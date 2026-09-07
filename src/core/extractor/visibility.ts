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

/**
 * When a modal is open the user is almost always stuck *in it* — extracting the
 * background is guaranteed-wrong. ~15 lines, and far cheaper than hit-testing
 * every candidate.
 *
 * Every candidate is held to `isVisible`, because that premise is the whole
 * justification: a modal nobody can see traps nobody. The last family is the
 * one that needed it. `dialog[open]:modal` and `[popover]:popover-open` are
 * browser-enforced states, but `role="dialog" aria-modal="true"` is only an
 * author's claim, and shipping a permanently-present `display: none` modal
 * template is ordinary practice.
 *
 * Measured on github.com/search?q=n8n: GitHub's hovercard container
 * `<div role="dialog" aria-modal="true" class="Popover js-hovercard-content">`
 * sits in the document at `display: none` on every results page, so all 197
 * controls were scoped into an empty shell — `elementsScanned` came back as
 * `1`, the shell itself. The guide then re-planned against a page it read as
 * offering nothing. github.com's home page and repo pages do not render that
 * container, which is why one site behaved differently page by page.
 */
export function findModalScope(root: Document | ShadowRoot): Element | null {
  for (const el of root.querySelectorAll('dialog[open]')) {
    if (el.matches(':modal') && !isOurs(el) && isVisible(el)) return el;
  }
  for (const el of root.querySelectorAll('[popover]:popover-open')) {
    if (!isOurs(el) && isVisible(el)) return el;
  }
  for (const el of root.querySelectorAll(
    '[role="dialog"][aria-modal="true"]:not([data-page-guide]),' +
      '[role="alertdialog"][aria-modal="true"]:not([data-page-guide])',
  )) {
    if (isVisible(el)) return el;
  }
  return null;
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
