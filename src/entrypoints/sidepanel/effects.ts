import { complete } from '@/agent/provider/provider';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import { createTrace } from '@/agent/agents/guide/trace';
import type { Trace } from '@/shared/types';
import { createNonceCache } from '@/agent/context/nonce';

/** One per panel instance. Lives here rather than inside the run loop because
 *  consecutive calls on one page are separate effects, and a cache scoped to a
 *  single run would never get a second look at the same snapshot. */
const nonces = createNonceCache();
import { TRACE_ENABLED_KEY, isFlagOn } from '@/agent/flags';
import type { CallModelParams, EffectOutcome, EffectRequest, EffectResult, EffectUsage, FetchDocParams } from '@/agent/thread/effect';
import type {
  EffectAbortMessage,
  EffectClaimResponse,
  EffectRequestMessage,
  EffectResultMessage,
  GuideInflightResponse,
} from '@/shared/protocol';
import type { ProviderConfig } from '@/shared/settings';

/**
 * The panel's half of the effect protocol (design doc §2.6) — the executor for `EFFECT_
 * REQUEST`s the host broadcasts, plus the E-6 recovery pull on mount.
 *
 * Kept separate from `App.tsx` on purpose, the same way `view-model.ts` is: every
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
 * round-trip later. And the provenance scanner (CONTEXT.md `Provenance`) has to see what the
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
    ? {
        ok: false,
        error: r.failure.error,
        retryable: r.failure.retryable,
        failureKind: r.failure.kind,
        providerCalls: r.providerCalls,
        // A draw that came back and was refused still cost its tokens. Dropping
        // the figure here is what made a rejected envelope look free.
        ...(r.usage ? { usage: r.usage } : {}),
      }
    : {
        ok: true,
        value: r.raw,
        providerCalls: r.providerCalls,
        ...(r.tool ? { tool: r.tool } : {}),
        ...(r.callId ? { callId: r.callId } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      };
  // The trace comes back beside the result, never folded into it: the outcome
  // is what the host decides on, and nothing about a debugging artefact may
  // change it. `startEffectListener` decides whether it goes any further.
  return { result: { effectId: req.effectId, at: req.at, outcome }, trace: trace.snapshot() };
}

/* ═══════════ fetchDoc (slice 11) ═══════════ */

/**
 * No re-authorization: `params.url` arrived already approved by the host
 * (design doc §6.2/§8.3, "判定权在 SW，不在侧栏——侧栏只能请求，不能自己批
 * 准") — this function's only job is to fetch it and hand back what it says.
 * `credentials:'omit'` / `redirect:'manual'` are §8.3's own floor for an
 * anonymous grab.
 *
 * A redirect is not followed. The address it leads to was never judged, and a
 * `manual` fetch cannot even see where it points — so it comes back as a
 * reason, and the model decides what to do (usually: point the user at the
 * link instead). The length is cut on the host, which does not take the
 * panel's word for it (`tools/read-doc.ts`).
 *
 * What goes back is text: a web page through `htmlToText`, a text document
 * as it is. Anything else — a PDF, an image — is refused by its type rather
 * than handed to a model as bytes.
 *
 * `providerCalls: 0` on every branch, and it is not a formality: a document
 * fetch spends no model quota, and the host's accounting has to be able to
 * tell that apart from a model call whose count it does not know.
 */
