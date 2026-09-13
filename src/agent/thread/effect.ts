import type { GuideHistory } from '@/agent/context/user-message';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

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
}

/** `url` is the address need_docs's link judgement has already approved
 *  (`tools/need-docs.ts`) — the panel fetches, it never decides (design doc
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
  pageHash: string;
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
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      failureKind: EffectFailureKind;
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
 * legitimate. `callModel` is set above `provider.ts`'s own `TOTAL_TIMEOUT_MS`
 * (120s) rather than equal to it: the panel's own SSE client already has a
 * total-timeout of its own, and the host declaring a call dead *before* the
 * panel's own client would have could discard a result that was always going
 * to arrive (as a `ProviderError`) on its own. `fetchDoc` has no streaming to
 * stall on, so it borrows `provider.ts`'s `STALL_TIMEOUT_MS` outright.
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
 * E-4/E-6's shared verdict: given whatever the host currently has persisted
 * as "the inflight effect" (or nothing), and the current time, what should a
 * caller (the host's own timeout sweep, or the panel asking on reopen)
 * conclude? Pure — `now` is always supplied, never read from `Date.now()`
 * internally, so both call sites can be driven deterministically in a test.
 */
export type EffectRecovery = 'none' | 'expired' | 'in_progress';

export function judgeRecovery(effect: Pick<EffectRequest, 'deadline'> | null, now: number): EffectRecovery {
  if (!effect) return 'none';
  return now >= effect.deadline ? 'expired' : 'in_progress';
}

/**
 * Closes a gap first recorded as "已知的、未在
 * 本文件解决": the host's dispatched-effect message is a broadcast, so two
 * `sidepanel.html` instances bound to the *same* tab both receive it.
 * `threadId`/`tabId` matching (`startEffectListener`'s `getTabId` check)
 * only rules out *other* tabs' panels — it cannot tell two instances of
 * *this* tab's panel apart, so without this both would really call
 * `complete()`/`fetch()` and the user would be billed twice for one model
 * call. E-2's `inflight` check does not help either: it protects the host's
 * own bookkeeping from a stale/duplicate *result*, not a network call that
 * has already gone out twice.
 *
 * The fix is first-come-first-served over a `Set` the host owns: whichever
 * `onMessage` handler observes this `effectId` first wins, and every
 * subsequent claim for the same id — from any instance, including a retry
 * from the same one — loses. `claimed` is passed in rather than module-level
 * state here so this stays a pure, synchronous judgement a test can drive
 * with a bare `Set` and no `chrome.*`; owning *the* `Set` (module lifetime,
 * when to create it) is `background.ts`'s job, the one place allowed to
 * touch `chrome.runtime.onMessage`.
 *
 * No persistence, and none is needed: the arbitration only has to be atomic
 * at the instant the broadcast fans out, and JS's single-threaded event loop
 * already guarantees that — every `onMessage` listener's "check `Set`, then
 * add" runs to completion before the next one starts, so there is no window
 * for two instances to both observe an empty slot. If the service worker is
 * evicted and a later wake-up starts with a fresh, empty `Set`, that costs
 * nothing: E-1's own invariant is at most one `inflight` effect per thread
 * at a time, so a rebuilt `Set` never has to arbitrate a *second* claim for
 * an id it already granted before eviction — the only claims it will ever
 * see are first claims for whatever is inflight now. Treat "empty `Set`
 * after eviction" as expected behaviour, not a bug to fix by persisting it.
 */
export function claimEffect(claimed: Set<string>, effectId: string): boolean {
  if (claimed.has(effectId)) return false;
  claimed.add(effectId);
  return true;
}
