import { describe, expect, it } from 'vitest';
import { openaiChat } from '@/agent/provider/protocols/openai-chat';
import type { ModelDelta, ModelRequest } from '@/agent/provider/types';
import {
  dataAfterDone,
  errorObjectInStream,
  noUsageEver,
  oneToolCall,
  textAndToolInOneChunk,
  twoTextLines,
  twoToolCallsInterleaved,
  usageAtEnd,
  usageMissingTotal,
  usageWithCacheHit,
} from './fixtures/sse-lines';

/**
 * The `openai-chat` adapter, both halves: a `ModelRequest` in and an
 * `HttpRequest` out, lines in and `ModelDelta`s out, and nothing in between
 * that needs a network, a clock or a key. Every test here calls a pure
 * function and reads what it returned — no mocked `fetch`, no `Response`, no
 * timers, which is the whole return on cutting the seam here.
 *
 * One thing this file does not cover, on purpose: the estimated usage for an
 * endpoint that reports none is not the adapter's to make — `parse` cannot see
 * the request — so it is asserted in `call-model.spec.ts`.
 */

const { prepare } = openaiChat;

const bodyOf = (req: ModelRequest) => JSON.parse(prepare(req).http.body!) as Record<string, unknown>;

const TOOL = { name: 'point', description: '指出下一步', inputSchema: { type: 'object' }, strict: true };

const base: ModelRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'you are a guide' }] },
    { role: 'user', content: [{ type: 'text', text: 'take me to the issues' }] },
  ],
  temperature: 1,
};

describe('openai-chat · prepare 出来的请求', () => {
  it('路径与方法是这个协议的，鉴权只是一句声明——头里没有任何密钥', () => {
    // The whole reason this product writes its own adapters instead of using a
    // provider SDK: every one of those fetches for itself, so every one of
    // them holds the user's key. An adapter that built an `Authorization`
    // header here would give that up from the inside.
    const { http } = prepare(base);
    expect(http.path).toBe('/chat/completions');
    expect(http.method).toBe('POST');
    expect(http.auth).toBe('bearer');
    expect(http.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('body 是适配器自己序列化好的字符串，不是一个等别人 stringify 的对象', () => {
    // Not a style preference: the request-body whitelist in
    // `architecture.spec.ts` reads this literal out of the syntax tree, and it
    // can only see the keys if they are written here.
    expect(typeof prepare(base).http.body).toBe('string');
  });

  it('纯函数：同一个请求调两次，两次字节相同', () => {
    expect(prepare(base).http.body).toBe(prepare(base).http.body);
  });

  it('键序就是字节：模型、消息、流、用量、温度、端点自己的字段，然后工具三件', () => {
    // Key order is the only real constraint on "the bytes did not change" — a
    // field moved one line up means nothing semantically and changes every
    // byte after it.
    const req: ModelRequest = {
      ...base,
      tools: [TOOL],
      providerOptions: { 'openai-chat': { thinking: { type: 'disabled' } } },
    };
    expect(Object.keys(bodyOf(req))).toEqual([
      'model', 'messages', 'stream', 'stream_options', 'temperature',
      'thinking', 'tools', 'tool_choice', 'parallel_tool_calls',
    ]);
  });

  it('没有工具时，三个工具字段一个都不发', () => {
    expect(Object.keys(bodyOf(base))).toEqual(['model', 'messages', 'stream', 'stream_options', 'temperature']);
  });

  it('工具默认是「必须调一个」，写明了就照写', () => {
    expect(bodyOf({ ...base, tools: [TOOL] }).tool_choice).toBe('required');
    expect(bodyOf({ ...base, tools: [TOOL], toolChoice: 'auto' }).tool_choice).toBe('auto');
  });

  it('工具嵌在 function 下（这是与 Responses 最容易踩的差别），键序照 name/description/strict/parameters', () => {
    const [tool] = bodyOf({ ...base, tools: [TOOL] }).tools as Record<string, unknown>[];
    expect(tool).toEqual({
      type: 'function',
      function: { name: 'point', description: '指出下一步', strict: true, parameters: { type: 'object' } },
    });
    expect(Object.keys(tool!.function as object)).toEqual(['name', 'description', 'strict', 'parameters']);
  });

  it('工具没写描述或 strict → 那两个键根本不出现，而不是发一个 undefined', () => {
    const [tool] = bodyOf({ ...base, tools: [{ name: 'done', inputSchema: {} }] }).tools as Record<string, unknown>[];
    expect(tool!.function).toEqual({ name: 'done', parameters: {} });
  });
});

describe('openai-chat · 消息翻成这条线上的形状', () => {
  it('普通消息：一段文字，多段文字接起来', () => {
    const req: ModelRequest = {
      ...base,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    };
    expect(bodyOf(req).messages).toEqual([{ role: 'user', content: 'ab' }]);
  });

  it('模型调工具的那一轮：content 是显式的 null，调用带 id 与原样的参数文本', () => {
    const req: ModelRequest = {
      ...base,
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'observe', input: '{"why":"x"}' }] }],
    };
    expect(bodyOf(req).messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'observe', arguments: '{"why":"x"}' } }] },
    ]);
  });

  it('送回去的工具结果：靠 tool_call_id 配对，而且它排在 content 前面', () => {
    const req: ModelRequest = {
      ...base,
      messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', output: '读到了' }] }],
    };
    const [m] = bodyOf(req).messages as Record<string, unknown>[];
    expect(m).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '读到了' });
    expect(Object.keys(m!)).toEqual(['role', 'tool_call_id', 'content']);
  });
});

