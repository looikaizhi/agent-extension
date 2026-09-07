import {
  createAgentHost,
  type AgentEvent,
  type HostSignal,
} from '@/agent/api';
import type { PageAccess, ThreadId, ThreadStore } from '@/agent/host/ports';
import {
  applyGuideInput,
  applyGuidePageChanged,
  guideThreadExists,
  cancelGuideEffect,
  dropGuideThread,
  peekGuideThread,
  peekGuideEffect,
  sweepExpiredGuideEffect,
  type GuideEffectDeps,
  type GuideStepOutcome,
} from '@/agent/host/guide';
import { bindingFromAck } from '@/agent/host/binding';
import { claimEffect, judgeRecovery, type EffectRequest } from '@/agent/host/effect';
import { budgetFor } from '@/agent/budget';
import { mergeTrace, traceKey } from '@/agent/guide/trace';
import { buildRunRecord, writeRunRecord, type RecordStore } from '@/agent/host/record';
import { replan, type ReplanPorts, type ReplanTrace } from '@/agent/host/replan';
import { matchFlow } from '@/core/packs/match';
import { chooseGuidePath } from '@/agent/host/route-choice';
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
import { modelIsConfigured } from '@/agent/provider';
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
 * `StepOneHost` still owns the `thread:` key convention and the checkpoint
 * shape, this just relays `get`/`set`/`remove` to the real storage.
 */
const threadStore: ThreadStore = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
  remove: (key) => chrome.storage.session.remove(key),
};

const agentHost = createAgentHost(threadStore);

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
 * 04-effect-protocol.md's Host → Panel half. Reuses the same broadcast
 * mechanism as `GUIDE_STATE`/`ContentEvent` above (the Seam's "既有广播机制
 * 的复用", not a new transport) — every extension context gets it, and each
 * `sidepanel/effects.ts` instance decides for itself whether the `threadId`
 * is one it should answer (its own `tabIdRef` check).
 */
function broadcastEffectRequest(req: EffectRequest): void {
  chrome.runtime.sendMessage({ type: 'EFFECT_REQUEST', ...req }).catch(() => {});
}

/** E-5's other half: `cancelGuideEffect` (agent/api.ts) only clears storage —
 *  broadcasting is chrome.*, so it stays here. */
function broadcastEffectAbort(effectId: string): void {
  chrome.runtime.sendMessage({ type: 'EFFECT_ABORT', effectId }).catch(() => {});
}

/**
 * The one `GuideEffectDeps` this worker ever constructs — `agent/api.ts`'s
 * `applyGuideInput`/`sweepExpiredGuideEffect` take it as a parameter rather
 * than reaching for `chrome.*` themselves (N-1), so this is where the real
 * store, the real broadcast and the real clock get plugged in.
 */
const guideEffectDeps: GuideEffectDeps = {
  store: threadStore,
  send: broadcastEffectRequest,
  now: () => Date.now(),
  newEffectId: () => crypto.randomUUID(),
};

/**
 * Closes the gap 04-effect-protocol.md's Gotchas recorded as "已知的、未在
 * 本文件解决": two `sidepanel.html` instances bound to the same tab both
 * receive the same broadcast `EFFECT_REQUEST` and, without this, both would
 * really call `complete()`/`fetch()` — one model call, charged twice. See
 * `claimEffect` (`agent/host/effect.ts`) for the arbitration judgement
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
/**
 * Sends one content event to whichever host owns this tab: S2's guided flow if
 * a `ThreadState` exists for it, S1's `StepOneHost` otherwise. The two never
 * both own a tab — `guide:{id}` and `thread:{id}` are written by different
 * paths and `startGuide` picks exactly one of them per session.
 */
async function onOwner(
  tabId: number,
  s1Signal: HostSignal,
  s2: (tabId: number, threadId: ThreadId) => Promise<void>,
): Promise<void> {
  const threadId = sessionIdForTab(tabId);
  if (await guideThreadExists(threadStore, threadId)) return s2(tabId, threadId);
  await signalToHost(tabId, s1Signal);
}

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
      const key = (u: string) => {
        try {
          const parsed = new URL(u);
          return `${parsed.origin}${parsed.pathname}`;
        } catch {
          return u;
        }
      };
      return { samePage: key(tab.url) === key(table.url), inTransit: tab.status === 'loading' };
    },
    commit: async (table) => {
      const outcome = await applyGuidePageChanged(guideEffectDeps, threadId, table, guideEffectDeps.newEffectId());
      if (!outcome) return null;
      await renderGuideOutcome(tabId, threadId, outcome);
      // Effects are the only honest evidence that the call did something.
      return { spent: outcome.effects.length > 0 };
    },
    reportSettleTimeout: async () => {
      const settled = await applyGuideInput(guideEffectDeps, threadId, { kind: 'step_settle_timeout' });
      await renderGuideOutcome(tabId, threadId, settled);
    },
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

