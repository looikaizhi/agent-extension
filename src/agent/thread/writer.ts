import { deadlineFor, judgeRecovery, type EffectRequest } from './effect';
import { pageMoved, step, stepOnScreen } from './machine';
import type { Ending, ExternalEnding, MachineEffect, MachineInput } from './thread';
import { contributionsFor, enabledPlugins, pluginsNamed } from '@/agent/context/plugins';
import type { FlagStore } from '@/agent/flags';
import { buildRunRecord } from './record';
import { writeRunRecord, type RecordStore } from './record-store';
import { createSerialQueue } from '@/shared/serial';
import { decodeThread, encodeThread, type ThreadState } from './thread';
import type { ThreadId, ThreadStore } from './ports';
import type { PromptTable } from '@/core/extractor/types';

/* ═══════════ guided-flow effect protocol ═══════════
 *
 * `step` (thread/machine.ts) is a pure reducer; something has to load a
 * `ThreadState`, call it, persist the result, and turn any dispatchable
 * `MachineEffect` into a wire `EffectRequest` for the panel. That something is
 * this file and only this file — the single-writer guard in
 * tests/unit/architecture.spec.ts fails if `step` gets a second caller — so
 * `background.ts` never imports `thread/machine.ts` and calls the functions below.
 *
 * `ThreadState` lives under `guide:{threadId}` (`guideKeyFor`), its in-flight
 * effect's wire mirror under `effect:{threadId}`, and the names of the Plugins
 * the run started with under `plugins:{threadId}`. All three are written only
 * here, through one per-thread serial queue (`writes`), so no two reductions
 * of the same thread can interleave.
 */

const guideKeyFor = (id: ThreadId) => `guide:${id}`;
const effectKeyFor = (id: ThreadId) => `effect:${id}`;
const pluginsKeyFor = (id: ThreadId) => `plugins:${id}`;

/** The names of the Plugins a run started with — `[]` when none were on. */
async function loadRunPlugins(store: ThreadStore, id: ThreadId): Promise<readonly string[]> {
  const k = pluginsKeyFor(id);
  return ((await store.get(k))[k] as string[] | undefined) ?? [];
}

async function loadGuideThread(store: ThreadStore, id: ThreadId): Promise<ThreadState | null> {
  const k = guideKeyFor(id);
  const record = (await store.get(k))[k] as Record<string, unknown> | undefined;
  return record ? decodeThread(record) : null;
}

/**
 * Converts the one dispatchable `MachineEffect` a `step` call can produce
 * (`callModel`/`fetchDoc` — never both in the same call; the model-call gate
 * and need_docs's fetch gate both stop at the same `inflight` tombstone)
 * into the wire `EffectRequest` E-1 sends. `present`/`notify` never reach
 * this function — those are effects the host executes itself (design doc
 * §2.1), not ones it delegates to the panel.
 *
 * `fetchDoc` always returns `null` for now. The effect does carry an address
 * the host has already approved (need_docs's link judgement), but the other
 * half of the loop is not built: nothing puts the request on the wire to the
 * panel, and nothing hands the document's text back to the model when it
 * returns. Producing no request is the honest answer until both exist;
 * `applyGuideInput` below clears the tombstone and tells the user so.
 */
export function toEffectRequest(
  threadId: ThreadId,
  effect: MachineEffect,
  at: EffectRequest['at'],
  deadline: number,
  /** What the enabled Plugins add to a model call's Context (`agent/context/plugins.ts`). */
  contributions: readonly string[] = [],
): EffectRequest | null {
  if (effect.kind === 'callModel') {
    return {
      effectId: effect.effectId,
      threadId,
      kind: 'callModel',
      params: {
        goal: effect.goal,
        table: effect.table,
        history: effect.history,
        ...(contributions.length ? { contributions } : {}),
        ...(effect.freshRefs?.length ? { freshRefs: effect.freshRefs } : {}),
      },
      at,
      deadline,
    };
  }
  return null; // 'fetchDoc' — not put on the wire yet (see above) — and anything not dispatchable
}

/** Says what the extension cannot do, not what the model got wrong — the model
 *  asking to read a linked doc is a reasonable request against a capability
 *  that is not built yet. Deleted, not reworded, once doc fetches go out and
 *  their text reaches the model. */
const DOC_FETCH_UNAVAILABLE: MachineEffect = {
  kind: 'notify',
  message: '模型想先读这个页面上的一份文档才能继续，但扩展还不能替你打开并读取它。换一个更具体的说法再问一次，或先自己打开那份文档。',
};

