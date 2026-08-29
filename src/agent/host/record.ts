import type { GuideRouteHop } from '@/agent/plan/contract';
import type { Check, Evidence, GuideHistoryEntry, RunStatus, ThreadState } from '@/agent/host/thread';

/**
 * What survives a guided run (07's Seam 10).
 *
 * The `ThreadState` is deleted the moment a run ends — it has to be, or
 * ownership routing keeps handing this tab to a thread that already finished.
 * This is the summary written *before* that deletion, and it is the only
 * source S3 has for distilling site knowledge and rendering the three export
 * formats. Writing it correctly now is what saves S3 from a data migration.
 *
 * Deliberately not a copy of `ThreadState`: `steps`/`cursor`/`table` are
 * working state, replaced wholesale on every replan and meaningless once the
 * run is over. What a later reader needs is what the user was trying to do,
 * the route they were given, which steps were actually proven, and how much it
 * cost.
 */
export interface RunRecord {
  runId: string;
  /** Wall clock at write time — the caller passes it, so this stays pure. */
  at: number;
  goal: string;
  /** Where the run ended up, from the last table it planned against. */
  url: string;
  route: readonly GuideRouteHop[];
  /** Every step that reached the screen, oldest first. */
  steps: { title: string; outcome: GuideHistoryEntry['outcome'] }[];
  status: RunStatus;
  evidence: Evidence;
  check: Check;
  /** §5.10's model-call count at the end of the run. */
  calls: number;
}

/**
 * CONTEXT.md's three run-level terminals, decided from what was *proven*.
 *
 * The judgement is deliberately "is there a step that was not confirmed",
 * never "did the cursor reach the end". S1 advanced the cursor identically for
 * `skipped` and `confirmed`, so a user who pressed 跳过 on every step walked
 * the cursor to the end and would have earned `completed` — which is `walked`
 * evidence, the strongest kind, and the foundation of the whole 「先跑通」
 * promise (§1.1). Nothing was run through. It must not be `completed`.
 *
 * A thread already carrying a terminal `status` (quota exhausted, a safety
 * stop) keeps it: those runs ended for a reason that outranks how many steps
 * happened to be confirmed before it.
 */
export function judgeRunStatus(state: ThreadState): RunStatus {
  if (state.status !== 'active') return state.status;
  const confirmed = state.history.filter((h) => h.outcome === 'confirmed').length;
  if (confirmed === 0) return 'abandoned';
  return confirmed === state.history.length ? 'completed' : 'partially_completed';
}

export function buildRunRecord(runId: string, state: ThreadState, at: number): RunRecord {
  return {
    runId,
    at,
    goal: state.goal,
    url: state.table.url,
    route: state.route,
    steps: state.history.map((h) => ({ title: h.title, outcome: h.outcome })),
    status: judgeRunStatus(state),
    evidence: state.evidence,
    check: state.check,
    calls: state.callCount,
  };
}

/**
 * A soft cap until S3's real per-site distillation and LRU replace it.
 *
 * Raw records accumulate with nothing to prune them, and unbounded growth in
 * `storage.local` is the kind of failure that only shows up on the machine of
 * whoever used the product most. 50 is a requested value, not one derived from
 * the design doc, and it is explicitly not the long-term policy.
 */
export const RUN_RECORD_CAP = 50;

export function trimRecords(existing: readonly RunRecord[], incoming: RunRecord): RunRecord[] {
  return [...existing, incoming].slice(-RUN_RECORD_CAP);
}

/**
 * The slice of `chrome.storage.local` this module needs, as a parameter.
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
