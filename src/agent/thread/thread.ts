import type { GuideHistory } from '@/agent/context/user-message';
import type { Reading, Since, ToolCall, ToolResult, TurnOnWire } from '@/agent/context/turn';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';
import type { AskOption, AskWants, GuideExpectAfter, GuideRouteHop, Ref, WaitUntil } from '@/shared/types';
import type { EffectOutcome } from './effect';

/**
 * CONTEXT.md's `Outcome`, first half: what happened to the step on screen.
 * `taken` — the step was done; `skipped` — the user pressed 跳过;
 * `unavailable` — a safety rule stopped the run on the page it led to (P-3).
 * A target that could not be found is not an action: it is a reading
 * (CONTEXT.md `Reading`), and the model decides what it means.
 */
export type StepAction = 'taken' | 'skipped' | 'unavailable';

/**
 * CONTEXT.md's `Outcome`, second half: what the page did afterwards — the page
 * the step was pointed on against the page last read when it was settled
 * (`effectOf` in transitions.ts). `moved` onto a different `View`, carrying
 * where it went; `changed_in_place` on the same view; `none`, the page was
 * read again and nothing on it had changed; `unknown`, every read since
 * failed, so nothing was seen at all.
 *
 * `none` is not "did not work". Live run t11 recorded nine steps this way and
 * none of them was a dead control: two copied the clone address, and the rest
 * were links whose page did not change in this tab.
 */
export type StepEffect = { kind: 'moved'; to: string } | { kind: 'changed_in_place' } | { kind: 'none' } | { kind: 'unknown' };

/**
 * How a run ended (CONTEXT.md `Run record`) — one half of what a Run record
 * says; how many steps were confirmed is the other, and neither is read off
 * the other. The first six are the reducer's own terminals; the rest happen
 * outside it, when the host ends a run that is still active.
 *
 * A run that never pointed at a step leaves no Run record at all (CONTEXT.md
 * `Question`), so `answered` — and any other ending such a run meets — is
 * never written down; it is what tells the host how to end it.
 */
export type Ending =
  /** The model said the user has arrived (`done`). */
  | 'model_done'
  /** A run that had pointed at nothing got its answer — `explain`, or an
   *  `ask` back to the user: it was a question, and it is over. */
  | 'answered'
  /** A fixed plan reached its last step. */
  | 'steps_walked'
  /** The model pointed again at a control that had already moved nobody. */
  | 'loop_backstop'
  /** The run took all the steps it may (ticket 09). */
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
export type ReducerEnding = Extract<Ending, 'model_done' | 'answered' | 'steps_walked' | 'loop_backstop' | 'quota_exhausted' | 'credentials_stop'>;

/** The endings only the host sees: the run was still active when it stopped. */
export type ExternalEnding = Exclude<Ending, ReducerEnding>;

/** How many of the steps that reached the screen were confirmed. Counted from
 *  history alone, never from how the run ended. */
export type Confirmation = 'all' | 'some' | 'none';

/**
 * Design doc §5.7's three orthogonal axes — `Binding` is not one
 * of them: it is stamped by the renderer at paint time (`binding.ts`) and
 * never reaches the Thread, because it answers "can I point at it *right
 * now*", a question with a fresh answer on every paint attempt.
 * `Evidence`/`Check` answer questions about the *run*, so they live here
 * instead.
 *
 */
/** §5.7's first axis — what the step on screen stands on, strongest first.
 *  `'handpicked'` is a fixed plan's: the person chose the element themselves,
 *  which is more direct than a document or an inference, but nobody has proven
 *  it works. `'documented'` is a model's answer given after it read a document
 *  on this site (`read_doc`) in the same conversation; `'model'` is one it gave
 *  without. */
export type Evidence = 'handpicked' | 'documented' | 'model';

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
 * CONTEXT.md `Turn`, as the Thread holds it: the conversation inside the step
 * being decided now. Opened afresh by every wake, cleared when an `Output`
 * lands.
 *
 * `pending` is a tool call the host is carrying out right now. It is not an
 * `inflight` effect on purpose: the host reads the page itself, in the same
 * handler, and a tombstone for that would only be one more thing a worker
 * evicted mid-read could leave behind to weld the thread shut. A read that
 * never comes back costs nothing — the next wake opens a new turn, and a late
 * reading with no pending call to match is dropped.
 */
