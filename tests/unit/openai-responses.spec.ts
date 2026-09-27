import { describe, expect, it } from 'vitest';
import { openaiResponses } from '@/agent/provider/protocols/openai-responses';
import { openaiChat } from '@/agent/provider/protocols/openai-chat';
import type { ModelDelta, ModelMessage, ModelRequest } from '@/agent/provider/types';
import { guideAgent } from '@/agent/agents/guide/agent';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import { modelRequestFor } from '@/agent/provider/call';
import { DEFAULT_CONFIG } from '@/shared/settings';
import { TABLES } from './fixtures/golden-guide-envelopes';
import {
  responsesFailedEvent,
  responsesIncomplete,
  responsesOneToolCall,
  responsesReasoningThenToolCall,
  responsesTwoTextDeltas,
  responsesTwoToolCalls,
} from './fixtures/sse-lines';

/**
 * The second protocol, and the only real proof the seam fits: a seam with one
 * occupant is always the right shape.
 *
 * Every test here calls a pure function. There is not one fixture about a
 * chunk boundary in this file — CRLF, a line cut in two, a character cut in
 * two, a heartbeat, the byte cap — because those were solved once in
 * `transport.ts` and a second protocol inherits all of them. That absence is
 * the return on cutting the seam where it was cut.
 */

const { prepare, parse } = openaiResponses;

const bodyOf = (req: ModelRequest) => JSON.parse(prepare(req).http.body!) as Record<string, unknown>;

const base: ModelRequest = {
  model: 'gpt-6-astra',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'you are a guide' }] },
    { role: 'user', content: [{ type: 'text', text: 'take me to the issues' }] },
  ],
  temperature: 1,
};

const TOOL = { name: 'point', description: '指出下一步', inputSchema: { type: 'object' }, strict: true };

async function* asLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}
const deltasOf = async (lines: string[]): Promise<ModelDelta[]> => {
  const out: ModelDelta[] = [];
  for await (const d of parse(asLines(lines))) out.push(d);
  return out;
};

describe('openai-responses · 写请求', () => {
  it('路径与鉴权：/responses，头里没有密钥', () => {
    const { http } = prepare(base);
    expect(http.path).toBe('/responses');
    expect(http.method).toBe('POST');
    expect(http.auth).toBe('bearer');
    expect(http.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('对话字段叫 input，不叫 messages——而且不发 stream_options', () => {
    // 用量本来就在 `response.completed` 上，没有东西可开。这也是两张白名单不一
    // 样的原因（`architecture.spec.ts`）。
    expect(Object.keys(bodyOf({ ...base, tools: [TOOL] }))).toEqual([
      'model', 'input', 'stream', 'temperature', 'tools', 'tool_choice', 'parallel_tool_calls',
    ]);
  });

  it('工具是扁平的，不嵌在 function 下——这是与 Chat Completions 最容易踩的差别', () => {
    const [tool] = bodyOf({ ...base, tools: [TOOL] }).tools as Record<string, unknown>[];
    expect(tool).toEqual({ type: 'function', name: 'point', description: '指出下一步', parameters: { type: 'object' }, strict: true });
    // 同一份 ToolSpec，两条线上两种形状——中立类型哪一种都没选，这正是它的用处。
    const chatBody = JSON.parse(openaiChat.prepare({ ...base, tools: [TOOL] }).http.body!) as { tools: Record<string, unknown>[] };
    expect(chatBody.tools[0]).toHaveProperty('function');
    expect(tool).not.toHaveProperty('function');
  });

  it('普通消息成为 input 项：进来的是 input_text，模型说的是 output_text', () => {
    expect(bodyOf(base).input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'you are a guide' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'take me to the issues' }] },
    ]);
    const said: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: '好的' }] };
    expect(bodyOf({ ...base, messages: [said] }).input).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
    ]);
  });

  it('工具调用与它的结果是两个独立的项，靠 call_id 配对——不是 tool_call_id', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'observe', input: '{"why":"x"}' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', output: '读到了' }] },
    ];
    expect(bodyOf({ ...base, messages }).input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'observe', arguments: '{"why":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '读到了' },
    ]);
  });

  it('推理块随工具结果原样回传，排在它所属的那次调用之前', () => {
    // 回传的是端点自己发的那个 item，不是照着摘要重建一个——那等于凭空造一个
    // 续传凭证。端点也拒收「后面没有跟着它所推理的那一项」的推理块。
    const item = { type: 'reasoning', id: 'rs_abc', summary: [{ type: 'summary_text', text: '先看清这一页' }] };
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先看清这一页', providerOptions: { 'openai-responses': { item } } },
          { type: 'tool-call', toolCallId: 'call_2', toolName: 'observe', input: '{}' },
        ],
      },
    ];
    expect(bodyOf({ ...base, messages }).input).toEqual([
      item,
      { type: 'function_call', call_id: 'call_2', name: 'observe', arguments: '{}' },
    ]);
    expect(prepare({ ...base, messages }).warnings).toEqual([]);
  });

  it('推理块不是这个端点发的（没有原始 item）→ 丢掉，并且说出来', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '别处来的' },
          { type: 'tool-call', toolCallId: 'call_3', toolName: 'done', input: '{}' },
        ],
      },
    ];
    expect(prepare({ ...base, messages }).warnings).toEqual([
      { type: 'unsupported-setting', setting: 'reasoning', detail: expect.any(String) },
    ]);
    expect(bodyOf({ ...base, messages }).input).toEqual([{ type: 'function_call', call_id: 'call_3', name: 'done', arguments: '{}' }]);
  });

  it('写给别的协议的字段丢了要说，自己的那一份照发', () => {
    const req: ModelRequest = {
      ...base,
      providerOptions: { 'openai-responses': { reasoning: { effort: 'low' } }, 'openai-chat': { thinking: { type: 'disabled' } } },
    };
    expect(prepare(req).warnings).toEqual([
      { type: 'unsupported-setting', setting: 'providerOptions.openai-chat', detail: expect.any(String) },
    ]);
    expect(bodyOf(req)).toMatchObject({ reasoning: { effort: 'low' } });
    expect(bodyOf(req)).not.toHaveProperty('thinking');
  });

  it('纯函数：同一个请求调两次，两次字节相同', () => {
    expect(prepare(base).http.body).toBe(prepare(base).http.body);
  });
});

