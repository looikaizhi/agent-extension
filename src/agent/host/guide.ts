import { deadlineFor, judgeRecovery, type EffectRequest } from './effect';
import { pageMoved, step, type MachineEffect, type MachineInput } from './machine';
import { decodeThread, encodeThread, type ThreadState } from './thread';
import type { ThreadId, ThreadStore } from './ports';
import type { PromptTable } from '@/core/extractor/types';

/* ═══════════ S2 guided-flow effect protocol ═══════════
 *
 * `step` (host/machine.ts) is a pure reducer; something has to load a
 * `ThreadState`, call it, persist the result, and turn any dispatchable
 * `MachineEffect` into a wire `EffectRequest` for the panel. Single-writer
 * (ADR 0009, tests/unit/architecture.spec.ts's own self-check on this file)
 * says that something must live here — `background.ts` may not import
 * `host/machine.ts` at all, so it calls the functions below instead of
 * `step` directly.
 *
 * This section is additive: it does not touch `StepOneHost`/`AgentHost`
 * above. 05 (`route`/`steps` production and consumption) is what makes a live
 * `goal` actually reach a `ThreadState` — `entrypoints/background.ts`'s
 * `startGuide` still tries the zero-cost paths first (a guide pack, then the
 * local lexical baseline), and only falls to `applyGuideInput` below when
 * both come back with nothing, exactly the shape design doc §1.4's
 * "M0 先行" ordering describes. 04's job was the protocol these functions
 * speak once that happens, proven here with a fake-backed `ThreadStore`
 * (matching 04-effect-protocol.md slice 1's own prescription) rather than the
 * live one; 05 is what makes it reachable at all.
 *
 * `ThreadState` gets its own key prefix (`guideKeyFor`, `guide:{threadId}`),
 * deliberately distinct from S1's `keyFor`/`thread:{threadId}` above.
 * 04-effect-protocol.md's own doc comment flagged this rather than silently
 * inheriting S1's convention: `StepOneHost`'s `Thread` and this file's
 * `ThreadState` are two different shapes that can each legitimately own the
 * same tab's session at different times (an inspector-driven guide today, a
 * model-driven one tomorrow) — sharing one key would mean whichever wrote
 * last wins, and the other flow's very next read decodes a record shaped for
 * a different type. Kept as a one-line, easy-to-audit difference rather than
 * folding the two stores into one shape: `Thread` and `ThreadState` differ in
 * nearly every field, and a union would need a runtime tag either way — this
 * *is* that tag, just expressed as a storage key instead of a field.
 */

const guideKeyFor = (id: ThreadId) => `guide:${id}`;
const effectKeyFor = (id: ThreadId) => `effect:${id}`;

async function loadGuideThread(store: ThreadStore, id: ThreadId): Promise<ThreadState | null> {
  const k = guideKeyFor(id);
  const record = (await store.get(k))[k] as Record<string, unknown> | undefined;
  return record ? decodeThread(record) : null;
}

/**
 * Converts the one dispatchable `MachineEffect` a `step` call can produce
 * (`callModel`/`fetchDoc` — never both in the same call; `tryEmitCallModel`/
 * `tryEmitFetchDoc` in machine.ts both gate on the same `inflight` tombstone)
 * into the wire `EffectRequest` E-1 sends. `present`/`notify` never reach
 * this function — those are effects the host executes itself (design doc
 * §2.1), not ones it delegates to the panel.
 *
 * `fetchDoc` always returns `null` for now: `MachineEffect`'s `fetchDoc`
 * variant carries `viaRef`/`query` only, no resolved `url` — that arrives
 * with 06's `RESOLVE_LINK` authorization step (design doc §6.2/§8.3).
 * Fabricating a URL here to fill the gap would be exactly the kind of
 * unauthorized fetch §8.3 exists to prevent, so this deliberately produces no
 * request rather than a wrong one; `applyGuideInput` below leaves the
 * reducer's own `inflight` tombstone alone in that case rather than guessing
 * what the wire-side record should say.
 */
function toEffectRequest(
  threadId: ThreadId,
  effect: MachineEffect,
  at: EffectRequest['at'],
  deadline: number,
): EffectRequest | null {
  if (effect.kind === 'callModel') {
    return {
      effectId: effect.effectId,
      threadId,
      kind: 'callModel',
      params: { goal: effect.goal, table: effect.table, history: effect.history },
      at,
      deadline,
    };
  }
  return null; // 'fetchDoc' (pending 06), and anything not dispatchable
}

/** Says what the extension cannot do, not what the model got wrong — the model
 *  asking to read a linked doc is a reasonable request against a capability
 *  that is not built yet (06). Deleted, not reworded, once `fetchDoc` can
 *  actually be dispatched. */
