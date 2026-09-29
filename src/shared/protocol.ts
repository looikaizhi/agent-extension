import type { EffectRequest, EffectResult } from '@/agent/thread/effect';
import type { ExtractProfile, ProjectBudget, PromptItem, PromptTable } from '@/core/extractor/types';
import type { Appearance } from './appearance';
import type { AskOption, AskWants, GuideRouteHop, Rect, Ref, Trace, WaitUntil } from './types';

/**
 * Mirrors `agent/thread/machine.ts`'s `Binding` and `agent/thread/thread.ts`'s
 * `Evidence`/`Check` — not imported from either on purpose. Both of those
 * files already import *from* this one (`GuideStep`/`HighlightMode`), and
 * `agent/thread/effect.ts`'s own doc comment explains why this file stays a
 * leaf with respect to `agent/thread/`: importing back would turn a one-way
 * edge into a cycle for the sake of three small string unions. Three literals
 * are cheap to keep in sync by hand; a cycle is not.
 */

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
 * The inspector used to produce a literal `click` for every element it was
 * handed, so picking a text field produced a step that told the user to click it. The
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
  /** Secondary highlights: what backs an answer, an ask's candidates, or every
   *  candidate when a descriptor binds to more than one element. Holes only,
   *  no pulse. */
  alsoRefs?: readonly Ref[];
  expectedUserAction: UserAction;
  title: string;
  detail?: string;
  /** For an `input` step: the text the model suggests typing. Shown on the
   *  card so the user can type it; nothing here ever types it for them. */
  value?: string;
}

/**
 * `guide` is a step the user is meant to operate — the model's, or the one the
 * element inspector paints by hand. `explain` only outlines: what backs an answer, or the candidates of
 * an ask. Nothing in it is to be clicked, so it is never rebound, never looked
 * for again and never judged for actionability.
 */
export type HighlightMode = 'guide' | 'explain';

/**
 * One command renders exactly one step.
 *
 * The cursor is deliberately absent. It belongs to whoever owns the flow — the
 * side panel today, the LangGraph checkpoint in step 2 — and never to the
 * content script, which does not survive a navigation and has no recovery
 * mechanism. `progress` is display data, not state: the renderer reads it to
 * draw 「步骤 2 / 5」 — or 「第 3 步」 when there is no total — and has no way
 * to advance it.
 */
export interface HighlightCommand {
  sessionId: SessionId;
  /** CONTEXT.md's `Presentation`, issued by the host and never made up by the
   *  content script. The same id again is the same presentation painted again —
   *  a reload, a step redrawn on a changed page — and keeps what it has
   *  running; a different id that reaches the screen ends everything the
   *  previous presentation left behind. */
  presentationId: string;
  /** The snapshot the step's refs were drawn from. Answers only whether a
   *  handle is still fresh — a ref from an older snapshot is rebound from the
   *  step's descriptor — never which page this is. */
  snapshotId: string;
  /** The page the step was drawn from (CONTEXT.md `View`): the address of the
   *  table it came out of. The step is painted only while the tab is still
   *  there. A same-document navigation leaves the snapshot current and the
   *  element connected, so nothing else can tell a step from the page just
   *  left from one for this page — and painting it would be a confident
   *  pointer at the wrong page (symptom 2). */
  view: string;
  mode: HighlightMode;
  step: GuideStep;
  /** Which step of the run this is, and of how many — `total` is `null` for
   *  the model's steps, which come one at a time. Absent on an outline: what
   *  backs an answer is not a step of anything. */
  progress?: { index: number; total: number | null };
  autoScroll: boolean;
}

export type HighlightFailure =
  /** The tab is no longer at the command's `view`: nothing painted, and the
   *  step is not looked for on the page it is at now. */
  | 'view_moved'
  | 'snapshot_stale'
  | 'ref_not_found'
  | 'sensitive_blocked';

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
/**
 * The port every open panel holds while it is there, named
 * `${PANEL_PORT}:${panelId}`.
 *
 * Nothing travels over it. It exists for the one thing messages cannot say:
 * *this panel is gone now*. The browser disconnects the port when the
 * document goes away, so the host learns it as a fact, at the moment it
 * becomes true — no heartbeat, no timeout, and no timer guessing at panel
 * state (06c). It is also the only identity the real side panel has: its
 * messages carry no document of any kind (see `EFFECT_CLAIM`).
 */
