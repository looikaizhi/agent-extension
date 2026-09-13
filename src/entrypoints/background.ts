import type { PageAccess, ThreadId, ThreadStore } from '@/agent/thread/ports';
import {
  applyGuideInput,
  applyGuidePageChanged,
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
import { claimEffect, judgeRecovery, type EffectRequest } from '@/agent/thread/effect';
import { budgetFor } from '@/agent/budget';
import { mergeTrace, traceKey } from '@/agent/agents/guide/trace';
import type { RecordStore } from '@/agent/thread/record-store';
import { samePlace } from '@/agent/thread/place';
import { replan, type ReplanPorts, type ReplanTrace, type ReplanTrigger } from '@/agent/thread/replan';
import type { ExternalEnding, ThreadState } from '@/agent/thread/thread';
import type { ExtractProfile, ProjectBudget, PromptTable } from '@/core/extractor/types';
import type {
  ContentEvent,
  EffectClaimResponse,
  EffectResultMessage,
  GuideInflightResponse,
  GuideClarify,
  GuideCrossSite,
  GuideState,
  GuideStep,
  HighlightMode,
  HostRequest,
  ResumeGuideResponse,
} from '@/shared/protocol';
import { sessionIdForTab, tabIdForSession } from '@/shared/protocol';
import { buildQaResponse, buildQaStep, checkPageIdentity } from '@/shared/qa-highlight';
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

function broadcast(msg: GuideState | GuideClarify | GuideCrossSite | ContentEvent): void {
  // Nothing may be listening (side panel closed); that is not an error.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * The effect protocol's Host → Panel half (design doc §2.6). Reuses the same broadcast
 * mechanism as `GUIDE_STATE`/`ContentEvent` above ("既有广播机制
 * 的复用", not a new transport) — every extension context gets it, and each
 * `sidepanel/effects.ts` instance decides for itself whether the `threadId`
 * is one it should answer (its own `tabIdRef` check).
 */
function broadcastEffectRequest(req: EffectRequest): void {
  chrome.runtime.sendMessage({ type: 'EFFECT_REQUEST', ...req }).catch(() => {});
}

/** E-5's other half: the host's storage side clears the tombstone when a run
 *  ends (`endGuide`); telling the panel to stop is chrome.*, so it lives here. */
function broadcastEffectAbort(effectId: string): void {
  chrome.runtime.sendMessage({ type: 'EFFECT_ABORT', effectId }).catch(() => {});
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
async function settleEnding(tabId: number, ending: GuideEnding): Promise<void> {
  if (!ending.ended) return;
  if (ending.cancelledEffectId) broadcastEffectAbort(ending.cancelledEffectId);
  // Harmless where the surface is already gone — the user closed the overlay
  // themselves, or it went with the tab: `sendToTab` answers
  // `no_content_script` rather than throwing.
  await sendToTab(tabId, { type: 'CLEAR' });
  if (ending.recordError)
    chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: ending.recordError }).catch(() => {});
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
  send: broadcastEffectRequest,
  now: () => Date.now(),
  newEffectId: () => crypto.randomUUID(),
};

/**
 * Closes a gap first recorded as "已知的、未在
 * 本文件解决": two `sidepanel.html` instances bound to the same tab both
 * receive the same broadcast `EFFECT_REQUEST` and, without this, both would
 * really call `complete()`/`fetch()` — one model call, charged twice. See
 * `claimEffect` (`agent/thread/effect.ts`) for the arbitration judgement
 * itself; this `Set` is the one piece of state that has to live on the host
 * (the only process every instance can reach), so it lives here rather than
 * in `agent/` (N-1: no `chrome.*` there, and this `Set` exists only because
 * `chrome.runtime.onMessage` fans out to more than one listener).
 *
 * Deliberately module-level, in-memory, and never written to
 * `chrome.storage`. The arbitration only has to be atomic for the instant a
 * broadcast fans out and every panel instance's `onMessage` handler reacts
 * to it — and JS's single-threaded event loop already guarantees that with
 * no lock required. A service worker eviction resets this `Set` to empty,
 * and that is harmless, not a bug to fix by persisting it: E-1 guarantees
 * at most one `inflight` effect per thread at a time, so whatever a freshly
 * booted worker sees is always a *first* claim for whatever is inflight
 * right now — never a second claim for an id some now-vanished `Set` already
 * granted. Losing the record of who already claimed an *already-resolved*
 * effect costs nothing either, since nothing asks about it again.
 */
const claimedEffectIds = new Set<string>();



/**
 * One extraction, retried while a heavy page is still settling.
 *
 * `ensureInjected` answering means the content script is alive, not that the
 * document it lives in is ready — on a freshly-navigated github.com the first
 * `EXTRACT` can still fail. Three attempts over ~1.2s, then the error is the
 * caller's to report; nothing here decides that a failed read means some other
 * path should answer instead.
 */
async function extractWhileSettling(page: PageAccess, budget: ProjectBudget): Promise<PromptTable> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.extract('interactive', budget);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last;
}

/**
 * `replan.ts`'s ports, bound to this worker's real world.
 *
 * Everything the decision needs lives behind this object, which is why the
 * decision itself is testable in node. What stayed here is only what genuinely
 * requires `chrome.*`.
 */
function replanPorts(tabId: number, threadId: ThreadId): ReplanPorts {
  return {
    ensureReady: () => ensureInjected(tabId),
    extract: async () => {
      const budget = budgetFor((await loadConfig()).contextWindow);
      const ex = await sendToTab(tabId, { type: 'EXTRACT', profile: 'interactive', budget });
      return ex.ok ? ex.data : null;
    },
    // Both answers from one `chrome.tabs.get`: asking twice per attempt would
    // let them disagree about the same instant.
    verdict: async (table) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.url) return { samePage: true, inTransit: false }; // cannot tell — do not block
      return { samePage: samePlace(tab.url, table.url), inTransit: tab.status === 'loading' };
    },
    commit: async (table) => {
      const outcome = await applyGuidePageChanged(guideEffectDeps, threadId, table, guideEffectDeps.newEffectId());
      if (!outcome) return null;
      await renderGuideOutcome(tabId, threadId, outcome);
      // Effects are the only honest evidence that the call did something.
      return { spent: outcome.effects.length > 0 };
    },
    reportSettleTimeout: async () => {
      const settled = await applyGuideInput(guideEffectDeps, threadId, {
        kind: 'step_settle_timeout',
        // A dead control now buys one fresh look at the page, so this input
        // can dispatch a `callModel` and needs an id to carry it.
        effectId: guideEffectDeps.newEffectId(),
      });
      await renderGuideOutcome(tabId, threadId, settled);
    },
    redraw: async () => void (await redrawGuide(tabId)),
    record: async (trace) => {
      const key = `replan:${threadId}`;
      const previous = ((await chrome.storage.session.get(key))[key] ?? []) as ReplanTrace[];
      // Appended, never replaced: each trigger owes its own account, and the
      // question worth answering at a stuck breakpoint is what *all* of them
      // decided, not just whichever finished last. Twelve back, because one
      // user action can wake four triggers.
      const kept = [...(Array.isArray(previous) ? previous : []), trace].slice(-12);
      await chrome.storage.session.set({ [key]: kept }).catch(() => {});
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/**
 * §5.3's re-planning, as one function every trigger shares: re-extract the page
 * as it is *now*, and let `applyGuidePageChanged` decide whether that is
 * actually a different page (`pageMoved`) before spending a model call.
 *
 * Three triggers reach it, and the guide needs all three — this is the
 * breakpoint machinery for a journey that crosses pages:
 *
 *  - **A completed navigation** (`chrome.tabs.onUpdated`). The one that carries
 *    a multi-page flow forward, and the one that was never wired: the content
 *    script only starts `watchPageStructure` when a `HIGHLIGHT` arrives, and a
 *    navigation tears that script down and re-injects a fresh one with no
 *    command and no watcher. So `PAGE_STRUCTURE_CHANGED` cannot fire after a
 *    real navigation — the single event §5.3 was counting on is the single
 *    event that page never sends.
 *  - **`STEP_CONFIRMED`** — D4's "点击 + 页面确实变了". The click is the
 *    trigger, `pageMoved` is the judgement. Covers the in-page half a
 *    navigation never produces: a menu or dialog opening.
 *  - **`PAGE_STRUCTURE_CHANGED`** — the content script noticing a structural
 *    change with no navigation and no click behind it.
 *
 * Re-extraction happens here rather than in the event: the event carries a
 * hash at most, never a table ("元素表变了，就重新抽取并重新调用一次").
 */
const replanGuide = (tabId: number, threadId: ThreadId, settle: readonly number[], trigger: ReplanTrigger) =>
  replan(threadId, replanPorts(tabId, threadId), settle, trigger);


/** One look, right now — for triggers that already fired *after* the change
 *  they describe: a completed navigation, and the content script's own
 *  debounced structure watcher. */
const SETTLED = [0];

/**
 * Several looks, spread over ~1.4s — for triggers that fire *before* the page
 * has finished becoming whatever they are evidence of.
 *
 * Two reach it. **`STEP_CONFIRMED`**, dispatched synchronously from the click
 * handler, so the host's first extraction races the very thing it is looking
 * for. Measured on github.com: clicking the highlighted `Code` button emitted
 * `STEP_CONFIRMED` and `pageMoved` was `true` a few hundred milliseconds
 * later, but the extraction taken at click time saw the page before the
 * dropdown existed. And **`TARGET_LOST`**, which reports the *start* of a
 * re-render rather than the end of one.
 *
 * Re-looking is free — extraction is local, and only a table that really moved
 * reaches `applyGuidePageChanged`'s model call. The loop stops at the first
 * attempt that finds movement, so a page that responds instantly costs exactly
 * one extraction.
 *
 * These three windows were briefly collapsed into one while a settle
 * judgement — "has the page stopped changing" — decided when to stop looking.
 * That was reverted and the judgement deleted: 56 of 70 live re-plans never
 * settled and burned the whole 4.4s window, journeys fell from 4.1 hops to
 * 2.1, and the harness timed out 13 times, even though cost fell (1.39 → 0.86
 * calls per hop). Both causes were in the criterion, not the idea: github.com's
 * search dropdown re-renders its suggestions, so consecutive control lists are
 * never identical; and a destination prediction that outranks quiescence polls
 * a page that is not the destination until the deadline. A second attempt has
 * to make the wait cheap where it cannot help — check the prediction only after
 * a real navigation, compare something coarser than the full control list,
 * and stop giving same-page changes a 4.4s budget.
 */
const UNSETTLED = [0, 300, 500, 600];

/** A navigation reports `complete` before the incoming document has
 *  necessarily taken over answering `EXTRACT`, so this needs room to re-look
 *  as well — the `verdict` port's `samePage` check turns a stale answer into a
 *  retry rather than into a wrong plan. */
const AFTER_NAV = [0, 400, 800, 1200, 2000];


/**
 * The one place that turns `applyGuideInput`'s raw `MachineEffect[]` into real
 * `HIGHLIGHT` commands and panel broadcasts.
 *
 * `present`: builds a `HighlightCommand` and dispatches it, then translates the
 * real `HighlightAck` into a `Binding` (`bindingFromAck`), feeds it back into
 * the reducer as `bind_result`, and broadcasts the three axes alongside `route`
 * (`GuideState`'s optional fields). The recursive
 * call at the end only ever sees a `notify` or nothing in practice —
 * `handleBindResult` (machine.ts) never itself produces a `present` — but
 * written against the general "process whatever effects came back" shape
 * rather than assuming that today, so a later change to `handleBindResult`
 * cannot silently start dropping effects here.
 *
 * `notify`: reuses `AGENT_ANSWER`, which `App.tsx` already renders as a status
 * message — no new wire type needed for "tell the user something went wrong".
 *
 * `callModel`/`fetchDoc` need nothing here: `applyGuideInput` already
 * dispatched them (`deps.send`, E-1) before this function ever sees the
 * outcome.
 */
async function renderGuideOutcome(tabId: number, threadId: ThreadId, outcome: GuideReduction): Promise<void> {
  const state = outcome.state;
  if (!state) return; // E-2 discard, or effect_result for a thread that no longer exists

  for (const effect of outcome.effects) {
    if (effect.kind === 'present') {
      const res = await paintStep(tabId, threadId, state, effect);

      const binding = res.ok ? bindingFromAck(res.data) : 'unbound';
      broadcast({
        type: 'GUIDE_STATE',
        tabId,
        sessionId: threadId,
        index: effect.index,
        total: effect.total,
        route: state.route,
        evidence: state.evidence,
        check: state.check,
        binding,
        ...(effect.step.detail !== undefined ? { why: effect.step.detail } : {}),
        walked: state.history,
        calls: state.callCount,
        ...(res.ok && res.data.failure ? { failure: res.data.failure } : {}),
        ...(res.ok && res.data.candidates ? { candidates: res.data.candidates.length } : {}),
      });

      // CL-2's escalation / the "未能定位" fallback (machine.ts's `handleBindResult`,
      // 03) both live behind this one input kind — feed the renderer's real
      // verdict back in rather than letting it go unreported, the same gap
      // this whole file's doc comment on `bindingFromAck` names.
      const followUp = await applyGuideInput(guideEffectDeps, threadId, { kind: 'bind_result', binding });
      await renderGuideOutcome(tabId, threadId, followUp);
    } else if (effect.kind === 'clarify') {
      broadcast({
        type: 'GUIDE_CLARIFY',
        tabId,
        sessionId: threadId,
        question: effect.question,
        options: effect.options,
      });

      // Outline every candidate at once, exactly as the QA path already does
      // for its own `clarify` (`buildQaStep` puts several candidates in
      // `alsoRefs` rather than setting `ref`, so nothing here picks one for
      // the user — K-6). An empty `options` is a real answer, not a
      // degenerate one: "I need more from you and the page offers no
      // candidates" — `buildQaStep` returns `null` and only the question is
      // shown.
      const items = effect.options
        .map((o) => state.table.items.find((i) => i.ref === o.ref))
        .filter((i): i is NonNullable<typeof i> => i !== undefined);
      const qaStep = buildQaStep(items, '需要你先选一个');
      if (qaStep) {
        await sendToTab(tabId, {
          type: 'HIGHLIGHT',
          command: {
            sessionId: threadId,
            snapshotId: state.table.snapshotId,
            mode: 'explain',
            step: qaStep,
            progress: { index: 0, total: 1 },
            autoScroll: true,
            skippable: false,
          },
        });
      }
    } else if (effect.kind === 'requestCrossSiteConfirm') {
      // P-2. Broadcast only — nothing is painted, because the whole point is
      // that the user decides before the step reaches the screen. The step is
      // already loaded behind this card, so answering costs no model call
      // either way.
      broadcast({
        type: 'GUIDE_CROSS_SITE',
        tabId,
        sessionId: threadId,
        from: effect.from,
        to: effect.to,
      });
    } else if (effect.kind === 'done') {
      // The guide is over. The model's `done` (`guide/output/done.ts`) and the
      // repeat backstop (`guide/output/guide.ts`) both end the thread and empty
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
      chrome.runtime
        .sendMessage({
          type: 'AGENT_ANSWER',
          text:
            effect.ending === 'model_done'
              ? `看起来已经到了：${effect.why}\n\n引导到这里结束。如果这不是你要找的，再说一次目标就行。`
              : effect.ending === 'steps_walked'
                ? `${effect.why}，引导到这里结束。`
                : `引导在原地打转，已经停下：${effect.why}`,
        })
        .catch(() => {});
    } else if (effect.kind === 'notify') {
      chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: effect.message }).catch(() => {});
    }
  }

  // Whatever ended the run — arrival, either quota, a
  // credential page after a cross-site hop, the loop backstop, or a fixed plan
  // running out — the run is
  // over and the same three things are owed: the highlight comes down, the
  // effect that was still in flight is abandoned, and a summary that could not
  // be saved is admitted rather than swallowed.
  if (outcome.ending) await settleEnding(tabId, outcome.ending);
}

