import { judgeConfirmation } from './record';
import type { Reading } from '@/agent/context/turn';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideHistoryEntry, MachineInput, ThreadState } from './thread';
import { effectOf, present, stampAction, stampEffect, type StepOut } from './transitions';

/**
 * A `Fixed plan` (CONTEXT.md) — the steps a caller handed over, run exactly as
 * written: started, advanced the moment the user uses a step or skips it,
 * ended when the last one is dealt with, and repainted — never re-planned —
 * when the page changes under it.
 *
 * It never calls the model, and that does not rest on this module remembering
 * to: `tryEmitCallModel` (`transitions.ts`), the one place a model call is
 * ever emitted, refuses a fixed plan outright, and nothing here imports it. An
 * input handler that forgot this file existed would still spend nothing.
 *
 * The reducer keeps the rules every thread shares and hands the decisions that
 * are the plan's here: what a reading (CONTEXT.md `Reading`) does to it, and
 * what 跳过 does. A fixed plan is the one consumer of readings that is not the
 * model — there is no model to ask.
 */

/**
 * The user has dealt with the step on screen — used it or skipped it — and
 * that is the moment to settle what the step before it did: from the page read
 * when the user was done with it (`pointedOn`, the page this step went up on)
 * to the page last read before they turned to this one. Earlier than this the
 * page may still have been answering; a fixed plan has no model to wait for
 * it, so the user's next move is what marks it done answering. A skipped step
 * did nothing to be settled.
 */
function settlePrevious(state: ThreadState): readonly GuideHistoryEntry[] {
  const index = state.history.length - 2;
  if (state.history[index]?.action !== 'taken') return state.history;
  return stampEffect(state.history, index, effectOf(state.pointedOn, state.table));
}

/**
 * Where every input a fixed plan receives ends up: the model is never asked
 * anything, so the only question left is whether this plan has a step after
 * the one the user just dealt with. The caller has already recorded what it
 * knows about the step being left, so this only advances — onto `page`, the
 * page as it is now — or ends.
 *
 * It ends as `steps_walked`, and what it says comes from how many steps were
 * confirmed (`judgeConfirmation`), not from the cursor: a cursor that reached
 * the last step proves nothing about whether the steps worked — a user who was
 * asked twice and got nowhere twice walked the plan and confirmed none of it
 * (`judgeConfirmation`'s own doc comment, which exists because S1 got exactly
 * this wrong).
 */
function advance(state: ThreadState, history: readonly GuideHistoryEntry[], page: PromptTable): StepOut {
  if (state.cursor + 1 < state.steps.length) {
    // The only plan with a next step: a model points at one step at a time.
    const next = state.cursor + 1;
    const advanced: ThreadState = {
      ...state,
      table: page,
      pointedOn: page,
      cursor: next,
      history: [...history, { title: state.steps[next]!.title, url: page.url }],
    };
    return { state: advanced, effects: [present(advanced)] };
  }
  const allConfirmed = judgeConfirmation(history) === 'all';
  return {
    state: { ...state, table: page, history, ending: 'steps_walked', steps: [], cursor: 0, inflight: null },
    // Said the way it went: a plan whose steps did not all work is not 「走完了」.
    effects: [{ kind: 'done', why: allConfirmed ? '这串步骤都走完了' : '这串步骤到头了，但有几步没有走通', ending: 'steps_walked' }],
  };
}

export const fixedPlan = {
  /**
   * `start_fixed` — a plan written before this run began (the inspector's row
   * click).
   *
   * The steps are landed verbatim. They carry a `Descriptor` — identity that
   * outlives a snapshot — and deliberately *not* a `ref`: binding happens when
   * the renderer goes to paint a step, not when the plan is made, because step 3's
   * target usually does not exist in the DOM while step 1 is on screen
   * (`GuideStep.ref`'s own doc comment in shared/protocol.ts).
   *
   * `callCount` starts at 0 and stays there: only `tryEmitCallModel` ever raises
   * it, and it refuses a fixed plan (see the top of this file).
   */
  start(input: Extract<MachineInput, { kind: 'start_fixed' }>): StepOut {
    const fresh: ThreadState = {
      rev: 0, // the `step` wrapper overwrites this with `nextRev`
      goal: input.goal,
      table: input.table,
      route: [],
      steps: input.steps,
      cursor: 0,
      history: [{ title: input.steps[0].title, url: input.table.url }],
      pointedOn: input.table,
      planSource: 'fixed',
      // The person picked the element themselves; nothing here was inferred.
      evidence: 'handpicked',
      check: 'unknown',
      callCount: 0,
      stepCalls: 0,
      spentSteps: 0,
      inflight: null,
    };
    return { state: fresh, effects: [present(fresh)] };
  },

  /**
   * A reading (CONTEXT.md `Reading`), with the page the host read right after
   * — `null` when it could not be read.
   *
   * `used` moves the plan on at once: the user did the step, and a plan
   * written in advance has nothing to wait for the page to decide. The step is
   * recorded as taken; what it did is settled when the user deals with the
   * next one (`settlePrevious`) — or, for the last step, right here, from the
   * page before the click against the page read after it: the run ends now,
   * and that one read is all there is.
   *
   * A page that loaded, changed by itself, or lost the target — or a step
   * that was not painted because the page had gone elsewhere — gets the same
   * step painted again against the page as it is now, which rebinds it from
   * its descriptor (how an SPA re-render or a reload is survived). Claiming it
   * done instead would be the lie the old host needed a whole "advance
   * speculatively, then step back" mechanism to take back.
   *
   * Three readings are answered by leaving things as they are, because painting
   * again would only repeat them: a target that is not on the page — the
   * 「找不到」 screen is up with 重试 and 跳过 on it, which is the user's to
   * answer, and the renderer goes on looking as the page changes — a target
   * that cannot be operated right now, which the user can see for themselves,
   * and a target that is a password-like field. What the user says has no one
   * here to hear it; the host never hands it to a fixed plan.
   */
  onReading(state: ThreadState, reading: Reading, table: PromptTable | null): StepOut {
    const page = table ?? state.table;
    if (
      reading.kind === 'not_found' ||
      reading.kind === 'not_actionable' ||
      reading.kind === 'said' ||
      (reading.kind === 'not_shown' && reading.why === 'sensitive')
    )
      return { state, effects: [] };
    if (reading.kind !== 'used') {
      const here: ThreadState = { ...state, table: page };
      return { state: here, effects: [present(here)] };
    }
    let history = stampAction(settlePrevious(state), 'taken');
    if (state.cursor + 1 >= state.steps.length) history = stampEffect(history, history.length - 1, effectOf(state.table, page));
    return advance(state, history, page);
  },

  /**
   * `step_skipped` — the user pressed 跳过.
   *
   * A fixed plan has an honest answer: its next step was written before the
   * run began, so moving to it is exactly what the button says. The step being
   * left is recorded as `skipped` — what the user did, and nothing about the
   * page — and that is what keeps a run whose every step was skipped from
   * counting as confirmed (`judgeConfirmation`).
   */
  onSkipped(state: ThreadState): StepOut {
    return advance(state, stampAction(settlePrevious(state), 'skipped'), state.table);
  },
};
