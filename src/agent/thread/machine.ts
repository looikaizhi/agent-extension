import { guideAgent } from '@/agent/agents/guide/agent';
import { moduleOf } from '@/agent/agents/guide/registry';
import { adviceFor } from '@/agent/provider/advice';
import type { EffectFailureKind } from './effect';
import type { MachineEffect, MachineInput, ThreadState } from './thread';
import { docResultOf } from '@/agent/tools/read-doc';
import {
  STEP_CALLS,
  askAgain,
  closeTurn,
  continueTurn,
  notify,
  openingOf,
  present,
  settleAnswer,
  stampAction,
  stepSpent,
  tryEmitCallModel,
  type StepOut,
} from './transitions';
import { sameView } from '@/shared/view';
import { tableOf } from '@/agent/context/turn';

/**
 * The pure reducer at the center of the guided flow (design doc §3; its
 * concurrency rules are §10's). `step` is the one entry point; the only other
 * export is a pure query over a thread — `stepOnScreen` — that decides
 * something without changing anything. The inputs it reads and
 * the effects it returns are typed in `thread.ts`, beside the state itself.
 *
 * N-2 (design doc §2.7): no `await`, no `fetch(`, no `chrome.`, here or in
 * anything this file loads. That is what lets a persisted `ThreadState` be
 * replayed deterministically in a plain node test, and what lets
 * `entrypoints/background.ts` trust that calling `step` twice with the same
 * `{state, input}` can never produce two different answers — there is nothing
 * it runs that could make it look at the clock, the network, or the platform.
 * `tests/unit/architecture.spec.ts` holds it to that; the assertion is
 * trivially satisfiable *because* nothing here ever needs those things — a
 * decision is not an execution.
 *
 * Single-writer: this file has no way to enforce "only `agent/thread/writer.ts`
 * calls `step`" from inside itself — a pure function cannot refuse a caller.
 * The enforcement lives in `tests/unit/architecture.spec.ts` (nothing but
 * `agent/thread/writer.ts` may call `step`, and nothing may re-export it)
 * precisely because
 * the danger this guards against (a second process — the side panel —
 * running the same reducer to "predict" a cursor move) is not a defect this
 * file's code could ever exhibit on its own; it is a defect in *who calls
 * it*, which only a cross-file guard can catch.
 */

/**
 * The step the screen should show for this thread right now, or `null` when
 * nothing on file is safe to paint.
 *
 * Asked when the screen lost the step while the run did not — a reload took the
 * content script with it, or a question's highlight took the overlay over. A
 * model-driven plan with a call in flight is exactly the case to refuse: the
 * table has already moved to the page the user is on, but the steps still
 * belong to the page they left, and painting one there is L-4 — a confident
 * pointer at the wrong element. The next plan is on its way and will present
 * itself.
 */
export function stepOnScreen(state: ThreadState): Extract<MachineEffect, { kind: 'present' }> | null {
  if (state.ending || !state.steps[state.cursor]) return null;
  if (state.inflight) return null;
  return present(state);
}

/**
 * `cross_site_decision` — the user's answer to P-2's card.
 *
 * Declining is not an error and not the end of the run: the guide simply stays
 * where it is with the step unshown, and spends nothing. Accepting presents
 * the step that was already loaded behind the card, and records where it leads
 * so the next breakpoint knows to run P-3 against the landing page.
 */
function handleCrossSiteDecision(
  state: ThreadState,
  input: Extract<MachineInput, { kind: 'cross_site_decision' }>,
): StepOut {
  const to = state.pendingCrossSite;
  if (!to) return { state, effects: [] }; // nothing was pending — a stale answer
  const cleared = { ...state, pendingCrossSite: undefined };
  // Declining is not an error, but it cannot be silent. The card disappears,
  // no step is painted, and nothing is said — from the user's side that is
  // indistinguishable from the extension breaking, which is exactly what one
  // live session read it as. The run does not end, on purpose: the next
  // page the user visits re-plans against it for free, so a change of mind
  // costs nothing.
  if (!input.confirmed)
    return {
      state: cleared,
      effects: [notify(`好，没有带你去 ${to}。这条路的下一步就在那边，所以到这里先停下——换个目标再说一次，我重新看这一页。`)],
    };
  return { state: { ...cleared, crossedTo: to }, effects: [present(cleared)] };
}