export interface GuideEffectDeps {
  store: ThreadStore;
  /** Where a finished run's summary goes. Injected rather than reached for,
   *  because `endGuide` below is the one place that writes it and a test has
   *  to be able to watch — including watching it fail. */
  records: RecordStore;
  /** Where the switches live (`agent/flags.ts`): the Plugin switches sit
   *  beside the trace switch, so a harness can set them before a run. Read
   *  once per run, when it starts. */
  flags: FlagStore;
  /** Called at most once per `applyGuideInput` call, only after this call's
   *  persistence has resolved (E-1) — never awaited internally, so a
   *  synchronous fake in a test can observe call order without racing a
   *  promise (design doc §2.6, E-1). */
  send: (req: EffectRequest) => void;
  now: () => number;
  /** Mints the id for an effect this call turns out to need. Injected rather
   *  than read from `crypto` directly so this module stays free of platform
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

export interface GuideReduction {
  /** `null` only when an `effect_result` arrived for a thread that does not
   *  exist at all (already dropped, or never started) — E-2 territory, not
   *  an error. Always non-null after a `start`. */
  state: ThreadState | null;
  /** `step`'s raw output — `present`/`notify` included, for a future caller
   *  that wants to render them (05). Empty on an E-2 discard. */
  effects: MachineEffect[];
  /** Present exactly when this input gave the thread an ending — the
   *  reducer has several ways to do that — arrival, either quota, a safety stop,
   *  the loop backstop, a fixed plan running out — and every one of them ends the run. The
   *  thread is already recorded and dropped by the time this is returned; what
   *  is left for the caller is the platform work the host cannot do from
   *  here (clearing the overlay, broadcasting the abort of whatever effect was
   *  in flight, and saying so if the summary could not be saved). */
  ending?: GuideEnding;
  /** The subset of `effects` that actually went out over the wire this call
   *  (at most one — see `toEffectRequest`'s doc comment). Empty whenever
   *  `effects` is, and also whenever the one dispatchable effect was a
   *  `fetchDoc`, which is not put on the wire yet. */
  sent: EffectRequest[];
}

/**
 * Every write to one thread's persisted state, one after another.
 *
 * Not an optimisation — a correctness requirement. `applyGuideInput` reads the
 * thread, computes, then writes it back; `endGuide` deletes it. Interleaved,
 * the write-back resurrects a thread that has already ended, and the ownership
 * routing then hands every later click in this tab to a run that is over.
 *
 * `createSerialQueue`, not the latest-wins variant `replan.ts` uses: an input
 * that arrives while another is being applied must still be applied, not
 * dropped. Superseding is right for re-plans (they describe consecutive states
 * of one transition) and wrong for state writes.
 *
 * Keyed by thread, so guides in different tabs still run in parallel. Every
 * public entry point below wraps exactly once — `applyGuidePageChanged` and
 * `sweepExpiredGuideEffect` call the *inner* form, because re-entering the
 * queue under the same key would wait on a tail that cannot drain until the
 * waiter returns.
 */
const writes = createSerialQueue();

