import { agentHost, threadExists, type AgentEvent, type HostSignal } from '@/agent/api';
import { LOCAL_BUDGET } from '@/agent/budget';
import type { PromptTable } from '@/core/extractor/types';
import type { ContentEvent, GuideState, GuideStep, HostRequest } from '@/shared/protocol';
import { sessionIdForTab } from '@/shared/protocol';
import { ensureInjected, sendToTab } from '@/shared/rpc';

/**
 * The host process: it translates agent events into renderer commands, and page
 * events back into signals for the agent.
 *
 * Ownership rule: state belongs to the process whose lifetime covers it *and*
 * which has a recovery mechanism. The service worker is evicted after 30 s idle
 * but any message wakes it and the thread is in `storage.session`, so it is the
 * only candidate that survives both a navigation and the side panel closing.
 *
 * This file holds no flow state of its own. That was deliberate: while the SW
 * kept its own `{steps, cursor}` *and* the agent kept a thread, the two could
 * disagree, and "who owns the cursor" would have been unanswerable again.
 */

const CONTEXT_WINDOW = 32_000;

/**
 * Shut the content script out of `chrome.storage.local`, where the API key lives.
 *
 * `local` is exposed to content scripts **by default** — only `session` is not.
 * So "the key is unreachable from the page" rested on one grep in
 * `architecture.spec.ts` saying the content script never imports storage: a code
 * convention, in the one context that shares a process with untrusted pages.
 * `setAccessLevel` turns it into a platform guarantee, and it costs one call.
 *
 * Not awaited and not fatal: an older Chrome without the method must not stop
 * the worker from booting, and the convention still holds there.
 */
try {
  void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
} catch {
  // Older Chrome without the method, and WXT's fake browser during `wxt prepare`,
  // both throw synchronously. Neither should stop the worker from booting.
}

function broadcast(msg: GuideState | ContentEvent): void {
  // Nothing may be listening (side panel closed); that is not an error.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * Consume one stream to its end, rendering whatever it asks for.
 *
 * A stream ends at `await_user` — that is `interrupt()` — so this returns and
 * the next user action starts a new one. The loop is written against the
 * `AgentEvent` union rather than against today's implementation, so step 2 adds
 * `delta` / `usage` handling here and changes nothing else.
 */
async function drive(tabId: number, stream: AsyncIterable<AgentEvent>): Promise<void> {
  const sessionId = sessionIdForTab(tabId);

  for await (const ev of stream) {
    switch (ev.kind) {
      case 'show': {
        const res = await sendToTab(tabId, {
          type: 'HIGHLIGHT',
          command: {
            sessionId,
            // Real snapshot, so the fast path is available while the page is
            // unchanged. When it is stale the renderer simply rebinds from the
            // descriptor (task 8) — the only thing that cannot survive is an
            // `alsoRefs` set, which is why no step is ever built with one.
            snapshotId: ev.snapshotId,
            mode: ev.mode,
            step: ev.step,
            progress: { index: ev.index, total: ev.total },
            autoScroll: true,
          },
        });

        broadcast({
          type: 'GUIDE_STATE',
          tabId,
          sessionId,
          index: ev.index,
          total: ev.total,
          ...(res.ok && res.data.failure ? { failure: res.data.failure } : {}),
          ...(res.ok && res.data.candidates ? { candidates: res.data.candidates.length } : {}),
        });

        // The renderer's verdict is evidence the flow owner needs, so it goes
        // straight back in rather than being interpreted here.
        if (res.ok && res.data.failure === 'ref_not_found') {
          return void (await drive(tabId, agentHost.resume(sessionId, { kind: 'unresolved' }, never)));
        }
        break;
      }

      case 'await_user':
        return; // interrupt: the stream is over until the user acts

      case 'answer':
        chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: ev.text }).catch(() => {});
        break;

      case 'error':
        broadcast({
          type: 'GUIDE_STATE',
          tabId,
          sessionId,
          index: ev.index,
          total: ev.total,
          failure: 'ref_not_found',
        });
        break;

      case 'done':
        await sendToTab(tabId, { type: 'CLEAR' });
        broadcast({ type: 'SESSION_ENDED', sessionId, reason: ev.reason === 'completed' ? 'completed' : 'aborted' });
        return;

      // phase / delta / usage: nothing to render in step 1, but they exist so
      // the keep-alive and the chat view have somewhere to attach.
      default:
        break;
    }
  }
}

/** Step 1 never cancels a zero-cost path; step 2 wires this to the UI. */
const never = new AbortController().signal;