function handleStart(input: Extract<MachineInput, { kind: 'start' }>, nextRev: number): StepOut {
  const fresh: ThreadState = {
    rev: 0, // the `step` wrapper overwrites this with `nextRev`
    goal: input.goal,
    table: input.table,
    route: [],
    steps: [],
    cursor: 0,
    history: [],
    // Nothing has been pointed at yet: the model's first answer is given on
    // the page the run starts on.
    pointedOn: input.table,
    // §5.7: where a model-planned run starts on both axes (thread.ts's doc
    // comments on these two fields say what the other values mean).
    evidence: 'model',
    check: 'unknown',
    callCount: 0,
    stepCalls: 0,
    spentSteps: 0,
    // Seeded with the screen this run starts on, so the opening call is the
    // only one spent on it.
    inflight: null,
  };
  return tryEmitCallModel(fresh, input.effectId, nextRev);
}

/**
 * One sentence per failure kind, shared by both routes to the same verdict:
 * the panel's `ok:false` (all the host gets when the envelope was refused
 * over there) and this reducer's own re-derivation below. Two wordings for
 * one condition is a divergence no test would catch, so there is one table.
 */
const FAILURE_TEXT: Record<EffectFailureKind, (detail: string) => string> = {
  // The endpoint's own words first, then — only when they name something the
  // user can act on — one sentence saying what that is. A guide that dies
  // against the thinking-mode wall says the same thing the settings page
  // says about the same wall, from the same module, because two wordings for
  // one condition is a divergence no test would catch.
  transport: (d) => `调用失败：${d}${adviceFor(d) ? `\n${adviceFor(d)}` : ''}`,
  parse: (d) => `模型输出无法解析：${d}`,
  violation: (d) => `模型输出不合法：${d}`,
};

/**
 * `effect_result` — the one branch that has to interpret a raw model or
 * fetch response. E-2 (idempotent discard) and E-3 (a reading landed while
 * the call was out: discard and ask again) run *before* anything in the
 * payload is trusted; only a result that survives both is handed to
 * `guideAgent.parseOutput`/`.validate`. E-3 lets one kind through a changed
 * world: a `done` on an unchanged address (below).
 */
