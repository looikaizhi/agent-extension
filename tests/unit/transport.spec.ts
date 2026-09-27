import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  fetchOnce,
  MAX_RESPONSE_BYTES,
  ProviderError,
  STALL_TIMEOUT_MS,
  streamLines,
  TOTAL_TIMEOUT_MS,
  type HttpRequest,
} from '@/agent/provider/transport';
import type { ProviderConfig } from '@/shared/settings';
import {
  crlfLineEndings,
  finalLineWithoutNewline,
  heartbeatBetweenDataLines,
  lineSplitAcrossChunkBoundary,
  multiByteCharSplitMidCharacter,
  oversizedResponse,
  twoCompleteLines,
} from './fixtures/sse-streams';

/**
 * `transport` is the seam, and it is the one place a fake `fetch` is still
 * unavoidable: the three clocks, the byte cap and cancellation are properties
 * of an actual request, and there is nothing below them to stub instead.
 *
 * Everything here is asserted in *lines*. That is the cut: a chunk boundary
 * landing mid-character or mid-line, a `\r` left over from CRLF, a body with
 * no trailing newline and a heartbeat comment are SSE's problems, settled once
 * here so no protocol adapter ever meets them. What a line *means* —
 * `data:`, `[DONE]`, `choices[].delta` — is not this file's business and is
 * tested in `openai-chat.spec.ts`.
 */

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

function mockFetch(chunks: Uint8Array[], status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(streamOf(chunks), { status }));
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

const cfg: ProviderConfig = {
  preset: 'custom',
  protocol: 'openai-chat',
  verdictByModel: {},
  baseURL: 'https://x.test/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  requestByModel: {},
  contextWindow: 32_000,
};

const post: HttpRequest = {
  path: '/chat/completions',
  method: 'POST',
  auth: 'bearer',
  headers: { 'Content-Type': 'application/json' },
  body: '{"model":"test-model"}',
};

const linesOf = (chunks: Uint8Array[], signal = new AbortController().signal) => {
  vi.stubGlobal('fetch', mockFetch(chunks));
  return collect(streamLines(cfg, post, signal));
};

describe('transport —— 字节切成行', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('一行跨两个 chunk（换行符落在下一个 chunk 里）→ 一整行', async () => {
    expect(await linesOf(lineSplitAcrossChunkBoundary())).toEqual([
      'data: {"choices":[{"delta":{"content":"split across chunks"}}]}',
    ]);
  });

  it('一个多字节字符被从中间切开 → 字符完整', async () => {
    expect(await linesOf(multiByteCharSplitMidCharacter())).toEqual(['data: {"choices":[{"delta":{"content":"中文"}}]}']);
  });

  it('CRLF 行尾 → 与 LF 等价，行尾不留 \\r', async () => {
    // Left on, a trailing `\r` is invisible to `JSON.parse` (legal whitespace)
    // and fatal to any equality test — `data: [DONE]\r` is not `data: [DONE]`.
    // Which is precisely why it is cut here and not in each adapter.
    expect(await linesOf(crlfLineEndings())).toEqual(['data: {"choices":[{"delta":{"content":"CRLF"}}]}']);
  });

  it('最后一行没有换行符 → 内容不丢', async () => {
    expect(await linesOf(finalLineWithoutNewline())).toEqual(['data: {"choices":[{"delta":{"content":"tail with no newline"}}]}']);
  });

  it('心跳注释行（: keep-alive）混在数据行之间 → 上游看不到它', async () => {
    // SSE's own framing, not any endpoint's: a comment line and the blank
    // line between events both mean "nothing to read here".
    expect(await linesOf(heartbeatBetweenDataLines())).toEqual([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
    ]);
  });

  it('超过大小上限的响应 → 中止并抛错', async () => {
    vi.stubGlobal('fetch', mockFetch(oversizedResponse(MAX_RESPONSE_BYTES)));
    await expect(collect(streamLines(cfg, post, new AbortController().signal))).rejects.toMatchObject({
      kind: 'size-limit',
    });
  });
});

describe('transport —— 请求怎么发出去', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('路径由调用方给，鉴权头由 transport 贴——密钥只有这一个去处', async () => {
    const fetchImpl = mockFetch(twoCompleteLines());
    vi.stubGlobal('fetch', fetchImpl);
    await collect(streamLines(cfg, post, new AbortController().signal));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://x.test/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe('{"model":"test-model"}');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('末尾多余的斜杠不会变成双斜杠的路径', async () => {
    const fetchImpl = mockFetch(twoCompleteLines());
    vi.stubGlobal('fetch', fetchImpl);
    await collect(streamLines({ ...cfg, baseURL: 'https://x.test/v1//' }, post, new AbortController().signal));
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x.test/v1/chat/completions');
  });

  it('没有 Key 的端点（本地模型）→ 不贴鉴权头，而不是贴一个空的', async () => {
    const fetchImpl = mockFetch(twoCompleteLines());
    vi.stubGlobal('fetch', fetchImpl);
    await collect(streamLines({ ...cfg, apiKey: '' }, post, new AbortController().signal));
    expect(fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization');
  });

  it('signal 在流中途 abort → 停止产出（不抛错），且 signal 真的传给了 fetch', async () => {
    const fetchImpl = mockFetch(twoCompleteLines());
    vi.stubGlobal('fetch', fetchImpl);
    const ac = new AbortController();
    const iterator = streamLines(cfg, post, ac.signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);

    ac.abort();

    const seen: string[] = [];
    while (true) {
      const r = await iterator.next();
      if (r.done) break;
      seen.push(r.value);
    }
    expect(seen).toEqual([]);

    // The seam promises the signal reaches the real fetch call, not just the
    // read loop. `transport` links a fetch-owned controller to the caller's
    // signal (a timeout must be able to cancel the fetch too, which the
    // caller's own signal can never do from the inside) — so this checks the
    // functional promise, not object identity: whatever was actually handed
    // to `fetch()` reports aborted once the caller aborts.
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });
});

