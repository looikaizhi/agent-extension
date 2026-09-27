import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableThinkingAndVerify, listModels, toolCapableModels, verifyModel } from '@/agent/provider/provider';
import { THINKING_WALL } from '@/agent/provider/advice';
import type { ProviderConfig } from '@/shared/settings';

/**
 * What is left of `provider.ts` once a wire format is somebody else's job:
 * can this endpoint be called at all, and does pressing the button reach it.
 *
 * Two steps now, and the split is the point. Step 1 needs an address and a
 * key; step 2 is a real call and therefore needs a model to make it *with* —
 * so it cannot run until one has been chosen. Each test below asserts which
 * requests its step sends, because "how many sockets did that button open" is
 * the one thing a merged version got to be vague about.
 *
 * Everything else this file used to hold moved out with the thing it tested —
 * the three clocks and the byte cap to `transport.spec.ts`, reading an SSE
 * line to `openai-chat.spec.ts`, and the guard that refuses to send a page to
 * an unconfigured endpoint to `call-model.spec.ts`. None of it was deleted;
 * all of it is asserted one layer closer to what it is about.
 */

const enc = new TextEncoder();

/** An endpoint that answers the two steps separately, the way a real one does. */
function endpoint({
  models = 200,
  ids = ['test-model'],
  listBody,
  probe,
}: {
  models?: number;
  ids?: string[];
  listBody?: string;
  probe?: { status?: number; lines?: string[]; body?: string };
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return new Response(listBody ?? JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: models });
    }
    const status = probe?.status ?? 200;
    const body = probe?.body ?? (probe?.lines ?? []).map((l) => `${l}\n\n`).join('');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(body));
          c.close();
        },
      }),
      { status },
    );
  });
}

const CALLED_A_TOOL = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"connection_check","arguments":"{\\"ok\\":\\"y\\"}"}}]}}]}',
  'data: [DONE]',
];
const ONLY_TEXT = ['data: {"choices":[{"delta":{"content":"当然可以，你想做什么？"}}]}', 'data: [DONE]'];

const REMOTE: ProviderConfig = {
  preset: 'custom',
  protocol: 'openai-chat',
  verdictByModel: {},
  baseURL: 'https://x.test/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  requestByModel: {},
  contextWindow: 32_000,
};

const urls = (f: ReturnType<typeof endpoint>) => f.mock.calls.map((c) => String(c[0]));

