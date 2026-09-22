import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import {
  applyGuideInput,
  applyReading,
  applySaid,
  claimGuideEffect,
  threadsWithEffects,
  unrunGuideEffect,
  type PanelOpen,
  carryGuideThread,
  guideThreadExists,
  endGuide,
  peekGuideEffect,
  peekGuideThread,
  stepToRepaint,
  sweepExpiredGuideEffect,
  type GuideEffectDeps,
  type GuideEnding,
  type GuideReduction,
  type PresentEffect,
} from '@/agent/thread/writer';
import { bindingFromAck } from '@/agent/thread/binding';
import type { EffectRequest } from '@/agent/thread/effect';
import { present, presentationIdOf } from '@/agent/thread/transitions';
import { pendingOf, roundOf } from '@/agent/conversation/entries';
import { addEntry, addRound, carryConversation, dropConversation, pingTab, readConversation, stampEntry } from '@/host/conversation-store';
import type { ConversationView, EntryStep } from '@/shared/conversation';
import { budgetFor } from '@/agent/budget';
import { mergeTrace, traceKey } from '@/agent/agents/guide/trace';
import type { RecordStore } from '@/agent/thread/record-store';
import type { Reading } from '@/agent/context/turn';
import type { ExternalEnding, ThreadState } from '@/agent/thread/thread';
import type { PromptTable } from '@/core/extractor/types';
import type {
  ContentEvent,
  EffectAbortMessage,
  EffectClaimResponse,
  EffectResultMessage,
  GuideInflightResponse,
  GuideStep,
  HighlightMode,
  HostRequest,
  OverlayMessage,
  ResumeGuideResponse,
} from '@/shared/protocol';
import { PANEL_PORT, sessionIdForTab, tabIdForSession } from '@/shared/protocol';
import { buildOutline } from '@/shared/outline';
import { ensureInjected, sendToTab } from '@/shared/rpc';
import { MODEL_NOT_CONFIGURED, modelIsConfigured } from '@/agent/provider/provider';
import { loadConfig } from '@/shared/settings';

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

/**
 * The only place this file touches `chrome.storage.session` on the agent's
 * behalf. `src/agent/` may not reference `chrome.*` at all (N-1) — platform
 * neutrality is what lets it run under a node test and outlive any one host —
 * so the host hands it this thin pass-through instead. No logic of its own:
 * the guided flow (`agent/thread/writer.ts`) owns the key convention and the
 * state shape, this just relays `get`/`set`/`remove` to the real storage.
 */
const threadStore: ThreadStore = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
  remove: (key) => chrome.storage.session.remove(key),
};

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

