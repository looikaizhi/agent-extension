import type { GuideExpectAfter, GuideRouteHop } from '@/agent/plan/contract';
import type { ClarifyTrigger } from '@/agent/plan/validate';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';

/**
 * CONTEXT.md's four step-level judgments. `undefined` (absence from
 * `ThreadState.outcomes` at that index) means "not yet judged" — 03 only
 * ever writes `invalidated` (the "未能定位" fallback, see machine.ts); the
 * rest arrive with 07's `confirmed` judgement (D4).
 */
export type Outcome = 'confirmed' | 'skipped' | 'failed' | 'invalidated';

/**
 * CONTEXT.md's three run-level terminals. `ThreadState.status` is this type
 * plus `'active'` — `'active'` is this file's own "still running" value and
 * is never one of the three a `RunRecord` is stamped with.
 */
export type RunStatus = 'completed' | 'partially_completed' | 'abandoned';

/**
 * 05-route-and-steps.md §5.7's three orthogonal axes — `Binding` is not one
 * of them: it is stamped by the renderer at paint time (machine.ts's own
 * `Binding` type) and never stored on `ThreadState`, because it answers "can
 * I point at it *right now*", a question with a fresh answer on every paint
 * attempt. `Evidence`/`Check` answer questions about the *run*, so they live
 * here instead.
 *
 * `'walked'` is declared now (S3's shape is already known) but no code path
 * under S2 ever assigns it — `architecture.spec.ts` greps for this; see this
 * file's own `evidence` field doc comment.
 */
export type Evidence = 'walked' | 'documented' | 'model';

/** `'pass'` is produced by `judgeArrival` (07) when the arrived page really
 *  contains the shape the model predicted in `expect_after`. It was declared
 *  unreachable through 05 — S4's `precheckLink` was assumed to be the only
 *  thing that could ever produce it — but the cheaper judge was already in the
 *  contract and merely unread. */
export type Check = 'pass' | 'unknown' | 'skipped';

/**
 * The one reason 03 produces. Design doc §12 groups quota exhaustion, the
 * user ending a run early, and a safety rule stopping one under the same
 * `abandoned` status with this field distinguishing why — but this task's
 * fifteen slices only ever exercise the quota path (slices 11/12), so the
 * type stays this narrow rather than pre-declaring reasons no code produces
 * yet (AGENTS.md: no speculative members). 07/08 widen it when they add the
 * other two.
 */
export type AbandonedReason = 'quota_exceeded' | 'credentials_on_unfamiliar_site';

/**
 * The tombstone (ADR 0008, design doc §2.6 E-1): at most one at a time,
 * recording an external-world effect (`callModel`/`fetchDoc`) dispatched but
 * not yet returned. `at` is the world state *at the moment of dispatch* —
 * `machine.ts` compares it against `state.table`'s current fields when the
 * matching `effect_result` arrives (E-3); any mismatch discards the result
 * outright rather than trusting a result computed against a world that has
 * since moved on.
 */
export interface InflightEffect {
  effectId: string;
  kind: 'callModel' | 'fetchDoc';
  at: { threadRev: number; snapshotId: string; pageHash: string; url: string };
}

/**
 * The full state of one guided run — `step`'s sole state shape (machine.ts).
 * `rev`/`inflight` are ADR-0008's two concurrency mechanisms; `goal`/`route`/
 * `steps`/`cursor`/`outcomes`/`status` are design doc §10's "流程" row.
 *
 * `table` is this file's one deliberate addition beyond §10's literal list.
 * `steps[i].ref` is a snapshot-scoped handle (CONTEXT.md), and validating a
 * fresh model envelope against it (`validateEnvelope`, R-a/R-e) needs the
 * exact ref set it was drawn against — carrying it here is what lets
 * `effect_result` be processed without a second live extraction round-trip.
 * The Seam explicitly leaves `ThreadState`'s internal fields open for this
 * kind of adjustment.
 */
/**
 * One step this thread has already put on screen. Deliberately *not* a
 * `GuideStep` and not an index into `steps`: `steps`/`cursor`/`outcomes` are
 * replaced wholesale every time a `guide` envelope lands (machine.ts's
 * `handleEffectResult`), so anything hanging off them is erased on every
 * replan — which is exactly what made the guide re-propose the step the user
 * had just completed, on every page, in all five live GitHub rounds.
 *
 * `outcome` is `Outcome` narrowed to the three values this stage can honestly
 * decide. Each has one source and no other: `confirmed` from `page_changed`
 * (where `pageMoved` has already proven the page really moved), `invalidated`
 * from a `bind_result` of `unbound`, `unknown` for a step still on screen.
 */
