import { guideAgent } from '@/agent/agents/guide/agent';
import { moduleOf } from '@/agent/agents/guide/registry';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';
import type { Ref } from '@/shared/types';
import type { EffectFailureKind } from './effect';
import type { MachineEffect, MachineInput, ThreadState } from './thread';
import {
  notify,
  present,
  stamp,
  stepForward,
  recordMove,
  tryEmitCallModel,
  type StepOut,
} from './transitions';
import { samePlace } from './place';
import { fixedPlan } from './fixed-plan';

/**
 * The pure reducer at the center of the guided flow (design doc §3; its
 * concurrency rules are §10's). `step` is the one entry point; the only other
 * exports are two pure queries over a thread — `pageMoved` and `stepOnScreen`
 * — that decide something without changing anything. The inputs it reads and
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

const UNRESOLVED_MESSAGE = '找不到这一步的目标，页面可能已经变化。';

/** Every control the model was shown last time, in the order it was shown
 *  them. `ref` is deliberately absent: refs are minted per snapshot
 *  (CONTEXT.md, "跨快照无意义"), so including them would make every
 *  re-extraction look like a change. */
const controlsOf = (t: PromptTable) => t.items.map((i) => `${i.path.join('>')}|${i.role}|${i.name}`).join('\n');

/**
 * D4's "页面确实变了", as one predicate both the reducer and
 * `agent/thread/writer.ts`'s pre-`step` guard read — the two used to compare `pageHash` each on their own
 * line, and a rule written twice is a rule that drifts.
 *
 * Two signals, either one sufficient:
 *
 * - **`pageHash`** — route plus landmark/heading structure
 *   (`core/extractor/fingerprint.ts`). Catches real navigations, which is what
 *   carries a multi-page journey forward.
 * - **The control list** — catches what `pageHash` is deliberately blind to. A
 *   menu, dropdown or dialog opening adds no landmark and no heading, so the
 *   fingerprint does not move, yet the page now offers a completely different
 *   set of things to do and the step on screen has already been done. That
 *   blindness is correct for the *watcher* (a hash reacting to every
 *   async-loaded button would invalidate the guide constantly) and wrong for
 *   *this* judgement, which is only ever reached after something already
 *   claimed the page moved.
 *
 * Both readings of "changed" are structural — no timers, no heuristics about
 * how much changed. A page that swapped one control for another moved; a page
 * that repainted the same controls did not.
 */
export function pageMoved(prev: PromptTable, next: PromptTable): boolean {
  return next.pageHash !== prev.pageHash || controlsOf(next) !== controlsOf(prev);
}

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
 * itself. A fixed plan carries descriptors only, so it can always be painted
 * against wherever the user is.
 */
export function stepOnScreen(state: ThreadState): Extract<MachineEffect, { kind: 'present' }> | null {
  if (state.ending || !state.steps[state.cursor]) return null;
  if (state.planSource === 'model' && state.inflight) return null;
  return present(state, state.cursor);
}

/**
 * `step_settle_timeout` — the user activated the step and the page did not
 * move (`replan.ts` looked several times before saying so).
 *
 * "Did not move" is not "did not work". Clicking a search button opens a
 * dialog; opening a menu expands it; both leave `pageMoved` false because the
 * route is unchanged and — for a dialog — extraction scopes into it, so the
 * control list is compared against a table describing somewhere else. The
 * user did exactly what was asked. What is missing is the rest of the plan.
 *
 * So the first question is whether this plan has a rest. The model writes
 * `e6 click` then `e6 input value:"n8n"` — click the search open, then type
 * into it — reusing the same ref because the dialog's textbox is not in the
 * table yet (`CHOICE_GUIDE` now asks for exactly this shape). Before this
 * branch existed `cursor` never advanced anywhere in the codebase, so that
 * second step was planned and then discarded, and four of seven live journeys
 * ended right here reading 「这一步看起来没有反应」 while the thing to do next
 * sat unused in `steps[1]`.
 *
 * Advancing costs no quota — the step is already planned and already
 * validated against the table it was drawn from. Only when the plan really is
 * exhausted does the old message stand: then there is nothing left to offer,
 * and a control that did not respond is a step to retry or skip, not a reason
 * to stop guiding.
 *
 * `stamp` keeps its first-come-wins rule, so a step whose fate is already
 * recorded is never rewritten — the page moving and the window closing can
 * both arrive for the same step, and the one that arrived first is the one
 * that actually happened.
 */
