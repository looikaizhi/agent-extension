/**
 * Which path answers 「引导我」 — ADR 0011.
 *
 * A pure predicate over four facts, extracted from `startGuide`'s plumbing so
 * the rule can be stated and checked on its own. The rule was rewritten once
 * after live measurement, and had no test of its own at the time; this is that
 * test's seam.
 *
 * The order matters and is deliberate:
 *
 *  1. **No goal, or the caller already supplied steps** — nothing to plan.
 *     An inspector-driven guide brings its own steps and must not be handed
 *     to a model that would replace them.
 *  2. **A guide pack matches** — free, authoritative, human-authored. It wins
 *     outright over the model, and always will.
 *  3. **No model configured** — fall back rather than fail. A missing key is
 *     not an error state for the guide, it is a cheaper mode.
 *  4. Otherwise the model plans it.
 *
 * The local lexical baseline is **deliberately absent**. It used to sit
 * between 2 and 3: only a `rankCandidates` verdict of `none` let a goal
 * through. On real pages that verdict never happens — four live goals in two
 * languages were all intercepted, because the scorer has a substring floor and
 * a page with hundreds of controls always brushes against it. The model path
 * was reachable only on small synthetic tables, which is exactly what every
 * e2e fixture is, and a whole stage's worth of defects survived 139 green runs
 * behind that gate. The baseline still serves S1's own zero-cost path; it no
 * longer decides who answers a guide.
 */
export type GuidePath = 'model' | 'step-one';

export function chooseGuidePath(facts: {
  goal?: string;
  url: string;
  /** A hand-written flow matched this goal on this site. */
  hasPack: boolean;
  /** The caller supplied concrete steps, so nothing needs planning. */
  hasSteps?: boolean;
  /** BYOK is filled in and usable. */
  configured: boolean;
}): GuidePath {
  if (facts.goal === undefined || facts.hasSteps) return 'step-one';
  if (facts.hasPack) return 'step-one';
  if (!facts.configured) return 'step-one';
  return 'model';
}
