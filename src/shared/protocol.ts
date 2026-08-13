import type { ExtractProfile, ProjectBudget, PromptTable } from '@/core/extractor/types';
import type { Rect, Ref } from './types';

/* ═══════════ identity ═══════════ */

declare const sessionBrand: unique symbol;

/**
 * Branded so a stray string cannot drift in where a session is meant.
 *
 * K-9: one live session per tab, and `sessionId ≡ threadId` once LangGraph
 * arrives — the checkpoint thread and the on-screen guide are the same thing,
 * so giving them separate identifiers would only create a mapping to keep in
 * sync. Deriving it from `tabId` makes that invariant structural.
 */
export type SessionId = string & { readonly [sessionBrand]: 'SessionId' };

export const sessionIdForTab = (tabId: number): SessionId => `tab-${tabId}` as SessionId;

/* ═══════════ element identity ═══════════ */

/**
 * Durable, cross-snapshot identity. Every field must be something an author can
 * read off the page and write down — no XPath, no CSS paths, no coordinates.
 * Matching is a conjunctive filter: every field present must hold. No scoring,
 * no tie-break (K-6).
 */
export interface ElementDescriptor {
  role: string;
  name: string;
  nameMatch?: 'exact' | 'contains' | 'fuzzy';
  /** Nearest nameable ancestor section / heading text. The primary discriminator. */
  scope?: string;
  /** The element's own visible text, as distinct from an aria-label derived name. */
  text?: string;
  /** Adjacent label text — the killer for form fields and table rows. */
  near?: string;
  /** Whitelisted attributes only. */
  attr?: Partial<Record<'href' | 'data-testid' | 'id' | 'name', string>>;
  /** Last resort: index among like candidates *within `scope`*. Marks the step fragile. */
  nth?: number;
}

/**
 * What the **user** should do. Nothing in this extension executes it — it only
 * decides whether the card reads "点击这里" or "在这里输入".
 *
 * The field is called `expectedUserAction` on purpose. It used to be
 * `action: 'click'`, which reads like something the extension performs; with
 * step 2 producing these values from a model, that misreading is one
 * plausible-looking commit away from an executor. `architecture.spec.ts` keeps
 * the door shut, but the name should not invite the attempt in the first place.
 */
export type UserAction = 'click' | 'input' | 'select' | 'toggle' | 'scroll' | 'observe';

/**
 * The action a role implies, for producers that have a role and no better
 * evidence — the element inspector, and any future step author.
 *
 * `toPackYaml` used to emit a literal `click` for every element it was handed,
 * so picking a text field produced a step that told the user to click it. The
 * card renders from this value, so the defect was visible to the user and
 * silent to us.
 *
 * Deliberately a total function with a `click` default rather than a partial
 * one: a role we have not thought about should produce a plausible step, not
 * `undefined` flowing into the card.
 */
const ACTION_BY_ROLE: Readonly<Record<string, UserAction>> = {
  textbox: 'input',
  searchbox: 'input',
  spinbutton: 'input',
  checkbox: 'toggle',
  switch: 'toggle',
  radio: 'toggle',
  combobox: 'select',
  listbox: 'select',
  slider: 'select',
};

export const actionForRole = (role: string): UserAction => ACTION_BY_ROLE[role] ?? 'click';

export interface GuideStep {
  /**
   * Handle into the current snapshot. **Optional**: a step may travel unbound —
   * step 3's target usually does not exist in the DOM while step 1 is on screen,
   * so binding a whole flow up front cannot tell "absent" from "not reached
   * yet". When absent, the renderer resolves from `descriptor`.
   */
  ref?: Ref;
  /** Identity that outlives the snapshot. Never dropped after a successful bind —
   *  `relocate` has nothing else to work from once the snapshot is stale (K-5). */
  descriptor: ElementDescriptor;
  /** Secondary highlights: `explain` / `diagnose` refs, or every candidate when
   *  a descriptor binds to more than one element. Holes only, no pulse. */
  alsoRefs?: readonly Ref[];
  expectedUserAction: UserAction;
  title: string;
  detail?: string;
}

export type HighlightMode = 'guide' | 'locate' | 'explain' | 'diagnose';

/**
 * One command renders exactly one step.
 *
 * The cursor is deliberately absent. It belongs to whoever owns the flow — the
 * side panel today, the LangGraph checkpoint in step 2 — and never to the
 * content script, which does not survive a navigation and has no recovery
 * mechanism. `progress` is display data, not state: the renderer reads it to
 * draw "步骤 2 / 5" and has no way to advance it.
 */
export interface HighlightCommand {
  sessionId: SessionId;
  /** Must equal the content script's current snapshot or the render is refused. */
  snapshotId: string;
  mode: HighlightMode;
  step: GuideStep;
  progress: { index: number; total: number };
  autoScroll: boolean;
}

export type HighlightFailure =
  | 'snapshot_stale'
  | 'ref_not_found'
  | 'sensitive_blocked'
  | 'not_visible'
  | 'frame_unreachable';

/**
 * The single channel for "what happened on screen".
 *
 * An outcome used to arrive two ways — `{ok:false, code}` for some refusals and
 * `{ok:true, data:{rendered:false, reason}}` for others — so every caller had to
 * check three levels, and each caller checked a different subset. Now `ok:false`
 * means only "the message did not get through"; everything the renderer decided
 * is here, and `failure` absent ⇔ something was painted.
 */
