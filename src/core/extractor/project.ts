import type { Ref } from '@/shared/types';
import { ENTRANCE_LANDMARK_ROLES, LANDMARK_ROLES, PRIMARY_INTERACTIVE_ROLES } from './roles';
import type { LocatorView, ProjectBudget, PromptItem, PromptTable, UINode } from './types';

/**
 * How long a name may be — **not** a budget knob, which is why it does not live
 * in `ProjectBudget`.
 *
 * It used to, and it had drifted to three different values: 120 in the retired
 * local matcher's budget, 80 from `budgetFor`, 80 as the content script's initial
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

/**
 * Node caps, driven by the model's context window.
 *
 * The middle rung is the measured one. Live traffic fits `prompt ≈ 25.8 ×
 * elements + 2593`, so 400 elements on a 64k window costs about 10.7k — a sixth
 * of it — against the 6.3k the old 150 was spending. That is the trade CONTEXT.md's
 * `Element table` records: 20 of 20 repository pages came back truncated at 150, and the
 * navigation the user needed was missing from 7 of 31 snapshots. The cap stops
 * being a knife that cuts every page and becomes a guard rail an extreme one
 * reaches, which only works if reaching it is genuinely rare.
 *
 * The other two rungs are proportion, not measurement, and should be read that
 * way. 120 on a 16k window is a *third* of it once the 2.6k intercept is
 * counted — small windows cannot buy the same headroom. 800 is extrapolation:
 * nothing above 64k has been measured here at all.
 *
 * The top rung has to stay the largest, which it did not have to be before:
 * raising the middle to 400 while leaving the top at 250 would have made a
 * bigger context window buy a smaller table.
 */
