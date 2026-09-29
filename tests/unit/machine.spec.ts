import { presentationIdOf, tryEmitCallModel } from '@/agent/thread/transitions';
import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { MachineEffect, MachineInput } from '@/agent/thread/thread';
import type { Reading } from '@/agent/context/turn';
import { judgeConfirmation } from '@/agent/thread/record';
import { step, stepOnScreen } from '@/agent/thread/machine';
import type { EffectFailureKind } from '@/agent/thread/effect';
import { decodeThread, encodeThread } from '@/agent/thread/thread';
import type { ThreadState } from '@/agent/thread/thread';
import type { ExtractStats, PromptItem, PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';
import type { Ref } from '@/shared/types';
import { goldenGuideCalls, TABLES } from './fixtures/golden-guide-envelopes';

/**
 * `step` is the reducer at the center of the guided flow. Every
 * fixture here is hand-written (`table()`/`baseState()` below) except slice
 * 15, which replays 01's frozen real-model corpus — the file's own Gotchas
 * forbid ever running `step` first and pasting its output back as the
 * expectation, so every `expect(...)` in this file was written by reading
 * the plan/ADRs, not by executing code.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

function table(items: ItemSpec[], overrides: Partial<Omit<PromptTable, 'items'>> = {}): PromptTable {
  return {
    snapshotId: 's1',
    url: 'https://example.test/console',
    title: 't',
    structureHash: 'h1',
    omitted: 0,
    degraded: false,
    ambiguity: 0,
    stats,
    ...overrides,
    items: items.map((i) => ({ ...i, ref: i.ref as Ref, path: i.path ?? [] })),
  };
}

/** One control, unambiguous — the common case for slices that don't care
 *  about the table's shape, only about what `step` does around it. */
const DELETE_TABLE = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }]);

const POINT_RAW = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e8', action: 'click', why: '点击删除实例按钮以发起删除操作',
});

/** An active thread already past `start`, waiting on nothing — the common
 *  starting point for slices that test `effect_result`/
 *  `reading` in isolation. */
function baseState(overrides: Partial<ThreadState> = {}): ThreadState {
  const table = overrides.table ?? DELETE_TABLE;
  return {
    rev: 3,
    goal: '把这台实例删掉',
    table,
    // Unless a test says otherwise, the step on screen was pointed on the page on file.
    pointedOn: table,
    route: [],
    steps: [],
    cursor: 0,
    history: [],
    evidence: 'model',
    check: 'unknown',
    callCount: 1,
    stepCalls: 0, spentSteps: 0,
    inflight: null,
    ...overrides,
  };
}

const effectsOfKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);

const DONE_RAW = JSON.stringify({ evidence: 'page_address', why: '到了' });

/** A reading arrives with `tbl` read right after, and the model it wakes
 *  answers with `tool`/`value` — the one moment a step is settled. */
function readThenAnswer(prior: ThreadState, tbl: PromptTable, tool: string, value: string, reading: Reading = { kind: 'changed' }) {
  const woke = step(prior, { kind: 'reading', reading, table: tbl, nextEffectId: 'fx-wake' });
  const call = woke.state.inflight!;
  return step(woke.state, {
    kind: 'effect_result', effectId: call.effectId, at: call.at,
    outcome: { ok: true, providerCalls: 1, tool, value }, nextEffectId: 'fx-next',
  });
}

describe('machine.ts · step — slice 1: start', () => {
  it('1. goal + 真实表 → 恰好一个 callModel effect，callCount=1，inflight 非空', () => {
    const input: MachineInput = { kind: 'start', goal: '把这台实例删掉', table: DELETE_TABLE, effectId: 'fx-1' };
    const { state, effects } = step(null, input);

    const calls = effectsOfKind(effects, 'callModel');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: 'callModel',
      effectId: 'fx-1',
      goal: '把这台实例删掉',
      table: DELETE_TABLE,
      // A first plan has nowhere to have been yet (07).
      history: { done: [], route: [] },
    });
    expect(effects).toHaveLength(1);
    expect(state.callCount).toBe(1);
    expect(state.inflight).not.toBeNull();
    expect(state.inflight?.effectId).toBe('fx-1');
    expect(state.rev).toBe(1);
  });
});

describe('machine.ts · step — slice 2: inflight 阻止第二个 callModel', () => {
  it('2. 已有 inflight 时收到会触发新 callModel 的输入 → 拒绝，state 除 rev 外不变，effects 为空', () => {
    const prior = baseState({
      rev: 5,
      inflight: { effectId: 'old', kind: 'callModel', at: { threadRev: 5, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url } },
    });
    // A reading, with a genuinely different page, would normally wake the
    // model (slice 9) — but a tombstone is already sitting there, so it must
    // be held instead.
    const changedTable: PromptTable = { ...DELETE_TABLE, structureHash: 'h2', snapshotId: 's2' };
    const input: MachineInput = { kind: 'reading', reading: { kind: 'changed' }, table: changedTable, nextEffectId: 'fx-new' };

    const { state, effects } = step(prior, input);

    expect(effects).toEqual([]);
    // The guarantee this test is named for: no second call is dispatched and
    // the existing tombstone is left alone.
    expect(state.callCount).toBe(prior.callCount);
    expect(state.inflight).toEqual(prior.inflight);

    // The reading, however, *is* kept, and the page it read. Not spending a
    // call and not remembering where the user went are two different things:
    // the answer on its way comes back for a page the user has left, and it is
    // the kept reading that gets it dropped (E-3). See the
    // "inflight 期间到达的新页面不会被丢掉" block below.
    expect(state.table).toEqual(changedTable);
    expect(state.readings).toEqual([{ kind: 'changed' }]);
  });
});

describe('machine.ts · step — slice 3: effect_result 成功', () => {
  it('3. 合法的 point → inflight 清空，产出 present（这一步），steps/route 推进', () => {
    const prior = baseState({
      rev: 4,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 4, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url } },
    });
    const input: MachineInput = {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 4, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-unused',
    };

    const { state, effects } = step(prior, input);

    expect(state.inflight).toBeNull();
    expect(state.route).toEqual([{ at: '实例操作区域', goal: '删除这台实例' }]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.ref).toBe('e8');
    expect(state.cursor).toBe(0);

    const presents = effectsOfKind(effects, 'present');
    expect(presents).toHaveLength(1);
    expect(presents[0]?.index).toBe(0);
    // The model points one step at a time: which step this is, and no total.
    expect(presents[0]?.total).toBeNull();
    expect(presents[0]?.step.ref).toBe('e8');
  });
});

describe('machine.ts · step — slice 4: 调用在途时来过读数（E-3）', () => {
  it('4. 作答期间来过读数 → 整条丢弃，inflight 清空，自动产出新的 callModel（callCount 再 +1），不等待用户输入', () => {
    // Simulate: a reading already moved `state.table` to a new structureHash
    // while the original callModel was inflight — the answer that comes back
    // was computed for the page before it.
    const movedTable: PromptTable = { ...DELETE_TABLE, structureHash: 'h2', snapshotId: 's2' };
    const prior = baseState({
      rev: 6,
      table: movedTable,
      pointedOn: DELETE_TABLE,
      readings: [{ kind: 'changed' }],
      callCount: 2,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 4, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url } },
    });
    const input: MachineInput = {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 4, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url }, // stale, echoes the old dispatch
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-2',
    };

    const { state, effects } = step(prior, input);

    // The stale envelope's content never lands — `steps`/`route` stay empty.
    expect(state.steps).toEqual([]);
    expect(state.route).toEqual([]);
    expect(state.callCount).toBe(3); // one more than prior's 2
    expect(state.inflight).not.toBeNull();
    expect(state.inflight?.effectId).toBe('fx-2');
    expect(state.inflight?.kind).toBe('callModel');

    const calls = effectsOfKind(effects, 'callModel');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.effectId).toBe('fx-2');
    expect(calls[0]?.table).toEqual(movedTable); // replans against the *current* table
  });
});

describe('machine.ts · step — E-3 的例外：网址没变时落地的 done 照收', () => {
  const DONE_RAW = JSON.stringify({ evidence: 'content_on_page', why: '要看的清单已经在这一页上' });
  const dispatched = { threadRev: 4, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url };
  /** The call went out on `dispatched`; the page then re-rendered (new
   *  snapshot, new hash) at `url` before the answer landed. */
  const landed = (tool: string, value: string, url = DELETE_TABLE.url) => {
    const moved: PromptTable = { ...DELETE_TABLE, url, structureHash: 'h2', snapshotId: 's2' };
    const prior = baseState({
      rev: 6, table: moved, pointedOn: DELETE_TABLE, readings: [{ kind: 'changed' }], callCount: 2,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: dispatched },
    });
    return step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: dispatched,
      outcome: { ok: true, providerCalls: 1, tool, value },
      nextEffectId: 'fx-2',
    });
  };

  it('页面在作答期间重新渲染（同一网址、新快照）→ done 照收：引导结束，不再多问一次', () => {
    const { state, effects } = landed('done', DONE_RAW);
    expect(state.ending).toBe('model_done');
    expect(state.inflight).toBeNull();
    expect(state.callCount).toBe(2);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(0);
    expect(effectsOfKind(effects, 'done')).toHaveLength(1);
  });

  it('网址变了 → done 照旧丢弃并重规划：它说的是上一页', () => {
    const { state, effects } = landed('done', DONE_RAW, 'https://example.test/elsewhere');
    expect(state.ending).toBeUndefined();
    expect(state.callCount).toBe(3);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });

  it('guide 不在例外里：同一网址重新渲染，它指向的控件可能已经变了，照旧丢弃', () => {
    const { state, effects } = landed('point', POINT_RAW);
    expect(state.steps).toEqual([]);
    expect(state.callCount).toBe(3);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });
});

