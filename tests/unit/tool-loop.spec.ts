import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import type { ModelCallOptions } from '@/agent/provider/call';
import type { ModelDelta, ModelMessage } from '@/agent/provider/types';
import { answering, finish, textOf, toolCall } from './fixtures/neutral';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import { DEFAULT_CONFIG, type ProviderConfig } from '@/shared/settings';
import type { Ref } from '@/shared/types';

/**
 * The tool loop (CONTEXT.md `Tool`, `Turn`): the model may look at the page
 * again before it answers, and what it saw goes back to it.
 *
 * Driven by the reducer, one model call per round: the model calls `observe`,
 * the host reads the page, the reducer records the round and sends the whole
 * conversation back. The step the model finally points at is checked against
 * the table the host read, never one the panel supplied.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const URL_A = 'https://x.test/repo';
/** The page the call opened on: still loading, the button is not there yet. */
const LOADING: PromptTable = {
  snapshotId: 's1', url: URL_A, title: 't', structureHash: 'h1', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'link', name: 'Code', path: ['主导航'] }],
};
/** The same page a moment later, read again: the button has arrived. */
const LOADED: PromptTable = {
  ...LOADING,
  snapshotId: 's2',
  structureHash: 'h2',
  items: [...LOADING.items, { ref: 'e7' as Ref, role: 'link', name: 'Settings', path: ['主导航'] }],
};
const GOAL = '把这个仓库改成 private';

const at = (s: ThreadState) => ({
  threadRev: s.inflight!.at.threadRev,
  snapshotId: s.inflight!.at.snapshotId,
  structureHash: s.inflight!.at.structureHash,
  url: s.inflight!.at.url,
});
const answer = (s: ThreadState, tool: string, args: unknown, callId?: string, nextEffectId = 'fx-next') =>
  step(s, {
    kind: 'effect_result',
    effectId: s.inflight!.effectId,
    at: at(s),
    outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args), ...(callId ? { callId } : {}) },
    nextEffectId,
  });
const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);

const OBSERVE = { why: '表里只有导航，页面像是还没加载完' };
const POINT_SETTINGS = {
  previous_step: 'first_plan',
  route: [{ at: '仓库页', goal: '进入设置' }],
  why: '可见性在仓库设置里',
  ref: 'e7',
  action: 'click',
  value: null,
  expect_after: null,
};

/** Start, then have the model ask to look again. */
function observing(callId?: string) {
  const started = step(null, { kind: 'start', goal: GOAL, table: LOADING, effectId: 'fx-1' });
  return answer(started.state, 'observe', OBSERVE, callId, 'fx-obs');
}

describe('observe 经登记处就位', () => {
  it('模型看得到 observe，它要说清为什么要再看一眼', () => {
    const tools = guideAgent.outputSchema({ goal: GOAL, table: LOADING, history: { done: [], route: [] } });
    const observe = tools.find((t) => t.name === 'observe');
    expect(observe).toBeDefined();
    expect((observe!.inputSchema as { required: string[] }).required).toEqual(['why']);
    expect(guideAgent.instructions).toContain('**observe**');
  });
});