function broadcast(msg: ContentEvent): void {
  // Nothing may be listening (side panel closed); that is not an error.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * The effect protocol's Host → Panel half (design doc §2.6). Reuses the same
 * broadcast mechanism as `ContentEvent` above ("既有广播机制的复用", not a new
 * transport) — every extension context gets it, and each
 * `sidepanel/effects.ts` instance decides for itself whether the `threadId`
 * is one it should answer (its own `tabIdRef` check).
 */
function broadcastEffectRequest(req: EffectRequest): void {
  chrome.runtime.sendMessage({ type: 'EFFECT_REQUEST', ...req }).catch(() => {});
}

/** E-5's other half: the host's storage side clears the tombstone when a run
 *  ends (`endGuide`); telling the panel to stop is chrome.*, so it lives here. */
function broadcastEffectAbort(effectId: string): void {
  const msg: EffectAbortMessage = { type: 'EFFECT_ABORT', effectId };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * The platform half of 「这趟引导结束了」.
 *
 * `endGuide` (agent/thread/writer.ts) owns everything that is storage — abandon
 * the tombstone, write the summary, drop the thread — and by N-1 it may
 * not touch `chrome.*`. So it hands back what only this file can do, and the
 * three things below are owed by *every* caller — any terminal the reducer
 * reaches, 结束引导, closing the overlay, closing the tab, and starting a new
 * guide over a running one. Before this each remembered a different subset:
 * one cleared the overlay, one broadcast the abort, some did neither.
 *
 * `ended: false` means there was nothing to end — already over, or never
 * started — and then nothing is owed. Whatever the overlay shows then is not
 * this run's to take down: a question's highlight, say.
 */
async function settleEnding(tabId: number, ending: GuideEnding, keepScreen = false): Promise<void> {
  if (!ending.ended) return;
  if (ending.cancelledEffectId) broadcastEffectAbort(ending.cancelledEffectId);
  // Harmless where the surface is already gone — the user closed the overlay
  // themselves, or it went with the tab: `sendToTab` answers
  // `no_content_script` rather than throwing. Kept only when what is on
  // screen is the answer itself: a question ends by showing what backs it up.
  if (!keepScreen) await sendToTab(tabId, { type: 'CLEAR' });
  await sayWaitingForPanel(tabId, false);
  // The run is over: what the panel shows is no longer pending anything.
  pingTab(tabId);
  if (ending.recordError) await addEntry(tabId, { at: Date.now(), kind: 'note', text: ending.recordError });
}

/** 「这趟引导结束了」 from outside the reducer — the user closed the overlay,
 *  started another guide here, or the tab is gone — and the caller says which,
 *  because the Run record keeps it. Idempotent, because `endGuide` is. */
async function endGuideForTab(tabId: number, how: ExternalEnding): Promise<void> {
  await settleEnding(tabId, await endGuide(guideEffectDeps, sessionIdForTab(tabId), how));
}

/**
 * `chrome.storage.local` as `record-store.ts`'s `RecordStore`.
 *
 * `QUOTA_BYTES` is the documented ceiling; `getBytesInUse()` is what is
 * actually spent. Asking before writing is §10.1's standing rule, and the one
 * failure it exists to prevent — a silently dropped record — is invisible from
 * both sides: the user believes the run was kept, S3 behaves as though it
 * never happened.
 */
const recordStore: RecordStore = {
  get: (key) => chrome.storage.local.get(key),
  set: (items) => chrome.storage.local.set(items),
  bytesInUse: () => chrome.storage.local.getBytesInUse(null),
  quota: chrome.storage.local.QUOTA_BYTES,
};

/**
 * The one `GuideEffectDeps` this worker ever constructs — `agent/thread/writer.ts`'s
 * `applyGuideInput`/`sweepExpiredGuideEffect` take it as a parameter rather
 * than reaching for `chrome.*` themselves (N-1), so this is where the real
 * store, the real broadcast and the real clock get plugged in.
 */
const guideEffectDeps: GuideEffectDeps = {
  store: threadStore,
  records: recordStore,
  flags: { get: (key) => chrome.storage.local.get(key) },
  send: (req) => void dispatchEffect(req),
  now: () => Date.now(),
  newEffectId: () => crypto.randomUUID(),
};

/**
 * Who can run a model call (ticket 06c). The call has to run in a side panel
 * — a service worker cannot hold a long request open — so the host asks the
 * browser, never a clock, whether one is open, and whether the panel that
 * took a call still is. The same page opened in a tab counts: it runs calls
 * the same way.
 */
const PANEL_URL = chrome.runtime.getURL('sidepanel.html');
const aPanelIsOpen = async (): Promise<boolean> =>
  (await chrome.runtime.getContexts({ documentUrls: [PANEL_URL] })).length > 0;

/**
 * The panels that are open right now, each by the name it gave itself
 * (`PANEL_PORT`).
 *
 * Panels used to be identified by `sender.documentId`, which the real side
 * panel does not have — its messages carry no document, no frame and no tab —
 * so the one surface this product is used through could never claim a call,
 * and every run stopped at 「正在想」. A panel now says who it is, and the
 * browser says when it is gone: the port disconnects with the document.
 */
const livePanels = new Set<string>();
/** Registered with the worker's other listeners, in `defineBackground` below. */
function watchPanelPorts(): void {
  chrome.runtime.onConnect.addListener((port) => {
    const cut = port.name.indexOf(':');
    const panelId = cut < 0 || port.name.slice(0, cut) !== PANEL_PORT ? '' : port.name.slice(cut + 1);
    if (!panelId) return;
    livePanels.add(panelId);
    port.onDisconnect.addListener(() => livePanels.delete(panelId));
  });
}
const panelIsOpen: PanelOpen = async (panelId) => livePanels.has(panelId);

/**
 * Hands a call to whichever panel claims it — or, with none open, tells the
 * user where the guide is waiting: a line on the overlay's card, and a badge
 * on the toolbar icon that opens the panel. The call stays in flight, unclaimed
 * and so never late (`judgeRecovery`), until a panel opens and the host hands
 * it out again (`handBackUnrun`).
 */
async function dispatchEffect(req: EffectRequest, announce = true): Promise<void> {
  const tabId = tabIdForSession(req.threadId as ThreadId);
  if (await aPanelIsOpen()) {
    broadcastEffectRequest(req);
    await sayWaitingForPanel(tabId, false);
  } else {
    await sayWaitingForPanel(tabId, true);
  }
  // A call going out changes what the run is doing without adding an entry;
  // the panel is told to look again, and computes 「在想」 from the thread.
  //
  // A hand-back (`announce: false`) changes nothing: the same call goes to
  // whoever will run it. Saying so would come straight back as another pull,
  // which hands it back again — a loop that ran at 320 round trips a second
  // and left no room for the call itself.
  if (announce) pingTab(tabId);
}

/** A call nobody is running — never claimed, or its panel has closed — goes out again. */
async function handBackUnrun(threadId: ThreadId): Promise<void> {
  const again = await unrunGuideEffect(guideEffectDeps, threadId, panelIsOpen);
  if (again) await dispatchEffect(again, false);
}

/**
 * The run follows the user into the tab a click opened for them.
 *
 * On activation rather than on creation: a middle-click that opens a tab in
 * the background is a page the user has *not* gone to — often one they mean to
 * read later, while they carry on where they are. A run that moved there would
 * leave the page they are still looking at, which is the same stranding this
 * exists to fix, only pointing the other way.
 *
 * Every branch out of here is a no-op: a tab that already has its own run, one
 * nothing opened, one whose opener has no run. That is what makes it safe to
 * ask on every single tab switch.
 */
async function carryGuideToTab(to: number, tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.openerTabId || !couldBeGuided(tab.url)) return false;
  if (await guideThreadExists(threadStore, sessionIdForTab(to))) return false;
  const from = tab.openerTabId;
  const { carried, cancelledEffectId } = await carryGuideThread(guideEffectDeps, sessionIdForTab(from), sessionIdForTab(to));
  if (!carried) return false;
  // It asked about the page the user has left; its answer would be a step for
  // a page nobody is on. Cancelled here, so it cannot land on the moved run.
  if (cancelledEffectId) broadcastEffectAbort(cancelledEffectId);
  await sendToTab(from, { type: 'CLEAR' });
  await sayWaitingForPanel(from, false);
  await carryConversation(from, to, '这一趟跟着你到新标签页来了');
  return true;
}

/**
 * A page a run could actually stand on.
 *
 * `http(s)` and nothing else: the content script reaches nowhere else, so a
 * run carried onto an extension page or a `chrome://` page is stranded
 * somewhere it can never continue. No address at all means the same thing
 * from the other side — this extension holds `<all_urls>` and no `tabs`
 * permission, so a tab whose address it cannot see is by definition one it
 * has no business on.
 *
 * That also rules out the new tab at the instant a click opens it, which has
 * no address yet. It is caught a moment later, when the page it went to
 * finishes loading — see the `onUpdated` listener.
 */
const couldBeGuided = (url: string | undefined): boolean => Boolean(url?.startsWith('http'));

const DEFAULT_TITLE = '页面引导';
const WAITING_TITLE = '引导在等侧栏：点这里打开侧栏，引导就会接着走';

/** Said, or unsaid, in both places the user might look: the overlay on the page and the toolbar icon. */
async function sayWaitingForPanel(tabId: number, waiting: boolean): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: waiting ? '!' : '' }).catch(() => {});
  if (waiting) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: waiting ? WAITING_TITLE : DEFAULT_TITLE }).catch(() => {});
  await sendToTab(tabId, { type: 'WAITING_FOR_PANEL', waiting });
}

/** One extraction of the page as it is right now, or `null` if it cannot be read. */
async function extractNow(tabId: number): Promise<PromptTable | null> {
  const budget = budgetFor((await loadConfig()).contextWindow);
  const ex = await sendToTab(tabId, { type: 'EXTRACT', profile: 'interactive', budget });
  return ex.ok ? ex.data : null;
}

