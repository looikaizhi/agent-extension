import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EffectRequest } from '@/agent/thread/effect';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import {
  applyGuideInput,
  applyReading,
  endGuide,
  type GuideEffectDeps,
} from '@/agent/thread/writer';
import type { RunRecord } from '@/agent/thread/record';
import { RUN_RECORDS_KEY, type RecordStore } from '@/agent/thread/record-store';
import { encodeThread, type ThreadState } from '@/agent/thread/thread';
import { guideThreadExists } from '@/agent/thread/writer';
import { bindingFromAck } from '@/agent/thread/binding';
import { step } from '@/agent/thread/machine';
import { presentationIdOf } from '@/agent/thread/transitions';
import { structureFingerprint, pageStructureChanged } from '@/core/extractor/fingerprint';
import type { ExtractStats, PromptItem, PromptTable } from '@/core/extractor/types';
import type { UINode } from '@/core/extractor/types';
import { flagStore } from './fixtures/flag-store';
import {
  describeBinding,
  describeCheck,
  describeEvidence,
} from '@/entrypoints/sidepanel/view-model';
import type { HighlightAck } from '@/shared/protocol';
import { makeRef, type Ref } from '@/shared/types';

/**
 * `route` consumption, per-page re-planning, and the
 * three orthogonal axes actually reaching the renderer. Every expectation
 * below is derived from the plan/design doc's own text (§5.3/§5.7, and this
 * file's own Gotchas), not from running the code first and pasting its
 * output back — the same discipline `machine.spec.ts`/`effect.spec.ts`
 * document for 03/04.
 *
 * The content script's actual `MutationObserver` wiring (slices 7/10) is
 * e2e-only (`tests/e2e/smoke.mjs`) — this file only covers the pure
 * comparison logic underneath it (`pageStructureChanged`), per the plan's
 * own "只测 e2e" carve-out for those two slices.
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

const THREAD_ID = 'tab-1' as ThreadId;
const TABLE = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }]);

const pointRaw = (at: string, goal: string, ref = 'e8') => JSON.stringify({ route: [{ at, goal }], ref, action: 'click', why: '点击以继续' });

function harness() {
  const data = new Map<string, unknown>();
  const order: string[] = [];
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => {
      order.push(...Object.keys(items).map((k) => `set:${k}`));
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (k) => {
      order.push(`remove:${k}`);
      data.delete(k);
    },
  };
  const now = { value: 1_000 };
  let minted = 0;
  const records: RunRecord[] = [];
  let recordFailure: string | null = null;
  let recordThrows = false;
  const recordStore: RecordStore = {
    get: async () => ({ [RUN_RECORDS_KEY]: records }),
    set: async (items) => {
      if (recordThrows) throw new Error('QUOTA_BYTES_EXCEEDED');
      order.push('record');
      const next = items[RUN_RECORDS_KEY] as RunRecord[];
      records.length = 0;
      records.push(...next);
    },
    // Driven by `recordFailure`: the quota check inside `writeRunRecord` is what
    // decides, so a test forces the refusal by making the store look full.
    bytesInUse: async () => (recordFailure ? 1_000_000 : 0),
    quota: 1_000,
  };
  // The Plugin switches, as a harness would write them before a run.
  const flags: Record<string, unknown> = {};
  const deps: GuideEffectDeps = {
    store,
    records: recordStore,
    flags: flagStore(flags),
    recent: async () => [],
    send: () => order.push('send'),
    now: () => now.value,
    newEffectId: () => `gen-${++minted}`,
  };
  return {
    store,
    deps,
    order,
    now,
    records,
    flags,
    failRecords: () => {
      recordFailure = 'full';
    },
    // The platform's own refusal, which arrives as a throw rather than as the
    // quota pre-check's `ok: false`. These are different failure paths and only
    // one of them used to be covered.
    throwOnRecordWrite: () => {
      recordThrows = true;
    },
  };
}

/**
 * Gives the stored thread one step it has pointed at, leaving everything else
 * — an in-flight call included — as it is. A run that never pointed at a step
 * was a question, and leaves no Run record (CONTEXT.md `Question`); the
 * tests of how a run's record is written need one that did.
 */