describe('openai-responses · 读回答', () => {
  it('文字 delta → text-delta，收尾一个 finish 带用量', async () => {
    expect(await deltasOf(responsesTwoTextDeltas())).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
      { type: 'finish', reason: 'completed', usage: { prompt: 10, completion: 5, total: 15, estimated: false } },
    ]);
  });

  it('工具调用：开始事件是线上明说的，不用猜哪一片带 id 和名字', async () => {
    // 这正是判别联合买到的东西：Chat Completions 没有这个事件，所以那个适配器
    // 仍要靠「第一片带 id/name」合成一个；这里原样映射。
    const deltas = await deltasOf(responsesOneToolCall());
    expect(deltas[0]).toEqual({ type: 'tool-input-start', id: 'call_1', name: 'point', index: 0 });
    const args = deltas.filter((d) => d.type === 'tool-input-delta').map((d) => (d as { delta: string }).delta).join('');
    expect(args).toBe('{"ref":"e5"}');
    // provenance：每一片都是模型自己的原文，`raw` 与 `delta` 同源。
    for (const d of deltas) if (d.type === 'tool-input-delta') expect(d.raw).toBe(d.delta);
    expect(deltas.at(-1)).toMatchObject({ usage: { prompt: 3712, cachedPrompt: 3584 } });
  });

  it('推理块整个交上来，原始 item 原封不动地带着', async () => {
    const [first] = await deltasOf(responsesReasoningThenToolCall());
    expect(first).toEqual({
      type: 'reasoning',
      text: '先看清这一页',
      providerOptions: { 'openai-responses': { item: { type: 'reasoning', id: 'rs_abc', summary: [{ type: 'summary_text', text: '先看清这一页' }] } } },
    });
  });

  it('两个调用各有自己的 output_index → 分得开', async () => {
    const deltas = await deltasOf(responsesTwoToolCalls());
    expect(deltas.filter((d) => d.type === 'tool-input-start')).toEqual([
      { type: 'tool-input-start', id: 'call_a', name: 'point', index: 0 },
      { type: 'tool-input-start', id: 'call_b', name: 'done', index: 1 },
    ]);
    const joined = (i: number) =>
      deltas.filter((d) => d.type === 'tool-input-delta' && d.index === i).map((d) => (d as { delta: string }).delta).join('');
    expect(joined(0)).toBe('{"a":1}');
    expect(joined(1)).toBe('{"b":2}');
  });

  it('HTTP 200 的流里报失败 → 抛出可识别的错误，不是空输出', async () => {
    await expect(deltasOf(responsesFailedEvent())).rejects.toMatchObject({ kind: 'contract', retryable: false });
  });

  it('答到一半没答完 → finish 说得出是因为什么停的', async () => {
    const deltas = await deltasOf(responsesIncomplete());
    expect(deltas.at(-1)).toEqual({
      type: 'finish',
      reason: 'max_output_tokens',
      usage: { prompt: 4, completion: 8, total: 12, estimated: false },
    });
  });

  it('同一份行喂两次，两次结果相同', async () => {
    expect(await deltasOf(responsesOneToolCall())).toEqual(await deltasOf(responsesOneToolCall()));
  });
});

