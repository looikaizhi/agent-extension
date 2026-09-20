import type { PageSince } from '@/agent/context/turn';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import type { GuideHistoryEntry, InflightEffect, MachineEffect, StepAction, StepEffect, ThreadState, Turn, WorldAt } from './thread';
import { judgeArrival } from '@/agent/thread/judge';
import { sameView } from '@/shared/view';

/**
 * The pieces every reducer branch builds its answer from: put a step on
 * screen, settle what happened to the one being left, tell the user something,
 * ask the model — afresh or again — and the two gates every model call and doc
 * fetch has to pass — the in-flight tombstone, then the quota.
 *
 * Kept apart from `machine.ts` so that anything deciding a consequence uses
 * these same pieces rather than a copy: a gate written twice is a gate that
 * drifts.
 *
 * Pure, like the reducer that loads it (N-2). The guard, and why it follows
 * imports instead of a file name, are in `tests/unit/architecture.spec.ts`.
 */

/**
 * The two budgets (ticket 09). A step — from one answer to the next — may ask
 * the model `STEP_CALLS` times, and the last of them offers only answers; a
 * run may take `RUN_STEPS` steps. Neither counts what a call cost: repair
 * rounds and documents fetched are inside the calls they belong to.
 *
 * Twelve calls a run was the old limit, and with a tool loop it ran out on the
 * third step — one live run ended as out of quota with nothing on screen. A
 * step that thinks too long now has to answer, and only a run that walks too
 * far ends.
 */
export const STEP_CALLS = 4;
export const RUN_STEPS = 12;

const STEP_SPENT_MESSAGE = `这一步我已经想了 ${STEP_CALLS} 次，还没有结论，先停在这里。页面有变化我会再看；你也可以换个说法，再说一次目标。`;

/** Every control on a page, in the order it was read. `ref` is deliberately
 *  absent: refs are minted per snapshot (CONTEXT.md, "跨快照无意义"), so
 *  including them would make every re-extraction look like a change. */
const controlsOf = (t: PromptTable) => t.items.map((i) => `${i.path.join('>')}|${i.role}|${i.name}`).join('\n');

/**
 * How the page in `next` relates to the one `prev` was taken from — D4's
 * "页面确实变了".
 *
 * Two questions, kept apart on purpose:
 *
 * - **Which page** — CONTEXT.md's `View`, the address alone. A different view
 *   is `moved` whatever its content looks like: `?q=a` and `?q=b` are two
 *   pages of results even when both render the same controls, and reading them
 *   as one page left the new table unable to get in.
 * - **Whether anything on it changed** — the structure fingerprint
 *   (`core/extractor/fingerprint.ts`) or the control list. The control list
 *   catches what the fingerprint is deliberately blind to: a menu, dropdown or
 *   dialog opening adds no landmark and no heading, yet the page now offers a
 *   completely different set of things to do.
 *
 * Every reading is structural — no timers, no heuristics about how much
 * changed. A page that swapped one control for another changed; a page that
 * repainted the same controls did not.
 */
export type PageChange = 'moved' | 'changed_in_place' | 'none';

export function pageChange(prev: PromptTable, next: PromptTable): PageChange {
  if (!sameView(prev.url, next.url)) return 'moved';
  if (next.structureHash !== prev.structureHash || controlsOf(next) !== controlsOf(prev)) return 'changed_in_place';
  return 'none';
}

/**
 * What a step did: the page it was pointed on against the page read last.
 * The same snapshot on both sides means no read since has succeeded — nothing
 * was seen, which is `unknown`, never `none`: `none` says the page was read
 * again and found as it was.
 *
 * `moved` only onto a different `View`. A page finishing its own load changes
 * without going anywhere, and writing the page it started on as where it got
 * to is a sentence the model reads back as 「照做了，页面确实变了，之后到了
 * <the same address>」 — a plain falsehood, and one the backstop reads as
 * evidence that the step moved nobody.
 */
export function effectOf(pointedOn: PromptTable, now: PromptTable): StepEffect {
  if (now.snapshotId === pointedOn.snapshotId) return { kind: 'unknown' };
  const change = pageChange(pointedOn, now);
  return change === 'moved' ? { kind: 'moved', to: now.url } : { kind: change };
}