describe('一轮工具调用', () => {
  it('模型要 observe → 宿主去读这一页；这时没有模型调用在途，工具对话记着这次调用', () => {
    const { state, effects } = observing('call_1');
    expect(ofKind(effects, 'observe')).toEqual([{ kind: 'observe', effectId: 'fx-obs' }]);
    expect(ofKind(effects, 'callModel')).toHaveLength(0);
    expect(state.inflight).toBeNull();
    expect(state.turn?.pending).toEqual({ effectId: 'fx-obs', call: { id: 'call_1', name: 'observe', args: JSON.stringify(OBSERVE) } });
  });

  it('读到了 → 这一轮记下，之后按新表核对，带着整段对话再问一次模型', () => {
    const { state } = observing('call_1');
    const back = step(state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: LOADED }, nextEffectId: 'fx-2' });

    expect(back.state.table).toBe(LOADED);
    expect(back.state.turn?.pending).toBeUndefined();
    expect(back.state.turn?.rounds).toEqual([
      { call: { id: 'call_1', name: 'observe', args: JSON.stringify(OBSERVE) }, result: { kind: 'page', table: LOADED } },
    ]);
    const [call] = ofKind(back.effects, 'callModel');
    expect(call?.effectId).toBe('fx-2');
    // The schema's ref enum and the final check read the table just read…
    expect(call?.table).toBe(LOADED);
    // …while the conversation still opens on the page the call began with.
    expect(call?.turn?.table).toBe(LOADING);
    expect(call?.turn?.rounds).toHaveLength(1);
    // Every round is a model call and spends the run's quota (until 09).
    expect(back.state.callCount).toBe(state.callCount + 1);
  });

  it('读不到 → 把「读不到」交给模型，由它决定；表不换', () => {
    const { state } = observing('call_1');
    const back = step(state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'unreadable' }, nextEffectId: 'fx-2' });
    expect(back.state.table).toBe(LOADING);
    expect(back.state.turn?.rounds[0]?.result).toEqual({ kind: 'unreadable' });
    expect(ofKind(back.effects, 'callModel')).toHaveLength(1);
  });

  it('端点没给调用 id → 用这次调用自己的 effectId 造一个，循环照样能走', () => {
    const { state } = observing();
    expect(state.turn?.pending?.call.id).toBe('call_fx-1');
  });

  it('point 对照刚读到的那张表核对：只在新表里的控件能被指出来', () => {
    const { state } = observing('call_1');
    const back = step(state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: LOADED }, nextEffectId: 'fx-2' });
    const pointed = answer(back.state, 'point', POINT_SETTINGS, 'call_2');
    expect(pointed.state.steps[0]).toMatchObject({ ref: 'e7', title: 'Settings' });
    expect(ofKind(pointed.effects, 'present')).toHaveLength(1);
    // An Output ends the conversation for this step.
    expect(pointed.state.turn).toBeUndefined();
  });
});

// A tool result that comes back after a reading voided its turn is in
// `readings.spec.ts`, with the rest of what a reading does to a turn.
describe('过期的工具结果不会被接上', () => {
  it('对不上 id 的读数 → 不动', () => {
    const { state } = observing('call_1');
    const stray = step(state, { kind: 'tool_result', effectId: 'fx-other', result: { kind: 'page', table: LOADED }, nextEffectId: 'fx-2' });
    expect(stray.effects).toEqual([]);
    expect(stray.state.turn?.pending?.effectId).toBe('fx-obs');
  });
});

describe('读到的是另一页', () => {
  it('点完先在原地起了变化，模型再看一眼时页面已经走了 → 这一步记的是最后读到的那一页', () => {
    const shown = step(null, { kind: 'start', goal: GOAL, table: LOADED, effectId: 'fx-1' });
    const pointed = answer(shown.state, 'point', POINT_SETTINGS, 'call_1', 'fx-unused');
    // The user clicked, and the page read right after had changed where it stood.
    const opened: PromptTable = { ...LOADED, snapshotId: 's4', structureHash: 'h4' };
    const woke = step(pointed.state, { kind: 'reading', reading: { kind: 'used', how: 'clicked' }, table: opened, nextEffectId: 'fx-3' });
    // Nothing about what the step did is written yet: the model has not answered.
    expect(woke.state.history.at(-1)).toEqual({ title: 'Settings', url: LOADED.url, action: 'taken' });
    // It looks again, and by then the page has gone somewhere else.
    const obs = answer(woke.state, 'observe', OBSERVE, 'call_2', 'fx-obs');
    const settings: PromptTable = {
      ...LOADED, url: 'https://x.test/repo/settings', snapshotId: 's5', structureHash: 'h5',
      items: [{ ref: 'e1' as Ref, role: 'radio', name: 'Private', path: ['可见性'] }],
    };
    const back = step(obs.state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: settings }, nextEffectId: 'fx-4' });
    expect(back.state.table).toBe(settings);
    const next = answer(back.state, 'point', { ...POINT_SETTINGS, ref: 'e1' }, 'call_3');
    expect(next.state.history[0]).toMatchObject({ action: 'taken', effect: { kind: 'moved', to: settings.url } });
  });
});

