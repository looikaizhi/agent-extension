import type { ClarifyOption } from '@/agent/envelope/contract';
import type { GuideHistory } from '@/agent/context/user-message';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideStep, HighlightMode } from '@/shared/protocol';
import type { GuideExpectAfter, GuideRouteHop, Ref } from '@/shared/types';
import type { EffectOutcome } from './effect';

/** Every reason a thread can be parked on a question (design doc §5.8). What
 *  `ThreadState.clarify` records. */
export type ClarifyTrigger = 'CL-1' | 'CL-2';

/**
 * CONTEXT.md's four step-level judgments. `undefined` (absence from
 * `ThreadState.outcomes` at that index) means "not yet judged" — 03 only
 * ever writes `invalidated` (the "未能定位" fallback, see machine.ts); the
 * rest arrive with 07's `confirmed` judgement (D4).
 */
export type Outcome = 'confirmed' | 'skipped' | 'failed' | 'invalidated';

/**
 * How a run ended (CONTEXT.md `Run record`) — one half of what a Run record
 * says; how many steps were confirmed is the other, and neither is read off
 * the other. The first five are the reducer's own terminals; the rest happen
 * outside it, when the host ends a run that is still active.
 */
export type Ending =
  /** The model said the user has arrived (`done`). */
  | 'model_done'
  /** A fixed plan reached its last step. */
  | 'steps_walked'
  /** The model pointed again at a control that had already moved nobody. */
  | 'loop_backstop'
  /** The model-call or doc-fetch quota ran out. */
  | 'quota_exhausted'
  /** A page reached across sites asked for credentials. */
  | 'credentials_stop'
  /** The user pressed 结束引导. */
  | 'user_ended'
  /** The user closed the overlay. */
  | 'overlay_closed'
  /** The tab the guide lived in was closed. */
  | 'tab_closed'
  /** A new guide was started in the same tab. */
  | 'superseded';

/** The endings the reducer reaches by itself — the ones a `ThreadState` carries. */
export type ReducerEnding = Extract<Ending, 'model_done' | 'steps_walked' | 'loop_backstop' | 'quota_exhausted' | 'credentials_stop'>;

/** The endings only the host sees: the run was still active when it stopped. */
export type ExternalEnding = Exclude<Ending, ReducerEnding>;

/** How many of the steps that reached the screen were confirmed. Counted from
 *  history alone, never from how the run ended. */
export type Confirmation = 'all' | 'some' | 'none';

/**
 * Design doc §5.7's three orthogonal axes — `Binding` is not one
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
/** §5.7's first axis — where this flow's knowledge comes from, strongest first.
 *  `'handpicked'` is a fixed plan's: the person chose the element themselves, which
 *  is more direct than a document or an inference, but nobody has proven it works. */
export type Evidence = 'walked' | 'handpicked' | 'documented' | 'model';

/** `'pass'` is produced by `judgeArrival` (07) when the arrived page really
 *  contains the shape the model predicted in `expect_after`. It was declared
 *  unreachable through 05 — S4's `precheckLink` was assumed to be the only
 *  thing that could ever produce it — but the cheaper judge was already in the
 *  contract and merely unread. */
export type Check = 'pass' | 'unknown' | 'skipped';

/**
 * The tombstone (design doc §2.6 E-1, §10): at most one at a time,
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
  at: WorldAt;
}

/**
 * The full state of one guided run — `step`'s sole state shape (machine.ts).
 * `rev`/`inflight` are design doc §10's two concurrency mechanisms; `goal`/`route`/
 * `steps`/`cursor`/`outcomes`/`ending` are design doc §10's "流程" row.
 *
 * `table` is this file's one deliberate addition beyond §10's literal list.
 * `steps[i].ref` is a snapshot-scoped handle (CONTEXT.md), and validating a
 * fresh model envelope against it (`refsViolation`, R-a/R-e) needs the
 * exact ref set it was drawn against — carrying it here is what lets
 * `effect_result` be processed without a second live extraction round-trip.
 * The Seam explicitly leaves `ThreadState`'s internal fields open for this
 * kind of adjustment.
 */