/**
 * What the model is told the page did since its last answer — `effectOf`'s
 * question, with one more distinction it needs and the record does not: an
 * address that changed while every control is still the old page's. That is a
 * new page not yet on screen, and the model can only tell it apart from a
 * finished one if it is said (symptom 1: the address moves first, the page
 * follows).
 */
export function pageSince(pointedOn: PromptTable, now: PromptTable): PageSince {
  if (now.snapshotId === pointedOn.snapshotId) return 'unreadable';
  const change = pageChange(pointedOn, now);
  if (change === 'moved') return controlsOf(now) === controlsOf(pointedOn) ? 'moved_same_controls' : 'moved';
  return change === 'none' ? 'unchanged' : 'changed_in_place';
}

/**
 * Which refs were not on the page the step was pointed on.
 *
 * Same `View` only. After a navigation every control is new and marking all
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
  if (!sameView(prev.url, next.url)) return [];
  const key = (i: PromptItem) => `${i.path.join('›')}|${i.role}|${i.name}`;
  const before = new Set(prev.items.map(key));
  return next.items.filter((i) => !before.has(key(i))).map((i) => i.ref);
}

/**
 * Records what happened to the step on screen — the last history entry. The
 * first answer is the one kept: a step the user skipped and then used, or
 * used and then lost, happened the way it first did.
 */
export function stampAction(history: readonly GuideHistoryEntry[], action: StepAction): readonly GuideHistoryEntry[] {
  const last = history[history.length - 1];
  if (!last || last.action !== undefined) return history;
  return [...history.slice(0, -1), { ...last, action }];
}

/** Records what the page did after the step at `index`, once: it is settled
 *  at one moment, from two reads, and nothing later rewrites it. */
export function stampEffect(history: readonly GuideHistoryEntry[], index: number, effect: StepEffect): readonly GuideHistoryEntry[] {
  const entry = history[index];
  if (!entry || entry.effect !== undefined) return history;
  return history.map((h, i) => (i === index ? { ...h, effect } : h));
}

export const notify = (message: string): MachineEffect => ({ kind: 'notify', message });

/**
 * CONTEXT.md's `Presentation`, as the host names it: one name for each step that
 * became current, kept by every repaint of that step. A new step appends one
 * history entry and a repaint appends none, so the count is the name. Painting
 * a step and matching a late report about it both read it here — two
 * derivations that disagreed would write a report down against the wrong step.
 */
export const presentationIdOf = (threadId: string, state: Pick<ThreadState, 'history'>): string =>
  `${threadId}#${state.history.length}`;

export function present(state: ThreadState): Extract<MachineEffect, { kind: 'present' }> {
  const guideStep = state.steps[state.cursor];
  if (!guideStep) throw new Error(`present: no step at index ${state.cursor}`);
  // A fixed plan is a list: this is step `cursor` of `steps.length`. The
  // model's run holds only the step on screen, so its place in the run is how
  // many steps have been shown — `history`, which already counts this one.
  return state.planSource === 'fixed'
    ? { kind: 'present', step: guideStep, index: state.cursor, total: state.steps.length }
    : { kind: 'present', step: guideStep, index: Math.max(0, state.history.length - 1), total: null };
}

/**
 * The model has answered with an `Output`: the step it answered after is
 * settled, the page it answered on becomes the one the next step is pointed
 * on, and the step being decided is over — one more taken from the run's
 * budget, and the next begins with all its calls.
 *
 * Settled here and not when the page changed, because only now has the model
 * had its chance to wait and look again (CONTEXT.md `Reading`): a step
 * written down as having done nothing while its page was still on its way
 * was the commonest false fact the old record held, and a fact once written
 * is never rewritten. What the step did is the page it was pointed on against
 * the page read last (`effectOf`); whether it arrived where the model said
 * it would is judged against the same page.
 *
 * P-3 is judged here too, for the same reason: the user just agreed to leave
 * their site, and the page they landed on asks for credentials. Checked on the
 * first answer after the hop that sees the page changed, and spent there:
 * "this page asks for your password" is unremarkable on a site the user
 * chose, and worth stopping for on one they were just taken to.
 */