describe('openai-chat · 丢掉的东西必须说出来', () => {
  it('什么都没丢 → 没有 warning', () => {
    expect(prepare(base).warnings).toEqual([]);
  });

  it('推理块丢了要说：这条线没有把模型自己那段推理送回去的位置', () => {
    // Responses *requires* the reasoning item to come back with the tool
    // result it precedes. Here there is nowhere to put it — and a silently
    // dropped one is exactly the kind of degradation that reads, three layers
    // up, as "the product is broken".
    const req: ModelRequest = {
      ...base,
      messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking…' }, { type: 'text', text: 'hi' }] }],
    };
    expect(prepare(req).warnings).toEqual([{ type: 'unsupported-setting', setting: 'reasoning', detail: expect.any(String) }]);
    // Dropped, not smuggled into the text.
    expect((bodyOf(req).messages as Record<string, unknown>[])[0]!.content).toBe('hi');
  });

  it('写给别的协议的字段丢了也要说，而且自己的那一份照发', () => {
    const req: ModelRequest = {
      ...base,
      providerOptions: { 'openai-chat': { thinking: { type: 'disabled' } }, 'openai-responses': { reasoning: { effort: 'low' } } },
    };
    expect(prepare(req).warnings).toEqual([
      { type: 'unsupported-setting', setting: 'providerOptions.openai-responses', detail: expect.any(String) },
    ]);
    expect(bodyOf(req)).toMatchObject({ thinking: { type: 'disabled' } });
    expect(bodyOf(req)).not.toHaveProperty('reasoning');
  });
});

describe('openai-chat · 它对自己的声明', () => {
  it('两项能力各自有一条分支读它', () => {
    // The list is short on purpose (CONTEXT.md `Capability`): a capability is
    // on it only because some branch reads it. `toolCallId` decides whether
    // the repair round can pair or has to re-send; `promptCaching` is the
    // settings page's native-vs-compatibility line.
    expect(openaiChat.capabilities).toEqual({ toolCallId: true, promptCaching: true });
  });
});

/* ═══════════ parse: lines back from the endpoint ═══════════ */

async function* asLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

const deltasOf = async (lines: string[]): Promise<ModelDelta[]> => {
  const out: ModelDelta[] = [];
  for await (const d of openaiChat.parse(asLines(lines))) out.push(d);
  return out;
};