function handleStepSettleTimeout(state: ThreadState, effectId: string, nextRev: number): StepOut {
  const last = state.history[state.history.length - 1];
  // Also the gate that keeps the replan below from ever looping: it stamps
  // `failed`, and a step whose fate is recorded never reaches here twice.
  if (!last || last.outcome !== 'unknown') return { state, effects: [] };

  // A fixed plan decides this for itself (`fixed-plan.ts`), and before
  // anything below: the replan further down is for a guide that has a model
  // to ask, and a fixed plan has none.
  if (state.planSource === 'fixed') return fixedPlan.onSettleTimeout(state);

  if (state.cursor + 1 < state.steps.length) {
    // `confirmed` is not ours to write — `handlePageChanged`'s doc comment
    // reserves it for the one place that has proven the page moved, and
    // nothing here has proven that. What is known is narrower and is what
    // gets recorded: the user acted on this step, and the guide moved on.
    return stepForward(state);
  }

  // The plan is spent and the control did not respond. Before settling for
  // "try again or skip it", spend the one thing that can still help: another
  // look at this page.
  //
  // Without this, a thread in exactly this position can never call the model
  // again. The only three dispatch sites are `start`, E-3, and
  // `page_changed` — and `page_changed` requires the page to move, which is
  // precisely what just failed to happen. Two of 21 live journeys died in that
  // closed loop, both because the model answered a `combobox` with a lone
  // `click`: clicking a text field cannot move a page, so nothing ever woke
  // the thread again. The step's own `why` said 「在搜索框输入 n8n-io/n8n」 in
  // both — the plan it described was fine, the plan it emitted was one step
  // short.
  const stalled: ThreadState = { ...state, history: stamp(state.history, 'failed') };
  const out = tryEmitCallModel(stalled, effectId, nextRev);
  // The screen still shows the same page and the same highlight, so without
  // this the user has no way to tell a slow page from a dead control. Which
  // sentence they get is decided by what actually went out, never by what we
  // hoped would: a tombstone or an exhausted quota means nothing is coming,
  // and promising a fresh look would be a lie the next silence exposes.
  const looking = out.effects.some((e) => e.kind === 'callModel');
  const said = looking
    ? `「${last.title}」这一步看起来没有反应，我再看看这一页。`
    : `「${last.title}」这一步看起来没有反应，可以再试一次，或者跳过它。`;
  return { state: out.state, effects: [notify(said), ...out.effects] };
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
  return { state: { ...cleared, crossedTo: to }, effects: [present(cleared, 0)] };
}

/**
 * Which refs were not on this page a moment ago.
 *
 * Same `Place` only. After a navigation every control is new and marking all
 * of them says nothing; the mark is for the other case — a click that opened a
 * menu or expanded a panel, where the reader gets the same few hundred rows
 * back with no clue which dozen just appeared. Measured live, one journey
 * clicked the same button five times while the control it wanted sat inside
 * the panel that button had opened.
 *
 * Compared by identity, not by `ref`: a `Ref` is meaningless across snapshots
 * (`CONTEXT.md`). What comes out is refs from the *new* table, which is the
 * one they will travel with.
 */
function freshRefsBetween(prev: PromptTable, next: PromptTable): readonly Ref[] {
  if (!samePlace(prev.url, next.url)) return [];
  const key = (i: PromptItem) => `${i.path.join('›')}|${i.role}|${i.name}`;
  const before = new Set(prev.items.map(key));
  return next.items.filter((i) => !before.has(key(i))).map((i) => i.ref);
}

