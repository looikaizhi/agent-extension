import { deadlineFor, judgeClaim, judgeRecovery, type DispatchedEffect, type EffectRequest } from './effect';
import { step, stepOnScreen } from './machine';
import { presentationIdOf } from './transitions';
import type { Ending, ExternalEnding, MachineEffect, MachineInput } from './thread';
import { contributionsFor, enabledPlugins, pluginsNamed } from '@/agent/context/plugins';
import type { FlagStore } from '@/agent/flags';
import { buildRunRecord } from './record';
import { writeRunRecord, type RecordStore } from './record-store';
import { createSerialQueue } from '@/shared/serial';
import { decodeThread, encodeThread, type ThreadState } from './thread';
import type { ThreadId, ThreadStore } from './ports';
import type { PromptTable } from '@/core/extractor/types';
import type { Reading } from '@/agent/context/turn';

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
/** When the tool the *host* is carrying out stops being worth waiting for. */
const toolKeyFor = (id: ThreadId) => `tool:${id}`;
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
 * and read_doc's fetch gate both stop at the same `inflight` tombstone)
 * into the wire `EffectRequest` E-1 sends. `present`/`notify` and the
 * tools the host carries out itself never reach this function (design doc
 * §2.1): only what is delegated to the panel does.
 *
 * A `fetchDoc` carries an address the host has already approved
 * (`tools/read-doc.ts`); the panel only fetches it (§8.3).
 */
export function toEffectRequest(
  threadId: ThreadId,
  effect: Extract<MachineEffect, { kind: 'callModel' | 'fetchDoc' }>,
  at: EffectRequest['at'],
  deadline: number,
  /** What the enabled Plugins add to a model call's Context (`agent/context/plugins.ts`). */
  contributions: readonly string[] = [],
): EffectRequest {
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
        ...(effect.since ? { since: effect.since } : {}),
        ...(effect.final ? { final: effect.final } : {}),
        ...(effect.turn ? { turn: effect.turn } : {}),
      },
      at,
      deadline,
    };
  }
  return {
    effectId: effect.effectId,
    threadId,
    kind: 'fetchDoc',
    params: { viaRef: effect.viaRef, query: effect.query, url: effect.url },
    at,
    deadline,
  };
}

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
 * `nextEffectId` removed, because deciding whether an input needs one requires
 * work that happens inside `step`, after the caller is done. Derived from
 * `MachineInput` rather than written out again, so the two can never drift.
 *
 * A reading is not among them: it reaches the reducer only through
 * `applyReading`, which reads the page inside the write chain.
 */
type MintedInput = Extract<MachineInput, { kind: 'effect_result' | 'tool_result' | 'reading' }>;
export type GuideInput =
  | Exclude<MachineInput, MintedInput>
  | WithoutNextId<Exclude<MintedInput, { kind: 'reading' }>>;

/** `Omit` over each member of a union, not over the union as a whole. */
type WithoutNextId<T> = T extends unknown ? Omit<T, 'nextEffectId'> : never;

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
   *  (at most one — see `toEffectRequest`'s doc comment). */
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
 * An input that arrives while another is being applied is still applied, never
 * dropped: every reading is a fact the model is owed.
 *
 * Keyed by thread, so guides in different tabs still run in parallel. Every
 * public entry point below wraps exactly once — the ones that decide something
 * before applying (`applyReading`, `sweepExpiredGuideEffect`) call the
 * *inner* form, because re-entering the
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
  input: GuideInput | WithoutNextId<Extract<MachineInput, { kind: 'reading' }>>,
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
    input.kind === 'effect_result' || input.kind === 'tool_result' || input.kind === 'reading'
      ? { ...input, nextEffectId: deps.newEffectId() }
      : input,
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

  const { state, effects } = result;

  const items: Record<string, unknown> = { [guideKeyFor(threadId)]: encodeThread(state) };
  if (req) items[effectKeyFor(threadId)] = req;
  if (startedWith) items[pluginsKeyFor(threadId)] = startedWith;
  // A tool the host runs itself (`observe`, `wait_for`) has no wire request to
  // carry a deadline, and the reducer has no clock. Its deadline is written
  // here, so a worker evicted mid-read — or a read that threw — cannot leave
  // the turn pending for good, deaf to every reading after it.
  //
  // Only those: `read_doc` goes out as a `fetchDoc` effect, which carries its
  // own deadline and whose expiry says 「没读到」 rather than 「读不到这一页」.
  const pending = state.turn?.pending && !state.inflight ? state.turn.pending : undefined;
  if (pending) items[toolKeyFor(threadId)] = { effectId: pending.effectId, deadline: deps.now() + HOST_TOOL_TIMEOUT_MS };
  await deps.store.set(items); // E-1: persistence first —
  if (!state.inflight) await deps.store.remove(effectKeyFor(threadId));
  if (!pending) await deps.store.remove(toolKeyFor(threadId));

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
 * Whether a guide owns this tab right now — asked before anything that costs:
 * nothing is read from the page and nothing is written.
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
  await store.remove(toolKeyFor(threadId));
}