describe('openai-chat · parse 吃的是行，不是字节', () => {
  it('两行文字 → 两个 text-delta，外加收尾的 finish', async () => {
    expect(await deltasOf(twoTextLines())).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
      { type: 'finish' },
    ]);
  });

  it('[DONE] 之后还有数据行 → 丢弃', async () => {
    // OpenAI 自己的约定，不是 SSE 的，所以它在这里读而不在 transport 读。
    expect(await deltasOf(dataAfterDone())).toEqual([{ type: 'text-delta', text: 'before' }, { type: 'finish' }]);
  });

  it('usage 块在最后 → 落在 finish 上，estimated: false', async () => {
    const last = (await deltasOf(usageAtEnd())).at(-1);
    expect(last).toEqual({ type: 'finish', usage: { prompt: 10, completion: 5, total: 15, estimated: false } });
  });

  it('usage 缺 total_tokens → 用 prompt + completion，而不是写一个 0', async () => {
    const last = (await deltasOf(usageMissingTotal())).at(-1);
    expect(last).toEqual({ type: 'finish', usage: { prompt: 10, completion: 5, total: 15, estimated: false } });
  });

  it('缓存命中的那一份用量：扁平的那种拼法也认', async () => {
    const last = (await deltasOf(usageWithCacheHit())).at(-1);
    expect(last).toMatchObject({ usage: { prompt: 3712, cachedPrompt: 3584 } });
  });

  it('端点全程不发 usage → finish 上就是空的，估算不归这一层', async () => {
    // `parse` 看得见行，看不见请求，所以算不出提示词那一侧。补在哪见 `call.ts`。
    expect((await deltasOf(noUsageEver())).at(-1)).toEqual({ type: 'finish' });
  });

  it('HTTP 200 的流里携带 error 对象 → 抛出可识别的错误，不是空输出', async () => {
    await expect(deltasOf(errorObjectInStream())).rejects.toMatchObject({ kind: 'contract', retryable: false });
  });

  it('finish_reason 与 usage 落在两个不同的块上 → 只收一个 finish，两样都在', async () => {
    const lines = [
      'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      'data: [DONE]',
    ];
    const deltas = await deltasOf(lines);
    expect(deltas.filter((d) => d.type === 'finish')).toHaveLength(1);
    expect(deltas.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls', usage: { prompt: 1, completion: 2, total: 3, estimated: false } });
  });
});

describe('openai-chat · 工具调用：这条线上没有开始事件，所以要合成一个', () => {
  it('一个工具调用：第一片带 id 与名字 → 合成 tool-input-start，其余是参数片', async () => {
    expect(await deltasOf(oneToolCall())).toEqual([
      { type: 'tool-input-start', id: 'call_1', name: 'point', index: 0 },
      { type: 'tool-input-delta', index: 0, delta: '{"ref"', raw: '{"ref"' },
      { type: 'tool-input-delta', index: 0, delta: ':"e5"}', raw: ':"e5"}' },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('两个调用交错 → 按 index 解复用，各自只开始一次', async () => {
    const deltas = await deltasOf(twoToolCallsInterleaved());
    expect(deltas.filter((d) => d.type === 'tool-input-start')).toEqual([
      { type: 'tool-input-start', id: 'call_a', name: 'point', index: 0 },
      { type: 'tool-input-start', id: 'call_b', name: 'done', index: 1 },
    ]);
    const joined = (i: number) =>
      deltas.filter((d) => d.type === 'tool-input-delta' && d.index === i).map((d) => (d as { delta: string }).delta).join('');
    expect(joined(0)).toBe('{"a":1}');
    expect(joined(1)).toBe('{"b":2}');
  });

  it('一个块里同时有文字和工具片 → 拆成两个事件，先文字后工具', async () => {
    // 扁平结构下这是一个 delta 带两样东西；判别联合下它必然是两件事，这也正是
    // 为什么「逐项相同」这种对照做不出来。
    expect((await deltasOf(textAndToolInOneChunk())).map((d) => d.type)).toEqual([
      'text-delta',
      'tool-input-start',
      'tool-input-delta',
      'finish',
    ]);
  });

  it('参数片是空字符串 → 不产出空事件', async () => {
    const lines = ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"done","arguments":""}}]}}]}'];
    expect(await deltasOf(lines)).toEqual([{ type: 'tool-input-start', id: 'c', name: 'done', index: 0 }, { type: 'finish' }]);
  });

  it('没有 index 的端点 → 当成 0（一次一个调用）', async () => {
    const lines = ['data: {"choices":[{"delta":{"tool_calls":[{"id":"c","function":{"name":"done","arguments":"{}"}}]}}]}'];
    expect(await deltasOf(lines)).toMatchObject([{ type: 'tool-input-start', index: 0 }, { type: 'tool-input-delta', index: 0 }, { type: 'finish' }]);
  });

  it('同一份行喂两次，两次结果相同——纯粹，但不是无状态', async () => {
    expect(await deltasOf(twoToolCallsInterleaved())).toEqual(await deltasOf(twoToolCallsInterleaved()));
  });
});