/**
 * The single place the guided flow calls `step` (machine.ts) — the
 * single-writer chain, enforced the same way N-4 is (a grep in
 * `architecture.spec.ts`). E-1's ordering is structural here, not a
 * convention callers have to remember: `deps.send` is only ever reached
 * after this call's own `store.set` has resolved.
 *
 * E-2's "不等 → 直接丢弃,不调用 step" (design doc §2.6) is the
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

export function applyGuideInput(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  input: GuideInput,
): Promise<GuideReduction> {
  return writes(threadId, () => applyGuideInputInner(deps, threadId, input));
}

async function applyGuideInputInner(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  input: GuideInput,
): Promise<GuideReduction> {
  const starting = input.kind === 'start' || input.kind === 'start_fixed';
  const prior = starting ? null : await loadGuideThread(deps.store, threadId);

  // The thread ended while this input was on its way. `dispatch` throws for any
  // input other than the two starts with no state, which in a message handler is an
  // unattended rejection; and applying it would write the thread back. Both are
  // answered here rather than at each call site, because "did it end while I
  // was in flight" is not a question a caller can answer for itself.
  if (!starting && !prior) return { state: null, effects: [], sent: [] };

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
  // Collected here, outside the reducer: which Plugins are on is a storage read.
  // A run is made with one set — read from the switches when it starts and kept
  // beside the thread — so every call it sends and its Run record agree, and a
  // switch changed mid-run applies from the next run.
  const startedWith = starting ? (await enabledPlugins(deps.flags)).map((p) => p.name) : undefined;
  const contributions =
    dispatched?.kind === 'callModel'
      ? contributionsFor(pluginsNamed(startedWith ?? (await loadRunPlugins(deps.store, threadId))), dispatched.table.url)
      : [];
  const req =
    dispatched && result.state.inflight
      ? toEffectRequest(threadId, dispatched, result.state.inflight.at, deadlineFor(dispatched.kind, deps.now()), contributions)
      : null;

  // The reducer asked for an effect this host cannot put on the wire — today
  // that is only `fetchDoc`: its address is already approved, but nothing puts
  // the request on the wire or brings the document back to the model yet. The
  // reducer's `inflight` tombstone
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
  if (startedWith) items[pluginsKeyFor(threadId)] = startedWith;
  await deps.store.set(items); // E-1: persistence first —
  if (!state.inflight) await deps.store.remove(effectKeyFor(threadId));

  // The one judgement that decides whether this run is over: did *this*
  // reduction give it an ending. Asking it here rather than at
  // each terminal means the reducer can grow another way to stop without
  // anyone remembering to wire it up — which is exactly how most of the
  // earlier ones came to leave `guide:{id}` behind.
  //
  // Written first, ended second: `endGuideInner` reads the thread back, so the
  // summary it records is the terminal state, not the one before it.
  const endedHere = prior && prior.ending === undefined ? state.ending : undefined;
  const ending = endedHere ? await endGuideInner(deps, threadId, endedHere) : undefined;

  const sent: EffectRequest[] = [];
  if (req) {
    deps.send(req); // — dispatch second, and only after the line above resolved.
    sent.push(req);
  }

  return { state, effects, sent, ...(ending ? { ending } : {}) };
}

/**
 * Whether a guide owns this tab right now — the question every content event
 * asks before it costs anything (a re-plan extracts the page).
 *
 * Deliberately a separate query rather than `applyGuidePageChanged`'s `null`:
 * that answers both "no guide here" and "a guide, but the page did not move",
 * and a caller deciding whether to look at all has to tell those apart.
 */
export async function guideThreadExists(store: ThreadStore, threadId: ThreadId): Promise<boolean> {
  return (await loadGuideThread(store, threadId)) !== null;
}

/**
 * The thread as it stands, for a caller that only reads it — no `step` call,
 * no `rev` advance.
 */
export async function peekGuideThread(store: ThreadStore, threadId: ThreadId): Promise<ThreadState | null> {
  return loadGuideThread(store, threadId);
}

/** What painting a step needs: the step as the reducer would present it. */
export type PresentEffect = Extract<MachineEffect, { kind: 'present' }>;

/**
 * The step to paint again for this thread, with the thread it belongs to — or
 * `null` when there is nothing safe to paint (`stepOnScreen` in machine.ts says
 * why a model-driven plan with a call in flight is refused). Read-only.
 */
export async function stepToRepaint(
  store: ThreadStore,
  threadId: ThreadId,
): Promise<{ state: ThreadState; present: PresentEffect } | null> {
  const state = await loadGuideThread(store, threadId);
  const present = state ? stepOnScreen(state) : null;
  return state && present ? { state, present } : null;
}


/**
 * The storage half of ending a guide: the thread and its effect mirror go.
 * Only `endGuideInner` calls it, inside the per-thread queue — a finished
 * thread left behind makes the ownership query answer yes forever, and a drop
 * outside the queue could race a write that puts it back.
 */
