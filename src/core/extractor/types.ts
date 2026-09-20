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
  stats: ExtractStats;
}