describe('machine.ts · step — ask', () => {
  it('模型问回来一句 → question、要什么、全部候选原样交出去，不被压成一句"信封类型不对"', () => {
    // 8 of the 12 samples in the first live run came back `clarify`, and every
    // one of them reached the user as the literal string "模型返回了非引导类
    // 信封（intent: clarify）". The question the model asked, and the
    // candidates it listed, were parsed, validated, and then thrown away —
    // so the one path the model actually takes most of the time was the one
    // path that told the user nothing.
    const forkTable = table([
      { ref: 'e8', role: 'link', name: 'web-a', path: ['实例列表'] },
      { ref: 'e9', role: 'link', name: 'web-b', path: ['实例列表'] },
    ]);
    const prior = baseState({
      rev: 4,
      table: forkTable,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 4, snapshotId: forkTable.snapshotId, structureHash: forkTable.structureHash, url: forkTable.url } },
      // Mid-journey, on the second of two steps: keeping them has to be
      // visible, which the default empty steps cannot show. And pointed at
      // before — a run that never had would be a question, and over.
      history: [{ title: 'web-a', url: forkTable.url }, { title: 'web-b', url: forkTable.url }],
      steps: [
        { ref: 'e8' as Ref, descriptor: { role: 'link', name: 'web-a' }, expectedUserAction: 'click', title: 'web-a' },
        { ref: 'e9' as Ref, descriptor: { role: 'link', name: 'web-b' }, expectedUserAction: 'click', title: 'web-b' },
      ],
      cursor: 1,
    });

    const { state, effects } = step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 4, snapshotId: forkTable.snapshotId, structureHash: forkTable.structureHash, url: forkTable.url },
      outcome: {
        ok: true,
        providerCalls: 1,
        tool: 'ask',
        value: JSON.stringify({
          question: '你要设为私有的是哪一个实例？',
          wants: 'choice',
          options: [
            { ref: 'e8', label: 'web-a' },
            { ref: 'e9', label: 'web-b' },
          ],
        }),
      },
      nextEffectId: 'fx-unused',
    });

    const asks = effectsOfKind(effects, 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]?.question).toBe('你要设为私有的是哪一个实例？');
    expect(asks[0]?.wants).toBe('choice');
    // All candidates, in the model's own order — never narrowed to one (K-6).
    expect(asks[0]?.options).toEqual([
      { ref: 'e8', label: 'web-a' },
      { ref: 'e9', label: 'web-b' },
    ]);
    expect(state.inflight).toBeNull();
    expect(state.ending).toBeUndefined(); // parked on a question, not ended
    // Parked with its steps intact, not ended: nothing is taken off the page.
    expect(state.steps).toEqual(prior.steps);
    expect(state.cursor).toBe(1);
  });
});

// A reading whose page did not change wakes the model all the same, and is
// told so (`readings.spec.ts`): deciding it was "nothing" is the model's call.
describe('machine.ts · step — slice 9/10: 读数带来的页面', () => {
  it('9. structureHash 与 state 记录的不同 → 产出新的 callModel effect，callCount +1', () => {
    const prior = baseState({ rev: 5, callCount: 1 });
    const changedTable: PromptTable = { ...DELETE_TABLE, structureHash: 'h2', snapshotId: 's2' };
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: changedTable, nextEffectId: 'fx-9' });

    expect(state.callCount).toBe(2);
    expect(state.table).toEqual(changedTable);
    const calls = effectsOfKind(effects, 'callModel');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.effectId).toBe('fx-9');
  });

  it('10b. structureHash 相同、但元素表换了一批控件 → 仍然触发重规划', () => {
    // `structureFingerprint` hashes landmark/heading structure only, deliberately: a
    // hash reacting to every button that appears after an async load would
    // invalidate the guide constantly. But that same insensitivity means the
    // single most common in-page transition on a real site — a menu or dialog
    // opening, which adds no landmark and no heading — reads as "nothing
    // happened", and the guide freezes on a step the user already did.
    // GitHub's `Code ▾` dropdown is exactly this shape, and it is step 3 of 4
    // in the clone flow.
    const prior = baseState({ rev: 5, callCount: 1 });
    const dropdownOpen: PromptTable = {
      ...DELETE_TABLE,
      snapshotId: 's2', // a genuinely new extraction — the page hash simply did not move
      items: [
        ...DELETE_TABLE.items,
        { ref: 'e30' as Ref, role: 'textbox', name: '仓库地址', path: ['克隆'] },
        { ref: 'e31' as Ref, role: 'button', name: '复制地址', path: ['克隆'] },
      ],
    };
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: dropdownOpen, nextEffectId: 'fx-10b' });

    expect(state.table).toEqual(dropdownOpen);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });

  it('10c. 站内搜索换了关键词、结构与控件都没变 → 仍是换页，触发重规划', () => {
    // `?q=a` 与 `?q=b` 是两个视图（CONTEXT.md 的 `View`：完整 URL 去掉
    // fragment）。旧判定只看 origin + pathname 再加结构，结构与控件恰好相同的
    // 两页被读成「什么都没发生」，新表永远提交不进来。
    const prior = baseState({ rev: 5, callCount: 1, table: { ...DELETE_TABLE, url: 'https://example.test/search?q=a' } });
    const nextQuery: PromptTable = { ...DELETE_TABLE, url: 'https://example.test/search?q=b', snapshotId: 's2' };
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: nextQuery, nextEffectId: 'fx-10c' });

    expect(state.table).toEqual(nextQuery);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });

});

describe('machine.ts · step — inflight 期间到达的新页面不会被丢掉', () => {
  const HOME = DELETE_TABLE;
  const SEARCH: PromptTable = table([{ ref: 'f1', role: 'link', name: 'n8n-io/n8n' }], {
    snapshotId: 's2',
    structureHash: 'h2',
    url: 'https://example.test/search?q=n8n',
  });
  const dispatchedAgainstHome = {
    effectId: 'E1',
    kind: 'callModel' as const,
    at: { threadRev: 3, snapshotId: HOME.snapshotId, structureHash: HOME.structureHash, url: HOME.url },
  };
  const envelopeForHome = JSON.stringify({
    route: [{ at: '控制台', goal: '删掉实例' }],
    ref: 'e8', action: 'click', why: '这是删除按钮',
  });

  it('A. 用户在模型作答期间跳到了新页面 → 新页面被记下（否则 E-3 无从比对），但不额外花一次调用', () => {
    const prior = baseState({ inflight: dispatchedAgainstHome, table: HOME, callCount: 1 });
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: SEARCH, nextEffectId: 'fx-a' });

    expect(state.table).toEqual(SEARCH);
    // Recorded, not acted on: a call is already out, and E-3 is what spends
    // the next one once that call comes back stale.
    expect(effects).toEqual([]);
    expect(state.callCount).toBe(1);
    expect(state.inflight).toEqual(dispatchedAgainstHome);
  });

  it('B. 随后旧页面的结果返回 → E-3 认出世界变了，丢弃它并针对新页面重规划，绝不把旧页面的步骤画到屏上', () => {
    const prior = baseState({ inflight: dispatchedAgainstHome, table: HOME, callCount: 1 });
    const moved = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: SEARCH, nextEffectId: 'fx-b1' }).state;

    const { state, effects } = step(moved, {
      kind: 'effect_result',
      effectId: 'E1',
      at: dispatchedAgainstHome.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: envelopeForHome },
      nextEffectId: 'E3',
    });

    // The whole point. `e8` is a real, bindable ref *of the page the user has
    // left*; presenting it is L-4 — pointing confidently at the wrong thing.
    expect(effectsOfKind(effects, 'present')).toHaveLength(0);
    const calls = effectsOfKind(effects, 'callModel');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toEqual(SEARCH);
    expect(state.inflight?.effectId).toBe('E3');
  });

  it('C. 这一跳的到达仍然被记账：模型下一次回答时，history 结算在真正到达的那一页上，check 也拿新表判', () => {
    const prior = baseState({
      inflight: dispatchedAgainstHome,
      table: HOME,
      history: [{ title: '搜索框', url: HOME.url }],
      expect: { via_ref: 'f1' as Ref, must_contain: { role: 'link', name: 'n8n-io/n8n' } },
    });
    const moved = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: SEARCH, nextEffectId: 'fx-c' }).state;
    const again = step(moved, {
      kind: 'effect_result', effectId: 'E1', at: dispatchedAgainstHome.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: envelopeForHome }, nextEffectId: 'E3',
    }).state;
    const { state } = step(again, {
      kind: 'effect_result', effectId: 'E3', at: again.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: DONE_RAW }, nextEffectId: 'E4',
    });

    expect(state.history.at(-1)).toEqual({ title: '搜索框', url: HOME.url, effect: { kind: 'moved', to: SEARCH.url } });
    expect(state.check).toBe('pass');
  });
});

