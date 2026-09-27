import { afterEach, describe, expect, it, vi } from 'vitest';
import { callModel, modelRequestFor, MODEL_NOT_CONFIGURED } from '@/agent/provider/call';
import type { ModelDelta, ModelMessage } from '@/agent/provider/types';
import type { ProviderConfig } from '@/shared/settings';
import { noUsageEver, oneToolCall, twoTextLines, usageAtEnd } from './fixtures/sse-lines';

/**
 * The layer between `transport` and an adapter: pick the protocol, let it
 * write the request, send it, let it read the answer — and take care of the
 * two things that belong to neither of them, the stream's opening event and
 * the usage estimate.
 *
 * Driven through a fake `fetch` because this is the piece that actually
 * sends. The lines it reads are the same fixtures the adapter is tested on,
 * re-encoded as bytes — that round trip is not incidental: it is the only
 * place `transport` and `parse` are asserted to agree on where a line ends.
 */

const enc = new TextEncoder();

/** The fixture lines, on the wire, as an endpoint would actually send them. */
function mockFetch(lines: string[], status = 200) {
  const body = lines.map((l) => `${l}\n\n`).join('');
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(body));
            controller.close();
          },
        }),
        { status },
      ),
  );
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

const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'X'.repeat(16) }] }];

async function collect(lines: string[], msgs: readonly ModelMessage[] = messages, c: ProviderConfig = cfg): Promise<ModelDelta[]> {
  vi.stubGlobal('fetch', mockFetch(lines));
  const out: ModelDelta[] = [];
  for await (const d of callModel(c, msgs, new AbortController().signal)) out.push(d);
  return out;
}