const DOC_FETCH_UNAVAILABLE: MachineEffect = {
  kind: 'notify',
  message: '模型想先读这个页面上的一份文档才能继续，但扩展还不能替你打开并读取它。换一个更具体的说法再问一次，或先自己打开那份文档。',
};

export interface GuideEffectDeps {
  store: ThreadStore;
  /** Called at most once per `applyGuideInput` call, only after this call's
   *  persistence has resolved (E-1) — never awaited internally, so a
   *  synchronous fake in a test can observe call order without racing a
   *  promise (04-effect-protocol.md slice 1). */
  send: (req: EffectRequest) => void;
  now: () => number;
  /** Mints the id for an effect this call turns out to need. Injected rather
   *  than read from `crypto` directly so `agent/api.ts` stays free of platform
   *  globals (N-1) and so a test can assert *which* id was spent. */
  newEffectId: () => string;
}

/**
 * What a caller actually hands `applyGuideInput`: `MachineInput` with
 * `effect_result`'s `nextEffectId` removed, because deciding whether a result
 * needs one requires parsing the payload — work that happens inside `step`,
 * after the caller is done. Derived from `MachineInput` rather than written
 * out again, so the two can never drift.
 */
export type GuideInput =
  | Exclude<MachineInput, { kind: 'effect_result' }>
  | Omit<Extract<MachineInput, { kind: 'effect_result' }>, 'nextEffectId'>;

export interface GuideStepOutcome {
  /** `null` only when an `effect_result` arrived for a thread that does not
   *  exist at all (already dropped, or never started) — E-2 territory, not
   *  an error. Always non-null after a `start`. */
  state: ThreadState | null;
  /** `step`'s raw output — `present`/`notify` included, for a future caller
   *  that wants to render them (05). Empty on an E-2 discard. */
  effects: MachineEffect[];
  /** The subset of `effects` that actually went out over the wire this call
   *  (at most one — see `toEffectRequest`'s doc comment). Empty whenever
   *  `effects` is, and also whenever the one dispatchable effect was a
   *  `fetchDoc` (pending 06). */
  sent: EffectRequest[];
}

/**
 * The single place S2's guided flow calls `step` (machine.ts) — ADR 0009's
 * single-writer chain, enforced the same way N-4 is (a grep in
 * `architecture.spec.ts`). E-1's ordering is structural here, not a
 * convention callers have to remember: `deps.send` is only ever reached
 * after this call's own `store.set` has resolved.
 *
 * E-2's "不等 → 直接丢弃,不调用 step" (04-effect-protocol.md Gotchas) is the
 * `effect_result` early return below, checked against the *freshly loaded*
 * `prior.inflight` before `step` — and therefore before `rev` advances or
 * anything is written — ever runs. `step` already treats a mismatched
 * `effect_result` as a no-op internally (03's `handleEffectResult`), so
 * skipping it here changes nothing about *correctness*; what it buys is not
 * spending a `rev` bump and a storage write on a delivery this thread has no
 * reason to trust — genuinely stale network noise (duplicate delivery,
 * slice 3/4) — rather than exercising the reducer's own equally-correct but
 * observably different "unchanged state, rev+1" path (machine.spec.ts slice 2).
 */
export async function applyGuideInput(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  input: GuideInput,
): Promise<GuideStepOutcome> {
  const prior = input.kind === 'start' ? null : await loadGuideThread(deps.store, threadId);

  if (input.kind === 'effect_result' && (!prior?.inflight || prior.inflight.effectId !== input.effectId)) {
    return { state: prior, effects: [], sent: [] };
  }

  const result = step(
    prior,
    input.kind === 'effect_result' ? { ...input, nextEffectId: deps.newEffectId() } : input,
  );

  const dispatched = result.state.inflight
    ? result.effects.find(
        (e): e is Extract<MachineEffect, { kind: 'callModel' | 'fetchDoc' }> =>
          e.kind === 'callModel' || e.kind === 'fetchDoc',
      )
    : undefined;
  const req =
    dispatched && result.state.inflight
      ? toEffectRequest(threadId, dispatched, result.state.inflight.at, deadlineFor(dispatched.kind, deps.now()))
      : null;

  // The reducer asked for an effect this host cannot put on the wire — today
  // that is only `fetchDoc`, which has no resolved URL until 06's
  // `RESOLVE_LINK` authorization step. The reducer's `inflight` tombstone
  // would then sit there with nothing able to resolve it: nothing goes out, so
  // no result ever comes back, and E-4's sweep only fires on an `effect:`
  // record that was never written. Every later input would find `inflight`
  // set and decline silently (`tryEmitCallModel`'s first gate) — a thread
  // welded shut, which is what the live run's `need_docs` sample actually did
  // for 91 seconds. Clear the tombstone and say so out loud instead.
  const undeliverable = dispatched !== undefined && req === null;
  const state = undeliverable ? { ...result.state, inflight: null } : result.state;
  const effects = undeliverable ? [...result.effects, DOC_FETCH_UNAVAILABLE] : result.effects;

  const items: Record<string, unknown> = { [guideKeyFor(threadId)]: encodeThread(state) };
  if (req) items[effectKeyFor(threadId)] = req;
  await deps.store.set(items); // E-1: persistence first —
  if (!state.inflight) await deps.store.remove(effectKeyFor(threadId));

  const sent: EffectRequest[] = [];
  if (req) {
    deps.send(req); // — dispatch second, and only after the line above resolved.
    sent.push(req);
  }

  return { state, effects, sent };
}

