import { makeRef, type Ref } from '@/shared/types';
import { isSensitive } from '@/core/security/sensitive';
import { pageFingerprint } from './fingerprint';
import { registry } from './registry';
import {
  CANDIDATE_SELECTOR,
  isEditable,
  isInteractive,
  LANDMARK_ROLES,
  PRIMARY_INTERACTIVE_ROLES,
} from './roles';
import { resolveName, resolveRole, resolveState } from './semantics';
import type { ExtractProfile, ExtractStats, LocatorView, UINode } from './types';
import { findModalScope, isOurs, isVisible, inViewport, toRect } from './visibility';

const MAX_SHADOW_DEPTH = 12;
/**
 * The point at which we stop and admit the table is incomplete.
 *
 * Deliberately generous. The earlier value was 250 ms and it was also used to
 * *compute* `degraded`, which conflated two different things: MDN takes ~340 ms
 * and was flagged degraded, while its walk had finished in 16 ms and the table
 * was perfectly complete. A flag that fires on "slow" cannot also mean
 * "incomplete", and "incomplete" is the one downstream consumers must not miss.
 *
 * Slowness is reported separately and honestly, by `stats.ms`.
 */
const BUDGET_MS = 1500;
/** Full-set names are not truncated; `project()` truncates for the prompt. */
const RAW_NAME_MAX = 200;

interface Candidate {
  el: Element;
}

/**
 * Produces the FULL set — no viewport pruning, no node cap. Token policy lives
 * in `project()` (K-4): pruning here would take a scrolled-away target out of
 * `relocate`'s search space, exactly when local relocation matters most.
 */
