/**
 * Which roles we are willing to point at. This is a product decision, not a
 * spec lookup — ARIA's widget subtree includes things we would never highlight
 * (progressbar, row), and we want things that are not widgets at all (heading).
 *
 * `tests/unit/roles.spec.ts` asserts this set does not drift from the ARIA
 * widget closure, using aria-query as a devDependency only.
 */
export const PRIMARY_INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
  'columnheader',
  'rowheader',
]);

/** Structural roles — used for `path` grouping and, at +context, listed too. */
export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'tablist',
  'toolbar',
  'menu',
  'menubar',
]);

export const DIAGNOSTIC_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'status',
  'log',
  'progressbar',
  'alertdialog',
]);

/**
 * One CSS query rather than a per-node predicate. Measured at 1.4–6.2 ms on
 * real pages, so there is no reason to hand-optimise past this.
 */
export const CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role]',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-label]',
  '[aria-labelledby]',
  '[aria-haspopup]',
  '[aria-expanded]',
  'h1,h2,h3,h4,h5,h6',
  'dialog',
  '[popover]',
].join(',');

/** Fallback for elements whose role is not in the primary set. */
export function isInteractive(el: Element, role: string): boolean {
  if (PRIMARY_INTERACTIVE_ROLES.has(role)) return true;
  if (role === 'presentation' || role === 'none') return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) >= 0) return true;
  return isEditable(el);
}

/**
 * Anywhere the user types. **Its text content is `.value` by another name**, and
 * S-05 applies to it in full.
 *
 * This exists because the extractor had a live leak through the one path that
 * does not look like reading a value: `role=generic` has no name-from-content,
 * so `extract.ts` falls back to the element's text so that a `<div tabindex=0>`
 * button can be named at all — and a `<div contenteditable>` satisfies exactly
 * the same conditions. A draft the user was typing arrived in `PromptItem.name`
 * and would have been sent to their model endpoint.
 *
 * All three existing guards missed it, which is why the check has to be here
 * rather than in another regex: `architecture.spec.ts` greps `.value` and the
 * read was `nodeValue`; the `UINode` field whitelist inspects field *names* and
 * this one is called `name`; `isSensitive` only scans attributes.
 */
export const isEditable = (el: Element): boolean =>
  (el as HTMLElement).isContentEditable === true ||
  el.localName === 'input' ||
  el.localName === 'textarea';