export interface HighlightAck {
  /** The element actually painted. `null` ⇔ `failure` is set. */
  resolved: Ref | null;
  /** Top-frame viewport coordinates, already composed across frames. */
  rect: Rect | null;
  scrolled: boolean;
  /** Every element the step matched, when it matched more than one. All are
   *  outlined and none is chosen — bind never breaks a tie (K-6). */
  candidates?: readonly Ref[];
  failure?: HighlightFailure;
}

/* ═══════════ RPC: caller → content script ═══════════ */

/**
 * The closed verb set. Adding to it is a deliberate act with a visible diff —
 * `architecture.spec.ts` asserts the exact contents, and `onRequest` rejects
 * anything not listed here at the door.
 *
 * There is no execute verb, and there must never be one: the extension holds
 * `<all_urls>` from install, so "it only reads the page" is a property of this
 * source tree rather than something Chrome enforces for us (方案 §2.3).
 */
export const RPC_TYPES = [
  'PING',
  'EXTRACT',
  'HIGHLIGHT',
  'CLEAR',
  // Authoring. Added deliberately in task 14, with the diff the whitelist exists
  // to force: it turns on element picking, and picking is still only *reading* —
  // it reports what the user pointed at and never acts on it.
  'INSPECT',
  'DEBUG_GET_OVERLAY_STATE',
] as const;

export type RpcType = (typeof RPC_TYPES)[number];

export interface ContentRpcMap {
  PING: { req: Record<never, never>; res: { version: string; frameId: number; title: string } };
  EXTRACT: { req: { profile: ExtractProfile; budget: ProjectBudget }; res: PromptTable };
  HIGHLIGHT: { req: { command: HighlightCommand }; res: HighlightAck };
  CLEAR: { req: Record<never, never>; res: null };
  /** Element picking for pack authoring. `on: false` leaves the mode. */
  INSPECT: { req: { on: boolean }; res: null };
  /** Overlay state readback. Not a test-only affordance — the side panel needs
   *  exactly this, and closed shadow roots make it the only way in. */
  DEBUG_GET_OVERLAY_STATE: {
    req: Record<never, never>;
    res: { mounted: boolean; visible: boolean; rect: Rect | null; status: string } | null;
  };
}

/** Compile-time proof that the runtime whitelist and the type map cannot drift. */
type VerbsAgree = [RpcType] extends [keyof ContentRpcMap]
  ? [keyof ContentRpcMap] extends [RpcType]
    ? true
    : never
  : never;
const _verbsAgree: VerbsAgree = true;
void _verbsAgree;

export type ContentRequest = {
  [K in RpcType]: { type: K } & ContentRpcMap[K]['req'];
}[RpcType];

/** Transport only. Everything the renderer decided lives in `HighlightAck`. */
export type TransportError =
  | 'no_content_script'
  | 'frame_unreachable'
  | 'extract_failed'
  | 'aborted';

export type ContentResponse<K extends RpcType = RpcType> =
  | { ok: true; data: ContentRpcMap[K]['res'] }
  | { ok: false; code: TransportError; message: string };

/* ═══════════ side panel → host (service worker) ═══════════ */

/**
 * Deliberately tiny, and deliberately not part of `ContentRpcMap`.
 *
 * The host is the only process that outlives both a navigation and the side
 * panel being closed, so it is the only place a flow can live. Task 9 replaces
 * these two messages with `AgentHost.start/abort` over an event stream; the
 * shape is chosen so that swap is a rename, not a redesign.
 */
export type HostRequest =
  /** `goal` is the agent path; `steps` is the element inspector handing over a
   *  ready-made flow. Step 2 only ever sends `goal`. */
  | { type: 'START_GUIDE'; tabId: number; goal?: string; steps?: readonly GuideStep[] }
  | { type: 'END_GUIDE'; tabId: number };

/** Host → side panel. The panel is a view; this is what it renders. */
export interface GuideState {
  type: 'GUIDE_STATE';
  tabId: number;
  sessionId: SessionId;
  index: number;
  total: number;
  /** Absent while a step is on screen. */
  failure?: HighlightFailure;
  candidates?: number;
}

/* ═══════════ events: content script → everyone ═══════════ */

export const EVENT_TYPES = [
  'STEP_CONFIRMED',
  'STEP_SKIPPED',
  'TARGET_LOST',
  /** Its counterpart. Without it the host's view of the session diverges from
   *  what is actually on screen the moment a lost step recovers. */
  'TARGET_FOUND',
  'SESSION_ENDED',
  'ELEMENT_PICKED',
] as const;

/**
 * `'completed'` is emitted by the **flow owner**, never by the content script:
 * deciding that a flow is finished is a flow decision, and the renderer only
 * reports what the user did to the one step it was handed.
 */
export type SessionEndReason = 'user_closed' | 'navigated' | 'aborted' | 'completed';

export type ContentEvent =
  | { type: 'STEP_CONFIRMED'; sessionId: SessionId; stepIndex: number }
  | { type: 'STEP_SKIPPED'; sessionId: SessionId; stepIndex: number }
  | {
      type: 'TARGET_LOST';
      sessionId: SessionId;
      ref: Ref;
      reason: 'removed' | 'hidden' | 'zero_area';
    }
  | { type: 'TARGET_FOUND'; sessionId: SessionId; ref: Ref }
  | { type: 'SESSION_ENDED'; sessionId: SessionId; reason: SessionEndReason }
  /**
   * The inspector's output. `matches !== 1 || !correct` means the descriptor is
   * not safe to write down — L-0 is a constraint, not a statistic (§7.5).
   */
  | {
      type: 'ELEMENT_PICKED';
      descriptor: ElementDescriptor;
      label: string;
      matches: number;
      correct: boolean;
      rung: string;
      yaml: string;
    };