async function pointedAtOneStep(store: ThreadStore) {
  const k = `guide:${THREAD_ID}`;
  const t = (await store.get(k))[k] as ThreadState;
  await store.set({ [k]: { ...t, history: [{ title: '删除实例', url: t.table.url }] } });
}

/* ═══════════ slice 1/2: route 的展示与消费 ═══════════ */

describe('agent/thread/writer.ts · route — slice 1/2: route 全貌展示，逐字段一致、不拼接', () => {
  it('1. 一次 callModel 结果返回后，ThreadState.route 与该次结果里的 route 逐字段一致', async () => {
    const { deps } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: '删掉这台实例', table: TABLE, effectId: 'fx-1' });
    const at = started.state!.inflight!.at;

    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('实例操作区域', '删除这台实例') },
    });

    expect(result.state!.route).toEqual([{ at: '实例操作区域', goal: '删除这台实例' }]);
  });

  it('2. 第二次重规划返回新的 route 后，ThreadState.route 整体替换为最新一次的，不与第一次的拼接或去重', async () => {
    const { deps } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: '删掉这台实例', table: TABLE, effectId: 'fx-1' });
    const at1 = started.state!.inflight!.at;
    const first = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: at1,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('实例操作区域', '删除这台实例') },
    });
    expect(first.state!.route).toEqual([{ at: '实例操作区域', goal: '删除这台实例' }]);

    // A reading wakes the model again: a second, independent callModel
    // dispatch and a second, differently-shaped route.
    //
    // The moved page carries a *different* control, which is what a real
    // second step points at. It used to reuse `e8` on an otherwise identical
    // table, and 07's repeat backstop correctly refused it: proposing the very
    // control the user had just been confirmed to finish, on the same URL, is
    // the loop that backstop exists to break. The fixture was the unrealistic
    // half — this test is about `route` being replaced, not about re-proposing
    // a finished step.
    const movedTable: PromptTable = {
      ...table([{ ref: 'e9', role: 'button', name: '确认删除', path: ['确认对话框'] }]),
      structureHash: 'h2',
      snapshotId: 's2',
    };
    const replanned = await applyReading(deps, THREAD_ID, { kind: 'changed' }, async () => movedTable);
    const again = replanned!.state!.inflight!;
    const second = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: again.effectId,
      at: again.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('确认对话框', '确认删除', 'e9') },
    });

    const route = second.state!.route;
    expect(route).toEqual([{ at: '确认对话框', goal: '确认删除' }]);
    // Not the union, not the concatenation of both — the first hop is gone.
    expect(route).not.toContainEqual({ at: '实例操作区域', goal: '删除这台实例' });
    expect(route).toHaveLength(1);
  });
});

/* ═══════════ slice 3: evidence 初始值 ═══════════ */

describe('machine.ts · step — slice 3: ThreadState.evidence 初始为 model', () => {
  it('3. start 产出的全新 ThreadState，evidence === "model"，check === "unknown"', () => {
    const { state } = step(null, { kind: 'start', goal: 'x', table: TABLE, effectId: 'fx-1' });
    expect(state.evidence).toBe('model');
    expect(state.check).toBe('unknown');
  });
});

/* ═══════════ slice 4: 没有代码路径直接写 'pass' ═══════════ */

