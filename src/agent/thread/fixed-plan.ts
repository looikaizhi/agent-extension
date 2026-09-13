import { samePlace } from './place';
import { judgeConfirmation } from './record';
import type { PromptTable } from '@/core/extractor/types';
import type { MachineInput, ThreadState } from './thread';
import { present, recordMove, stamp, stepForward, type StepOut } from './transitions';

/**
 * A `Fixed plan` (CONTEXT.md) — the steps a caller handed over, run exactly as
 * written: started, advanced only once the user used a step or skipped it,
 * ended when the last one is dealt with, and repainted — never re-planned —
 * when the page changes under it.
 *
 * It never calls the model, and that does not rest on this module remembering
 * to: `tryEmitCallModel` (`transitions.ts`), the one place a model call is
 * ever emitted, refuses a fixed plan outright, and nothing here imports it. An
 * input handler that forgot this file existed would still spend nothing.
 *
 * The reducer keeps the rules every thread shares — whether the page really
 * moved, the credential stop after a cross-site hop — and hands the decision
 * that is the plan's here. How a move is recorded against the step being
 * left, the arrival check included, is `recordMove`, shared with the model's
 * path.
 */

/**
 * Where every input a fixed plan receives ends up: the model is never asked
 * anything, so the only question left is whether this plan has a step after
 * the one the user just dealt with.
 *
 * The caller has already recorded what it knows about the step being left
 * (`page_changed` stamps `confirmed`, the settle window stamps `failed`), so
 * this only advances or ends — and clears `used`, which belonged to the step
 * being left.
 *
 * It ends as `steps_walked`, and what it says comes from how many steps were
 * confirmed (`judgeConfirmation`), not from the cursor: a cursor that reached
 * the last step proves nothing about whether the steps worked — a user who was
 * asked twice and got nowhere twice walked the plan and confirmed none of it
 * (`judgeConfirmation`'s own doc comment, which exists because S1 got exactly
 * this wrong).
 */
function advance(from: ThreadState): StepOut {
  const state: ThreadState = { ...from, used: false };
  if (state.cursor + 1 < state.steps.length) return stepForward(state);
  const allConfirmed = judgeConfirmation(state.history) === 'all';
  return {
    state: { ...state, ending: 'steps_walked', steps: [], cursor: 0, inflight: null },
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
      outcomes: input.steps.map(() => undefined),
      history: [{ title: input.steps[0].title, url: input.table.url, outcome: 'unknown' }],
      planSource: 'fixed',
      // The person picked the element themselves; nothing here was inferred.
      evidence: 'handpicked',
      check: 'unknown',
      callCount: 0,
      docFetchCount: 0,
      inflight: null,
    };
    return { state: fresh, effects: [present(fresh, 0)] };
  },

  /**
   * `step_settle_timeout` — the user used the step and the page did not move.
   *
   * A fixed plan's settle window closing means the same thing a page move
   * does: the user dealt with the step in front of them and there is nothing
   * left to decide. **Including when the plan is spent** — the replan the
   * reducer would otherwise reach is for a guide that has a model to ask, and
   * a fixed plan has none: sent there, the step would be refused by the gate
   * and simply never move on.
   */
  onSettleTimeout(state: ThreadState): StepOut {
    // Only a used step has a settle window to close; anything else has nothing
    // to report.
    if (!state.used) return { state, effects: [] };
    return advance({ ...state, history: stamp(state.history, 'failed') });
  },

  /**
   * `page_changed`, once the reducer has proven the page really moved to
   * `table`. A used step made that move, so the move is recorded against it
   * (`recordMove`) and the plan advances.
   *
   * A fixed plan does not re-plan, and it moves only when the user used its
   * step (`ThreadState.used`). A page that changed on its own — the user went
   * somewhere else, the page re-rendered, the target vanished unused — gets the
   * same step painted again against where things are now, which rebinds it
   * from its descriptor. Claiming it done instead would be the lie the old
   * host needed a whole "advance speculatively, then step back" mechanism to
   * take back.
   */
  onPageMoved(state: ThreadState, table: PromptTable): StepOut {
    if (state.used) return advance(recordMove(state, table));
    const here: ThreadState = { ...state, table, crossedTo: undefined };
    return { state: here, effects: [present(here, here.cursor)] };
  },

  /**
   * `step_skipped` — the user pressed 跳过.
   *
   * A fixed plan has an honest answer: its next step was written before the
   * run began, so moving to it is exactly what the button says. The step being
   * left keeps `unknown` in the history — skipping proves nothing — and that is
   * what keeps a run whose every step was skipped from counting as confirmed
   * (`judgeConfirmation`).
   */
  onSkipped(state: ThreadState): StepOut {
    return advance(state);
  },

  /**
   * `step_used` — the user activated the target of the step on screen.
   *
   * Recorded and nothing else: whether the step *worked* is the page's to
   * answer, and the answer arrives as `page_changed` (it moved — `confirmed`)
   * or `step_settle_timeout` (it did not — `failed`). Advancing here would
   * paint the next step on the page the user is leaving, where a navigating
   * step's successor cannot bind, and record that as a failure it was not.
   */
  onUsed(state: ThreadState, at: string): StepOut {
    // The page already left the place the click happened on before this report
    // was applied: the page-change pipeline (`replan.ts`) committed the move first. Moves
    // run through a latest-wins queue of their own, so that order is possible
    // even though this report was sent first — and the move is then the answer
    // the page owed. Waiting for a settle window instead would watch a page that
    // no longer moves, and record a step that worked as `failed`.
    if (at && !samePlace(at, state.table.url)) {
      return advance({ ...state, history: stamp(state.history, 'confirmed', state.table.url) });
    }
    return { state: { ...state, used: true }, effects: [] };
  },
};