/**
 * A reading (CONTEXT.md `Reading`): one of the four observation sources saw
 * something in this tab. The page is read once, right after — inside the
 * thread's write chain (`applyReading`), so a slow read of the page being
 * left cannot land after a quick read of the page arrived at — and both are
 * written down; then whatever that wakes is carried out.
 *
 * No window and no second look. Whether the page has finished answering is
 * the model's to judge, with `wait_for` and `observe`: every guess this host
 * used to make about how long to wait was one more wait that could stall on
 * its own (CONTEXT.md, the note after `Reading`).
 */
async function readingArrived(tabId: number, reading: Reading, presentationId?: string): Promise<GuideReduction | null> {
  const threadId = sessionIdForTab(tabId);
  // E-4 is a passive check on the next message, and a reading is a message.
  // Without this, a call whose panel threw — or was never answered for any
  // other reason — sat in flight for as long as the user only looked at the
  // page, and the guide never recovered on its own.
  const swept = await sweepExpiredGuideEffect(guideEffectDeps, threadId);
  if (swept) await renderGuideOutcome(tabId, threadId, swept);
  const read = async () => ((await ensureInjected(tabId)) ? await extractNow(tabId) : null);
  const outcome = await applyReading(guideEffectDeps, threadId, reading, read, presentationId);
  if (outcome) await renderGuideOutcome(tabId, threadId, outcome);
  // Something happened on the page while a call was out: the moment to ask
  // whether anyone is still running it — its panel may have been closed
  // under it (06c). A call this reading just sent is new, and is not asked about.
  if (outcome?.state?.inflight && outcome.sent.length === 0) await handBackUnrun(threadId);
  return outcome;
}

/**
 * The one place that turns `applyGuideInput`'s raw `MachineEffect[]` into real
 * `HIGHLIGHT` commands and panel broadcasts.
 *
 * `present`: builds a `HighlightCommand`, dispatches it, and broadcasts what
 * the paint came back with (`bindingFromAck`) beside the three axes and
 * `route` (`GuideState`'s optional fields). What the paint says is shown,
 * never concluded from: a refusal that is a fact about the step becomes a
 * reading (CONTEXT.md `Reading`).
 *
 * `notify`: goes into the conversation as a note, and onto the overlay's card
 * — the two places the user might be looking.
 *
 * `cancel`: the panel running that effect stops it (`EFFECT_ABORT`).
 *
 * `callModel`/`fetchDoc` need nothing here: `applyGuideInput` already
 * dispatched them (`deps.send`, E-1) before this function ever sees the
 * outcome.
 */
