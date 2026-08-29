import type { GuideRouteHop } from '@/agent/plan/contract';
import type { EffectRecovery, EffectRequest, EffectResult } from '@/agent/host/effect';
import type { ExtractProfile, ProjectBudget, PromptItem, PromptTable } from '@/core/extractor/types';
import type { Rect, Ref } from './types';

/**
 * Mirrors `agent/host/machine.ts`'s `Binding` and `agent/host/thread.ts`'s
 * `Evidence`/`Check` — not imported from either on purpose. Both of those
 * files already import *from* this one (`GuideStep`/`HighlightMode`), and
 * `agent/host/effect.ts`'s own doc comment explains why this file stays a
 * leaf with respect to `agent/host/`: importing back would turn a one-way
 * edge into a cycle for the sake of three small string unions. Three literals
 * are cheap to keep in sync by hand; a cycle is not.
 */
export type WireBinding = 'bound' | 'ambiguous' | 'unbound';
export type WireEvidence = 'walked' | 'documented' | 'model';
export type WireCheck = 'pass' | 'unknown' | 'skipped';

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

/** The inverse of `sessionIdForTab` — needed the moment a message arrives
 *  carrying only a `threadId`/`SessionId` (no `sender.tab`, e.g. `EFFECT_
 *  RESULT` from the side panel) and the host still has to know which tab to
 *  `sendToTab` a `HIGHLIGHT` command at. Kept next to
 *  the encoding it inverts rather than re-derived ad hoc at each call site —
 *  the `'tab-'` prefix is spelled out in exactly one place either way. */
export const tabIdForSession = (id: SessionId): number => Number(id.slice('tab-'.length));

/* ═══════════ element identity ═══════════ */

/**
 * Durable, cross-snapshot identity. Every field must be something an author can
 * read off the page and write down — no XPath, no CSS paths, no coordinates.
 * Matching is a conjunctive filter: every field present must hold. No scoring,
 * no tie-break (K-6).
 *
 * A field earns its place only when the same release ships both a writer and a
 * reader. `text`, `near` and `attr` were declared here and never became either,
 * so they are gone. `attr.data-testid` comes back when the Playwright exporter
 * lands and can read it; `text` and `near` do not come back at all — `textOf`
 * over a contenteditable subtree spells out whatever the user typed, and the
 * S-05 guard only greps `.value`.
 */
