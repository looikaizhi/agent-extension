import type { Ref } from '@/shared/types';
import { LANDMARK_ROLES, PRIMARY_INTERACTIVE_ROLES } from './roles';
import type { LocatorView, ProjectBudget, PromptItem, PromptTable, UINode } from './types';
import { withinBands } from './visibility';

/**
 * How long a name may be — **not** a budget knob, which is why it does not live
 * in `ProjectBudget`.
 *
 * It used to, and it had drifted to three different values: 120 in the host's
 * `LOCAL_BUDGET`, 80 from `budgetFor`, 80 as the content script's initial
 * `lastBudget`. Because the name is truncated *before* it becomes part of an
 * identity (see `describeAll` below), two extractions taken at two budgets
 * produced two different identities for the same element — so a descriptor
 * authored against one of them bound to nothing against the other. The path was
 * real: the host extracts at 120, the side panel's "抽取本页元素" overwrites
 * `lastBudget` with 80, and the guide's next `bindHere()` re-extracts at 80.
 *
 * Names that long are ARNs, resource paths and policy titles — the AWS console
 * case this product targets first — so the single value is the larger one. What
 * it costs in tokens is bounded by how many names exceed 80 characters, which
 * on every page measured here is a handful.
 */
export const NAME_MAX_LEN = 120;

/** Node caps follow §5.1 of the design doc; driven by the model's context window. */
export function budgetFor(contextWindow: number): ProjectBudget {
  const maxNodes = contextWindow < 16_000 ? 60 : contextWindow <= 64_000 ? 150 : 250;
  return { maxNodes, viewportBands: 1 };
}

/** A node together with the identity that must not depend on the viewport. */
export interface Described {
  node: UINode;
  item: PromptItem;
}

/**
 * Identity pass over the **full set** — every interactive node on the page,
 * regardless of where the user has scrolled.
 *
 * This split exists because of F-5. `nth` used to be assigned after pruning, on
 * the surviving slice, and pruning depends on scroll position: the same button
 * was `nth: 2` at the top of the page and had no `nth` at all further down. A
 * descriptor authored in one scroll position then bound to nothing in another,
 * which quietly voided K-6's guarantee that a unique match is a correct match.
 *
 * The old comment here argued that "uniqueness is a property of the projected
 * set, so nth can only be computed after pruning". That is precisely backwards:
 * `nth` is part of a *durable identity*, so it must be a property of the page.
 * Uniqueness within the projected set is what `ambiguity` measures, and that is
 * a different question.
 *
 * (Named `describeAll` rather than `describe` only to stay out of the way of
 * vitest's global of the same name.)
 */
export function describeAll(view: LocatorView, budget: ProjectBudget): readonly Described[] {
  const byRef = new Map<Ref, UINode>(view.nodes.map((n) => [n.ref, n]));
  const headings = headingsBefore(view, byRef);
  const targets = view.nodes.filter((n) => PRIMARY_INTERACTIVE_ROLES.has(n.role) || n.focusable);

  const described: Described[] = targets.map((node) => {
    const item: PromptItem = {
      ref: node.ref,
      role: node.role,
      // Truncated before keying, so two names that differ only past the budget
      // are treated as the collision they will look like to the consumer.
      name: truncate(node.name, NAME_MAX_LEN),
      path: pathOf(node, byRef, headings),
    };
    if (node.state) item.state = node.state;
    // Marked when the name is not text the user can read on screen — not the
    // same split as accessible-name status. `placeholder` renders as grey
    // text in an empty input, so it stays unmarked alongside `label` /
    // `content`; `alt` does not, because an icon's alt text is never painted.
    if (
      node.nameSource !== 'aria-label' &&
      node.nameSource !== 'aria-labelledby' &&
      node.nameSource !== 'label' &&
      node.nameSource !== 'content' &&
      node.nameSource !== 'placeholder'
    )
      item.nameSource = node.nameSource;
    if (node.sensitive) item.sensitive = true;
    // Carried to the host, never to the model — `toPromptText` does not
    // serialise it and `href.spec.ts` asserts that it never will.
    if (node.href) item.href = node.href;
    return { node, item };
  });

  assignNth(described.map((d) => d.item));
  return described;
}

/**
 * Pure function: full set → prompt table. No DOM, no agent dependency, so the
 * eval harness can call it before any agent code exists.
 *
 * Selection only — identity is already fixed by `describeAll`, and nothing here
 * may touch `path` or `nth`.
 */
