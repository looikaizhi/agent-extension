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
  pageHash: string;
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
  /** Viewport bands to keep, 1 = ±1 screen. */
  viewportBands: number;
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
  sensitive?: true;
}

export interface PromptTable {
  snapshotId: string;
  url: string;
  title: string;
  pageHash: string;
  items: PromptItem[];
  truncated: boolean;
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