export interface Turn extends TurnOnWire {
  pending?: { effectId: string; call: ToolCall };
}

/**
 * The full state of one guided run — `step`'s sole state shape (machine.ts).
 * `rev`/`inflight` are design doc §10's two concurrency mechanisms; `goal`/`route`/
 * `steps`/`cursor`/`ending` are design doc §10's "流程" row.
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
 * `GuideStep` and not an index into `steps`: `steps`/`cursor` are
 * replaced wholesale every time a `point` lands (`guide/output/point.ts`'s
 * `consequence`), so anything hanging off them is erased on every
 * replan — which is exactly what made the guide re-propose the step the user
 * had just completed, on every page, in all five live GitHub rounds.
 *
 * `action` and `effect` are two separate facts and neither is read off the
 * other. Both are absent while the step is still on screen and undecided.
 */
export interface GuideHistoryEntry {
  /** The control's name as the user reads it on screen. */
  title: string;
  /** The page this step was proposed on. */
  url: string;
  /** What happened to the step, proven by a reading (`used`), the user's
   *  跳过, or the host failing to find it. The first answer is the one kept. */
  action?: StepAction;
  /** What the page did afterwards, settled once: when the model answers
   *  next, or, on a fixed plan, when the user acts on the step after it.
   *
   *  `moved.to` is what the model reads as 「之后到了 …」. Without it the
   *  memory reads "you clicked Search" and the model cannot tell a search it
   *  has *run* from one it has yet to run — live round 1 typed `n8n`, landed
   *  on `search?q=n8n`, and was then advised to open the search box again
   *  "以便输入 n8n 找到仓库". The control name records what was pressed; this
   *  records what it accomplished. */
  effect?: StepEffect;
}

export interface ThreadState {
  rev: number;
  goal: string;
  /** The page as last read — by the start, a reading, or a tool. What a model
   *  call is sent with and its answer checked against: a read that lands while
   *  the model is being asked voids that answer, so the two never differ. */
  table: PromptTable;
  /** The page the step on screen was pointed on: the page the model's last
   *  answer was checked against, or, on a fixed plan, the page read when its
   *  current step went up. What a step did is this page against the last one
   *  read (`effectOf`), and it is what the model is told the page changed
   *  from when it is woken. */
  pointedOn: PromptTable;
  /** Readings that arrived since the model last answered and that no call
   *  has carried to it yet (CONTEXT.md `Reading`). Present only when there
   *  are some; one arriving while the model is being asked is what voids that
   *  answer. */
  readings?: readonly Reading[];
  route: readonly GuideRouteHop[];
  steps: readonly GuideStep[];
  cursor: number;
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
  /** §5.7: "这一步的知识从哪来". `'handpicked'` for the whole of a fixed plan;
   *  on the model's run, set again by every answer that lands — `'documented'`
   *  when the conversation it came out of read a document, `'model'` when not. */
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
  /** Model calls this run has made, repair rounds included — what it cost,
   *  shown to the user and kept in the Run record. Not a limit: the two
   *  budgets below are (ticket 09). */
  callCount: number;
  /** Model calls made since the step being decided began — since the last
   *  answer landed. A step may make four (`transitions.ts`); the fourth
   *  offers only answers. */
  stepCalls: number;
  /** Steps this run has taken: every answer that landed, and every step that
   *  ran out of calls without one. A run may take twelve. */
  spentSteps: number;
  inflight: InflightEffect | null;
  /** The conversation with the model inside the step being decided now —
   *  absent when no model is being asked anything. */
  turn?: Turn;
}

/* ═══════════ what `step` (machine.ts) reads and returns ═══════════
 *
 * Beside the state it changes rather than inside the reducer, so that anything
 * deciding a consequence can name them without importing the reducer. */

/** design doc §2.6's `EffectRequest.at` / `EffectResult.at`: the world state
 *  a dispatched effect was issued against. */