describe('machine.ts · step — 跨站跳转要先问过用户（P-2）', () => {
  /** 落地地址来自**表**（页面自己背书），不是模型——模型永远只给 ref（S-07）。 */
  const pageWith = (href: string) =>
    table([{ ref: 'e1', role: 'link', name: '打开帮助', href }], { url: 'https://console.example.test/app' });
  const envelope = JSON.stringify({
    route: [{ at: '控制台', goal: '看帮助' }],
    ref: 'e1', action: 'click', why: '这条链接会带你去帮助页',
  });
  const land = (href: string) => {
    const tbl = pageWith(href);
    const inflight = {
      effectId: 'E1',
      kind: 'callModel' as const,
      at: { threadRev: 3, snapshotId: tbl.snapshotId, structureHash: tbl.structureHash, url: tbl.url },
    };
    return step(baseState({ inflight, table: tbl }), {
      kind: 'effect_result',
      effectId: 'E1',
      at: inflight.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: envelope },
      nextEffectId: 'E3',
    });
  };

  it('P-2a. 下一步会离开当前 host → 先请求确认，不直接画到屏上', () => {
    const { state, effects } = land('https://docs.other-example.test/help');
    const ask = effectsOfKind(effects, 'requestCrossSiteConfirm');
    expect(ask).toHaveLength(1);
    // 卡片念的是完整 hostname——本阶段没有品牌提取，只能说字面上的地址。
    expect(ask[0]?.from).toBe('console.example.test');
    expect(ask[0]?.to).toBe('docs.other-example.test');
    expect(effectsOfKind(effects, 'present')).toHaveLength(0);
    expect(state.pendingCrossSite).toBe('docs.other-example.test');
  });

  it('P-2b. 同一 host → 照常展示，不打扰用户', () => {
    const { state, effects } = land('https://console.example.test/help');
    expect(effectsOfKind(effects, 'requestCrossSiteConfirm')).toHaveLength(0);
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
    expect(state.pendingCrossSite).toBeUndefined();
  });

  it('P-2c. 子域名不同也算跨站——不猜「是不是同一家」', () => {
    expect(effectsOfKind(land('https://docs.example.test/help').effects, 'requestCrossSiteConfirm')).toHaveLength(1);
  });

  it('P-2d. 这一步没有 href（按钮、非链接）→ 不是跨站，照常展示', () => {
    const tbl = table([{ ref: 'e1', role: 'button', name: '打开帮助' }], { url: 'https://console.example.test/app' });
    const inflight = {
      effectId: 'E1', kind: 'callModel' as const,
      at: { threadRev: 3, snapshotId: tbl.snapshotId, structureHash: tbl.structureHash, url: tbl.url },
    };
    const { effects } = step(baseState({ inflight, table: tbl }), {
      kind: 'effect_result', effectId: 'E1', at: inflight.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: envelope }, nextEffectId: 'E3',
    });
    expect(effectsOfKind(effects, 'requestCrossSiteConfirm')).toHaveLength(0);
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
  });

  it('P-2e. 用户否掉 → 停在原地，不展示，也不再花任何一次调用', () => {
    const asked = land('https://docs.other-example.test/help').state;
    const { state, effects } = step(asked, { kind: 'cross_site_decision', confirmed: false });
    expect(effectsOfKind(effects, 'present')).toHaveLength(0);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(0);
    expect(state.callCount).toBe(asked.callCount);
    expect(state.pendingCrossSite).toBeUndefined();
  });

  it('P-2e2. 否掉之后要说一句话——卡片消失、屏上没有步骤、一个字都不说，读起来就是坏了', () => {
    const asked = land('https://docs.other-example.test/help').state;
    const { effects } = step(asked, { kind: 'cross_site_decision', confirmed: false });
    const said = effectsOfKind(effects, 'notify')[0]?.message ?? '';
    // 说清楚两件事：没带你去，以及这条路就停在这儿了。
    expect(said).toContain('docs.other-example.test');
    expect(said.length).toBeGreaterThan(0);
  });

  it('P-2f. 用户放行 → 这一步才画到屏上，并记下「上一跳是已确认的跨站跳转」', () => {
    const asked = land('https://docs.other-example.test/help').state;
    const { state, effects } = step(asked, { kind: 'cross_site_decision', confirmed: true });
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
    expect(state.pendingCrossSite).toBeUndefined();
    // P-3 要用它：只有紧跟在已确认跨站跳转之后的落地页才做凭据字段检查。
    expect(state.crossedTo).toBe('docs.other-example.test');
  });
});

describe('machine.ts · step — 落地页要密码就停下（P-3）', () => {
  const HERE = table([{ ref: 'e1', role: 'link', name: '继续' }], { url: 'https://console.example.test/app' });
  const LANDED_SAFE = table([{ ref: 'f1', role: 'link', name: '帮助首页' }], {
    url: 'https://docs.elsewhere.test/help', snapshotId: 's2', structureHash: 'h2',
  });
  const LANDED_ASKS_FOR_CREDENTIALS = table(
    [
      { ref: 'f1', role: 'textbox', name: '用户名' },
      { ref: 'f2', role: 'textbox', name: '密码', sensitive: true },
    ],
    { url: 'https://docs.elsewhere.test/help', snapshotId: 's2', structureHash: 'h2' },
  );

  const crossed = (over: Partial<ThreadState> = {}) =>
    baseState({ table: HERE, crossedTo: 'docs.elsewhere.test', history: [{ title: '继续', url: HERE.url, action: 'taken' }], ...over });

  it('P-3a. 刚确认过跨站，落地页出现凭据字段 → 模型回答落地时停下，它说的什么都不照做', () => {
    const { state, effects } = readThenAnswer(crossed(), LANDED_ASKS_FOR_CREDENTIALS, 'done', DONE_RAW, { kind: 'loaded', url: LANDED_ASKS_FOR_CREDENTIALS.url });

    expect(effectsOfKind(effects, 'callModel')).toHaveLength(0);
    expect(effectsOfKind(effects, 'done')).toHaveLength(0);
    expect(state.ending).toBe('credentials_stop');
    // 已经做了的那一步仍记着做了：先到先得。
    expect(state.history.at(-1)).toMatchObject({ action: 'taken', effect: { kind: 'moved', to: LANDED_ASKS_FOR_CREDENTIALS.url } });
    // 文案必须只描述我们观察到的事实，不做「这是钓鱼网站」这类无法证实的判断。
    const said = effectsOfKind(effects, 'notify')[0]?.message ?? '';
    expect(said).toContain('docs.elsewhere.test');
    expect(said).not.toMatch(/钓鱼|诈骗|不安全|恶意/);
  });

  it('P-3a2. 读数本身不停下任何东西：落地页读到了，只唤醒模型', () => {
    const { state, effects } = step(crossed(), { kind: 'reading', reading: { kind: 'loaded', url: LANDED_ASKS_FOR_CREDENTIALS.url }, table: LANDED_ASKS_FOR_CREDENTIALS, nextEffectId: 'fx' });
    expect(state.ending).toBeUndefined();
    expect(effects.map((e) => e.kind)).toEqual(['callModel']);
  });

  it('P-3b. 刚确认过跨站，但落地页不含凭据字段 → 照常继续', () => {
    const point = JSON.stringify({ route: [{ at: '帮助首页', goal: '看帮助' }], ref: 'f1', action: 'click', why: '帮助首页' });
    const { state, effects } = readThenAnswer(crossed(), LANDED_SAFE, 'point', point);
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
    expect(state.ending).toBeUndefined();
    // 检查过一次就用掉了：再往后的页面属于用户自己选择停留的站点。
    expect(state.crossedTo).toBeUndefined();
  });

  it('P-3c. 没有刚确认过跨站 → 同样有凭据字段的页面不触发停止', () => {
    // 「这一页要你输密码」在你自己选择的站点上稀松平常，只有在刚被带到一个
    // 陌生站点之后才值得为它停下来。
    const { state } = readThenAnswer(crossed({ crossedTo: undefined }), LANDED_ASKS_FOR_CREDENTIALS, 'done', DONE_RAW);
    expect(state.ending).toBe('model_done');
  });
});