describe('listModels() —— 第 1 步：只要地址和 Key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('只发一次 /models，不发真调用——这一步还没有模型可用来发', async () => {
    const fetchImpl = endpoint({ ids: ['a', 'b'] });
    vi.stubGlobal('fetch', fetchImpl);
    const r = await listModels(REMOTE);
    expect(urls(fetchImpl)).toEqual(['https://x.test/v1/models']);
    expect(r).toMatchObject({ ok: true, models: ['a', 'b'] });
    expect(r.message).toContain('2 个模型');
  });

  it('没有工具调用的那一类不进候选，并说清隐去了几个', async () => {
    // 同一份目录里混着向量 / 语音 / 图像模型——它们一个都驱动不了本产品，而一份
    // 几百条的列表带着它们就没法看。数目要说出来，否则用户会以为名字丢了。
    vi.stubGlobal('fetch', endpoint({ ids: ['gpt-6-sol', 'text-embedding-3-small', 'tts-1', 'gpt-image-1', 'bge-reranker-v2'] }));
    const r = await listModels(REMOTE);
    expect(r.models).toEqual(['gpt-6-sol']);
    expect(r.message).toContain('4 个');
  });

  it('端点没有 /models → 不报错也不拦着，改为手填', async () => {
    // 有的端点根本不提供列表。把它说成「连接失败」会拦下一个其实能用的端点。
    const fetchImpl = endpoint({ models: 404 });
    vi.stubGlobal('fetch', fetchImpl);
    const r = await listModels(REMOTE);
    expect(r).toMatchObject({ ok: true, models: [] });
    expect(r.message).toContain('手填');
  });

  it('列表读不出来 → 同样退回手填', async () => {
    vi.stubGlobal('fetch', endpoint({ listBody: '<html>not json</html>' }));
    const r = await listModels(REMOTE);
    expect(r).toMatchObject({ ok: true, models: [] });
    expect(r.message).toContain('手填');
  });

  it('Key 被拒 → 这一步就答完了，说的是 Key 而不是模型', async () => {
    const fetchImpl = endpoint({ models: 401 });
    vi.stubGlobal('fetch', fetchImpl);
    const r = await listModels(REMOTE);
    expect(r).toMatchObject({ ok: false, models: [] });
    expect(r.message).toContain('Key 被拒绝');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('verifyModel() —— 第 2 步：对着选定的那一个模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('只发一次真调用，一个玩具函数 + 必须调用工具；不再去要一次列表', async () => {
    const fetchImpl = endpoint({ probe: { lines: CALLED_A_TOOL } });
    vi.stubGlobal('fetch', fetchImpl);
    await verifyModel(REMOTE);
    expect(urls(fetchImpl)).toEqual(['https://x.test/v1/chat/completions']);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.tool_choice).toBe('required');
    expect(JSON.stringify(body.tools)).toContain('connection_check');
  });

  it('回来是工具调用 → 开关写「支持」，话里带上是哪个模型过的', async () => {
    vi.stubGlobal('fetch', endpoint({ probe: { lines: CALLED_A_TOOL } }));
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: true, forcedToolChoice: 'supported' });
    expect(r.message).toContain('test-model');
  });

  it('回来只有文字 → 开关写「不支持」，并当场说清在它上面跑不动', async () => {
    // 这正是整条流程的理由：把静默降级提前到他按下按钮的那一刻，而不是等引导跑
    // 到一半时撞上。
    vi.stubGlobal('fetch', endpoint({ probe: { lines: ONLY_TEXT } }));
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: false, forcedToolChoice: 'unsupported' });
    expect(r.message).toContain('静默忽略');
    expect(r.message).toContain('跑不动');
  });

  it('验收调用 400 → 留在「未知」，端点的报错原样给用户看', async () => {
    // 多半是某个 schema 关键字被拒。原话里有那个关键字，转述之后就没有了。
    vi.stubGlobal('fetch', endpoint({ probe: { status: 400, body: JSON.stringify({ error: { message: "unsupported keyword: 'strict'" } }) } }));
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: false, forcedToolChoice: 'unknown' });
    expect(r.message).toContain("unsupported keyword: 'strict'");
  });

  it('还没选模型 → 一趟都不发，也不写开关', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyModel({ ...REMOTE, model: '  ' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.forcedToolChoice).toBeUndefined();
  });
});

describe('toolCapableModels() —— 只筛掉名字自己说明白的那一类', () => {
  it('向量 / 重排 / 语音 / 图像 / 视频筛掉，对话模型一个不动', () => {
    expect(
      toolCapableModels([
        'gpt-6-sol',
        'deepseek-flash',
        'qwen-vl-max',
        'text-embedding-3-large',
        'bge-reranker-v2-m3',
        'tts-1-hd',
        'whisper-1',
        'gpt-4o-audio-preview',
        'dall-e-3',
        'gpt-image-1',
        'sora-video-2',
      ]),
    ).toEqual(['gpt-6-sol', 'deepseek-flash', 'qwen-vl-max']);
  });

  it('不做别的猜测：列表里跑不动的那些，名字上看不出来', () => {
    // 2026-09-25 实测：这三个都在 `/models` 里，一个 503、一个 500、一个 400
    // （除非加 `enable_thinking: false`）。名字里没有任何线索——所以这里不筛，
    // 交给第 2 步那次真调用去量。
    expect(toolCapableModels(['gemini-3-pro', 'gemini-2.5-flash', 'qwen3.8-max'])).toEqual([
      'gemini-3-pro',
      'gemini-2.5-flash',
      'qwen3.8-max',
    ]);
  });
});

