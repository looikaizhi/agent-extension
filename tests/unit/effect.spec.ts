import { describe, expect, it, vi } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import {
  applyGuideInput,
  claimGuideEffect,
  toEffectRequest,
  peekGuideEffect,
  sweepExpiredGuideEffect,
  type GuideEffectDeps,
} from '@/agent/thread/writer';
import {
  CALL_MODEL_TIMEOUT_MS,
  FETCH_DOC_TIMEOUT_MS,
  deadlineFor,
  judgeRecovery,
  timeoutMsFor,
  type EffectRequest,
} from '@/agent/thread/effect';
import { encodeThread, type ThreadState } from '@/agent/thread/thread';
import { recoverInflightOnMount, runCallModelEffect, runFetchDocEffect } from '@/entrypoints/sidepanel/effects';
import { DEFAULT_CONFIG } from '@/shared/settings';
import type { GuideInflightResponse } from '@/shared/protocol';
import type { ModelDelta } from '@/agent/provider/types';
import { ProviderError } from '@/agent/provider/transport';
import type { ExtractStats, PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { flagStore } from './fixtures/flag-store';
import { answering, finish, textOf, toolCall } from './fixtures/neutral';

/**
 * Design doc §2.6: E-1…E-6 over the two-message protocol. Every
 * expectation below is independently derived from the plan/design doc, the
 * same discipline `machine.spec.ts` documents — nothing here was written by
 * running the code first and pasting its output back.
 *
 * Split into two halves matching the file's own two runtime homes:
 *  - Host side (`agent/thread/writer.ts`'s `applyGuideInput`/`peekGuideEffect`/
 *    `sweepExpiredGuideEffect`) — fake `ThreadStore`,
 *    zero `chrome.*`, slices 1–8.
 *  - Panel side (`entrypoints/sidepanel/effects.ts`'s `runCallModelEffect`/
 *    `runFetchDocEffect`/`recoverInflightOnMount`) — fake `complete`/`fetch`
 *    injected by parameter, zero `chrome.*`, slices 9–13.
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

const TABLE = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }]);
const GOAL = '把这台实例删掉';
const THREAD_ID = 'tab-1' as ThreadId;

const POINT_RAW = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e8',
  action: 'click',
  why: '点击删除实例按钮以发起删除操作',
});

/* ═══════════ Host-side test harness ═══════════ */

function harness(): { store: ThreadStore; deps: GuideEffectDeps; order: string[]; now: { value: number } } {
  const data = new Map<string, unknown>();
  const order: string[] = [];
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => {
      order.push('persist');
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (k) => {
      data.delete(k);
    },
  };
  const now = { value: 1_000 };
  let minted = 0;
  const deps: GuideEffectDeps = {
    flags: flagStore(),
    recent: async () => [],
    store,
    // Never exercised here — these tests drive the effect protocol, not the
    // ending. Present because the dependency object requires it.
    records: { get: async () => ({}), set: async () => {}, bytesInUse: async () => 0, quota: 1_000_000 },
    send: () => order.push('send'),
    now: () => now.value,
    newEffectId: () => `gen-${++minted}`,
  };
  return { store, deps, order, now };
}

describe('agent/thread/writer.ts · applyGuideInput — slice 1: E-1 持久化先于发送', () => {
  it('0. callModel 的 params 逐字带上 effect 上的每一个字段——白名单式拷贝会静默丢字段', () => {
    // `toEffectRequest` 是手写的字段拷贝，加了新字段而忘了这里，它就在线格式上
    // 无声消失。已经发生过一次：`freshRefs` 算出来了、单测也过了，真机 114 次
    // 请求里一次都没出现，因为它没被拷进 params。这条把两边钉在一起。
    const effect = {
      kind: 'callModel' as const,
      effectId: 'fx-1',
      goal: GOAL,
      table: TABLE,
      history: { done: [], route: [] },
      freshRefs: ['e8' as Ref],
      since: { readings: [{ kind: 'changed' as const }], page: 'changed_in_place' as const },
      final: true as const,
    };
    const req = toEffectRequest('tab-1' as ThreadId, effect, { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: TABLE.url }, 0, ['技能段落']);
    for (const k of Object.keys(effect)) {
      if (k === 'kind' || k === 'effectId') continue;
      expect(req?.params, `params 少了 ${k}`).toHaveProperty(k);
    }
    // Plugin 的贡献不在 effect 上——它在归约器之外收集，由调用方交进来。
    expect(req?.params).toHaveProperty('contributions', ['技能段落']);
  });

  it('1. start 产出 callModel effect → 假 store 记录的顺序是 persist 先于 send', async () => {
    const { deps, order } = harness();

    const outcome = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });

    expect(order).toEqual(['persist', 'send']);
    expect(outcome.sent).toHaveLength(1);
    expect(outcome.sent[0]).toMatchObject({ effectId: 'fx-1', threadId: THREAD_ID, kind: 'callModel' });
    expect(outcome.state?.inflight?.effectId).toBe('fx-1');
  });
});