describe('machine.ts · step — read_doc 只抓页面自己链出去的地方（06）', () => {
  const withLink = (href?: string) =>
    table([{ ref: 'e9', role: 'link', name: '查看文档', ...(href ? { href } : {}) }], {
      url: 'https://console.example.test/app',
    });
  const envelope = JSON.stringify({ via_ref: 'e9', query: '怎么停止实例' });
  const land = (tbl: ReturnType<typeof withLink>) => {
    const inflight = {
      effectId: 'E1', kind: 'callModel' as const,
      at: { threadRev: 3, snapshotId: tbl.snapshotId, structureHash: tbl.structureHash, url: tbl.url },
    };
    return step(baseState({ inflight, table: tbl }), {
      kind: 'effect_result', effectId: 'E1', at: inflight.at,
      outcome: { ok: true, providerCalls: 1, tool: 'read_doc', value: envelope }, nextEffectId: 'E3',
    });
  };

  it('06a. 干净的页面链接 → fetchDoc 带上已批准的绝对地址，面板拿到的永远是批过的', () => {
    const { effects } = land(withLink('https://docs.example.test/ec2/stop'));
    const fetches = effectsOfKind(effects, 'fetchDoc');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe('https://docs.example.test/ec2/stop');
  });

  it('06b. 命中结构红旗 → 不发抓取；拒绝的原因（连同真正会去的站点）作为这一轮的结果交回模型', () => {
    const { state, effects } = land(withLink('https://console.example.test@evil.test/d'));
    expect(effectsOfKind(effects, 'fetchDoc')).toHaveLength(0);
    const result = state.turn?.rounds.at(-1)?.result;
    expect(result?.kind === 'no_doc' && result.reason).toContain('evil.test');
    expect(effectsOfKind(effects, 'notify')).toHaveLength(0);
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });

  it('06c. via_ref 在表里找不到对应链接 → 不发抓取，不抛错，原因交回模型', () => {
    const { state, effects } = land(withLink(undefined));
    expect(effectsOfKind(effects, 'fetchDoc')).toHaveLength(0);
    expect(state.turn?.rounds.at(-1)?.result).toMatchObject({ kind: 'no_doc' });
    expect(effectsOfKind(effects, 'callModel')).toHaveLength(1);
  });
});

describe('machine.ts · step — 落点只记真的换了地方的那一次', () => {
  /**
   * `effect` 记的是「这一步**成就了什么**」，换了视图时连去向一起记。页面在原地注水，
   * 旧日会先把这一步记成「只在原地变了」，真正的落地页后到就再也写不进去——兜底
   * 于是把模型正确的自我纠正「回到 Issues 列表」判成打转，真机第五轮四次全被挡。
   *
   * 现在一步只结算一次：模型在它之后回答的那一刻，拿「它被指出来时的那一页」和
   * 「最后读到的那一页」比。注水和落地谁先到都无所谓，回答看到的是最后那一页。
   */
  const FROM = table([{ ref: 'e1', role: 'link', name: 'Issues' }], {
    url: 'https://x.test/repo', structureHash: 'h1', snapshotId: 's1',
  });
  const HYDRATED: PromptTable = { ...FROM, structureHash: 'h2', snapshotId: 's2' };   // 同一页，注水
  // 落地页上仍然有一个同名的「Issues」导航项——这正是兜底会不会误判的关键：
  // 判据只看标题，所以真正决定成败的是那条历史记录里的落点对不对。
  const LANDED = table(
    [
      { ref: 'e9', role: 'link', name: 'New issue' },
      { ref: 'e19', role: 'link', name: 'Issues' },
    ],
    { url: 'https://x.test/repo/issues', structureHash: 'h3', snapshotId: 's3' },
  );
  const pending = () => baseState({ table: FROM, history: [{ title: 'Issues', url: FROM.url, action: 'taken' }] });
  const pointAt = (ref: string) => JSON.stringify({ route: [{ at: 'issue 列表', goal: '继续' }], ref, action: 'click', why: '继续' });

  it('L-1. 只在原地注水、模型就此回答 → 只在原地变了，不写去向', () => {
    const { state } = readThenAnswer(pending(), HYDRATED, 'done', DONE_RAW);
    expect(state.history.at(-1)).toEqual({ title: 'Issues', url: FROM.url, action: 'taken', effect: { kind: 'changed_in_place' } });
  });

  it('L-2. 先注水、落地页在模型作答时才到 → 那次回答作废，重问之后记的是落地页', () => {
    const hydrated = step(pending(), { kind: 'reading', reading: { kind: 'changed' }, table: HYDRATED, nextEffectId: 'a' }).state;
    const landed = step(hydrated, { kind: 'reading', reading: { kind: 'loaded', url: LANDED.url }, table: LANDED, nextEffectId: 'unused' }).state;
    const again = step(landed, {
      kind: 'effect_result', effectId: 'a', at: landed.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: DONE_RAW }, nextEffectId: 'b',
    }).state;
    // A `done` on another view is not the exception: it was about the page before.
    expect(again.history.at(-1)?.effect).toBeUndefined();
    const { state } = step(again, {
      kind: 'effect_result', effectId: 'b', at: again.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: DONE_RAW }, nextEffectId: 'c',
    });
    expect(state.history.at(-1)).toEqual({ title: 'Issues', url: FROM.url, action: 'taken', effect: { kind: 'moved', to: LANDED.url } });
  });

  it('L-3. 兜底不误判——落地之后「回到 Issues」是纠正，不是打转', () => {
    const { effects } = readThenAnswer(pending(), LANDED, 'point', pointAt('e19'));
    expect(effectsOfKind(effects, 'done')).toHaveLength(0);
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
  });

  it('L-4. 已经记下的去向不被后来的页面改写', () => {
    const first = readThenAnswer(pending(), LANDED, 'point', pointAt('e9')).state;
    expect(first.history[0]?.effect).toEqual({ kind: 'moved', to: LANDED.url });
    const elsewhere = table([{ ref: 'e2', role: 'link', name: 'x' }], {
      url: 'https://x.test/other', structureHash: 'h9', snapshotId: 's9',
    });
    const { state } = readThenAnswer(first, elsewhere, 'done', DONE_RAW);
    expect(state.history[0]?.effect).toEqual({ kind: 'moved', to: LANDED.url });
    expect(state.history[1]?.effect).toEqual({ kind: 'moved', to: elsewhere.url });
  });

  it('L-5. 一步都没走过时什么也不记，不凭空造一条', () => {
    const { state } = readThenAnswer(baseState({ table: FROM, history: [] }), LANDED, 'done', DONE_RAW);
    expect(state.history).toEqual([]);
  });

  it('L-6. 只换了查询参数也是换了地方 → 写落点（下一页、换筛选条件都是新视图）', () => {
    const PAGE_1 = table([{ ref: 'e1', role: 'link', name: '下一页' }], {
      url: 'https://x.test/issues?page=1', structureHash: 'h1', snapshotId: 's1',
    });
    const PAGE_2 = table([{ ref: 'e2', role: 'link', name: '上一页' }], {
      url: 'https://x.test/issues?page=2', structureHash: 'h1', snapshotId: 's2',
    });
    const prior = baseState({ table: PAGE_1, history: [{ title: '下一页', url: PAGE_1.url, action: 'taken' }] });
    const { state } = readThenAnswer(prior, PAGE_2, 'done', DONE_RAW);

    expect(state.history.at(-1)).toEqual({ title: '下一页', url: PAGE_1.url, action: 'taken', effect: { kind: 'moved', to: PAGE_2.url } });
  });
});