function handleStart(input: Extract<MachineInput, { kind: 'start' }>, nextRev: number): StepOut {
  const fresh: ThreadState = {
    rev: 0, // the `step` wrapper overwrites this with `nextRev`
    goal: input.goal,
    table: input.table,
    route: [],
    steps: [],
    cursor: 0,
    outcomes: [],
    history: [],
    planSource: 'model',
    // §5.7: where a model-planned run starts on both axes (thread.ts's doc
    // comments on these two fields say what the other values mean).
    evidence: 'model',
    check: 'unknown',
    callCount: 0,
    docFetchCount: 0,
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
  transport: (d) => `调用失败：${d}`,
  parse: (d) => `模型输出无法解析：${d}`,
  violation: (d) => `模型输出不合法：${d}`,
};

/**
 * `effect_result` — the one branch that has to interpret a raw model or
 * fetch response. E-2 (idempotent discard) and E-3 (world-mismatch discard +
 * auto-replan) run *before* anything in the payload is trusted; only a
 * result that survives both is handed to `guideAgent.parseOutput`/`.validate`.
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

  // §5.9 says a repair call counts against the same 12-call cap as the call
  // it repairs. It never did: `tryEmitCallModel` charges exactly 1 when it
  // dispatches, while the repair round happens *inside* the effect, where the
  // host cannot see it — so 12 dispatched effects could spend up to 24 real
  // requests and `callCount` would still read 12. The panel now reports what
  // it actually spent, and this adds whatever exceeded the one already
  // charged. Applied before E-3, not after: a result discarded for arriving
  // in the wrong world was still paid for.
  const unbilled = Math.max(0, input.outcome.providerCalls - 1);
  const cleared: ThreadState = { ...state, inflight: null, callCount: state.callCount + unbilled };

  const worldMatches =
    input.at.threadRev === state.inflight.at.threadRev &&
    input.at.snapshotId === state.table.snapshotId &&
    input.at.pageHash === state.table.pageHash &&
    input.at.url === state.table.url;

  if (!worldMatches) {
    // E-3: discard the result outright and replan unconditionally — the
    // Gotchas are explicit that this does not wait for a new user input.
    // `state.table` already reflects whatever changed (only `page_changed`
    // moves it, and that input carries the fresh table with it), so the
    // replan needs nothing from this stale result beyond triggering it.
    return tryEmitCallModel(cleared, input.nextEffectId, nextRev);
  }

  if (!input.outcome.ok) {
    // Three different things, three different sentences. The panel runs the
    // same `parseOutput`/`validate` this reducer does, and on a refusal it
    // returns `ok:false` — so the model's text never reaches here and the
    // verdict cannot be re-derived (design doc §8.3 gives the host the last
    // word, but only over text it actually receives). Saying 「调用失败」 to
    // a user whose plan was refused for naming a password field was wrong
    // twice over: the call succeeded, and the reason was worth telling.
    return { state: cleared, effects: [notify(FAILURE_TEXT[input.outcome.failureKind](input.outcome.error))] };
  }

  // Re-derived here, not trusted from the panel (§8.3, "判定权在 Host"). The
  // intent is the function the model called, not a field in the text, so the
  // host has to be told which one — `value` is the arguments and cannot say.
  // A `callModel` result without it is a `fetchDoc` result or a bug, and
  // either way there is no envelope to recover.
  // The wire leaves `value` as `unknown`. The panel sends the model's raw
  // text; anything else is a result nobody can parse, and is reported as one.
  if (typeof input.outcome.value !== 'string') {
    return { state: cleared, effects: [notify(FAILURE_TEXT.parse('结果不是文字'))] };
  }
  const value = input.outcome.value;
  const parsed = input.outcome.tool
    ? guideAgent.parseOutput(input.outcome.tool, value)
    : ({ kind: 'error', message: '结果里没有工具名，无法判断这是哪一种信封' } as const);
  if (parsed.kind === 'error') {
    return { state: cleared, effects: [notify(FAILURE_TEXT.parse(parsed.message))] };
  }
  if (parsed.kind === 'foreign') {
    // explain/need_text: those are the question agent's answers (CONTEXT.md
    // `Question`), which never go through a Thread. Not malformed, and not
    // this reducer's to act on — reported as what came back, and the run
    // stays recoverable — it does not end.
    return { state: cleared, effects: [notify(`模型返回了非引导类信封（intent: ${parsed.intent}）`)] };
  }
  const validated = guideAgent.validate(parsed.envelope, state.table);
  if (validated.kind === 'violation') {
    return { state: cleared, effects: [notify(FAILURE_TEXT.violation(validated.reason))] };
  }


  // What an answer does to the thread belongs to the intent that answered —
  // its module's `consequence`. The reducer only routes it there.
  const envelope = validated.envelope;
  return moduleOf(envelope).consequence(cleared, envelope, { nextEffectId: input.nextEffectId, nextRev });
}

/**
 * `bind_result` — CL-2's other half (`judgeFirstStepBind` in
 * `agent/thread/judge.ts` is the pure judgement over a *table-only*
 * `BindResult`; this is the live-DOM report the renderer produces when it
 * actually tries to paint `steps[cursor]`, which is the only place an
 * `ambiguous` *Binding* can come from — see `thread.ts`'s doc comment on
 * `Binding`). Deliberately not routed through `judgeFirstStepBind`: that
 * function's input type carries `ref`/`item`/`refs`/`items` fields a
 * `Binding` value has no data for, so bridging the two would mean
 * fabricating fields nobody has rather than reusing real logic — the
 * `'ambiguous'` check both would run is one line long on either side of that
 * bridge.
 */
function handleBindResult(state: ThreadState, input: Extract<MachineInput, { kind: 'bind_result' }>): StepOut {
  if (input.binding === 'bound') return { state, effects: [] };

  if (state.cursor === 0 && input.binding === 'ambiguous') {
    // CL-2: escalate, do not advance, do not spend another callModel.
    return { state: { ...state, clarify: 'CL-2' }, effects: [] };
  }

  // `unbound`, and `ambiguous` anywhere but the fresh first step: S1's
  // existing "未能定位" path (not CL-2 — Gotchas are explicit that CL-2 is
  // scoped to the first step of a freshly-produced `steps` array only).
  const outcomes = state.outcomes.slice();
  outcomes[state.cursor] = 'invalidated';
  return {
    state: { ...state, outcomes, history: stamp(state.history, 'invalidated') },
    effects: [notify(UNRESOLVED_MESSAGE)],
  };
}

/**
 * `page_changed` — §5.3's re-planning trigger. The caller (`background.ts`)
 * always hands over a freshly extracted table; this function's entire job is
 * deciding whether that table's `pageHash` actually differs from what the
 * current `steps` were planned against (slice 10 guards the "no, nothing
 * really changed" case at this layer rather than trusting the caller never
 * to over-report).
 */
function handlePageChanged(state: ThreadState, input: Extract<MachineInput, { kind: 'page_changed' }>, nextRev: number): StepOut {
  if (!pageMoved(state.table, input.table)) return { state, effects: [] };

  // P-3: the user just agreed to leave their site, and the page they landed on
  // wants credentials. Stop, and say only what we actually observed.
  //
  // Scoped to the hop right after a *confirmed* cross-site jump, and spent
  // after one check: "this page asks for your password" is unremarkable on a
  // site the user chose, and worth stopping for on one they were just taken
  // to. Checking everywhere would train them to dismiss it.
  if (state.crossedTo && input.table.items.some((i) => i.sensitive)) {
    return {
      state: {
        ...state,
        table: input.table,
        crossedTo: undefined,
        history: stamp(state.history, 'invalidated'),
        ending: 'credentials_stop',
      },
      // Deliberately not "this site is unsafe" — we are not a security product
      // and cannot substantiate that (§8.4's closing note on our limits). We
      // describe what we saw and what we did about it.
      effects: [
        notify(
          `这一步把你带到了 ${state.crossedTo}，而那一页要求输入账号信息。为安全起见，引导已经停下。`,
        ),
      ],
    };
  }
  // A fixed plan does not re-plan: it advances or repaints (`fixed-plan.ts`).
  if (state.planSource === 'fixed') return fixedPlan.onPageMoved(state, input.table);
  // Reaching here *is* the evidence that the step being left moved the page.
  const moved = recordMove(state, input.table);

  // A call is already out against the page the user has just left. Record the
  // move and spend nothing: E-3 discards that result when it lands, because
  // the world no longer matches, and replans against this table instead.
  //
  // Recording it is the whole point, and this branch used to return `state`
  // untouched. E-3's world check compares the dispatched `at` against
  // `state.table` — so a table that never moved made a result computed for the
  // *previous* page look perfectly current. E-3 stayed silent, the stale
  // envelope was accepted, and a step belonging to a page the user had already
  // left was painted on screen: L-4, this product's only hard zero. Measured
  // on github.com over 15 live journeys, 13 of them stalled on exactly this —
  // the guide re-proposed the search box on the search *results* page, could
  // not bind it, and stopped.
  if (state.inflight) return { state: moved, effects: [] };

  return tryEmitCallModel(moved, input.effectId, nextRev, freshRefsBetween(state.table, input.table));
}

/**
 * `step_skipped` — the user pressed 跳过 on the step on screen. A fixed plan
 * moves to its next step (`fixed-plan.ts`).
 *
 * A model-driven guide has no answer yet. Re-planning would hand back the very
 * step the user just declined, and nothing here can record "don't offer this
 * again"; so the guide stays where it is. What the button should say about
 * that is still an open question, and it is not this reducer's to invent.
 */
function handleStepSkipped(state: ThreadState): StepOut {
  if (state.planSource === 'fixed') return fixedPlan.onSkipped(state);
  return { state, effects: [] };
}

/**
 * `step_used` — the user activated the target of the step on screen. A fixed
 * plan records it and waits for the page to answer (`fixed-plan.ts`).
 *
 * A model-driven guide ignores it: its breakpoints re-plan whatever caused
 * them, so knowing who caused one changes nothing.
 */
function handleStepUsed(state: ThreadState, at: string): StepOut {
  if (state.planSource === 'fixed') return fixedPlan.onUsed(state, at);
  return { state, effects: [] };
}

function dispatch(state: ThreadState | null, input: MachineInput, nextRev: number): StepOut {
  // `start` is the one input that may replace a finished thread — that is the
  // user asking for something else, or asking again.
  if (input.kind === 'start') return handleStart(input, nextRev);
  if (input.kind === 'start_fixed') return fixedPlan.start(input);
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
    case 'step_settle_timeout':
      return handleStepSettleTimeout(state, input.effectId, nextRev);
    case 'step_skipped':
      return handleStepSkipped(state);
    case 'step_used':
      return handleStepUsed(state, input.at);
    case 'cross_site_decision':
      return handleCrossSiteDecision(state, input);
    case 'bind_result':
      return handleBindResult(state, input);
    case 'page_changed':
      return handlePageChanged(state, input, nextRev);
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
