import { trimRecords, type RunRecord } from './record';

/**
 * Where Run records are kept — the one part of a Run record that touches
 * storage.
 *
 * Kept apart from what a record is and how a run is judged (`record.ts`),
 * because the reducer reads that half and nothing the reducer loads may reach
 * for storage (N-2): a write that waits on the platform has no place in a
 * function that must replay the same way every time.
 */

/**
 * The slice of `chrome.storage.local` this file needs, as a parameter.
 *
 * Same discipline as `sidepanel/effects.ts`: every judgement here is ordinary
 * data-in/data-out logic, so the storage dependency is injected and the whole
 * thing runs in a plain node test with a plain object.
 */
export interface RecordStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  bytesInUse(): Promise<number>;
  quota: number;
}

export const RUN_RECORDS_KEY = 'run:records';

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Checks the remaining quota *before* writing (§10.1's standing rule).
 *
 * Silent failure is the hardest kind to find: the user believes the run was
 * kept, and S3 later behaves as though it never happened. So an over-budget
 * write returns a readable error instead of being swallowed — the caller
 * decides what to tell the user, but it can no longer be told nothing.
 */
export async function writeRunRecord(store: RecordStore, record: RunRecord): Promise<WriteResult> {
  const existing = ((await store.get(RUN_RECORDS_KEY))[RUN_RECORDS_KEY] ?? []) as RunRecord[];
  const next = trimRecords(Array.isArray(existing) ? existing : [], record);

  const used = await store.bytesInUse();
  const incoming = JSON.stringify({ [RUN_RECORDS_KEY]: next }).length;
  const previous = JSON.stringify({ [RUN_RECORDS_KEY]: existing }).length;
  // The write replaces the old array rather than appending to it, so only the
  // delta is new spend — and eviction can make that delta negative.
  if (used - previous + incoming > store.quota) {
    return {
      ok: false,
      error: `本地存储空间不足，这次引导的记录没能保存（已用 ${used} 字节，配额 ${store.quota} 字节）`,
    };
  }

  await store.set({ [RUN_RECORDS_KEY]: next });
  return { ok: true };
}