function handleEffectResult(
  state: ThreadState,
  input: Extract<MachineInput, { kind: 'effect_result' }>,
  nextRev: number,
): StepOut {
  // E-2: not the effect we are waiting for (stale duplicate, or nothing was
  // ever inflight) — ignored outright, not even an error.
  if (!state.inflight || state.inflight.effectId !== input.effectId) {
    return { state, effects: [] };
  }

  // What the run cost counts every request, repair rounds included: the
  // repair happens *inside* the effect, where the host cannot see it, so the
  // panel reports what it actually spent, and this adds whatever exceeded the
  // one already counted at dispatch. Applied before E-3, not after: a result
  // discarded for arriving in the wrong world was still paid for.
  const inflight = state.inflight;
  // A document the model asked to read, not an answer from the model.
  if (inflight.kind === 'fetchDoc') return handleDocFetched(state, input, nextRev);

  const unbilled = Math.max(0, input.outcome.providerCalls - 1);
  const cleared: ThreadState = { ...state, inflight: null, callCount: state.callCount + unbilled, transportFails: 0 };
  // Every way this result can end the step's conversation without an answer —
  // refused, unreadable, someone else's answer — ends it here, and on the
  // step's last call ends the step too (`closeTurn`). Only a tool call carries
  // it on, and only a wake opens a new one.
  const closed: ThreadState = closeTurn(cleared);

  // The one answer a changed world cannot have invalidated: a `done` names no
  // control, so a page that re-rendered under it — same address, new snapshot
  // — has taken back nothing it said. Discarding it anyway was the commonest
  // way a guide walked off a page it had arrived on: over two live runs this
  // check threw away 22–23% of all model calls, 26 of them a `done` on an
  // unchanged address, and asking again turned six journeys back into
  // `guide`. Only a different view can make a `done` wrong.
  const stillHere = input.outcome.ok && input.outcome.tool === 'done' && sameView(input.at.url, state.table.url);

  // E-3: a reading landed while this call was out, so whatever it says —
  // an answer, a tool call, a failure — was computed for a world that has
  // since changed. Dropped unread, and the model asked again with what
  // happened; this does not wait for anything else to arrive.
  if (state.readings?.length && !stillHere) return askAgain(cleared, input.nextEffectId, nextRev);

  if (!input.outcome.ok) {
    // Three different things, three different sentences. The panel runs the
    // same `parseOutput`/`validate` this reducer does, and on a refusal it
    // returns `ok:false` — so the model's text never reaches here and the
    // verdict cannot be re-derived (design doc §8.3 gives the host the last
    // word, but only over text it actually receives). Saying 「调用失败」 to
    // a user whose plan was refused for naming a password field was wrong
    // twice over: the call succeeded, and the reason was worth telling.
    // A transport failure is not the model failing to answer — it is the trip
    // failing: nothing came back to judge. The first one on this step is taken
    // again rather than stopping the run, because a hiccup that ends a journey
    // is a journey the user has to retype from the beginning.
    const trip = input.outcome.failureKind === 'transport' && input.outcome.retryable;
    // Only while this step still has a call to spend: asking again with an
    // empty budget lands on 「这一步我已经想了 4 次」, which swallows the one
    // thing the user needed to hear — that the trip never went through.
    if (trip && !state.transportFails && cleared.stepCalls < STEP_CALLS)
      return askAgain({ ...cleared, transportFails: 1 }, input.nextEffectId, nextRev);
    // Twice in a row is not a hiccup. The user is told, and offered the one
    // thing that costs them nothing to try: the same call again.
    return {
      state: closed,
      effects: [notify(FAILURE_TEXT[input.outcome.failureKind](input.outcome.error), trip || undefined, input.outcome.fix)],
    };
  }

  // Re-derived here, not trusted from the panel (§8.3, "判定权在 Host"). The
  // intent is the function the model called, not a field in the text, so the
  // host has to be told which one — `value` is the arguments and cannot say.
  // A `callModel` result without it is a `fetchDoc` result or a bug, and
  // either way there is no envelope to recover.
  // The wire leaves `value` as `unknown`. The panel sends the model's raw
  // text; anything else is a result nobody can parse, and is reported as one.
  if (typeof input.outcome.value !== 'string') {
    return { state: closed, effects: [notify(FAILURE_TEXT.parse('结果不是文字'))] };
  }
  const value = input.outcome.value;
  const parsed = input.outcome.tool
    ? guideAgent.parseOutput(input.outcome.tool, value)
    : ({ kind: 'error', message: '结果里没有工具名，无法判断这是哪一种信封' } as const);
  if (parsed.kind === 'error') {
    return { state: closed, effects: [notify(FAILURE_TEXT.parse(parsed.message))] };
  }
  const validated = guideAgent.validate(parsed.envelope, state.table);
  if (validated.kind === 'violation') {
    return { state: closed, effects: [notify(FAILURE_TEXT.violation(validated.reason))] };
  }


  // What an answer does to the thread belongs to the intent that answered —
  // its module's `consequence`. The reducer only routes it there.
  const envelope = validated.envelope;
  const m = moduleOf(envelope);
  // The call as the model made it, for a tool that replays it with its result.
  // An endpoint that gave no id still gets a round the model can pair: the
  // effect id is unique, and made here rather than in the panel it is the same
  // on every replay of this input.
  const call = {
    id: input.outcome.callId ?? `call_${input.effectId}`,
    name: envelope.intent,
    args: value,
    // Carried, never read here: only the adapter that issued it knows what is
    // in it, and the next request has to hand it back beside this call.
    ...(input.outcome.reasoning ? { reasoning: input.outcome.reasoning } : {}),
  };
  const ids = { nextEffectId: input.nextEffectId, nextRev, call };
  if (m.kind === 'tool') {
    // The step's last call offered only answers. An endpoint that answered
    // with a tool anyway does not get it run: the step is out of calls.
    if (cleared.stepCalls >= STEP_CALLS) return stepSpent(cleared);
    return m.consequence(cleared, envelope, ids);
  }
  // An answer. It settles the step it comes after (`settleAnswer`) first, so
  // what the answer does next — the loop backstop reads it — sees it settled;
  // unless it is one that moves nothing (`explain`), which leaves the step on
  // screen as it is — the user has not acted on it — and only ends the
  // thinking: the step's calls start over, and one more step is taken from
  // the run, so a model that keeps explaining still runs out.
  const answered = m.leavesStepOnScreen
    ? { state: { ...cleared, turn: undefined, stepCalls: 0, spentSteps: cleared.spentSteps + 1 } }
    : settleAnswer({ ...cleared, turn: undefined });
  if ('stop' in answered && answered.stop) return answered.stop;
  // §5.7's first axis, for what this answer puts on screen: read off the
  // conversation it came out of, which is gone once the answer lands. A
  // document the model read in it is what the answer stands on; a fetch that
  // brought nothing back, or a conversation voided by a reading, is not.
  const readADoc = cleared.turn?.rounds.some((r) => r.result.kind === 'doc') ?? false;
  const based: ThreadState = { ...answered.state, evidence: readADoc ? 'documented' : 'model' };
  const out = m.consequence(based, envelope, ids);
  // CONTEXT.md `Question`: a run that has pointed at nothing when an answer
  // lands was a question, whatever was typed — decided by what it did, never
  // at the door. It is over, and leaves nothing behind (`writer.ts`).
  const question = out.state.history.length === 0 && out.state.ending === undefined;
  return { ...out, state: { ...out.state, turn: undefined, ...(question ? { ending: 'answered' as const } : {}) } };
}