describe('两步共用的地址与 Key 检查', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cfgFor = (baseURL: string, apiKey = ''): ProviderConfig => ({
    preset: 'custom',
    protocol: 'openai-chat',
    verdictByModel: {},
    baseURL,
    model: 'test-model',
    apiKey,
    requestByModel: {},
    contextWindow: 32_000,
  });

  it('my-localhost-proxy.example.com 无 Key → 两步都被拒（不再被 .includes("localhost") 误判为本地）', async () => {
    // If the bug is still present, the buggy short-circuit skips the key
    // check and falls through to a real fetch. Asserting on message *content*
    // alone would be fragile (a mock error message that happens to contain
    // the right substring passes vacuously) — the decisive, independent proof
    // is that `fetch` is never called at all when the key check should have
    // rejected first.
    const fetchMock = vi.fn(async () => {
      throw new Error('network should never be reached in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
    const cfg = cfgFor('https://my-localhost-proxy.example.com/v1');
    // Literal string copied from the existing, unchanged source line — not
    // derived by running the code.
    expect(await listModels(cfg)).toEqual({ ok: false, message: '这个端点需要 API Key。', models: [] });
    expect(await verifyModel(cfg)).toEqual({ ok: false, message: '这个端点需要 API Key。' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('真 127.0.0.1 无 Key → 放行；能不能跑仍然由那次真调用说了算', async () => {
    vi.stubGlobal('fetch', endpoint({ probe: { lines: CALLED_A_TOOL } }));
    const cfg = cfgFor('http://127.0.0.1:11434/v1');
    expect(await listModels(cfg)).toMatchObject({ ok: true });
    expect(await verifyModel(cfg)).toMatchObject({ ok: true, forcedToolChoice: 'supported' });
  });

  it('连不上本地服务 → 第 1 步点出 CORS 这个最常见的原因', async () => {
    // 浏览器把 CORS 报成一个笼统的网络错误，不说破就会让人去查防火墙。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const r = await listModels(cfgFor('http://localhost:11434/v1'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('OLLAMA_ORIGINS');
  });

  it('baseURL 不是合法 URL → 给出可读的错，不抛异常', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // `await` alone is the "does not throw" proof: a rejected/thrown promise
    // here would fail the test before reaching the assertions below.
    const r = await listModels(cfgFor('not a url', 'sk-anything'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
  });
});

/** 一个按顺序给出不同回答的端点——「先撞墙，换个写法再试」就是这么发生的。 */
function endpointSeq(answers: Array<{ status?: number; body?: string; lines?: string[] }>) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    const body = a.body ?? (a.lines ?? []).map((l) => `${l}\n\n`).join('');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(body));
          c.close();
        },
      }),
      { status: a.status ?? 200 },
    );
  });
}

/** 通义与 DeepSeek 拒绝的原话不一样，但都带着 thinking 这个词——判据就是它。 */
const THINKING_WALL_400 = {
  status: 400,
  body: JSON.stringify({
    error: { message: 'The tool_choice parameter does not support being set to required or object in thinking mode' },
  }),
};
const BUSY_429 = { status: 429, body: JSON.stringify({ error: { message: '当前分组上游负载已饱和，请稍后再试' } }) };
const sentFields = (f: ReturnType<typeof endpointSeq>) =>
  f.mock.calls
    .filter((c) => !String(c[0]).endsWith('/models'))
    .map((c) => {
      const {
        model: _m,
        messages: _s,
        tools: _t,
        tool_choice: _tc,
        temperature: _tp,
        stream: _st,
        stream_options: _so,
        parallel_tool_calls: _p,
        ...rest
      } = JSON.parse(String(c[1]!.body)) as Record<string, unknown>;
      return rest;
    });

describe('verifyModel() —— 三种「不行」，三句不同的话', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('思考模式那堵墙：先说人话，再附上端点原话', async () => {
    // 用户不知道 thinking 是什么。只把这句英文扔给他，等于没说。
    vi.stubGlobal('fetch', endpointSeq([THINKING_WALL_400]));
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: false, wall: 'thinking', forcedToolChoice: 'unknown' });
    expect(r.message).toContain('思考模式');
    expect(r.message).toContain('does not support being set to required');
  });

  it('端点忙（429）：说清这不是配置的问题，也不写开关', async () => {
    // 2026-09-25 实测：十次探测里三次是这个。只说「验收失败」会让人去改本来
    // 就对的设置。
    vi.stubGlobal('fetch', endpointSeq([BUSY_429]));
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: false, wall: 'busy', forcedToolChoice: 'unknown' });
    expect(r.message).toContain('不是配置的问题');
  });

  it('别的 400：原话照给，但不咬定是思考模式', async () => {
    // 没量过的原因配上一句自信的解释，就是让人去追错方向。这一条的出口仍然给
    // ——按一下就试出来了——但话里说的是「最常见的原因是」，不是「就是」。
    vi.stubGlobal('fetch', endpointSeq([{ status: 400, body: JSON.stringify({ error: { message: "unsupported keyword: 'strict'" } }) }]));
    const r = await verifyModel(REMOTE);
    expect(r.wall).toBe('refused');
    expect(r.message).toContain("unsupported keyword: 'strict'");
    expect(r.message).not.toContain(THINKING_WALL);
  });
});

