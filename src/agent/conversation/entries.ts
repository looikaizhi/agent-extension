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

/** One line of what was actually said, and by whom. */
export interface Talk {
  who: 'user' | 'guide';
  text: string;
}

/** A turn starts when the user says something. */
const TALKING: ReadonlySet<ConversationEntry['kind']> = new Set(['said', 'answer', 'ask']);

/**
 * What was said before the sentence this run is serving — the user's words and
 * the guide's own answers, verbatim, most recent last.
 *
 * Only what the two of them said to each other: a step the guide pointed at is
 * already in the run's `history`, with what became of it, and the host's own
 * notes are bookkeeping rather than conversation.
 *
 * Everything from the last 「user said」 onwards is left out, because that is
 * this run's own goal and the message already ends with it.
 *
 * Why at all: an `explain` that lands ends its run, so every question is a run
 * of its own and the model could not see a word of what it had just answered.
 * On a live pricing page the user asked 「那我要怎么打开看到这些产品呢」 and
 * 「这些产品」 referred to a list the model had written one turn earlier — with
 * nothing in the prompt to refer to, it re-derived the whole page from scratch.
 */
export function recentTalk(
  entries: readonly ConversationEntry[],
  { turns, chars }: { turns: number; chars: number },
): Talk[] {
  const last = entries.findLastIndex((e) => e.kind === 'said');
  const before = last < 0 ? entries : entries.slice(0, last);
  const said = before.map((e, i) => (e.kind === 'said' ? i : -1)).filter((i) => i >= 0);
  const from = said.length > turns ? said[said.length - turns]! : 0;
  return before
    .slice(from)
    .filter((e) => TALKING.has(e.kind))
    .map((e) => ({
      who: e.kind === 'said' ? ('user' as const) : ('guide' as const),
      text: e.text.length > chars ? `${e.text.slice(0, chars)}…` : e.text,
    }));
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