/**
 * A document the model asked to read (`read_doc`) came back from the panel —
 * or failed, or was swept as expired. Either way it goes back to the model as
 * the result of its call (`docResultOf` says what it becomes), and the turn
 * goes on.
 *
 * Unless a reading landed while it was fetched: then the conversation it
 * belongs to was about a page that has since changed — its refs may name other
 * controls now — and the model is asked afresh (`askAgain`), the same as a
 * model answer that arrives in a changed world.
 */
function handleDocFetched(state: ThreadState, input: Extract<MachineInput, { kind: 'effect_result' }>, nextRev: number): StepOut {
  const cleared: ThreadState = { ...state, inflight: null };
  if (state.readings?.length) return askAgain(cleared, input.nextEffectId, nextRev);
  const turn = cleared.turn;
  if (!turn?.pending || turn.pending.effectId !== input.effectId) return { state: cleared, effects: [] };
  const round = { call: turn.pending.call, result: docResultOf(input.outcome) };
  return continueTurn({ ...cleared, turn: openingOf(turn, [...turn.rounds, round]) }, input.nextEffectId, nextRev);
}

/**
 * `tool_result` — the host carried out a tool the model called (`observe`,
 * `wait_for`). The result goes back to the model as the result of its call,
 * and the turn goes on.
 *
 * Matched to the call by id, and only while that call is still pending: a
 * result that belongs to a turn no longer open must not be spliced into a
 * conversation that never asked for it. And not taken at all when a reading
 * landed while the tool ran: the turn is void, and the model is asked afresh
 * (`askAgain`).
 *
 * The page a result brings is the page last read, and the one the answer is
 * then checked against. Nothing about the result is written down: a wait that
 * ran out is what the model hears, not a fact about the step on screen
 * (CONTEXT.md `Reading`), and what the step did is settled when the model
 * answers (`settleAnswer`).
 */
function handleToolResult(state: ThreadState, input: Extract<MachineInput, { kind: 'tool_result' }>, nextRev: number): StepOut {
  const turn = state.turn;
  if (!turn?.pending || turn.pending.effectId !== input.effectId) return { state, effects: [] };
  if (state.readings?.length) return askAgain(state, input.nextEffectId, nextRev);
  const table = tableOf(input.result);
  const round = { call: turn.pending.call, result: input.result };
  const next = { ...state, ...(table ? { table } : {}), turn: openingOf(turn, [...turn.rounds, round]) };
  return continueTurn(next, input.nextEffectId, nextRev);
}