export interface WorldAt {
  threadRev: number;
  snapshotId: string;
  structureHash: string;
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
 * branches ever spend one (an E-3 replan, a `read_doc` envelope asking for a
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
   * record writes it, and the table is what `pageChange` compares the next page
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
  | { kind: 'cross_site_decision'; confirmed: boolean }
  /** The user pressed 跳过 on the step on screen (`handleStepSkipped`). */
  | { kind: 'step_skipped' }
  /**
   * An observation source saw something (CONTEXT.md `Reading`), and `table`
   * is the page the host read right after — `null` when it could not be
   * read. `nextEffectId` is for the model call it may wake (`handleReading`).
   */
  | { kind: 'reading'; reading: Reading; table: PromptTable | null; nextEffectId: string }
  /** What the host brought back for a tool the model called — the page read
   *  again (`observe`), or how a wait went (`wait_for`). `effectId` names the
   *  call it answers; `nextEffectId` is for the model call that carries it back. */
  | { kind: 'tool_result'; effectId: string; result: ToolResult; nextEffectId: string };

/**
 * The two effect families design doc §2.1/§2.6 name — platform effects Host
 * executes itself (`present`), and external-world effects Host delegates to
 * Panel (`callModel`/`fetchDoc`, design doc §2.6). This file produces
 * only *values* describing what should happen next; it never distinguishes
 * the two families beyond their `kind` tag, and never executes either.
 *
 * `extract` (the Seam's other platform effect) is not a member yet: every
 * one of this task's fifteen slices hands `step` an already-extracted table
 * directly (`start`/`reading`'s `table` field) rather than asking the
 * reducer to request one — nothing in 03 ever needs to *decide* an
 * extraction is required. It joins this union in whichever later stage
 * first needs the reducer to ask for one.
 */
export type MachineEffect =
  /** Paint the step on screen. `index` is which step of the run it is;
   *  `total` is how many a plan written in advance has, and `null` for the
   *  model's — it points at one step at a time, and nobody knows the count. */
  | { kind: 'present'; step: GuideStep; index: number; total: number | null }
  | {
      kind: 'callModel';
      effectId: string;
      goal: string;
      table: PromptTable;
      history: GuideHistory;
      /** Refs that appeared since the last call, when the page did not
       *  navigate (`freshRefsBetween`). Absent otherwise. */
      freshRefs?: readonly Ref[];
      /** What woke the model, when a reading did. Absent otherwise. */
      since?: Since;
      /** The step's last call: only answers are on offer, and the model is
       *  told to give one. Absent on every other call. */
      final?: true;
      /** The step's conversation so far, once it has a round. `table` above
       *  is then the page read last, and this carries the one the step opened on. */
      turn?: TurnOnWire;
    }
  /** Read the page as it is now, for the model that asked (`observe`). The
   *  host does it itself and answers with a `tool_result`. */
  | { kind: 'observe'; effectId: string }
  /** Wait until `text` appears on the page (or goes), for at most `seconds`
   *  — already capped — then read the page (`wait_for`). The content script
   *  waits; the host answers with a `tool_result`. */
  | { kind: 'waitFor'; effectId: string; until: WaitUntil; text: string; seconds: number }
  /** `url` is already approved: the host decided, the panel only fetches
   *  (§8.3). It arrives here from the page's own link, never from the model. */
  | { kind: 'fetchDoc'; effectId: string; viaRef: Ref; query: string; url: string }
  /** CL-1: the model asked the user instead of pointing at a step (§5.8).
   *  Carries what it wants back and *every* candidate it listed, in its own
   *  order — narrowing them to one here would be the K-6 violation asking
   *  exists to avoid. */
  | { kind: 'ask'; question: string; wants: AskWants; options: readonly AskOption[] }
  /** The model answered a question about the page (`explain`): the answer,
   *  and the elements that back it up — outlined, none of them singled out. */
  | { kind: 'explain'; answer: string; refs: readonly Ref[] }
  /** This step leaves the site. Ask before the user commits to it — the
   *  promise is that they see the destination *before* going, not after
   *  (§8.4). `from`/`to` are full hostnames: this stage has no brand
   *  extraction, so the card says the literal address and claims nothing
   *  about who owns it. */
  | { kind: 'requestCrossSiteConfirm'; from: string; to: string }
  /** Stop the call or fetch still out under this id: whatever it brings back
   *  answers a question nobody is asking any more (the user said something
   *  new). Its result, if it still arrives, is stale and dropped (E-2). */
  | { kind: 'cancel'; effectId: string }
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
