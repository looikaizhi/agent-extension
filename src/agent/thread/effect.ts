import type { Talk } from '@/agent/conversation/entries';
import type { GuideHistory } from '@/agent/context/user-message';
import type { Since, ToolCall, TurnOnWire } from '@/agent/context/turn';
import type { PromptTable } from '@/core/extractor/types';
import type { Fix, Ref } from '@/shared/types';

/**
 * The wire protocol — design doc §2.6's request/result
 * pair, verbatim. Pure types plus the handful of pure judgements that do not
 * need a live `ThreadState` (deadlines, E-6's recovery verdict), so both
 * `agent/thread/writer.ts` (the one place allowed to call `step`) and
 * `entrypoints/sidepanel/effects.ts` can share one definition without either
 * depending on `machine.ts`/`thread.ts`.
 *
 * Deliberately self-contained: no import from `./machine` or `./thread`, and
 * no `SessionId` borrowed from elsewhere either — `EffectAt` restates a
 * handful of fields instead, to keep this file a leaf. What "leaf" constrains
 * is this file's *outbound* edges only: `machine.ts` importing `EffectUsage`
 * and `EffectFailureKind` from here is the inbound direction and leaves the
 * property intact, which is why those are shared rather than restated. `shared/protocol.ts` imports these two shapes
 * (type-only) to build the tagged message envelopes the actual
 * `chrome.runtime.sendMessage` calls use; this file never imports anything
 * back from there, so that stays a one-way edge, not a cycle.
 *
 * N-1 (`src/agent/**` may not touch `chrome.*`) holds trivially here —
 * nothing in this file ever could. This task's own completion criterion
 * goes further: the two message-envelope type tags
 * (`shared/protocol.ts`'s `EffectRequestMessage`/`EffectResultMessage`) must
 * not appear anywhere under `src/agent` at all, plain data shapes or not —
 * `tests/unit/architecture.spec.ts` has the guard for this file's neighbourhood.
 */

export interface CallModelParams {
  goal: string;
  table: PromptTable;
  /** Where this guide has already been (07). Travels on the wire because the
   *  prompt is built in the panel (CONTEXT.md `Panel`) while the record of the journey
   *  lives on the host — without it every replan is a fresh conversation, and
   *  the model re-proposes the step the user just finished. */
  history: GuideHistory;
  /** What the enabled `Plugin`s add to this call's Context — today the site's
   *  `Skill`, when it has one. Collected on the host when the call is sent
   *  (`agent/context/plugins.ts`), outside the reducer, and carried here for the
   *  same reason `history` is: the prompt is built in the panel (CONTEXT.md
   *  `Panel`). */
  contributions?: readonly string[];
  /** What was said earlier in this conversation — the user's words and the
   *  guide's own answers, most recent last. Read on the host when the call is
   *  sent (the conversation is the host's, `CONTEXT.md` `Conversation`) and
   *  carried here for the same reason `history` is: the prompt is built in the
   *  panel. Absent when nothing was said before this. */
  recent?: readonly Talk[];
  /**
   * Refs that were not on this page a moment ago, when the page did not
   * navigate. Empty or absent everywhere else: on a fresh page everything is
   * new, and marking all of it says nothing.
   *
   * Computed on the host, which is the only side holding both the previous
   * snapshot and this one — and by identity (`path|role|name`), because a
   * `Ref` means nothing across snapshots. What crosses the wire is refs, valid
   * in the table they travel with.
   */
  freshRefs?: readonly Ref[];
  /** What woke the model, when a reading did (CONTEXT.md `Reading`): every
   *  reading since its last answer, and how the page compares with the one
   *  that answer was given on. Absent otherwise. */
  since?: Since;
  /** The step's last call (ticket 09): only answers are offered, and the
   *  model is told to give one. Absent on every other call. */
  final?: true;
  /** The step's conversation so far (CONTEXT.md `Turn`), once it has a
   *  round: the page the step opened on, then every tool call and what came
   *  back. `table` above is then the page read last — what the answer is
   *  checked against. Absent on a call with no rounds, which is what keeps
   *  that call byte for byte what it was before the loop existed. */
  turn?: TurnOnWire;
}

/** `url` is the address read_doc's link judgement has already approved
 *  (`tools/read-doc.ts`) — the panel fetches, it never decides (design doc
 *  §8.3). The panel's executor is written against this shape; the host does
 *  not put this request on the wire yet — see `toEffectRequest` in
 *  `agent/thread/writer.ts`. */
export interface FetchDocParams {
  viaRef: Ref;
  query: string;
  url: string;
}

/** design doc §2.6: the world state an effect was issued against, echoed
 *  back unchanged by the panel (E-3 — "SW 不信任侧栏重算"). */
export interface EffectAt {
  threadRev: number;
  snapshotId: string;
  structureHash: string;
  url: string;
}

export interface EffectUsage {
  prompt: number;
  completion: number;
  total: number;
  /** The cached share of `prompt`, when the endpoint reports one. Travels
   *  because `prompt` alone stopped describing cost once prefix caching
   *  started hitting. */
  cachedPrompt?: number;
}

export interface EffectRequest {
  /** SW-generated, written into `ThreadState.inflight` before this is ever
   *  sent (E-1) — never minted by this file. */
  effectId: string;
  threadId: string;
  kind: 'callModel' | 'fetchDoc';
  params: CallModelParams | FetchDocParams;
  at: EffectAt;
  /** epoch ms. The panel may use this to self-abort; the host's own E-4
   *  judgement (`judgeRecovery` below) never trusts the panel to. */
  deadline: number;
}