/**
 * Which of the two hosts owns this tab's session right now.
 *
 * `StepOneHost` (S1) and the guided flow (S2) both listen for the same content
 * events — `STEP_CONFIRMED`, `TARGET_LOST`, a completed navigation — and every
 * one of them was wired to S1 alone. S1's `resume()` reads `thread:{id}`; an S2
 * thread lives under `guide:{id}`, so `resume()` found nothing and ended the
 * session. One click on the step we had just highlighted destroyed the guide.
 *
 * Deliberately a separate query rather than folding the decision into
 * `applyGuidePageChanged`'s existing `null`: that function returns `null` both
 * for "no S2 thread here" and for "S2 thread, but the page did not move", and
 * routing has to tell those apart — the first must fall through to S1, the
 * second must not.
 */
export async function guideThreadExists(store: ThreadStore, threadId: ThreadId): Promise<boolean> {
  return (await loadGuideThread(store, threadId)) !== null;
}

/**
 * The thread as it stands, for a caller that must summarise a run before
 * ending it (07's Seam 10) — read-only, no `step` call, no `rev` advance.
 */
export async function peekGuideThread(store: ThreadStore, threadId: ThreadId): Promise<ThreadState | null> {
  return loadGuideThread(store, threadId);
}


/**
 * Ends the guided flow for this tab: the thread itself goes, not just whatever
 * it had in flight.
 *
 * Distinct from `cancelGuideEffect`, which deliberately keeps the thread alive
 * (E-5 cancels an effect, not the guide). Nothing used to delete the thread at
 * all — `END_GUIDE` only cancelled the effect — which was invisible while
 * `guide:{id}` had no readers outside the flow itself. It stopped being
 * invisible the moment ownership routing started asking "does an S2 thread own
 * this tab": a finished guide left its record behind, `guideThreadExists`
 * answered yes forever, and every later S1 flow in that same tab was routed to
 * a thread that had already ended.
 */
export async function dropGuideThread(store: ThreadStore, threadId: ThreadId): Promise<void> {
  await store.remove(guideKeyFor(threadId));
  await store.remove(effectKeyFor(threadId));
}

/**
 * E-4/E-6's read side: what the host currently has persisted as "the
 * inflight effect" for this thread, with nothing recomputed and no `step`
 * call — safe from a context that must not spend money or advance `rev` (a
 * panel's "what happened while I was closed" query, E-6; the host's own
 * passive timeout sweep, E-4, before it decides whether to synthesize a
 * failure).
 */
export async function peekGuideEffect(store: ThreadStore, threadId: ThreadId): Promise<EffectRequest | null> {
  const k = effectKeyFor(threadId);
  return ((await store.get(k))[k] as EffectRequest | undefined) ?? null;
}

/**
 * E-4: "超时由 SW 按 deadline 判定，不依赖侧栏上报". No `chrome.alarms` —
 * 04-effect-protocol.md's Gotchas explicitly allow a passive check on the
 * next message instead, so `background.ts` calls this at the top of its
 * panel-result and "what's inflight" handlers. `judgeRecovery` itself is
 * pure and takes `now` as data, so whether this runs on a timer or on
 * message-wake never changes what it decides — only when it gets the chance
 * to decide it.
 *
 * On an expired effect, this synthesizes exactly the `effect_result` a
 * genuinely failed panel would have sent (`ok:false`, `retryable:true`) and
 * runs it through the same `applyGuideInput` path as a real one — reusing
 * `machine.ts`'s existing "调用失败" handling (03) rather than teaching the
 * reducer a dedicated timeout input kind.
 */
