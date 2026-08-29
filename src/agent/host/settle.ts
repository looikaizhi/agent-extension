import { judgeArrival } from '@/agent/plan/validate';
import type { GuideExpectAfter } from '@/agent/plan/contract';
import type { PromptTable } from '@/core/extractor/types';

/**
 * **Not wired.** Nothing calls this today — `background.ts` went back to its
 * three settle windows on 2026-08-21 and this module is kept only because the
 * judgement it encodes is still the right idea, badly parameterised.
 *
 * What the live run falsified: 56 of 70 re-plans never settled and burned the
 * whole 4.4s window, journeys fell from 4.1 hops to 2.1, and the harness timed
 * out 13 times. Two causes, both in the criterion rather than the concept:
 * github.com's search dropdown re-renders its suggestions, so consecutive
 * control lists are never byte-identical; and `expect` — which describes the
 * *destination* — outranks quiescence, so a page that is not the destination
 * polls fruitlessly until the deadline. Cost did improve (1.39 → 0.86 calls
 * per hop, ceiling 12 → 7): the gate works, the waiting is what was ruinous.
 *
 * That is the same pathology Playwright cites for discouraging `networkidle`,
 * rebuilt on a different signal — quoted in this module's own plan document
 * before it was written. Any rewrite has to make the wait cheap when it cannot
 * help: check `expect` only after a real navigation, compare something coarser
 * than the full control list, and stop giving same-page changes a 4.4s budget.
 *
 * See `docs/plans/s2-guided-flow/09-transition-settled.md`.
 *
 * ---
 *
 * Has the transition finished, or is the page still moving?
 *
 * A third question, distinct from the two the codebase already answers.
 * `pageMoved` (machine.ts) asks **did anything change** — a difference test.
 * The settle windows in `background.ts` ask **is the page readable yet**. This
 * asks **has it stopped changing**, and nothing asked it before.
 *
 * The distinction is what 15 live github.com journeys turned on. A navigation's
 * first observable difference is almost never its destination: it is a dropdown
 * opening, the outgoing document being torn down, a half-painted frame. The
 * earliest trigger wins the one model call this hop gets — and the earliest
 * trigger fires ~50 ms after the click, when the page is at its least settled.
 * The model was handed github.com's home page and asked what to do next, from a
 * user who had already left it; it answered "click the search box", which is the
 * right answer to the wrong question.
 */
export type Settlement = 'settled' | 'still-moving';

/** Same projection `pageMoved` compares on — identity of the control list,
 *  insensitive to refs, which are minted per snapshot. */
const controlsOf = (t: PromptTable) => t.items.map((i) => `${i.path.join('>')}|${i.role}|${i.name}`).join('\n');

/** Origin + pathname, matching `tableIsOfCurrentPage`'s comparison: a query
 *  string that gains a tracking parameter is not a route change. */
function locationOf(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * Two layers, in priority order, mirroring what browser automation converged on.
 *
 * **With a prediction** — the model's `expect_after` names the shape the
 * destination should contain, so wait for exactly that. This is Playwright's
 * web-first assertion in our vocabulary: check the UI state you actually need,
 * never a proxy for it. It deliberately outranks quiescence, because a page can
 * finish rendering the *wrong* destination and sit there perfectly still.
 *
 * **Without one** — require both signals to hold against the previous look:
 *  - the location stopped moving. An SPA route change fires no load event and
 *    leaves `readyState` at `complete`, so the URL is the only primary signal
 *    it offers, and `pageMoved`'s hash+controls test cannot see it at all.
 *  - the control list stopped moving. The DOM-quiescence half, the same thing
 *    browser-use and the CDP-based tools settle on.
 *
 * Network idleness is deliberately absent. Playwright discourages it in its own
 * API, for the reason that decides it here too: a page polling faster than every
 * 500 ms never goes idle, and github.com polls.
 *
 * There is no deadline in this function. Bounding the wait is mandatory — every
 * implementation surveyed has one — but a deadline is a fact about a clock, and
 * this is a pure judgement about two tables. `runReplan` owns the clock and
 * commits against the freshest table when its windows run out. That fallback is
 * not an error path: on an infinite-scroll or long-polling page neither layer
 * above will *ever* say `settled`, and the issue list is exactly that shape.
 */
export function judgeSettled(args: {
  expect?: GuideExpectAfter;
  previous: PromptTable | null;
  current: PromptTable;
}): Settlement {
  if (args.expect) return judgeArrival(args.expect, args.current) === 'pass' ? 'settled' : 'still-moving';

  const previous = args.previous;
  if (!previous) return 'still-moving';
  if (locationOf(previous.url) !== locationOf(args.current.url)) return 'still-moving';
  return controlsOf(previous) === controlsOf(args.current) ? 'settled' : 'still-moving';
}