/**
 * Content events mean something only while a guide owns the tab. Asked here,
 * once, so a tab with nothing running never pays for an extraction.
 */
async function ifGuiding(tabId: number, then: (threadId: ThreadId) => Promise<void>): Promise<void> {
  const threadId = sessionIdForTab(tabId);
  if (await guideThreadExists(threadStore, threadId)) await then(threadId);
}

/**
 * Paints the step the guide is on without moving it — for the two moments the
 * screen lost it while the run did not: a question's highlight took the overlay
 * over (`PANEL_RESUME_GUIDE`), or a reload took the content script with it
 * (`replan`'s `redraw`). Reads the thread through its one named read, never a
 * storage key typed inline, and writes nothing.
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
      snapshotId: state.table.snapshotId,
      mode: effect.mode,
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
  if (!(await ensureInjected(tabId))) return false;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? '';
  const threadId = sessionIdForTab(tabId);

  // A new guide gets a fresh debug trace. Threads are keyed by tab and so is
  // the trace, so without this a second guide in the same tab appends to the
  // first one's record — and since the trace keeps only its last 24 entries,
  // the new guide's opening calls get evicted by the old guide's. Cleared
  // here rather than in `dropGuideThread`: a guide that just ended badly is
  // precisely when someone wants to read its trace, so ending one must not
  // destroy it.
  await chrome.storage.session.remove(traceKey(threadId)).catch(() => {});

  const page = {
    async extract(profile: ExtractProfile, budget: ProjectBudget): Promise<PromptTable> {
      const ex = await sendToTab(tabId, { type: 'EXTRACT', profile, budget });
      if (!ex.ok) throw new Error(ex.message);
      return ex.data;
    },
  };

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
    chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: MODEL_NOT_CONFIGURED }).catch(() => {});
    return false;
  }

  let table: PromptTable;
  try {
    table = await extractWhileSettling(page, budgetFor(cfg.contextWindow));
  } catch (e) {
    // Reading the page failed, and saying so is the honest outcome: a guide
    // started against a page it could not read has nothing to compare the
    // next page with.
    chrome.runtime
      .sendMessage({ type: 'AGENT_ANSWER', text: `读不到这个页面的内容：${e instanceof Error ? e.message : String(e)}` })
      .catch(() => {});
    return false;
  }

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
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.error('[page-guide] setPanelBehavior', e));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg as (HostRequest | ContentEvent | EffectResultMessage) & { type?: string };
    if (!m?.type) return false;

    if (m.type === 'START_GUIDE') {
      const r = m as Extract<HostRequest, { type: 'START_GUIDE' }>;
      startGuide(r.tabId, r).then((ok) => sendResponse({ ok }));
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
        await sweepExpiredGuideEffect(guideEffectDeps, threadId);
        const outcome = await applyGuideInput(guideEffectDeps, threadId, {
          kind: 'effect_result',
          effectId: r.effectId,
          at: r.at,
          outcome: r.outcome,
        });
        // `EFFECT_RESULT` arrives from the panel, which has no `sender.tab` —
        // `threadId` is the wire's only address, so it is decoded back into a
        // tab id here (`tabIdForSession`, the inverse of `sessionIdForTab`).
        await renderGuideOutcome(tabIdForSession(threadId), threadId, outcome);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // E-6: the panel's one-time pull on mount. Also runs the E-4 sweep first,
    // so "过期" is something this answers honestly rather than something a
    // later message has to notice.
    if (m.type === 'PANEL_GUIDE_INFLIGHT') {
      const { tabId } = m as Extract<HostRequest, { type: 'PANEL_GUIDE_INFLIGHT' }>;
      void (async () => {
        const threadId = sessionIdForTab(tabId);
        await sweepExpiredGuideEffect(guideEffectDeps, threadId);
        const effect = await peekGuideEffect(threadStore, threadId);
        const res: GuideInflightResponse = { recovery: judgeRecovery(effect, Date.now()), effect };
        sendResponse(res);
      })();
      return true;
    }

    // Same-tab multi-instance arbitration (see `claimedEffectIds`'s doc comment above and `claimEffect` in
    // `agent/thread/effect.ts`). Synchronous: the check-and-add already happened
    // by the time `sendResponse` is called, so there is no `void (async () =>
    // ...)` wrapper here the way the other branches below have — nothing to await.
    if (m.type === 'EFFECT_CLAIM') {
      const { effectId } = m as Extract<HostRequest, { type: 'EFFECT_CLAIM' }>;
      const res: EffectClaimResponse = { granted: claimEffect(claimedEffectIds, effectId) };
      sendResponse(res);
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

    // A question's highlight (CONTEXT.md `Question`). The only thread access
    // anywhere in this handler is the read-only ownership query — a question
    // never builds, resumes or aborts a Thread.
    if (m.type === 'PANEL_SHOW_QA_RESULT') {
      const req = m as Extract<HostRequest, { type: 'PANEL_SHOW_QA_RESULT' }>;
      void (async () => {
        if (!(await ensureInjected(req.tabId)))
          return sendResponse({
            ok: false,
            code: 'no_content_script',
            message: '本页面不允许扩展运行（或尚未授权该站点）',
          });

        // The one check only the host can make: `chrome.tabs` does not exist in
        // a content script. This catches a whole-page navigation; the narrower
        // "same URL, page re-rendered" case is `render()`'s `mode: 'explain'`
        // branch in content.ts — this function cannot see that far.
        const tab = await chrome.tabs.get(req.tabId).catch(() => null);
        const identity = checkPageIdentity(req.url, tab?.url ?? '');
        if (!identity.ok) return sendResponse(buildQaResponse(identity, false, null));

        // Only read once the page identity is confirmed: a rejected request
        // never reaches the response shape that carries this field anyway.
        const guideActive = await guideThreadExists(threadStore, sessionIdForTab(req.tabId));
        const step = buildQaStep(req.items, req.title, req.detail);
        if (!step) return sendResponse(buildQaResponse(identity, guideActive, null));

        const res = await sendToTab(req.tabId, {
          type: 'HIGHLIGHT',
          command: {
            sessionId: sessionIdForTab(req.tabId),
            snapshotId: req.snapshotId,
            mode: 'explain',
            step,
            progress: { index: 0, total: 1 },
            autoScroll: true,
            skippable: false,
          },
        });
        if (!res.ok) return sendResponse(res);
        sendResponse(buildQaResponse(identity, guideActive, res.data));
      })();
      return true;
    }

    // Redraws the tab's parked guide step without advancing its cursor — the
    // panel calls this once a QA highlight closes, to hand the screen back.
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

    // The user used the step's own target. A fixed plan records that — it is
    // the only thing allowed to move one — and both kinds look at where the
    // page went.
    //
    // The re-plan is claimed *before* the use is recorded. A navigating click
    // also wakes the navigation trigger, and whichever claims the queue first
    // runs first: recording the use first let the navigation claim ahead, and
    // this re-plan then spent its whole window looking at a page that had
    // already arrived — while a reload's redraw waited behind it (measured: 2
    // of 3 e2e runs). The use still lands before this re-plan can commit
    // anything, because both go through the same per-thread write queue, and
    // it is enqueued first.
    if (m.type === 'STEP_CONFIRMED')
      void ifGuiding(from, async (id) => {
        const looking = replanGuide(from, id, UNSETTLED, 'step-confirmed');
        // `sender.url` is the page the click happened on — already a different
        // one by now if the click navigated, which is exactly what it records.
        await applyGuideInput(guideEffectDeps, id, { kind: 'step_used', at: sender.url ?? '' });
        await looking;
      });
    // A fixed plan moves to its next step; a model-driven guide stays where it
    // is (`handleStepSkipped` says why).
    if (m.type === 'STEP_SKIPPED')
      void ifGuiding(from, async (id) =>
        renderGuideOutcome(from, id, await applyGuideInput(guideEffectDeps, id, { kind: 'step_skipped' })),
      );
    // Closing the overlay ends the run, and for a model-driven one that means
    // money: the call still in flight is abandoned rather than paid for and
    // thrown away. This used to clean up the old host only, so a model-driven run left its
    // thread, its `effect:` mirror and its unwritten summary behind — and the
    // leftover thread then owned this tab's ownership query forever.
    if (m.type === 'SESSION_ENDED' && (m as { reason?: string }).reason === 'user_closed')
      void endGuideForTab(from, 'overlay_closed');
    // The tracker only gives up once the target has really gone, which means
    // the page moved out from under the step — `pageMoved` still gets the last
    // word on whether it did. A model-driven guide re-plans; a fixed plan has
    // the same step painted again, which rebinds it from its descriptor (how an
    // SPA re-render is survived).
    if (m.type === 'TARGET_LOST') void ifGuiding(from, (id) => replanGuide(from, id, UNSETTLED, 'target-lost'));
    // The renderer recovered on its own; only the panel's view needs correcting,
    // so this deliberately does *not* re-present (that would re-extract for
    // nothing).
    if (m.type === 'TARGET_FOUND') {
      void (async () => {
        const t = await peekGuideThread(threadStore, sessionIdForTab(from));
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
    // §5.3's re-planning trigger, host side. The content script already did
    // its own cheap check (`pageStructureChanged` against its own last-
    // reported hash) before ever sending this — this handler re-extracts a
    // fresh table (the event itself carries only a hash, never a table: "元素
    // 表变了，就重新抽取并重新调用一次") and lets `applyGuidePageChanged` run
    // the host's own, independent comparison against `ThreadState.table.
    // pageHash` before spending anything. A silent no-op whenever no guide
    // owns this tab right now (`applyGuidePageChanged` returns `null`).
    if (m.type === 'PAGE_STRUCTURE_CHANGED') {
      const { sessionId } = m as Extract<ContentEvent, { type: 'PAGE_STRUCTURE_CHANGED' }>;
      void replanGuide(from, sessionId, SETTLED, 'structure-changed');
    }
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    void (async () => {
      const id = sessionIdForTab(tabId);
      // The cross-page breakpoint. A guided flow is supposed to survive
      // navigation and keep guiding on the page the user just landed on
      // (§5.3); this listener is the only event that still reaches the worker
      // after a navigation, because the navigation destroyed the content
      // script that would otherwise have reported it.
      if (await guideThreadExists(threadStore, id)) await replanGuide(tabId, id, AFTER_NAV, 'navigation');
    })();
  });

  // The tab the guide lived in is gone. Same two halves as 「关掉浮层」 above —
  // and the overlay half of `settleEnding` is a no-op by construction here,
  // because the surface went with the tab.
  chrome.tabs.onRemoved.addListener((tabId) => void endGuideForTab(tabId, 'tab_closed'));
});