export function settleAnswer(state: ThreadState): { state: ThreadState; stop?: StepOut } {
  const index = state.history.length - 1;
  const undecided = index >= 0 && state.history[index]!.effect === undefined;
  const effect = undecided ? effectOf(state.pointedOn, state.table) : null;
  const settled: ThreadState = {
    ...state,
    stepCalls: 0,
    spentSteps: state.spentSteps + 1,
    pointedOn: state.table,
    // A card for a step the model has now moved past asks about nothing.
    pendingCrossSite: undefined,
    ...(effect ? { history: stampEffect(state.history, index, effect) } : {}),
    // No `expect` means the model declined to predict, and `'skipped'` says
    // exactly that.
    ...(effect ? { check: state.expect ? judgeArrival(state.expect, state.table) : 'skipped' } : {}),
  };
  const landed = effect !== null && effect.kind !== 'none' && effect.kind !== 'unknown';
  if (!state.crossedTo || !landed) return { state: settled };
  const hop = state.crossedTo;
  const spent: ThreadState = { ...settled, crossedTo: undefined };
  if (!state.table.items.some((i) => i.sensitive)) return { state: spent };
  return {
    state: spent,
    stop: {
      state: { ...spent, history: stampAction(spent.history, 'unavailable'), ending: 'credentials_stop', turn: undefined },
      // Deliberately not "this site is unsafe" — we are not a security product
      // and cannot substantiate that (§8.4's closing note on our limits). We
      // describe what we saw and what we did about it.
      effects: [notify(`这一步把你带到了 ${hop}，而那一页要求输入账号信息。为安全起见，引导已经停下。`)],
    },
  };
}

/**
 * The step's conversation ends without an answer — the call failed, or its
 * answer could not be taken. If that was the step's last call, the step ends
 * with it: counted as taken from the run, and the next reading begins a new
 * one with all its calls.
 */
export function closeTurn(state: ThreadState): ThreadState {
  const spent = state.stepCalls >= STEP_CALLS;
  return { ...state, turn: undefined, ...(spent ? { stepCalls: 0, spentSteps: state.spentSteps + 1 } : {}) };
}

/**
 * The step has used every call it had and has no answer: the user is told,
 * and the run goes on — the next reading begins a new step. What the page did
 * meanwhile stays as readings, to be told then. Not an ending: a step that
 * thinks too long is not a run that is over.
 */
export function stepSpent(state: ThreadState): StepOut {
  return { state: closeTurn({ ...state, stepCalls: STEP_CALLS }), effects: [notify(STEP_SPENT_MESSAGE)] };
}

/** The run has taken all its steps, and a new one would begin: it ends, and
 *  says how far it got — the last step it pointed at is the one the user
 *  was left on. */
function runSpent(state: ThreadState): StepOut {
  const last = state.history.at(-1)?.title;
  return {
    state: { ...state, ending: 'quota_exhausted', inflight: null },
    effects: [
      notify(
        `这趟引导已经走了 ${RUN_STEPS} 步，还没有到，先停在这里。${last ? `最后一步是「${last}」。` : ''}想继续的话，在这一页上再说一次目标。`,
      ),
    ],
  };
}

export const worldAtOf = (table: PromptTable, threadRev: number): WorldAt => ({
  threadRev,
  snapshotId: table.snapshotId,
  structureHash: table.structureHash,
  url: table.url,
});

export type StepOut = { state: ThreadState; effects: MachineEffect[] };

/**
 * Single-writer chain's "inflight is a tombstone, not a queue" plus the two
 * budgets, in one gate — every path that wants to dispatch a `callModel`
 * funnels through here so the rules can never be checked in only one of them.
 *
 * A blocked-by-inflight attempt is silent (slice 2: unchanged state, no
 * effects) — this is not a user-facing event, it is the reducer declining a
 * redundant request its caller should not have made. A step out of calls, or
 * a run out of steps, is something the user must be told about.
 */
