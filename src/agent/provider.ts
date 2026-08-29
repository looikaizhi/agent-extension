import type { ProviderConfig } from '@/shared/settings';

/**
 * The only file in the extension allowed to touch the network, and the whole of
 * the provider layer for now: P-03, connection testing.
 *
 * It exists before the agent on purpose. §1.5 gates phase one on "安装 → 完成 Key
 * 配置 ≥ 35%", and a form that accepts a key without ever checking it converts
 * a wrong key into a failure ten minutes later, in the middle of a guide, where
 * it looks like the product is broken. Verification at save time is the
 * cheapest thing that protects that funnel.
 *
 * `architecture.spec.ts` asserts that no other source file makes a request, so
 * "the key only ever goes to the endpoint the user configured" is checkable
 * rather than promised.
 */
export interface TestResult {
  ok: boolean;
  /** Shown to the user verbatim, so it has to say what to do next. */
  message: string;
  /** Models the endpoint reports, when it offers a listing. */
  models?: string[];
}

const TIMEOUT_MS = 15_000;

/* ═══════════ P-04: generation streaming ═══════════ */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Real once the endpoint reports it; character-count based otherwise (`estimated: true`). */
export interface Usage {
  prompt: number;
  completion: number;
  total: number;
  estimated: boolean;
}

export interface Delta {
  /** May be empty — a usage-only chunk carries no new text. */
  content: string;
  /** Present only on the last `Delta` of a stream. */
  usage?: Usage;
}

/**
 * `retryable` is the caller's routing signal: network hiccups, 429s and 5xx
 * are worth a retry; a rejected key or a malformed contract are not — retrying
 * either just spends the same money on the same failure. `complete()` itself
 * never retries (that decision belongs to the caller, per the seam contract).
 */
export type ProviderErrorKind =
  | 'network'
  | 'http'
  | 'auth'
  | 'contract'
  | 'size-limit'
  | 'timeout-connect'
  | 'timeout-stall'
  | 'timeout-total';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Parses one already-unwrapped SSE line into a `Delta`, or `null` if the line carries nothing usable. */