export const PANEL_PORT = 'panel';

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
  // Added deliberately for `wait_for` (07c), with the diff the whitelist exists
  // to force: it watches the page's visible text until a piece of it appears or
  // goes, then answers. It reads and waits; it never touches anything.
  'WAIT_FOR',
  // Added deliberately for a model call no panel can run (06c), with the diff
  // the whitelist exists to force: it puts one line on the overlay's card
  // telling the user to open the side panel, or takes it down. It writes to
  // our own overlay and nothing of the page's.
  'WAITING_FOR_PANEL',
  // Added deliberately so the overlay can say what the side panel says (10c),
  // with the diff the whitelist exists to force: it shows one card of our own
  // with a question, an answer, a cross-site confirmation or why the guide
  // stopped, or takes it down. It writes nothing of the page's, and its
  // buttons only report back to the host.
  'SAY',
  // Added deliberately for the user's choice of look (CONTEXT.md `Appearance`),
  // with the diff the whitelist exists to force: it tells our own overlay which
  // style and shade to paint in. The content script cannot read storage, so the
  // host hands it over. It changes the colours of our overlay and nothing of the
  // page's.
  'THEME',
] as const;

export type RpcType = (typeof RPC_TYPES)[number];

export interface ContentRpcMap {
  PING: { req: Record<never, never>; res: { version: string; frameId: number; title: string } };
  /** `frameId` 是宿主告诉它的：内容脚本没有办法知道自己在哪个框架里，而 ref 的
   *  命名空间要靠它（`makeRef`）。缺省 0 = 顶层文档。 */
  EXTRACT: { req: { profile: ExtractProfile; budget: ProjectBudget; frameId?: number }; res: PromptTable };
  HIGHLIGHT: { req: { command: HighlightCommand }; res: HighlightAck };
  CLEAR: { req: Record<never, never>; res: null };
  /** Element picking for writing a fixed plan's steps. `on: false` leaves the mode. */
  INSPECT: { req: { on: boolean }; res: null };
  /** Overlay state readback. Nothing in the product sends it: it is how the
   *  e2e suite sees what is on screen, since a closed shadow root has no other
   *  way in. It reads and changes nothing. */
  DEBUG_GET_OVERLAY_STATE: {
    req: Record<never, never>;
    res: {
      mounted: boolean;
      visible: boolean;
      rect: Rect | null;
      status: string;
      waiting: boolean;
      /** The card shown when it is not a step, and where its buttons are. */
      message: (OverlayMessage & { buttons: { label: string; rect: Rect }[] }) | null;
      /** Whether a missing target is being looked for, and how many looks it has taken. */
      watch: { watching: boolean; looks: number };
    } | null;
  };
  /** Wait until `text` appears in (or goes from) the page's visible text, or
   *  `timeoutMs` passes — whichever is first. `met` says which. */
  WAIT_FOR: { req: { until: WaitUntil; text: string; timeoutMs: number }; res: { met: boolean; waitedMs: number } };
  /** The guide on this tab needs a model call that no open side panel can
   *  run: say so on the overlay (`waiting: true`), or stop saying it. */
  WAITING_FOR_PANEL: { req: { waiting: boolean }; res: null };
  /** Show a card on the overlay with something the user has to read (or
   *  answer), or take it down (`null`). */
  SAY: { req: { message: OverlayMessage | null }; res: null };
  /** The look to paint the overlay in. Sent before anything is painted and
   *  whenever the user changes it; 跟随系统 is resolved on the page. */
  THEME: { req: { appearance: Appearance }; res: null };
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
export type TransportError = 'no_content_script' | 'extract_failed';

export type ContentResponse<K extends RpcType = RpcType> =
  | { ok: true; data: ContentRpcMap[K]['res'] }
  | { ok: false; code: TransportError; message: string };

/* ═══════════ side panel → host (service worker) ═══════════ */

/**
 * Deliberately tiny, and deliberately not part of `ContentRpcMap`.
 *
 * The host is the only process that outlives both a navigation and the side
 * panel being closed, so it is the only place a flow can live.
 *
 * The `PANEL_*` verbs are a different kind and are not part of that swap.
 * They own no flow — they relay one panel gesture each to the content script,
 * and exist only so the content script answers to a single commander.
 * `PANEL_RESUME_GUIDE` is the same kind again: it starts, resumes or aborts
 * nothing, and only repaints the step the tab's guide is already on.
 */
export type HostRequest =
  /** What the user said in the panel's one entry. Said while a model guide is
   *  going, it is said *to* that guide — it hears it as a reading — and starts
   *  nothing; otherwise it starts a run, and a run is recorded against it.
   *  Either way it goes into this tab's `Conversation` as the user's own words. */
  | { type: 'SAID'; tabId: number; text: string }
  /** The element inspector's 「指给我」: outline the one element the user picked
   *  themselves. It paints and nothing more — no run is started, so nothing
   *  watches whether they use it and nothing is written down. */
  | { type: 'POINT_AT'; tabId: number; step: GuideStep }
  /** The panel's one authoritative read: this tab's conversation, what the run
   *  is doing right now, and the step pinned on screen. Answered with a
   *  `ConversationView`. Asked on mount, on every tab change, and whenever a
   *  `CONVERSATION_CHANGED` ping arrives — a ping that never arrives costs
   *  nothing, which is the point. */
  | { type: 'GET_CONVERSATION'; tabId: number }
  /** Ends whatever flow currently owns the tab, agent- or inspector-driven alike. */
  | { type: 'END_GUIDE'; tabId: number }
  /** The user's answer to P-2's card. Declining is not an error: the guide
   *  stays where it is with the step unshown, and spends nothing. */
  | { type: 'CROSS_SITE_DECISION'; tabId: number; confirmed: boolean }
  /** 「再试一次」 after a call that never got through. The same run asks
   *  again — goal, steps and everything read so far stay where they are —
   *  which is the whole point: retyping the goal would start a different one
   *  and throw away the way already walked. */
  | { type: 'RETRY_GUIDE'; tabId: number }
  /** The panel's "抽取本页元素", relayed rather than sent directly: the content
   *  script must answer to exactly one commander, and `tabId` must be
   *  interpreted in exactly one place rather than once per sender. */
  | { type: 'PANEL_EXTRACT'; tabId: number }
  /** The panel's inspect-mode toggle. Relayed for the same reason as `PANEL_EXTRACT`. */
  | { type: 'PANEL_INSPECT'; tabId: number; on: boolean }
  /** Redraws whatever step the tab's guide Thread is currently parked on,
   *  without advancing its cursor. The panel calls this once an answer's
   *  outline is closed, to hand the screen back to an in-progress guide —
   *  reading the parked step is enough; nothing here moves the guide. */
  | { type: 'PANEL_RESUME_GUIDE'; tabId: number }
  /** E-6: the panel asks this once on mount, before
   *  it does anything else — never to issue a new `EffectRequest` itself, only
   *  to learn whether one is already outstanding for this tab's thread, so a
   *  reopened panel can say "上一次调用超时" / "仍在进行" honestly instead of
   *  either staying silent or (worse) sending a second, paid-for request.
   *  Hearing it, the host knows a panel is open, and hands out again every
   *  call on any tab that no panel is running (06c). */
  | { type: 'PANEL_GUIDE_INFLIGHT'; tabId: number }
  /**
   * Closes a gap the effect protocol first left open: `EFFECT_
   * REQUEST` is a broadcast, so two `sidepanel.html` instances bound to the
   * *same* tab both receive it and, without this, both would really call
   * `complete()`/`fetch()` for one model call — a real duplicate charge, not
   * just duplicate host bookkeeping (which E-2 already handles). Every
   * `startEffectListener` instance sends this *before* touching
   * `complete()`/`fetch()`; the host answers with `EffectClaimResponse`, and
   * only the first asker for a given `effectId` gets `granted: true`
   * (`agent/thread/effect.ts`'s `judgeClaim`), written down with the effect
   * of `threadId`. A losing instance does not retry, error, or render
   * anything — it silently yields, because another open panel is already
   * running this call.
   *
   * `panelId` is the panel's own name for itself, and the host takes it at
   * face value: a message from the *real* side panel arrives with no
   * `sender.documentId`, no `frameId` and no `sender.tab` at all, so a host
   * that identified panels by their document granted nothing to the one
   * surface this product is actually used through — every call sat unclaimed
   * and the panel showed 「正在想」 for as long as the user was willing to
   * watch it. Whether that panel is still there is `PANEL_PORT`'s job. */
  | { type: 'EFFECT_CLAIM'; threadId: string; effectId: string; panelId: string };

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
 *  thread never had anything in flight or because it never existed.
 *
 *  Never `expired`: the host sweeps before it answers, and the sweep's own
 *  verdict has already gone out to every open panel by then. */
export interface GuideInflightResponse {
  recovery: 'none' | 'in_progress';
  effect: EffectRequest | null;
}

/** `EFFECT_CLAIM`'s answer. `granted` is `false` for every asker while the
 *  panel that took the effect is still open — see `HostRequest`'s
 *  `EFFECT_CLAIM` variant and `agent/thread/effect.ts`'s `judgeClaim`. */
export interface EffectClaimResponse {
  granted: boolean;
}

/**
 * The effect protocol's wire envelopes (design doc §2.6) over `chrome.runtime.sendMessage` —
 * `EffectRequest`/`EffectResult` (`@/agent/thread/effect`) plus the `type` tag
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
/**
 * `trace` rides along only when the debug switch is on (`agent/agents/guide/trace.ts`
 * — off by default, and read by the panel from `storage.local`). It is the
 * panel's only way to get one to storage at all: N-6 keeps the panel out of
 * `storage.session`, so it collects and the worker writes. Absent on every
 * normal call, and nothing downstream of `handleEffectResult` reads it.
 */
export type EffectResultMessage = { type: 'EFFECT_RESULT'; threadId: string; trace?: Trace } & EffectResult;

/** E-5: broadcast when a run ends with an `inflight` tombstone still set, so
 *  the panel stops a call nobody will read. Harmless if nobody is listening,
 *  or if that panel already sent its result — the host discards a result for
 *  a thread that is gone (E-2). */
export interface EffectAbortMessage {
  type: 'EFFECT_ABORT';
  effectId: string;
}

/**
 * Host → side panel. The panel is a view; this is what it renders.
 *
 * `route`/`evidence`/`check`/`binding` come from the guide's `ThreadState`
 * (`agent/thread/writer.ts`'s `applyGuideInput`, rendered by
 * `entrypoints/background.ts`'s `renderGuideOutcome`). A fixed plan sends them
 * too, with an empty `route`: it never calls the model, so it has none to show.
 *
 * Per the Seam: "route 的展示与消费是一回事" — each broadcast carries the
 * *complete*, current `route`/`steps` picture, verbatim from `ThreadState`;
 * the panel replaces its displayed `route` with this array wholesale rather
 * than appending to or de-duplicating against whatever it showed before.
 */
/**
 * The host, to every open panel: this tab's conversation moved. Data-free by
 * design — the panel answers it with `GET_CONVERSATION`, so a ping lost to a
 * closed panel, a tab switch or a sleeping worker changes nothing. The five
 * broadcasts this replaced (`GUIDE_STATE` / `GUIDE_ASK` / `GUIDE_EXPLAIN` /
 * `GUIDE_CROSS_SITE` / `AGENT_ANSWER`) each carried state that existed
 * nowhere else, so a panel that missed one — filtered out by a tab switch,
 * or simply not mounted yet — was wrong until something else happened to
 * correct it, and 「正在想…」 never came down at all.
 */
export interface ConversationChanged {
  type: 'CONVERSATION_CHANGED';
  tabId: number;
  rev: number;
}

/* ═══════════ events: content script → everyone ═══════════ */

export const EVENT_TYPES = [
  /** The user used the target of the step on screen — one of the four
   *  observation sources (CONTEXT.md `Reading`). */
  'STEP_USED',
  'TARGET_LOST',
  /** Its counterpart. Without it the host's view of the session diverges from
   *  what is actually on screen the moment a lost step recovers. */
  'TARGET_FOUND',
  /** The step's target is not on the page — said once per presentation, the
   *  moment it is painted as 「找不到」 (CONTEXT.md `Reading`). */
  'TARGET_NOT_FOUND',
  /** The step's target is on the page but cannot be operated right now
   *  (CONTEXT.md `Actionability`) — said once per presentation. */
  'STEP_NOT_ACTIONABLE',
  /** The user closed a question or an answer on the overlay's card: the screen
   *  goes back to the step, the way the panel's 关闭 does. */
  'MESSAGE_CLOSED',
  /** The user answered the overlay's cross-site card — the same decision the
   *  panel's buttons send as `CROSS_SITE_DECISION`. */
  'CROSS_SITE_DECIDED',
  'SESSION_ENDED',
  'ELEMENT_PICKED',
  /** A *second*, independent subscription on
   *  the same DOM-observation machinery `attachTracker`'s `TargetTracker`
   *  already uses — that one watches a single highlighted target; this one
   *  watches whatever landmark/heading nodes feed `structureFingerprint`. Reported
   *  only when the content script's own comparison (`pageStructureChanged`,
   *  `core/extractor/fingerprint.ts`) says the hash actually moved, or the
   *  address has become a different `View` (the hash no longer carries the
   *  address) — not on every DOM mutation the observer wakes up for. */
  'PAGE_STRUCTURE_CHANGED',
] as const;

/**
 * What the overlay's own card says, when it is not a step (10c): the side panel
 * says the same, but the user is looking at the page, and the panel may be shut.
 *
 * `ask` — the model asked the user something; `answer` — it answered a question
 * about the page. Closing either hands the screen back the way the panel's
 * 关闭 does. `cross_site` — the next step leaves the site, with 继续 and 先不去.
 * `note` — anything else to read: why the guide stopped, or what went wrong.
 */
export interface OverlayMessage {
  kind: 'ask' | 'answer' | 'cross_site' | 'note';
  title: string;
  text: string;
}

/**
 * `'completed'` is emitted by the **flow owner**, never by the content script:
 * deciding that a flow is finished is a flow decision, and the renderer only
 * reports what the user did to the one step it was handed.
 */
export type SessionEndReason = 'user_closed' | 'navigated' | 'aborted' | 'completed';

/** Why a target on the page cannot be operated right now (CONTEXT.md
 *  `Actionability`). Not being visible is not among them: that is the target
 *  gone, and `TARGET_LOST` says it. */
export type NotActionableWhy = 'disabled' | 'covered' | 'moving';

export type ContentEvent =
  /**
   * The user used the target of the step on screen: clicked it, or typed into
   * it and was done (`change`). Says which presentation it was on screen for,
   * so a report that outlives its step is not written down against the next
   * one — this is the one reading that records something about the step.
   */
  | { type: 'STEP_USED'; sessionId: SessionId; presentationId: string; how: 'clicked' | 'typed' }
  | {
      type: 'TARGET_LOST';
      sessionId: SessionId;
      ref: Ref;
      reason: 'removed' | 'hidden' | 'zero_area';
    }
  | { type: 'TARGET_FOUND'; sessionId: SessionId; ref: Ref }
  | { type: 'TARGET_NOT_FOUND'; sessionId: SessionId; presentationId: string }
  | { type: 'STEP_NOT_ACTIONABLE'; sessionId: SessionId; presentationId: string; why: NotActionableWhy }
  | { type: 'MESSAGE_CLOSED' }
  | { type: 'CROSS_SITE_DECIDED'; confirmed: boolean }
  | { type: 'SESSION_ENDED'; sessionId: SessionId; reason: SessionEndReason }
  /** The page's structure changed by itself — one of the four observation
   *  sources (CONTEXT.md `Reading`). The content script compares against its
   *  own last-*reported* hash so it does not report every mutation; what the
   *  change means is the model's to read. */
  | { type: 'PAGE_STRUCTURE_CHANGED'; sessionId: SessionId; structureHash: string }
  /**
   * The inspector's output. `matches !== 1 || !correct` means the descriptor is
   * not safe to guide by — L-0 is a constraint, not a statistic (§7.5).
   */
  | {
      type: 'ELEMENT_PICKED';
      descriptor: ElementDescriptor;
      label: string;
      matches: number;
      correct: boolean;
      rung: string;
    };