describe('agent/thread/writer.ts · applyGuideInput — slice 2: EFFECT_RESULT 被接受', () => {
  it('2. effectId 与 inflight 相符 → 结果被接受,喂给 step 产出下一个 state', async () => {
    const { deps } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    const at = started.state!.inflight!.at;

    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
    });

    expect(result.state?.inflight).toBeNull();
    expect(result.state?.steps).toHaveLength(1);
    expect(result.state?.steps[0]?.ref).toBe('e8');
    expect(result.effects.some((e) => e.kind === 'present')).toBe(true);
  });
});

describe('agent/thread/writer.ts · applyGuideInput — slice 3: effectId 不符 → 丢弃,不调用 step', () => {
  it('3a. 另一个 effectId → 丢弃,state 不变(同一个 rev),不再持久化/发送', async () => {
    const { deps, order } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    order.length = 0;

    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'wrong-id',
      at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
    });

    expect(result.sent).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result.state).toEqual(started.state); // unchanged — step was never invoked
    expect(order).toEqual([]); // no persist, no send at all
  });

  it('3b. 从来没有任何 inflight(全新 thread)→ 同样丢弃,不抛错', async () => {
    const { deps } = harness();
    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-orphan',
      at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: TABLE.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
    });
    expect(result.state).toBeNull();
    expect(result.sent).toEqual([]);
  });
});

describe('agent/thread/writer.ts · applyGuideInput — slice 4: 重复投递', () => {
  it('4. 同一个合法 EFFECT_RESULT 收到两次 → 第二次被丢弃', async () => {
    const { deps, order } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    const at = started.state!.inflight!.at;
    const input = { kind: 'effect_result' as const, effectId: 'fx-1', at, outcome: { ok: true as const, providerCalls: 1, tool: 'point', value: POINT_RAW } };

    const first = await applyGuideInput(deps, THREAD_ID, input);
    expect(first.state?.steps).toHaveLength(1);

    order.length = 0;
    const second = await applyGuideInput(deps, THREAD_ID, input); // same message again

    expect(second.sent).toEqual([]);
    expect(second.effects).toEqual([]);
    expect(second.state).toEqual(first.state); // untouched
    expect(order).toEqual([]);
  });
});

