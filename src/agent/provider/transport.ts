import type { ProviderConfig } from '@/shared/settings';

/**
 * The one place in this extension that puts a model request on the wire.
 *
 * Splitting "how a request goes out and how the response comes back" from
 * "which wire format is being spoken" is what lets a second protocol cost two
 * pure functions instead of a second copy of the clocks, the byte cap, the
 * cancellation wiring and the SSE line splitter. Everything here is true of
 * any endpoint; none of it knows what a request or a response *means*.
 *
 * Precisely: it does not know any protocol's request body or response body.
 * The path is the caller's (`/chat/completions`, `/models`) — the key is not.
 * A caller declares only *that* its request is authenticated, and this file is
 * the only thing in the tree that ever reads `cfg.apiKey` on its way out.
 * `architecture.spec.ts` asserts both halves: exactly two files may open a
 * socket — this one, and the document-fetch executor that never sees a key —
 * and nothing else may.
 */

/**
 * `retryable` is the caller's routing signal: network hiccups, 429s and 5xx
 * are worth a retry; a rejected key or a malformed contract are not — retrying
 * either just spends the same money on the same failure. Nothing here ever
 * retries on its own (that decision belongs to the caller, per the seam
 * contract).
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

/**
 * Nothing here lets a raw error escape once it has decided the call was
 * genuinely aborted (see the catch blocks below) — anything that reaches this
 * function and is not a `ProviderError` is an even-more-unexpected failure
 * that still has to be said honestly, rather than leak `[object Object]` or a
 * stack trace to the user.
 *
 * Lives beside `ProviderError` rather than in the panel: it reads that class
 * and nothing else, and `agent/agents/guide/runner.ts` needs it too —
 * importing a panel module from under `src/agent` would run the dependency the
 * wrong way.
 */
export function describeProviderError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  return `未知错误：${String((err as Error)?.message ?? err)}`;
}

/**
 * A real page-QA answer (explanation text + the JSON envelope's ref list) is
 * well under 10 KB even on a busy page. 2 MB gives ~200x headroom above that
 * — enough that no legitimate answer ever trips it — while still bounding the
 * worst case: a runaway generation loop or a misbehaving proxy that echoes
 * garbage indefinitely would otherwise buffer without limit.
 */
export const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * Three independent clocks, all present in real deployments:
 *
 *  - **connect** — time to first byte. A plain `/models` GET and a POST that
 *    has to reach the same network path before the model even starts deserve
 *    the same patience, not more, not less — which is why the connection test
 *    has no fourth clock of its own any more.
 *  - **stall** — time between two lines once the response has started.
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

/**
 * One request, as everything above this file describes it.
 *
 * `body` arrives already serialized, and `headers` carries no authorization:
 * `auth` is a *declaration* that this request is authenticated, which is what
 * keeps the key out of every caller. One scheme today because every endpoint
 * this product speaks to uses it; a protocol that needs another declares it
 * here rather than building a header of its own.
 */
export interface HttpRequest {
  /** Appended to the configured base, e.g. `/chat/completions`. */
  path: string;
  method: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: string;
  auth: 'bearer';
}

/** What the non-streaming mode hands back. The status is not judged here — the caller asked for one shot, not for a verdict. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

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

/** The three clocks and the cancellation wiring of one call, shared by both modes. */
function beginCall(signal?: AbortSignal) {
  // A separate controller, not the caller's `signal` directly: a timeout has
  // to be able to cancel the in-flight request too, and the caller's signal
  // is never ours to abort from the inside.
  const internal = new AbortController();
  const onCallerAbort = () => internal.abort();
  signal?.addEventListener('abort', onCallerAbort);

  const startedAt = Date.now();
  // "connect" until the first byte arrives, then "stall" — one deadline, one
  // meaning at a time. `remainingTotal()` is recomputed every iteration so a
  // single long-lived timer is never left racing calls it no longer guards.
  let livenessDeadline = startedAt + CONNECT_TIMEOUT_MS;
  let firstByteSeen = false;
  const remainingTotal = () => Math.max(0, startedAt + TOTAL_TIMEOUT_MS - Date.now());

  return {
    /** Handed to `fetch`, so a deadline can cancel the request itself. */
    fetchSignal: internal.signal,
    /** Races `op` against both the current liveness deadline and the total budget, at once. */
    async guarded<T>(op: Promise<T>): Promise<T> {
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
    },
    /** The first byte, and only the first, switches the liveness clock from connect to stall. */
    sawFirstByte(): void {
      if (firstByteSeen) return;
      firstByteSeen = true;
      livenessDeadline = Date.now() + STALL_TIMEOUT_MS;
    },
    /**
     * Evidence of life — push the stall deadline back out.
     *
     * What counts as evidence is a line the endpoint meant to send, not a
     * chunk that happened to arrive: a socket producing nothing but
     * `: keep-alive` is producing no answer, and 30 seconds of that is a
     * stall. (Before the split this was pushed once per parsed `Delta`, which
     * is the same thing one layer up — except for a data line carrying
     * nothing, which the endpoint still had to be alive to send.)
     */
    alive(): void {
      livenessDeadline = Date.now() + STALL_TIMEOUT_MS;
    },
    dispose(): void {
      signal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

type Call = ReturnType<typeof beginCall>;

const urlFor = (cfg: ProviderConfig, req: HttpRequest): string => `${cfg.baseURL.replace(/\/+$/, '')}${req.path}`;

const initFor = (cfg: ProviderConfig, req: HttpRequest, fetchSignal: AbortSignal): RequestInit => ({
  method: req.method,
  headers: {
    ...req.headers,
    // The single place a key is read on its way out. Absent for the local
    // presets, which need none (`isLocalEndpoint`, `provider.ts`).
    ...(req.auth === 'bearer' && cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  },
  ...(req.body === undefined ? {} : { body: req.body }),
  signal: fetchSignal,
});

/**
 * Gotcha, HTTP layer: a non-2xx status is the same silent-failure risk as an
 * error object carried inside an HTTP-200 stream — the body will not be
 * SSE-shaped (no `data:` prefix), so every line a parser saw would just be
 * dropped, and the call would quietly look like "the model said nothing"
 * instead of surfacing the real rejection.
 */
async function httpError(res: Response): Promise<ProviderError> {
  const detail = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`Key 被拒绝（HTTP ${res.status}）。${detail}`, 'auth', false);
  }
  if (res.status === 429 || res.status >= 500) {
    return new ProviderError(`端点暂时不可用（HTTP ${res.status}）。${detail}`, 'network', true);
  }
  return new ProviderError(`端点返回 HTTP ${res.status}。${detail}`, 'contract', false);
}

/** Bytes to text: the byte cap, the caller's abort, and a UTF-8 decode that survives a chunk boundary landing mid-character. */
async function* readBody(res: Response, call: Call, signal?: AbortSignal): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  while (true) {
    // Checked on both sides of the await: the caller can abort while we are
    // parked in `reader.read()`, not just between two chunks.
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { value, done } = await call.guarded(reader.read());
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    if (done) return;
    call.sawFirstByte();
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProviderError(`响应超过大小上限（${MAX_RESPONSE_BYTES} 字节）`, 'size-limit', false);
    }
    yield decoder.decode(value, { stream: true });
  }
}

