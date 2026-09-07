import { complete } from '@/agent/provider';
import { runGuideToEnd } from '@/agent/guide/runner';
import { createTrace, type Trace } from '@/agent/guide/trace';
import { createNonceCache } from '@/agent/guide/nonce';

/** One per panel instance. Lives here rather than inside the run loop because
 *  consecutive calls on one page are separate effects, and a cache scoped to a
 *  single run would never get a second look at the same snapshot. */
const nonces = createNonceCache();
import { TRACE_ENABLED_KEY, isFlagOn } from '@/agent/guide/flags';
import type { CallModelParams, EffectOutcome, EffectRequest, EffectResult, FetchDocParams } from '@/agent/host/effect';
import { sessionIdForTab } from '@/shared/protocol';
import type {
  EffectClaimResponse,
  EffectRequestMessage,
  EffectResultMessage,
  GuideInflightResponse,
} from '@/shared/protocol';
import type { ProviderConfig } from '@/shared/settings';

/**
 * The panel's half of 04-effect-protocol.md — the executor for `EFFECT_
 * REQUEST`s the host broadcasts, plus the E-6 recovery pull on mount.
 *
 * Kept separate from `App.tsx` on purpose, the same way `qa.ts` is: every
 * judgement here is ordinary data-in/data-out logic, so it takes its
 * `complete`/`fetch` dependency as a parameter (defaulting to the real one)
 * and can be driven in a plain node test with a canned async generator or a
 * canned `Response`, instead of needing a real network call or `chrome.*`.
 * `App.tsx` only ever calls `startEffectListener` — the one function here
 * that actually touches `chrome.*` — and mounts it once.
 */

/* ═══════════ callModel (slice 9/10) ═══════════ */

/**
 * Transport, and nothing else: hand the run to `guide/runner.ts`, put what
 * comes back on the wire. The pipeline it used to spell out inline
 * (`buildMessages` → `complete()` → `parseOutput` → repair → `validate`)
 * reads in one place now, and that place is not tied to the side panel.
 *
 * What stays true across the move: `value` on success is the model's raw
 * text, never a re-serialized `Envelope`. `machine.ts`'s `handleEffectResult`
 * re-parses it and is the authoritative check (design doc §8.3, "判定权在
 * Host"); running the same check here first only means a hallucinated ref
 * gets a readable error immediately instead of the host rediscovering it a
 * round-trip later. And ADR 0005's provenance scanner has to see what the
 * model actually said, so re-serializing here would break it outright.
 *
 * What is new: `providerCalls` and `failureKind` cross with the outcome. The
 * repair round happens inside the runner, so without the first the host can
 * only guess how much of its quota an effect spent; and the host cannot
 * re-derive the second at all, because on a failure it never receives the
 * text to judge.
 */
export async function runCallModelEffect(
  req: EffectRequest & { kind: 'callModel' },
  cfg: ProviderConfig,
  signal: AbortSignal,
  completeFn: typeof complete = complete,
): Promise<{ result: EffectResult; trace: Trace | null }> {
  const trace = createTrace();
  const r = await runGuideToEnd(req.params as CallModelParams, cfg, signal, completeFn, trace.record, nonces);

  const outcome: EffectOutcome = r.failure
    ? { ok: false, error: r.failure.error, retryable: r.failure.retryable, failureKind: r.failure.kind, providerCalls: r.providerCalls }
    : { ok: true, value: r.raw, providerCalls: r.providerCalls, ...(r.tool ? { tool: r.tool } : {}), ...(r.usage ? { usage: r.usage } : {}) };
  // The trace comes back beside the result, never folded into it: the outcome
  // is what the host decides on, and nothing about a debugging artefact may
  // change it. `startEffectListener` decides whether it goes any further.
  return { result: { effectId: req.effectId, at: req.at, outcome }, trace: trace.snapshot() };
}

/* ═══════════ fetchDoc (slice 11) ═══════════ */

/**
 * No re-authorization: `params.url` arrived already approved by the host
 * (design doc §6.2/§8.3, "判定权在 SW，不在侧栏——侧栏只能请求，不能自己批
 * 准") — this function's only job is to fetch it. `credentials:'omit'` /
 * `redirect:'manual'` are §8.3's own floor for an anonymous, non-redirect-
 * following grab; the full redirect-reauthorization loop (V-8) and the
 * response-size cap (V-9) are 06's job, once something upstream of this file
 * actually produces a resolved `url` to drive them (see `agent/api.ts`'s
 * `toEffectRequest` doc comment — 03's `fetchDoc` effect has no `url` yet).
 *
 * `providerCalls: 0` on every branch, and it is not a formality: a document
 * fetch spends no model quota, and the host's accounting has to be able to
 * tell that apart from a model call whose count it does not know.
 */
export async function runFetchDocEffect(
  req: EffectRequest & { kind: 'fetchDoc' },
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<EffectResult> {
  const params = req.params as FetchDocParams;
  try {
    const res = await fetchFn(params.url, { credentials: 'omit', redirect: 'manual', signal });
    if (!res.ok) {
      return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: `文档抓取失败：HTTP ${res.status}`, retryable: true, failureKind: 'transport', providerCalls: 0 } };
    }
    const text = await res.text();
    return { effectId: req.effectId, at: req.at, outcome: { ok: true, value: text, providerCalls: 0 } };
  } catch (err) {
    if (signal.aborted) return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: '已取消', retryable: false, failureKind: 'transport', providerCalls: 0 } };
    return {
      effectId: req.effectId,
      at: req.at,
      outcome: { ok: false, error: `文档抓取失败：${String((err as Error)?.message ?? err)}`, retryable: true, failureKind: 'transport', providerCalls: 0 },
    };
  }
}