describe('架构护栏 — slice 4: check 只由 judgeArrival 判出 pass', () => {
  const SRC = join(process.cwd(), 'src');
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  }
  const files = walk(SRC);
  const read = (p: string) => readFileSync(p, 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('4a. src 下没有任何代码把 .check 直接赋值为字面量 "pass"——只有 judgeArrival 能判出到达', () => {
    // The assertion is 05's, unchanged. Its stated reason was not: 05 said
    // `'pass'` was unreachable until S4's `precheckLink` existed, and 07 showed
    // the cheaper judge was already in the contract (`expect_after`, parsed
    // since 01 and then dropped on the floor). `judgeArrival` returns it, so
    // the axis moves — but through one function that weighs the arrived page,
    // never through a literal someone stamped on. That is what this grep has
    // always actually been protecting, and it still holds.
    const offenders = files.filter((f) => /check\s*[:=]\s*'pass'/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

});

/* ═══════════ slice 5: 三轴的展示文案彼此独立 ═══════════ */

describe('sidepanel/view-model.ts · describeEvidence/describeCheck/describeBinding — slice 5', () => {
  it('5a. 三个轴各自的取值都有非空、互不相同的文案', () => {
    const evidenceTexts = (['documented', 'model'] as const).map(describeEvidence);
    const checkTexts = (['pass', 'unknown', 'skipped'] as const).map(describeCheck);
    const bindingTexts = (['bound', 'ambiguous', 'unbound'] as const).map(describeBinding);
    for (const t of [...evidenceTexts, ...checkTexts, ...bindingTexts]) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
    // evidence 现在只有两个取值：'handpicked' 随固定计划一起删了，检视器画的那个
    // 框不再开一趟引导，所以没有东西会写下它。
    expect(new Set(evidenceTexts).size).toBe(2);
    expect(new Set(checkTexts).size).toBe(3);
    expect(new Set(bindingTexts).size).toBe(3);
  });

  it('5b. binding 为 unbound 时，evidence/check 各自仍然独立可读——不因为某一轴的取值而让另两轴的文案跟着消失或改变', () => {
    const evidence = describeEvidence('model');
    const check = describeCheck('unknown');
    const bindingUnbound = describeBinding('unbound');
    const bindingBound = describeBinding('bound');
    // Changing `binding` alone must not change what `evidence`/`check` say.
    expect(describeEvidence('model')).toBe(evidence);
    expect(describeCheck('unknown')).toBe(check);
    expect(bindingUnbound).not.toBe(bindingBound);
  });
});

/* ═══════════ HighlightAck → Binding 翻译 ═══════════ */

describe('agent/thread/binding.ts · bindingFromAck', () => {
  const ackOf = (over: Partial<HighlightAck>): HighlightAck => ({ resolved: null, rect: null, ...over });

  it('resolved 非空 → bound', () => {
    expect(bindingFromAck(ackOf({ resolved: makeRef(0, 1) }))).toBe('bound');
  });

  it('resolved 为空但 candidates 非空 → ambiguous（K-6：多个命中，不挑一个）', () => {
    expect(bindingFromAck(ackOf({ candidates: [makeRef(0, 1), makeRef(0, 2)] }))).toBe('ambiguous');
  });

  it('resolved 为空、candidates 也为空、failure 存在 → unbound', () => {
    expect(bindingFromAck(ackOf({ failure: 'ref_not_found' }))).toBe('unbound');
    expect(bindingFromAck(ackOf({ failure: 'snapshot_stale' }))).toBe('unbound');
    expect(bindingFromAck(ackOf({ failure: 'sensitive_blocked' }))).toBe('unbound');
  });
});

/* ═══════════ slice 6/7 的纯逻辑一半：pageStructureChanged ═══════════ */

describe('core/extractor/fingerprint.ts · pageStructureChanged — slice 6/7', () => {
  // `structureFingerprint` reads `location.origin`/`location.pathname` — a live-DOM
  // global this repo's node-environment vitest run does not provide (no
  // jsdom/happy-dom dependency; `core/extractor/*` is otherwise proven only
  // by the e2e suite). Stubbed here, minimally, purely so the *comparison*
  // logic (`pageStructureChanged`) can be exercised against `structureFingerprint`'s
  // real output rather than hand-typed hash strings.
  vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/console' });

  const node = (over: Partial<UINode>): UINode => ({
    ref: makeRef(0, 1),
    role: 'button',
    name: 'x',
    rect: [0, 0, 10, 10],
    inViewport: true,
    frameId: 0,
    nameSource: 'content',
    ...over,
  });

  it('6. 仅普通交互元素变化（landmark/heading 结构不变）→ structureFingerprint 相同 → 不应上报', () => {
    const before = [node({ role: 'main', name: '实例列表', ref: makeRef(0, 1) })];
    // A button appearing after an async load — not a landmark, not a heading.
    const after = [...before, node({ role: 'button', name: '新按钮', ref: makeRef(0, 2) })];
    const h1 = structureFingerprint(before);
    const h2 = structureFingerprint(after);
    expect(h1).toBe(h2);
    expect(pageStructureChanged(h1, h2)).toBe(false);
  });

  it('7. landmark/heading 结构确实变化（如"实例列表"页跳转为"实例详情"页，URL 不变的 SPA 场景）→ structureFingerprint 不同 → 应上报', () => {
    const listPage = [node({ role: 'main', name: '实例列表', ref: makeRef(0, 1) })];
    const detailPage = [node({ role: 'main', name: '实例详情', ref: makeRef(0, 1) })];
    const h1 = structureFingerprint(listPage);
    const h2 = structureFingerprint(detailPage);
    expect(h1).not.toBe(h2);
    expect(pageStructureChanged(h1, h2)).toBe(true);
  });

  it('pageStructureChanged 对首次上报（previousHash 为 null）总是判定为变化', () => {
    expect(pageStructureChanged(null, structureFingerprint([]))).toBe(true);
  });
});

describe('agent/thread/writer.ts · endGuide — 一趟引导结束只有一个地方说了算', () => {
  /**
   * 今天这五件事散在「用户点结束引导」那一个消息分支里，而归约器有五种终态、
   * 外部还有三种结束方式，其余七条路都不执行它们。把它收成一处之后，加一种新
   * 的结束方式不必再去八个调用点各补一遍。
   *
   * 并发是这里的第一等公民，不是补丁：MV3 的多个监听器并发跑，而
   * `applyGuideInput` 先把线程读进内存、再写回去——中间被删掉的话它会把已经
   * 结束的线程原样写回来。
   */
  const startedThread = async (h: ReturnType<typeof harness>) => {
    const started = await applyGuideInput(h.deps, THREAD_ID, {
      kind: 'start',
      goal: '把这台实例删掉',
      table: TABLE,
      effectId: 'fx-1',
    });
    await pointedAtOneStep(h.store);
    return started;
  };

  it('E-1. 摘要在删线程之前落盘——这是这趟运行最后一次还存在、可被记录的时刻', async () => {
    const h = harness();
    await startedThread(h);
    h.order.length = 0;

    const ending = await endGuide(h.deps, THREAD_ID, 'user_ended');

    expect(ending.ended).toBe(true);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.goal).toBe('把这台实例删掉');
    // 顺序，不是「两件事都做了」：夹具记录存储调用序列，落盘必须排在删除前。
    expect(h.order.indexOf('record')).toBeGreaterThan(-1);
    expect(h.order.indexOf('record')).toBeLessThan(h.order.indexOf(`remove:guide:${THREAD_ID}`));
  });

  it('E-2. 在途的 Effect 被中止，并把它的 id 交回给调用方去广播', async () => {
    const h = harness();
    const started = await startedThread(h);
    expect(started.state?.inflight?.effectId).toBe('fx-1');

    const ending = await endGuide(h.deps, THREAD_ID, 'user_ended');
    expect(ending.cancelledEffectId).toBe('fx-1');
  });

  it('E-3. 重复终结是无操作——不写第二条记录，也不再要求广播', async () => {
    const h = harness();
    await startedThread(h);
    await endGuide(h.deps, THREAD_ID, 'user_ended');
    h.order.length = 0;

    const again = await endGuide(h.deps, THREAD_ID, 'user_ended');

    expect(again.ended).toBe(false);
    expect(again.cancelledEffectId).toBeNull();
    expect(h.records).toHaveLength(1);
    expect(h.order).toEqual([]);
  });

  it('E-4. 压根没有线程时也是无操作，不凭空造一条记录', async () => {
    const h = harness();
    const ending = await endGuide(h.deps, THREAD_ID, 'user_ended');
    expect(ending.ended).toBe(false);
    expect(h.records).toEqual([]);
  });

  it('E-5. 摘要写不进去也要把引导结束掉，并把失败交回去告诉用户', async () => {
    // 记录丢了比引导卡死轻：一条写不进的摘要不该让线程永远活着，
    // 而那正是「已完成的线程劫持后续引导」那个缺陷的形状。
    const h = harness();
    await startedThread(h);
    h.failRecords();

    const ending = await endGuide(h.deps, THREAD_ID, 'user_ended');

    expect(ending.ended).toBe(true);
    expect(ending.recordError).toContain('没能保存');
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
    expect(ending.cancelledEffectId).toBe('fx-1');
  });

  it('E-5b. 存储层直接抛异常时也一样——引导仍然结束，异常不得逃出去', async () => {
    // `writeRunRecord` 的 `ok:false` 只是它自己的配额**预测**；平台真正拒绝时
    // 是抛出来的。让它逃出去会跳过下面的删除，留下的正是这个函数存在的理由要
    // removes 的那条线程——「记录丢了」是轻伤，「线程删不掉」会带走这个标签页
    // 之后的每一趟引导。
    const h = harness();
    await startedThread(h);
    h.throwOnRecordWrite();

    const ending = await endGuide(h.deps, THREAD_ID, 'user_ended');

    expect(ending.ended).toBe(true);
    expect(ending.recordError).toContain('没能保存');
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
    expect(await h.store.get(`effect:${THREAD_ID}`)).toEqual({});
  });

  it('E-6. 结束之后迟到的 Effect 结果不能把线程写回来', async () => {
    const h = harness();
    const started = await startedThread(h);
    await endGuide(h.deps, THREAD_ID, 'user_ended');

    const late = await applyGuideInput(h.deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('实例操作区域', '删除这台实例') },
    });

    expect(late.state).toBeNull();
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
  });

  it('E-7. 并发：一次输入正在处理时终结插进来，结束之后线程不得复活', async () => {
    // 这是真正的竞态，而不是 E-6 那种「结束早已完成」：`applyGuideInput` 先把
    // 线程读进内存，若终结在它写回之前发生，旧值会被原样写回去。串行队列是解
    // 药——两者共用同一个按线程的键，就不可能交错。
    const h = harness();
    const started = await startedThread(h);

    const [, ending] = await Promise.all([
      applyGuideInput(h.deps, THREAD_ID, {
        kind: 'effect_result',
        effectId: 'fx-1',
        at: started.state!.inflight!.at,
        outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('实例操作区域', '删除这台实例') },
      }),
      endGuide(h.deps, THREAD_ID, 'user_ended'),
    ]);

    expect(ending.ended).toBe(true);
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
    expect(h.records).toHaveLength(1);
  });

  it('E-8. 线程已经没了的时候送一个别的输入 —— 不抛异常、也不写回', async () => {
    // 归约器对「非 start 输入 + 空线程」是抛错的，那在一个消息处理器里会变成
    // 一个没人接的 rejection。守在这一层，而不是让每个调用点各自记得先查。
    const h = harness();
    await startedThread(h);
    await endGuide(h.deps, THREAD_ID, 'user_ended');

    const late = await applyGuideInput(h.deps, THREAD_ID, { kind: 'cross_site_decision', confirmed: true });

    expect(late.state).toBeNull();
    expect(late.effects).toEqual([]);
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
  });
});