describe('openai-responses · 它对自己的声明', () => {
  it('两项能力都成立：每次调用都有 call_id，格式本身报缓存数字', () => {
    expect(openaiResponses.capabilities).toEqual({ toolCallId: true, promptCaching: true });
  });
});

/* ═══════════ 整条链：推理块出去又回来 ═══════════ */

describe('openai-responses · 推理块走完一个来回', () => {
  const TABLE = { ...TABLES.route, snapshotId: 'snap', url: 'https://github.com/n8n-io/n8n' };
  const CTX = { goal: '带我去 issue 列表', table: TABLE, history: { done: [], route: [] } };
  const cfg = { ...DEFAULT_CONFIG, protocol: 'openai-responses' as const, apiKey: 'sk-x' };

  /** The endpoint reasons, then calls a tool — the shape that makes the item matter. */
  const reasoned = async function* (): AsyncGenerator<ModelDelta> {
    for (const d of await deltasOf(responsesReasoningThenToolCall())) yield d;
  };

  it('运行循环把它接住，连同调用 id 一起交给宿主', async () => {
    // 它和 `callId` 走同一条路：运行循环 → 结果 → 宿主的归约器 → Turn。宿主
    // 一个字节都不读它，只是替下一次请求保管着。
    const r = await runGuideToEnd(CTX, cfg, new AbortController().signal, reasoned as never);
    expect(r.callId).toBe('call_2');
    expect(r.reasoning).toMatchObject({ type: 'reasoning', providerOptions: { 'openai-responses': { item: { id: 'rs_abc' } } } });
  });

  it('下一次请求里，它原样排在那次调用前面，结果跟在后面', async () => {
    const r = await runGuideToEnd(CTX, cfg, new AbortController().signal, reasoned as never);
    const turn = {
      table: TABLE,
      rounds: [
        {
          call: { id: r.callId!, name: r.tool!, args: r.raw, ...(r.reasoning ? { reasoning: r.reasoning } : {}) },
          result: { kind: 'page' as const, table: TABLE },
        },
      ],
    };
    const messages = guideAgent.buildMessages({ ...CTX, turn }, () => 'N');
    const input = JSON.parse(openaiResponses.prepare(modelRequestFor(cfg, messages)).http.body!).input as Record<string, unknown>[];
    const types = input.map((i) => i.type ?? `message:${i.role}`);
    expect(types).toEqual(['message:system', 'message:user', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[2]).toMatchObject({ id: 'rs_abc' });
    expect(input[3]).toMatchObject({ call_id: 'call_2' });
    expect(input[4]).toMatchObject({ call_id: 'call_2' });
  });

  it('修复轮也靠 call_id 配对——这条线上就是这个字段', async () => {
    // 修复轮不是一个单独的概念：它就是普通的一轮工具结果，只是内容在说「你上
    // 次错在哪」（CONTEXT.md `Repair call`）。配对本身通用，配对的字段名不通用。
    const sent: (readonly ModelMessage[])[] = [];
    let n = 0;
    const broken = async function* (_c: unknown, m: readonly ModelMessage[]): AsyncGenerator<ModelDelta> {
      sent.push(m);
      n += 1;
      const args = n === 1 ? '{"route": [' : JSON.stringify({ previous_step: 'first_plan', route: [], why: '就是它', ref: 'e5', action: 'click', value: null, expect_after: null });
      yield { type: 'tool-input-start', id: 'call_r', name: 'point', index: 0 };
      yield { type: 'tool-input-delta', index: 0, delta: args, raw: args };
      yield { type: 'finish', usage: { prompt: 1, completion: 1, total: 2, estimated: false } };
    };
    const r = await runGuideToEnd(CTX, cfg, new AbortController().signal, broken as never);
    expect(r.failure).toBeUndefined();
    expect(r.providerCalls).toBe(2);

    const input = JSON.parse(openaiResponses.prepare(modelRequestFor(cfg, sent[1]!)).http.body!).input as Record<string, unknown>[];
    expect(input.at(-2)).toMatchObject({ type: 'function_call', call_id: 'call_r' });
    expect(input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_r' });
    // 送回去的那一半说的是具体哪里不对，不是一句「重来」。
    expect(JSON.stringify(input.at(-1))).toContain('why');
  });
});
