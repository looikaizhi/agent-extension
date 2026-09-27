import { append, stampStep } from '@/agent/conversation/entries';
import { createSerialQueue } from '@/shared/serial';
import { emptyConversation, type Conversation, type ConversationEntry, type ConversationRound, type EntryStep } from '@/shared/conversation';

/**
 * The host's side of CONTEXT.md `Conversation`: where one tab's conversation
 * is kept, and the only writer of it.
 *
 * Session storage, keyed by tab — a conversation outlives any single run and
 * dies with the tab, which is exactly the lifetime the user experiences.
 * Every write goes through one serial queue per tab, for the same reason the
 * thread's writes do: read-modify-write interleaved loses entries, and an
 * entry is something that happened.
 *
 * The panel is told only that something changed. It then pulls
 * (`GET_CONVERSATION`); the ping carries no data and is never authoritative,
 * so a ping lost to a closed panel, a tab switch or a sleeping worker costs
 * nothing.
 */

const keyFor = (tabId: number) => `conv:tab-${tabId}`;
const writes = createSerialQueue();

export async function readConversation(tabId: number): Promise<Conversation> {
  const key = keyFor(tabId);
  const stored = (await chrome.storage.session.get(key))[key] as Conversation | undefined;
  return stored ?? emptyConversation(tabId);
}

/**
 * Tells every open panel that something about this tab changed. Data-free by
 * design, and sent for a change of *state* as well as of content: what the run
 * is doing is computed from the thread at pull time, so a call going out — or
 * coming back — moves what the panel should show without adding an entry.
 * A ping nobody hears costs nothing; the panel's next pull is authoritative.
 */
export function pingTab(tabId: number, rev = 0): void {
  chrome.runtime.sendMessage({ type: 'CONVERSATION_CHANGED', tabId, rev }).catch(() => {});
}

const ping = (conversation: Conversation): void => pingTab(conversation.tabId, conversation.rev);

/**
 * Tabs whose last write did not get through. In memory on purpose: it says
 * something about right now, and a worker that restarts has no claim to know
 * it any more.
 */
const full = new Set<number>();

/** Whether this tab's conversation is currently failing to be written. */
export const writesFailing = (tabId: number): boolean => full.has(tabId);

/** What is kept when the store has room for almost nothing. */
const KEEP_LAST = 10;

const forget = (c: Conversation, keep: number): Conversation => ({
  ...c,
  entries: c.entries.slice(-keep),
  dropped: (c.dropped ?? 0) + Math.max(0, c.entries.length - keep),
});

/**
 * Writes it down, making room if there is none: the earliest entries go
 * first, and how many went is written down with them.
 *
 * `storage.session` holds every tab's thread — element tables included — as
 * well as every conversation, and it is one quota for all of them. A write
 * that throws used to take the whole render path with it (the host `await`s
 * these in thirteen places), and the thing that had just happened was lost
 * with no trace at all. Losing the oldest lines of a long conversation to
 * keep the newest is a poor outcome; losing what just happened, silently, is
 * a worse one.
 *
 * `null` when even `KEEP_LAST` entries do not fit — then nothing was written,
 * and the caller is told so rather than handed a conversation that only looks
 * saved.
 */
async function store(tabId: number, c: Conversation): Promise<Conversation | null> {
  const attempts = [c, forget(c, Math.ceil(c.entries.length / 2)), forget(c, KEEP_LAST)];
  for (const attempt of attempts) {
    try {
      await chrome.storage.session.set({ [keyFor(tabId)]: attempt });
      full.delete(tabId);
      return attempt;
    } catch {
      // No room. The next attempt asks for less; the last one gives up.
    }
  }
  full.add(tabId);
  return null;
}

/** Read, change, write, tell — serialized per tab. Returns what was written. */
function change(tabId: number, fn: (c: Conversation) => Conversation): Promise<Conversation> {
  return writes(`conv-${tabId}`, async () => {
    const before = await readConversation(tabId);
    const after = fn(before);
    if (after === before) return before;
    const written = await store(tabId, after);
    // Nothing was written, so nothing is claimed: the panel is still told to
    // look again, and what it pulls says the store is full.
    if (!written) {
      pingTab(tabId, before.rev);
      return before;
    }
    ping(written);
    return written;
  });
}

/**
 * One more thing to show. `takeThinking` folds the rounds drafted so far into
 * this entry — true for everything the model produced (a step, an answer, a
 * question), false for the host's own notes, which no thinking led to.
 */
export const addEntry = (
  tabId: number,
  entry: Omit<ConversationEntry, 'id'>,
  takeThinking = false,
  /** The call that produced this entry. Shown last, after the tool rounds that
   *  led to it — a model that answers in one shot still has one thing to
   *  disclose, and what it cost. */
  andRound?: ConversationRound,
): Promise<Conversation> =>
  change(tabId, (c) => {
    const rounds = [...(takeThinking ? (c.draft ?? []) : []), ...(andRound ? [andRound] : [])];
    return append(takeThinking && c.draft ? { ...c, draft: undefined } : c, rounds.length ? { ...entry, rounds } : entry);
  });

/** A tool round finished while the model is still working on this step. Kept
 *  as a draft so the panel can show the thinking as it happens; it is folded
 *  into the entry that concludes the turn. */
export const addRound = (tabId: number, round: ConversationRound): Promise<Conversation> =>
  change(tabId, (c) => ({ ...c, rev: c.rev + 1, draft: [...(c.draft ?? []), round] }));

/** What became of the step an entry showed. */
export const stampEntry = (
  tabId: number,
  presentationId: string,
  outcome: EntryStep['outcome'],
  binding?: 'bound' | 'ambiguous' | 'unbound',
): Promise<Conversation> => change(tabId, (c) => stampStep(c, presentationId, outcome, binding));

/**
 * The conversation follows the run into the tab the user moved to (a click
 * that opened a new tab).
 *
 * What was said is carried over rather than moved: the tab left behind keeps
 * its own copy, with one line saying where the run went, so a user who
 * switches back finds an account of it instead of a blank panel. Entry ids
 * carry the tab they were minted in, so the two copies never collide.
 */
export async function carryConversation(from: number, to: number, note: string): Promise<void> {
  const left = await readConversation(from);
  await change(to, (c) => ({ ...c, rev: c.rev + 1, entries: [...c.entries, ...left.entries], ...(left.draft ? { draft: left.draft } : {}) }));
  await addEntry(from, { at: Date.now(), kind: 'note', text: note });
}

/** The tab is gone. Nothing of it is worth keeping. */
export async function dropConversation(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyFor(tabId));
}