export interface GuideHistoryEntry {
  /** The control's name as the user reads it on screen. */
  title: string;
  /** The page this step was proposed on. */
  url: string;
  /** `failed` is 设计文档's "点了但没到": the user activated the control and
   *  the page never moved. Before it existed such a step stayed `unknown`
   *  forever — neither done nor failed — and `judgeRunStatus` counted it as
   *  still in progress. */
  outcome: Extract<Outcome, 'confirmed' | 'invalidated' | 'failed'> | 'unknown';
  /** Where this step actually took the user. Set only alongside `confirmed`,
   *  from the table of the page that was arrived at.
   *
   *  Without it the memory reads "you clicked Search" and the model cannot
   *  tell a search it has *run* from one it has yet to run — live round 1
   *  typed `n8n`, landed on `search?q=n8n`, and was then advised to open the
   *  search box again "以便输入 n8n 找到仓库". The control name records what
   *  was pressed; this records what it accomplished. */
  landedAt?: string;
}

export interface ThreadState {
  rev: number;
  goal: string;
  /** The table the *current* `steps`/pending `callModel` were built against.
   *  `table.pageHash`/`table.url`/`table.snapshotId` are ThreadState's only
   *  record of "world state" — nothing duplicates them as separate fields. */
  table: PromptTable;
  route: readonly GuideRouteHop[];
  steps: readonly GuideStep[];
  cursor: number;
  /** Parallel to `steps`. */
  outcomes: readonly (Outcome | undefined)[];
  /** Every step already shown, oldest first, across every replan. Never
   *  reset — see `GuideHistoryEntry`. This is what the next `buildGuidePrompt`
   *  reads so the model is told where the user has already been. */
  history: readonly GuideHistoryEntry[];
  status: 'active' | RunStatus;
  abandonedReason?: AbandonedReason;
  /** §5.7: "这个流程的知识从哪来". Set once, at `start` (machine.ts's
   *  `handleStart`), to `'model'` — S2's only source. 06 is what upgrades an
   *  existing thread to `'documented'` after a successful doc-grounding fetch;
   *  no code in *this* file's own reducer ever changes it after `start`. */
  evidence: Evidence;
  /** §5.7: "到达期望验证的结果". Settled at each breakpoint by `judgeArrival`
   *  against the freshly extracted table: `'pass'` when the predicted shape is
   *  really there, `'unknown'` when it is not, `'skipped'` when the model made
   *  no prediction to check. */
  check: Check;
  /** What the model said would appear after the step now on screen (§5.4's
   *  `expect_after`). Read at the next breakpoint by `judgeArrival` to settle
   *  `check`; absent whenever the model declined to predict. */
  expect?: GuideExpectAfter;
  /** The host of a step that would leave this site, while its confirmation
   *  card is on screen and unanswered (P-2). Present only between asking and
   *  the user's answer — `steps[0]` is already loaded and waiting behind it. */
  pendingCrossSite?: string;
  /** The host a *confirmed* cross-site hop led to. Read at the next
   *  breakpoint by P-3, which checks the landing page for credential fields —
   *  and only there, because "a page asks for your password" is unremarkable
   *  on the site you chose and worth stopping for on one you just arrived at. */
  crossedTo?: string;
  /** Set while CL-2/CL-3/CL-4 is waiting on the user to resolve it; absent
   *  the rest of the time. Only CL-2 is produced by 03 (slice 6). */
  clarify?: ClarifyTrigger;
  /** §5.10's quota: model calls, including repair calls and replans. Cap 12. */
  callCount: number;
  /** §5.10's quota, independent of `callCount`. Cap 5. */
  docFetchCount: number;
  inflight: InflightEffect | null;
}

/**
 * Pass-through, not a transform: every field on `ThreadState` is already
 * JSON-safe (strings, numbers, `null`, plain arrays/objects), so there is no
 * serialization step to get wrong — same pattern as S1's `Thread` (`api.ts`),
 * which handed itself to `ThreadStore.set` unchanged.
 */
export function encodeThread(state: ThreadState): Record<string, unknown> {
  return { ...state };
}

/**
 * `null` on anything short of "a well-formed `ThreadState`" — never throws
 * (machine.ts Gotchas: "读到一份找不到的/损坏的记录,返回 null,不抛错"). A
 * missing thread and a corrupted one are the same event from here: the
 * caller passes `{}` for "no record at that key" (mirroring S1's
 * `store.get(k)[k] ?? null`), and `{}` fails the exact same `rev` check a
 * corrupted record would.
 *
 * Only `rev` is checked field-by-field. Deeper structural validation is not
 * needed: this store is never hand-edited — its only writer is `step`'s own
 * return value, passed straight through `encodeThread` with nothing in
 * between — so "malformed enough to reach here" realistically only happens
 * via storage-layer corruption or a schema change, both of which `rev`
 * (present on every version of this shape since it was introduced) already
 * catches.
 */
export function decodeThread(record: Record<string, unknown>): ThreadState | null {
  if (typeof record.rev !== 'number') return null;
  return record as unknown as ThreadState;
}