describe('agent/thread/writer.ts · applyGuideInput — slice 5: E-3 调用在途时来过读数', () => {
  it('5. 页面在调用期间只是原地变了（地址、快照之外唯独结构不同）→ 回答整条丢弃，带着读数自动重问', async () => {
    const { store, deps } = harness();
    const movedTable: PromptTable = { ...TABLE, structureHash: 'h2', snapshotId: 's2' };
    const staleAt = { threadRev: 4, snapshotId: TABLE.snapshotId, structureHash: TABLE.structureHash, url: TABLE.url };
    const seeded: ThreadState = {
      rev: 6,
      goal: GOAL,
      table: movedTable, // the world has since moved on: a reading landed while the call was out
      pointedOn: TABLE,
      readings: [{ kind: 'changed' }],
      route: [],
      steps: [],
      cursor: 0,
      history: [],
        evidence: 'model',
      check: 'unknown',
      callCount: 2,
      stepCalls: 0, spentSteps: 0,
      inflight: { effectId: 'fx-1', kind: 'callModel', at: staleAt },
    };
    await store.set({ [`guide:${THREAD_ID}`]: encodeThread(seeded) });

    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: staleAt, // echoes exactly what was dispatched against — genuinely stale, not malformed
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: POINT_RAW },
    });

    expect(result.state?.steps).toEqual([]); // the stale envelope's content never lands
    expect(result.state?.route).toEqual([]);
    expect(result.state?.callCount).toBe(3); // replanned — one more call spent
    // The id for the replan is minted by `applyGuideInput` (`deps.newEffectId`),
    // never by the caller: whether an `effect_result` will need one at all
    // depends on branches only the reducer can take (an E-3 world mismatch,
    // a `read_doc` envelope), which no caller can predict before the payload
    // has been parsed. Both real callers omitted it, and both throw sites the
    // old optional field guarded were reachable in the live run.
    expect(result.state?.inflight?.effectId).toBe('gen-1');
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]?.effectId).toBe('gen-1');
    expect(result.sent[0]?.kind).toBe('callModel');
    const params = result.sent[0]?.params as { table: PromptTable; since?: unknown };
    expect(params.table).toEqual(movedTable); // replans against the *current* table
    expect(params.since).toEqual({ readings: [{ kind: 'changed' }], page: 'changed_in_place' });
  });
});

describe('agent/thread/writer.ts · applyGuideInput — read_doc 不得把线程焊死', () => {
  it('模型要求抓文档 → 抓取请求真的发出去，线程等的就是它；不再说「扩展还不能读」', async () => {
    const docTable = table([
      { ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] },
      { ref: 'e9', role: 'link', name: '实例管理帮助文档', path: ['页脚'], href: 'https://docs.example.test/instances/delete' },
    ]);
    const { deps } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: docTable, effectId: 'fx-1' });

    const result = await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: started.state!.inflight!.at,
      outcome: {
        ok: true,
        providerCalls: 1,
        tool: 'read_doc',
        value: JSON.stringify({ via_ref: 'e9', query: '删除实例前需要满足什么条件' }),
      },
    });

    // The tombstone is only safe because something will resolve it: the request
    // is on the wire, and a fetch that never answers is swept at its deadline.
    // Before the fetch went out, this tombstone had nothing to resolve it — the
    // live run's 91-second hang, sample 2 of 12.
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]).toMatchObject({ kind: 'fetchDoc', params: { url: 'https://docs.example.test/instances/delete' } });
    expect(result.state?.inflight?.effectId).toBe(result.sent[0]?.effectId);
    expect(result.effects.filter((e) => e.kind === 'notify')).toEqual([]);
  });
});