describe('machine.ts · step — 兜底要分清打转和合理重用', () => {
  const HOME = table([{ ref: 'e1', role: 'button', name: '搜索框' }], { url: 'https://x.test/' });
  const REPO = table([{ ref: 'e1', role: 'button', name: '搜索框' }], {
    url: 'https://x.test/repo', snapshotId: 's2', structureHash: 'h2',
  });
  const envelope = JSON.stringify({
    route: [{ at: '某页', goal: '继续' }],
    ref: 'e1', action: 'click', why: '再用一次搜索框',
  });
  const land = (tbl: PromptTable, history: ThreadState['history']) => {
    const inflight = {
      effectId: 'E1', kind: 'callModel' as const,
      at: { threadRev: 3, snapshotId: tbl.snapshotId, structureHash: tbl.structureHash, url: tbl.url },
    };
    return step(baseState({ inflight, table: tbl, history }), {
      kind: 'effect_result', effectId: 'E1', at: inflight.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: envelope }, nextEffectId: 'E3',
    });
  };

  it('B-1. 上次用它到了别处，现在人已经在别处 → 再用一次是合理的，不该拦', () => {
    // 搜索框把用户带到了 /repo，现在他在 /repo 上想再搜点别的。同名控件，
    // 但这不是打转——拦下来就是把一次正当的操作说成「看起来已经到了」。
    const { effects } = land(REPO, [
      { title: '搜索框', url: 'https://x.test/', action: 'taken', effect: { kind: 'moved', to: 'https://x.test/repo' } },
    ]);
    expect(effectsOfKind(effects, 'done')).toHaveLength(0);
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
  });

  it('B-2. 上次用它到了这里，现在还在这里，又指它 → 原地打转，拦', () => {
    const { effects } = land(HOME, [
      { title: '搜索框', url: 'https://x.test/', action: 'taken', effect: { kind: 'changed_in_place' } },
    ]);
    const done = effectsOfKind(effects, 'done');
    expect(done).toHaveLength(1);
    expect(done[0]?.ending).toBe('loop_backstop');
  });

  it('B-2b. 兜底拦下之后线程要终结——说了「已经停下」就不能接着规划', () => {
    // `background.ts` 的 done 分支靠这条不变量清掉浮层：线程结束、steps 清空，
    // 就没有东西可指了——它对 source:'model' 成立，对 source:'backstop' 一直不成立。于是
    // 浮层被清掉、面板说「引导在原地打转，已经停下」，而线程还活着、steps 还
    // 在，下一次页面变化照样重新规划、照样烧配额。真机第五轮第一次触发兜底，
    // 3 次全是这个样子，每次都多走了一跳。
    //
    // 结束方式记为打转兜底，不是「模型说到了」：兜底没有断言目标达成，它只
    // 是断言走不下去了。确认了几步是 Run record 的另一半，按历史算——`seen`
    // 的条件要求至少有一条执行过、页面也变了的一步才可能命中，所以不会是「一步都没有」。
    const { state } = land(HOME, [
      { title: '搜索框', url: 'https://x.test/', action: 'taken', effect: { kind: 'changed_in_place' } },
    ]);
    expect(state.ending).toBe('loop_backstop');
    expect(state.steps).toEqual([]);
    expect(state.cursor).toBe(0);
  });

  it('B-2c. 终结之后再来输入，一律不动——和模型自己发 done 之后是同一条规矩', () => {
    const stopped = land(HOME, [
      { title: '搜索框', url: 'https://x.test/', action: 'taken', effect: { kind: 'changed_in_place' } },
    ]).state;
    const moved: PromptTable = { ...HOME, structureHash: 'zz', snapshotId: 'zz' };
    const { state, effects } = step(stopped, { kind: 'reading', reading: { kind: 'changed' }, table: moved, nextEffectId: 'fx-after' });
    expect(effects).toEqual([]);
    expect(state.callCount).toBe(stopped.callCount);
  });
});

describe('machine.ts · step — slice 11: 整趟步数用完', () => {
  it('11. 已经走了 12 步，本该开第 13 步的读数 → 不产出 callModel，结束方式记为配额用完，附一个展示 effect', () => {
    const prior = baseState({ rev: 20, callCount: 30, spentSteps: 12 });
    const changedTable: PromptTable = { ...DELETE_TABLE, structureHash: 'h2', snapshotId: 's2' };
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: changedTable, nextEffectId: 'fx-13th' });

    expect(effectsOfKind(effects, 'callModel')).toEqual([]);
    expect(state.ending).toBe('quota_exhausted');
    expect(state.callCount).toBe(30); // not incremented — the attempt never happened
    expect(effectsOfKind(effects, 'notify')).toHaveLength(1);
  });

});

describe('thread.ts · encodeThread/decodeThread — slice 13/14', () => {
  it('13. 任意合法 ThreadState 经编码再解码，与原值逐字段相等', () => {
    const original: ThreadState = baseState({
      rev: 7,
      route: [{ at: 'a', goal: 'b' }],
      steps: [{ ref: 'e8' as Ref, descriptor: { role: 'button', name: '删除' }, expectedUserAction: 'click', title: '删除' }],
      cursor: 0,
      callCount: 4,
      stepCalls: 0, spentSteps: 0,
      inflight: { effectId: 'x', kind: 'fetchDoc', at: { threadRev: 7, snapshotId: 's', structureHash: 'h', url: 'u' } },
    });

    const decoded = decodeThread(encodeThread(original));
    expect(decoded).toEqual(original);
  });

  it('14. rev 字段缺失或类型错误 → 返回 null，不抛错', () => {
    expect(decodeThread({})).toBeNull();
    expect(decodeThread({ rev: 'not-a-number', goal: 'x' })).toBeNull();
    expect(() => decodeThread({ rev: '7' })).not.toThrow();
  });
});

describe('machine.ts · step — slice 15: 用真实语料跑 start → effect_result', () => {
  it('15. 真实 DeepSeek 输出：start 产出 callModel，effect_result 消费其原始输出后产出 present(那一步)', () => {
    // 不钉在某个 slice 号上。哪一条 slice 进得了语料取决于当天的抽样——曾经
    // slice 1 那一轮就落进了 `malformedToolCalls`。这条测试要的是"任意一条
    // 真实的、可绑定的 point 语料"，钉住一个 slice 号只会让它随抽样红绿。
    const call = goldenGuideCalls.find(
      (c) => c.tool === 'point' && c.annotation.expectedFirstStepBinding === 'bound',
    );
    if (!call) throw new Error('语料里没有一条可绑定的 point');
    const tbl = TABLES[call.tableId];

    const started = step(null, { kind: 'start', goal: call.goal, table: tbl, effectId: 'fx-real-1' });
    expect(effectsOfKind(started.effects, 'callModel')).toHaveLength(1);
    expect(started.state.inflight?.effectId).toBe('fx-real-1');

    // Independent cross-check, not `step`'s own output: what a fresh
    // `guideAgent.parseOutput`/`guideAgent.validate` pass over the *exact same raw text*
    // says the first step should be — this is the "已通过 02 的校验" the plan
    // describes, verified here rather than assumed.
    const parsed = guideAgent.parseOutput(call.tool, call.rawOutput);
    if (parsed.kind !== 'ok' || parsed.envelope.intent !== 'point') throw new Error('fixture is not a point');
    const validated = guideAgent.validate(parsed.envelope, tbl);
    expect(validated.kind).toBe('ok');
    expect(call.annotation.expectedFirstStepBinding).toBe('bound');

    const result = step(started.state, {
      kind: 'effect_result',
      effectId: 'fx-real-1',
      at: { threadRev: started.state.rev, snapshotId: tbl.snapshotId, structureHash: tbl.structureHash, url: tbl.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: call.rawOutput },
      nextEffectId: 'fx-unused',
    });

    expect(result.state.inflight).toBeNull();
    expect(result.state.steps).toHaveLength(1);
    expect(result.state.steps[0]?.ref).toBe(parsed.envelope.ref);
    const presents = effectsOfKind(result.effects, 'present');
    expect(presents).toHaveLength(1);
    expect(presents[0]?.step.ref).toBe(parsed.envelope.ref);
  });
});

describe('machine.ts · step — 确定性', () => {
  it('同一个 {state, input} 连续调用两次，两次返回值深度相等', () => {
    const state = baseState({ rev: 8 });
    const input: MachineInput = {
      kind: 'reading', reading: { kind: 'changed' }, table: { ...DELETE_TABLE, structureHash: 'hx', snapshotId: 'sx' }, nextEffectId: 'fx-det',
    };

    const first = step(state, input);
    const second = step(state, input);

    expect(second).toEqual(first);
  });
});

/* ═══════════ 跨重规划的记忆 ═══════════ */