async function renderGuideOutcome(
  tabId: number,
  threadId: ThreadId,
  outcome: GuideReduction,
  /** What the model call this outcome came from spent, when it came from one. */
  usage?: { prompt: number; completion: number },
): Promise<void> {
  const state = outcome.state;
  if (!state) return; // E-2 discard, or effect_result for a thread that no longer exists

  // What the user is told as this run ends, said on the overlay once the
  // highlight has come down — said before, the clearing would take it with it.
  let closingNote: string | null = null;
  /** Something to read that is not a step: it goes into the conversation, and
   *  onto the overlay's card now — or, when this reduction ends the run, once
   *  the run has been settled (the clearing would take it with it). */
  const note = async (text: string, detail?: string) => {
    await addEntry(tabId, { at: Date.now(), kind: 'note', text, ...(detail ? { detail } : {}) });
    if (outcome.ending) closingNote = text;
    else await say(tabId, { kind: 'note', title: '提示', text });
  };

  for (const effect of outcome.effects) {
    if (effect.kind === 'present') {
      const res = await paintStep(tabId, threadId, state, effect);
      // The step becomes an entry, carrying the thinking that produced it.
      // What the paint answered is written onto the entry rather than
      // broadcast: the panel reads the conversation, never a passing message.
      await addEntry(
        tabId,
        {
          at: Date.now(),
          kind: 'step',
          text: effect.step.title,
          ...(effect.step.detail !== undefined ? { detail: effect.step.detail } : {}),
          step: {
            index: effect.index,
            total: effect.total,
            presentationId: presentationIdOf(threadId, state),
            ...(res.ok && res.data.failure === 'ref_not_found' ? { outcome: 'not_found' as const } : {}),
          },
          // §5.7's three axes and the model's waypoints, beside the step they
          // are about — the same facts the old `GUIDE_STATE` carried, now
          // written down where they stay readable after the fact.
          axes: {
            evidence: state.evidence,
            check: state.check,
            binding: res.ok ? bindingFromAck(res.data) : 'unbound',
          },
          ...(state.route.length ? { route: state.route } : {}),
          ...(usage ? { usage } : {}),
        },
        true,
        // A fixed plan reaches the screen without a model call; there is no
        // round to show for it.
        state.planSource === 'model' ? { tool: 'point', ...(usage ? { usage } : {}) } : undefined,
      );

      // Nothing else in what the paint says is written down. It used to be:
      // every failure became 「找不到这一步的目标」 and an `unavailable` stamp —
      // including a paint cut short by the next command or by a CLEAR, which
      // answers `ref_not_found` too, and which by then was written onto
      // whatever step held this tab, of this run or the next.
      //
      // Two refusals are facts about this step, and go in as readings matched
      // to this presentation: the tab is no longer at the page the step was
      // drawn from (symptom 2), or its target is a password-like field. The
      // page is read again, and the model — or a fixed plan — decides what now.
      // A target painted as 「找不到」 is the renderer's own to report
      // (`TARGET_NOT_FOUND`), once for the presentation.
      const refused = res.ok ? res.data.failure : undefined;
      if (refused === 'view_moved' || refused === 'sensitive_blocked') {
        const why = refused === 'view_moved' ? 'elsewhere' : 'sensitive';
        await readingArrived(tabId, { kind: 'not_shown', why }, presentationIdOf(threadId, state));
      }
    } else if (effect.kind === 'ask') {
      const answerIt =
        state.ending === undefined ? '在侧栏的输入框里回答它。' : '在侧栏的输入框里，把回答连同你要做的事一起再说一次。';
      const noSecrets = effect.wants === 'text' ? '密码、验证码、卡号不要写进来——那些只在页面上自己填。' : '';
      await addEntry(
        tabId,
        {
          at: Date.now(),
          kind: 'ask',
          text: effect.question,
          // The same guidance the overlay's card gives: how to answer, and —
          // when words are asked for — what never belongs in them.
          detail: answerIt + noSecrets,
          options: effect.options.map((o) => ({ ref: String(o.ref), label: o.label })),
          ...(usage ? { usage } : {}),
        },
        true,
        { tool: 'ask', ...(usage ? { usage } : {}) },
      );

      // Outline every candidate at once (`buildOutline` puts several in
      // `alsoRefs` rather than setting `ref`, so nothing here picks one for
      // the user — K-6). An ask for words has no candidates: `buildOutline`
      // returns `null` and only the question is shown.
      const items = effect.options
        .map((o) => state.table.items.find((i) => i.ref === o.ref))
        .filter((i): i is NonNullable<typeof i> => i !== undefined);
      const outline = buildOutline(items, '需要你先选一个');
      if (outline) {
        await sendToTab(tabId, {
          type: 'HIGHLIGHT',
          command: {
            sessionId: threadId,
            presentationId: `${presentationIdOf(threadId, state)}:ask`,
            snapshotId: state.table.snapshotId,
            view: state.table.url,
            mode: 'explain',
            step: outline,
            autoScroll: true,
            skippable: false,
          },
        });
      }
      await say(tabId, { kind: 'ask', title: '需要你先说清楚', text: [effect.question, answerIt + noSecrets].join('\n') });
    } else if (effect.kind === 'observe') {
      // The model asked to look again. One read, now, and no retry on a clock:
      // whether the page has finished arriving is the model's to judge
      // (CONTEXT.md `Reading`), and a page that cannot be read is exactly what
      // it gets told — it can look again, or answer.
      const table = (await ensureInjected(tabId)) ? await extractNow(tabId) : null;
      const next = await applyGuideInput(guideEffectDeps, threadId, {
        kind: 'tool_result',
        effectId: effect.effectId,
        result: table ? { kind: 'page', table } : { kind: 'unreadable' },
      });
      await showThinking(tabId, next, usage);
      await renderGuideOutcome(tabId, threadId, next);
    } else if (effect.kind === 'waitFor') {
      // The model's wait (`wait_for`), already capped. The content script
      // watches the page for the text; then the page is read once, as it is
      // now. A wait the page walked away from — a navigation drops the
      // content script mid-wait — is reported as not finished, never as met or
      // missed, and the new page is what gets read.
      const waited = (await ensureInjected(tabId))
        ? await sendToTab(tabId, { type: 'WAIT_FOR', until: effect.until, text: effect.text, timeoutMs: effect.seconds * 1000 })
        : null;
      const table = (await ensureInjected(tabId)) ? await extractNow(tabId) : null;
      const waitResult = {
        kind: 'waited' as const,
        until: effect.until,
        text: effect.text,
        seconds: waited?.ok ? Math.round(waited.data.waitedMs / 100) / 10 : effect.seconds,
        met: waited?.ok ? waited.data.met : null,
        table,
      };
      const next = await applyGuideInput(guideEffectDeps, threadId, { kind: 'tool_result', effectId: effect.effectId, result: waitResult });
      await showThinking(tabId, next, usage);
      await renderGuideOutcome(tabId, threadId, next);
    } else if (effect.kind === 'explain') {
      // The answer to a question about the page: the words to the panel, and
      // everything that backs them up outlined at once — the same way an ask
      // outlines its candidates, none of them singled out (K-6).
      await addEntry(
        tabId,
        { at: Date.now(), kind: 'answer', text: effect.answer, ...(usage ? { usage } : {}) },
        true,
        { tool: 'explain', ...(usage ? { usage } : {}) },
      );
      const items = effect.refs
        .map((ref) => state.table.items.find((i) => i.ref === ref))
        .filter((i): i is NonNullable<typeof i> => i !== undefined);
      const outline = buildOutline(items, '依据');
      if (outline) {
        await sendToTab(tabId, {
          type: 'HIGHLIGHT',
          command: {
            sessionId: threadId,
            presentationId: `${presentationIdOf(threadId, state)}:explain`,
            snapshotId: state.table.snapshotId,
            view: state.table.url,
            mode: 'explain',
            step: outline,
            autoScroll: true,
            skippable: false,
          },
        });
      }
      await say(tabId, { kind: 'answer', title: '回答', text: effect.answer });
    } else if (effect.kind === 'requestCrossSiteConfirm') {
      // P-2. Broadcast only — nothing is painted, because the whole point is
      // that the user decides before the step reaches the screen. The step is
      // already loaded behind this card, so answering costs no model call
      // either way.
      await addEntry(
        tabId,
        {
          at: Date.now(),
          kind: 'note',
          text: '这一步会离开当前站点',
          detail: `你正要从 ${effect.from} 前往 ${effect.to}。`,
        },
        true,
      );
      await say(tabId, { kind: 'cross_site', title: '这一步会离开当前站点', text: `你正要从 ${effect.from} 前往 ${effect.to}。` });
    } else if (effect.kind === 'done') {
      // The guide is over. The model's `done` (`guide/output/done.ts`) and the
      // repeat backstop (`guide/output/point.ts`) both end the thread and empty
      // `steps`, so there is nothing left to point at — and the overlay has to
      // go with it.
      //
      // The old note here argued the opposite, and it was right about the
      // world it was written in: back then `status` stayed `active`, so
      // clearing the overlay tore down the only surface carrying the step the
      // user was being asked to confirm, and the guide went on planning
      // against a wiped screen. Now the thread ends, and leaving a highlight up
      // says the opposite of what the panel says. Measured before the change:
      // 11 of 21 live journeys proposed `done` more than once — one of them
      // five times — because the user's obvious move is to click the control
      // still glowing at them, which re-plans, which arrives again.
      //
      // Disagreeing is still possible and still cheap: asking again starts a
      // new guide, which is the one input a finished thread accepts.
      // The overlay is cleared below, off `outcome.ending`, not here: the model
      // saying it arrived is only one of five ways a run can stop, and the
      // other four used to leave the highlight up because this branch was the
      // only one that took it down.
      const text =
        effect.ending === 'model_done'
          ? `看起来已经到了：${effect.why}\n\n引导到这里结束。如果这不是你要找的，再说一次目标就行。`
          : effect.ending === 'steps_walked'
            ? `${effect.why}，引导到这里结束。`
            : `引导在原地打转，已经停下：${effect.why}`;
      await note(text);
    } else if (effect.kind === 'notify') {
      await note(effect.message);
    } else if (effect.kind === 'cancel') {
      broadcastEffectAbort(effect.effectId);
    }
  }

  // Whatever ended the run — arrival, the step budget, a credential page after
  // a cross-site hop, the loop backstop, or a fixed plan running out — the run
  // is over and the same three things are owed: the highlight comes down, the
  // effect that was still in flight is abandoned, and a summary that could not
  // be saved is admitted rather than swallowed. A question is the exception to
  // the first: what it answered, and outlined, stays up.
  if (outcome.ending) await settleEnding(tabId, outcome.ending, state.ending === 'answered');
  if (closingNote) await say(tabId, { kind: 'note', title: '引导结束了', text: closingNote });
}