const replanGuide = (tabId: number, threadId: ThreadId, settle: readonly number[] = SETTLED, trigger = 'unknown') =>
  replan(threadId, replanPorts(tabId, threadId), settle, trigger);

/**
 * `chrome.storage.local` as `record.ts`'s `RecordStore`.
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
 * These three windows were briefly collapsed into one while 09's settle
 * judgement decided when to stop looking. That was reverted: 80% of live
 * re-plans never settled and burned the whole window, and journeys went from
 * 4.1 hops to 2.1. See `docs/plans/s2-guided-flow/09-transition-settled.md`.
 */
const UNSETTLED = [0, 300, 500, 600];

/** A navigation reports `complete` before the incoming document has
 *  necessarily taken over answering `EXTRACT`, so this needs room to re-look
 *  as well — the `tabVerdict` guard turns a stale answer into a
 *  retry rather than into a wrong plan. */
const AFTER_NAV = [0, 400, 800, 1200, 2000];


/**
 * The S2 counterpart to `drive()` above — the one place that turns
 * `applyGuideInput`'s raw `MachineEffect[]` into real `HIGHLIGHT` commands and
 * panel broadcasts (05-route-and-steps.md's Seam). `drive()` cannot be reused
 * as-is: it consumes `AgentEvent`s from `StepOneHost`'s self-contained
 * generator, while `applyGuideInput` hands back a flat effect list from a
 * single `step` call — the two are different shapes for a reason explained in
 * `agent/api.ts`'s own doc comment on why the S2 path could not be bolted
 * onto that generator.
 *
 * `present`: builds a `HighlightCommand` and dispatches it, exactly like
 * `drive()`'s `show` case — then does the one thing S1 never had to
 * (translate the real `HighlightAck` into a `Binding`, `bindingFromAck`, and
 * feed it back into the reducer as `bind_result`) and broadcasts the three
 * axes alongside `route` (`GuideState`'s new optional fields). The recursive
 * call at the end only ever sees a `notify` or nothing in practice —
 * `handleBindResult` (machine.ts) never itself produces a `present` — but
 * written against the general "process whatever effects came back" shape
 * rather than assuming that today, so a later change to `handleBindResult`
 * cannot silently start dropping effects here.
 *
 * `notify`: reuses `AGENT_ANSWER`, the exact broadcast `drive()`'s `answer`
 * case already sends and `App.tsx` already renders as a status message — no
 * new wire type needed for "tell the user something went wrong".
 *
 * `callModel`/`fetchDoc` need nothing here: `applyGuideInput` already
 * dispatched them (`deps.send`, E-1) before this function ever sees the
 * outcome.
 */
async function renderGuideOutcome(tabId: number, threadId: ThreadId, outcome: GuideStepOutcome): Promise<void> {
  const state = outcome.state;
  if (!state) return; // E-2 discard, or effect_result for a thread that no longer exists

  for (const effect of outcome.effects) {
    if (effect.kind === 'present') {
      const res = await sendToTab(tabId, {
        type: 'HIGHLIGHT',
        command: {
          sessionId: threadId,
          snapshotId: state.table.snapshotId,
          mode: effect.mode,
          step: effect.step,
          progress: { index: effect.index, total: effect.total },
          autoScroll: true,
        },
      });

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
      // A proposal, not a verdict (machine.ts's `done` effect): the thread
      // stays `active` and nothing is marked complete here. Reuses
      // `AGENT_ANSWER`, which the panel already renders as a status line — the
      // user decides whether that is really the end.
      //
      // The overlay deliberately stays up. This used to send `CLEAR` right
      // after the broadcast, which tore down the only surface carrying the
      // current step and its buttons — the proposal was delivered by
      // destroying the thing it is a proposal about, and a user who disagreed
      // had nothing left to disagree with. Worse, `status` stays `active`, so
      // the guide kept planning against a screen it had just wiped: across 15
      // live github.com journeys the hop after a `done` read back an overlay
      // with nothing in it and the run stopped there.
      chrome.runtime
        .sendMessage({
          type: 'AGENT_ANSWER',
          text:
            effect.source === 'model'
              ? `看起来已经到了：${effect.why}`
              : `引导在原地打转，已经停下：${effect.why}`,
        })
        .catch(() => {});
    } else if (effect.kind === 'notify') {
      chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: effect.message }).catch(() => {});
    }
    // 'callModel' / 'fetchDoc': already dispatched inside `applyGuideInput` (E-1).
  }
}