export async function runFetchDocEffect(
  req: EffectRequest & { kind: 'fetchDoc' },
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
  toText: (html: string) => string = htmlToText,
): Promise<EffectResult> {
  const params = req.params as FetchDocParams;
  const failed = (error: string) => ({
    effectId: req.effectId,
    at: req.at,
    outcome: { ok: false as const, error, retryable: true, failureKind: 'transport' as const, providerCalls: 0 },
  });
  try {
    const res = await fetchFn(params.url, { credentials: 'omit', redirect: 'manual', signal });
    if (res.type === 'opaqueredirect') return failed('这条链接会跳到别的地址；跳过去的地址没有经过核对，所以没有跟着去抓');
    if (!res.ok) return failed(`文档抓取失败：HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const body = await res.text();
    const text = /html/.test(type) ? toText(body) : !type || /^text\/|json|markdown/.test(type) ? body : null;
    if (text === null) return failed(`这不是网页，也不是文字（${type}），读不了`);
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

/**
 * A fetched web page as the text a reader would read: scripts and styles out,
 * the page's own main content when it marks one, whitespace folded. Parsed by
 * the panel's own `DOMParser` — a document is never rendered, and nothing in
 * it runs.
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, style, noscript, template')) el.remove();
  const root = doc.querySelector('main, article, [role="main"]') ?? doc.body;
  return (root?.textContent ?? '').replace(/\s+/g, ' ').trim();
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
 * call sites architecture.spec.ts counts; the
 * other is the `EFFECT_CLAIM` round trip below.
 *
 * Every open panel answers every thread's request, whichever tab it is
 * showing. A panel follows the active tab and the host broadcasts a request
 * once, so an instance that only answered its own tab dropped every call made
 * while the guide's tab was in the background — a link that opens a new tab
 * is enough — and nothing ever sent that call again: the thread kept it in
 * flight until the user gave up. Which instance spends the money is the
 * `EFFECT_CLAIM` claim's job immediately below: the host grants exactly one
 * before anyone calls `complete()`/`fetch()`.
 */
/**
 * What one `callModel` effect actually spent, reported to whoever mounted the
 * listener.
 *
 * The guide path never reached the cost panel — `App.tsx` only records the QA
 * path's own two calls — so a user watching a guide burn money read 「调用 2」
 * from a completely unrelated question and had no way to see the guide at all.
 * That is not a display detail: the panel is the only place this product ever
 * says what it is spending.
 *
 * `usage` is already summed over the primary draw and its repair, because that
 * round happens inside `runGuideToEnd`; `providerCalls` says how many requests
 * that sum covers.
 */
export interface ModelSpend {
  providerCalls: number;
  usage?: EffectUsage;
}

export function startEffectListener(
  loadCfg: () => Promise<ProviderConfig>,
  onModelSpend?: (spend: ModelSpend) => void,
): () => void {
  const controllers = new Map<string, AbortController>();

  const onRequest = (msg: unknown) => {
    const m = msg as { type?: string } | undefined;
    if (m?.type !== 'EFFECT_REQUEST') return;
    const req = msg as EffectRequestMessage;

    void (async () => {
      // Arbitration, *before* anything that spends money. Every other open
      // `sidepanel.html` instance sees the identical broadcast
      // `EFFECT_REQUEST` and races this same claim; the host grants
      // exactly one (`claimEffect`, `agent/thread/effect.ts`). Losing here is
      // not a failure — it means the other instance already owns this call —
      // so this returns silently: no controller registered, no error, no
      // `EFFECT_RESULT`, nothing rendered.
      const claim = (await chrome.runtime
        .sendMessage({ type: 'EFFECT_CLAIM', threadId: req.threadId, effectId: req.effectId })
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
          // Reported whatever the outcome: a refused envelope was still paid
          // for, and a panel that only counts successes understates the bill
          // exactly when the user most wants to know.
          onModelSpend?.({
            providerCalls: result.outcome.providerCalls,
            ...(result.outcome.usage ? { usage: result.outcome.usage } : {}),
          });
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
  // this file's `RecoveryOutcome` doc comment on why both message
  // orders are safe.
  const onAbort = (msg: unknown) => {
    const m = msg as Partial<EffectAbortMessage> | undefined;
    if (m?.type === 'EFFECT_ABORT' && m.effectId) controllers.get(m.effectId)?.abort();
  };

  chrome.runtime.onMessage.addListener(onRequest);
  chrome.runtime.onMessage.addListener(onAbort);
  return () => {
    chrome.runtime.onMessage.removeListener(onRequest);
    chrome.runtime.onMessage.removeListener(onAbort);
  };
}