function parseDataLine(payload: string): Delta | null {
  const parsed = JSON.parse(payload) as {
    choices?: Array<{ delta?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    // Gotcha: HTTP 200 is not proof of success — some endpoints report a
    // model-side failure as a normal SSE data line instead of a non-2xx
    // status. Left unhandled, this reads as "the model said nothing" and
    // burns a repair call on an answer that was never coming.
    error?: { message?: string; type?: string; code?: string | number };
  };
  if (parsed.error) {
    const detail = parsed.error.message ?? parsed.error.type ?? JSON.stringify(parsed.error);
    throw new ProviderError(`模型端点返回错误：${detail}`, 'contract', false);
  }
  const content = parsed.choices?.[0]?.delta?.content ?? '';
  const rawUsage = parsed.usage;
  if (!content && !rawUsage) return null;

  const delta: Delta = { content };
  if (rawUsage) {
    const prompt = rawUsage.prompt_tokens ?? 0;
    const completion = rawUsage.completion_tokens ?? 0;
    // Gotcha: `total_tokens` is sometimes missing even when the other two are
    // present. Writing 0 there would read as "0 tokens total" in the UI —
    // indistinguishable from a real zero-cost call — so fall back to the sum.
    delta.usage = { prompt, completion, total: rawUsage.total_tokens ?? prompt + completion, estimated: false };
  }
  return delta;
}

/**
 * A real page-QA answer (explanation text + the JSON envelope's ref list) is
 * well under 10 KB even on a busy page. 2 MB gives ~200x headroom above that
 * — enough that no legitimate answer ever trips it — while still bounding the
 * worst case: a runaway generation loop or a misbehaving proxy that echoes
 * garbage indefinitely would otherwise buffer without limit.
 */
export const MAX_RESPONSE_BYTES = 2_000_000;

// Rough industry-standard heuristic (~4 chars/token for English; imprecise for
// CJK, but this only ever feeds a cost *estimate* the UI labels as such —
// never billing. `Math.ceil` so a lone leftover character still counts.
const CHARS_PER_TOKEN = 4;
const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Three independent clocks, all present in real deployments:
 *
 *  - **connect** — time to first byte. Mirrors `testConnection`'s own
 *    15s budget: if a plain `/models` GET deserves 15s, a POST that has to
 *    reach the same network path before the model even starts deserves the
 *    same patience, not more, not less.
 *  - **stall** — time between two `Delta`s once generation has started.
 *    Doubled from connect: slow local presets (Ollama/LM Studio on modest
 *    hardware, per the preset notes in `settings.ts`) can go quiet between
 *    tokens far longer than a healthy connection ever should before its
 *    first byte, and a false trip here throws away a real, if slow, answer.
 *  - **total** — the whole call, start to finish. 2 minutes is generous for
 *    a page-QA explanation (short prose plus a small ref list) while still
 *    guaranteeing the panel is never stuck on one question indefinitely.
 */
export const CONNECT_TIMEOUT_MS = 15_000;
export const STALL_TIMEOUT_MS = 30_000;
export const TOTAL_TIMEOUT_MS = 120_000;

/** Sentinels: which deadline elapsed before `op` did. Never `reject()`, see `raceDeadlines` below. */
const LIVENESS_TIMED_OUT = Symbol('liveness-timed-out');
const TOTAL_TIMED_OUT = Symbol('total-timed-out');

/**
 * Races `op` against two fresh, single-use deadlines simultaneously and
 * reports which of the three actually won.
 *
 * The deadline sides *resolve* with a sentinel rather than rejecting. A
 * `setTimeout` callback that calls `reject()` on a promise is the textbook
 * shape Node's unhandled-rejection tracking is built to catch — and under
 * `vi.useFakeTimers()` specifically, that combination reliably produces a
 * `PromiseRejectionHandledWarning` even though `Promise.race` legitimately
 * attaches its handler synchronously (confirmed against this file's own test
 * suite: switching the deadline side from reject to resolve made the warning
 * disappear with no other change). A `throw` from ordinary control flow,
 * immediately awaited by a caller already suspended on it, does not have
 * that problem — so `guarded()` below throws only from synchronous code
 * after this races, never from inside a timer callback.
 */
async function raceDeadlines<T>(
  op: Promise<T>,
  livenessMs: number,
  totalMs: number,
): Promise<T | typeof LIVENESS_TIMED_OUT | typeof TOTAL_TIMED_OUT> {
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const liveness = new Promise<typeof LIVENESS_TIMED_OUT>((resolve) => {
    livenessTimer = setTimeout(() => resolve(LIVENESS_TIMED_OUT), Math.max(0, livenessMs));
  });
  const total = new Promise<typeof TOTAL_TIMED_OUT>((resolve) => {
    totalTimer = setTimeout(() => resolve(TOTAL_TIMED_OUT), Math.max(0, totalMs));
  });
  try {
    return await Promise.race([op, liveness, total]);
  } finally {
    clearTimeout(livenessTimer);
    clearTimeout(totalTimer);
    // If a deadline won, `op` is still pending and will settle on its own
    // later (e.g. a real fetch eventually rejecting with its own AbortError
    // once `internal.abort()` reaches it) — make sure that eventual
    // settlement can never surface as a separate unhandled rejection.
    void op.catch(() => {});
  }
}

/**
 * `http://localhost*` / `http://127.0.0.1*` are the only endpoints that don't
 * need a key. Exact hostname match, not a substring check on the whole URL:
 * matching on substring treats `https://my-localhost-proxy.example.com/v1` as
 * local and waives the key requirement for a real public endpoint that merely
 * has "localhost" somewhere in its name. Shared between `testConnection`'s
 * save-time check and `complete()`'s every-call guard below — one rule, one
 * implementation, so the two can never drift apart again.
 */
function isLocalEndpoint(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Whether a model call is even possible — the same condition `complete()`
 * refuses on below, exported so a *router* can ask it before committing a
 * request to a path that can only end in that refusal.
 *
 * ADR 0011 sends every non-pack goal to the model. That is the right routing
 * when there is a model; with none configured it would turn "点保存" from a
 * free, instant, correct local answer into an error message. The zero-cost
 * paths are what this extension does before anyone has typed a key at all, so
 * the router falls back to them here rather than the product going dark.
 */
export const modelIsConfigured = (cfg: ProviderConfig): boolean =>
  Boolean(cfg.apiKey) || isLocalEndpoint(cfg.baseURL);

export async function* complete(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncIterable<Delta> {
  if (signal.aborted) return;

  const base = cfg.baseURL.replace(/\/+$/, '');

  // Same rule `testConnection` enforces at save time (settings.ts: "the key
  // only ever goes to the endpoint the user configured") — but that check
  // alone does not stop an *unconfigured* panel from calling this function at
  // all. `messages` carries the page's element table (`buildPrompt`), which
  // is exactly the kind of thing BYOK promises never leaves the machine
  // toward a destination the user never chose. `DEFAULT_CONFIG.baseURL`
  // prefills a real public endpoint (settings.ts), so "no key yet" must be
  // caught here, before the first `fetch`, not discovered as a 401 after the
  // request (and the page content) already went out.
  if (!cfg.apiKey && !isLocalEndpoint(base)) {
    throw new ProviderError(
      '还没有配置模型：请先在下方「模型配置（BYOK）」里填写端点和 API Key，并点「测试连接并保存」。',
      'auth',
      false,
    );
  }

  // A separate controller, not the caller's `signal` directly: a timeout has
  // to be able to cancel the in-flight request too, and the caller's signal
  // is never ours to abort from the inside.
  const internal = new AbortController();
  const onCallerAbort = () => internal.abort();
  signal.addEventListener('abort', onCallerAbort);

  const startedAt = Date.now();
  // "connect" until the first byte arrives, then "stall" — one deadline, one
  // meaning at a time. `remainingTotal()` is recomputed every iteration so a
  // single long-lived timer is never left racing calls it no longer guards.
  let livenessDeadline = startedAt + CONNECT_TIMEOUT_MS;
  const remainingTotal = () => Math.max(0, startedAt + TOTAL_TIMEOUT_MS - Date.now());

  /** Races `op` against both the current liveness deadline and the total budget, at once. */
  const guarded = async <T>(op: Promise<T>, firstByteSeen: boolean): Promise<T> => {
    const result = await raceDeadlines(op, livenessDeadline - Date.now(), remainingTotal());
    if (result === LIVENESS_TIMED_OUT) {
      throw firstByteSeen
        ? new ProviderError(`连接停滞：${STALL_TIMEOUT_MS}ms 内没有新内容`, 'timeout-stall', true)
        : new ProviderError(`连接超时：${CONNECT_TIMEOUT_MS}ms 内未收到首字节`, 'timeout-connect', true);
    }
    if (result === TOTAL_TIMED_OUT) {
      throw new ProviderError(`调用总耗时超过 ${TOTAL_TIMEOUT_MS}ms`, 'timeout-total', true);
    }
    return result;
  };

  try {
    const res = await guarded(
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: internal.signal,
      }),
      false,
    );

    // Gotcha, HTTP layer: a non-2xx status here is the same silent-failure
    // risk as the in-stream `error` object slice above — the body will not
    // be SSE-shaped (no `data:` prefix), so every line the parser sees would
    // just be dropped, and the call would quietly look like "the model said
    // nothing" instead of surfacing the real rejection.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`Key 被拒绝（HTTP ${res.status}）。${detail}`, 'auth', false);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError(`端点暂时不可用（HTTP ${res.status}）。${detail}`, 'network', true);
      }
      throw new ProviderError(`端点返回 HTTP ${res.status}。${detail}`, 'contract', false);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Once the endpoint has said [DONE], anything still arriving on the socket
    // (some proxies keep it open and echo stray bytes) is not part of the
    // answer — stop parsing, not just stop caring about the result.
    let streamDone = false;
    let completionChars = 0;
    let sawRealUsage = false;
    let totalBytes = 0;
    let firstByteSeen = false;

    const consumeLine = function* (line: string): Generator<Delta> {
      if (streamDone || !line.startsWith('data:')) return;
      const payload = line.slice(5).trimStart();
      if (payload === '[DONE]') {
        streamDone = true;
        return;
      }
      const delta = parseDataLine(payload);
      if (!delta) return;
      completionChars += delta.content.length;
      if (delta.usage) sawRealUsage = true;
      yield delta;
    };

    while (true) {
      // Checked on both sides of the await: the caller can abort while we are
      // parked in `reader.read()`, not just between two already-yielded Deltas.
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { value, done } = await guarded(reader.read(), firstByteSeen);
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      if (!firstByteSeen) {
        firstByteSeen = true;
        livenessDeadline = Date.now() + STALL_TIMEOUT_MS;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ProviderError(`响应超过大小上限（${MAX_RESPONSE_BYTES} 字节）`, 'size-limit', false);
      }
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        for (const delta of consumeLine(line)) {
          livenessDeadline = Date.now() + STALL_TIMEOUT_MS; // a Delta is evidence of life — push the deadline back out
          yield delta;
        }
      }
    }
    // The socket can close without a trailing newline — the last line is only
    // visible once `read()` reports done, so flush whatever is left in `buffer`.
    if (buffer) yield* consumeLine(buffer);

    // "usage on the last Delta" is a hard promise (§ usage 在最后一个 Delta 上),
    // and most OpenAI-compatible presets never send real usage unless the
    // request explicitly asked for it. When nothing real arrived, manufacture
    // the estimate here so the promise holds regardless of the endpoint.
    if (!sawRealUsage) {
      const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
      const prompt = estimateTokens(promptChars);
      const completion = estimateTokens(completionChars);
      yield { content: '', usage: { prompt, completion, total: prompt + completion, estimated: true } };
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal.aborted) return;
    throw new ProviderError(`网络错误：${String((err as Error)?.message ?? err)}`, 'network', true);
  } finally {
    signal.removeEventListener('abort', onCallerAbort);
  }
}