/**
 * `reading` — an observation source saw something (CONTEXT.md `Reading`),
 * and the host read the page right after.
 *
 * Written down and nothing more: the page read becomes the page last read,
 * and a `used` records that the user did the step on screen — the one fact a
 * reading proves by itself. What the step *did* is not decided here; the page
 * a click has just started to change is the page it is leaving, and settling
 * it now is how a page finishing its own load came to be written down as the
 * click's doing (symptom 1). The model settles that when it answers next.
 *
 * Then the model hears it. If nothing is being asked, it is woken now, with
 * the page as just read — no window, no second look: whether the page has
 * finished arriving is the model's to judge, with `wait_for` and `observe`.
 * If it is being asked — a call out, a tool running — this is held until the
 * answer is back, and that answer is then dropped (`askAgain`): one call at a
 * time, however many readings arrive.
 *
 * Except what the user says. A change on the page may leave the answer on its
 * way standing (a `done` on the same view is kept); the user's own words never
 * do — that answer was for a goal they have since added to. So nothing waits
 * for it: what is out is called off, and the model is asked again now.
 */
function handleReading(state: ThreadState, input: Extract<MachineInput, { kind: 'reading' }>, nextRev: number): StepOut {
  const read: ThreadState = {
    ...state,
    ...(input.table ? { table: input.table } : {}),
    ...(input.reading.kind === 'used' ? { history: stampAction(state.history, 'taken') } : {}),
    readings: [...(state.readings ?? []), input.reading],
  };
  if (input.reading.kind === 'said' && (state.inflight || state.turn?.pending)) {
    const again = askAgain({ ...read, inflight: null }, input.nextEffectId, nextRev);
    const out = state.inflight ? [{ kind: 'cancel' as const, effectId: state.inflight.effectId }] : [];
    return { ...again, effects: [...out, ...again.effects] };
  }
  if (state.inflight || state.turn?.pending) return { state: read, effects: [] };
  return tryEmitCallModel(read, input.nextEffectId, nextRev);
}

function dispatch(state: ThreadState | null, input: MachineInput, nextRev: number): StepOut {
  // `start` is the one input that may replace a finished thread — that is the
  // user asking for something else, or asking again.
  if (input.kind === 'start') return handleStart(input, nextRev);
  if (!state) throw new Error(`machine.ts: no thread to apply a "${input.kind}" input to`);

  // A finished thread accepts nothing. Without this, an ending was a label
  // rather than a state: a thread out of quota still re-planned on the next
  // page change, and `done` could not become terminal at all — the page moves
  // once more and the guide starts pointing again. Every terminal is reached
  // deliberately (arrived, out of quota, stopped for safety); none of them
  // wants one more step.
  if (state.ending) return { state, effects: [] };

  switch (input.kind) {
    case 'effect_result':
      return handleEffectResult(state, input, nextRev);
    // Nothing is in flight — the call that failed cleared it — so this is the
    // ordinary 「ask again」 with everything the run already knows.
    case 'retry':
      return state.inflight ? { state, effects: [] } : askAgain(state, input.nextEffectId, nextRev);
    case 'reading':
      return handleReading(state, input, nextRev);
    case 'cross_site_decision':
      return handleCrossSiteDecision(state, input);
    case 'tool_result':
      return handleToolResult(state, input, nextRev);
  }
}

/**
 * The single entry point. `state === null`
 * means "no thread yet" and is only ever valid alongside `input.kind ===
 * 'start'` — every other input requires a caller that already has a
 * `ThreadState` to hand back in (from `decodeThread`, or from this
 * function's own previous return).
 *
 * `rev` is entirely this wrapper's concern: every call increments it by
 * exactly one relative to the incoming state, unconditionally — including
 * calls that end up changing nothing else (slice 2's inflight-blocked
 * rejection still returns `rev + 1`). Handlers below never touch `rev`
 * themselves; only `nextRev`, computed once here and threaded down, so a
 * newly-dispatched effect's `inflight.at.threadRev` always matches the state
 * it is about to be persisted alongside.
 */
export function step(state: ThreadState | null, input: MachineInput): { state: ThreadState; effects: MachineEffect[] } {
  const nextRev = (state?.rev ?? 0) + 1;
  const result = dispatch(state, input, nextRev);
  return { state: { ...result.state, rev: nextRev }, effects: result.effects };
}