describe('agent/thread/writer.ts · sweepExpiredGuideEffect — slice 6: E-4 超时判定', () => {
  it('6. 有侧栏认领、deadline 已过 → 判定超时：第一次原样再问一遍，第二次才告诉用户', async () => {
    const { deps, now } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    const req = started.sent[0]!;
    expect(req.deadline).toBe(now.value + CALL_MODEL_TIMEOUT_MS);
    await claimGuideEffect(deps, THREAD_ID, 'fx-1', 'doc-A', async () => true);

    now.value = req.deadline + 1; // strictly past the deadline
    const swept = await sweepExpiredGuideEffect(deps, THREAD_ID);

    // 一次没等到回答，是这一趟没走通，不是模型没答好：原样再走一遍，用户不必知道。
    expect(swept).not.toBeNull();
    expect(swept!.effects.filter((e) => e.kind === 'notify')).toEqual([]);
    expect(swept!.sent).toHaveLength(1);
    expect(swept!.state?.transportFails).toBe(1);

    // 连着第二次就不是抖一下了：告诉用户，并且这条可以再试。
    const again = swept!.sent[0]!;
    await claimGuideEffect(deps, THREAD_ID, again.effectId, 'doc-A', async () => true);
    now.value = again.deadline + 1;
    const twice = await sweepExpiredGuideEffect(deps, THREAD_ID);

    expect(twice!.state?.inflight).toBeNull();
    expect(twice!.effects).toMatchObject([{ kind: 'notify', canRetry: true }]);
    // The wire-side mirror is cleared too — a panel asking afterwards sees nothing.
    expect(await peekGuideEffect(deps.store, THREAD_ID)).toBeNull();
  });

  it('6b. deadline 未到 → 不判定超时,不触碰 state(被动检查,不依赖侧栏上报)', async () => {
    const { deps, now } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    const req = started.sent[0]!;

    now.value = req.deadline - 1;
    const swept = await sweepExpiredGuideEffect(deps, THREAD_ID);

    expect(swept).toBeNull();
    expect((await peekGuideEffect(deps.store, THREAD_ID))?.effectId).toBe('fx-1');
  });
});

/* ═══════════ Panel-side (sidepanel/effects.ts) ═══════════ */

const FAKE_AT = { threadRev: 1, snapshotId: TABLE.snapshotId, structureHash: TABLE.structureHash, url: TABLE.url };

function callModelReq(): EffectRequest & { kind: 'callModel' } {
  return {
    effectId: 'fx-1',
    threadId: THREAD_ID,
    kind: 'callModel',
    params: { goal: GOAL, table: TABLE, history: { done: [], route: [] } },
    at: FAKE_AT,
    deadline: 999_999,
  };
}

/** A fake `callModel()` — the same events the real one produces for a tool
 *  call: the call's start, its arguments a fragment at a time, then the finish
 *  that every stream ends on and that always carries `usage`. */
async function* fakeComplete(raw: string, tool = 'point'): AsyncGenerator<ModelDelta> {
  yield* answering(tool, raw, { pieces: 2 });
}