describe('machine.ts · step — history 独立于 steps，跨重规划存活', () => {
  it('1/2. start 后 history 为空；point 落地 → 追加一条还没有结果的 {title, url}', () => {
    const { state: started } = step(null, { kind: 'start', goal: '把这台实例删掉', table: DELETE_TABLE, effectId: 'fx-1' });
    expect(started.history).toEqual([]);

    const { state } = step(started, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-unused',
    });

    expect(state.history).toEqual([{ title: '删除实例', url: DELETE_TABLE.url }]);
  });

  it('3. 读数只唤醒模型，不结算上一条；模型回答时才记它做成了什么', () => {
    const prior = baseState({ history: [{ title: '删除实例', url: DELETE_TABLE.url, action: 'taken' }] });
    const moved: PromptTable = { ...DELETE_TABLE, structureHash: 'h2', snapshotId: 's2' };

    const woke = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: moved, nextEffectId: 'fx-9' });
    expect(woke.state.history).toEqual(prior.history);

    // Changed in place: the page changed, but `moved` is only for a *different
    // address* — a page finishing its own load did not get anywhere, and only
    // `moved` carries where the step **got to**. Writing the page it started
    // on is a sentence the model reads back as 「之后到了 <同一个地址>」, and the
    // backstop reads as proof the step moved nobody.
    const { state } = readThenAnswer(prior, moved, 'done', DONE_RAW);
    expect(state.history).toEqual([
      { title: '删除实例', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' } },
    ]);
  });

  it('5. 连续两次 point → history 累积两条，steps 只剩最新那一步', () => {
    // This is the whole point of the field: `steps`/`cursor` are
    // replaced wholesale on every replan, so a memory hanging off them would
    // be erased exactly when it is needed — which is what made the live guide
    // re-propose the step the user had just finished, on every page.
    const first = step(null, { kind: 'start', goal: '把这台实例删掉', table: DELETE_TABLE, effectId: 'fx-1' }).state;
    const afterOne = step(first, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-unused',
    }).state;

    const movedTable = table([{ ref: 'e9', role: 'button', name: '确认删除', path: ['确认框'] }], {
      structureHash: 'h2',
      snapshotId: 's2',
      url: 'https://example.test/confirm',
    });
    const replanning = step(afterOne, { kind: 'reading', reading: { kind: 'used', how: 'clicked' }, table: movedTable, nextEffectId: 'fx-2' }).state;
    const afterTwo = step(replanning, {
      kind: 'effect_result',
      effectId: 'fx-2',
      at: { threadRev: replanning.rev, snapshotId: 's2', structureHash: 'h2', url: movedTable.url },
      outcome: {
        ok: true,
        providerCalls: 1,
        tool: 'point',
        value: JSON.stringify({
          route: [{ at: '确认框', goal: '确认删除' }],
          ref: 'e9', action: 'click', why: '确认这次删除',
        }),
      },
      nextEffectId: 'fx-unused',
    }).state;

    expect(afterTwo.history).toEqual([
      { title: '删除实例', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'moved', to: movedTable.url } },
      { title: '确认删除', url: movedTable.url },
    ]);
    expect(afterTwo.steps).toHaveLength(1);
    expect(afterTwo.steps[0]?.ref).toBe('e9');
  });
});

/* ═══════════ 终态与重复兜底 ═══════════ */

const inflightAt = { effectId: 'fx-1', kind: 'callModel' as const, at: { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url } };
const resultAt = { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url };

describe('machine.ts · step — done 信封与重复兜底', () => {
  it('11c. 同页变化 → callModel 带上新出现的 ref；跨页导航 → 一个都不带', () => {
    // 判据是 Place（origin + pathname），不是整个地址：查询串多一个跟踪参数
    // 不算换了页。跨页时所有控件都是新的，标记没有信息量。
    const before = table([{ ref: 'e1', role: 'button', name: '克隆' }]);
    const opened = table([
      { ref: 'e1', role: 'button', name: '克隆' },
      { ref: 'e2', role: 'link', name: '复制地址' },
    ]);
    const prior = baseState({ table: before, steps: [], cursor: 0 });

    const same = step(prior, { kind: 'reading', reading: { kind: 'changed' }, table: opened, nextEffectId: 'fx-a' });
    const call = same.effects.find((e) => e.kind === 'callModel');
    expect(call && 'freshRefs' in call ? call.freshRefs : null).toEqual(['e2']);

    const elsewhere = step(prior, {
      kind: 'reading',
      reading: { kind: 'loaded', url: 'https://example.test/other' },
      table: table([{ ref: 'e9', role: 'button', name: '别处' }], { url: 'https://example.test/other', snapshotId: 's9' }),
      nextEffectId: 'fx-b',
    });
    const call2 = elsewhere.effects.find((e) => e.kind === 'callModel');
    expect(call2 && 'freshRefs' in call2).toBe(false);
  });

  it('11b. 终态线程不再接受推进类输入——结束方式是状态，不是标签', () => {
    // 没有这道守卫，`done` 根本变不成终态：页面再动一次，引导就又开始指路了。
    // 配额耗尽、安全停止同理——每个终态都是刻意到达的，没有一个想再走一步。
    const finished = baseState({ ending: 'model_done', steps: [], cursor: 0 });
    const moved = step(finished, { kind: 'reading', reading: { kind: 'changed' }, table: table([{ ref: 'e9', role: 'button', name: '别的' }]), nextEffectId: 'fx-9' });
    expect(moved.effects).toEqual([]);
    expect(moved.state.ending).toBe('model_done');
    // 但用户可以重新开始——`start` 是唯一还接受的输入。
    const restarted = step(finished, { kind: 'start', goal: '换一个目标', table: DELETE_TABLE, effectId: 'fx-10' });
    expect(restarted.state.ending).toBeUndefined();
    expect(restarted.effects.some((e) => e.kind === 'callModel')).toBe(true);
  });

  it('11. done 信封 → 终态：不再 present，撤掉步骤，结束方式记为模型说到了', () => {
    // 带着两步、停在第二步：撤掉步骤要看得出来，默认的空步骤分不出撤没撤。
    const prior = baseState({
      inflight: inflightAt,
      steps: [
        { ref: 'e8' as Ref, descriptor: { role: 'button', name: '删除实例' }, expectedUserAction: 'click', title: '删除实例' },
        { ref: 'e9' as Ref, descriptor: { role: 'button', name: '确认' }, expectedUserAction: 'click', title: '确认' },
      ],
      cursor: 1,
    });

    const { state, effects } = step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: resultAt,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: JSON.stringify({ why: '当前页面已经是 issues 列表' }) },
      nextEffectId: 'fx-unused',
    });

    expect(effectsOfKind(effects, 'done')).toHaveLength(1);
    expect(effectsOfKind(effects, 'done')[0]?.why).toBe('当前页面已经是 issues 列表');
    expect(effectsOfKind(effects, 'present')).toEqual([]);
    // 曾经这里断言 `active`，理由是「模型的自评不足以独自结束一次 run」。那个顾虑
    // 是对的，但它把用户的反对权放错了地方：`status` 留在 active 的后果是高亮还
    // 指着一个按钮，屏幕上同时说「看起来已经到了」和「点这里」。真机 21 轮里 11
    // 轮提了不止一次 done，一轮提了五次，106 跳里有 21 跳发生在模型已经说到了之后。
    // 反对的方式是重新发起一次引导（`start` 是终态线程唯一还接受的输入），而不是
    // 继续给一个刚被告知「你到了」的人派下一步。
    expect(state.ending).toBe('model_done');
    expect(state.steps).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.inflight).toBeNull();
    // 终结方式记为「模型说到了」，与兜底、固定计划走完的 done 区分开。
    expect(effectsOfKind(effects, 'done')[0]?.ending).toBe('model_done');
  });

  it('12. 新指的这一步与刚判 confirmed 的那一步同名同页 → 不 present，走 done 同一条路', () => {
    const prior = baseState({
      inflight: inflightAt,
      history: [{ title: '删除实例', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' } }],
    });

    const { effects } = step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: resultAt,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW }, // 这一步的 title === '删除实例'
      nextEffectId: 'fx-unused',
    });

    expect(effectsOfKind(effects, 'present')).toEqual([]);
    expect(effectsOfKind(effects, 'done')).toHaveLength(1);
  });

  it('13. 同名但上一条还没判 confirmed → 照常 present（同名不等于重复）', () => {
    // Filling the same field twice is legitimate. Only a step that was *just*
    // completed has no reason to be redone.
    const prior = baseState({
      inflight: inflightAt,
      history: [{ title: '删除实例', url: DELETE_TABLE.url, action: 'unavailable' }],
    });

    const { effects } = step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: resultAt,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-unused',
    });

    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
    expect(effectsOfKind(effects, 'done')).toEqual([]);
  });
});

describe('machine.ts · step — 到达与打转是两件事', () => {
  it('D. 模型自己说 done 与兜底判定打转，带着不同的 source，调用方才能说不同的话', () => {
    // Both used to reach the renderer as the same `{kind:'done', why}` and come
    // out as the same sentence, 「看起来已经到了：…」. They are opposites: one
    // says the journey arrived, the other says it stopped going anywhere.
    const table = DELETE_TABLE;
    const inflight = {
      effectId: 'E1',
      kind: 'callModel' as const,
      at: { threadRev: 3, snapshotId: table.snapshotId, structureHash: table.structureHash, url: table.url },
    };
    const resultWith = (value: string, prior: ThreadState, tool = 'done') =>
      step(prior, { kind: 'effect_result', effectId: 'E1', at: inflight.at, outcome: { ok: true, providerCalls: 1, tool, value }, nextEffectId: 'E3' });

    const fromModel = resultWith(
      JSON.stringify({ why: '你要的东西已经在这一页上了' }),
      baseState({ inflight, table }),
      'done',
    );
    const modelDone = effectsOfKind(fromModel.effects, 'done');
    expect(modelDone).toHaveLength(1);
    expect(modelDone[0]?.ending).toBe('model_done');

    const fromBackstop = resultWith(
      JSON.stringify({
        route: [{ at: '控制台', goal: '删掉实例' }],
        ref: 'e8', action: 'click', why: '再点一次删除',
      }),
      baseState({ inflight, table, history: [{ title: '删除实例', url: table.url, action: 'taken', effect: { kind: 'changed_in_place' } }] }),
      'point',
    );
    const backstopDone = effectsOfKind(fromBackstop.effects, 'done');
    expect(backstopDone).toHaveLength(1);
    expect(backstopDone[0]?.ending).toBe('loop_backstop');
    // The backstop's own words must not claim an arrival it has no evidence for.
    expect(backstopDone[0]?.why).not.toContain('已经到了');
  });
});

