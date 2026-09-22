/**
 * What the side panel shows, as the host writes it down.
 *
 * A `Conversation` is everything that happened in one tab, in the order it
 * happened: what the user said, every step the guide pointed at, what it
 * answered, what it asked back, and what the host itself had to say. One per tab, kept
 * in the worker's session storage, outliving any single run — a guide that
 * ends leaves its messages behind, and the next thing the user says continues
 * the same thread of talk.
 *
 * The panel never owns this. It pulls it (`GET_CONVERSATION`) and renders it;
 * the host's ping only says "there is something new". That is the whole
 * reason the panel can no longer get stuck: a missed message costs nothing,
 * because no message was ever the state.
 *
 * Types only, off the leaf type file — reachable from the panel, the worker
 * and the tests without dragging a module graph behind them.
 */

import type { GuideRouteHop, WireBinding, WireCheck, WireEvidence } from './types';

/**
 * One round of the model's thinking, as the panel discloses it: the tool it
 * called, why it said it called it, what came back, and what that round cost.
 * Built from the Thread's own `ToolRound` (`agent/context/turn.ts`) — nothing
 * here is collected specially for the display.
 */
export interface ConversationRound {
  /** `point` / `ask` / `explain` / `done` / `observe` / `wait_for` / `read_doc`. */
  tool: string;
  /** The model's own words for this round, when its arguments carry them. */
  why?: string;
  /** What the tool was asked for: the text waited for, the link read. */
  asked?: string;
  /** One line about what came back: the page, the document, the wait. */
  got?: string;
  /** What this round's model call spent. Absent for a round whose call the
   *  host has no figure for. */
  usage?: { prompt: number; completion: number };
}

/** What kind of entry this is — who said it, and about what. */
export type EntryKind =
  /** The user typed something. */
  | 'said'
  /** The guide pointed at a step on the page. */
  | 'step'
  /** The model answered a question about the page (`explain`). */
  | 'answer'
  /** The model asked the user something back (`ask`). */
  | 'ask'
  /** The host itself: a refusal, a failure, how a run ended, what to do next. */
  | 'note';

/** The step an entry is about, as the panel shows it. */
export interface EntryStep {
  /** Which step of this run — `total` is null for a model-planned run, which
   *  never knows how many there will be. */
  index: number;
  total: number | null;
  /** The presentation this entry belongs to, so a later fact about the same
   *  step (used, skipped, lost) lands on the entry that showed it. */
  presentationId: string;
  /** What became of it, once something did. */
  outcome?: 'used' | 'skipped' | 'not_found' | 'not_actionable' | 'gone';
}

export interface ConversationEntry {
  /** Unique within its conversation, and stable — the panel keys on it. */
  id: string;
  at: number;
  kind: EntryKind;
  /** The words: what the user said, the answer, the question, the note, or a
   *  step's title. */
  text: string;
  /** A step's reason, or a note's second line. */
  detail?: string;
  /** An `ask`'s candidates — never pre-picked for the user (K-6). */
  options?: readonly { ref: string; label: string }[];
  step?: EntryStep;
  /** §5.7's three axes for the step this entry showed — what it rests on, whether
   *  arrival was judged, and what the paint bound. Shown beside the step, never
   *  merged into one number. */
  axes?: { evidence: WireEvidence; check: WireCheck; binding: WireBinding };
  /** The model's latest coarse waypoints, as of this entry. Shown verbatim:
   *  no keyword extraction, no breadcrumb assembly. */
  route?: readonly GuideRouteHop[];
  /** The thinking that produced this entry, oldest first. Empty or absent
   *  when the entry is the user's own, or the host's. */
  rounds?: readonly ConversationRound[];
  /** What the model call behind this entry spent. */
  usage?: { prompt: number; completion: number };
}

export interface Conversation {
  tabId: number;
  /** Bumped on every write; the panel uses it to drop a stale pull. */
  rev: number;
  entries: readonly ConversationEntry[];
  /** Rounds of a turn that has not concluded yet — what the panel shows as
   *  thinking while it is still happening. Folded into the entry that ends
   *  the turn, and never shown twice. */
  draft?: readonly ConversationRound[];
}

/**
 * What this tab's guide is doing right now, derived from the Thread every
 * time it is asked — never a flag the panel keeps for itself. The panel's
 * 「正在想…」 used to be exactly such a flag, and a single missed broadcast
 * left it on screen for good.
 */
export type Pending =
  | { kind: 'idle' }
  /** A model call is out. */
  | { kind: 'thinking' }
  /** The host is carrying out a tool the model asked for. */
  | { kind: 'running_tool'; tool: string }
  /** A call is waiting for a side panel to run it (06c). */
  | { kind: 'waiting_for_panel' }
  /** The run is parked on the user: a question, or a cross-site confirmation. */
  | { kind: 'waiting_for_user'; what: 'ask' | 'cross_site' };

/** Everything the panel needs for one render, answered by one pull. */
export interface ConversationView {
  conversation: Conversation;
  pending: Pending;
  /** The step on screen right now, pinned above the conversation — `null`
   *  when nothing is painted. */
  step: PinnedStep | null;
}

export interface PinnedStep {
  entryId: string;
  title: string;
  detail?: string;
  index: number;
  total: number | null;
  skippable: boolean;
}

export const emptyConversation = (tabId: number): Conversation => ({ tabId, rev: 0, entries: [] });