export function tryEmitCallModel(state: ThreadState, effectId: string, nextRev: number): StepOut {
  const blocked = callBlocked(state);
  if (blocked) return blocked;
  // A wake opens a new turn (CONTEXT.md `Turn`): whatever the model looked at
  // for an earlier step was about an earlier page. Opened only once the gates
  // have passed — a declined wake must not wipe the turn of a call still out.
  // It carries every reading the model has not answered yet, and they are
  // the turn's from here on.
  const freshRefs = freshRefsBetween(state.pointedOn, state.table);
  const readings = state.readings ?? [];
  const turn: Turn = {
    table: state.table,
    ...(freshRefs.length ? { freshRefs } : {}),
    ...(readings.length ? { since: { readings, page: pageSince(state.pointedOn, state.table) } } : {}),
    rounds: [],
  };
  return sendCall({ ...state, readings: undefined, turn }, effectId, nextRev);
}

/**
 * A reading landed while the model was being asked, and the answer — or the
 * tool result — is now back: it is about a world that has since changed, so
 * it is dropped unread and the model asked again, afresh (E-3, as readings
 * have it). What woke the voided turn is still news to the model, which never
 * got to answer it, so it is told again, ahead of what arrived since.
 */
export function askAgain(state: ThreadState, effectId: string, nextRev: number): StepOut {
  const readings = [...(state.turn?.since?.readings ?? []), ...(state.readings ?? [])];
  return tryEmitCallModel({ ...state, turn: undefined, readings: readings.length ? readings : undefined }, effectId, nextRev);
}

/**
 * A tool's result is back: the same turn goes on, one round longer. Every
 * round is a model call, paid from the step's budget.
 */
export function continueTurn(state: ThreadState & { turn: Turn }, effectId: string, nextRev: number): StepOut {
  return callBlocked(state) ?? sendCall(state, effectId, nextRev);
}

/** The gates every model call passes, fresh or continuing. */
function callBlocked(state: ThreadState): StepOut | null {
  // A fixed plan has no model. Every input a fixed plan receives is decided in
  // its own module (`fixed-plan.ts`), so reaching here with one is a bug in a
  // future branch rather than a case to handle — and this is the funnel, so stating
  // the invariant once here is what makes it structural instead of a rule
  // every new dispatch site has to remember.
  if (state.planSource === 'fixed') return { state, effects: [] };
  if (state.inflight) return { state, effects: [] };
  if (state.stepCalls >= STEP_CALLS) return stepSpent(state);
  // Only when a step would begin: the run's last step still gets all its calls.
  if (state.stepCalls === 0 && state.spentSteps >= RUN_STEPS) return runSpent(state);
  return null;
}

function sendCall(state: ThreadState & { turn: Turn }, effectId: string, nextRev: number): StepOut {
  const inflight: InflightEffect = { effectId, kind: 'callModel', at: worldAtOf(state.table, nextRev) };
  const { turn } = state;
  return {
    state: { ...state, callCount: state.callCount + 1, stepCalls: state.stepCalls + 1, inflight },
    effects: [
      {
        kind: 'callModel',
        effectId,
        goal: state.goal,
        table: state.table,
        history: { done: state.history, route: state.route },
        // No rounds, no turn on the wire: a call that looked at nothing is the
        // call it always was.
        ...(turn.rounds.length
          ? { turn: openingOf(turn, turn.rounds) }
          : { ...(turn.freshRefs ? { freshRefs: turn.freshRefs } : {}), ...(turn.since ? { since: turn.since } : {}) }),
        ...(state.stepCalls + 1 === STEP_CALLS ? { final: true as const } : {}),
      },
    ],
  };
}

/** A turn's opening — the page and what woke it, rebuilt byte for byte on
 *  every round — with `rounds` after it. Drops `pending`, which is the
 *  host's business and never crosses the wire. */
export const openingOf = (turn: Turn, rounds: Turn['rounds']): Turn => ({
  table: turn.table,
  ...(turn.freshRefs ? { freshRefs: turn.freshRefs } : {}),
  ...(turn.since ? { since: turn.since } : {}),
  rounds,
});
