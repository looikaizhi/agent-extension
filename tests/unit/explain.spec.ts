import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import { applyGuideInput, applyReading, guideThreadExists, type GuideEffectDeps } from '@/agent/thread/writer';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import { RUN_RECORDS_KEY, type RecordStore } from '@/agent/thread/record-store';
import type { RunRecord } from '@/agent/thread/record';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * `explain` and CONTEXT.md's `Question` (ticket 08a).
 *
 * The guide agent answers a question about the page itself, with the elements
 * that back the answer up. Whether a run was a question is read off what it
 * did, not decided at the door: a run that has pointed at nothing when an
 * answer lands — `explain`, `ask` or `done` — was a question. It ends there,
 * leaves no thread and no Run record, and what it answered stays on screen.
 * Once a run has pointed at a step, `explain` is an answer on the way: the
 * step stays where it is and the guide goes on.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
let snap = 0;
const page = (): PromptTable => ({
  snapshotId: `s${++snap}`, url: 'https://x.test/repo', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [
    { ref: 'e1' as Ref, role: 'link', name: 'Issues', path: ['主导航'] },
    { ref: 'e2' as Ref, role: 'button', name: 'Star', path: ['仓库头部'] },
    { ref: 'e3' as Ref, role: 'textbox', name: '密码', path: ['登录'], sensitive: true },
  ],
});
const EXPLAIN = { answer: 'Star 是收藏这个仓库，Issues 是问题列表。', refs: ['e2', 'e1'] };
const POINT = { previous_step: 'first_plan', route: [{ at: '仓库页', goal: '进 Issues' }], why: '从这里进', ref: 'e1', action: 'click', value: null, expect_after: null };

const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);
let fx = 0;
const answer = (s: ThreadState, tool: string, args: unknown) =>
  step(s, {
    kind: 'effect_result', effectId: s.inflight!.effectId, at: s.inflight!.at,
    outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args) },
    nextEffectId: `fx-${++fx}`,
  });
const started = () => step(null, { kind: 'start', goal: '这一页上的按钮都是干什么的？', table: page(), effectId: 'fx-start' }).state;

describe('explain 经登记处就位', () => {
  it('模型看得到 explain：回答文字，加上支撑它的元素', () => {
    const tools = guideAgent.outputSchema({ goal: 'g', table: page(), history: { done: [], route: [] } });
    const explain = tools.find((t) => t.name === 'explain');
    expect((explain?.inputSchema as { required: string[] }).required).toEqual(['answer', 'refs']);
    expect(guideAgent.instructions).toContain('**explain**');
  });

  it('依据不在表里、或是敏感输入框 → 拒绝', () => {
    for (const refs of [['e9'], ['e3']]) {
      const parsed = guideAgent.parseOutput('explain', JSON.stringify({ ...EXPLAIN, refs }));
      if (parsed.kind !== 'ok') throw new Error('fixture must parse');
      expect(guideAgent.validate(parsed.envelope, page()).kind).toBe('violation');
    }
  });

  it('一步的最后一次调用也能 explain：它是一个回答', () => {
    const names = guideAgent.outputSchema({ goal: 'g', table: page(), history: { done: [], route: [] }, final: true }).map((t) => t.name);
    expect(names).toContain('explain');
  });
});

describe('一趟里一次 point 都没有：这是一次问答，回答落地就收场', () => {
  it('explain → 回答交给侧栏、框出依据；这一趟以 answered 收场，不再问模型', () => {
    const { state, effects } = answer(started(), 'explain', EXPLAIN);
    expect(ofKind(effects, 'explain')).toEqual([{ kind: 'explain', answer: EXPLAIN.answer, refs: ['e2', 'e1'] }]);
    expect(ofKind(effects, 'callModel')).toEqual([]);
    expect(state.ending).toBe('answered');
  });

  it('先 observe 再 explain → 仍是一次问答', () => {
    const asked = answer(started(), 'observe', { why: '再看一眼' });
    const back = step(asked.state, { kind: 'tool_result', effectId: asked.state.turn!.pending!.effectId, result: { kind: 'page', table: page() }, nextEffectId: `fx-${++fx}` });
    const { state } = answer(back.state, 'explain', EXPLAIN);
    expect(state.ending).toBe('answered');
  });

  it('ask → 问题交给用户；也以 answered 收场：用户会把话说得更具体再问一次', () => {
    const { state, effects } = answer(started(), 'ask', { question: '你想了解哪个按钮？', wants: 'text', options: [] });
    expect(ofKind(effects, 'ask')).toHaveLength(1);
    expect(state.ending).toBe('answered');
  });

  it('done → 照旧说到了', () => {
    const { state } = answer(started(), 'done', { evidence: 'content_on_page', why: '就在这一页上' });
    expect(state.ending).toBe('model_done');
  });
});

