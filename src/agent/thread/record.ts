import type { GuideRouteHop } from '@/shared/types';
import type { Check, Confirmation, Ending, Evidence, GuideHistoryEntry, ThreadState } from '@/agent/thread/thread';

/**
 * What survives a guided run (07's Seam 10).
 *
 * The `ThreadState` is deleted the moment a run ends — it has to be, or
 * ownership routing keeps handing this tab to a thread that already finished.
 * This is the summary written *before* that deletion, and it is the only
 * source S3 has for distilling Memory and rendering the three export
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
  /** How the run ended. */
  ending: Ending;
  /** How many of its steps were confirmed — never inferred from `ending`. */
  confirmation: Confirmation;
  evidence: Evidence;
  check: Check;
  /** §5.10's model-call count at the end of the run. */
  calls: number;
  /** The Plugins this run was made with (CONTEXT.md `Plugin`): read from the
   *  switches when it started and used for every call it sent, so an eval can
   *  put the result down to exactly one combination. */
  plugins: readonly string[];
}

/**
 * How many of the steps that reached the screen were confirmed — counted from
 * history alone, never from how the run ended: a run that confirmed three
 * steps and then ran out of quota confirmed some, not none.
 *
 * The judgement is deliberately "is there a step that was not confirmed",
 * never "did the cursor reach the end". S1 advanced the cursor identically for
 * `skipped` and `confirmed`, so a user who pressed 跳过 on every step walked
 * the cursor to the end and would have counted as having run it through —
 * `walked` evidence, the strongest kind, and the foundation of the whole
 * 「先跑通」 promise (§1.1). Nothing was run through.
 *
 * Confirmed is not arrived (CONTEXT.md `Arrival`): a confirmed step says the
 * user activated it and the page moved, not that it moved the right way.
 */
export function judgeConfirmation(history: readonly GuideHistoryEntry[]): Confirmation {
  const confirmed = history.filter((h) => h.outcome === 'confirmed').length;
  if (confirmed === 0) return 'none';
  return confirmed === history.length ? 'all' : 'some';
}

export function buildRunRecord(
  runId: string,
  state: ThreadState,
  at: number,
  ending: Ending,
  plugins: readonly string[],
): RunRecord {
  return {
    runId,
    at,
    goal: state.goal,
    url: state.table.url,
    route: state.route,
    steps: state.history.map((h) => ({ title: h.title, outcome: h.outcome })),
    ending,
    confirmation: judgeConfirmation(state.history),
    evidence: state.evidence,
    check: state.check,
    calls: state.callCount,
    plugins,
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