/* ═══════════ E-6: recovery on mount (slice 12/13) ═══════════ */

export interface RecoveryOutcome {
  recovery: GuideInflightResponse['recovery'];
  effect: EffectRequest | null;
}

/**
 * Called once, on mount, before this file's message listener is even
 * attached. `ask` only ever *reads* what the host already knows
 * (`PANEL_GUIDE_INFLIGHT`) — this function has no parameter through which it
 * could reach `complete`/`fetch`, which is the structural half of "不自动重
 * 发"; a test asserting a `fetch`/`complete` spy saw zero calls across this
 * call is the behavioural half.
 */
export async function recoverInflightOnMount(
  tabId: number,
  ask: (tabId: number) => Promise<GuideInflightResponse>,
): Promise<RecoveryOutcome> {
  const res = await ask(tabId);
  return { recovery: res.recovery, effect: res.effect };
}

/* ═══════════ real wiring ═══════════ */

/**
 * The one function in this file that touches `chrome.*`. Listens for
 * `EFFECT_REQUEST`, executes it (`runCallModelEffect`/`runFetchDocEffect`),
 * and replies with exactly one `EFFECT_RESULT` — one of the two `sendMessage`
 * call sites this file's completion criteria grep for (04-effect-protocol.md,
 * amended); the other is the `EFFECT_CLAIM` round trip below.
 *
 * `getTabId` rules out *other* tabs' panels: an instance only ever considers
 * a request addressed to the tab it is currently tracking (`App.tsx`'s own
 * `tabIdRef` pattern), dropping anything else silently. It cannot tell two
 * instances of *this same tab's* panel apart — the gap 04-effect-protocol.md's
 * Gotchas recorded as accepted — so the `EFFECT_CLAIM` claim immediately
 * below is what actually closes it: the host arbitrates before either
 * instance is allowed to spend money on `complete()`/`fetch()`.
 */
export function startEffectListener(getTabId: () => number | null, loadCfg: () => Promise<ProviderConfig>): () => void {
  const controllers = new Map<string, AbortController>();

  const onRequest = (msg: unknown) => {
    const m = msg as { type?: string } | undefined;
    if (m?.type !== 'EFFECT_REQUEST') return;
    const req = msg as EffectRequestMessage;

    const tabId = getTabId();
    if (tabId === null || req.threadId !== sessionIdForTab(tabId)) return; // not this instance's tab to answer

    void (async () => {
      // Same-tab arbitration, *before* anything that spends money. A second
      // `sidepanel.html` instance bound to this same tab sees the identical
      // broadcast `EFFECT_REQUEST` and races this same claim; the host grants
      // exactly one (`claimEffect`, `agent/host/effect.ts`). Losing here is
      // not a failure — it means the other instance already owns this call —
      // so this returns silently: no controller registered, no error, no
      // `EFFECT_RESULT`, nothing rendered.
      const claim = (await chrome.runtime
        .sendMessage({ type: 'EFFECT_CLAIM', effectId: req.effectId })
        .catch(() => ({ granted: false }))) as EffectClaimResponse | undefined;
      if (!claim?.granted) return;

      const controller = new AbortController();
      controllers.set(req.effectId, controller);
      try {
        const cfg = await loadCfg();
        let trace: Trace | null = null;
        let result: EffectResult;
        if (req.kind === 'callModel') {
          const ran = await runCallModelEffect(req as EffectRequest & { kind: 'callModel' }, cfg, controller.signal, complete);
          result = ran.result;
          // Asked after the run, and asked of `storage.local` — `storage.session`
          // belongs to the worker (N-6). A disabled trace therefore costs one
          // local read and puts nothing on the wire; only the worker ever
          // writes the thing itself.
          if (ran.trace && (await isFlagOn(chrome.storage.local, TRACE_ENABLED_KEY))) trace = ran.trace;
        } else {
          result = await runFetchDocEffect(req as EffectRequest & { kind: 'fetchDoc' }, controller.signal);
        }
        const out: EffectResultMessage = { type: 'EFFECT_RESULT', threadId: req.threadId, ...result, ...(trace ? { trace } : {}) };
        chrome.runtime.sendMessage(out).catch(() => {});
      } finally {
        controllers.delete(req.effectId);
      }
    })();
  };

  // E-5: harmless when the effectId is not (or no longer) tracked here — see
  // this file's `RecoveryOutcome` doc comment and 04-effect-protocol.md's
  // Gotchas on why both message orders are safe.
  const onAbort = (msg: unknown) => {
    const m = msg as { type?: string; effectId?: string } | undefined;
    if (m?.type === 'EFFECT_ABORT' && m.effectId) controllers.get(m.effectId)?.abort();
  };

  chrome.runtime.onMessage.addListener(onRequest);
  chrome.runtime.onMessage.addListener(onAbort);
  return () => {
    chrome.runtime.onMessage.removeListener(onRequest);
    chrome.runtime.onMessage.removeListener(onAbort);
  };
}