/**
 * A tool round just finished: show it as thinking while this step is still
 * being decided. Read from the turn the reducer recorded, so what the panel
 * discloses is the model's own call and the result it was actually given —
 * never a reconstruction of either.
 */
async function showThinking(tabId: number, outcome: GuideReduction, usage?: { prompt: number; completion: number }): Promise<void> {
  const rounds = outcome.state?.turn?.rounds ?? [];
  // The draft mirrors this turn's rounds, so only what is not on it yet is
  // added — a turn that goes on for several rounds shows each of them once.
  const shown = (await readConversation(tabId)).draft?.length ?? 0;
  for (const round of rounds.slice(shown)) await addRound(tabId, roundOf(round, usage));
}

/** The overlay's card (ticket 10c): the same words the side panel shows, for a
 *  user looking at the page — or `null` to take it down. */
async function say(tabId: number, message: OverlayMessage | null): Promise<void> {
  await sendToTab(tabId, { type: 'SAY', message });
}

/**
 * Everything the panel shows, in one answer: the conversation as written, what
 * the run is doing right now, and the step pinned above it.
 *
 * `pending` is computed here from the thread on every ask (`pendingOf`), which
 * is why the panel can no longer be stuck on a state that has passed: there is
 * no flag anywhere to be stale. The pinned step is the entry that showed it, so
 * the card and the history cannot disagree about which step this is.
 */
async function conversationView(tabId: number): Promise<ConversationView> {
  const threadId = sessionIdForTab(tabId);
  const [conversation, thread] = await Promise.all([readConversation(tabId), peekGuideThread(threadStore, threadId)]);
  const shown = thread && !thread.ending ? shownOn(thread) : null;
  const presentationId = thread && shown ? presentationIdOf(threadId, thread) : null;
  const entry = presentationId ? conversation.entries.find((e) => e.step?.presentationId === presentationId) : undefined;
  return {
    conversation,
    pending: pendingOf(thread, { panelOpen: await aPanelIsOpen(), lastEntry: conversation.entries.at(-1) ?? null }),
    step:
      shown && entry
        ? {
            entryId: entry.id,
            title: shown.step.title,
            ...(shown.step.detail !== undefined ? { detail: shown.step.detail } : {}),
            index: shown.index,
            total: shown.total,
            skippable: thread!.planSource === 'fixed',
          }
        : null,
  };
}

/** The step on screen, read off the thread — `null` when there is none. */
const shownOn = (state: ThreadState): PresentEffect | null => (state.steps[state.cursor] ? present(state) : null);

/**
 * Content events mean something only while a guide owns the tab. Asked here,
 * once, so a tab with nothing running never pays for an extraction.
 */
async function ifGuiding(tabId: number, then: (threadId: ThreadId) => Promise<void>): Promise<void> {
  const threadId = sessionIdForTab(tabId);
  if (await guideThreadExists(threadStore, threadId)) await then(threadId);
}

/**
 * Paints the step the guide is on without moving it — for the moment the
 * screen lost it while the run did not: a question's highlight took the overlay
 * over (`PANEL_RESUME_GUIDE`). Reads the thread through its one named read,
 * never a storage key typed inline, and writes nothing.
 *
 * `null` when there is no step to paint — no guide, one already over, or a
 * model-driven plan whose next plan is already on its way (its steps belong
 * to the page the user left; `stepOnScreen` in machine.ts).
 */
async function redrawGuide(tabId: number) {
  const threadId = sessionIdForTab(tabId);
  const shown = await stepToRepaint(threadStore, threadId);
  return shown ? await paintStep(tabId, threadId, shown.state, shown.present) : null;
}

/**
 * One guide step onto the page — the single place a step's `HighlightCommand`
 * is built, for the first time it is shown and every repaint after. 跳过 is
 * offered only where it does something: a fixed plan.
 */
async function paintStep(tabId: number, threadId: ThreadId, state: ThreadState, effect: PresentEffect) {
  return await sendToTab(tabId, {
    type: 'HIGHLIGHT',
    command: {
      sessionId: threadId,
      presentationId: presentationIdOf(threadId, state),
      snapshotId: state.table.snapshotId,
      view: state.table.url,
      mode: 'guide',
      step: effect.step,
      progress: { index: effect.index, total: effect.total },
      autoScroll: true,
      skippable: state.planSource === 'fixed',
    },
  });
}

/**
 * The steps of a plan that needs no planning — the inspector's, handed over
 * whole — or `null` when this goal is the model's to plan.
 *
 * `ref` and `alsoRefs` are dropped from handed-over steps. A ref only means
 * something inside the snapshot it was drawn from, and the host is about to
 * take its own; carried across, a panel-side `e12` would be read against the
 * host's snapshot, where it can name a different element — L-4, the one hard
 * zero. The descriptor is what survives a snapshot, and binding from it happens
 * when the step is painted.
 */
function fixedStepsFor(steps: readonly GuideStep[] | undefined): [GuideStep, ...GuideStep[]] | null {
  const [first, ...rest] = (steps ?? []).map(({ ref: _ref, alsoRefs: _alsoRefs, ...identity }) => identity);
  return first ? [first, ...rest] : null;
}

