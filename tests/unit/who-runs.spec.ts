import { describe, expect, it } from 'vitest';
import { CALL_MODEL_TIMEOUT_MS } from '@/agent/thread/effect';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import { RUN_RECORDS_KEY, type RecordStore } from '@/agent/thread/record-store';
import {
  applyGuideInput,
  claimGuideEffect,
  peekGuideEffect,
  sweepExpiredGuideEffect,
  threadsWithEffects,
  unrunGuideEffect,
  type GuideEffectDeps,
} from '@/agent/thread/writer';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * Who is running a dispatched call (ticket 06c).
 *
 * The model is called from a side panel, because a service worker cannot hold
 * a long request open. So a call the host dispatches runs only if some panel
 * takes it, and keeps running only while that panel stays open. Who took it
 * is written down with the call, and "is anyone running it" is asked of the
 * browser — which panels are open right now — never guessed from a clock.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const TABLE: PromptTable = {
  snapshotId: 's1', url: 'https://x.test/repo', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'link', name: 'Issues', path: [] }],
};
const T = 'tab-1' as ThreadId;

function harness() {
  const data = new Map<string, unknown>();
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (k) => void data.delete(k),
  };
  const records: RecordStore = {
    get: async () => ({ [RUN_RECORDS_KEY]: [] }),
    set: async () => {},
    bytesInUse: async () => 0,
    quota: 1_000_000,
  };
  const now = { value: 1_000 };
  let fx = 0;
  const deps: GuideEffectDeps = {
    store, records, flags: { get: async () => ({}) }, recent: async () => [],
    send: () => {}, now: () => now.value, newEffectId: () => `gen-${++fx}`,
  };
  /** The storage as the browser would hand all of it over. */
  const dump = () => Object.fromEntries(data);
  return { deps, now, dump };
}

/** Panels that are open, by document id. */
const open = (...ids: string[]) => async (id: string) => ids.includes(id);

async function dispatched() {
  const h = harness();
  const started = await applyGuideInput(h.deps, T, { kind: 'start', goal: '去 Issues', table: TABLE, effectId: 'fx-1' });
  return { ...h, req: started.sent[0]! };
}

describe('认领记进调用记录（06c）', () => {
  it('第一个来认领的侧栏拿到；它还开着，别的侧栏再来就拒绝', async () => {
    const { deps } = await dispatched();
    expect(await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A', 'doc-B'))).toBe(true);
    expect(await claimGuideEffect(deps, T, 'fx-1', 'doc-B', open('doc-A', 'doc-B'))).toBe(false);
    expect((await peekGuideEffect(deps.store, T))?.claimedBy).toBe('doc-A');
  });

  it('同一个侧栏再问一次 → 拒绝：它已经在跑这一次了', async () => {
    const { deps } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'));
    expect(await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'))).toBe(false);
  });

  it('认领者已经关掉 → 下一个来认领的接手', async () => {
    const { deps } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'));
    expect(await claimGuideEffect(deps, T, 'fx-1', 'doc-B', open('doc-B'))).toBe(true);
    expect((await peekGuideEffect(deps.store, T))?.claimedBy).toBe('doc-B');
  });

  it('来认领的不是此刻在途的那一次 → 拒绝', async () => {
    const { deps } = await dispatched();
    expect(await claimGuideEffect(deps, T, 'fx-old', 'doc-A', open('doc-A'))).toBe(false);
    expect(await claimGuideEffect(deps, 'tab-9' as ThreadId, 'fx-1', 'doc-A', open('doc-A'))).toBe(false);
  });

  it('宿主进程被回收之后，认领照样作数：它记在存储里，不在内存里', async () => {
    const { deps } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A', 'doc-B'));
    const restarted: GuideEffectDeps = { ...deps };
    expect(await claimGuideEffect(restarted, T, 'fx-1', 'doc-B', open('doc-A', 'doc-B'))).toBe(false);
  });
});

describe('没人在跑的调用：交回去重新派出（06c）', () => {
  it('从没被认领 → 没人在跑：原样交回，截止时间从头算', async () => {
    const { deps, now, req } = await dispatched();
    now.value += 10 * 60_000;
    const again = await unrunGuideEffect(deps, T, open());
    expect(again).toMatchObject({ effectId: 'fx-1', kind: 'callModel', params: req.params });
    expect(again?.deadline).toBe(now.value + CALL_MODEL_TIMEOUT_MS);
    expect((await peekGuideEffect(deps.store, T))?.deadline).toBe(again?.deadline);
  });

  it('认领者还开着 → 有人在跑，什么都不交', async () => {
    const { deps } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'));
    expect(await unrunGuideEffect(deps, T, open('doc-A'))).toBeNull();
  });

  it('认领者关掉了 → 没人在跑：交回，认领清空，下一个侧栏能接手', async () => {
    const { deps } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'));
    const again = await unrunGuideEffect(deps, T, open());
    expect(again?.effectId).toBe('fx-1');
    expect((await peekGuideEffect(deps.store, T))?.claimedBy).toBeUndefined();
    expect(again).not.toHaveProperty('claimedBy');
    expect(await claimGuideEffect(deps, T, 'fx-1', 'doc-B', open('doc-B'))).toBe(true);
  });

  it('没有在途的调用 → 什么都不交', async () => {
    const { deps } = harness();
    expect(await unrunGuideEffect(deps, T, open())).toBeNull();
  });

  it('列得出哪些线程有在途的调用', async () => {
    const { deps, dump } = await dispatched();
    await applyGuideInput(deps, 'tab-2' as ThreadId, { kind: 'start', goal: 'g', table: TABLE, effectId: 'fx-2' });
    expect(threadsWithEffects(dump()).sort()).toEqual(['tab-1', 'tab-2']);
  });
});

describe('截止时间只管有人在跑的调用（06c）', () => {
  it('没人认领的调用，过了截止时间也不算超时——它还没开始', async () => {
    const { deps, now, req } = await dispatched();
    now.value = req.deadline + 1;
    expect(await sweepExpiredGuideEffect(deps, T)).toBeNull();
    expect((await peekGuideEffect(deps.store, T))?.effectId).toBe('fx-1');
  });

  it('有人认领、过了截止时间 → 超时：先原样再问一遍，连着第二次才告诉用户', async () => {
    const { deps, now, req } = await dispatched();
    await claimGuideEffect(deps, T, 'fx-1', 'doc-A', open('doc-A'));
    now.value = req.deadline + 1;
    const swept = await sweepExpiredGuideEffect(deps, T);
    expect(swept?.sent).toHaveLength(1);

    const again = swept!.sent[0]!;
    await claimGuideEffect(deps, T, again.effectId, 'doc-A', open('doc-A'));
    now.value = again.deadline + 1;
    expect((await sweepExpiredGuideEffect(deps, T))?.effects).toMatchObject([{ kind: 'notify', canRetry: true }]);
  });
});
