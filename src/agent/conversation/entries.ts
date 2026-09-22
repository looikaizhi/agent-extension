import type { ToolRound } from '@/agent/context/turn';
import type { ThreadState } from '@/agent/thread/thread';
import type { Conversation, ConversationEntry, ConversationRound, Pending } from '@/shared/conversation';

/**
 * CONTEXT.md `Conversation`: what the panel shows, built from what the Thread
 * already holds.
 *
 * Pure, and platform-free (N-1): the host owns the storage and the wire, this
 * file owns what a round reads like, what an entry is, and — the one that
 * matters — what the run is doing right now. 「正在想…」 is computed here from
 * the Thread on every pull, so it cannot outlive the call it describes; the
 * panel keeps no flag of its own to get stuck on.
 */

/** The model's own arguments, as it wrote them. Unparseable is not an error:
 *  the round still happened and is still worth showing. */
const argsOf = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** What the tool was asked for, in the words the disclosure shows. */
function askedOf(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'wait_for') {
    const text = str(args.text);
    if (!text) return undefined;
    return `等「${text}」${args.until === 'gone' ? '消失' : '出现'}`;
  }
  if (tool === 'read_doc') {
    const query = str(args.query);
    return query ? `读文档：${query}` : undefined;
  }
  return undefined;
}

/** One line about what came back. */
function gotOf(result: ToolRound['result']): string | undefined {
  switch (result.kind) {
    case 'page':
      return `读到这一页的 ${result.table.items.length} 个控件`;
    case 'unreadable':
      return '这一页读不到';
    case 'waited':
      return result.met === null ? '没等完：页面换了' : `${result.met ? '等到了' : '没等到'}（${result.seconds} 秒）`;
    case 'doc':
      return `读到 ${result.text.length} 个字${result.truncated ? '（截过）' : ''}`;
    case 'no_doc':
      return `没读到：${result.reason}`;
  }
}

export function roundOf(round: ToolRound, usage?: { prompt: number; completion: number }): ConversationRound {
  const args = argsOf(round.call.args);
  const asked = askedOf(round.call.name, args);
  const got = gotOf(round.result);
  // `why` is the model's, and only `observe` is asked for one by name; the
  // other tools say what they want through their own arguments.
  const why = str(args.why);
  return {
    tool: round.call.name,
    ...(why ? { why } : {}),
    ...(asked ? { asked } : {}),
    ...(got ? { got } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** The next entry id for this conversation — unique, stable, and ordered. */
const idFor = (conversation: Conversation): string => `${conversation.tabId}:${conversation.rev + 1}`;

/** One more thing happened. The conversation is replaced, never mutated. */
export function append(conversation: Conversation, entry: Omit<ConversationEntry, 'id'>): Conversation {
  return {
    ...conversation,
    rev: conversation.rev + 1,
    entries: [...conversation.entries, { ...entry, id: idFor(conversation) }],
  };
}

/**
 * What became of a step, written onto the entry that showed it — matched by
 * presentation, so a report that outlived its step lands nowhere rather than
 * on the step that replaced it. An unmatched stamp changes nothing: the same
 * conversation comes back, so the caller can tell there is nothing to write.
 */
export function stampStep(
  conversation: Conversation,
  presentationId: string,
  outcome: NonNullable<ConversationEntry['step']>['outcome'],
  /** What the paint binds now — a target that came back is bound again. */
  binding?: NonNullable<ConversationEntry['axes']>['binding'],
): Conversation {
  const i = conversation.entries.findLastIndex((e) => e.step?.presentationId === presentationId);
  if (i === -1) return conversation;
  const entry = conversation.entries[i]!;
  if (entry.step?.outcome === outcome && (binding === undefined || entry.axes?.binding === binding)) return conversation;
  const entries = [...conversation.entries];
  entries[i] = {
    ...entry,
    step: { ...entry.step!, outcome },
    ...(binding && entry.axes ? { axes: { ...entry.axes, binding } } : {}),
  };
  return { ...conversation, rev: conversation.rev + 1, entries };
}

/**
 * What this tab's run is doing right now.
 *
 * Read off the Thread every time it is asked, never remembered: the panel's
 * old 「正在想…」 was a flag it set when it sent the goal and cleared when a
 * broadcast happened to arrive, so a broadcast filtered out by a tab switch —
 * or a call whose panel threw — left it on screen for good.
 */
export function pendingOf(
  state: ThreadState | null,
  opts: { panelOpen: boolean; lastEntry?: ConversationEntry | null },
): Pending {
  if (!state || state.ending) return { kind: 'idle' };
  if (state.turn?.pending) return { kind: 'running_tool', tool: state.turn.pending.call.name };
  // A call nobody can run is not thinking — it is waiting for a side panel to
  // open, and the user is the one who has to do something about it (06c).
  if (state.inflight) return opts.panelOpen ? { kind: 'thinking' } : { kind: 'waiting_for_panel' };
  if (state.pendingCrossSite) return { kind: 'waiting_for_user', what: 'cross_site' };
  if (opts.lastEntry?.kind === 'ask') return { kind: 'waiting_for_user', what: 'ask' };
  return { kind: 'idle' };
}