describe('引导中（已经指过一步）给出 explain：回答显示，引导继续', () => {
  function explainedMidGuide() {
    const pointed = answer(started(), 'point', POINT).state;
    const woken = step(pointed, { kind: 'reading', reading: { kind: 'changed' }, table: page(), nextEffectId: `fx-${++fx}` }).state;
    return { pointed, out: answer(woken, 'explain', EXPLAIN) };
  }

  it('不结束这一趟、不画新的一步，屏上那一步原样留着', () => {
    const { pointed, out } = explainedMidGuide();
    expect(out.state.ending).toBeUndefined();
    expect(out.state.steps).toEqual(pointed.steps);
    expect(ofKind(out.effects, 'present')).toEqual([]);
    expect(ofKind(out.effects, 'explain')).toHaveLength(1);
  });

  it('屏上那一步做成了什么不在这时记——用户还没对它动手', () => {
    const { pointed, out } = explainedMidGuide();
    expect(out.state.history).toEqual(pointed.history);
    expect(out.state.pointedOn).toBe(pointed.pointedOn);
  });

  it('这一步的调用从头算，但算走掉一步：读数一直叫醒、模型一直解释，一趟也有尽头', () => {
    const { pointed, out } = explainedMidGuide();
    expect(out.state.stepCalls).toBe(0);
    expect(out.state.spentSteps).toBe(pointed.spentSteps + 1);
  });
});

/* ═══════════ the writer: a question leaves nothing behind ═══════════ */

function harness() {
  const data = new Map<string, unknown>();
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (k) => void data.delete(k),
  };
  const records: RunRecord[] = [];
  const recordStore: RecordStore = {
    get: async () => ({ [RUN_RECORDS_KEY]: records }),
    set: async (items) => void records.splice(0, records.length, ...(items[RUN_RECORDS_KEY] as RunRecord[])),
    bytesInUse: async () => 0,
    quota: 1_000_000,
  };
  const deps: GuideEffectDeps = {
    store, records: recordStore, flags: { get: async () => ({}) }, recent: async () => [],
    send: () => {}, now: () => 0, newEffectId: () => `gen-${++fx}`,
  };
  return { deps, store, records };
}
const T = 'tab-1' as ThreadId;
const resultOf = (at: ThreadState['inflight'], tool: string, args: unknown) => ({
  kind: 'effect_result' as const, effectId: at!.effectId, at: at!.at,
  outcome: { ok: true as const, providerCalls: 1, tool, value: JSON.stringify(args) },
});

describe('写链：问答不留线程、不写 Run record', () => {
  it('一次 explain 就收场 → 线程删掉，一条记录都不写', async () => {
    const { deps, store, records } = harness();
    const s = await applyGuideInput(deps, T, { kind: 'start', goal: '这是什么页', table: page(), effectId: 'fx-1' });
    const out = await applyGuideInput(deps, T, resultOf(s.state!.inflight, 'explain', EXPLAIN));
    expect(out.ending?.ended).toBe(true);
    expect(await guideThreadExists(store, T)).toBe(false);
    expect(records).toEqual([]);
  });

  it('第一句就 done（已经在这了）→ 也不写记录：一步都没有指过', async () => {
    const { deps, records } = harness();
    const s = await applyGuideInput(deps, T, { kind: 'start', goal: '看 issue', table: page(), effectId: 'fx-1' });
    await applyGuideInput(deps, T, resultOf(s.state!.inflight, 'done', { evidence: 'content_on_page', why: '就在这' }));
    expect(records).toEqual([]);
  });

  it('指过一步的引导结束 → 照常写一条记录', async () => {
    const { deps, records } = harness();
    const s = await applyGuideInput(deps, T, { kind: 'start', goal: '去 issue', table: page(), effectId: 'fx-1' });
    const pointed = await applyGuideInput(deps, T, resultOf(s.state!.inflight, 'point', POINT));
    const woke = await applyReading(deps, T, { kind: 'used', how: 'clicked' }, async () => page(), 'tab-1#1');
    expect(pointed.state?.history).toHaveLength(1);
    await applyGuideInput(deps, T, resultOf(woke!.state!.inflight, 'done', { evidence: 'content_on_page', why: '到了' }));
    expect(records).toHaveLength(1);
  });
});