export function extract(profile: ExtractProfile, frameId = 0): LocatorView {
  const t0 = performance.now();
  const stats: ExtractStats = {
    elementsScanned: 0,
    candidates: 0,
    visible: 0,
    emitted: 0,
    shadowRoots: 0,
    emptyName: 0,
    modalScoped: false,
    ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
  };

  const modal = findModalScope(document);
  stats.modalScoped = modal !== null;
  const scope: Document | Element = modal ?? document;

  const candidates: Candidate[] = [];
  const truncated = { walk: false, semantics: false };
  walk(scope, 0, candidates, stats, t0, truncated);
  const t1 = performance.now();

  const visible = candidates.filter((c) => isVisible(c.el));
  stats.visible = visible.length;
  const t2 = performance.now();

  const nodes: UINode[] = [];
  const elOf = new Map<Ref, Element>();
  const refOf = new Map<Element, Ref>();
  let n = 0;
  let tName = 0;
  for (const c of visible) {
    // The naming pass had no budget at all: the watchdog only guarded the walk,
    // so a pathological page could block the main thread indefinitely here —
    // and this is where the time actually goes (measured: MDN 300 ms of 340 ms).
    if (performance.now() - t0 > BUDGET_MS) {
      truncated.semantics = true;
      break;
    }
    const role = resolveRole(c.el);
    // Heading by *role*, not by tag name. `<div role="heading" aria-level="2">`
    // is ubiquitous in component libraries, and testing `localName` dropped
    // every one of them — taking the section label with it (F-10).
    const interactive = isInteractive(c.el, role);
    if (!interactive && !LANDMARK_ROLES.has(role) && role !== 'heading') continue;

    const nameStart = performance.now();
    let { name, source } = resolveName(c.el, RAW_NAME_MAX);
    // `role=generic` does not support name-from-content, so the spec-correct
    // accessible name of `<div tabindex="0">Publish draft</div>` is empty. That
    // is right for assistive tech and useless for us: the user sees the words
    // and will ask for them. We already decided this is a control — by the same
    // logic its label is its text. Kept out of `resolveName` so that function
    // stays spec-faithful; the product judgement lives where the product
    // knowledge is.
    // `isEditable` is the S-05 gate, not an optimisation: a `<div
    // contenteditable>` meets every condition on this line, and its text is
    // what the user typed. Without it a half-written draft became the element's
    // `name` and left the page with the rest of the table.
    if (!name && interactive && !PRIMARY_INTERACTIVE_ROLES.has(role) && !isEditable(c.el)) {
      const text = textOf(c.el).slice(0, RAW_NAME_MAX);
      if (text) [name, source] = [text, 'content'];
    }
    tName += performance.now() - nameStart;
    if (!name) stats.emptyName += 1;
    const rect = toRect(c.el);
    const ref = makeRef(frameId, ++n);

    const node: UINode = {
      ref,
      role,
      name,
      rect,
      inViewport: inViewport(rect),
      frameId,
      nameSource: source,
    };
    const state = resolveState(c.el, profile);
    if (state) node.state = state;
    if (isSensitive(c.el, role)) node.sensitive = true;
    // A `<div tabindex="0">` acting as a button has no ARIA role, so it is not
    // in the primary set — yet `isInteractive` accepted it and we paid to
    // extract it. Without this flag `project()` then dropped it, so the whole
    // div-button family was extracted and thrown away, and could never be
    // guided to. Caught by the eval corpus, not by any test.
    if (interactive && !PRIMARY_INTERACTIVE_ROLES.has(role)) node.focusable = true;

    const row = rowLabelOf(c.el);
    if (row) node.rowLabel = row;

    nodes.push(node);
    elOf.set(ref, c.el);
    refOf.set(c.el, ref);
    registry.stage(ref, c.el);
  }

  // Second pass: `parent` is the nearest emitted landmark/heading ancestor, so
  // it can only be resolved once every node has a ref.
  const byRef = new Map(nodes.map((x) => [x.ref, x]));
  for (const node of nodes) {
    const el = elOf.get(node.ref);
    if (!el) continue;
    const parent = nearestStructuralAncestor(el, refOf, byRef);
    if (parent) node.parent = parent;
  }

  stats.emitted = nodes.length;
  const t3 = performance.now();

  stats.ms = {
    walk: +(t1 - t0).toFixed(1),
    visibility: +(t2 - t1).toFixed(1),
    semantics: +(t3 - t2).toFixed(1),
    name: +tName.toFixed(1),
    total: +(t3 - t0).toFixed(1),
  };

  const snapshotId = nextSnapshotId();
  registry.commit(snapshotId);

  return {
    snapshotId,
    url: redactUrl(location.href),
    title: document.title,
    pageHash: pageFingerprint(nodes),
    profile,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nodes,
    // "Incomplete", not "slow". Nothing downstream can recover from a table
    // that is missing nodes; a table that took a while is merely a table.
    degraded: truncated.walk || truncated.semantics,
    stats,
  };
}

/**
 * The page's address as the user sees it, minus anything that looks like a
 * credential.
 *
 * This used to be `origin + pathname`, which silently dropped the query and the
 * fragment. That is not a small omission here: `?tab=issues`,
 * `?region=us-east-1` and `#/settings` are often the only thing that tells a
 * console page apart from its siblings, and the flow owner compares against
 * `tab.url`, which does carry them — so the two views of "where are we"
 * disagreed, and pack matching saw a URL the browser never showed.
 *
 * Restoring them means the address travels to the user's model endpoint intact,
 * so the parameters that carry secrets are removed first. This is not a general
 * secret scanner and must not be described as one: it strips the conventional
 * names, which is where tokens in URLs actually live, and nothing more.
 */
/**
 * Exact names and suffixes only — never a substring search.
 *
 * A looser pattern destroys ordinary page context, and the losses land exactly
 * where this product is weakest: `?stock_code=` is a data source's identity,
 * `?error_code=` is what a diagnosis needs, `?sort_key=` is the DynamoDB
 * console, and `author` / `keyword` merely contain `auth` / `key`.
 *
 * Bare `code` is deliberately absent. An OAuth `?code=` is short-lived and
 * single-use, so keeping it costs little; matching it would redact every
 * product code, country code and error code on the web.
 */
