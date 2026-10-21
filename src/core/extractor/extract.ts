import { makeRef, type Ref } from '@/shared/types';
import { isSensitive } from '@/core/security/sensitive';
import { structureFingerprint } from './fingerprint';
import { redactUrl } from '@/shared/view';
import { registry } from './registry';
import {
  CANDIDATE_SELECTOR,
  isEditable,
  isInteractive,
  LANDMARK_ROLES,
  PRIMARY_INTERACTIVE_ROLES,
} from './roles';
import { resolveName, resolveRole, resolveState } from './semantics';
import type { ExtractProfile, ExtractStats, FrameNote, LocatorView, UINode } from './types';
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
  const embedded: Element[] = [];
  const truncated = { walk: false, semantics: false };
  walk(scope, 0, candidates, stats, t0, truncated, embedded);
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

    // Where a link leads, absolute — the host's only way to tell a same-site
    // step from one that leaves the site *before* the user commits to it
    // (07's P-2). Read from the element, because the page is the only honest
    // source: the model outputs refs and never URLs (S-07).
    //
    // `el.href` on an anchor is already resolved against the document, which
    // is what makes a relative `/help` usable here. A `javascript:` or bare
    // `#fragment` destination is not a navigation and is deliberately skipped
    // — asking the user to confirm leaving the site to go nowhere would train
    // them to dismiss the card without reading it.
    if (c.el instanceof HTMLAnchorElement && c.el.href) {
      const raw = c.el.getAttribute('href') ?? '';
      if (!raw.startsWith('#') && !/^javascript:/i.test(raw)) node.href = c.el.href;
    }

    const row = rowLabelOf(c.el);
    if (row) node.rowLabel = row;

    const near = nearbyTextOf(c.el, name);
    if (near) node.nearby = near;

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
    structureHash: structureFingerprint(nodes),
    profile,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    nodes,
    // "Incomplete", not "slow". Nothing downstream can recover from a table
    // that is missing nodes; a table that took a while is merely a table.
    degraded: truncated.walk || truncated.semantics,
    frames: framesOf(embedded),
    stats,
  };
}

/** Big enough to hold something the user came for, biggest first, at most a
 *  handful. A tracking pixel and a 0×0 frame are not holes in the page; saying
 *  so for every one of them would bury the one frame that matters. */
const FRAME_MIN = { width: 120, height: 60 };
const FRAMES_MAX = 5;

function framesOf(embedded: readonly Element[]): FrameNote[] {
  return embedded
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => rect.width >= FRAME_MIN.width && rect.height >= FRAME_MIN.height && isVisible(el))
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
    .slice(0, FRAMES_MAX)
    .map(({ el }) => ({
      label: (el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('aria-label') || '').slice(0, 60).trim(),
      // Only the host: the rest of an embedded frame's address is query and
      // token soup, and the host is the part that says whose it is.
      host: hostOf(el.getAttribute('src')),
    }));
}

function hostOf(src: string | null): string {
  if (!src) return '';
  try {
    return new URL(src, location.href).host;
  } catch {
    return '';
  }
}

/**
 * A registry-free companion to `extract()`, computing exactly the hash a full
 * extraction's `LocatorView.structureHash` would carry (`structureFingerprint`, same
 * landmark/heading filter) — without ever calling `registry.stage`/`registry.
 * commit`.
 *
 * Why this cannot just be "`extract()`, then read `.structureHash`": `registry` is
 * one global generation, not scoped per caller (`registry.ts`'s own doc
 * comment) — `extract()` unconditionally commits a fresh one on every call.
 * The structure watcher (the `changed` reading, CONTEXT.md `Reading`) re-checks
 * the page's structural hash after DOM mutations, from a background watcher
 * that has no idea whether a guide step or an answer's outline currently has
 * something resolved against
 * whatever generation is live right now. Calling `extract()` for that would
 * silently invalidate all of it — a background structure check landing
 * between two unrelated `HIGHLIGHT` commands would make the next one fail
 * with a stale-snapshot refusal for a reason nobody watching would ever
 * connect back to a page-structure poll.
 *
 * Reuses the exact same candidate discovery `extract()` itself uses (`walk`:
 * shadow-DOM traversal, modal scoping, the watchdog budget) and the same
 * `resolveRole`/`resolveName` — this is *not* a second, independently-tuned
 * scanner (05's Gotchas: "S2 不需要、也不应该重新发明一个更敏感或更迟钝的指
 * 纹算法"). It only omits everything downstream of role/name that solely
 * interactive elements need (state, sensitivity, rect, `rowLabel`, refs) and
 * the registry commit itself — nothing here can ever be resolved back to a
 * live element, which is exactly right: nothing that calls this needs one.
 */
