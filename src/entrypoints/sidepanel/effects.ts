import { complete, ProviderError } from '@/agent/provider';
import { GUIDE_ENVELOPE_SHAPE_GUIDE, buildGuidePrompt, buildRepairPrompt } from '@/agent/plan/prompt';
import { parseContract } from '@/agent/plan/contract';
import { validateEnvelope } from '@/agent/plan/validate';
import type { CallModelParams, EffectRequest, EffectResult, EffectUsage, FetchDocParams } from '@/agent/host/effect';
import { sessionIdForTab } from '@/shared/protocol';
import type {
  EffectClaimResponse,
  EffectRequestMessage,
  EffectResultMessage,
  GuideInflightResponse,
} from '@/shared/protocol';
import type { ProviderConfig } from '@/shared/settings';
import { describeProviderError } from './qa';

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

const isRetryable = (err: unknown): boolean => (err instanceof ProviderError ? err.retryable : true);

/* ═══════════ callModel (slice 9/10) ═══════════ */

/**
 * `buildGuidePrompt` → `complete()` → `parseContract` → `validateEnvelope` —
 * 01/02's pipeline, reused verbatim rather than rebuilt (design doc Seam).
 *
 * `parseContract`/`validateEnvelope` here are a *gate*, not a transform:
 * `value` on success is still the raw model text, never the parsed
 * `Envelope` object. `machine.ts`'s own `handleEffectResult` (03) re-parses
 * `outcome.value` itself and is the authoritative check (design doc §8.3:
 * "判定权在 Host") — re-running the check on this side first only means a
 * hallucinated ref or broken JSON gets a readable `error` immediately
 * instead of the host silently rediscovering the identical failure one
 * round-trip later. Handing the host anything other than the *original* raw
 * text would also break ADR 0005: `parseContract`'s provenance scanner has
 * to run against what the model actually said, not against a re-serialized
 * reconstruction of it.
 */
export async function runCallModelEffect(
  req: EffectRequest & { kind: 'callModel' },
  cfg: ProviderConfig,
  signal: AbortSignal,
  completeFn: typeof complete = complete,
): Promise<EffectResult> {
  const params = req.params as CallModelParams;
  let raw = '';
  let usage: EffectUsage | undefined;

  try {
    for await (const d of completeFn(cfg, buildGuidePrompt(params.goal, params.table, params.history), signal)) {
      raw += d.content;
      if (d.usage) usage = { prompt: d.usage.prompt, completion: d.usage.completion, total: d.usage.total };
    }
  } catch (err) {
    return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: describeProviderError(err), retryable: isRetryable(err) } };
  }

  let parsed = parseContract(raw);
  if (parsed.kind === 'error') {
    // One repair round, the same one S1's QA path has always taken (`App.tsx`:
    // primary output fails to parse → `buildRepairPrompt` → parse again).
    // S2 never had it, so a single missing field in one model response killed
    // the whole guide at hop 0 — `retryable: true` was recorded on the way out
    // and nobody read it. Measured live: 1–2 of every 15 github.com journeys
    // died this way, before taking a single step.
    //
    // Exactly one retry, never a loop: a model that cannot produce the shape
    // twice will not produce it on the third try either, and the guide's whole
    // cost ceiling is built on a bounded number of requests per effect.
    const repairMessages = buildRepairPrompt(raw, GUIDE_ENVELOPE_SHAPE_GUIDE);
    let repaired = '';
    try {
      for await (const d of completeFn(cfg, repairMessages, signal)) {
        repaired += d.content;
        // Both requests' cost is reported, because both were really spent.
        if (d.usage)
          usage = {
            prompt: (usage?.prompt ?? 0) + d.usage.prompt,
            completion: (usage?.completion ?? 0) + d.usage.completion,
            total: (usage?.total ?? 0) + d.usage.total,
          };
      }
    } catch (err) {
      return {
        effectId: req.effectId,
        at: req.at,
        outcome: { ok: false, error: describeProviderError(err), retryable: isRetryable(err) },
      };
    }
    const reparsed = parseContract(repaired);
    if (reparsed.kind === 'error') {
      return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: reparsed.message, retryable: true } };
    }
    parsed = reparsed;
    raw = repaired;
  }
  const validated = validateEnvelope(parsed.envelope, params.table);
  if (validated.kind === 'violation') {
    return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: validated.reason, retryable: true } };
  }

  return { effectId: req.effectId, at: req.at, outcome: { ok: true, value: raw, ...(usage ? { usage } : {}) } };
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
      return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: `文档抓取失败：HTTP ${res.status}`, retryable: true } };
    }
    const text = await res.text();
    return { effectId: req.effectId, at: req.at, outcome: { ok: true, value: text } };
  } catch (err) {
    if (signal.aborted) return { effectId: req.effectId, at: req.at, outcome: { ok: false, error: '已取消', retryable: false } };
    return {
      effectId: req.effectId,
      at: req.at,
      outcome: { ok: false, error: `文档抓取失败：${String((err as Error)?.message ?? err)}`, retryable: true },
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
        const result =
          req.kind === 'callModel'
            ? await runCallModelEffect(req as EffectRequest & { kind: 'callModel' }, cfg, controller.signal)
            : await runFetchDocEffect(req as EffectRequest & { kind: 'fetchDoc' }, controller.signal);
        const out: EffectResultMessage = { type: 'EFFECT_RESULT', threadId: req.threadId, ...result };
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