const SECRET_NAMES = new Set(
  [
    'token', 'access_token', 'accesstoken', 'id_token', 'idtoken', 'refresh_token',
    'auth_token', 'authtoken', 'authorization', 'api_key', 'apikey', 'access_key',
    'secret', 'client_secret', 'secret_key', 'password', 'passwd', 'pwd', 'pass',
    'sig', 'signature', 'session', 'sessionid', 'session_id', 'jsessionid',
    'phpsessid', 'credential', 'credentials', 'otp', 'code_verifier',
  ].map((s) => s.toLowerCase()),
);

const SECRET_SUFFIX = /(_|-)?(token|secret|signature|password)s?$/i;

/**
 * `code` alone is a product code, a country code, an error code. `code` next to
 * `state` is an OAuth authorization code — the most valuable thing that ever
 * travels in a URL.
 *
 * The companion parameter is what makes the two decidable apart, so it is what
 * the rule keys on. A blanket `code` rule would redact `?stock_code=` and
 * `?error_code=` on exactly the pages this product exists to explain.
 */
const OAUTH_COMPANIONS = ['state', 'code_verifier', 'session_state', 'id_token', 'access_token'];

const isSecretParam = (k: string, oauth: boolean): boolean => {
  const lk = k.toLowerCase();
  if (oauth && lk === 'code') return true;
  return SECRET_NAMES.has(lk) || SECRET_SUFFIX.test(k);
};

function redactParams(p: URLSearchParams): boolean {
  const oauth = OAUTH_COMPANIONS.some((c) => p.has(c));
  let hit = false;
  for (const k of [...p.keys()])
    if (isSecretParam(k, oauth)) {
      p.set(k, 'REDACTED');
      hit = true;
    }
  return hit;
}

export function redactUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }

  // `https://github.com@evil.com` reads as GitHub to a human and resolves to
  // evil.com. Always stripped, and always a reason to distrust the link.
  const hadUserinfo = Boolean(u.username || u.password);
  u.username = '';
  u.password = '';

  const hitQuery = redactParams(u.searchParams);
  // The fragment is where implicit OAuth returns tokens, and it is also where
  // SPA routes live — frequently in the same string, which is why an earlier
  // "only rewrite a fragment that is entirely parameters" rule let
  // `#/callback?id_token=…` through untouched.
  //
  // Splitting on `?` serves both: the route keeps its shape and the parameters
  // get the same treatment as the query. Round-tripping the whole fragment
  // through `URLSearchParams` — the obvious shortcut — turns `#/callback?x`
  // into `#%2Fcallback%3Fx` and destroys the one field that tells two SPA views
  // apart.
  let hitHash = false;
  const frag = u.hash.slice(1);
  if (frag.includes('=')) {
    const cut = frag.indexOf('?');
    const route = cut >= 0 ? frag.slice(0, cut) : '';
    const f = new URLSearchParams(cut >= 0 ? frag.slice(cut + 1) : frag);
    if (redactParams(f)) {
      u.hash = `#${route}${cut >= 0 ? '?' : ''}${f.toString()}`;
      hitHash = true;
    }
  }

  // Nothing matched: return the input untouched rather than `URL`'s normalised
  // re-serialisation, which changes percent-encoding and breaks the verbatim
  // comparisons this value takes part in.
  return hadUserinfo || hitQuery || hitHash ? u.toString() : href;
}

/**
 * Snapshot ids without `crypto.randomUUID()`.
 *
 * That API only exists in a **secure context**. `localhost` and `127.0.0.1`
 * count as one, which is why every fixture and every real site measured here
 * worked — and why the failure was invisible: on any plain-`http://` page with
 * a normal hostname the extractor threw on its last line and produced nothing.
 * Internal corporate consoles are exactly that shape, and they are the product's
 * stated target user.
 *
 * A snapshot id only has to be unique within this document's lifetime; it is a
 * generation guard, not a secret.
 */
