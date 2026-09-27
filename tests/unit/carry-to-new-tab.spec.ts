import { describe, expect, it } from 'vitest';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import { RUN_RECORDS_KEY, type RecordStore } from '@/agent/thread/record-store';
import { applyGuideInput, carryGuideThread, peekGuideThread, type GuideEffectDeps } from '@/agent/thread/writer';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * 点出一个新标签页（票 04）。
 *
 * 一次点击开出新标签页，和同一页里跳转，对用户是同一件事：他做了被指的那一步，
 * 结果落在了旁边而不是原地。而这里每一样东西都按 tabId 存，所以不搬家的话，这一
 * 趟就留在用户已经离开的那一页上，指着他刚刚用过的那个控件。
 *
 * 搬过去之后，模型看到的只是「页面变成了新的一页」——它不需要知道有过新标签页。
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const TABLE: PromptTable = {
  snapshotId: 's1', url: 'https://x.test/repo', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'link', name: 'Issues', path: [] }],
};
const A = 'tab-1' as ThreadId;
const B = 'tab-2' as ThreadId;

function harness() {
  const data = new Map<string, unknown>();
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (k) => void data.delete(k),
  };
  const records: RecordStore = { get: async () => ({ [RUN_RECORDS_KEY]: [] }), set: async () => {}, bytesInUse: async () => 0, quota: 1_000_000 };
  const deps: GuideEffectDeps = {
    store, records, flags: { get: async () => ({}) }, recent: async () => [],
    send: () => {}, now: () => 1_000, newEffectId: () => 'gen-1',
  };
  return { deps, keys: () => [...data.keys()].sort() };
}

async function running() {
  const h = harness();
  await applyGuideInput(h.deps, A, { kind: 'start', goal: '去 Issues', table: TABLE, effectId: 'fx-1' });
  return h;
}

describe('引导跟着人走到新标签页（04）', () => {
  it('搬过去：新标签页上是同一趟，旧标签页上什么都不剩', async () => {
    const { deps, keys } = await running();
    const before = await peekGuideThread(deps.store, A);

    const { carried } = await carryGuideThread(deps, A, B);

    expect(carried).toBe(true);
    const moved = await peekGuideThread(deps.store, B);
    expect(moved?.goal).toBe(before?.goal);
    expect(moved?.cursor).toBe(before?.cursor);
    expect(await peekGuideThread(deps.store, A)).toBeNull();
    // 旧标签页的键一个都不许留下：留着的话，那一页的「有没有引导」会永远答是。
    expect(keys().filter((k) => k.endsWith(A))).toEqual([]);
  });

  it('在途的那次调用被点名取消——它问的是用户已经离开的那一页', async () => {
    const { deps } = await running();

    const { cancelledEffectId } = await carryGuideThread(deps, A, B);

    expect(cancelledEffectId).toBe('fx-1');
    // 搬过去的那一趟身上不能还挂着它：那就成了没人会回答的「正在想」（票 03）。
    expect((await peekGuideThread(deps.store, B))?.inflight ?? null).toBeNull();
  });

  it('旧标签页上本来就没有引导 → 什么都不做', async () => {
    const { deps, keys } = harness();

    expect(await carryGuideThread(deps, A, B)).toEqual({ carried: false, cancelledEffectId: null });
    expect(keys()).toEqual([]);
  });
});