export function extractStructureHash(): string {
  const t0 = performance.now();
  const stats: ExtractStats = {
    elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
    ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
  };
  const modal = findModalScope(document);
  const scope: Document | Element = modal ?? document;
  const candidates: Candidate[] = [];
  walk(scope, 0, candidates, stats, t0, { walk: false }, []);

  const nodes: { role: string; name: string }[] = [];
  for (const c of candidates) {
    if (!isVisible(c.el)) continue;
    const role = resolveRole(c.el);
    if (!LANDMARK_ROLES.has(role) && role !== 'heading') continue;
    nodes.push({ role, name: resolveName(c.el, RAW_NAME_MAX).name });
  }
  return structureFingerprint(nodes);
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

/** 旁注最多留这么长。够说清「这一块在讲什么」，不够把一段正文搬进来。 */
const NEARBY_MAX = 80;

/** 里面是不是装着可交互的东西。装着就不是「说明文字」，是另一片控件区。 */
const HAS_CONTROL = 'a,button,input,select,textarea,summary,[role],[tabindex],[onclick],[contenteditable]';

/**
 * 一层容器里的「说明文字」：它的直接文字子节点，加上那些**自己不含任何控件**的子元素的文字。
 *
 * 两半都要。只取直接文字子节点在真实页面上几乎永远是空的——说明往往写在
 * `<span>`、`<p>`、`<small>` 里，是控件的兄弟而不是祖先的裸文本。而放开到「整棵子树的文字」
 * 就会把邻近的控件名一起卷进来，那正是 Playwright 的 aria 快照在表格上同一段字出现五次的原因。
 * 「不含控件的子元素」这条线把两者分开：散文进来，控件区不进来。
 */
function proseOf(el: Element): string {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += ` ${n.nodeValue ?? ''}`;
    else if (n.nodeType === 1) {
      const e = n as Element;
      if (e.matches(HAS_CONTROL) || e.querySelector(HAS_CONTROL)) continue;
      out += ` ${e.textContent ?? ''}`;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * 控件旁边那句说明：从它自己往上走，取**第一个**说出新东西的祖先。
 *
 * 三条约束，每一条都是为了不把 Playwright 那个坑重挖一遍：
 *
 * - **只算不含控件的那部分**（`proseOf`）——见上。
 * - **只走 4 层**。「旁边」必须是旁边；走到 40 层就成了「这一页上有的字」。
 * - **和名字互相包含就跳过继续往上**。`<a>Code</a>` 那一层的文字就是它自己的名字，
 *   再写一遍只是重复；跳过去才可能拿到外面那句真正的说明。
 */
function nearbyTextOf(el: Element, name: string): string | undefined {
  const n = norm(name);
  let cur: Element | null = parentAcross(el);
  for (let guard = 0; cur && guard < 4; guard++) {
    // 这一层里除了它自己还有别的控件 —— 那这一层的散文说的是**这一组**，不是这一个，
    // 到此为止。少了这一条，往上走总会撞到一个大到页面级的祖先，于是每一条控件后面
    // 都挂着同一段标题：实测 354/355 条都拿到旁注、+2648 token，全是噪音。
    // AgentOccam 说的「加信息反而变差」就是这个形状。
    if (cur.querySelectorAll(HAS_CONTROL).length > 1) return undefined;
    const t = proseOf(cur);
    const c = norm(t);
    if (c && (!n || (!c.includes(n) && !n.includes(c)))) return t.slice(0, NEARBY_MAX);
    cur = parentAcross(cur);
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
  /** Frames met on the way: collected, never walked into (`FrameNote`). */
  embedded: Element[],
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
    // A separate document, and the content script does not run in it: what is
    // inside cannot be read at all. It is written down as a hole in the table
    // rather than passed over in silence — see `FrameNote`.
    if (el.localName === 'iframe' || el.localName === 'frame') {
      embedded.push(el);
      continue;
    }
    const sr = el.shadowRoot; // open roots only — measured 32 on GitHub, 37 on MDN
    if (sr) {
      stats.shadowRoots += 1;
      walk(sr, depth + 1, out, stats, t0, truncated, embedded);
    }
  }
}