describe('模型读到的顺序就是发生的顺序', () => {
  it('首条消息是这一步开始时的那一页；每一轮是一对 assistant 调用与 tool 结果，按 id 配对', () => {
    const { state } = observing('call_1');
    const back = step(state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: LOADED }, nextEffectId: 'fx-2' });
    const [call] = ofKind(back.effects, 'callModel');
    const messages = guideAgent.buildMessages(
      { goal: GOAL, table: call!.table, history: call!.history, turn: call!.turn },
      () => 'N',
    );
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(textOf(messages[1])).toContain('"Code"');
    expect(textOf(messages[1])).not.toContain('"Settings"');
    // Paired by the call's own id. Which field name carries it on the wire is
    // the adapter's business (CONTEXT.md `Repair call`); here it is one id.
    expect(messages[2]!.content).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'observe', input: JSON.stringify(OBSERVE) },
    ]);
    const result = messages[3]!.content[0]!;
    expect(result).toMatchObject({ type: 'tool-result', toolCallId: 'call_1' });
    // The page read is the page's own text, so it goes inside the same wrapper.
    const output = result.type === 'tool-result' ? result.output : '';
    expect(output).toContain('<untrusted_page_content nonce="N">');
    expect(output).toContain('"Settings"');
  });

  it('没有工具轮次时，送出去的和今天逐字相同——线上不带空的对话', () => {
    const started = step(null, { kind: 'start', goal: GOAL, table: LOADING, effectId: 'fx-1' });
    const [call] = ofKind(started.effects, 'callModel');
    expect(call).not.toHaveProperty('turn');
  });
});

describe('observe → point → done，一条完整的序列', () => {
  it('看一眼、指一步、用户照做换了页、模型说到了', () => {
    let s = step(null, { kind: 'start', goal: GOAL, table: LOADING, effectId: 'fx-1' }).state;
    s = answer(s, 'observe', OBSERVE, 'call_1', 'fx-obs').state;
    const read = step(s, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: LOADED }, nextEffectId: 'fx-2' });
    s = read.state;
    const pointed = answer(s, 'point', POINT_SETTINGS, 'call_2');
    expect(ofKind(pointed.effects, 'present')[0]?.step.ref).toBe('e7');
    s = pointed.state;

    const settings: PromptTable = { ...LOADED, url: 'https://x.test/repo/settings', snapshotId: 's6', structureHash: 'h6' };
    // The user clicked it, and by the time the page was read it had already gone.
    const woke = step(s, { kind: 'reading', reading: { kind: 'used', how: 'clicked' }, table: settings, nextEffectId: 'fx-3' });
    // A fresh wake starts a fresh conversation: nothing from the last step's rounds goes out.
    expect(ofKind(woke.effects, 'callModel')[0]).not.toHaveProperty('turn');
    s = woke.state;

    const done = answer(s, 'done', { evidence: 'page_address', why: '已经在设置页上了' }, 'call_3');
    expect(done.state.ending).toBe('model_done');
    expect(done.state.history).toEqual([{ title: 'Settings', url: LOADED.url, action: 'taken', effect: { kind: 'moved', to: settings.url } }]);
  });
});

describe('运行循环把调用 id 交回宿主', () => {
  it('端点给了 id → 结果里带着它，宿主用它把这一轮配成对', async () => {
    async function* call(_c: ProviderConfig, _m: readonly ModelMessage[], _s: AbortSignal, _o?: ModelCallOptions): AsyncGenerator<ModelDelta> {
      yield* answering('observe', JSON.stringify(OBSERVE), { id: 'call_xyz' });
    }
    const r = await runGuideToEnd({ goal: GOAL, table: LOADING, history: { done: [], route: [] } }, DEFAULT_CONFIG, new AbortController().signal, call);
    expect(r.failure).toBeUndefined();
    expect(r.tool).toBe('observe');
    expect(r.callId).toBe('call_xyz');
  });

  it('带着工具对话的那次请求，发出去的就是配好对的整段对话', async () => {
    const sent: (readonly ModelMessage[])[] = [];
    async function* call(_c: ProviderConfig, m: readonly ModelMessage[]): AsyncGenerator<ModelDelta> {
      sent.push(m);
      yield* toolCall('point', JSON.stringify(POINT_SETTINGS), { id: 'call_2' });
      yield finish({ prompt: 1, completion: 1, total: 2, estimated: false });
    }
    const turn = {
      table: LOADING,
      rounds: [{ call: { id: 'call_1', name: 'observe', args: JSON.stringify(OBSERVE) }, result: { kind: 'page' as const, table: LOADED } }],
    };
    const r = await runGuideToEnd({ goal: GOAL, table: LOADED, history: { done: [], route: [] }, turn }, DEFAULT_CONFIG, new AbortController().signal, call);
    expect(r.failure).toBeUndefined();
    expect(sent[0]!.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});
