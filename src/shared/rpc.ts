import type { ContentEvent, ContentRequest, ContentResponse, RpcType } from './protocol';
import { EVENT_TYPES, RPC_TYPES } from './protocol';

const VERBS: ReadonlySet<string> = new Set(RPC_TYPES);
const EVENTS: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Tab-scoped RPC. Deliberately caller-agnostic: today the side panel calls it
 * directly, in step 2 the service worker will. The content script side does not
 * change either way (K in §6.1 of the plan).
 */
export async function sendToTab<K extends RpcType>(
  tabId: number,
  req: Extract<ContentRequest, { type: K }>,
  frameId = 0,
): Promise<ContentResponse<K>> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, req, { frameId });
    if (!res) return { ok: false, code: 'no_content_script', message: '无响应' };
    return res as ContentResponse<K>;
  } catch (e) {
    return { ok: false, code: 'no_content_script', message: String(e) };
  }
}

type Handler = (
  req: ContentRequest,
  sender: chrome.runtime.MessageSender,
) => Promise<ContentResponse>;

/** Returns an unsubscribe — a superseded content script instance must go silent. */
export function onRequest(handler: Handler): () => void {
  const listener = (
    req: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ) => {
    const r = req as { type?: unknown } | null;
    // Whitelist, not a shape check: an unknown verb is refused at the door
    // rather than reaching a switch that happens not to handle it. Events share
    // this channel, so non-verbs must be declined without answering.
    if (!r || typeof r.type !== 'string' || !VERBS.has(r.type)) return false;
    handler(r as ContentRequest, sender).then(sendResponse, (e) =>
      sendResponse({ ok: false, code: 'extract_failed', message: String(e?.stack ?? e) }),
    );
    return true; // keep the channel open for the async response
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function emit(event: ContentEvent): void {
  // Nothing may be listening (side panel closed); that is not an error.
  chrome.runtime.sendMessage(event).catch(() => {});
}

/**
 * The tab is carried out of band, from `sender` — a content script cannot know
 * its own tabId. Without it the side panel would have to assume every event
 * came from the tab it is currently looking at, which is false the moment the
 * user switches tabs mid-guide.
 */
export function onEvent(cb: (e: ContentEvent, tabId: number | null) => void): () => void {
  const listener = (msg: unknown, sender: chrome.runtime.MessageSender) => {
    const e = msg as ContentEvent | undefined;
    if (e && typeof e.type === 'string' && EVENTS.has(e.type)) cb(e, sender.tab?.id ?? null);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Idempotent injection. Also covers the "extension installed/reloaded after the
 * page was already open" bug class, which is why it is a long-term primitive
 * rather than a workaround.
 */
export async function ensureInjected(tabId: number): Promise<boolean> {
  const alive = await sendToTab(tabId, { type: 'PING' });
  if (alive.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['/content-scripts/content.js'],
    });
    return (await sendToTab(tabId, { type: 'PING' })).ok;
  } catch {
    return false;
  }
}