/**
 * The same run, one tab further on.
 *
 * A click that opens a new tab is not a new journey — the user did the step
 * they were shown, and the page it led to happens to have opened beside the
 * old one instead of inside it. Everything about a run is keyed by tab, so
 * without this the run stays parked on the tab the user left, pointing at a
 * control they already used, while the tab they are actually looking at has
 * nothing at all.
 *
 * The call in flight does not come along: it asked about the page the user
 * has left, and its answer would be a step for a page nobody is on. The
 * caller cancels it (`cancelledEffectId`) and the new page is read instead —
 * which is exactly what a navigation inside one tab already does, so the
 * reducer never has to know a new tab was involved.
 */
export function carryGuideThread(
  deps: GuideEffectDeps,
  from: ThreadId,
  to: ThreadId,
): Promise<{ carried: boolean; cancelledEffectId: string | null }> {
  return writes(from, async () => {
    const thread = await loadGuideThread(deps.store, from);
    if (!thread) return { carried: false, cancelledEffectId: null };
    const cancelledEffectId = thread.inflight?.effectId ?? null;
    // The Plugins a run started with are part of that run, not of the tab.
    await deps.store.set({ [guideKeyFor(to)]: { ...thread, inflight: null }, [pluginsKeyFor(to)]: await loadRunPlugins(deps.store, from) });
    await dropGuideThread(deps.store, from);
    return { carried: true, cancelledEffectId };
  });
}

/**
 * E-4/E-6's read side: what the host currently has persisted as "the
 * inflight effect" for this thread, with nothing recomputed and no `step`
 * call — safe from a context that must not spend money or advance `rev` (a
 * panel's "what happened while I was closed" query, E-6; the host's own
 * passive timeout sweep, E-4, before it decides whether to synthesize a
 * failure).
 */
export async function peekGuideEffect(store: ThreadStore, threadId: ThreadId): Promise<DispatchedEffect | null> {
  const k = effectKeyFor(threadId);
  return ((await store.get(k))[k] as DispatchedEffect | undefined) ?? null;
}

/** Whether the panel document with this id is still open — asked of the browser. */
export type PanelOpen = (documentId: string) => Promise<boolean>;

/**
 * A panel asks to run the effect in flight (ticket 06c). Decided inside the
 * write chain, and written down with the effect before the answer goes back,
 * so the panel that is told yes is the one on record before it spends
 * anything (`judgeClaim` says who wins).
 */
export function claimGuideEffect(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  effectId: string,
  claimant: string,
  isOpen: PanelOpen,
): Promise<boolean> {
  return writes(threadId, async () => {
    const effect = await peekGuideEffect(deps.store, threadId);
    const holder = effect?.claimedBy;
    const holderOpen = holder !== undefined && holder !== claimant ? await isOpen(holder) : false;
    if (!judgeClaim(effect, effectId, claimant, holderOpen)) return false;
    await deps.store.set({ [effectKeyFor(threadId)]: { ...effect!, claimedBy: claimant } });
    return true;
  });
}

/**
 * The effect in flight, handed back to be dispatched again when nobody is
 * running it: no panel ever took it, or the one that did has closed (ticket
 * 06c). Its deadline starts again — a deadline is a promise about a call
 * someone is running — and its claim is cleared, so the next panel to ask
 * takes it. `null` when there is nothing in flight, or its panel is still open.
 *
 * Handing back a call that a panel is about to claim is harmless: the claim
 * is decided per effect, so a second dispatch of it is claimed once.
 */
export function unrunGuideEffect(deps: GuideEffectDeps, threadId: ThreadId, isOpen: PanelOpen): Promise<EffectRequest | null> {
  return writes(threadId, async () => {
    const effect = await peekGuideEffect(deps.store, threadId);
    if (!effect) return null;
    if (effect.claimedBy !== undefined && (await isOpen(effect.claimedBy))) return null;
    const { claimedBy: _gone, ...request } = effect;
    const again: EffectRequest = { ...request, deadline: deadlineFor(request.kind, deps.now()) };
    await deps.store.set({ [effectKeyFor(threadId)]: again });
    return again;
  });
}

/** Every thread with an effect in flight, read off the whole store at once. */
export function threadsWithEffects(everything: Record<string, unknown>): ThreadId[] {
  const prefix = effectKeyFor('' as ThreadId);
  return Object.keys(everything)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length) as ThreadId);
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

/**
 * The longest a tool the host runs itself may take before the thread stops
 * waiting for it. Above `wait_for`'s own cap and the read that follows it,
 * because a wait that is still running is not a wait that was lost.
 */