export async function testConnection(cfg: ProviderConfig): Promise<TestResult> {
  const base = cfg.baseURL.replace(/\/+$/, '');
  if (!base) return { ok: false, message: '还没有填写端点地址。' };

  // `new URL()` here only to surface a specific "not a valid URL" message —
  // `isLocalEndpoint` below does the same parse but swallows that error,
  // which would read here as "端点需要 API Key" instead of the real problem.
  try {
    new URL(base);
  } catch {
    return { ok: false, message: `端点地址不是合法 URL：${cfg.baseURL}` };
  }
  const isLocal = isLocalEndpoint(base);

  if (!cfg.apiKey && !isLocal) return { ok: false, message: '这个端点需要 API Key。' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // `/models` first: it is cheap, needs no token budget, and a 401 here is an
    // unambiguous "the key is wrong" rather than something the model said.
    const res = await fetch(`${base}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: ac.signal,
    });

    if (res.status === 401 || res.status === 403)
      return { ok: false, message: `Key 被拒绝（HTTP ${res.status}）。检查 Key 是否复制完整。` };
    if (!res.ok)
      return {
        ok: false,
        message: `端点返回 HTTP ${res.status}。检查地址是否为 OpenAI 兼容路径（通常以 /v1 结尾）。`,
      };

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    const hasModel = models.length === 0 || models.includes(cfg.model);
    return {
      ok: true,
      message: hasModel
        ? `连接成功${models.length ? `，端点提供 ${models.length} 个模型` : ''}。`
        : `连接成功，但端点没有列出「${cfg.model}」。可能仍然可用，也可能需要换一个。`,
      models,
    };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // The local presets fail here far more often than anywhere else, and the
    // browser reports CORS as a generic network error — so name the likely cause.
    if (isLocal)
      return {
        ok: false,
        message: `连不上本地服务（${msg}）。确认服务已启动，且已允许来自扩展的跨源请求（Ollama：OLLAMA_ORIGINS=chrome-extension://*）。`,
      };
    return { ok: false, message: `连接失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
