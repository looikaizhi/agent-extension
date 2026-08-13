export { budgetFor } from '@/core/extractor/project';

/**
 * Token budget is not part of the agent boundary.
 *
 * It used to be re-exported from `api.ts`, which meant the side panel imported
 * the agent module purely to size an extraction — and would have kept doing so
 * once that module grew LangGraph, providers and a checkpoint saver behind it.
 * The budget is a property of the model's context window, not of the agent, so
 * it gets its own door.
 */

import type { ProjectBudget } from '@/core/extractor/types';

/**
 * What the *local* matcher sees: everything.
 *
 * Token budget is a constraint on what we send to a model, and the lexical
 * baseline sends nothing anywhere. Scoring it against the viewport-limited
 * projection made the product behave the way a real test found it: on MDN, a
 * footer link was unfindable from the top of the page and findable after
 * scrolling to it — which asks the user to locate the thing they are asking us
 * to locate.
 */
export const LOCAL_BUDGET: ProjectBudget = {
  // Not Infinity: this crosses `chrome.runtime.sendMessage`, and JSON turns
  // Infinity into null. Large enough for any real page (MDN, the heaviest we
  // have measured, emits ~2100).
  maxNodes: 100_000,
  viewportBands: 1,
};