describe('machine.ts · step — 重复兜底覆盖跨页同名', () => {
  it('12b. 刚在 A 页确认的控件，在 B 页又被提议 → 仍然拦下（真实的循环几乎都是跨页的）', () => {
    // Live rounds 1 and 4: the first step was proposed on the repo page and
    // re-proposed on the page it navigated to, because the same nav control is
    // present on both. The url condition this backstop originally carried let
    // exactly that through.
    const other = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }], {
      url: 'https://example.test/other',
      structureHash: 'h9',
    });
    const prior = baseState({
      table: other,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 3, snapshotId: 's1', structureHash: 'h9', url: other.url } },
      history: [{ title: '删除实例', url: 'https://example.test/console', action: 'taken', effect: { kind: 'changed_in_place' } }],
    });

    const { effects } = step(prior, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: { threadRev: 3, snapshotId: 's1', structureHash: 'h9', url: other.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-unused',
    });

    expect(effectsOfKind(effects, 'present')).toEqual([]);
    expect(effectsOfKind(effects, 'done')).toHaveLength(1);
  });
});

/* ═══════════ 重构步骤②：修复调用计入配额（设计文档 §5.9） ═══════════ */

describe('machine.ts · step — providerCalls 让配额说的话变成真的', () => {
  const at = { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url };
  const inflight = { effectId: 'fx-1', kind: 'callModel' as const, at };

  it('Q13-1. 一次调用一次请求 → callCount 不动（派发时已经记过那一次）', () => {
    const prior = baseState({ inflight, callCount: 4 });
    const { state } = step(prior, {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
      nextEffectId: 'fx-2',
    });
    expect(state.callCount).toBe(4);
  });

  it('Q13-2. 跑了修复轮 → 两次请求，callCount 补记第二次', () => {
    // 这是这次修改要还的债：修复轮发生在 effect *内部*，宿主看不见，于是
    // 12 次派发最多能真的发出 24 次请求，而 callCount 一直报 12。
    const prior = baseState({ inflight, callCount: 4 });
    const { state } = step(prior, {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 2, value: POINT_RAW },
      nextEffectId: 'fx-2',
    });
    expect(state.callCount).toBe(5);
  });

  it('Q13-3. 作答期间来过读数、被 E-3 丢弃的结果，钱照样是花掉了的', () => {
    const prior = baseState({ inflight, callCount: 4, readings: [{ kind: 'changed' }] });
    const { state } = step(prior, {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 2, value: POINT_RAW },
      nextEffectId: 'fx-2',
    });
    // 补记的第 2 次 + E-3 自动重规划派发的那一次
    expect(state.callCount).toBe(6);
  });

  it('Q13-4. providerCalls 为 0（请求根本没发出去）不会倒扣配额', () => {
    const prior = baseState({ inflight, callCount: 4, transportFails: 1 });
    const { state } = step(prior, {
      kind: 'effect_result', effectId: 'fx-1', at,
      // 已经自动重试过，所以这一次是「告诉用户」那条路：没有新的调用去动配额。
      outcome: { ok: false, error: '连接超时', retryable: true, failureKind: 'transport', providerCalls: 0 },
      nextEffectId: 'fx-2',
    });
    expect(state.callCount).toBe(4);
  });

});

/* ═══════════ 重构步骤②：三种失败，三种说法（Q7） ═══════════ */

describe('machine.ts · step — 侧栏否决的信封不再一律说「调用失败」', () => {
  const at = { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url };
  const inflight = { effectId: 'fx-1', kind: 'callModel' as const, at };
  /** `transportFails: 1` 表示这一步刚刚已经自动重试过一次——传输层的失败要到
   *  第二次才说给用户听，见下面那条专门的用例。 */
  const notifyText = (kind: EffectFailureKind, error: string) => {
    const { effects } = step(baseState({ inflight, transportFails: 1 }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: false, error, retryable: true, failureKind: kind, providerCalls: 1 },
      nextEffectId: 'fx-2',
    });
    return effectsOfKind(effects, 'notify').map((e) => e.message);
  };

  it('Q7-1. transport → 「调用失败」（这一条本来就是对的）', () => {
    expect(notifyText('transport', '连接超时')).toEqual(['调用失败：连接超时']);
  });

  it('Q7-1b. 撞上思考模式那堵墙：原话之外，多一句他能照着做的话', () => {
    // 引导跑到一半撞上它，和在设置页上撞上它，是同一堵墙。两处说同一句话，
    // 而且出自同一个模块——两套文案是没有测试抓得住的分叉。
    const [said] = notifyText('transport', '端点返回 HTTP 400。does not support being set to required or object in thinking mode');
    expect(said).toContain('does not support being set to required');
    expect(said).toContain('思考模式');
    expect(said).toContain('关掉思考，再试一次');
  });

  it('Q7-1c. 别的传输失败不会被安上一句没量过的解释', () => {
    expect(notifyText('transport', '连接超时')).toEqual(['调用失败：连接超时']);
  });

  // 「这一趟没走通」和「模型没答好」是两回事：前者再走一遍就可能通，而让用户
  // 把目标重打一遍会开一趟新的，把已经走过的路丢掉。
  it('Q7-4. 第一次传输层失败：不打扰用户，原样再问一次', () => {
    const { state, effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: false, error: '连接超时', retryable: true, failureKind: 'transport', providerCalls: 1 },
      nextEffectId: 'fx-2',
    });
    expect(effectsOfKind(effects, 'notify')).toEqual([]);
    expect(effects.some((e) => e.kind === 'callModel')).toBe(true);
    expect(state.transportFails).toBe(1);
  });

  it('Q7-5. 连着第二次：告诉用户，并且这条可以再试', () => {
    const { effects } = step(baseState({ inflight, transportFails: 1 }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: false, error: '连接超时', retryable: true, failureKind: 'transport', providerCalls: 1 },
      nextEffectId: 'fx-2',
    });
    expect(effectsOfKind(effects, 'notify')).toEqual([{ kind: 'notify', message: '调用失败：连接超时', canRetry: true }]);
  });

  it('Q7-6. 不可重试的失败（钥匙被拒这一类）：不自动再试，也不给重试入口', () => {
    const { effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: false, error: 'API Key 被拒', retryable: false, failureKind: 'transport', providerCalls: 1 },
      nextEffectId: 'fx-2',
    });
    expect(effects.some((e) => e.kind === 'callModel')).toBe(false);
    expect(effectsOfKind(effects, 'notify')).toEqual([{ kind: 'notify', message: '调用失败：API Key 被拒' }]);
  });

  it('Q7-6b. 用户自己能改好的失败：说的时候带上去哪里改（侧栏据此给出「打开模型配置」）', () => {
    const { effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: false, error: 'API Key 被拒', retryable: false, failureKind: 'transport', fix: 'model', providerCalls: 1 },
      nextEffectId: 'fx-2',
    });
    expect(effectsOfKind(effects, 'notify')).toEqual([{ kind: 'notify', message: '调用失败：API Key 被拒', fix: 'model' }]);
  });

  it('Q7-7. 用户点「再试一次」：同一趟原样再问，不是新开一趟', () => {
    const prior = baseState({ callCount: 2 });
    const { state, effects } = step(prior, { kind: 'retry', nextEffectId: 'fx-9' });
    expect(effects.some((e) => e.kind === 'callModel')).toBe(true);
    expect([state.goal, state.callCount]).toEqual([prior.goal, 3]);
  });

  it('Q7-2. parse → 说的是模型没给出信封，不是调用失败', () => {
    expect(notifyText('parse', '缺少 why 字段')).toEqual(['模型输出无法解析：缺少 why 字段']);
  });

  it('Q7-3. violation → 说的是信封被规则拒了，不是调用失败', () => {
    // 用户的计划因为点了密码框被 R-e 拒掉，却被告知「调用失败」——调用成功了，
    // 而且拒绝的理由恰恰是最值得告诉他的那句话。
    expect(notifyText('violation', 'steps[0].ref 指向敏感字段')).toEqual(['模型输出不合法：steps[0].ref 指向敏感字段']);
  });

  it('Q7-4. 侧栏否决与宿主自己重新判定，同一种失败说同一句话', () => {
    // 宿主拿得到原文时会自己再判一次（§8.3「判定权在 Host」）。两条路径通向
    // 同一个结论，措辞必须一致，否则用户看到的是哪一句取决于谁先发现——而那
    // 是没有任何测试看得见的分歧。
    const badRef = JSON.stringify({
      route: [{ at: 'x', goal: 'y' }],
      ref: 'e999', action: 'click', why: '表里没有这个 ref',
    });
    const { effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: badRef },
      nextEffectId: 'fx-2',
    });
    const texts = effectsOfKind(effects, 'notify').map((e) => e.message);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.startsWith('模型输出不合法：')).toBe(true);
  });
});