describe('callModel —— 一次调用的形状', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('流的第一件事是 stream-start，带着适配器丢了什么', async () => {
    // The warnings come from `prepare` and the events from `parse`; only
    // something holding both can put them in one stream, which is why this
    // event is made here and not in the adapter.
    const withReasoning: ModelMessage[] = [...messages, { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking…' }] }];
    const [first] = await collect(twoTextLines(), withReasoning);
    expect(first).toEqual({ type: 'stream-start', warnings: [{ type: 'unsupported-setting', setting: 'reasoning', detail: expect.any(String) }] });
  });

  it('没什么可说的时候，stream-start 的 warnings 是空的，但事件照样在', async () => {
    expect((await collect(twoTextLines()))[0]).toEqual({ type: 'stream-start', warnings: [] });
  });

  it('端点报了用量 → 原样带上来，estimated 是 false', async () => {
    expect((await collect(usageAtEnd())).at(-1)).toEqual({
      type: 'finish',
      usage: { prompt: 10, completion: 5, total: 15, estimated: false },
    });
  });

  it('端点全程不报用量 → 这一层按字符估一个，并标明是估的', async () => {
    // 16 prompt chars and 8 completion chars (`1234` + `5678`) — both exact
    // multiples of the 4-chars-per-token heuristic, so 4 and 2 are computed by
    // hand rather than read off the code.
    expect((await collect(noUsageEver())).at(-1)).toEqual({
      type: 'finish',
      usage: { prompt: 4, completion: 2, total: 6, estimated: true },
    });
  });

  it('答案整个是一次工具调用时，估算也算得出来——旧路径在这里记的是零', async () => {
    // The old path counted only text toward completion, and this product's
    // answers are tool calls almost every time, so an endpoint that reports no
    // usage used to be charged as if the model had written nothing.
    const last = (await collect(oneToolCall())).at(-1);
    expect(last).toMatchObject({ type: 'finish', reason: 'tool_calls', usage: { estimated: true } });
    expect((last as { usage: { completion: number } }).usage.completion).toBeGreaterThan(0);
  });

  it('用量永远落在最后一个事件上，不论哪一种', async () => {
    for (const lines of [usageAtEnd(), noUsageEver(), oneToolCall()]) {
      const deltas = await collect(lines);
      expect(deltas.at(-1)).toMatchObject({ type: 'finish', usage: expect.anything() });
      expect(deltas.filter((d) => d.type === 'finish')).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});

describe('callModel —— 发不出去的时候', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('空 Key + 远程端点 → 不发起任何 fetch，抛出可识别错误', async () => {
    // The page's element table is in `request`. What has to be protected here
    // is not the wording of the error but that `fetch` was never called —
    // throwing after the request went out is a fait accompli.
    const fetchMock = vi.fn(async () => {
      throw new Error('不该发出任何网络请求');
    });
    vi.stubGlobal('fetch', fetchMock);
    const noKey: ProviderConfig = { ...cfg, apiKey: '', baseURL: 'https://api.openai.com/v1' };
    const run = async () => {
      for await (const _ of callModel(noKey, messages, new AbortController().signal)) {
        // drained
      }
    };
    await expect(run()).rejects.toMatchObject({ kind: 'auth', retryable: false, message: MODEL_NOT_CONFIGURED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空 Key + localhost 端点 → 照常放行（本地模型本来就不需要 Key）', async () => {
    const local: ProviderConfig = { ...cfg, apiKey: '', baseURL: 'http://127.0.0.1:11434/v1' };
    expect((await collect(twoTextLines(), messages, local)).filter((d) => d.type === 'text-delta')).toHaveLength(2);
  });

  it('流中途 abort → 停止产出，不抛错，也不补一个半截答案的用量', async () => {
    vi.stubGlobal('fetch', mockFetch(twoTextLines()));
    const ac = new AbortController();
    const it_ = callModel(cfg, messages, ac.signal)[Symbol.asyncIterator]();
    expect((await it_.next()).value).toMatchObject({ type: 'stream-start' });
    ac.abort();
    const rest: ModelDelta[] = [];
    while (true) {
      const r = await it_.next();
      if (r.done) break;
      rest.push(r.value);
    }
    expect(rest.filter((d) => d.type === 'finish')).toEqual([]);
  });

  it('端点在流里报错 → 原样抛上来，不被包成「网络错误」', async () => {
    vi.stubGlobal('fetch', mockFetch(['data: {"error":{"message":"invalid_api_key"}}']));
    const run = async () => {
      for await (const _ of callModel(cfg, messages, new AbortController().signal)) {
        // drained
      }
    };
    await expect(run()).rejects.toMatchObject({ kind: 'contract', retryable: false });
  });

  it('data 行不是合法 JSON → 包成可路由的错误，而不是让 SyntaxError 漏到运行循环', async () => {
    vi.stubGlobal('fetch', mockFetch(['data: {not json']));
    const run = async () => {
      for await (const _ of callModel(cfg, messages, new AbortController().signal)) {
        // drained
      }
    };
    await expect(run()).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('modelRequestFor —— 端点要的那几个字段，跟着模型走', () => {
  // 这条以前没有测试守着：字段是在发请求的那一刻去预设表里查的，而自定义端点
  // （聚合商的地址就是这一类）永远查不到，于是它一个字段都发不出去。现在它们
  // 存在配置里、按模型分开，所以「发出去的是不是这一个模型的那一套」要有人看着。
  const withFields = (fields: Record<string, Record<string, unknown>>): ProviderConfig => ({
    ...cfg,
    preset: 'custom',
    requestByModel: fields,
  });

  it('当前模型的字段进 providerOptions，放在这个端点所讲协议的名下', () => {
    const req = modelRequestFor(withFields({ 'test-model': { enable_thinking: false } }), []);
    expect(req.providerOptions).toEqual({ 'openai-chat': { enable_thinking: false } });
  });

  it('别的模型的字段不会跟着跑出去', () => {
    // qwen 那一套发给一个 OpenAI 模型，在别的端点上会被判成未知参数直接报错。
    const req = modelRequestFor(withFields({ 'other-model': { enable_thinking: false } }), []);
    expect(req.providerOptions).toBeUndefined();
  });

  it('没有字段时连 providerOptions 这个键都不出现，而不是一个空对象', () => {
    expect(modelRequestFor(withFields({ 'test-model': {} }), [])).not.toHaveProperty('providerOptions');
  });

  it('预设不再在发送时被查——它只是把值填进配置', () => {
    // 同一个 deepseek 预设，配置里没有字段：发出去的就没有字段。
    const req = modelRequestFor({ ...cfg, preset: 'deepseek', requestByModel: {} }, []);
    expect(req.providerOptions).toBeUndefined();
  });
});
