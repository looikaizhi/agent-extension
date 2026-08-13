import type { Rect } from '@/shared/types';

/**
 * Cheap-to-expensive, short-circuiting. Our code never calls getComputedStyle:
 * step 3 already eliminates `display:none` (its rect is all-zero) and step 4 is
 * one native call covering visibility / opacity / content-visibility.
 */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return false;

  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;

  // Baseline 2024. Covers display / visibility / opacity / content-visibility:auto
  // in a single native call, faster and shorter than four getComputedStyle reads.
  return el.checkVisibility({
    opacityProperty: true,
    visibilityProperty: true,
    contentVisibilityAuto: true,
  });
}

export function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

export function inViewport(rect: Rect): boolean {
  const [x, y, w, h] = rect;
  return y + h > 0 && y < window.innerHeight && x + w > 0 && x < window.innerWidth;
}

/** Keep elements within ±`bands` screens of the viewport.
 *  Takes the viewport as data so callers in Node (the eval harness) can use it. */
export function withinBands(
  rect: Rect,
  bands: number,
  viewport: { width: number; height: number },
): boolean {
  const [x, y, w, h] = rect;
  const { width: vw, height: vh } = viewport;
  return (
    y + h > -vh * bands && y < vh * (1 + bands) && x + w > -vw * bands && x < vw * (1 + bands)
  );
}

/**
 * When a modal is open the user is almost always stuck *in it* — extracting the
 * background is guaranteed-wrong. ~15 lines, and far cheaper than hit-testing
 * every candidate.
 */
export function findModalScope(root: Document | ShadowRoot): Element | null {
  for (const el of root.querySelectorAll('dialog[open]')) {
    if (el.matches(':modal') && !isOurs(el)) return el;
  }
  for (const el of root.querySelectorAll('[popover]:popover-open')) {
    if (!isOurs(el)) return el;
  }
  return root.querySelector(
    '[role="dialog"][aria-modal="true"]:not([data-page-guide]),' +
      '[role="alertdialog"][aria-modal="true"]:not([data-page-guide])',
  );
}

/**
 * The guide must never see itself.
 *
 * Our overlay host is `popover="manual"` and open, so it is a perfectly valid
 * modal scope by the rule above — which meant that re-extracting while a step
 * was on screen scoped the whole extraction to our own host, whose shadow root
 * is closed, and produced **zero nodes**. Nothing could bind, and every guide
 * died on its second step.
 *
 * This only became reachable with late binding (task 8): before that, EXTRACT
 * was always called before anything was painted.
 */
export const isOurs = (el: Element): boolean => el.hasAttribute('data-page-guide');