/**
 * One step this thread has already put on screen. Deliberately *not* a
 * `GuideStep` and not an index into `steps`: `steps`/`cursor`/`outcomes` are
 * replaced wholesale every time a `guide` envelope lands (`guide/output/guide.ts`'s
 * `consequence`), so anything hanging off them is erased on every
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
   *  forever — neither done nor failed — and the run's verdict counted it as
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
   *  reset — see `GuideHistoryEntry`. This is what the next user message
   *  reads so the model is told where the user has already been. */
  history: readonly GuideHistoryEntry[];
  /** Present once the run is over, saying how it ended; absent while it is
   *  still running. A thread that has one accepts nothing but a new `start`,
   *  and the host ends the run the moment one appears. */
  ending?: ReducerEnding;
  /** Where this run's `steps` come from, and the one thing that decides whether
   *  it may ever call the model.
   *
   *  `'model'` is a guide the reducer plans by asking; `'fixed'` is a plan that
   *  was written before the run began (the inspector's row click) — it is
   *  landed as given, advanced as the user deals with each step, and ends when
   *  it runs out (`fixed-plan.ts`). A `'fixed'` run spends nothing, and that is
   *  enforced at the one place a model call is emitted (`tryEmitCallModel`)
   *  rather than trusted to every input handler. */
  planSource: 'model' | 'fixed';
  /** A fixed plan's step whose own target the user has just used, while the
   *  page answers. It is the only thing allowed to move a fixed plan forward:
   *  a page that changed on its own — a wander elsewhere, a re-render, a
   *  target that vanished unused — gets the same step painted again instead of
   *  having it claimed done. Never set on a model-driven run, which re-plans on
   *  every change anyway. */
  used?: boolean;
  /** §5.7: "这个流程的知识从哪来". Set once, at the start of a run: `'model'`
   *  for a plan the model makes, `'handpicked'` for a fixed plan the user
   *  picked in the element table. */
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
  /** Set while a question is waiting on the user to resolve it — CL-1 (the
   *  model asked) or CL-2 (the first step bound ambiguously); absent the rest
   *  of the time. */
  clarify?: ClarifyTrigger;
  /** §5.10's quota: model calls, including repair calls and replans. Cap 12. */
  callCount: number;
  /** §5.10's quota, independent of `callCount`. Cap 5. */
  docFetchCount: number;
  inflight: InflightEffect | null;
}

/* ═══════════ what `step` (machine.ts) reads and returns ═══════════
 *
 * Beside the state it changes rather than inside the reducer, so that anything
 * deciding a consequence can name them without importing the reducer. */

/** CONTEXT.md's renderer-stamped axis: "此刻能不能把它指出来". Distinct from
 *  `core/descriptor/bind.ts`'s `BindResult` — that is a table-only match attempt
 *  (`'unique' | 'ambiguous' | 'not_found'`) this file never runs itself
 *  (bindStep needs no `chrome.*`, but its inputs — a live snapshot — are the
 *  content script's, not this reducer's to fabricate). A `Binding` value only
 *  ever arrives *already computed*, via a `bind_result` input, from the
 *  renderer's own attempt against whatever page is on screen right now. */
export type Binding = 'bound' | 'ambiguous' | 'unbound';

/** design doc §2.6's `EffectRequest.at` / `EffectResult.at`: the world state
 *  a dispatched effect was issued against. */
export interface WorldAt {
  threadRev: number;
  snapshotId: string;
  pageHash: string;
  url: string;
}

/**
 * The event kinds `step` recognises.
 *
 * Every id is supplied by the caller, never minted here: `crypto.randomUUID()`
 * is exactly the kind of hidden input N-2's determinism requirement forbids
 * reading directly.
 *
 * `nextEffectId` is required on `effect_result` even though only two of its
 * branches ever spend one (an E-3 replan, a `need_docs` envelope asking for a
 * fetch). It used to be optional, guarded by a throw on each of those two
 * branches — which made correctness depend on the caller predicting which
 * branch this reducer would take, and that prediction needs the payload
 * already parsed. Neither real caller could make it, neither did, and both
 * throws fired in the first live run. An unspent id costs nothing (it is
 * stored only when an effect is actually dispatched), so requiring it turns a
 * runtime landmine into a compile-time obligation and deletes both throws.
 */