/**
 * Which of three unrelated things went wrong, so the host can say three
 * different things to the user. `transport` — the request never produced an
 * answer. `parse` — an answer came back that is not an envelope, twice.
 * `violation` — a well-formed envelope that R-a…R-e refused.
 *
 * They used to arrive as one undifferentiated `error` string and reach the
 * user as 「调用失败」 regardless, which is wrong for two of the three: a
 * refused envelope is not a failed call, and the panel is the *only* place
 * that knows which happened, because on the failure path the host never sees
 * the model text and cannot re-derive the verdict for itself.
 */
export type EffectFailureKind = 'transport' | 'parse' | 'violation';

export type EffectOutcome =
  | {
      ok: true;
      value: unknown;
      usage?: EffectUsage;
      providerCalls: number;
      /**
       * Which function the model called, when the answer came back as a tool
       * call. The name *is* the intent, and `value` is the arguments text with
       * no `intent` in it — so without this the host cannot re-derive the
       * envelope it is supposed to be the final judge of (§8.3), and every
       * answer reads as "信封缺少 intent 字段". Absent on the text path.
       */
      tool?: string;
      /** The endpoint's id for that call. A tool round is replayed to the model
       *  as a call and its result paired by this id; the host makes one from
       *  the effect id when the endpoint gave none. */
      callId?: string;
      /** The reasoning the endpoint reported before that call, opaque, to be
       *  replayed with its result. Absent on protocols that report none. */
      reasoning?: ToolCall['reasoning'];
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      failureKind: EffectFailureKind;
      /** Where the user can put it right, when it is theirs to fix. */
      fix?: Fix;
      providerCalls: number;
      /** Present whenever the endpoint answered at all. A draw that came back
       *  and was then refused was still billed, and the panel's cost display
       *  is the only place the user is ever told what a run costs — reporting
       *  a refused envelope as free is the one reading that is certainly
       *  wrong. Absent on a transport failure, where nothing came back. */
      usage?: EffectUsage;
    };

export interface EffectResult {
  effectId: string;
  /** Echoed from the `EffectRequest` this answers, not recomputed — E-3 lives
   *  in `machine.ts`'s comparison against `ThreadState.table`, not here. */
  at: EffectAt;
  outcome: EffectOutcome;
}

/**
 * §5.10/design doc's per-kind budget for how long a dispatched effect stays
 * legitimate. `callModel` is set above `transport.ts`'s own `TOTAL_TIMEOUT_MS`
 * (120s) rather than equal to it: the panel's own SSE client already has a
 * total-timeout of its own, and the host declaring a call dead *before* the
 * panel's own client would have could discard a result that was always going
 * to arrive (as a `ProviderError`) on its own. `fetchDoc` has no streaming to
 * stall on, so it borrows `transport.ts`'s `STALL_TIMEOUT_MS` outright.
 */
export const CALL_MODEL_TIMEOUT_MS = 150_000;
export const FETCH_DOC_TIMEOUT_MS = 30_000;

export function timeoutMsFor(kind: EffectRequest['kind']): number {
  return kind === 'callModel' ? CALL_MODEL_TIMEOUT_MS : FETCH_DOC_TIMEOUT_MS;
}

export function deadlineFor(kind: EffectRequest['kind'], now: number): number {
  return now + timeoutMsFor(kind);
}

/**
 * A dispatched effect as the host keeps it: the request that went out, and
 * the panel that took it (`claimedBy`, the panel document's id). Absent until
 * a panel claims it, and cleared when the host hands it out again because
 * nobody is running it (ticket 06c).
 */
export type DispatchedEffect = EffectRequest & { claimedBy?: string };

/**
 * E-4/E-6's shared verdict: given whatever the host currently has persisted
 * as "the inflight effect" (or nothing), and the current time, what should a
 * caller (the host's own timeout sweep, or the panel asking on reopen)
 * conclude? Pure — `now` is always supplied, never read from `Date.now()`
 * internally, so both call sites can be driven deterministically in a test.
 *
 * A deadline is a promise about a call someone is running. An effect no panel
 * has claimed has not started, so nothing about it can be late: it waits for
 * a panel, and the host says so to the user (06c).
 */
export type EffectRecovery = 'none' | 'expired' | 'in_progress';

export function judgeRecovery(effect: Pick<DispatchedEffect, 'deadline' | 'claimedBy'> | null, now: number): EffectRecovery {
  if (!effect) return 'none';
  if (!effect.claimedBy) return 'in_progress';
  return now >= effect.deadline ? 'expired' : 'in_progress';
}

/**
 * Which panel runs a dispatched effect. The host's dispatch is a broadcast,
 * and every open `sidepanel.html` answers it whichever tab it is showing
 * (`startEffectListener`), so without this each of them would really call
 * `complete()`/`fetch()` and the user would be billed once per open panel
 * for one model call.
 *
 * The first panel to ask for the effect in flight gets it. A panel that asks
 * again for the same one — itself included — is refused while the one that
 * has it is still open; once that one has closed, the next asker takes over.
 * The claim is kept with the effect, not in the host's memory: the service
 * worker is evicted while panels run their calls, and a claim that died with
 * it would let a second panel run the same call (06c). `holderOpen` is asked
 * of the browser by the caller; this stays a pure judgement.
 */
export function judgeClaim(
  effect: DispatchedEffect | null,
  effectId: string,
  claimant: string,
  holderOpen: boolean,
): boolean {
  if (!effect || effect.effectId !== effectId) return false;
  if (!effect.claimedBy) return true;
  if (effect.claimedBy === claimant) return false;
  return !holderOpen;
}