export function budgetFor(contextWindow: number): ProjectBudget {
  const maxNodes = contextWindow < 16_000 ? 120 : contextWindow <= 64_000 ? 400 : 800;
  return { maxNodes };
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
export function describeAll(view: LocatorView): readonly Described[] {
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
  const byRef = new Map<Ref, UINode>(view.nodes.map((n) => [n.ref, n]));
  // Lossless first, budget second. Unwrapping is not a way of saving room — it
  // runs even when there is room to spare, because a table that names the same
  // target twice is worse for the reader either way.
  const { kept, omitted } = prune(dropRestatements(describeAll(view), byRef), budget, byRef);
  return tableOf(view, kept.map((d) => d.item), omitted);
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
export function fullTable(view: LocatorView): PromptTable {
  return tableOf(view, describeAll(view).map((d) => d.item), 0);
}

function tableOf(view: LocatorView, items: PromptItem[], omitted: number): PromptTable {
  return {
    snapshotId: view.snapshotId,
    url: view.url,
    title: view.title,
    pageHash: view.pageHash,
    items,
    omitted,
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
 * Entrances first, then document order, then cut the tail (CONTEXT.md `Element table`, `Entrance`).
 *
 * What this replaces is a score: viewport +4 / within a band +2 / off screen
 * +1, plus small bonuses for role and name. It ranked by *proximity to what the
 * user happens to be looking at*, which made the discard position drift with
 * the scroll — measured on one page, scrolling to the file list dropped the
 * navigation, and scrolling to the top dropped the sidebar instead. Whatever
 * was on screen won, and the budget was spent on it.
 *
 * Ranking by relevance to the goal is not the fix, and was measured too: the
 * lexical scorer already in the tree scores five of seven real targets below
 * its own discard threshold, because the user types Chinese and the page is in
 * English — 「CI 是怎么配置的」 against a control named `Actions` shares no
 * trigram. It also *keeps* noise, promoting a commit message containing "ci".
 * Answering "which of these matters most" needs a trained cross-encoder, which
 * is what the one framework that does it uses.
 *
 * So this answers two questions that have definite answers instead: is this an
 * entrance, and where does it sit in the document. Entrances are taken first
 * but are not exempt from the budget — a page whose entrances alone overflow
 * still gets a clean tail cut rather than an oversized table.
 */
function prune(
  described: readonly Described[],
  budget: ProjectBudget,
  byRef: Map<Ref, UINode>,
): { kept: readonly Described[]; omitted: number } {
  if (described.length <= budget.maxNodes) return { kept: described, omitted: 0 };

  const ordered = described.map((d, order) => ({ d, order, entrance: inEntrance(d.node, byRef) }));
  const kept = [...ordered.filter((o) => o.entrance), ...ordered.filter((o) => !o.entrance)]
    .slice(0, budget.maxNodes)
    .sort((a, b) => a.order - b.order)
    .map((o) => o.d);
  return { kept, omitted: described.length - budget.maxNodes };
}

/** Whether any enclosing landmark exists to take the user somewhere else. */
function inEntrance(n: UINode, byRef: Map<Ref, UINode>): boolean {
  for (const a of ancestors(n, byRef)) if (ENTRANCE_LANDMARK_ROLES.has(a.role)) return true;
  return false;
}

/**
 * Drop the shells that say the same target a second time — `CONTEXT.md`'s
 * `Restatement`.
 *
 * `describeAll` emits anything focusable, not only the primary interactive
 * roles, because a `<div tabindex="0">` really is a button. The cost is that a
 * focusable shell around a single real control arrives as its own row, and the
 * table then names one target twice.
 *
 * The criterion is deliberately structural, not textual. An earlier draft
 * deleted a row whose *name contained another row's name*; on the very fixture
 * built to exercise it, that would have deleted a sibling link pointing at a
 * different URL — losing a target, which is the one thing this may not do. A
 * shell wrapping exactly one interactive descendant can go, because clicking
 * that descendant is the only thing the shell could have offered. Two
 * descendants and it is a region, not a shell; an interactive role of its own
 * and it is a target, not a shell.
 *
 * Counting only *interactive* descendants is what makes nested shells collapse.
 * Counting every emitted descendant instead — the first version did — leaves
 * the outer one standing the moment two shells nest, because the inner shell
 * counts as a second descendant. Playwright MCP's `unwrapSingleChildGenerics`,
 * which this follows, gets the same effect by recursing.
 *
 * Honest about its reach: on the current eval corpus this removes nothing,
 * because no fixture contains such a shell. How common they are on real pages
 * is unmeasured — the live logs record no parent links, so the 29 fallback-name
 * rows seen there cannot be checked for wrapping after the fact.
 */
function dropRestatements(
  described: readonly Described[],
  byRef: Map<Ref, UINode>,
): readonly Described[] {
  const emitted = new Set(described.map((d) => d.node.ref));
  const interactiveBelow = new Map<Ref, number>();
  for (const { node } of described) {
    if (!PRIMARY_INTERACTIVE_ROLES.has(node.role)) continue;
    for (const a of ancestors(node, byRef))
      if (emitted.has(a.ref)) interactiveBelow.set(a.ref, (interactiveBelow.get(a.ref) ?? 0) + 1);
  }
  return described.filter(
    (d) =>
      PRIMARY_INTERACTIVE_ROLES.has(d.node.role) ||
      (interactiveBelow.get(d.node.ref) ?? 0) !== 1,
  );
}

/**
 * Enclosing nodes, nearest first.
 *
 * Bounded rather than trusting the tree: `parent` refs arrive over a message
 * channel from a page we do not control, and a cycle here would hang the
 * content script. Twelve is deep enough for every real landmark nesting seen
 * and shallow enough to cost nothing.
 */
function* ancestors(n: UINode, byRef: Map<Ref, UINode>): Generator<UINode> {
  let cur = n.parent ? byRef.get(n.parent) : undefined;
  let guard = 0;
  while (cur && guard++ < 12) {
    yield cur;
    cur = cur.parent ? byRef.get(cur.parent) : undefined;
  }
}

/** Every enclosing landmark, nearest first — landmarks genuinely do wrap their
 *  contents, which is exactly what headings do not. */
function landmarkChain(n: UINode, byRef: Map<Ref, UINode>): UINode[] {
  return [...ancestors(n, byRef)].filter((a) => LANDMARK_ROLES.has(a.role));
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
 * The text actually sent to the model.
 *
 * Two page-level lines first, then the elements as an indented tree.
 *
 * `page` / `title` answer "where am I", which nothing else in this prompt
 * does. Without them five live journeys re-proposed a control the user had
 * just used: the model clicked `Code`, the URL went from `/n8n-io/n8n/pulls`
 * to `/n8n-io/n8n`, and with no way to see that it proposed `Code` again —
 * 35% of every repeat measured on github.com traces to this one gap. Both are
 * what browser-use sends every turn as `Current url:` / `Available tabs:`.
 *
 * The URL is reduced to `host + path + query`: the scheme is noise (every
 * page is https) and the fragment never changes what page you are on. It is
 * deliberately *not* the whole story on `href` — see `href.spec.ts`. Element
 * hrefs stay out of the prompt entirely (§8.2): thirty attacker-authored
 * destinations are a menu the model could pick a request target from, while
 * the address the user is already at is a fact about where they stand. The
 * model still has no field anywhere in the contract that carries a URL.
 *
 * Both values are page-controlled, so both are `JSON.stringify`-quoted like
 * every name here — a title containing a newline would otherwise forge a
 * line of our own header format. Structural safety against the *wrapper*
 * remains the nonce's job (`context/user-message.ts`), and `nonceFor` sees these lines
 * because they are part of what it hashes.
 *
 * Indentation, not `## a › b › c` group headers. The flat form was chosen to
 * save tokens (150 nodes × 7 ≈ 1050 as per-node fields, versus ~15 group
 * headers ≈ 90) and it does — but D2Snap (arXiv 2508.04412) measures
 * hierarchy as the strongest single feature for LLM page understanding, and
 * the representations that flatten it (accessibility trees, reader views)
 * score materially worse. A real prompt here measures 3488 tokens against a
 * 32k window: the 960 tokens the flat form saves were never the constraint.
 * Shared prefixes are still printed once, so the tree form is *cheaper* than
 * repeating `## a › b › c` per run, not dearer.
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
 * Groups follow document order, not a `path`-keyed bucket: a group is opened
 * per *contiguous run* of items sharing it, so a `path` that gets interrupted
 * by a different one and then resumes (A, B, A) opens `A` twice. That is
 * deliberate, not an oversight — bucketing by `path` would reorder the items
 * to make the runs contiguous, and document order is itself information the
 * model uses: it mirrors how the page reads, and it is also the
 * order `prune` cuts along. A repeated group line costs a handful of tokens;
 * silently
 * reordering controls costs the thing document order exists to preserve.
 */
export function toPromptText(table: PromptTable, fresh?: ReadonlySet<Ref>): string {
  const lines: string[] = [`page ${JSON.stringify(pageLabel(table.url))}`];
  if (table.title) lines.push(`title ${JSON.stringify(truncate(table.title, NAME_MAX_LEN))}`);
  // Said out loud, because the reader cannot tell otherwise. `prune` cuts the
  // document's tail once the budget is spent, and a live run had 45 of 98 calls
  // reading a table that had been cut — with nothing in the text to say so. The
  // model then reasons from "not in the
  // table" to "not on the page", and both of the wrong answers that follow
  // were observed: it re-proposed a control on a page whose content it had
  // simply not been shown, and it asked the user for help on pages that did
  // have an entrance.
  if (table.omitted > 0)
    lines.push('truncated 这一页元素太多，下面只是其中一部分；导航一类的入口已优先保留');

  let prev: readonly string[] = [];
  for (const it of table.items) {
    let shared = 0;
    while (shared < prev.length && shared < it.path.length && prev[shared] === it.path[shared]) shared += 1;
    // Only the levels this item does not already share with the previous one.
    for (let i = shared; i < it.path.length; i += 1)
      lines.push(`${'  '.repeat(i)}${flatten(it.path[i] ?? '')}:`);

    const mark = it.nameSource ? '~' : '';
    const tail = [
      it.nth !== undefined ? `#${it.nth}` : '',
      it.state?.length ? `[${it.state.join(',')}]` : '',
      it.sensitive ? '!secret' : '',
      // Only ever set when the page did not navigate — see `CallModelParams`.
      // A click that opens a menu leaves the reader with the same few hundred
      // rows and no clue which dozen of them just appeared; measured live, one
      // journey clicked the same button five times while the control it wanted
      // sat in the panel that button had opened.
      fresh?.has(it.ref) ? '+new' : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `${'  '.repeat(it.path.length)}${it.ref} ${it.role} ${mark}${JSON.stringify(it.name)}${tail ? ` ${tail}` : ''}`,
    );
    prev = it.path;
  }
  // Last thing read, right where the decision gets made. The header line above
  // says the same thing, ~2300 tokens earlier on a full page — and a live run
  // had the model reason from "not in the table" to "not on the page" anyway.
  // The count is here because "there is more" and "there are 214 more" are
  // different situations: browser-use's `[End of page]` works for the same
  // reason, it gives the reader a position rather than a boolean.
  //
  // It does *not* claim the missing elements are a contiguous run at the end of
  // the document, which an earlier wording did and which `prune` makes false:
  // entrances are taken first, so a late one survives while an earlier ordinary
  // control is dropped. Saying "everything after here is missing" would be a
  // lie the model could act on.
  //
  // Not forgeable from page content, though it sits inside the untrusted
  // wrapper with the header lines. A group header is the only line built
  // without `JSON.stringify`, and it always ends in `:`; every element line
  // carries a quoted name. Neither can end in `]`.
  if (table.omitted > 0) lines.push(`[表到此为止 · 这一页还有 ${table.omitted} 个元素没有列出]`);
  return lines.join('\n');
}

/** The address minus the two parts that carry no signal: the fragment (it
 *  does not change which page you are on) and an `http(s)://` prefix (every
 *  page has one). Any other scheme is kept — `about:blank` and
 *  `chrome://extensions` are real pages a guide can be sitting on, and there
 *  the scheme *is* the identity. Middle-truncated like a name, so a long
 *  query keeps the tail that tells two of them apart. */
function pageLabel(raw: string): string {
  try {
    const u = new URL(raw);
    const withoutHash = u.href.slice(0, u.href.length - u.hash.length);
    return truncate(withoutHash.replace(/^https?:\/\//, ''), NAME_MAX_LEN);
  } catch {
    return truncate(raw, NAME_MAX_LEN);
  }
}

/** A newline inside a page-authored group name would forge a level in the
 *  indented tree, the way it would forge a header line before it. */
const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();