async function startGuide(tabId: number, req: { goal: string; steps?: readonly GuideStep[] }) {
  // Every refusal below says so in the conversation. A refusal the user
  // cannot see is what left the panel on 「正在想…」 for good: the host knew,
  // and nobody was told.
  if (!(await ensureInjected(tabId))) {
    await addEntry(tabId, {
      at: Date.now(),
      kind: 'note',
      text: '这个页面上用不了',
      detail: '浏览器不允许扩展在这种页面上运行（chrome:// 开头的页面、应用商店、其它扩展的页面、PDF，以及没给本扩展访问权限的站点）。换一个普通网页再说一次。',
    });
    return false;
  }

  const threadId = sessionIdForTab(tabId);

  // One entry, one run at a time (08b). What the user says while a model
  // guide is going is said *to* it — a reading it wakes on, whether it turns
  // out to be a question on the way or a change of what to do. Only when
  // nothing is there to hear it does a new run start. A plan handed over
  // whole (the inspector's row) always starts one.
  if (!req.steps) {
    const heard = await applySaid(guideEffectDeps, threadId, req.goal, async () =>
      (await ensureInjected(tabId)) ? await extractNow(tabId) : null,
    );
    if (heard) {
      await renderGuideOutcome(tabId, threadId, heard);
      return true;
    }
  }

  // A new guide gets a fresh debug trace. Threads are keyed by tab and so is
  // the trace, so without this a second guide in the same tab appends to the
  // first one's record — and since the trace keeps only its last 24 entries,
  // the new guide's opening calls get evicted by the old guide's. Cleared
  // here rather than in `dropGuideThread`: a guide that just ended badly is
  // precisely when someone wants to read its trace, so ending one must not
  // destroy it.
  await chrome.storage.session.remove(traceKey(threadId)).catch(() => {});

  // A plan handed over whole — the inspector's row — runs as a fixed plan:
  // landed as given, never planned, never billed. Everything else is the
  // model's.
  //
  // Without a model there is nothing to plan with, and saying so is the
  // answer. This used to fall back to the local lexical matcher, which on real
  // pages almost never produced a usable one — four live github.com goals in
  // two languages all got a wrong or ambiguous single highlight — and every
  // e2e fixture was small enough to hide that.
  const steps = fixedStepsFor(req.steps);
  const cfg = await loadConfig();
  if (!steps && !modelIsConfigured(cfg)) {
    await addEntry(tabId, { at: Date.now(), kind: 'note', text: MODEL_NOT_CONFIGURED });
    return false;
  }

  // Read once. Reading the page failed, and saying so is the honest outcome:
  // a guide started against a page it could not read has nothing to compare
  // the next page with. It is not tried again after a pause — how long a page
  // takes to become readable is not something this product guesses at, and
  // the user saying it again is a retry they can see.
  const ex = await sendToTab(tabId, { type: 'EXTRACT', profile: 'interactive', budget: budgetFor(cfg.contextWindow) });
  if (!ex.ok) {
    await addEntry(tabId, { at: Date.now(), kind: 'note', text: `读不到这个页面的内容：${ex.message}` });
    return false;
  }
  const table = ex.data;

  // A new guide is also the end of the one already running here: its summary
  // is written and its in-flight call abandoned, exactly as if the user had
  // pressed 结束引导. Starting over it used to overwrite the thread in place —
  // no record, and a model call left running for a plan nobody would see.
  // Done only now, once the new guide is certain to start: a refusal above
  // (no model, an unreadable page) leaves the running guide alone.
  await endGuideForTab(tabId, 'superseded');

  const outcome = await applyGuideInput(
    guideEffectDeps,
    threadId,
    steps
      ? { kind: 'start_fixed', goal: req.goal, table, steps }
      : { kind: 'start', goal: req.goal, table, effectId: guideEffectDeps.newEffectId() },
  );
  await renderGuideOutcome(tabId, threadId, outcome);
  return true;
}

