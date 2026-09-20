import type { PromptTable } from '@/core/extractor/types';
import type { NotActionableWhy } from '@/shared/protocol';
import type { Ref, WaitUntil } from '@/shared/types';

/**
 * CONTEXT.md `Turn`: the conversation with the model inside one step — the
 * page the step's first call opened on, and every tool round since.
 *
 * Types, plus the one question every reader of a round asks (`tableOf`) —
 * imported by both the Thread (which records rounds) and the wire (which
 * carries them to the panel, where the messages are built): the
 * model call happens in the panel, the decisions on the host, and a round has
 * to be the same shape on both sides.
 */

/** One call the model made, as the endpoint returned it — replayed back to
 *  the model verbatim, so its arguments are the model's own text. */
export interface ToolCall {
  /** The endpoint's call id, or one made from the effect id when the
   *  endpoint gave none: the result is paired with the call by this id. */
  id: string;
  name: string;
  args: string;
}

/** What a tool round sent back to the model. */
export type ToolResult =
  /** The page as it is at this moment, read again. */
  | { kind: 'page'; table: PromptTable }
  /** The page could not be read at all — the model decides what to do. */
  | { kind: 'unreadable' }
  /**
   * A `wait_for` came back: whether the text did what the model expected
   * (`met`), how long it took, and the page as it is now. `met` is `null`
   * when the wait could not finish — the page left or reloaded under it — and
   * `table` is `null` when the page could not be read afterwards.
   */
  | { kind: 'waited'; until: WaitUntil; text: string; seconds: number; met: boolean | null; table: PromptTable | null }
  /** A document the model asked to read (`read_doc`): its text, cut to a
   *  length, and whether it was cut. */
  | { kind: 'doc'; text: string; truncated: boolean }
  /** No document: the host would not fetch the link, or the fetch failed —
   *  said as the reason, for the model to decide what to do next. */
  | { kind: 'no_doc'; reason: string };

/** The page a round brought back, if it brought one. */
export const tableOf = (result: ToolResult): PromptTable | null =>
  result.kind === 'page' ? result.table : result.kind === 'waited' ? result.table : null;

/**
 * CONTEXT.md `Reading`: one thing an observation source saw, and nothing
 * made of it. Which source saw it is the kind; when is the order they arrived
 * in. The page as it was at that moment is read by the host alongside, and is
 * not part of what the source saw.
 */
export type Reading =
  /** The user used the target of the step on screen — clicked it, or typed
   *  into it and was done typing. */
  | { kind: 'used'; how: 'clicked' | 'typed' }
  /** The tab finished loading a whole page, now at `url`. */
  | { kind: 'loaded'; url: string }
  /** The target of the step on screen went off the page. */
  | { kind: 'target_lost' }
  /** The page's structure changed by itself. */
  | { kind: 'changed' }
  /** The step was not painted: when the renderer went to paint it, the tab
   *  was no longer at the page it was drawn from (`elsewhere`), or its target
   *  was a password-like field, which is never outlined (`sensitive`). */
  | { kind: 'not_shown'; why: 'elsewhere' | 'sensitive' }
  /** When the renderer went to paint the step, its target was not on the
   *  page. Said the moment it was painted as 「找不到」; the renderer goes on
   *  looking each time the page changes, and paints it if it appears. */
  | { kind: 'not_found' }
  /** The step's target is on the page, but cannot be operated right now
   *  (CONTEXT.md `Actionability`): disabled, covered by something else, or
   *  still moving. The step stays painted. */
  | { kind: 'not_actionable'; why: NotActionableWhy }
  /** The user said something more while the guide was going — a question on
   *  the way, or a change of what to do; the model tells which. */
  | { kind: 'said'; text: string };

/**
 * How the page the model is shown now compares with the one it last answered
 * on: onto another address (`moved`), onto another address while every
 * control on it is still the old page's (`moved_same_controls`), the same
 * address with its controls changed (`changed_in_place`) or not
 * (`unchanged`) — or `unreadable`, when no read since has succeeded and the
 * page shown is still the old one.
 */
export type PageSince = 'moved' | 'moved_same_controls' | 'changed_in_place' | 'unchanged' | 'unreadable';

/** What woke the model: every reading since its last answer, oldest first,
 *  and how the page now compares with the one that answer was given on. */
export interface Since {
  readings: readonly Reading[];
  page: PageSince;
}

export interface ToolRound {
  call: ToolCall;
  result: ToolResult;
}

/** A turn as it crosses the wire: only once it has rounds, so a call with
 *  none is byte for byte the call it always was. */
export interface TurnOnWire {
  /** The page the step's first call opened on — what the user message shows.
   *  The table a round read is in that round's result, and the latest one is
   *  what the answer is checked against. */
  table: PromptTable;
  /** Refs marked new on `table` when the turn opened, kept so every round
   *  rebuilds the opening message byte for byte (and the prefix cache holds). */
  freshRefs?: readonly Ref[];
  /** What woke the model for this turn, kept for the same reason. */
  since?: Since;
  rounds: readonly ToolRound[];
}