const signalToHost = (tabId: number, report: HostSignal) =>
  drive(tabId, agentHost.resume(sessionIdForTab(tabId), report, never));

async function startGuide(tabId: number, req: { goal?: string; steps?: readonly GuideStep[] }) {
  if (!(await ensureInjected(tabId))) return false;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? '';

  // The table is only needed by the resolution paths; the inspector already
  // knows which element it means.
  let table = emptyTable(url);
  if (!req.steps) {
    const ex = await sendToTab(tabId, {
      type: 'EXTRACT',
      profile: 'interactive',
      // The local matcher has no token budget, so it gets the whole page. Step 2
      // will ask for `budgetFor(contextWindow)` on the model's behalf — same
      // verb, different consumer, which is what `budget` is a parameter for.
      budget: LOCAL_BUDGET,
    });
    if (!ex.ok) return false;
    table = ex.data;
  }

  await drive(
    tabId,
    agentHost.start(
      {
        threadId: sessionIdForTab(tabId),
        url,
        table,
        contextWindow: CONTEXT_WINDOW,
        locale: 'zh-CN',
        ...(req.goal !== undefined ? { goal: req.goal } : {}),
        ...(req.steps ? { steps: req.steps } : {}),
      },
      never,
    ),
  );
  return true;
}

function emptyTable(url: string): PromptTable {
  return {
    snapshotId: '',
    url,
    title: '',
    pageHash: '',
    items: [],
    truncated: false,
    degraded: false,
    ambiguity: 0,
    stats: {
      elementsScanned: 0,
      candidates: 0,
      visible: 0,
      emitted: 0,
      shadowRoots: 0,
      emptyName: 0,
      modalScoped: false,
      ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
    },
  };
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.error('[page-guide] setPanelBehavior', e));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg as (HostRequest | ContentEvent) & { type?: string };
    if (!m?.type) return false;

    if (m.type === 'START_GUIDE') {
      const r = m as Extract<HostRequest, { type: 'START_GUIDE' }>;
      startGuide(r.tabId, r).then((ok) => sendResponse({ ok }));
      return true;
    }

    if (m.type === 'END_GUIDE') {
      const { tabId } = m as Extract<HostRequest, { type: 'END_GUIDE' }>;
      (async () => {
        await agentHost.abort(sessionIdForTab(tabId));
        await sendToTab(tabId, { type: 'CLEAR' });
        broadcast({ type: 'SESSION_ENDED', sessionId: sessionIdForTab(tabId), reason: 'aborted' });
        sendResponse({ ok: true });
      })();
      return true;
    }

    // Content events carry no tabId of their own — it comes from `sender`.
    const from = sender.tab?.id;
    if (from === undefined) return false;

    if (m.type === 'STEP_CONFIRMED') void signalToHost(from, { kind: 'confirmed' });
    if (m.type === 'STEP_SKIPPED') void signalToHost(from, { kind: 'skipped' });
    if (m.type === 'SESSION_ENDED' && (m as { reason?: string }).reason === 'user_closed')
      void agentHost.abort(sessionIdForTab(from));
    // The tracker only gives up once the target has really gone; re-presenting
    // the same step rebinds it from the descriptor, which is how an SPA
    // re-render is survived.
    if (m.type === 'TARGET_LOST') void signalToHost(from, { kind: 'reloaded' });
    // The renderer recovered on its own; only the panel's view needs correcting,
    // so this deliberately does *not* re-present (that would re-extract for
    // nothing).
    if (m.type === 'TARGET_FOUND') {
      void (async () => {
        const k = `thread:${sessionIdForTab(from)}`;
        const t = (await chrome.storage.session.get(k))[k] as
          | { cursor: number; steps: unknown[] }
          | undefined;
        if (t)
          broadcast({
            type: 'GUIDE_STATE',
            tabId: from,
            sessionId: sessionIdForTab(from),
            index: t.cursor,
            total: t.steps.length,
          });
      })();
    }
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete') return;
    void (async () => {
      const id = sessionIdForTab(tabId);
      if (!(await threadExists(id))) return;
      const url = tab.url ?? '';
      const thread = await currentUrlOf(id);
      await signalToHost(tabId, url === thread ? { kind: 'reloaded' } : { kind: 'navigated', url });
    })();
  });

  chrome.tabs.onRemoved.addListener((tabId) => void agentHost.abort(sessionIdForTab(tabId)));
});

/** The URL at which the current step was last presented. */
async function currentUrlOf(id: string): Promise<string> {
  const k = `thread:${id}`;
  const t = (await chrome.storage.session.get(k))[k] as { url?: string } | undefined;
  return t?.url ?? '';
}