/**
 * One line as a protocol gets to see it, or `null` when the line is pure SSE
 * framing and no protocol should ever be shown it.
 *
 * Both cases are defined by the SSE specification rather than by any endpoint,
 * which is exactly why they are settled once here: a `\r` survives a split on
 * `\n` and every adapter would otherwise have to remember to trim it (today's
 * parser only gets away with it because a trailing `\r` is legal JSON
 * whitespace — `data: [DONE]\r` already fails an equality test against
 * `[DONE]`), and a `:` comment line is a heartbeat, which means nothing to
 * anybody upstream.
 */
function usable(line: string): string | null {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmed || trimmed.startsWith(':')) return null;
  return trimmed;
}

/**
 * Streaming mode: one line at a time, for as long as the endpoint keeps
 * talking.
 *
 * A line — not a byte, and not a parsed event. Where the cut goes is the whole
 * point: UTF-8 split mid-character, a line split across two chunks, CRLF,
 * a body that ends without a trailing newline and a heartbeat comment are all
 * *SSE* problems, so writing them once here is what stops the next protocol
 * from meeting them again. `[DONE]`, by contrast, is OpenAI's own convention
 * (Anthropic has no such marker) and stays with whoever parses the lines.
 *
 * An aborted caller ends the stream rather than failing it: it asked for
 * nothing more, which is not the same as something having gone wrong.
 */
export async function* streamLines(cfg: ProviderConfig, req: HttpRequest, signal: AbortSignal): AsyncGenerator<string> {
  const call = beginCall(signal);
  try {
    const res = await call.guarded(fetch(urlFor(cfg, req), initFor(cfg, req, call.fetchSignal)));
    if (!res.ok) throw await httpError(res);

    let buffer = '';
    for await (const chunk of readBody(res, call, signal)) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = usable(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        if (line === null) continue;
        call.alive();
        yield line;
      }
    }
    // The socket can close without a trailing newline — the last line is only
    // visible once `read()` reports done, so flush whatever is left. Not after
    // an abort, though: `readBody` returns quietly on one, and a caller that
    // stopped listening is owed nothing further.
    if (signal.aborted) return;
    const tail = usable(buffer);
    if (tail !== null) yield tail;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal.aborted) return;
    throw new ProviderError(`网络错误：${String((err as Error)?.message ?? err)}`, 'network', true);
  } finally {
    call.dispose();
  }
}

/**
 * Non-streaming mode: read the whole body, under the same three clocks and the
 * same byte cap, and hand back the status with it.
 *
 * This exists so that the connection test does not need a `fetch` of its own.
 * A second call site with its own socket would make "the key has exactly one
 * destination" a claim about two files instead of a fact about one — and the
 * body is returned rather than split into lines because a JSON document is not
 * an event stream: dropping its blank lines would corrupt it.
 *
 * No abort signal: the streaming call is the long one a user can cancel, this
 * one is a button that either answers or runs out of clock.
 */
export async function fetchOnce(cfg: ProviderConfig, req: HttpRequest): Promise<HttpResponse> {
  const call = beginCall();
  try {
    const res = await call.guarded(fetch(urlFor(cfg, req), initFor(cfg, req, call.fetchSignal)));
    let body = '';
    for await (const chunk of readBody(res, call)) {
      call.alive();
      body += chunk;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`网络错误：${String((err as Error)?.message ?? err)}`, 'network', true);
  } finally {
    call.dispose();
  }
}