export async function sweepExpiredGuideEffect(deps: GuideEffectDeps, threadId: ThreadId): Promise<GuideStepOutcome | null> {
  const inflight = await peekGuideEffect(deps.store, threadId);
  if (judgeRecovery(inflight, deps.now()) !== 'expired') return null;
  return applyGuideInput(deps, threadId, {
    kind: 'effect_result',
    effectId: inflight!.effectId,
    at: inflight!.at,
    outcome: { ok: false, error: '调用超时', retryable: true },
  });
}

/**
 * E-5: cancels whatever effect is currently in flight, without ending the
 * guide itself — `route`/`steps`/`cursor` survive; only the tombstone (and
 * its wire-side mirror, the `effect:` key) is cleared. Bypasses `step`
 * deliberately: `machine.ts`'s `MachineInput` has no "abort" member (adding
 * one is a 03-scoped change this task does not make), and clearing a
 * tombstone is a mechanical fact here, not a judgement — there is nothing
 * for a reducer branch to decide.
 *
 * Returns the cancelled `effectId` (for the caller to broadcast `abort`), or
 * `null` when there was nothing to cancel — already resolved, or never
 * started. `null` is not an error: the Gotchas are explicit that a "cancel"
 * arriving after the result already landed is a harmless no-op (slice 8).
 */
export async function cancelGuideEffect(store: ThreadStore, threadId: ThreadId): Promise<string | null> {
  const prior = await loadGuideThread(store, threadId);
  const effectId = prior?.inflight?.effectId ?? null;
  if (!prior || !effectId) return null;
  await store.set({ [guideKeyFor(threadId)]: encodeThread({ ...prior, inflight: null }) });
  await store.remove(effectKeyFor(threadId));
  return effectId;
}

/**
 * §5.3's re-planning trigger, host side. `entrypoints/background.ts` calls
 * this once per `PAGE_STRUCTURE_CHANGED` content-script event, after
 * re-extracting a fresh `PromptTable` — never with a stale one, since a fresh
 * extraction is the entire reason the event fired.
 *
 * Two independent guards, matching 05-route-and-steps.md's Gotchas exactly:
 * the content script (`core/extractor/fingerprint.ts`'s `pageStructureChanged`)
 * already refuses to report when *its own* last-known hash has not moved;
 * this function adds the host's own, independent check against the hash the
 * *guide* actually planned against (`ThreadState.table.pageHash`) — the two
 * can legitimately differ (a stale report in flight, more than one page
 * change between messages) so neither guard substitutes for the other.
 *
 * Returning `null` rather than calling `applyGuideInput` at all when nothing
 * needs to change is deliberate, not merely an optimisation: `step` (machine.
 * ts) unconditionally bumps `rev` on every call (its own doc comment), so
 * calling through for a no-op `page_changed` would still churn `rev` and
 * write to storage for zero observable benefit — slice 8's own assertion.
 *
 * `null` is also the answer when no S2 `ThreadState` exists for this thread
 * at all (an S1 pack/baseline/inspector-driven flow currently owns the tab,
 * or nothing does) — `step` has no defined behaviour for a `page_changed`
 * input against `state === null` (`dispatch` throws), so this must not reach
 * `applyGuideInput` in that case either.
 */
export async function applyGuidePageChanged(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  table: PromptTable,
  effectId: string,
): Promise<GuideStepOutcome | null> {
  const prior = await loadGuideThread(deps.store, threadId);
  if (!prior) return null;
  if (!pageMoved(prior.table, table)) return null;
  return applyGuideInput(deps, threadId, { kind: 'page_changed', table, effectId });
}

/**
 * The verbatim, no-derivation view 05-route-and-steps.md's Seam demands for
 * "全貌展示": `route` is `ThreadState.route` itself — the *complete*, latest
 * envelope's waypoints, already replaced-not-merged by `machine.ts`'s own
 * `handleEffectResult` (`route: envelope.route`, a plain assignment, never a
 * concat) — and `evidence`/`check` are read straight off the same state, with
 * no aggregation into one combined value (the Gotchas: "合并任意两轴都会造出
 * 一个既不能解释也不能复核的等级"). Exists as its own named function, thin as
 * it is, so a test can assert *this exact triple* end-to-end through two
 * successive `applyGuideInput` re-plans without reaching past it into
 * `ThreadState`'s internal field names.
 */
export interface GuideDisplay {
  route: ThreadState['route'];
  evidence: ThreadState['evidence'];
  check: ThreadState['check'];
}

export function guideDisplayOf(state: ThreadState): GuideDisplay {
  return { route: state.route, evidence: state.evidence, check: state.check };
}