async function dropGuideThread(store: ThreadStore, threadId: ThreadId): Promise<void> {
  await store.remove(guideKeyFor(threadId));
  await store.remove(effectKeyFor(threadId));
  await store.remove(pluginsKeyFor(threadId));
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
 * a passive check on the
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
export function sweepExpiredGuideEffect(
  deps: GuideEffectDeps,
  threadId: ThreadId,
): Promise<GuideReduction | null> {
  return writes(threadId, () => sweepExpiredGuideEffectInner(deps, threadId));
}

async function sweepExpiredGuideEffectInner(
  deps: GuideEffectDeps,
  threadId: ThreadId,
): Promise<GuideReduction | null> {
  const inflight = await peekGuideEffect(deps.store, threadId);
  if (judgeRecovery(inflight, deps.now()) !== 'expired') return null;
  return applyGuideInputInner(deps, threadId, {
    kind: 'effect_result',
    effectId: inflight!.effectId,
    at: inflight!.at,
    // E-4: the panel never came back. `providerCalls: 1` is the floor, not a
    // measurement — the host cannot know whether the panel got as far as a
    // repair round, and 1 is exactly what `tryEmitCallModel` already charged
    // optimistically when it dispatched. Claiming more would bill for a
    // request that may never have gone out; claiming 0 would hand back quota
    // for one that almost certainly did.
    outcome: { ok: false, error: '调用超时', retryable: true, failureKind: 'transport', providerCalls: 1 },
  });
}


/**
 * §5.3's re-planning trigger, host side. `entrypoints/background.ts` calls
 * this once per `PAGE_STRUCTURE_CHANGED` content-script event, after
 * re-extracting a fresh `PromptTable` — never with a stale one, since a fresh
 * extraction is the entire reason the event fired.
 *
 * Two independent guards:
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
 * `null` is also the answer when no guide exists for this thread at all —
 * `step` has no defined behaviour for a `page_changed`
 * input against `state === null` (`dispatch` throws), so this must not reach
 * `applyGuideInput` in that case either.
 */
export async function applyGuidePageChanged(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  table: PromptTable,
  effectId: string,
): Promise<GuideReduction | null> {
  return writes(threadId, async () => {
    const prior = await loadGuideThread(deps.store, threadId);
    if (!prior) return null;
    if (!pageMoved(prior.table, table)) return null;
    return applyGuideInputInner(deps, threadId, { kind: 'page_changed', table, effectId });
  });
}

/**
 * A guide is over — the one place that says what that means.
 *
 * Four things, in an order that cannot be swapped: cancel whatever effect is
 * still in flight, write the run's summary, drop the thread, and hand back what
 * the caller has to do to the tab and the panel. The summary goes first because
 * dropping the thread is the moment the run stops existing to be recorded, and
 * the record is the only lasting account of it.
 *
 * Dropping is mandatory, not tidiness: a finished thread left behind makes the
 * ownership query answer yes forever, and every later flow in this tab gets
 * routed to a run that already ended.
 *
 * Idempotent by construction — the thread is gone after the first call, so the
 * second finds nothing and reports `ended: false`. Callers may race each other
 * (the model finishing and the user pressing stop are different events) and
 * neither needs to know about the other.
 *
 * A failed record write does **not** stop the ending. Losing a summary is
 * lighter than leaving a guide that cannot be started over, so the failure is
 * reported back rather than thrown.
 *
 * Touches no platform API: what the caller must do about the overlay and the
 * broadcast comes back as data.
 */
export interface GuideEnding {
  /** `false` when there was nothing to end — already ended, or never existed.
   *  Reported so a caller *may* skip its platform work; the one caller today
   *  clears the overlay either way, because a stale highlight on screen is
   *  worse than a redundant clear. */
  ended: boolean;
  /** The effect that was in flight, for the caller to broadcast an abort. */
  cancelledEffectId: string | null;
  /** Present only when the run's summary could not be written. Say it out loud;
   *  the guide has still ended. */
  recordError?: string;
}

/** Ends a run from outside the reducer; `how` is what the caller saw end it. */
export function endGuide(deps: GuideEffectDeps, threadId: ThreadId, how: ExternalEnding): Promise<GuideEnding> {
  return writes(threadId, () => endGuideInner(deps, threadId, how));
}

async function endGuideInner(deps: GuideEffectDeps, threadId: ThreadId, how: Ending): Promise<GuideEnding> {
  const thread = await loadGuideThread(deps.store, threadId);
  if (!thread) return { ended: false, cancelledEffectId: null };

  // A run the reducer ended keeps its own ending — an outside end racing it
  // does not overwrite that; one still running ends the way the caller saw.
  const ending = thread.ending ?? how;

  const cancelledEffectId = thread.inflight?.effectId ?? null;

  // Caught, not merely inspected. `writeRunRecord`'s `ok: false` is only its
  // own quota *prediction*; the store underneath rejects for real — a
  // `QUOTA_BYTES_EXCEEDED` from the platform arrives as a throw. Letting that
  // escape would skip the drop below and leave exactly the thread this
  // function exists to remove, which is the failure mode with teeth: a run
  // that cannot be recorded is a lost summary, a run that cannot be dropped
  // takes every later guide in this tab with it.
  let recordError: string | undefined;
  try {
    const plugins = await loadRunPlugins(deps.store, threadId);
    const written = await writeRunRecord(
      deps.records,
      buildRunRecord(`${threadId}-${deps.now()}`, thread, deps.now(), ending, plugins),
    );
    if (!written.ok) recordError = written.error;
  } catch (err) {
    recordError = `这次引导的记录没能保存：${err instanceof Error ? err.message : String(err)}`;
  }

  await dropGuideThread(deps.store, threadId);

  return { ended: true, cancelledEffectId, ...(recordError ? { recordError } : {}) };
}

