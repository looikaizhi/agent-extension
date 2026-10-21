import type { NameSource, Rect, Ref, UIState } from '@/shared/types';

/**
 * One interactive element.
 *
 * S-05 is enforced at the type level: there is no `value`, `text` or `html`
 * field here, and there never will be. `tests/unit/architecture.spec.ts`
 * asserts the runtime key set matches this whitelist.
 */
export interface UINode {
  /* —— goes into the prompt —— */
  ref: Ref;
  /** Explicit ARIA role or HTML-AAM inferred role. Never null; 'generic' when undecidable. */
  role: string;
  name: string;
  /** Only present when non-empty, to save tokens. */
  state?: UIState[];
  /** Nearest extracted landmark / heading ancestor. Feeds `PromptItem.path[0]`. */
  parent?: Ref;
  /**
   * 控件旁边那句说明——它所在的最小语义容器的**直接**文字子节点。
   *
   * 和 `rowLabel` 同一类东西：DOM 派生、必须在这里算、喂给投影。区别在于 `rowLabel`
   * 回答「这是哪一行」，这个回答「这一块在讲什么」。
   *
   * **不递归**是这条的全部要害。Playwright 的 aria 快照在表格上爆掉，正是因为 accessible
   * name 在 row / cell / link 每一层各重算一遍，同一段提交信息在一个表格行里出现五次。
   * 只取直接文字子节点，一段字就只会出现在离它最近的那一层。
   */
  nearby?: string;
  /** Identity of the enclosing table row, if any. Feeds `PromptItem.path[1]`.
   *  DOM-derived, so it must be computed here even though `path` is assembled
   *  in `project()`. This is what separates GitHub's 14 identical row links. */
  rowLabel?: string;
  /** Credential / payment / 2FA input. Listed (diagnosis needs it) but never highlightable. */
  sensitive?: true;
  /** Absolute destination for link-like elements — see `PromptItem.href`. */
  href?: string;
  /** Interactive only through the focusability fallback — a `<div tabindex="0">`
   *  acting as a button. Its role is 'generic', so projection would otherwise
   *  drop it and the whole div-button family could never be guided to. */
  focusable?: true;

  /* —— never goes into the prompt —— */
  rect: Rect;
  inViewport: boolean;
  frameId: number;
  /** Drives the `emptyName` metric and name-fallback tuning. */
  nameSource: NameSource;
}

export type ExtractProfile = 'interactive' | '+context' | '+diagnostics';

/**
 * The full set. Lives only in the content script and is never serialised across
 * a process boundary — see K-4. Pruning happens in `project()`, so `relocate`
 * can still search for a target that scrolled out of view.
 */
/**
 * An embedded frame on the page, as much of it as can be read from outside.
 *
 * The content script runs in the top document only, and an extractor that
 * walked into a frame would be walking a document it cannot see into at all
 * when that frame is cross-origin. So a frame is not an element in the table:
 * it is a hole in it, and this is the hole's label. Saying 「你要的东西在一个
 * 嵌入框架里，我看不到」 is worth a great deal more than silently behaving as
 * though the page did not contain it.
 */
export interface FrameNote {
  /** `title`, `name` or `aria-label` — whatever the page author put there. */
  label: string;
  /** Where it comes from, when the address says: `js.stripe.com`. Empty for
   *  a frame with no `src`, or one written inline with `srcdoc`. */
  host: string;
}

export interface LocatorView {
  snapshotId: string;
  url: string;
  title: string;
  /** Landmark/heading structure only — never which page this is. That is `url`,
   *  compared as CONTEXT.md's `View`. */
  structureHash: string;
  profile: ExtractProfile;
  /** Captured here so `project()` stays free of DOM globals and can run in Node. */
  viewport: { width: number; height: number };
  nodes: UINode[];
  /** Watchdog tripped: traversal was cut short. Observable, never silent. */
  degraded: boolean;
  /** The frames big enough to hold something the user came for. */
  frames: readonly FrameNote[];
  stats: ExtractStats;
}

export interface ExtractStats {
  elementsScanned: number;
  candidates: number;
  visible: number;
  emitted: number;
  shadowRoots: number;
  emptyName: number;
  modalScoped: boolean;
  /** `name` is broken out of `semantics` because it is where the time actually
   *  goes — measured at 300 ms of MDN's 340 ms — and because a ratchet baseline
   *  needs the one number that moves. */
  ms: { total: number; walk: number; visibility: number; semantics: number; name: number };
}

/**
 * Token-budget policy. Belongs to projection, not to DOM extraction.
 *
 * `nameMaxLen` deliberately is **not** here: a name length participates in an
 * element's identity, and anything in this object is a per-caller knob. Having
 * it here let three callers pick three values and quietly produce three
 * different identities for one element. It is `NAME_MAX_LEN` in `project.ts`.
 */
export interface ProjectBudget {
  maxNodes: number;
}