describe('sidepanel/effects.ts · runCallModelEffect — slice 9/10', () => {
  it('9. 校验通过 → outcome.ok === true,value 是模型原始输出,usage 被转发', async () => {
    const { result } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, () =>
      fakeComplete(POINT_RAW),
    );

    expect(result.effectId).toBe('fx-1');
    expect(result.at).toEqual(FAKE_AT);
    expect(result.outcome.ok).toBe(true);
    if (result.outcome.ok) {
      expect(result.outcome.value).toBe(POINT_RAW);
      expect(result.outcome.usage).toEqual({ prompt: 10, completion: 20, total: 30 });
      // Independent cross-check: what the value actually parses/validates to.
      expect(result.outcome.tool).toBe('point');
      const parsed = guideAgent.parseOutput('point', result.outcome.value as string);
      expect(parsed.kind).toBe('ok');
      if (parsed.kind === 'ok') expect(guideAgent.validate(parsed.envelope, TABLE).kind).toBe('ok');
    }
  });

  it('9b. 信封形状不合(少了一个字段)→ 发起一次修复调用,修好了就照常成功', async () => {
    // 旧日的问答路径早就这么做了（首次解析失败 → 修复请求 → 再解析）。引导路径
    // 没有，于是模型一次输出里少个字段，整条引导就
    // 死在第 0 跳——真机 3×5 里有 1~2 条是这么没的，`retryable: true` 被记下来
    // 却没有任何人读它。
    const broken = JSON.stringify({
      route: [{ at: '控制台', goal: '删掉实例' }],
      ref: 'e8',
      action: 'click', // `why` 缺失
    });
    const calls: string[] = [];
    const { result } = await runCallModelEffect(
      callModelReq(),
      DEFAULT_CONFIG,
      new AbortController().signal,
      (_cfg, messages) => {
        calls.push(JSON.stringify(messages));
        return fakeComplete(calls.length === 1 ? broken : POINT_RAW);
      },
    );

    expect(calls).toHaveLength(2);
    // schema 跟着第一次请求就发出去了，所以修复轮是重抽一次同样的请求，
    // 而不是把格式再讲一遍——两次的消息逐字相同。
    expect(calls[1]).toBe(calls[0]);
    expect(result.outcome.ok).toBe(true);
    if (result.outcome.ok) expect(result.outcome.value).toBe(POINT_RAW);
  });

  it('9d. 模型调了一个没给它的工具 → 当成坏形状，修一次', async () => {
    // 能调的工具只有登记处里那几个。叫不出名字的调用和少了字段的调用是同一类
    // 错：模型没照着给它的形状回答。
    let calls = 0;
    const { result } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, async function* (): AsyncGenerator<ModelDelta> {
      calls += 1;
      if (calls === 1) {
        yield* toolCall('teleport', JSON.stringify({ to: 'e8' }), { id: 'call-1' });
      } else {
        yield* toolCall('point', POINT_RAW, { id: 'call-2' });
      }
      yield finish({ prompt: 1, completion: 1, total: 2, estimated: false });
    });
    expect(calls).toBe(2);
    expect(result.outcome.ok).toBe(true);
    if (result.outcome.ok) expect(result.outcome.tool).toBe('point');
  });

  it('9c. 修复也没救回来 → 如实失败,而且只修一次,不成环', async () => {
    const broken = JSON.stringify({ route: [], ref: 'e8', action: 'click' });
    let n = 0;
    const { result } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, () => {
      n++;
      return fakeComplete(broken);
    });

    expect(n).toBe(2);
    expect(result.outcome.ok).toBe(false);
  });

  it('10. 引用了不在当前表里的 ref(校验失败)→ outcome.ok === false,error 可读,不抛异常', async () => {
    const badRaw = JSON.stringify({ route: [{ at: 'x', goal: 'y' }], ref: 'e999', action: 'click', why: '不存在的元素' });

    const { result } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, () =>
      fakeComplete(badRaw),
    );

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(typeof result.outcome.error).toBe('string');
      expect(result.outcome.error.length).toBeGreaterThan(0);
      expect(result.outcome.retryable).toBe(true);
    }
  });

  it('10b. complete() 本身抛出 ProviderError → outcome.ok === false,不抛出未处理异常', async () => {
    async function* throwing(): AsyncGenerator<ModelDelta> {
      throw new ProviderError('端点拒绝了请求', 'auth', false);
      // eslint-disable-next-line no-unreachable
      yield finish();
    }
    const { result } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, throwing);
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.error).toBe('端点拒绝了请求');
      expect(result.outcome.retryable).toBe(false); // echoes ProviderError's own kind
    }
  });
});

