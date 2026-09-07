import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import type { NameSource, UIState } from '@/shared/types';
import type { ExtractProfile } from './types';

/**
 * `getRole` already implements the HTML-AAM implicit mapping (input[type]
 * branches, a[href], select[multiple], role="presentation" conflict
 * resolution) and never calls getComputedStyle. aria-query is not needed here.
 */
export function resolveRole(el: Element): string {
  let role: string | null = null;
  try {
    role = getRole(el);
  } catch {
    role = null;
  }
  if (role) return role;

  // HTML-AAM gives password/hidden-ish inputs *no* ARIA role, which is correct
  // for assistive tech but wrong for us: an element we never extract is one we
  // can never refuse to highlight (S-03) and never diagnose. Map them
  // explicitly rather than letting them fall through to 'generic'.
  if (el.localName === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    if (type === 'password') return 'textbox';
    if (type === 'file' || type === 'color' || type === 'date' || type === 'datetime-local')
      return 'textbox';
  }
  return 'generic';
}

/** A name made only of punctuation/symbols is an extraction defect, not a name.
 *  Measured: fixing this alone lifted GitHub's top-1 ceiling 85.5% → 93.4%. */
const JUNK = /^[\s\p{P}\p{S}]*$/u;

function humanize(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveName(
  el: Element,
  maxLen: number,
): { name: string; source: NameSource } {
  // computeAccessibleName walks the name subtree calling getComputedStyle on
  // each child — only ever call it on an already-filtered candidate.
  let raw = '';
  try {
    raw = computeAccessibleName(el);
  } catch {
    raw = '';
  }
  let source: NameSource = raw ? classifySource(el, raw.trim()) : 'none';

  if (!raw || raw.trim().length < 2 || JUNK.test(raw)) {
    const title = el.getAttribute('title')?.trim();
    const svgTitle = el.querySelector(':scope > svg > title')?.textContent?.trim();
    const testid =
      el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-qa');
    const href = el.getAttribute('href');

    if (title) [raw, source] = [title, 'title'];
    else if (svgTitle) [raw, source] = [svgTitle, 'title'];
    else if (testid) [raw, source] = [humanize(testid), 'testid'];
    else if (href) {
      const tail = href.split(/[?#]/)[0]?.split('/').filter(Boolean).pop();
      if (tail) [raw, source] = [humanize(decodeURIComponent(tail)), 'href'];
    } else {
      raw = '';
      source = 'none';
    }
  }

  const norm = raw.replace(/\s+/g, ' ').trim();
  return {
    name: norm.length > maxLen ? `${norm.slice(0, maxLen - 1)}…` : norm,
    source,
  };
}

/**
 * Where the name came from — which decides whether the user can read it.
 *
 * Guessed from attributes, except for `title`, where guessing was wrong. The
 * accessible-name spec ends with `title` as its last resort, and
 * `computeAccessibleName` implements that — so an element carrying only a
 * `title` never reaches `resolveName`'s explicit fallback below, and used to
 * be classified `content`: "text the user reads on screen". Measured: across
 * the whole eval corpus, 189 items, **not one** carried a `nameSource`, so the
 * `~` mark had zero coverage and the model was being told that names existing
 * only in a `title` attribute were painted on the page. That mark is the one
 * thing standing between it and telling a user to 「点写着 X 的按钮」 when
 * nothing on screen says X.
 *
 * Detected by comparing the computed name against the title, which is exact
 * whenever the title is what produced it. The residual is an element whose
 * visible text happens to equal its own `title` — real, but rare, and it errs
 * the safe way: the model under-trusts a name it could have read, rather than
 * over-trusting one it could not.
 */
const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();

function classifySource(el: Element, name: string): NameSource {
  if (el.hasAttribute('aria-labelledby')) return 'aria-labelledby';
  if (el.hasAttribute('aria-label')) return 'aria-label';
  if (el.hasAttribute('alt')) return 'alt';
  if (el.hasAttribute('placeholder')) return 'placeholder';
  const id = el.getAttribute('id');
  if (id && el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)) return 'label';
  if (el.closest('label')) return 'label';
  // Both sides folded: `computeAccessibleName` collapses whitespace the way
  // the spec says, a raw attribute does not. A `title` carrying a newline
  // would otherwise compare unequal and fall back to `content` — the exact
  // failure this branch exists to remove.
  if (fold(el.getAttribute('title') ?? '') === fold(name)) return 'title';
  return 'content';
}

/** Boolean IDL attributes only. Reading `.value` content is forbidden (S-05). */
export function resolveState(el: Element, profile: ExtractProfile): UIState[] | undefined {
  const s: UIState[] = [];
  const aria = (n: string) => el.getAttribute(`aria-${n}`);
  const input = el as HTMLInputElement;

  if (input.disabled === true || aria('disabled') === 'true') s.push('disabled');

  if (profile !== 'interactive') {
    const expanded = aria('expanded');
    if (expanded === 'true') s.push('expanded');
    else if (expanded === 'false') s.push('collapsed');

    const checked = aria('checked');
    if (checked === 'true' || input.checked === true) s.push('checked');
    else if (checked === 'mixed') s.push('mixed');

    if (aria('selected') === 'true') s.push('selected');
    const current = aria('current');
    if (current && current !== 'false') s.push('current');
    if (aria('required') === 'true' || input.required === true) s.push('required');
    if (aria('readonly') === 'true' || input.readOnly === true) s.push('readonly');
    const invalid = aria('invalid');
    if (invalid && invalid !== 'false') s.push('invalid');
    if (aria('busy') === 'true') s.push('busy');
  }

  return s.length ? s : undefined;
}