export interface PromptItem {
  ref: Ref;
  role: string;
  name: string;
  /** Grouping path, e.g. ["Instances", "i-0abc · running"]. Serialised as group
   *  headers rather than per-node fields — an order of magnitude cheaper. */
  path: readonly string[];
  state?: UIState[];
  /** 控件旁边那句说明（`UINode.nearby`）。渲染成条目行末尾的 `· 说明`。 */
  nearby?: string;
  /**
   * `path[0]` 的 ARIA role，仅当它来自一个地标时。
   *
   * 只影响渲染（`toPromptText` 把组标题写成 `navigation "Repository"`），**不进 `Descriptor`、
   * 不进去重的键**——`scope` 仍然只用 `path` 的文字。这样分开是有意的：`bindStep` 的 scope 是
   * 子串包含匹配，把 role 混进那根字符串会让一次跨快照重绑多出一个可能变化的因子，
   * 而这条改动想买的只是「这一块是干什么的」这点语义。
   *
   * 为什么只有 `path[0]`：`pathOf` 里能带 role 的只有地标那一层，后面两层是标题文字与行标签。
   * 没有名字的地标照旧不进 path——给 `<main>` 开一个组会让整页多一级缩进，
   * 换来的只是一个词。
   */
  landmark?: string;
  /** Only when (path, role, name) is still not unique. */
  nth?: number;
  /**
   * Present only when the name is **not** text the user can read on screen.
   *
   * The test is visibility, not accessible-name status: `placeholder` renders
   * as grey text in an empty input, so it is exempt like `label` / `content`.
   * `alt` is not exempt — an icon button's alt text is never painted, so the
   * model still needs the flag or it will say "click the button that says X"
   * about text nobody can see.
   *
   * `aria-label` fails that same visibility test and is exempt anyway. That is
   * a deliberate carve-out on a second axis: an author writes an `aria-label`
   * for a human to hear, so it is nearly always sound prose, whereas `title` /
   * testid / href are machine strings. Flagging `aria-label` would fire on the
   * majority of icon buttons and drown the flag in noise.
   *
   * Serialised as a single bit (see `toPromptText`) — spelling out which
   * fallback it was would cost ~40x the tokens for something the model does
   * not need to know.
   */
  nameSource?: NameSource;
  sensitive?: true;
  /**
   * Where this control leads, absolute, for link-like elements only.
   *
   * Present so the **host** can tell a same-site step from one that leaves the
   * site *before* the user commits to it (07's P-2) — the promise is "you see
   * the destination before you go", which is impossible without knowing it.
   *
   * The page is the only honest source. The model cannot supply it (S-07: it
   * outputs refs, never URLs), and asking it to would invite exactly the
   * fabrication S-01's adversarial fixtures exist to catch.
   *
   * **Never serialised into the prompt** (`toPromptText`, and `href.spec.ts`
   * asserts it): deciding is the service worker's job (design doc §8.3), the
   * model has no use for it, and a screen of links would cost real tokens to
   * tell it something it must not act on.
   */
  href?: string;
}

export interface PromptTable {
  snapshotId: string;
  url: string;
  title: string;
  /** Landmark/heading structure only — never which page this is. That is `url`,
   *  compared as CONTEXT.md's `View`. */
  structureHash: string;
  items: PromptItem[];
  /** How many elements the budget cut from the document's tail. `0` means the
   *  table is the whole page. A count rather than a flag because the model is
   *  told the number: "there is more" and "there are 214 more" are different
   *  situations, and only one of them is worth changing plan over. */
  omitted: number;
  /** The 250 ms watchdog fired: this table is incomplete. Carried through from
   *  `LocatorView` because a degradation nobody downstream can see is not
   *  observable — the side panel and, in step 2, the agent both have to know
   *  they are looking at a partial page (F-12). */
  degraded: boolean;
  /** Share of items not uniquely identifiable from prompt-visible fields.
   *  Measurement only — never sent to a model. */
  ambiguity: number;
  /** Holes in this table: what is embedded on the page and cannot be seen
   *  into. Told to the model, because "not in the table" must not read as
   *  "not on the page" (`FrameNote`).
   *
   *  Optional, and absent means "this table says nothing about frames" —
   *  which is what a hand-written one, or one recorded before frames were
   *  looked at, honestly is. The one real producer (`project`) always sets
   *  it, because the extractor always knows. */
  frames?: readonly FrameNote[];
  /**
   * Where the items came from, when this table is more than one document:
   * the top frame first, then every embedded frame that was read into.
   *
   * The host needs it to send a command *back* to the right place — a ref
   * carries its frame (`makeRef` writes `f3e12`), but painting it needs that
   * frame's own `snapshotId` and its own address, because the renderer checks
   * both against the document it is actually running in.
   *
   * Absent on a single-document table, which is what every hand-written one
   * and every table recorded before frames were entered honestly is.
   */
  sources?: readonly TableSource[];
  stats: ExtractStats;
}

export interface TableSource {
  /** 0 is the top document. */
  frameId: number;
  snapshotId: string;
  url: string;
}
