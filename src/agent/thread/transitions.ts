import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import type { GuideHistoryEntry, InflightEffect, MachineEffect, ThreadState, WorldAt } from './thread';
import { judgeArrival } from '@/agent/thread/judge';
import { samePlace } from './place';

/**
 * The pieces every reducer branch builds its answer from: put a step on
 * screen, move on to the next one, settle what happened to the one being left,
 * tell the user something, and the two gates every model call and doc fetch
 * has to pass — the in-flight tombstone, then the quota.
 *
 * Kept apart from `machine.ts` so that anything deciding a consequence uses
 * these same pieces rather than a copy: a gate written twice is a gate that
 * drifts.
 *
 * Pure, like the reducer that loads it (N-2). The guard, and why it follows
 * imports instead of a file name, are in `tests/unit/architecture.spec.ts`.
 */

const CALL_QUOTA_MESSAGE = '这条引导已用满模型调用上限（12 次），已停止。';

/** Settles the outcome of the step currently on screen — the last history
 *  entry, and only while it is still `unknown`. A step whose fate is already
 *  recorded is never rewritten: `confirmed` and `invalidated` come from two
 *  different inputs that can both arrive for the same step, and the first one
 *  to arrive is the one that actually happened. */
export function stamp(
  history: readonly GuideHistoryEntry[],
  outcome: GuideHistoryEntry['outcome'],
  landedAt?: string,
): readonly GuideHistoryEntry[] {
  const last = history[history.length - 1];
  if (!last) return history;

  // A landing worth recording is one that went somewhere. `pageMoved` is true
  // for a page finishing its own load, and writing the page it started on as
  // where it "got to" is a sentence the model then reads back as 「照做了，页面
  // 确实变了，之后到了 <the same address>」 — a plain falsehood, and one the
  // backstop below reads as evidence that the step moved nobody. Measured
  // across three live runs: 7, 5 and 14 of the navigating steps were recorded
  // that way, and in two journeys it turned the model's own correction —
  // 「回到 issue 列表」 — into a loop the backstop refused.
  const arrived = landedAt !== undefined && !samePlace(landedAt, last.url);

  // First-come-wins, and it is about the step's *fate*: `confirmed` and
  // `invalidated` can both arrive for one step and the first is what happened.
  // Where it got to is a different question, and one this may still be the
  // first to answer — the load finishing and the navigation completing arrive
  // as two inputs, in that order, and only the second knows the address.
  if (last.outcome !== 'unknown') {
    if (!arrived || last.landedAt !== undefined) return history;
    return [...history.slice(0, -1), { ...last, landedAt }];
  }
  return [...history.slice(0, -1), { ...last, outcome, ...(arrived ? { landedAt } : {}) }];
}

export const notify = (message: string): MachineEffect => ({ kind: 'notify', message });

export function present(state: ThreadState, index: number): Extract<MachineEffect, { kind: 'present' }> {
  const guideStep = state.steps[index];
  if (!guideStep) throw new Error(`present: no step at index ${index}`);
  return {
    kind: 'present',
    step: guideStep,
    index,
    total: state.steps.length,
    mode: state.steps.length > 1 ? 'guide' : 'locate',
  };
}

/** Moves to the next step of the plan and shows it. The caller has already
 *  decided there is one, and recorded what it knows about the step being left. */
/**
 * A page that really moved, recorded against the step being left: the new
 * table, the step stamped `confirmed` with where it landed, and the arrival
 * judged. CONTEXT.md's `confirmed` is "点击且页面确实变了", and every caller has
 * just had `pageMoved` prove the page moved — the model's path for every move,
 * a fixed plan only for a move its own used step made (`fixed-plan.ts`). The
 * one other place that writes `confirmed` is `fixedPlan.onUsed`, where that
 * move got there before the report of the click did.
 */
export function recordMove(state: ThreadState, table: PromptTable): ThreadState {
  return {
    ...state,
    table,
    // Spent: the check belongs to the hop that crossed, not to every page
    // after it. Whatever the user does next is on a site they have now chosen.
    crossedTo: undefined,
    history: stamp(state.history, 'confirmed', table.url),
    // The one moment the arrival can be judged: a fresh table of the page
    // the step led to. No `expect` means the model declined to predict, and
    // `'skipped'` says exactly that.
    check: state.expect ? judgeArrival(state.expect, table) : 'skipped',
  };
}

export function stepForward(state: ThreadState): StepOut {
  const next = state.cursor + 1;
  const advanced: ThreadState = {
    ...state,
    cursor: next,
    outcomes: state.outcomes.map((o, i) => (i === state.cursor ? o ?? 'skipped' : o)),
    history: [...state.history, { title: state.steps[next]!.title, url: state.table.url, outcome: 'unknown' }],
  };
  return { state: advanced, effects: [present(advanced, next)] };
}

/**
 * The two gates every model call and doc fetch passes, in this order: nothing
 * new while one is in flight — the tombstone, declined silently, because a
 * caller asking twice is not an event the user needs to hear about — and then
 * the quota, which ends the run and says why. `null` means go ahead.
 */
export function dispatchBlocked(state: ThreadState, used: number, limit: number, message: string): StepOut | null {
  if (state.inflight) return { state, effects: [] };
  if (used >= limit) {
    return {
      state: { ...state, ending: 'quota_exhausted', inflight: null },
      effects: [notify(message)],
    };
  }
  return null;
}

export const worldAtOf = (table: PromptTable, threadRev: number): WorldAt => ({
  threadRev,
  snapshotId: table.snapshotId,
  pageHash: table.pageHash,
  url: table.url,
});

export type StepOut = { state: ThreadState; effects: MachineEffect[] };

/**
 * Single-writer chain's "inflight is a tombstone, not a queue" plus §5.10's quota, in one gate — every path that
 * wants to dispatch a `callModel` funnels through here so the two rules can
 * never be checked in only one of them.
 *
 * A blocked-by-inflight attempt is silent (slice 2: unchanged state, no
 * effects) — this is not a user-facing event, it is the reducer declining a
 * redundant request its caller should not have made. A blocked-by-quota
 * attempt is a terminal state the user must be told about (slice 11).
 */
export function tryEmitCallModel(
  state: ThreadState,
  effectId: string,
  nextRev: number,
  freshRefs: readonly Ref[] = [],
): StepOut {
  // A fixed plan has no model. Every input a fixed plan receives is decided in
  // its own module (`fixed-plan.ts`), so reaching here with one is a bug in a
  // future branch rather than a case to handle — and this is the funnel, so stating
  // the invariant once here is what makes it structural instead of a rule
  // every new dispatch site has to remember.
  if (state.planSource === 'fixed') return { state, effects: [] };
  const blocked = dispatchBlocked(state, state.callCount, 12, CALL_QUOTA_MESSAGE);
  if (blocked) return blocked;
  const inflight: InflightEffect = { effectId, kind: 'callModel', at: worldAtOf(state.table, nextRev) };
  return {
    state: { ...state, callCount: state.callCount + 1, inflight },
    effects: [
      {
        kind: 'callModel',
        effectId,
        goal: state.goal,
        table: state.table,
        history: { done: state.history, route: state.route },
        ...(freshRefs.length ? { freshRefs } : {}),
      },
    ],
  };
}