describe('disableThinkingAndVerify() —— 不猜是哪种写法，试出来', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('第一种写法就通了 → 只发一次，把这一套留下，并说清用的是哪一种', async () => {
    const f = endpointSeq([{ lines: CALLED_A_TOOL }]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r).toMatchObject({ ok: true, fields: { enable_thinking: false }, forcedToolChoice: 'supported' });
    expect(sentFields(f)).toEqual([{ enable_thinking: false }]);
    expect(r.message).toContain('enable_thinking');
  });

  it('第一种被拒、第二种通了 → 两次真调用，留下的是第二种', async () => {
    // 两种拼法互发都会 400（2026-09-25 在同一个端点上量到），所以只能试。
    const f = endpointSeq([THINKING_WALL_400, { lines: CALLED_A_TOOL }]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({ thinking: { type: 'disabled' } });
    expect(sentFields(f)).toEqual([{ enable_thinking: false }, { thinking: { type: 'disabled' } }]);
  });

  it('两种都撞墙 → 一个字段都不写，两次原话都带回来', async () => {
    const f = endpointSeq([THINKING_WALL_400]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r.ok).toBe(false);
    expect(r.fields).toBeUndefined();
    expect(r.message).toContain('一个字段都没写');
    expect(sentFields(f)).toHaveLength(2);
  });

  it('墙过去了，但这个模型只回文字 → 停在这里，字段与判决一起留下', async () => {
    // 这是量出来的结论，不是半路上的噪音：留下字段，才配得上那个「不支持」。
    const f = endpointSeq([{ lines: ONLY_TEXT }]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r).toMatchObject({ ok: false, forcedToolChoice: 'unsupported', fields: { enable_thinking: false } });
    expect(sentFields(f)).toHaveLength(1);
  });

  it('墙过去了，但端点忙 → 什么都没量出来，就什么都不写', async () => {
    const f = endpointSeq([BUSY_429]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r.ok).toBe(false);
    expect(r.fields).toBeUndefined();
    expect(r.forcedToolChoice).toBeUndefined();
  });
});

describe('verifyModel() —— 端点把原因吞掉的时候', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('400 但没说为什么 → 照样把出口给用户，只是话说得有分寸', async () => {
    // 2026-09-25 实测：同一个请求，stream=false 时端点回的是「…required or
    // object in thinking mode」，stream=true 时只回「openai_error」。产品永远
    // 走流式，所以「原话里有没有 thinking」这条判据在这种端点上一次都不会命中。
    vi.stubGlobal(
      'fetch',
      endpointSeq([{ status: 400, body: JSON.stringify({ error: { message: 'openai_error', type: 'bad_response_status_code' } }) }]),
    );
    const r = await verifyModel(REMOTE);
    expect(r).toMatchObject({ ok: false, wall: 'refused' });
    expect(r.message).toContain('openai_error');
    expect(r.message).toContain('最常见的原因');
  });

  it('这种「不知道为什么」的拒绝，按钮照样会试到第二种写法', async () => {
    const f = endpointSeq([
      { status: 400, body: JSON.stringify({ error: { message: 'openai_error' } }) },
      { lines: CALLED_A_TOOL },
    ]);
    vi.stubGlobal('fetch', f);
    const r = await disableThinkingAndVerify(REMOTE);
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({ thinking: { type: 'disabled' } });
    expect(sentFields(f)).toEqual([{ enable_thinking: false }, { thinking: { type: 'disabled' } }]);
  });

  it('Key 被拒不是这堵墙：不给按钮，也不劝他关思考', async () => {
    vi.stubGlobal('fetch', endpointSeq([{ status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) }]));
    const r = await verifyModel(REMOTE);
    expect(r.wall).toBeUndefined();
  });
});