describe('sidepanel/effects.ts · runCallModelEffect — 调试 trace 与结果分开走', () => {
  it('12. trace 与 result 并列返回，不塞进 outcome 里', async () => {
    // 宿主是照着 outcome 做决定的。调试产物一旦混进去，「关掉 trace 会不会
    // 改变行为」就不再是一个能回答的问题。
    const { result, trace } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, () =>
      fakeComplete(POINT_RAW),
    );
    expect(result.outcome.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYS');
    expect(trace).not.toBeNull();
    expect(trace!.entries.map((e) => e.kind)).toEqual(['request', 'raw', 'settled']);
  });

  it('13. trace 记下的 system 就是真发出去的那一份，user 里带着这一页的控件', async () => {
    const sent: string[] = [];
    const { trace } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, (_cfg, messages) => {
      sent.push(textOf(messages[0]), textOf(messages[1]));
      return fakeComplete(POINT_RAW);
    });
    expect(trace!.system).toBe(sent[0]);
    const req = trace!.entries.find((e) => e.kind === 'request');
    expect(req).toMatchObject({ kind: 'request', user: sent[1] });
    expect(sent[1]).toContain('删除实例');
  });

  it('14. 失败的一次也留下记录——最该看的就是这一次', async () => {
    const badRaw = JSON.stringify({ route: [{ at: 'x', goal: 'y' }], ref: 'e999', action: 'click', why: '不存在的元素' });
    const { result, trace } = await runCallModelEffect(callModelReq(), DEFAULT_CONFIG, new AbortController().signal, () =>
      fakeComplete(badRaw),
    );
    expect(result.outcome.ok).toBe(false);
    // 六个事件，不是三个：校验失败现在和解析失败一样买得起一次修复轮。
    // 第二次仍被拒才收手——修复恰好一次、绝不成环，所以 `repair` 只出现一次。
    expect(trace!.entries.map((e) => e.kind)).toEqual([
      'request', 'raw', 'violation', 'repair', 'raw', 'violation',
    ]);
  });
});

describe('sidepanel/effects.ts · runFetchDocEffect — slice 11', () => {
  it('11. 收到 fetchDoc 请求 → 直接 fetch(params.url),不重新做任何授权判断', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response('# 帮助文档正文', { status: 200 });
    }) as typeof fetch;

    const req: EffectRequest & { kind: 'fetchDoc' } = {
      effectId: 'fx-doc',
      threadId: THREAD_ID,
      kind: 'fetchDoc',
      params: { viaRef: 'e88' as Ref, query: '验证码多久过期', url: 'https://example.test/help/expiry' },
      at: FAKE_AT,
      deadline: 999_999,
    };

    const result = await runFetchDocEffect(req, new AbortController().signal, fakeFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://example.test/help/expiry'); // exactly the given url, nothing rewritten
    expect(result.outcome.ok).toBe(true);
    if (result.outcome.ok) expect(result.outcome.value).toBe('# 帮助文档正文');
  });

  it('11b. 抓取失败(HTTP 非 2xx)→ outcome.ok === false,不抛异常', async () => {
    const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    const req: EffectRequest & { kind: 'fetchDoc' } = {
      effectId: 'fx-doc',
      threadId: THREAD_ID,
      kind: 'fetchDoc',
      params: { viaRef: 'e88' as Ref, query: 'q', url: 'https://example.test/missing' },
      at: FAKE_AT,
      deadline: 999_999,
    };
    const result = await runFetchDocEffect(req, new AbortController().signal, fakeFetch);
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) expect(result.outcome.retryable).toBe(true);
  });
});

