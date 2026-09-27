import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { Reading } from '@/agent/context/turn';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { textOf } from './fixtures/neutral';

/**
 * The two budgets (ticket 09) that replace "twelve model calls a run".
 *
 * A step — from one answer to the next — may ask the model at most four
 * times; the fourth time only answers are on offer, and a step that still ends
 * without one tells the user and waits for the page, without ending the run.
 * A run may take at most twelve steps, and only that ends it as
 * `quota_exhausted`. Calls are still counted, but only as what the run cost.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
let snap = 0;
const page = (items: [string, string, string][] = [['e1', 'link', 'Issues'], ['e2', 'link', '帮助文档']]): PromptTable => ({
  snapshotId: `s${++snap}`, url: 'https://x.test/repo', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: items.map(([ref, role, name]) => ({
    ref: ref as Ref, role, name, path: ['主导航'], ...(name === '帮助文档' ? { href: 'https://x.test/docs/help' } : {}),
  })),
});
const GOAL = '新建一个 issue';
const POINT = { previous_step: 'first_plan', route: [{ at: '仓库页', goal: '进 Issues' }], why: '从这里进', ref: 'e1', action: 'click', value: null, expect_after: null };
const CHANGED: Reading = { kind: 'changed' };

const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);
let fx = 0;
const answer = (s: ThreadState, tool: string, args: unknown) =>
  step(s, {
    kind: 'effect_result', effectId: s.inflight!.effectId, at: s.inflight!.at,
    outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args) },
    nextEffectId: `fx-${++fx}`,
  });
/** The model asks to look again, and the host brings the page back. */
const lookAgain = (s: ThreadState) => {
  const asked = answer(s, 'observe', { why: '再看一眼' });
  return step(asked.state, { kind: 'tool_result', effectId: asked.state.turn!.pending!.effectId, result: { kind: 'page', table: page() }, nextEffectId: `fx-${++fx}` });
};
const read = (s: ThreadState, reading: Reading = CHANGED) => step(s, { kind: 'reading', reading, table: page(), nextEffectId: `fx-${++fx}` });
const started = () => step(null, { kind: 'start', goal: GOAL, table: page(), effectId: 'fx-start' });

describe('每步调用上限：4 次', () => {
  it('前三次照常给全部工具；第四次只给结论工具', () => {
    let out = started();
    const calls = [ofKind(out.effects, 'callModel')[0]];
    for (let i = 0; i < 3; i++) {
      out = lookAgain(out.state);
      calls.push(ofKind(out.effects, 'callModel')[0]);
    }
    expect(calls.map((c) => c?.final ?? false)).toEqual([false, false, false, true]);
  });

  it('第四次还是要用工具 → 这一步用完：告诉用户，不结束这一趟，不再问模型，也不去执行那个工具', () => {
    let s = started().state;
    for (let i = 0; i < 3; i++) s = lookAgain(s).state;
    const { state, effects } = answer(s, 'observe', { why: '还想再看' });
    expect(effects.map((e) => e.kind)).toEqual(['notify']);
    expect(ofKind(effects, 'notify')[0]?.message).toContain('4 次');
    expect(state.ending).toBeUndefined();
    expect(state.turn).toBeUndefined();
    expect(state.inflight).toBeNull();
  });

  it('用完之后来一条读数 → 开新的一步，预算从头算', () => {
    let s = started().state;
    for (let i = 0; i < 3; i++) s = lookAgain(s).state;
    s = answer(s, 'observe', { why: '还想再看' }).state;
    const woke = read(s);
    const [call] = ofKind(woke.effects, 'callModel');
    expect(call).toBeDefined();
    expect(call?.final).toBeUndefined();
  });

  it('第四次调用失败了 → 照实告诉用户失败，这一步也就此结束：下一条读数开新的一步', () => {
    let s = started().state;
    for (let i = 0; i < 3; i++) s = lookAgain(s).state;
    const failed = step(s, {
      kind: 'effect_result', effectId: s.inflight!.effectId, at: s.inflight!.at,
      outcome: { ok: false, providerCalls: 1, error: '断了', retryable: true, failureKind: 'transport' },
      nextEffectId: `fx-${++fx}`,
    });
    expect(ofKind(failed.effects, 'notify')[0]?.message).toContain('断了');
    const woke = read(failed.state);
    const [call] = ofKind(woke.effects, 'callModel');
    expect(call).toBeDefined();
    expect(call?.final).toBeUndefined();
  });

  it('读数一直在作废回答：一步里也最多问四次，第五次不发', () => {
    let out = started();
    let calls = 1;
    for (let i = 0; i < 6; i++) {
      const during = read(out.state);
      expect(ofKind(during.effects, 'callModel')).toEqual([]);
      out = answer(during.state, 'point', POINT);
      calls += ofKind(out.effects, 'callModel').length;
      if (!out.state.inflight) break;
    }
    expect(calls).toBe(4);
    expect(ofKind(out.effects, 'notify')).toHaveLength(1);
    expect(out.state.ending).toBeUndefined();
    // What voided the last call is still news for the next step.
    expect(out.state.readings?.length).toBeGreaterThan(0);
  });

  it('一次回答落地，这一步就结束：下一步从零算起', () => {
    let s = started().state;
    for (let i = 0; i < 3; i++) s = lookAgain(s).state;
    s = answer(s, 'point', POINT).state;
    let out = read(s);
    const calls = [ofKind(out.effects, 'callModel')[0]];
    for (let i = 0; i < 3; i++) {
      out = lookAgain(out.state);
      calls.push(ofKind(out.effects, 'callModel')[0]);
    }
    expect(calls.map((c) => c?.final ?? false)).toEqual([false, false, false, true]);
  });
});