describe('agent/thread/writer.ts · 每一种终态都真的结束', () => {
  /**
   * 判据是**状态转换**，不是入口：一次归约给这趟运行记上了结束方式，
   * 就该走终结。归约器有五种这样的转换，而在此之前只有「模型说完成」
   * 那一种会被外面注意到——其余四种把 `guide:{id}` 留在原地，于是所有权查询
   * 永远答「有」，这个标签页之后每一趟引导的点击都被路由给一条已经结束的运行。
   */
  const AT = { threadRev: 3, snapshotId: 's1', structureHash: 'h1', url: TABLE.url };

  const seed = async (h: ReturnType<typeof harness>, over: Partial<ThreadState> = {}) => {
    const state: ThreadState = {
      rev: 3,
      goal: '把这台实例删掉',
      table: TABLE,
      pointedOn: TABLE,
      route: [],
      steps: [],
      cursor: 0,
      // Pointed at once: a run that never had leaves no record to check.
      history: [{ title: '删除实例', url: TABLE.url }],
        evidence: 'model',
      check: 'unknown',
      callCount: 1,
      stepCalls: 0, spentSteps: 0,
      inflight: null,
      ...over,
    };
    await h.store.set({ [`guide:${THREAD_ID}`]: encodeThread(state) });
    h.order.length = 0;
    return state;
  };
  const inflight = { effectId: 'E1', kind: 'callModel' as const, at: AT };
  const resultOf = (tool: string, value: string) => ({
    kind: 'effect_result' as const,
    effectId: 'E1',
    at: AT,
    outcome: { ok: true as const, providerCalls: 1, tool, value },
  });
  const gone = async (h: ReturnType<typeof harness>) => {
    expect(await h.store.get(`guide:${THREAD_ID}`)).toEqual({});
    expect(await h.store.get(`effect:${THREAD_ID}`)).toEqual({});
    expect(h.records).toHaveLength(1);
  };

  it('T-1. 模型说完成', async () => {
    const h = harness();
    await seed(h, { inflight });
    const out = await applyGuideInput(
      h.deps,
      THREAD_ID,
      resultOf('done', JSON.stringify({ evidence: 'content_on_page', why: '地址已经显示在这一页上' })),
    );
    expect(out.state?.ending).toBe('model_done');
    expect(out.ending?.ended).toBe(true);
    await gone(h);
    expect(h.records[0]?.ending).toBe('model_done');
    expect(h.records[0]?.confirmation).toBe('none');
  });

  it('T-2. 整趟步数用完', async () => {
    const h = harness();
    await seed(h, { spentSteps: 12 });
    const moved: PromptTable = { ...TABLE, structureHash: 'h2', snapshotId: 's2', url: 'https://example.test/other' };
    const out = await applyReading(h.deps, THREAD_ID, { kind: 'loaded', url: moved.url }, async () => moved);
    expect(out?.state?.ending).toBe('quota_exhausted');
    expect(out?.ending?.ended).toBe(true);
    await gone(h);
    expect(h.records[0]?.ending).toBe('quota_exhausted');
    expect(h.records[0]?.confirmation).toBe('none');
  });

  it('T-4. 跨站落地页要凭据，为安全停下', async () => {
    const h = harness();
    await seed(h, { crossedTo: 'docs.other-example.test', history: [{ title: '去文档站', url: TABLE.url }] });
    const landing = table([{ ref: 'e1', role: 'textbox', name: '密码', sensitive: true }], {
      url: 'https://docs.other-example.test/login',
      structureHash: 'h9',
      snapshotId: 's9',
    });
    // The landing page is a reading like any other: it wakes the model, and the
    // stop comes when its answer lands, before anything in it is acted on.
    const woke = await applyReading(h.deps, THREAD_ID, { kind: 'loaded', url: landing.url }, async () => landing);
    const call = woke!.state!.inflight!;
    const out = await applyGuideInput(h.deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: call.effectId,
      at: call.at,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: JSON.stringify({ evidence: 'page_address', why: '到了' }) },
    });
    expect(out.state?.ending).toBe('credentials_stop');
    expect(out.ending?.ended).toBe(true);
    await gone(h);
    expect(h.records[0]?.ending).toBe('credentials_stop');
    expect(h.records[0]?.confirmation).toBe('none');
  });

  it('T-5. 循环兜底把引导拦下', async () => {
    const h = harness();
    await seed(h, {
      inflight,
      // 这一步被记成「执行了、页面只在原地变了」——兜底的判据正是它：一个没
      // 把人带到别处的控件被再次指向，就是打转。
      history: [{ title: '删除实例', url: TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' } }],
    });
    const out = await applyGuideInput(
      h.deps,
      THREAD_ID,
      resultOf('point', pointRaw('实例操作区域', '删除这台实例')),
    );
    expect(out.state?.ending).toBe('loop_backstop');
    expect(out.ending?.ended).toBe(true);
    await gone(h);
    expect(h.records[0]?.ending).toBe('loop_backstop');
    expect(h.records[0]?.confirmation).toBe('all');
  });

  it('T-2b. 前几步已确认、随后撞上配额 → 摘要记为「配额用完 + 部分确认」', async () => {
    const h = harness();
    await seed(h, {
      spentSteps: 12,
      history: [
        { title: '搜索', url: TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' } },
        { title: '点了没反应的按钮', url: TABLE.url, action: 'taken', effect: { kind: 'none' } },
      ],
    });
    const moved: PromptTable = { ...TABLE, structureHash: 'h3', snapshotId: 's3', url: 'https://example.test/elsewhere' };
    await applyReading(h.deps, THREAD_ID, { kind: 'loaded', url: moved.url }, async () => moved);
    await gone(h);
    expect(h.records[0]?.ending).toBe('quota_exhausted');
    expect(h.records[0]?.confirmation).toBe('some');
  });

  it.each(['user_ended', 'overlay_closed', 'tab_closed', 'superseded'] as const)(
    'T-11. 从外面结束（%s）→ 摘要记下这种结束方式，确认程度仍按历史算',
    async (how) => {
      const h = harness();
      await seed(h, {
        history: [
          { title: '删除实例', url: TABLE.url, action: 'taken', effect: { kind: 'changed_in_place' } },
          { title: '确认删除', url: TABLE.url },
        ],
      });
      const ending = await endGuide(h.deps, THREAD_ID, how);
      expect(ending.ended).toBe(true);
      await gone(h);
      expect(h.records[0]?.ending).toBe(how);
      expect(h.records[0]?.confirmation).toBe('some');
    },
  );

  it('T-6. 终结之后所有权查询答「没有」——这才是劫持缺陷真正消失', async () => {
    // 缺陷的形状是：`done` 把状态写成完成却留着记录，而所有权查询只问「有没有
    // 这条记录」。删掉之后，同一个标签页里下一趟引导不会被它接走。
    const h = harness();
    await seed(h, { inflight });
    expect(await guideThreadExists(h.store, THREAD_ID)).toBe(true);

    await applyGuideInput(
      h.deps,
      THREAD_ID,
      resultOf('done', JSON.stringify({ evidence: 'page_address', why: '地址栏就是目标' })),
    );

    expect(await guideThreadExists(h.store, THREAD_ID)).toBe(false);
  });

  it('T-7. 摘要仍然在删除之前落盘', async () => {
    const h = harness();
    await seed(h, { inflight });
    await applyGuideInput(
      h.deps,
      THREAD_ID,
      resultOf('done', JSON.stringify({ evidence: 'content_on_page', why: '就在这一页上' })),
    );
    expect(h.order.indexOf('record')).toBeGreaterThan(-1);
    expect(h.order.indexOf('record')).toBeLessThan(h.order.indexOf(`remove:guide:${THREAD_ID}`));
  });

  it('T-9. 两个来源同时终结同一趟引导——只落一条摘要', async () => {
    // 真正会同时发生的一对：模型答 `done`（归约器自己走到终态）与用户关掉标签页
    // （外面直接调 `endGuide`）。两条路都会落盘、都会删线程，所以它们之间没有
    // 串行化的话就是两条摘要加一次对已删线程的二次删除。判据只看结果：恰好一条
    // 记录，且只有一方认领了这次结束。
    const h = harness();
    await seed(h, { inflight });

    const [reduced, closed] = await Promise.all([
      applyGuideInput(
        h.deps,
        THREAD_ID,
        resultOf('done', JSON.stringify({ evidence: 'content_on_page', why: '就在这一页上' })),
      ),
      endGuide(h.deps, THREAD_ID, 'user_ended'),
    ]);

    expect(h.records).toHaveLength(1);
    expect([reduced.ending?.ended === true, closed.ended].filter(Boolean)).toHaveLength(1);
    expect(await guideThreadExists(h.store, THREAD_ID)).toBe(false);
  });

  it('T-8. 还活着的一次归约不会误触终结', async () => {
    const h = harness();
    await seed(h, { callCount: 1 });
    const moved: PromptTable = { ...TABLE, structureHash: 'h2', snapshotId: 's2', url: 'https://example.test/other' };
    const out = await applyReading(h.deps, THREAD_ID, { kind: 'loaded', url: moved.url }, async () => moved);
    expect(out?.state?.ending).toBeUndefined();
    expect(out?.ending).toBeUndefined();
    expect(h.records).toEqual([]);
    expect(await guideThreadExists(h.store, THREAD_ID)).toBe(true);
  });
});

describe('agent/thread/writer.ts · Plugin 的贡献在发出模型调用时收集', () => {
  const GH = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }], { url: 'https://github.com/n8n-io/n8n' });
  const contributionsOf = (sent: readonly EffectRequest[]) => {
    const r = sent[0];
    return r && 'contributions' in r.params ? r.params.contributions : undefined;
  };

  it('PL-1. Skill 默认开：github 上发出的模型调用带着它那一段；一趟只用它开始时的那组开关，设置里关掉，下一趟才不带', async () => {
    const h = harness();
    const started = await applyGuideInput(h.deps, THREAD_ID, { kind: 'start', goal: '看 issue', table: GH, effectId: 'fx-1' });
    expect(contributionsOf(started.sent)?.[0]).toContain('关于这个站点，你需要知道：');
    await applyGuideInput(h.deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: pointRaw('仓库页', '删除这台实例') },
    });

    // Switched off mid-run: this run keeps the set it started with.
    h.flags['plugin:skill'] = false;
    const moved: PromptTable = { ...GH, structureHash: 'h2', snapshotId: 's2', url: 'https://github.com/n8n-io/n8n/issues' };
    const next = await applyReading(h.deps, THREAD_ID, { kind: 'loaded', url: moved.url }, async () => moved);
    expect(next!.sent.map((r) => r.kind)).toEqual(['callModel']);
    expect(contributionsOf(next!.sent)?.[0]).toContain('关于这个站点，你需要知道：');

    // The next run reads the switches afresh.
    await endGuide(h.deps, THREAD_ID, 'user_ended');
    const again = await applyGuideInput(h.deps, THREAD_ID, { kind: 'start', goal: '看 release', table: GH, effectId: 'fx-3' });
    expect(again.sent.map((r) => r.kind)).toEqual(['callModel']);
    expect(contributionsOf(again.sent)).toBeUndefined();
  });

  it('PL-2. 没有它的站点什么也不带', async () => {
    const h = harness();
    const started = await applyGuideInput(h.deps, THREAD_ID, { kind: 'start', goal: 'g', table: TABLE, effectId: 'fx-1' });
    expect(started.sent.map((r) => r.kind)).toEqual(['callModel']);
    expect(contributionsOf(started.sent)).toBeUndefined();
  });

  it('PL-3. Run record 记下这一趟开始时开着的那组 Plugin，中途改了开关也不变；这组随线程一起删掉', async () => {
    const on = harness();
    await applyGuideInput(on.deps, THREAD_ID, { kind: 'start', goal: 'g', table: GH, effectId: 'fx-1' });
    await pointedAtOneStep(on.store);
    on.flags['plugin:skill'] = false;
    await endGuide(on.deps, THREAD_ID, 'user_ended');
    expect(on.records[0]?.plugins).toEqual(['skill', 'memory']);
    expect(await on.store.get(`plugins:${THREAD_ID}`)).toEqual({});

    const off = harness();
    off.flags['plugin:skill'] = false;
    off.flags['plugin:memory'] = false;
    await applyGuideInput(off.deps, THREAD_ID, { kind: 'start', goal: 'g', table: GH, effectId: 'fx-1' });
    await pointedAtOneStep(off.store);
    off.flags['plugin:skill'] = true;
    await endGuide(off.deps, THREAD_ID, 'user_ended');
    expect(off.records[0]?.plugins).toEqual([]);
  });
});