export default defineBackground(() => {
  watchPanelPorts();
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.error('[page-guide] setPanelBehavior', e));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg as (HostRequest | ContentEvent | EffectResultMessage) & { type?: string };
    if (!m?.type) return false;

    // What the user said. It goes into the conversation first — the user's
    // own words are not conditional on anything the run does with them — and
    // then to the run, which either hears it (08b) or starts over.
    if (m.type === 'SAID') {
      const r = m as Extract<HostRequest, { type: 'SAID' }>;
      void (async () => {
        await addEntry(r.tabId, { at: Date.now(), kind: 'said', text: r.text });
        const ok = await startGuide(r.tabId, { goal: r.text });
        sendResponse({ ok });
      })();
      return true;
    }

    // The inspector's row: a plan handed over whole, which never reaches the
    // model. It is still something the user asked for, so it is said too.
    if (m.type === 'POINT_AT') {
      const r = m as Extract<HostRequest, { type: 'POINT_AT' }>;
      void (async () => {
        await addEntry(r.tabId, { at: Date.now(), kind: 'said', text: r.goal });
        const ok = await startGuide(r.tabId, { goal: r.goal, steps: r.steps });
        sendResponse({ ok });
      })();
      return true;
    }

    // The panel's one authoritative read. Everything it shows comes from here:
    // the conversation, what the run is doing right now (computed from the
    // thread, never remembered), and the step pinned on screen.
    if (m.type === 'GET_CONVERSATION') {
      const { tabId } = m as Extract<HostRequest, { type: 'GET_CONVERSATION' }>;
      void (async () => {
        // A pull comes from a panel that is open right now, which is the one
        // thing a call in flight needs: somebody to run it. So the pull is
        // also the passive check E-4 asks for, and the moment to hand back a
        // call nobody is running.
        //
        // Without this a call whose claimant went away — the panel closed, its
        // window gone — stayed in flight for good on a page where no step had
        // been painted yet: the renderer reports readings only about a step on
        // screen, so nothing would ever arrive to trigger the check, and the
        // panel showed 「正在想」 until the user gave up. Reproduced, then
        // fixed here (e2e 「孤儿调用」).
        const threadId = sessionIdForTab(tabId);
        const swept = await sweepExpiredGuideEffect(guideEffectDeps, threadId);
        if (swept) await renderGuideOutcome(tabId, threadId, swept);
        else await handBackUnrun(threadId);
        sendResponse(await conversationView(tabId));
      })();
      return true;
    }

    if (m.type === 'CROSS_SITE_DECISION') {
      const { tabId, confirmed } = m as Extract<HostRequest, { type: 'CROSS_SITE_DECISION' }>;
      void (async () => {
        const outcome = await applyGuideInput(guideEffectDeps, sessionIdForTab(tabId), {
          kind: 'cross_site_decision',
          confirmed,
        });
        await renderGuideOutcome(tabId, sessionIdForTab(tabId), outcome);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // The panel's pinned card offers 跳过 for a fixed plan, the same gesture
    // the overlay's own button makes.
    if (m.type === 'SKIP_STEP') {
      const { tabId } = m as Extract<HostRequest, { type: 'SKIP_STEP' }>;
      void (async () => {
        await ifGuiding(tabId, async (id) => {
          const t = await peekGuideThread(threadStore, id);
          if (t) await stampEntry(tabId, presentationIdOf(id, t), 'skipped');
          await renderGuideOutcome(tabId, id, await applyGuideInput(guideEffectDeps, id, { kind: 'step_skipped' }));
        });
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (m.type === 'END_GUIDE') {
      const { tabId } = m as Extract<HostRequest, { type: 'END_GUIDE' }>;
      (async () => {
        // Everything the host has to do when a guide is over now lives in one place
        // (`endGuide` + `settleEnding`), because there are several ways for a
        // run to end and only this one used to do the whole job.
        const ending = await endGuide(guideEffectDeps, sessionIdForTab(tabId), 'user_ended');
        await settleEnding(tabId, ending);
        // `settleEnding` takes the overlay down when a run really ended. This
        // press takes it down either way: the user aimed at a surface that is
        // up, and what it shows may not be a run at all — a question's
        // highlight, or a guide that already ended.
        if (!ending.ended) await sendToTab(tabId, { type: 'CLEAR' });
        broadcast({ type: 'SESSION_ENDED', sessionId: sessionIdForTab(tabId), reason: 'aborted' });
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (m.type === 'EFFECT_RESULT') {
      const r = m as EffectResultMessage;
      const threadId = r.threadId as ThreadId; // echoed back verbatim from a real `sessionIdForTab()` on the panel side
      void (async () => {
        // Debug trace, before anything that can early-return: it is keyed by
        // thread and `storage.session` is the worker's alone (N-6), so this is
        // the only place it can be written. Deliberately outside the decision
        // path — a failure here must not touch the result being processed.
        if (r.trace) {
          const key = traceKey(threadId);
          try {
            const existing = (await chrome.storage.session.get(key))[key];
            await chrome.storage.session.set({ [key]: mergeTrace(existing, r.trace) });
          } catch {
            /* a trace that cannot be stored is not a reason to drop a result */
          }
        }
        // A result that lands after its deadline meets the sweep first, and
        // what the sweep concludes — 「调用超时」, or the model asked again when
        // a reading arrived meanwhile — is all the user will ever hear about that call: the
        // result itself is discarded as stale right below (E-2).
        const swept = await sweepExpiredGuideEffect(guideEffectDeps, threadId);
        if (swept) await renderGuideOutcome(tabIdForSession(threadId), threadId, swept);
        const outcome = await applyGuideInput(guideEffectDeps, threadId, {
          kind: 'effect_result',
          effectId: r.effectId,
          at: r.at,
          outcome: r.outcome,
        });
        const usage = r.outcome.usage ? { prompt: r.outcome.usage.prompt, completion: r.outcome.usage.completion } : undefined;
        // A document the model asked for is a round too: show it as thinking.
        await showThinking(tabIdForSession(threadId), outcome, usage);
        // `EFFECT_RESULT` arrives from the panel, which has no `sender.tab` —
        // `threadId` is the wire's only address, so it is decoded back into a
        // tab id here (`tabIdForSession`, the inverse of `sessionIdForTab`).
        await renderGuideOutcome(tabIdForSession(threadId), threadId, outcome, usage);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // E-6: the panel's pull on mount. A panel is open now, so every call no
    // panel is running — dispatched while none was open, or whose panel has
    // since closed, on any tab — goes out again first (06c): panels run every
    // tab's calls. Then the E-4 sweep, rendered like any other outcome: a
    // call its panel took and ran past its deadline has nobody else to report it.
    if (m.type === 'PANEL_GUIDE_INFLIGHT') {
      const { tabId } = m as Extract<HostRequest, { type: 'PANEL_GUIDE_INFLIGHT' }>;
      void (async () => {
        for (const id of threadsWithEffects(await chrome.storage.session.get(null))) await handBackUnrun(id);
        const threadId = sessionIdForTab(tabId);
        const swept = await sweepExpiredGuideEffect(guideEffectDeps, threadId);
        if (swept) await renderGuideOutcome(tabId, threadId, swept);
        const effect = await peekGuideEffect(threadStore, threadId);
        const res: GuideInflightResponse = { recovery: effect ? 'in_progress' : 'none', effect };
        sendResponse(res);
      })();
      return true;
    }

    // Which open panel runs a call (`judgeClaim` in `agent/thread/effect.ts`).
    // The claimant is the asking document, kept with the effect so the host can
    // later ask whether it is still open. A panel is always a document; a claim
    // without one is refused rather than recorded against nobody.
    if (m.type === 'EFFECT_CLAIM') {
      const { threadId, effectId, panelId } = m as Extract<HostRequest, { type: 'EFFECT_CLAIM' }>;
      void (async () => {
        // Who is asking is what the panel says it is, not what the message
        // came wrapped in: `sender` tells us nothing about a real side panel.
        const granted = panelId ? await claimGuideEffect(guideEffectDeps, threadId as ThreadId, effectId, panelId, panelIsOpen) : false;
        const res: EffectClaimResponse = { granted };
        sendResponse(res);
      })();
      return true;
    }

    // The PANEL_* verbs exist only because the content script must answer to
    // exactly one commander. Without them the panel would `sendToTab` directly,
    // and `tabId` would be interpreted twice — once here, once in the panel.
    if (m.type === 'PANEL_EXTRACT') {
      const { tabId } = m as Extract<HostRequest, { type: 'PANEL_EXTRACT' }>;
      void (async () => {
        if (!(await ensureInjected(tabId)))
          return sendResponse({
            ok: false,
            code: 'no_content_script',
            message: '本页面不允许扩展运行（或尚未授权该站点）',
          });
        sendResponse(
          await sendToTab(tabId, {
            type: 'EXTRACT',
            profile: 'interactive',
            budget: budgetFor((await loadConfig()).contextWindow),
          }),
        );
      })();
      return true;
    }

    if (m.type === 'PANEL_INSPECT') {
      const { tabId, on } = m as Extract<HostRequest, { type: 'PANEL_INSPECT' }>;
      void (async () => {
        if (!(await ensureInjected(tabId)))
          return sendResponse({
            ok: false,
            code: 'no_content_script',
            message: '本页面不允许扩展运行（或尚未授权该站点）',
          });
        sendResponse(await sendToTab(tabId, { type: 'INSPECT', on }));
      })();
      return true;
    }

    // Redraws the tab's parked guide step without advancing its cursor — the
    // panel calls this once an answer's outline is closed, to hand the screen back.
    // Paints through `redrawGuide`, which reads the thread by name and writes
    // nothing: a question never moves the guide.
    if (m.type === 'PANEL_RESUME_GUIDE') {
      const { tabId } = m as Extract<HostRequest, { type: 'PANEL_RESUME_GUIDE' }>;
      void (async () => {
        if (!(await ensureInjected(tabId)))
          return sendResponse({
            ok: false,
            code: 'no_content_script',
            message: '本页面不允许扩展运行（或尚未授权该站点）',
          });

        const res = await redrawGuide(tabId);
        if (!res) {
          const resp: ResumeGuideResponse = {
            ok: false,
            code: 'no_active_guide',
            message: '没有正在进行的引导可以恢复。',
          };
          return sendResponse(resp);
        }
        sendResponse(res);
      })();
      return true;
    }

    // Content events carry no tabId of their own — it comes from `sender`.
    const from = sender.tab?.id;
    if (from === undefined) return false;

    // The four observation sources (CONTEXT.md `Reading`): the user used the
    // step's target, the target went off the page, the page's structure
    // changed by itself — and, below, a whole page finished loading. Each is
    // written down as what it saw, and nothing more (`readingArrived`).
    if (m.type === 'STEP_USED') {
      const { presentationId, how } = m as Extract<ContentEvent, { type: 'STEP_USED' }>;
      void stampEntry(from, presentationId, 'used');
      void readingArrived(from, { kind: 'used', how }, presentationId);
    }
    if (m.type === 'TARGET_LOST') {
      void (async () => {
        const t = await peekGuideThread(threadStore, sessionIdForTab(from));
        if (t) await stampEntry(from, presentationIdOf(sessionIdForTab(from), t), 'gone');
      })();
      void readingArrived(from, { kind: 'target_lost' });
    }
    if (m.type === 'PAGE_STRUCTURE_CHANGED') void readingArrived(from, { kind: 'changed' });
    // A fixed plan moves to its next step; a model-driven guide stays where it
    // is (`handleStepSkipped` says why).
    if (m.type === 'STEP_SKIPPED')
      void ifGuiding(from, async (id) => {
        const t = await peekGuideThread(threadStore, id);
        if (t) await stampEntry(from, presentationIdOf(id, t), 'skipped');
        await renderGuideOutcome(from, id, await applyGuideInput(guideEffectDeps, id, { kind: 'step_skipped' }));
      });
    // Closing the overlay ends the run, and for a model-driven one that means
    // money: the call still in flight is abandoned rather than paid for and
    // thrown away. This used to clean up the old host only, so a model-driven run left its
    // thread, its `effect:` mirror and its unwritten summary behind — and the
    // leftover thread then owned this tab's ownership query forever.
    if (m.type === 'SESSION_ENDED' && (m as { reason?: string }).reason === 'user_closed')
      void endGuideForTab(from, 'overlay_closed');
    // The renderer recovered on its own; only the panel's view needs correcting,
    // so this deliberately does *not* re-present (that would re-extract for
    // nothing).
    // The renderer recovered on its own: the step that was 「找不到」 is on
    // screen again, so the entry that showed it stops saying otherwise.
    if (m.type === 'TARGET_FOUND') {
      void (async () => {
        const id = sessionIdForTab(from);
        const t = await peekGuideThread(threadStore, id);
        if (t) await stampEntry(from, presentationIdOf(id, t), undefined, 'bound');
      })();
    }
    // The overlay's card was answered: the same as the side panel's buttons.
    if (m.type === 'CROSS_SITE_DECIDED') {
      const { confirmed } = m as Extract<ContentEvent, { type: 'CROSS_SITE_DECIDED' }>;
      void (async () => {
        const id = sessionIdForTab(from);
        await renderGuideOutcome(from, id, await applyGuideInput(guideEffectDeps, id, { kind: 'cross_site_decision', confirmed }));
      })();
    }
    // A question or an answer closed on the overlay: the screen goes back to the
    // step, or — with no guide going — the outline comes down, as the side
    // panel's 关闭 does.
    if (m.type === 'MESSAGE_CLOSED')
      void (async () => {
        if (!(await redrawGuide(from))) await sendToTab(from, { type: 'CLEAR' });
      })();
    // The renderer painted the step as 「找不到」, or painted it and found its
    // target cannot be operated right now. Facts, not verdicts: whether to
    // wait, or point somewhere else, is the model's to judge, and it is told
    // as a reading (a fixed plan leaves its screen up, with 重试 and 跳过 on
    // it). Matched against the presentation on screen, so a report that
    // outlived its step is dropped.
    if (m.type === 'STEP_NOT_ACTIONABLE') {
      const { presentationId, why } = m as Extract<ContentEvent, { type: 'STEP_NOT_ACTIONABLE' }>;
      void stampEntry(from, presentationId, 'not_actionable');
      void readingArrived(from, { kind: 'not_actionable', why }, presentationId);
    }
    if (m.type === 'TARGET_NOT_FOUND') {
      const { presentationId } = m as Extract<ContentEvent, { type: 'TARGET_NOT_FOUND' }>;
      void (async () => {
        await stampEntry(from, presentationId, 'not_found');
        await readingArrived(from, { kind: 'not_found' }, presentationId);
      })();
    }
    return false;
  });

  // A whole page finished loading — the fourth observation source, and the
  // only one that still reaches the worker after a navigation: the navigation
  // took the content script that reports the other three with it.
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete') return;
    void (async () => {
      // The tab a click opened is handed to the user *before* it has a page,
      // so the switch below sees no url to judge and no page to read. This is
      // where that tab finishes arriving — and the reading right after is the
      // one the carried run continues on.
      if (tab.active) await carryGuideToTab(tabId, tab);
      await readingArrived(tabId, { kind: 'loaded', url: tab.url ?? '' });
    })();
  });

  // 人在哪,引导在哪 —— a click that opened a new tab, and the user went there.
  chrome.tabs.onActivated.addListener(({ tabId }) =>
    void (async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !(await carryGuideToTab(tabId, tab))) return;
      // Already loaded, so no `onUpdated` is coming to read it for us.
      if (tab.status === 'complete') await readingArrived(tabId, { kind: 'loaded', url: tab.url ?? '' });
    })(),
  );

  // The tab the guide lived in is gone. Same two halves as 「关掉浮层」 above —
  // and the overlay half of `settleEnding` is a no-op by construction here,
  // because the surface went with the tab.
  chrome.tabs.onRemoved.addListener((tabId) =>
    void (async () => {
      await endGuideForTab(tabId, 'tab_closed');
      await dropConversation(tabId);
    })(),
  );
});