export const HOST_TOOL_TIMEOUT_MS = 45_000;

/**
 * The other half of E-4: the tool the *host* took on. Nothing on the wire
 * carries it, so nothing else can notice it never finished — and a turn left
 * pending ignores every reading after it, which reads as a guide that died
 * mid-step.
 *
 * What goes back is what actually happened: the page was not read
 * (`unreadable`), or the wait never finished (`met: null`) — never a result
 * that claims the tool ran and found nothing.
 */
async function sweepExpiredToolCall(deps: GuideEffectDeps, threadId: ThreadId): Promise<GuideReduction | null> {
  const key = toolKeyFor(threadId);
  const mark = (await deps.store.get(key))[key] as { effectId: string; deadline: number } | undefined;
  if (!mark || deps.now() < mark.deadline) return null;
  const thread = await loadGuideThread(deps.store, threadId);
  // A call on the wire is the effect sweep's, not this one's.
  const pending = thread?.inflight ? undefined : thread?.turn?.pending;
  if (!pending || pending.effectId !== mark.effectId) {
    await deps.store.remove(key);
    return null;
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(pending.call.args) as Record<string, unknown>;
  } catch {
    /* the model's own text; an unreadable one changes nothing below */
  }
  const result =
    pending.call.name === 'wait_for'
      ? ({
          kind: 'waited' as const,
          until: args.until === 'gone' ? ('gone' as const) : ('appears' as const),
          text: typeof args.text === 'string' ? args.text : '',
          seconds: typeof args.seconds === 'number' ? args.seconds : 0,
          met: null,
          table: null,
        })
      : ({ kind: 'unreadable' as const });
  return applyGuideInputInner(deps, threadId, { kind: 'tool_result', effectId: pending.effectId, result });
}

async function sweepExpiredGuideEffectInner(
  deps: GuideEffectDeps,
  threadId: ThreadId,
): Promise<GuideReduction | null> {
  const tool = await sweepExpiredToolCall(deps, threadId);
  if (tool) return tool;
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
 * A reading (CONTEXT.md `Reading`): one of the four observation sources saw
 * something in this thread's tab. The host reads the page right after —
 * `read`, `null` when it cannot — and the reducer writes both down.
 *
 * The read happens *inside* the write chain, as one unit with the reduction.
 * Readings arrive in bursts — one click on a link can bring all four — and
 * each is read separately; outside the chain, a slow read of the page being
 * left could land after a quick read of the page arrived at, and put the old
 * page back.
 *
 * Nothing is read when there is nothing to write it into: no guide in this
 * tab, or a reading about a step that is no longer the one on screen. Three
 * readings are about the step itself — the user used it, it was not painted,
 * it was looked for and not found — and each is matched against the
 * presentation it came from (`presentationId`): a report that outlived its
 * step, or one from a run already over, is dropped. `null` then.
 */
/**
 * The user said something while this tab had a guide going (08b): if a model
 * guide is going, it hears it, as a reading — a question on the way gets its
 * answer and the guide goes on; a change of what to do gets a step toward it.
 * `null` when there is nothing here to hear it — no guide, or a fixed plan,
 * which has no model — and nothing is read: the caller starts a new run.
 *
 * Decided inside the write chain, like every reading: a guide ending between
 * the check and the write would otherwise take the sentence with it.
 */
export function applySaid(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  text: string,
  read: () => Promise<PromptTable | null>,
): Promise<GuideReduction | null> {
  return writes(threadId, async () => {
    const prior = await loadGuideThread(deps.store, threadId);
    if (!prior || prior.planSource !== 'model' || prior.ending) return null;
    return applyGuideInputInner(deps, threadId, { kind: 'reading', reading: { kind: 'said', text }, table: await read() });
  });
}

const ABOUT_THE_STEP: ReadonlySet<Reading['kind']> = new Set(['used', 'not_shown', 'not_found', 'not_actionable']);

export function applyReading(
  deps: GuideEffectDeps,
  threadId: ThreadId,
  reading: Reading,
  read: () => Promise<PromptTable | null>,
  presentationId?: string,
): Promise<GuideReduction | null> {
  return writes(threadId, async () => {
    const prior = await loadGuideThread(deps.store, threadId);
    if (!prior) return null;
    if (ABOUT_THE_STEP.has(reading.kind) && presentationIdOf(threadId, prior) !== presentationId) return null;
    return applyGuideInputInner(deps, threadId, { kind: 'reading', reading, table: await read() });
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
  // A run that never pointed at a step was a question (CONTEXT.md `Question`),
  // however it ended: it leaves no Run record. The record is the journey's —
  // what S3 distills and what gets exported — and a question walked none.
  if (thread.history.length > 0) try {
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