export interface ElementDescriptor {
  role: string;
  name: string;
  nameMatch?: 'exact' | 'contains' | 'fuzzy';
  /** Nearest nameable ancestor section / heading text. The primary discriminator. */
  scope?: string;
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
  /** For an `input` step: the text the model suggests typing. Shown on the
   *  card so the user can type it; nothing here ever types it for them. */
  value?: string;
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
 * `START_GUIDE` / `END_GUIDE` with `AgentHost.start/abort` over an event
 * stream; the shape is chosen so that swap is a rename, not a redesign.
 *
 * The `PANEL_*` verbs are a different kind and are not part of that swap.
 * They own no flow — they relay one panel gesture each to the content script,
 * and exist only so the content script answers to a single commander.
 * `PANEL_SHOW_QA_RESULT` and `PANEL_RESUME_GUIDE` (task 6) are the same kind
 * again: a question never owns a Thread (ADR 0004), so neither one starts,
 * resumes or aborts one — `PANEL_SHOW_QA_RESULT` only ever *reads* `agentHost`
 * (`exists()`), and `PANEL_RESUME_GUIDE` does not touch it at all.
 */
export type HostRequest =
  /** `goal` is the agent path; `steps` is the element inspector handing over a
   *  ready-made flow. Step 2 only ever sends `goal`. */
  | { type: 'START_GUIDE'; tabId: number; goal?: string; steps?: readonly GuideStep[] }
  /** Ends whatever flow currently owns the tab, agent- or inspector-driven alike. */
  | { type: 'END_GUIDE'; tabId: number }
  /** The user's answer to P-2's card. Declining is not an error: the guide
   *  stays where it is with the step unshown, and spends nothing. */
  | { type: 'CROSS_SITE_DECISION'; tabId: number; confirmed: boolean }
  /** The panel's "抽取本页元素", relayed rather than sent directly: the content
   *  script must answer to exactly one commander, and `tabId` must be
   *  interpreted in exactly one place rather than once per sender. */
  | { type: 'PANEL_EXTRACT'; tabId: number }
  /** The panel's inspect-mode toggle. Relayed for the same reason as `PANEL_EXTRACT`. */
  | { type: 'PANEL_INSPECT'; tabId: number; on: boolean }
  /**
   * A QA answer's highlight (task 6, ADR 0004 & 0006). Unlike every other verb
   * here, this one does *not* touch `agentHost` beyond the read-only `exists()`
   * — a question never builds, resumes or aborts a Thread.
   */
  | {
      type: 'PANEL_SHOW_QA_RESULT';
      tabId: number;
      /** The snapshot `items` were read from. Becomes `HighlightCommand.snapshotId`
       *  unchanged — the host must never substitute a freshly re-extracted one,
       *  or `render()`'s `mode: 'explain'` branch could never detect staleness
       *  (ADR 0006). */
      snapshotId: string;
      /** The page's URL when the question was asked, compared against the tab's
       *  *current* URL before anything is forwarded — the one check only the
       *  host can make (`chrome.tabs.get`). */
      url: string;
      /** Already-resolved items, not bare refs: the panel already has them from
       *  its own `PANEL_EXTRACT` table (same pattern as `App.tsx`'s
       *  `onRowClick`), which is what lets the host build a descriptor via
       *  `descriptorOf` (`src/core/packs/bind.ts`) without a second extraction —
       *  a second extraction would commit a new snapshot generation and make
       *  the `snapshotId` above unresolvable on arrival. */
      items: readonly PromptItem[];
      mode: 'explain';
      title: string;
      detail?: string;
    }
  /** Redraws whatever step the tab's guide Thread is currently parked on,
   *  without advancing its cursor. The panel calls this once a QA highlight's
   *  overlay closes, to hand the screen back to an in-progress guide — reading
   *  the parked step is enough; nothing here calls `agentHost.resume()`. */
  | { type: 'PANEL_RESUME_GUIDE'; tabId: number }
  /** E-6: the panel asks this once on mount, before
   *  it does anything else — never to issue a new `EffectRequest`, only to
   *  learn whether one is already outstanding for this tab's thread, so a
   *  reopened panel can say "上一次调用超时" / "仍在进行" honestly instead of
   *  either staying silent or (worse) sending a second, paid-for request. */
  | { type: 'PANEL_GUIDE_INFLIGHT'; tabId: number }
  /**
   * Closes the gap 04-effect-protocol.md's Gotchas left open: `EFFECT_
   * REQUEST` is a broadcast, so two `sidepanel.html` instances bound to the
   * *same* tab both receive it and, without this, both would really call
   * `complete()`/`fetch()` for one model call — a real duplicate charge, not
   * just duplicate host bookkeeping (which E-2 already handles). Every
   * `startEffectListener` instance sends this *before* touching
   * `complete()`/`fetch()`; the host answers with `EffectClaimResponse`, and
   * only the first asker for a given `effectId` gets `granted: true`
   * (`agent/host/effect.ts`'s `claimEffect`). A losing instance does not
   * retry, error, or render anything — it silently yields, because another
   * instance of the very same panel is already running this call. */
  | { type: 'EFFECT_CLAIM'; effectId: string };

/**
 * `PANEL_RESUME_GUIDE`'s answer. Not `ContentResponse<'HIGHLIGHT'>` verbatim
 * only because there is one failure mode the content script has no vocabulary
 * for — the tab has no parked Thread at all (`storage.session` has no
 * `thread:` record, or the panel called this when `guideActive` was already
 * false). Everything else forwards the content script's own `HighlightAck`
 * unchanged.
 */
export type ResumeGuideResponse = ContentResponse<'HIGHLIGHT'> | { ok: false; code: 'no_active_guide'; message: string };

/** `PANEL_GUIDE_INFLIGHT`'s answer (E-6). `effect` is `null` exactly when
 *  `recovery === 'none'` — there is nothing to recover, either because the
 *  thread never had anything in flight or because it never existed. */
export interface GuideInflightResponse {
  recovery: EffectRecovery;
  effect: EffectRequest | null;
}

/** `EFFECT_CLAIM`'s answer. `granted` is `false` for every asker after the
 *  first for a given `effectId` — see `HostRequest`'s `EFFECT_CLAIM` variant
 *  and `agent/host/effect.ts`'s `claimEffect` for why one `Set` on the host
 *  is enough and needs no persistence. */
export interface EffectClaimResponse {
  granted: boolean;
}

/**
 * 04-effect-protocol.md's wire envelopes over `chrome.runtime.sendMessage` —
 * `EffectRequest`/`EffectResult` (`@/agent/host/effect`) plus the `type` tag
 * every message on this channel needs to be told apart from `GuideState` /
 * `ContentEvent` / the `HostRequest` verbs above.
 *
 * `EffectResultMessage` adds `threadId`, which the *pure* `EffectResult`
 * shape deliberately does not carry (design doc §2.6) — background.ts has no
 * `sender.tab` to fall back on for a message the side panel sent (the same
 * reason every `PANEL_*` verb above carries its own `tabId`), so the panel
 * echoes back the `threadId` it read off the `EffectRequest` it is answering.
 */
export type EffectRequestMessage = { type: 'EFFECT_REQUEST' } & EffectRequest;
export type EffectResultMessage = { type: 'EFFECT_RESULT'; threadId: string } & EffectResult;

/** E-5: broadcast when the host clears an `inflight` tombstone before a
 *  result arrived for it. Harmless if nobody is listening, or if the panel
 *  that would have listened already sent its result (see `cancelGuideEffect`
 *  in `agent/api.ts` — that path never reaches this broadcast at all, since
 *  there is nothing left to cancel by the time the result won the race). */
export interface EffectAbortMessage {
  type: 'EFFECT_ABORT';
  effectId: string;
}

/**
 * Host → side panel. The panel is a view; this is what it renders.
 *
 * `route`/`evidence`/`check`/`binding` are 05-route-and-steps.md's addition —
 * present only on broadcasts the S2 model-driven guide produces (`agent/api.ts`'s
 * `applyGuideInput`, driven from `entrypoints/background.ts`'s `renderGuideOutcome`).
 * The S1 paths (element inspector, guide packs, the local lexical baseline)
 * never set them: those never call the model, so there is no `route` to show
 * and no `Evidence`/`Check` axis with a real value to stamp — leaving the
 * fields absent is the honest reading, not defaulting them to some
 * placeholder the user would mistake for a real answer.
 *
 * Per the Seam: "route 的展示与消费是一回事" — each broadcast carries the
 * *complete*, current `route`/`steps` picture, verbatim from `ThreadState`;
 * the panel replaces its displayed `route` with this array wholesale rather
 * than appending to or de-duplicating against whatever it showed before.
 */
/**
 * CL-1: the guided flow is parked on a question the model asked, rather than
 * on a step. Its own broadcast rather than a field on `GuideState`, because
 * the two describe different situations — `GuideState` always answers "which
 * step is on screen", and here there is no step at all.
 *
 * `options` carries every candidate the model listed, in its order. The panel
 * lists them all and picks none (K-6).
 */
export interface GuideClarify {
  type: 'GUIDE_CLARIFY';
  tabId: number;
  sessionId: SessionId;
  question: string;
  options: readonly { ref: Ref; label: string }[];
}

/**
 * P-2: this step would leave the site. Broadcast before the step is shown —
 * the promise is that the user sees where they are going *before* going, not
 * after. `from`/`to` are full hostnames: this stage has no brand extraction,
 * so the card states the literal address and claims nothing about who owns it.
 */
export interface GuideCrossSite {
  type: 'GUIDE_CROSS_SITE';
  tabId: number;
  sessionId: SessionId;
  from: string;
  to: string;
}

export interface GuideState {
  type: 'GUIDE_STATE';
  tabId: number;
  sessionId: SessionId;
  index: number;
  total: number;
  /** Absent while a step is on screen. */
  failure?: HighlightFailure;
  candidates?: number;
  /** The model's latest coarse waypoint sequence (§5.4) — present only on an
   *  S2 model-driven guide broadcast. Displayed exactly as returned: no
   *  keyword extraction, no breadcrumb assembly (05's Gotchas). */
  route?: readonly GuideRouteHop[];
  /** §5.7's three orthogonal axes, mirrored here from `ThreadState.evidence`/
   *  `ThreadState.check` and this paint attempt's own `Binding` verdict —
   *  never merged into one combined "confidence" value (05's Gotchas: "合并
   *  任意两轴都会造出一个既不能解释也不能复核的等级"). */
  evidence?: WireEvidence;
  check?: WireCheck;
  binding?: WireBinding;
  /** Why *this* control — the model's own `why` for the step on screen.
   *  Already travelled this far as `GuideStep.detail`; carried out here so the
   *  panel can show the reasoning next to the plan rather than only as a
   *  caption on the highlight. */
  why?: string;
  /** Where the guide has already been, oldest first, with how each step
   *  turned out. This is the thing that was invisible: the run had a memory
   *  from 07 onward, but only the model could read it. */
  walked?: readonly { title: string; url: string; outcome: string; landedAt?: string }[];
  /** Model calls spent so far, against §5.10's cap of 12. Shown because a
   *  guide that is looping is visible as a number climbing long before it is
   *  visible as repeated advice. */
  calls?: number;
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
  /** 05-route-and-steps.md's Seam. A *second*, independent subscription on
   *  the same DOM-observation machinery `attachTracker`'s `TargetTracker`
   *  already uses — that one watches a single highlighted target; this one
   *  watches whatever landmark/heading nodes feed `pageFingerprint`. Reported
   *  only when the content script's own comparison (`pageStructureChanged`,
   *  `core/extractor/fingerprint.ts`) says the hash actually moved — not on
   *  every DOM mutation the observer wakes up for. */
  'PAGE_STRUCTURE_CHANGED',
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
  /** §5.3's re-planning trigger, carried at its cheapest: the content script
   *  computes the new hash itself (it already has the live DOM), and leaves
   *  deciding whether it actually differs from what the *guide* was planned
   *  against to the host (`ThreadState.table.pageHash`, `agent/api.ts`'s
   *  `applyGuidePageChanged`) — the content script only ever compares against
   *  its own last-*reported* hash, a cheaper, independent check that exists
   *  purely so it does not spam this event on every mutation (05's Gotchas,
   *  "两层核对独立存在"). */
  | { type: 'PAGE_STRUCTURE_CHANGED'; sessionId: SessionId; pageHash: string }
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