export function project(view: LocatorView, budget: ProjectBudget): PromptTable {
  const { kept, truncated } = prune(describeAll(view, budget), budget, view, budget.viewportBands);
  return tableOf(view, kept.map((d) => d.item), truncated);
}

/**
 * Every described node — no viewport band, no budget cut.
 *
 * This is what late binding searches, and it must be the whole page. The
 * projected table exists to fit a prompt; using it as the search space made a
 * perfectly ordinary step ("the next button is further down") bind to nothing,
 * because the target had been pruned for being off screen (F-6). Token budget
 * is a constraint on what we *say*, never on what we can *find*.
 */
export function fullTable(view: LocatorView, budget: ProjectBudget): PromptTable {
  return tableOf(view, describeAll(view, budget).map((d) => d.item), false);
}

function tableOf(view: LocatorView, items: PromptItem[], truncated: boolean): PromptTable {
  return {
    snapshotId: view.snapshotId,
    url: view.url,
    title: view.title,
    pageHash: view.pageHash,
    items,
    truncated,
    degraded: view.degraded,
    ambiguity: ambiguityOf(items),
    stats: view.stats,
  };
}

/**
 * Truncate in the middle, not at the tail.
 *
 * Long names are ARNs, paths, URLs and policy titles, and what makes two of
 * them different is almost always at the *end*. Tail truncation therefore
 * removes exactly the discriminating information: the eval corpus had two
 * buttons whose first 80 characters were identical, and cutting the tail made
 * them the same string — an ambiguity we manufactured ourselves.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  return `${s.slice(0, head)}…${s.slice(-(max - 1 - head))}`;
}

/**
 * Score-then-restore-document-order. A plain document-order cut would
 * systematically drop main-content controls: the first 250 elements of a
 * console are almost all global nav, while the button the user wants is in
 * <main>.
 */
function prune(
  described: readonly Described[],
  budget: ProjectBudget,
  view: LocatorView,
  bands: number,
): { kept: readonly Described[]; truncated: boolean } {
  if (described.length <= budget.maxNodes) return { kept: described, truncated: false };

  const scored = described.map((d, order) => ({ d, order, score: score(d.node, view, bands) }));
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const kept = scored
    .slice(0, budget.maxNodes)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.d);
  return { kept, truncated: true };
}

/**
 * Proximity to the viewport is a *preference*, not a filter.
 *
 * It used to be both: `project()` first dropped everything outside ±1 viewport
 * and then pruned to the budget — so information was discarded even when there
 * was budget left over. Real-world consequence: a control 1400 px down could
 * not be located until the user scrolled to it, which inverts the product (the
 * user is asking *us* where it is). The budget is the only thing that has to
 * cut; distance only decides who gets cut first.
 */
function score(n: UINode, view: LocatorView, bands: number): number {
  let s = 0;
  s += n.inViewport ? 4 : withinBands(n.rect, bands, view.viewport) ? 2 : 1;
  if (PRIMARY_INTERACTIVE_ROLES.has(n.role)) s += 2;
  if (n.name.length > 0) s += 1;
  else s -= 3;
  if (n.sensitive) s -= 1;
  return s;
}

/** Every enclosing landmark, nearest first — landmarks genuinely do wrap their
 *  contents, which is exactly what headings do not. */
function landmarkChain(n: UINode, byRef: Map<Ref, UINode>): UINode[] {
  const out: UINode[] = [];
  let cur = n.parent ? byRef.get(n.parent) : undefined;
  let guard = 0;
  while (cur && guard++ < 12) {
    if (LANDMARK_ROLES.has(cur.role)) out.push(cur);
    cur = cur.parent ? byRef.get(cur.parent) : undefined;
  }
  return out;
}

/**
 * For every node, the heading that most recently *preceded* it in document
 * order within the same landmark.
 *
 * This is F-9, and it was the single largest disambiguation loss: on Stripe, 96
 * of 108 controls had an empty `path` and ambiguity sat at 18.5% against a ≤5%
 * gate. The first implementation looked for a heading by walking *up* the
 * ancestor chain — but HTML almost never nests a section's content inside its
 * `<h2>`; the heading is a preceding sibling. The design prototype scanned
 * document order and measured 0%, and that difference is the whole gap.
 *
 * One forward pass, so this stays O(n) rather than a backward scan per node.
 *
 * The bound is *containment*, not equality: a heading applies to everything
 * inside its own landmark, including nested ones. Requiring the two landmarks
 * to be identical looked reasonable and measured badly — on Stripe, controls sit
 * in `div[role="toolbar"]` (a landmark) while the heading sits in `main`, so the
 * heading was discarded and the path collapsed to "Actions", which every one of
 * those toolbars is called. Path coverage 47%, ambiguity 8.3%.
 */