describe('transport —— HTTP 层的失败分类', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A non-2xx status is the same "answer silently missing" risk as an error
  // object carried inside an HTTP-200 stream: the body won't be SSE-shaped, so
  // every line would be dropped and the call would quietly look like "the
  // model said nothing" instead of surfacing the real HTTP failure.
  it('401 → 不可重试的 auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })),
    );
    await expect(collect(streamLines(cfg, post, new AbortController().signal))).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
  });

  it('429 → 可重试的 network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })),
    );
    await expect(collect(streamLines(cfg, post, new AbortController().signal))).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('fetch 本身抛错 → 包成可识别的 ProviderError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await collect(streamLines(cfg, post, new AbortController().signal)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect((err as ProviderError).message).toContain('Failed to fetch');
  });
});

describe('transport —— 非流式模式', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const models: HttpRequest = { path: '/models', method: 'GET', auth: 'bearer' };

  it('一次读完整个响应体：状态码与正文都交回，不在这里下判断', async () => {
    // `listModels` needs the status itself — a 401 there means "the key is
    // wrong", which is a different sentence from the streaming path's. So this
    // mode reports rather than throws.
    const payload = JSON.stringify({ data: [{ id: 'test-model' }] });
    vi.stubGlobal('fetch', mockFetch([enc.encode(payload)]));
    expect(await fetchOnce(cfg, models)).toEqual({ status: 200, ok: true, body: payload });
  });

  it('非 2xx 也照样交回，不抛错', async () => {
    vi.stubGlobal('fetch', mockFetch([enc.encode('nope')], 401));
    expect(await fetchOnce(cfg, models)).toMatchObject({ status: 401, ok: false });
  });

  it('正文里的换行与空行原样保留（JSON 不是事件流）', async () => {
    const pretty = '{\n  "data": [],\n\n  "object": "list"\n}';
    vi.stubGlobal('fetch', mockFetch([enc.encode(pretty)]));
    expect((await fetchOnce(cfg, models)).body).toBe(pretty);
  });

  it('同样的三个钟：首字节不来就是 timeout-connect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const result = fetchOnce(cfg, models);
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout-connect', retryable: true });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    await assertion;
  }, 3000);

  it('同样的 2MB 上限', async () => {
    vi.stubGlobal('fetch', mockFetch(oversizedResponse(MAX_RESPONSE_BYTES)));
    await expect(fetchOnce(cfg, models)).rejects.toMatchObject({ kind: 'size-limit' });
  });
});

describe('transport —— 三层超时', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connect（首字节）超时 → timeout-connect', async () => {
    vi.useFakeTimers();
    // The server never answers at all — `fetch()` itself never settles.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const result = collect(streamLines(cfg, post, new AbortController().signal));
    // Attach the rejection handler *before* advancing time: the rejection
    // itself happens synchronously inside `advanceTimersByTimeAsync`, so a
    // handler wired up only afterward (e.g. `await expect(result).rejects`
    // called after the advance) is briefly and spuriously "unhandled".
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout-connect', retryable: true });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    await assertion;
  }, 3000);

  it('stall（两行之间）超时 → timeout-stall', async () => {
    vi.useFakeTimers();
    // One line arrives immediately, then the socket goes silent forever.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          pulled++;
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"one"}}]}\n\n'));
          return;
        }
        return new Promise<void>(() => {});
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const result = collect(streamLines(cfg, post, new AbortController().signal));
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout-stall', retryable: true });
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
    await assertion;
  }, 3000);

  it('心跳行不算活着：只发注释行的连接照样 timeout-stall', async () => {
    // A heartbeat is dropped before anything upstream sees it, and it does not
    // push the stall deadline back out either — a socket that only ever says
    // `: keep-alive` is producing no answer, and 30s of that is a stall.
    vi.useFakeTimers();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          pulled++;
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"one"}}]}\n\n'));
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(enc.encode(': keep-alive\n\n'));
            resolve();
          }, STALL_TIMEOUT_MS / 2);
        });
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const result = collect(streamLines(cfg, post, new AbortController().signal));
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout-stall', retryable: true });
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
    await assertion;
  }, 3000);

  it('total（整通调用）超时 → timeout-total', async () => {
    vi.useFakeTimers();
    // First byte arrives immediately (well inside the 15s connect budget).
    // After that, content keeps arriving every 25s — comfortably inside the
    // 30s stall window, so stall never trips — but the cumulative time
    // exceeds the 120s total budget.
    const gapMs = 25_000;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          pulled++;
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"tick"}}]}\n\n'));
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"tick"}}]}\n\n'));
            resolve();
          }, gapMs);
        });
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const result = collect(streamLines(cfg, post, new AbortController().signal));
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout-total', retryable: true });
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + gapMs);
    await assertion;
  }, 3000);
});