/* ═══════════ 工具路径：宿主也要能自己重新判一次（§8.3） ═══════════ */

describe('machine.ts · step — tool calling 的结果，宿主同样自己重新求导', () => {
  const at = { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url };
  const inflight = { effectId: 'fx-1', kind: 'callModel' as const, at };
  /** 工具路径的 value 是 arguments 原文——里面本来就没有 intent。 */
  const TOOL_ARGS = JSON.stringify({
    route: [{ at: '实例操作区域', goal: '删除这台实例' }],
    ref: 'e8', action: 'click', why: '点击删除实例按钮',
  });

  it('T-1. 带上工具名 → 照常产出步骤（工具名就是 intent）', () => {
    const { state, effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: TOOL_ARGS },
      nextEffectId: 'fx-2',
    });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.ref).toBe('e8');
    expect(effectsOfKind(effects, 'present')).toHaveLength(1);
  });

  it('T-2. 不带工具名 → 说不出这是哪一种信封，这正是真机上 7/7 挂掉的那一下', () => {
    // 侧栏当时是成功的，挂的是这里：宿主拿文本解析器去读一份没有 intent 的
    // arguments。整套单测当时全绿，因为没有一条覆盖这条路。
    const { state, effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 1, value: TOOL_ARGS },
      nextEffectId: 'fx-2',
    });
    expect(state.steps).toHaveLength(0);
    const texts = effectsOfKind(effects, 'notify').map((e) => e.message);
    expect(texts[0]).toContain('没有工具名');
  });

  it('T-3. 工具名与 arguments 都在，但引用了表外的 ref → 照旧被 R-a 拒掉', () => {
    // schema 的 enum 收窄了可能性，没有取代校验：实测 strict 也不是全强制。
    const outside = JSON.stringify({ route: [{ at: 'x', goal: 'y' }], ref: 'e999', action: 'click', why: '表里没有' });
    const { effects } = step(baseState({ inflight }), {
      kind: 'effect_result', effectId: 'fx-1', at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: outside },
      nextEffectId: 'fx-2',
    });
    expect(effectsOfKind(effects, 'notify').map((e) => e.message)[0]).toContain('模型输出不合法');
  });
});


/* ═══════════ 重画：只画属于这一页的那一步 ═══════════ */

describe('machine.ts · stepOnScreen 只画属于这一页的步', () => {
  const STEPS: [GuideStep, GuideStep] = [
    { descriptor: { role: 'link', name: 'Docs' }, expectedUserAction: 'click', title: '打开文档' },
    { descriptor: { role: 'button', name: 'API Reference' }, expectedUserAction: 'click', title: '打开 API 参考' },
  ];
  const DOCS = table([{ ref: 'e2', role: 'button', name: 'API Reference', path: ['主导航'] }], {
    url: 'https://example.test/docs', structureHash: 'h-docs', snapshotId: 's-docs',
  });
  it('S-1. 模型规划、有调用在途 → 不重画：手上的步骤属于刚离开的那一页（L-4）', () => {
    const inflight = { effectId: 'fx-1', kind: 'callModel' as const, at: { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: DELETE_TABLE.url } };
    expect(stepOnScreen(baseState({ steps: STEPS, table: DOCS, inflight }))).toBeNull();
  });

  it('S-2. 模型规划、没有调用在途 → 画当前这一步，和第一次呈现一模一样', () => {
    // The model's thread holds only the step on screen; two have been shown.
    const history = [{ title: '打开文档', url: DELETE_TABLE.url, action: 'taken' as const }, { title: STEPS[1]!.title, url: DELETE_TABLE.url }];
    const shown = stepOnScreen(baseState({ steps: [STEPS[1]!], cursor: 0, history }));
    expect(shown).toEqual({ kind: 'present', step: STEPS[1], index: 1, total: null });
  });

  it('S-4. 已经结束的，或者手上没有步骤的 → 什么都不画', () => {
    expect(stepOnScreen(baseState({ steps: STEPS, ending: 'steps_walked' }))).toBeNull();
    expect(stepOnScreen(baseState({ steps: [] }))).toBeNull();
  });
});

describe('machine.ts · step — 一步的结果：action × effect（04）', () => {
  // 两个字段各记一件事：那一步有没有被执行（action），这一页之后怎么样了（effect）。
  // 旧的单值把两件事焊在一起——「点了、这一页没变」被叫作 failed。真机 t11 里
  // 这样记下的 9 步，全是复制按钮、在新标签页打开的链接这类：点了、也起了作用，
  // 只是这个标签页没变。action 由「用户用了它」的读数证明，effect 在模型下一次
  // 回答时结算。
  const onScreen = (title: string) => ({ title, url: DELETE_TABLE.url });
  const USED: Reading = { kind: 'used', how: 'clicked' };
  const elsewhere = table([{ ref: 'e9', role: 'link', name: 'New issue' }], {
    url: 'https://example.test/console/issues',
    snapshotId: 's-elsewhere',
  });

  it('A-1. 点了、模型回答时这一页没变 → action taken、effect none，不再叫 failed', () => {
    const again = { ...DELETE_TABLE, snapshotId: 's-again' };
    const { state } = readThenAnswer(baseState({ history: [onScreen('Copy URL to clipboard')] }), again, 'done', DONE_RAW, USED);
    expect(state.history.at(-1)).toEqual({
      title: 'Copy URL to clipboard', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'none' },
    });
  });
  it('A-2. 同一个视图上东西变了 → effect changed_in_place', () => {
    const expanded: PromptTable = {
      ...DELETE_TABLE,
      snapshotId: 's-expanded',
      items: [...DELETE_TABLE.items, { ref: 'e30' as Ref, role: 'button', name: '复制地址', path: ['克隆'] }],
    };
    const { state } = readThenAnswer(baseState({ history: [onScreen('Code')] }), expanded, 'done', DONE_RAW, USED);
    expect(state.history.at(-1)).toEqual({
      title: 'Code', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' },
    });
  });
  it('A-3. 换了视图 → effect moved，并带着去了哪——模型读到的「之后到了 X」就靠它', () => {
    const { state } = readThenAnswer(baseState({ history: [onScreen('Issues')] }), elsewhere, 'done', DONE_RAW, USED);
    expect(state.history.at(-1)).toEqual({
      title: 'Issues', url: DELETE_TABLE.url, action: 'taken', effect: { kind: 'moved', to: elsewhere.url },
    });
  });
  it('A-6. 定了「找不到」之后页面换了 → 模型回答时照样记下去向（真机 t09 出现过两次）', () => {
    const prior = baseState({ history: [{ title: '删除', url: DELETE_TABLE.url, action: 'unavailable' as const }] });
    const { state } = readThenAnswer(prior, elsewhere, 'done', DONE_RAW);
    expect(state.history.at(-1)).toEqual({
      title: '删除', url: DELETE_TABLE.url, action: 'unavailable', effect: { kind: 'moved', to: elsewhere.url },
    });
  });
  it('A-7. 已经结算过的一步，之后页面再换 → 保持原样，不改写', () => {
    const settled = { title: 'Copy', url: DELETE_TABLE.url, action: 'taken' as const, effect: { kind: 'none' as const } };
    const { state } = readThenAnswer(baseState({ history: [settled] }), elsewhere, 'done', DONE_RAW);
    expect(state.history.at(-1)).toEqual(settled);
  });
});

describe('transitions.ts · presentationIdOf — 宿主签发的呈现身份', () => {
  // 画一步和核对「这一轮没找到」的报告共用这一个推导：两边算法不一致，
  // 迟到的报告就会被记到别的一步头上。
  const one = baseState({ history: [{ title: '打开实例操作', url: DELETE_TABLE.url }] });

  it('同一步重画（换了快照、换了表）还是同一次呈现', () => {
    const repainted: ThreadState = { ...one, table: { ...DELETE_TABLE, snapshotId: 's-repaint' }, rev: one.rev + 3 };
    expect(presentationIdOf('tab-1', repainted)).toBe(presentationIdOf('tab-1', one));
  });

  it('换上新的一步，就是新的一次呈现；不同的标签页也不相同', () => {
    const next: ThreadState = { ...one, history: [...one.history, { title: '删除这台实例', url: DELETE_TABLE.url }] };
    expect(presentationIdOf('tab-1', next)).not.toBe(presentationIdOf('tab-1', one));
    expect(presentationIdOf('tab-2', one)).not.toBe(presentationIdOf('tab-1', one));
  });
});