async function startGuide(tabId: number, req: { goal?: string; steps?: readonly GuideStep[] }) {
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

  // "引导我" means a guided flow, so it goes to the thing that can produce one
  // (ADR 0011). A guide pack still wins outright — free, authoritative,
  // human-authored — and is checked first, exactly as `agentHost.start`'s own
  // Path 1 already does internally. Everything past that is the model's.
  //
  // The local lexical baseline used to sit in between, and only a
  // `rankCandidates` verdict of `none` let a goal through to the model. On
  // github.com that verdict never happens: four live goals, in two languages,
  // all got intercepted (unique hit once, "N 个控件都符合，说得更具体一些"
  // three times). The scorer has a substring floor, and a page with hundreds
  // of controls always brushes against it — so the model path was reachable
  // only on small synthetic tables, which is exactly what every e2e fixture
  // is. That is why a whole stage's worth of defects survived 139 green e2e
  // runs.
  //
  // Deliberately *not* folded into `agentHost.start`'s own generator: that
  // generator resolves entirely within this one `await` chain, while this path
  // must delegate the model call to the panel and continue later from a
  // completely different message — see `agent/api.ts`'s doc comment on why
  // that could never be a plain `await` inside a generator.
  const cfg = await loadConfig();
  // ADR 0011's rule, stated on its own in `host/route-choice.ts` so it can be
  // checked without standing up a tab.
  const path = chooseGuidePath({
    ...(req.goal !== undefined ? { goal: req.goal } : {}),
    url,
    hasPack: matchFlow(url, req.goal ?? '') !== null,
    hasSteps: Boolean(req.steps?.length),
    configured: modelIsConfigured(cfg),
  });
  if (path === 'model') {
    const goal = req.goal!;
    let modelTable: PromptTable;
    try {
      modelTable = await extractWhileSettling(page, budgetFor(cfg.contextWindow));
    } catch (e) {
      // Reading the page failed. This used to fall through to
      // `agentHost.start`, which re-extracts and usually succeeds a moment
      // later — so a transient failure came out the other side looking like a
      // routing decision: the same goal on the same page produced a model
      // guide or a single S1 highlight depending on how warm the tab was.
      // Observed live on github.com, where the first goal after a `goto` was
      // answered by S1 and the second, on the identical page, by the model.
      // Saying so is the honest outcome; silently answering a different
      // question is not.
      chrome.runtime
        .sendMessage({ type: 'AGENT_ANSWER', text: `读不到这个页面的内容：${e instanceof Error ? e.message : String(e)}` })
        .catch(() => {});
      return false;
    }
    const outcome = await applyGuideInput(guideEffectDeps, threadId, {
      kind: 'start',
      goal,
      table: modelTable,
      effectId: guideEffectDeps.newEffectId(),
    });
    await renderGuideOutcome(tabId, threadId, outcome);
    return true;
  }

  await drive(
    tabId,
    agentHost.start(
      {
        threadId,
        url,
        page,
        ...(req.goal !== undefined ? { goal: req.goal } : {}),
        ...(req.steps ? { steps: req.steps } : {}),
      },
      never,
    ),
  );
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
        await agentHost.abort(sessionIdForTab(tabId));
        // E-5: also cancel whatever S2 guided-flow effect this tab's thread
        // has in flight, if any — a no-op (returns `null`) whenever S1's
        // `StepOneHost` path is what's actually running, since that path
        // never writes an `inflight` tombstone in the first place.
        const cancelledEffectId = await cancelGuideEffect(threadStore, sessionIdForTab(tabId));
        if (cancelledEffectId) broadcastEffectAbort(cancelledEffectId);
        // 07 Seam 10: the run's summary is written *before* the thread goes.
        // Deleting the thread is mandatory (a finished thread left behind
        // makes `guideThreadExists` answer yes forever, and every later flow
        // in this tab gets routed to a run that already ended) — so this is
        // the last moment the run still exists to be recorded, and the record
        // is S3's only source for distilling site knowledge.
        const ending = await peekGuideThread(threadStore, sessionIdForTab(tabId));
        if (ending) {
          const written = await writeRunRecord(
            recordStore,
            buildRunRecord(`${sessionIdForTab(tabId)}-${Date.now()}`, ending, Date.now()),
          );
          if (!written.ok) chrome.runtime.sendMessage({ type: 'AGENT_ANSWER', text: written.error }).catch(() => {});
        }
        // Then drop the thread itself — cancelling the effect is not ending the
        // guide (see `dropGuideThread`'s doc comment on why leaving the record
        // behind poisons ownership routing for every later flow in this tab).
        await dropGuideThread(threadStore, sessionIdForTab(tabId));
        await sendToTab(tabId, { type: 'CLEAR' });
        broadcast({ type: 'SESSION_ENDED', sessionId: sessionIdForTab(tabId), reason: 'aborted' });
        sendResponse({ ok: true });
      })();
      return true;
    }

    // 04-effect-protocol.md: the panel's answer to a dispatched
    // `EFFECT_REQUEST`. E-4's passive timeout sweep runs first — if the
    // host's own clock already declared this effect expired, a late-arriving
    // genuine result is exactly the "duplicate/stale delivery" E-2 exists to
    // discard, not a second, conflicting truth to reconcile.
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
          // The wire `EffectResult.outcome.value` is `unknown` (effect.ts);
          // `MachineInput`'s own `EffectOutcome.value` is `string` — `step`
          // (machine.ts) feeds it straight to `parseContract`, which only
          // accepts one. `sidepanel/effects.ts` only ever sends a string on
          // success (see its `runCallModelEffect` doc comment on why `value`
          // stays raw text, never the parsed `Envelope`); `JSON.stringify`
          // below is a defensive fallback for anything else, not the
          // expected path.
          outcome: r.outcome.ok
            ? {
                ok: true,
                value: typeof r.outcome.value === 'string' ? r.outcome.value : JSON.stringify(r.outcome.value),
                providerCalls: r.outcome.providerCalls,
                ...(r.outcome.tool ? { tool: r.outcome.tool } : {}),
                ...(r.outcome.usage ? { usage: r.outcome.usage } : {}),
              }
            : r.outcome,
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

    // Same-tab multi-instance arbitration (collateral to 04-effect-protocol.md's
    // Gotchas — see `claimedEffectIds`'s doc comment above and `claimEffect` in
    // `agent/host/effect.ts`). Synchronous: the check-and-add already happened
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

    // A question's highlight (task 6, ADR 0004 & 0006). The only `agentHost`
    // call anywhere in this handler is the read-only `exists()` — a question
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
        // branch in content.ts (ADR 0006) — this function cannot see that far.
        const tab = await chrome.tabs.get(req.tabId).catch(() => null);
        const identity = checkPageIdentity(req.url, tab?.url ?? '');
        if (!identity.ok) return sendResponse(buildQaResponse(identity, false, null));

        // Only read once the page identity is confirmed: a rejected request
        // never reaches the response shape that carries this field anyway.
        const guideActive = await agentHost.exists(sessionIdForTab(req.tabId));
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
          },
        });
        if (!res.ok) return sendResponse(res);
        sendResponse(buildQaResponse(identity, guideActive, res.data));
      })();
      return true;
    }

    // Redraws the tab's parked guide step without advancing its cursor — the
    // panel calls this once a QA highlight closes, to hand the screen back.
    // Reads `storage.session` directly, the same way `currentUrlOf` and the
    // `TARGET_FOUND` handler below do, rather than going through `agentHost`:
    // there is no write here for any `agentHost` method to do.
    if (m.type === 'PANEL_RESUME_GUIDE') {
      const { tabId } = m as Extract<HostRequest, { type: 'PANEL_RESUME_GUIDE' }>;
      void (async () => {
        if (!(await ensureInjected(tabId)))
          return sendResponse({
            ok: false,
            code: 'no_content_script',
            message: '本页面不允许扩展运行（或尚未授权该站点）',
          });

        const k = `thread:${sessionIdForTab(tabId)}`;
        const t = (await chrome.storage.session.get(k))[k] as
          | { steps: GuideStep[]; cursor: number; snapshotId: string }
          | undefined;
        const step = t?.steps[t.cursor];
        if (!t || !step) {
          const resp: ResumeGuideResponse = {
            ok: false,
            code: 'no_active_guide',
            message: '没有正在进行的引导可以恢复。',
          };
          return sendResponse(resp);
        }

        // Same derivation `resume()` uses in `agent/api.ts` — a single-step
        // thread (the lexical baseline / a bare `locate`) reads as `locate`,
        // everything longer reads as `guide`. Duplicated rather than exported
        // from `agent/api.ts` because it is one ternary, and importing it would
        // mean reaching into `agent/` for a value this file can already derive
        // from data it just read itself.
        const mode: HighlightMode = t.steps.length > 1 ? 'guide' : 'locate';
        sendResponse(
          await sendToTab(tabId, {
            type: 'HIGHLIGHT',
            command: {
              sessionId: sessionIdForTab(tabId),
              snapshotId: t.snapshotId,
              mode,
              step,
              progress: { index: t.cursor, total: t.steps.length },
              autoScroll: true,
            },
          }),
        );
      })();
      return true;
    }

    // Content events carry no tabId of their own — it comes from `sender`.
    const from = sender.tab?.id;
    if (from === undefined) return false;

    // Routed by owner (`guideThreadExists`) — see its doc comment in
    // `agent/api.ts` for what happened when every one of these went to S1
    // unconditionally.
    if (m.type === 'STEP_CONFIRMED')
      void onOwner(from, { kind: 'confirmed' }, (t, id) => replanGuide(t, id, UNSETTLED, 'step-confirmed'));
    // `skipped` has no S2 meaning yet: re-planning would hand back the very
    // step the user just declined, and `machine.ts` has no "don't offer this
    // again" to record it against. Reaching S1's `resume()` would end the S2
    // thread outright, so the honest S2 behaviour is to leave the guide
    // standing and let the user end it or ask again.
    if (m.type === 'STEP_SKIPPED') void onOwner(from, { kind: 'skipped' }, async () => {});
    if (m.type === 'SESSION_ENDED' && (m as { reason?: string }).reason === 'user_closed')
      void agentHost.abort(sessionIdForTab(from));
    // The tracker only gives up once the target has really gone; re-presenting
    // the same step rebinds it from the descriptor, which is how an SPA
    // re-render is survived.
    // S1 re-presents (rebinding from the descriptor is how an SPA re-render is
    // survived). S2 re-plans instead: its steps are bound to one specific
    // table, so a target that is really gone means the page moved out from
    // under the plan — `pageMoved` still gets the last word on whether it did.
    if (m.type === 'TARGET_LOST') void onOwner(from, { kind: 'reloaded' }, (t, id) => replanGuide(t, id, UNSETTLED, 'target-lost'));
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
    // §5.3's re-planning trigger, host side. The content script already did
    // its own cheap check (`pageStructureChanged` against its own last-
    // reported hash) before ever sending this — this handler re-extracts a
    // fresh table (the event itself carries only a hash, never a table: "元素
    // 表变了，就重新抽取并重新调用一次") and lets `applyGuidePageChanged` run
    // the host's own, independent comparison against `ThreadState.table.
    // pageHash` before spending anything. A silent no-op whenever no S2
    // `ThreadState` owns this tab right now (`applyGuidePageChanged` returns
    // `null`) — this event fires for *every* active guide session, S1's
    // pack/baseline/inspector-driven ones included, and those have no
    // `ThreadState` to replan.
    if (m.type === 'PAGE_STRUCTURE_CHANGED') {
      const { sessionId } = m as Extract<ContentEvent, { type: 'PAGE_STRUCTURE_CHANGED' }>;
      void replanGuide(from, sessionId, SETTLED, 'structure-changed');
    }
    return false;
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete') return;
    void (async () => {
      const id = sessionIdForTab(tabId);
      // The cross-page breakpoint. A guided flow is supposed to survive
      // navigation and keep guiding on the page the user just landed on
      // (§5.3); this listener is the only event that still reaches the worker
      // after a navigation, because the navigation destroyed the content
      // script that would otherwise have reported it.
      if (await guideThreadExists(threadStore, id)) return replanGuide(tabId, id, AFTER_NAV, 'navigation');
      if (!(await agentHost.exists(id))) return;
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