let snapshotSeq = 0;
const SNAPSHOT_SALT = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const nextSnapshotId = (): string => `${SNAPSHOT_SALT}-${++snapshotSeq}`;

/**
 * Ancestor step that crosses shadow boundaries.
 *
 * `parentElement` and `closest()` both stop dead at a shadow root, so every
 * control inside one — 32 such roots on GitHub, 37 on MDN — could never be
 * given a section or a row label (F-10). Worse, that made the metric lie: the
 * fixture reported `ambiguity: 0%` partly because its shadow content was
 * invisible to disambiguation entirely.
 */
function parentAcross(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/**
 * `textContent` runs adjacent descendants together — GitHub's commit cell came
 * out as `'Latest commit 3 peoplechore(deps): bump '` (F-12), which is not a
 * label anyone could match on. Joining text nodes with a space fixes it and,
 * unlike `innerText`, forces no layout.
 */
function textOf(el: Element): string {
  // Skip editable subtrees even when the element itself is not editable: a
  // `<div tabindex="0">` wrapping a `<div contenteditable>` would otherwise
  // carry the user's text out through its own name. The caller already refuses
  // editable elements; this is the same rule applied one level down, because
  // the leak is silent and the cost of the second check is a filter callback.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && isEditable(n.parentElement)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let out = '';
  let guard = 0;
  while (walker.nextNode() && guard++ < 200) out += ` ${walker.currentNode.nodeValue ?? ''}`;
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Row identity: the first non-empty cell of the enclosing row. This is what
 * separates otherwise-identical per-row actions (`Delete ×20`) and, measured on
 * GitHub, what resolves the 14 identical commit links in the file table.
 */
function rowLabelOf(el: Element): string | undefined {
  let row: Element | null = el;
  for (let guard = 0; row && guard < 40; guard++) {
    if (row.matches('tr, [role="row"]')) break;
    row = parentAcross(row);
  }
  if (!row?.matches('tr, [role="row"]')) return undefined;
  for (const cell of row.querySelectorAll('th, td, [role="rowheader"], [role="gridcell"]')) {
    const t = textOf(cell);
    if (t) return t.slice(0, 40);
  }
  return undefined;
}

function nearestStructuralAncestor(
  el: Element,
  refOf: Map<Element, Ref>,
  byRef: Map<Ref, UINode>,
): Ref | undefined {
  let cur = parentAcross(el);
  let guard = 0;
  while (cur && guard++ < 40) {
    const ref = refOf.get(cur);
    if (ref) {
      const node = byRef.get(ref);
      if (node && (LANDMARK_ROLES.has(node.role) || node.role === 'heading')) return ref;
    }
    cur = parentAcross(cur);
  }
  return undefined;
}

function walk(
  root: Document | Element | ShadowRoot,
  depth: number,
  out: Candidate[],
  stats: ExtractStats,
  t0: number,
  truncated: { walk: boolean },
): void {
  if (depth > MAX_SHADOW_DEPTH) return;
  if (performance.now() - t0 > BUDGET_MS) {
    truncated.walk = true;
    return;
  }

  for (const el of root.querySelectorAll('*')) {
    // Our own overlay host carries `popover`, so it matches CANDIDATE_SELECTOR
    // and would otherwise be offered to the user as something to click.
    if (isOurs(el)) continue;
    stats.elementsScanned += 1;
    if (el.matches(CANDIDATE_SELECTOR)) {
      out.push({ el });
      stats.candidates += 1;
    }
    // Frames are a separate document; the frame protocol handles them.
    if (el.localName === 'iframe' || el.localName === 'frame') continue;
    const sr = el.shadowRoot; // open roots only — measured 32 on GitHub, 37 on MDN
    if (sr) {
      stats.shadowRoots += 1;
      walk(sr, depth + 1, out, stats, t0, truncated);
    }
  }
}