export type MachineInput =
  | { kind: 'start'; goal: string; table: PromptTable; effectId: string }
  /**
   * A plan that was already written — the inspector's 「点这一行」 flow. The
   * reducer lands it and paints the first step: no
   * extraction, no planning, no model call, ever.
   *
   * **No `effectId`, and that absence is the whole distinction**: this start
   * needs no Effect budget because it never dispatches an Effect. Every other
   * input that could spend one carries an id; this one cannot, so a fixed plan
   * that somehow reached a dispatch site would have nothing to dispatch with.
   *
   * `goal` and `table` are required for the same reasons the model-driven
   * start needs them: `ThreadState` has no meaning without a goal, the Run
   * record writes it, and the table is what `pageMoved` compares the next page
   * against.
   *
   * `steps` is non-empty by type: a plan with nothing in it has nothing to show
   * and nothing to wait for, and making it unrepresentable is what keeps a
   * start from being terminal on arrival — the ending flow only watches for a
   * thread *gaining* an ending.
   */
  | { kind: 'start_fixed'; goal: string; table: PromptTable; steps: readonly [GuideStep, ...GuideStep[]] }
  | {
      kind: 'effect_result';
      effectId: string;
      at: WorldAt;
      outcome: EffectOutcome;
      nextEffectId: string;
    }
  | { kind: 'bind_result'; binding: Binding }
  | { kind: 'cross_site_decision'; confirmed: boolean }
  /** The settle window closed and the page never moved — `background.ts`'s
   *  re-plan loop is the only thing that can observe that, because deciding
   *  it requires a clock. */
  | { kind: 'step_settle_timeout'; effectId: string }
  /** The user pressed 跳过 on the step on screen (`handleStepSkipped`). */
  | { kind: 'step_skipped' }
  /** The user activated the target of the step on screen, on the page at `at`
   *  — where the click happened, not where the tab is now (`handleStepUsed`). */
  | { kind: 'step_used'; at: string }
  | { kind: 'page_changed'; table: PromptTable; effectId: string };

/**
 * The two effect families design doc §2.1/§2.6 name — platform effects Host
 * executes itself (`present`), and external-world effects Host delegates to
 * Panel (`callModel`/`fetchDoc`, design doc §2.6). This file produces
 * only *values* describing what should happen next; it never distinguishes
 * the two families beyond their `kind` tag, and never executes either.
 *
 * `extract` (the Seam's other platform effect) is not a member yet: every
 * one of this task's fifteen slices hands `step` an already-extracted table
 * directly (`start`/`page_changed`'s `table` field) rather than asking the
 * reducer to request one — nothing in 03 ever needs to *decide* an
 * extraction is required. It joins this union in whichever later stage
 * first needs the reducer to ask for one.
 */
export type MachineEffect =
  | { kind: 'present'; step: GuideStep; index: number; total: number; mode: HighlightMode }
  | {
      kind: 'callModel';
      effectId: string;
      goal: string;
      table: PromptTable;
      history: GuideHistory;
      /** Refs that appeared since the last call, when the page did not
       *  navigate (`freshRefsBetween`). Absent otherwise. */
      freshRefs?: readonly Ref[];
    }
  /** `url` is already approved: the host decided, the panel only fetches
   *  (§8.3). It arrives here from the page's own link, never from the model. */
  | { kind: 'fetchDoc'; effectId: string; viaRef: Ref; query: string; url: string }
  /** CL-1: the model asked the user a question instead of planning a step
   *  (§5.8). Carries the question and *every* candidate the model listed, in
   *  the model's own order — narrowing them to one here would be the K-6
   *  violation the whole clarify channel exists to avoid. */
  | { kind: 'clarify'; question: string; options: readonly ClarifyOption[] }
  /** This step leaves the site. Ask before the user commits to it — the
   *  promise is that they see the destination *before* going, not after
   *  (§8.4). `from`/`to` are full hostnames: this stage has no brand
   *  extraction, so the card says the literal address and claims nothing
   *  about who owns it. */
  | { kind: 'requestCrossSiteConfirm'; from: string; to: string }
  /** The run is over, and says why. Terminal: the thread already has its
   *  ending when this is emitted, and disagreeing means starting a new
   *  guide (`start` is the one input a finished thread accepts).
   *
   *  `ending` separates three events that used to arrive here
   *  indistinguishable and come out as one sentence, 「看起来已经到了：…」.
   *  `'model_done'` means the model read the page and believes the user has
   *  arrived; `'loop_backstop'` means it proposed a control already used and
   *  the guide stopped rather than circle; `'steps_walked'` means a plan that
   *  was written in advance reached its last step. Three different things, and telling a
   *  user one of them when another happened is a lie the renderer had no way
   *  to avoid. */
  | { kind: 'done'; why: string; ending: Extract<ReducerEnding, 'model_done' | 'loop_backstop' | 'steps_walked'> }
  /** The one non-platform, non-external-world effect this file produces: a
   *  pure "tell the user" value for a terminal or recoverable-error state
   *  that has no `GuideStep` to attach to (quota exhaustion, an unresolved
   *  target, a contract violation). */
  | { kind: 'notify'; message: string };

/**
 * Pass-through, not a transform: every field on `ThreadState` is already
 * JSON-safe (strings, numbers, `null`, plain arrays/objects), so there is no
 * serialization step to get wrong: the state goes to `ThreadStore.set` as it is.
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