function headingsBefore(view: LocatorView, byRef: Map<Ref, UINode>): Map<Ref, string> {
  const out = new Map<Ref, string>();
  let last: { name: string; landmark: Ref | undefined } | null = null;
  for (const n of view.nodes) {
    const chain = landmarkChain(n, byRef);
    if (last && (last.landmark === undefined || chain.some((l) => l.ref === last!.landmark)))
      out.set(n.ref, last.name);
    if (n.role === 'heading' && n.name) last = { name: n.name, landmark: chain[0]?.ref };
  }
  return out;
}

/**
 * Grouping path. Serialised as group headers by `toPromptText`, not as a
 * per-node field: 150 nodes × 7 tokens ≈ 1050 tokens versus ~15 groups × 6
 * tokens ≈ 90 for the same information.
 */
function pathOf(
  n: UINode,
  byRef: Map<Ref, UINode>,
  headings: Map<Ref, string>,
): readonly string[] {
  const out: string[] = [];

  const landmark = landmarkChain(n, byRef)[0];
  if (landmark?.name) out.push(landmark.name);

  const heading = headings.get(n.ref);
  if (heading && heading !== landmark?.name) out.push(heading);

  if (n.rowLabel) out.push(n.rowLabel);

  return out;
}

/** Last-resort ordinal, only where (path, role, name) is still not unique. */
function assignNth(items: PromptItem[]): void {
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    if ((counts.get(k) ?? 0) > 1) {
      const i = (seen.get(k) ?? 0) + 1;
      seen.set(k, i);
      it.nth = i;
    }
  }
}

const keyOf = (it: PromptItem) => `${it.path.join('›')}|${it.role}|${it.name}`;

/** Share of items not uniquely identifiable by (path, role, name).
 *  `nth` is excluded from the key on purpose: it makes uniqueness true by
 *  construction, so including it would make this metric always report 0. */
function ambiguityOf(items: readonly PromptItem[]): number {
  if (!items.length) return 0;
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let dup = 0;
  for (const it of items) if ((counts.get(keyOf(it)) ?? 0) > 1) dup += 1;
  return +((dup / items.length) * 100).toFixed(1);
}

/**
 * The text actually sent to the model. Group-header serialisation: `path` is
 * written once per run of items that share it, not repeated per item.
 *
 * One item per line, keys unnamed: `ref role "name"` rather than
 * `ref: e1  role: link  name: "x"`. The named form repeats three key names on
 * every line — measured at 150 items, 7623 characters. This form drops them:
 * 4366 characters for the same 150 items, a 43% cut, with zero information
 * loss.
 *
 * Two marks carry information the shape alone can't: `~` before the name
 * means the name is not text the user can read on screen — it came from a
 * fallback (`title`, `href`, testid, …), so the model is describing the
 * control by a string nobody sees painted. `!secret` means this is a
 * credential input; unmarked, the model will propose it as a step, and S-03
 * hard-rejects it at the render boundary — the user sees a step silently
 * vanish instead of never being offered it.
 *
 * Headers follow document order, not a `path`-keyed bucket: a header is
 * written once per *contiguous run* of items that share a `path`, so a
 * `path` that gets interrupted by a different one and then resumes (A, B,
 * A) prints its header twice. That is deliberate, not an oversight —
 * bucketing by `path` would reorder the items to make the runs contiguous,
 * and document order is itself information the model uses: it mirrors how
 * the page reads and is exactly what `score()` prioritises. An extra header
 * line costs a handful of tokens; silently reordering controls costs the
 * thing document order exists to preserve.
 */
export function toPromptText(table: PromptTable): string {
  const lines: string[] = [];
  let lastPath: string | undefined;
  for (const it of table.items) {
    const p = it.path.join('›');
    if (p !== lastPath) {
      lastPath = p;
      if (p) lines.push(`## ${it.path.join(' › ')}`);
    }
    const mark = it.nameSource ? '~' : '';
    const tail = [
      it.nth !== undefined ? `#${it.nth}` : '',
      it.state?.length ? `[${it.state.join(',')}]` : '',
      it.sensitive ? '!secret' : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`${it.ref} ${it.role} ${mark}${JSON.stringify(it.name)}${tail ? ` ${tail}` : ''}`);
  }
  return lines.join('\n');
}