describe('sidepanel/effects.ts · recoverInflightOnMount — slice 12/13', () => {
  it('13. 未过 deadline 的 inflight → 展示"仍在进行",同样不发起新请求', async () => {
    const fetchSpy = vi.fn();
    const completeSpy = vi.fn();
    const res: GuideInflightResponse = {
      recovery: 'in_progress',
      effect: { ...callModelReq(), deadline: Date.now() + 60_000 },
    };

    const outcome = await recoverInflightOnMount(1, async () => res);

    expect(outcome.recovery).toBe('in_progress');
    expect(outcome.effect?.effectId).toBe('fx-1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('12b/13b. 没有任何 inflight → recovery = none, effect = null', async () => {
    const res: GuideInflightResponse = { recovery: 'none', effect: null };
    const outcome = await recoverInflightOnMount(1, async () => res);
    expect(outcome).toEqual({ recovery: 'none', effect: null });
  });
});

/* ═══════════ effect.ts 纯函数 ═══════════ */

describe('agent/thread/effect.ts · 纯函数', () => {
  it('deadlineFor/timeoutMsFor：callModel 与 fetchDoc 使用各自独立的超时窗口', () => {
    expect(timeoutMsFor('callModel')).toBe(CALL_MODEL_TIMEOUT_MS);
    expect(timeoutMsFor('fetchDoc')).toBe(FETCH_DOC_TIMEOUT_MS);
    expect(deadlineFor('callModel', 1_000)).toBe(1_000 + CALL_MODEL_TIMEOUT_MS);
    expect(deadlineFor('fetchDoc', 1_000)).toBe(1_000 + FETCH_DOC_TIMEOUT_MS);
  });

  it('judgeRecovery：无 → none，未过期 → in_progress，已过期 → expired（边界值 now === deadline 记为已过期）', () => {
    expect(judgeRecovery(null, 1_000)).toBe('none');
    expect(judgeRecovery({ deadline: 2_000, claimedBy: 'doc-A' }, 1_000)).toBe('in_progress');
    expect(judgeRecovery({ deadline: 2_000, claimedBy: 'doc-A' }, 2_000)).toBe('expired');
    expect(judgeRecovery({ deadline: 2_000, claimedBy: 'doc-A' }, 2_001)).toBe('expired');
    // No panel ever took it: it has not started, so it cannot be late (06c).
    expect(judgeRecovery({ deadline: 2_000 }, 2_001)).toBe('in_progress');
  });
});

/*
 * 同一次调用只让一个侧栏跑（多个侧栏都收到同一条广播）：仲裁在 06c 改成记在调用
 * 记录里，测试在 `who-runs.spec.ts`。
 */

describe('agent/thread/writer.ts · sweepExpiredGuideEffect — 宿主自己执行的工具也有期限', () => {
  /** A thread parked on a tool the host runs itself (`observe`), the way the
   *  reducer leaves it: `turn.pending` set, and no `inflight` — an `observe`
   *  is never dispatched to a panel. */
  const parkedOnObserve = async (deps: GuideEffectDeps) => {
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    return await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'observe', value: JSON.stringify({ why: '这一页应该已经变了' }) },
    });
  };

  it('工具还在跑、没过期 → 什么都不动', async () => {
    const { deps, now } = harness();
    const parked = await parkedOnObserve(deps);
    expect(parked.state?.turn?.pending?.call.name).toBe('observe');
    now.value += 1_000;
    expect(await sweepExpiredGuideEffect(deps, THREAD_ID)).toBeNull();
  });

  it('工具断在半路、过了期限 → 交回一个「没读到」的结果，模型接着往下走，线程不被焊死', async () => {
    const { deps, now } = harness();
    await parkedOnObserve(deps);
    // The worker was evicted mid-read, or the read threw: nothing will ever
    // deliver this tool's result, and without a sweep the thread ignores every
    // reading from here on.
    now.value += 60_000;
    const swept = await sweepExpiredGuideEffect(deps, THREAD_ID);
    expect(swept?.state?.turn?.pending).toBeUndefined();
    // The model is asked again, told the page could not be read.
    expect(swept?.sent).toHaveLength(1);
    expect(swept?.state?.turn?.rounds.at(-1)?.result).toEqual({ kind: 'unreadable' });
  });

  it('等文字的那一种，交回的是「没等完」，不是「没等到」——它没等完', async () => {
    const { deps, now } = harness();
    const started = await applyGuideInput(deps, THREAD_ID, { kind: 'start', goal: GOAL, table: TABLE, effectId: 'fx-1' });
    await applyGuideInput(deps, THREAD_ID, {
      kind: 'effect_result',
      effectId: 'fx-1',
      at: started.state!.inflight!.at,
      outcome: {
        ok: true,
        providerCalls: 1,
        tool: 'wait_for',
        value: JSON.stringify({ until: 'appears', text: '创建成功', seconds: 10 }),
      },
    });
    now.value += 60_000;
    const swept = await sweepExpiredGuideEffect(deps, THREAD_ID);
    expect(swept?.state?.turn?.rounds.at(-1)?.result).toEqual({
      kind: 'waited',
      until: 'appears',
      text: '创建成功',
      seconds: 10,
      met: null,
      table: null,
    });
  });
});