describe('整趟步数上限：12 步', () => {
  /** A run that has pointed at `n` steps and is waiting for the page. */
  function walked(n: number): ThreadState {
    let s = started().state;
    for (let i = 0; i < n; i++) {
      s = answer(s, 'point', POINT).state;
      if (i < n - 1) s = read(s, { kind: 'used', how: 'clicked' }).state;
    }
    return s;
  }

  it('第 12 步落地之后，下一次要开新的一步 → 结束为 quota_exhausted，并说清走了几步、最后一步是什么', () => {
    const s = walked(12);
    expect(s.ending).toBeUndefined();
    const { state, effects } = read(s, { kind: 'used', how: 'clicked' });
    expect(state.ending).toBe('quota_exhausted');
    expect(ofKind(effects, 'callModel')).toEqual([]);
    const said = ofKind(effects, 'notify')[0]?.message ?? '';
    expect(said).toContain('12 步');
    expect(said).toContain('「Issues」');
  });

  it('第 11 步之后还能再走一步', () => {
    const { state, effects } = read(walked(11), { kind: 'used', how: 'clicked' });
    expect(state.ending).toBeUndefined();
    expect(ofKind(effects, 'callModel')).toHaveLength(1);
  });

  it('调用花得再多，只要步数没满就不结束：调用次数只是花了多少', () => {
    const s: ThreadState = { ...walked(2), callCount: 40 };
    const { state, effects } = read(s, { kind: 'used', how: 'clicked' });
    expect(state.ending).toBeUndefined();
    expect(ofKind(effects, 'callModel')).toHaveLength(1);
  });

  it('这一步用完了预算、没有回答，也算走掉一步：读数再多，一趟也有尽头', () => {
    let s = started().state;
    for (let step = 0; step < 12; step++) {
      for (let i = 0; i < 3; i++) s = lookAgain(s).state;
      s = answer(s, 'observe', { why: '还想再看' }).state;
      s = read(s).state;
    }
    expect(s.ending).toBe('quota_exhausted');
  });
});

describe('文档抓取不再单独计数', () => {
  it('一趟里第 6 次读文档照样去抓：每次抓取都夹在这一步的调用里，已经被每步预算管着', () => {
    let s = started().state;
    let fetches = 0;
    for (let i = 0; i < 6; i++) {
      const asked = answer(s, 'read_doc', { via_ref: 'e2', query: '怎么新建' });
      expect(asked.state.ending).toBeUndefined();
      fetches += ofKind(asked.effects, 'fetchDoc').length;
      const back = step(asked.state, {
        kind: 'effect_result', effectId: asked.state.inflight!.effectId, at: asked.state.inflight!.at,
        outcome: { ok: true, providerCalls: 0, value: '正文' }, nextEffectId: `fx-${++fx}`,
      }).state;
      s = read(answer(back, 'point', POINT).state, { kind: 'used', how: 'clicked' }).state;
    }
    expect(fetches).toBe(6);
  });
});

describe('第四次调用念给模型的话', () => {
  const ctx = { goal: GOAL, table: page(), history: { done: [], route: [] } };

  it('只给回答：point、ask、explain、done', () => {
    expect(guideAgent.outputSchema({ ...ctx, final: true }).map((t) => t.name)).toEqual(['point', 'ask', 'explain', 'done']);
  });

  it('最后一条是我们说的话：这一次直接给结论', () => {
    const messages = guideAgent.buildMessages({ ...ctx, final: true }, () => 'N');
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(textOf(last)).toContain('这一次请直接给结论');
    // The opening is the same message it always was: the prefix cache holds.
    expect(messages[1]).toEqual(guideAgent.buildMessages(ctx, () => 'N')[1]);
  });

  it('那句话点名的正是这一次给的每一个回答——问这一页的事，也能直接答', () => {
    const last = textOf(guideAgent.buildMessages({ ...ctx, final: true }, () => 'N').at(-1));
    for (const name of guideAgent.outputSchema({ ...ctx, final: true }).map((t) => t.name)) expect(last).toContain(name);
  });

  it('不是第四次 → 一个字都不多', () => {
    expect(guideAgent.buildMessages(ctx, () => 'N')).toHaveLength(2);
  });
});
