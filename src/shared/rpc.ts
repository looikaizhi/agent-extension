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

/**
 * The same request to every document on the page, frames included.
 *
 * Only for verbs where "who answered" does not matter — `CLEAR` is the one.
 * Once a step can be painted inside a frame, taking it down through the top
 * document alone leaves it on screen: each document has its own overlay, and
 * each one only hears what is addressed to it. Chrome delivers a message with
 * no `frameId` to every frame that is listening and hands back whichever
 * answered first, which is exactly the wrong thing to read and the right
 * thing to ignore.
 */
export async function sendToEveryFrame<K extends RpcType>(tabId: number, req: Extract<ContentRequest, { type: K }>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, req);
  } catch {
    // Nothing listening anywhere is not an error: the page may have navigated.
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
 * The frames on this page worth reading, and the content script put into each.
 *
 * **Why not `allFrames: true` on the static registration.** That would park a
 * content script — listeners, overlay, registry — in every frame a page has,
 * and most of what a page has is advertising and tracking. This asks first and
 * installs second: one throwaway probe in every frame (no listeners, nothing
 * kept), then the real script only into the frames that answered like a place
 * a user could be trying to do something.
 *
 * **Why no new permission.** `chrome.scripting` is already granted (the
 * manifest has had it since `ensureInjected`), and `executeScript` reports the
 * `frameId` of every result. `chrome.webNavigation.getAllFrames` would be the
 * other way to enumerate, and it costs an install-time warning this extension
 * has been careful not to add.
 *
 * The filter is the frame's own view of itself — its viewport is exactly the
 * box the page gave it — and matches the one `framesOf()` already applies when
 * it decides which frames are worth *mentioning* to the model.
 */
const FRAME_MIN = { width: 120, height: 60 };
const FRAMES_MAX = 5;

export interface EnteredFrame {
  frameId: number;
  url: string;
}

export async function enterFrames(tabId: number): Promise<EnteredFrame[]> {
  let probes;
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        url: location.href,
        w: window.innerWidth,
        h: window.innerHeight,
        // Cheap and deliberately crude: a frame with nothing to operate is not
        // a place the user is trying to get something done.
        controls: document.querySelectorAll('a[href],button,input,select,textarea,[role],[onclick]').length,
      }),
    });
  } catch {
    return []; // a page this extension cannot script at all — the top frame already said so
  }
  const worth = probes
    .filter((p) => p.frameId !== 0 && p.result)
    .map((p) => ({ frameId: p.frameId, ...(p.result as { url: string; w: number; h: number; controls: number }) }))
    .filter((f) => f.w >= FRAME_MIN.width && f.h >= FRAME_MIN.height && f.controls > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, FRAMES_MAX);
  if (worth.length === 0) return [];

  // Inject only where nothing is answering yet. Re-injecting is not free and
  // not idempotent in the way it looks: a second instance greets the first by
  // shutting it down (`content.ts`'s SHUTDOWN handshake), which also destroys
  // that document's overlay — so doing this on every extraction would wipe the
  // box painted inside a frame on the very next hop.
  const live: EnteredFrame[] = [];
  for (const f of worth) {
    if (!(await sendToTab(tabId, { type: 'PING' }, f.frameId)).ok) {
      try {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [f.frameId] }, files: ['/content-scripts/content.js'] });
      } catch {
        continue;
      }
      if (!(await sendToTab(tabId, { type: 'PING' }, f.frameId)).ok) continue;
    }
    live.push({ frameId: f.frameId, url: f.url });
  }
  return live;
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
