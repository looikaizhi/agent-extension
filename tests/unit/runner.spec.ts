import { describe, expect, it } from 'vitest';
import { runGuide, runGuideToEnd, type RunEvent } from '@/agent/agents/guide/runner';
import type { ToolSpec } from '@/agent/provider/types';
import { guideAgent, type GuideContext } from '@/agent/agents/guide/agent';
import type { ModelDelta, ModelMessage } from '@/agent/provider/types';
import { ProviderError } from '@/agent/provider/transport';
import { DEFAULT_CONFIG, withVerdict } from '@/shared/settings';
import type { ExtractStats, PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { answering, finish, saying, textOf, toolCall, USAGE } from './fixtures/neutral';

/**
 * `agent/agents/guide/runner.ts` — the run loop the panel used to hold inline.
 *
 * Two things this file exists to pin down, both of which the code it replaces
 * could not express at all:
 *
 *  - `providerCalls` is a count of requests that really went out, and the
 *    host's quota is charged against it. §5.9 always said a repair call
 *    counts; until this number existed, nothing could make it true.
 *  - `failureKind` separates three failures that used to arrive as one
 *    opaque string, of which only the first is actually a failed call.
 *
 * And one property worth a test of its own: the events are decoration. A
 * caller that never reads a single one still gets the same `RunResult` —
 * otherwise the trace channel (step ③) would be load-bearing, and turning it
 * off would change what the product does.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

const table = (items: ItemSpec[]): PromptTable => ({
  snapshotId: 's1',
  url: 'https://example.test/console',
  title: 't',
  structureHash: 'h1',
  omitted: 0,
  degraded: false,
  ambiguity: 0,
  stats,
  items: items.map((i) => ({ ...i, ref: i.ref as Ref, path: i.path ?? [] })),
});

const TABLE = table([
  { ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] },
  { ref: 'e9', role: 'textbox', name: '登录密码', sensitive: true, path: ['实例操作'] },
]);

const CTX: GuideContext = { goal: '把这台实例删掉', table: TABLE, history: { done: [], route: [] } };

/** Arguments as the model writes them: no `intent` — the function name is it. */
const POINT_RAW = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e8',
  action: 'click',
  why: '点击删除实例按钮以发起删除操作',
});

/** Missing `why` — parses as JSON, fails the envelope contract. */
const UNPARSEABLE = JSON.stringify({
  route: [{ at: '控制台', goal: '删掉实例' }],
  ref: 'e8',
  action: 'click',
});

/** A well-formed envelope R-e refuses: it proposes typing into a `sensitive` field. */
const SENSITIVE_RAW = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e9',
  action: 'input',
  value: 'hunter2',
  why: '先登录',
});

/**
 * R-d, not R-e: an `action` outside the enum. This is the shape that actually
 * cost a live round — the model wrote `press_enter`, validation refused it, and
 * nothing retried, so the thread kept a plan already shown not to work.
 */
const BAD_ACTION_RAW = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e8',
  action: 'press_enter',
  why: '按回车提交',
});

/** Same shape as the real provider: content chunks, then a final usage-bearing
 *  `ModelDelta`. Nothing here streams usage twice, because nothing real does. */
const replies = (...texts: string[]) => {
  let n = 0;
  return async function* (): AsyncGenerator<ModelDelta> {
    const text = texts[Math.min(n, texts.length - 1)] ?? '';
    n += 1;
    // Split, because the endpoint splits: a runner that keeps only the first
    // fragment produces truncated JSON and looks like a model that cannot
    // write one.
    yield* answering('point', text, { pieces: 2 });
  };
};

const collect = async (complete: () => AsyncGenerator<ModelDelta>) => {
  const events: RunEvent[] = [];
  const it = runGuide(CTX, DEFAULT_CONFIG, new AbortController().signal, complete as never);
  let n = await it.next();
  while (!n.done) {
    events.push(n.value);
    n = await it.next();
  }
  return { events, result: n.value };
};

const signal = () => new AbortController().signal;

describe('guide/runner.ts · providerCalls — 配额算的是真发出去的请求', () => {
  it('1. 一次就对 → providerCalls 1', async () => {
    const { result } = await collect(replies(POINT_RAW));
    expect(result.providerCalls).toBe(1);
    expect(result.failure).toBeUndefined();
    expect(result.raw).toBe(POINT_RAW);
  });

  it('2. 走了修复轮 → providerCalls 2，raw 是修好之后那一份', async () => {
    // 修好的那一份才是解析通过的文本，溯源扫描（CONTEXT.md `Provenance`）要看的正是它。
    const { result } = await collect(replies(UNPARSEABLE, POINT_RAW));
    expect(result.providerCalls).toBe(2);
    expect(result.raw).toBe(POINT_RAW);
    expect(result.failure).toBeUndefined();
  });

  it('3. 第一次请求就抛 → providerCalls 1（请求发出去了，只是没回来）', async () => {
    async function* throwing(): AsyncGenerator<ModelDelta> {
      throw new ProviderError('端点拒绝了请求', 'auth', false);
      yield finish();
    }
    const result = await runGuideToEnd(CTX, DEFAULT_CONFIG, signal(), throwing as never);
    expect(result.providerCalls).toBe(1);
  });

  it('4. usage 跨两次请求相加，不是后一次覆盖前一次', async () => {
    const { result } = await collect(replies(UNPARSEABLE, POINT_RAW));
    expect(result.usage).toEqual({ prompt: 20, completion: 40, total: 60 });
  });
});

describe('guide/runner.ts · failureKind — 三种失败不是同一件事', () => {
  it('5. 网络/端点出错 → transport', async () => {
    async function* throwing(): AsyncGenerator<ModelDelta> {
      throw new ProviderError('连接停滞', 'timeout-stall', true);
      yield finish();
    }
    const result = await runGuideToEnd(CTX, DEFAULT_CONFIG, signal(), throwing as never);
    expect(result.failure).toMatchObject({ kind: 'transport', retryable: true });
    // 网络抖一下不是用户能在设置里改好的事。
    expect(result.failure?.fix).toBeUndefined();
  });

  it('5b. Key 被拒 → 带上去哪里改：模型配置', async () => {
    async function* throwing(): AsyncGenerator<ModelDelta> {
      throw new ProviderError('Key 被拒绝（HTTP 401）', 'auth', false);
      yield finish();
    }
    const result = await runGuideToEnd(CTX, DEFAULT_CONFIG, signal(), throwing as never);
    expect(result.failure).toMatchObject({ kind: 'transport', retryable: false, fix: 'model' });
  });

  it('6. 两次都给不出信封 → parse，且只修一次不成环', async () => {
    const { result, events } = await collect(replies(UNPARSEABLE, UNPARSEABLE));
    expect(result.providerCalls).toBe(2);
    expect(result.failure?.kind).toBe('parse');
    expect(events.filter((e) => e.kind === 'repair')).toHaveLength(1);
  });

  it('7. 信封合法但被 R-e 拒掉 → violation，不是 transport', async () => {
    // 调用成功了，模型也给出了合法形状——被拒的是内容。告诉用户「调用失败」
    // 在这里错了两次：调用没失败，而拒绝的理由恰恰最值得说。
    //
    // 两次调用：校验失败和解析失败一样买得起一次修复轮。改这条之前，违规只是
    // 被标上 `retryable: true` 然后没人消费——真机上两次违规各报废一整轮，
    // 因为归约器在被拒之后原封保留上一份已经证明走不通的计划。
    const { result } = await collect(replies(SENSITIVE_RAW, SENSITIVE_RAW));
    expect(result.providerCalls).toBe(2);
    expect(result.failure?.kind).toBe('violation');
    // 独立复核：直接问 agent 门面，同一张表同一封信，判的也是 violation。
    const parsed = guideAgent.parseOutput('point', SENSITIVE_RAW);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(guideAgent.validate(parsed.envelope, TABLE).kind).toBe('violation');
  });
});

describe('guide/runner.ts · 事件流是装饰，不承重', () => {
  it('8. 顺利的一次：request → raw → settled', async () => {
    const { events } = await collect(replies(POINT_RAW));
    expect(events.map((e) => e.kind)).toEqual(['request', 'raw', 'settled']);
  });

  it('9. 修复的一次：把两次请求和中间那次解析失败都摆出来', async () => {
    const { events } = await collect(replies(UNPARSEABLE, POINT_RAW));
    expect(events.map((e) => e.kind)).toEqual(['request', 'raw', 'parse_error', 'repair', 'raw', 'settled']);
  });

  it('9b. 校验失败也走同一条修复轮，并且真能救回来', async () => {
    // 第一抽引用了敏感元素（R-e 拒），第二抽改对了。事件流与解析失败那条
    // 一模一样，只是中间那个事件是 violation——这正是「同一条修复轮」的意思。
    const { events, result } = await collect(replies(SENSITIVE_RAW, POINT_RAW));
    expect(events.map((e) => e.kind)).toEqual(['request', 'raw', 'violation', 'repair', 'raw', 'settled']);
    expect(result.failure).toBeUndefined();
    expect(result.providerCalls).toBe(2);
  });

  it('9b-2. R-d 也救得回来：动作名不在枚举内，改一个词就对了', async () => {
    // 真机上正是这一条报废了一整轮：模型写了 `press_enter`，校验拒掉，然后
    // 没有任何东西重试。它和敏感 ref 那类不同——不是安全红线，是一个错字。
    const { events, result } = await collect(replies(BAD_ACTION_RAW, POINT_RAW));
    expect(events.map((e) => e.kind)).toEqual(['request', 'raw', 'violation', 'repair', 'raw', 'settled']);
    expect(result.failure).toBeUndefined();
    const v = events.find((e) => e.kind === 'violation');
    expect(v && 'reason' in v ? v.reason : '').toContain('press_enter');
  });

  it('9c. 修复轮恰好一次，绝不成环——第二次仍被拒就收手', async () => {
    const { events } = await collect(replies(SENSITIVE_RAW, SENSITIVE_RAW));
    expect(events.filter((e) => e.kind === 'repair')).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual(['request', 'raw', 'violation', 'repair', 'raw', 'violation']);
  });

  it('10. request 事件带的就是真发出去的 system 与 user，不是另一份重建', async () => {
    const { events } = await collect(replies(POINT_RAW));
    const req = events.find((e) => e.kind === 'request');
    const sent = guideAgent.buildMessages(CTX);
    expect(req).toBeDefined();
    if (req?.kind === 'request') {
      expect(req.system).toBe(guideAgent.instructions);
      expect(req.system).toBe(textOf(sent[0]));
      // 形状不在提示词里了，它跟着 schema 一起走。
      expect(req.tools).toBeDefined();
      // user 每次带 nonce，逐字比不了，比它非随机的那部分。
      expect(req.user).toContain('删除实例');
      expect(req.user).toContain(CTX.goal);
    }
  });

  it('11. 修复轮重发同一个请求，而不是复述形状说明', async () => {
    const { events } = await collect(replies(UNPARSEABLE, POINT_RAW));
    const req = events.find((e) => e.kind === 'request');
    const repair = events.find((e) => e.kind === 'repair');
    expect(repair).toBeDefined();
    if (req?.kind === 'request' && repair?.kind === 'repair') {
      expect(repair.system).toBe(req.system);
      expect(repair.user).toBe(req.user);
    }
    // schema 已经跟着第一次请求发出去了，所以解析失败不是"模型没懂格式"，
    // 而是这一抽漏了个字段——重抽一次，不是把格式再讲一遍。
    expect(guideAgent).not.toHaveProperty('buildRepairMessages');
  });

  it('12. 一个事件都不读，RunResult 逐字相同', async () => {
    const watched = await collect(replies(UNPARSEABLE, POINT_RAW));
    const ignored = await runGuideToEnd(CTX, DEFAULT_CONFIG, signal(), replies(UNPARSEABLE, POINT_RAW) as never);
    expect(ignored).toEqual(watched.result);
  });
});

/* ═══════════ tool calling（C）═══════════ */

/** Mimics the endpoint's tool-call stream: the name on the first fragment,
 *  then `arguments` in pieces, then a usage-only chunk. Splitting the
 *  arguments is the point — a runner that reads only the first fragment
 *  produces truncated JSON and looks like a model that cannot write one. */
let lastTools: readonly ToolSpec[] | undefined;
const toolReplies = (...calls: Array<{ name: string; args: string }>) => {
  let n = 0;
  return async function* (
    _cfg: unknown,
    _messages: unknown,
    _signal: unknown,
    options?: { tools?: readonly ToolSpec[] },
  ): AsyncGenerator<ModelDelta> {
    const call = calls[Math.min(n, calls.length - 1)]!;
    n += 1;
    lastTools = options?.tools;
    yield* answering(call.name, call.args, { pieces: 2 });
  };
};

/** The tool path never sends `intent` — the function name is the intent. */
const TOOL_ARGS = JSON.stringify({
  route: [{ at: '实例操作区域', goal: '删除这台实例' }],
  ref: 'e8',
  action: 'click',
  why: '点击删除实例按钮以发起删除操作',
});

const runTools = (complete: unknown, cfg = DEFAULT_CONFIG) => runGuideToEnd(CTX, cfg, signal(), complete as never);

describe('guide/runner.ts · tools 模式', () => {
  it('13. 工具名就是 intent——模型从不被要求写 intent 字段', async () => {
    const r = await runTools(toolReplies({ name: 'point', args: TOOL_ARGS }));
    expect(r.failure).toBeUndefined();
    // `raw` 是模型写的 arguments 原文，一字未改：溯源扫描要看的正是它，
    // 而它里面本来就没有 intent。
    expect(r.raw).toBe(TOOL_ARGS);
    expect(r.raw).not.toContain('intent');
    const parsed = guideAgent.parseOutput('point', r.raw);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(parsed.envelope.intent).toBe('point');
  });

  it('14. arguments 分片被拼起来——只读第一片会得到截断的 JSON', async () => {
    const r = await runTools(toolReplies({ name: 'point', args: TOOL_ARGS }));
    expect(r.raw.length).toBe(TOOL_ARGS.length);
    expect(() => JSON.parse(r.raw)).not.toThrow();
  });

  it('15. 送出去的就是登记的那几个工具，且没有一个向模型索取 intent', async () => {
    await runTools(toolReplies({ name: 'point', args: TOOL_ARGS }));
    const tools = lastTools as ToolSpec[];
    const point = tools.find((t) => t.name === 'point')!;
    expect(point.strict).toBe(true);
    const params = point.inputSchema as { properties: { ref: { enum: string[] } } };
    expect(params.properties.ref.enum).toEqual(['e8', 'e9']);
    // 每种信封各是一个工具，且没有任何一个向模型索取 intent。
    expect(tools.map((t) => t.name).sort()).toEqual(['ask', 'done', 'explain', 'observe', 'point', 'read_doc', 'wait_for']);
    expect(JSON.stringify(tools)).not.toContain('"intent"');
  });

  it('16. 端点没返回任何工具调用 → 记为解析失败，不是崩溃', async () => {
    async function* noTool(): AsyncGenerator<ModelDelta> {
      yield* saying('我觉得你应该点那个按钮');
    }
    const r = await runTools(noTool);
    expect(r.failure?.kind).toBe('parse');
  });

  it('17. 掉了 required 字段 → 再抽一次同样的请求，而不是复述形状说明', async () => {
    // 文本版按*形状*失败，所以 §5.9 的修复轮重述形状。工具调用不会那样失败
    // ——schema 是跟着请求一起发出去的——剩下的只是这一抽掉了个字段。
    const broken = JSON.stringify({ route: [{ at: 'x', goal: 'y' }] }); // 缺 why、ref、action
    const r = await runTools(toolReplies({ name: 'point', args: broken }, { name: 'point', args: TOOL_ARGS }));
    expect(r.providerCalls).toBe(2);
    expect(r.failure).toBeUndefined();
    expect(r.raw).toBe(TOOL_ARGS);
  });

  it('18. 引用了表外的 ref → 照旧被 R-a 拒掉；schema 收窄了可能性，没有取代校验', async () => {
    // 实测：deepseek 的 strict 让 required 从 2/16 漏降到 0/16，但 24 抽里仍有
    // 一次漏了必填数组。收窄不等于消除，R-a…R-e 在这条路上同样是防线。
    const outside = JSON.stringify({ route: [{ at: 'x', goal: 'y' }], ref: 'e999', action: 'click', why: '表里没有' });
    const r = await runTools(toolReplies({ name: 'point', args: outside }));
    expect(r.failure?.kind).toBe('violation');
  });

  it('19. 没有别的路了——文本信封那条路已经删掉', () => {
    // 自定义文本契约要求模型遵守一套只有强模型跟得住的约定；工具调用是
    // OpenAI / Anthropic / Gemini / vLLM 都原生支持的那个接口。
    expect(guideAgent).not.toHaveProperty('buildRepairMessages');
    expect(guideAgent).not.toHaveProperty('shapeGuide');
  });
});

/* ═══════════ 端点不遵守 tool_choice: 'required' 时 ═══════════ */

describe('guide/runner.ts · 端点不给工具调用时', () => {
  /** 只发文字，不发 tool_calls——`tool_choice` 被忽略时的样子。 */
  const textOnly = (...texts: string[]) => {
    let n = 0;
    return async function* (): AsyncGenerator<ModelDelta> {
      const t = texts[Math.min(n, texts.length - 1)] ?? '';
      n += 1;
      yield* saying(t);
    };
  };

  /**
   * 这里从前有一条降级：文字只要能解析成一个带 `intent` 的信封，就照样收下。
   *
   * **机制本身是好的，它的测试当时也是绿的——从没接线的是触发条件。** 解析要求
   * 信封里有 `intent` 字段，而系统提示词从头到尾没教过信封格式、也没出现过这个
   * 词：没有人告诉过模型可以这么答。165 条真机语料里，零条回答是没有工具调用
   * 来的。它是一条只在测试文件里活着的路径，删的是它，不是一段死代码。
   *
   * 换来的是更早、也更说得清的一句话：见下面「发之前就说」。代价要如实承认——
   * 在 `openai-chat` 这一个协议内部，换端点的容忍度是**下降**的。
   */
  it('20. 端点只回文字 → 说清是哪一种失败，不再试着把它读成信封', async () => {
    const r = await runTools(textOnly(JSON.stringify({ intent: 'point', ref: 'e8', action: 'click', why: '点删除' })));
    expect(r.failure?.kind).toBe('parse');
    expect(r.failure?.error).toContain('只回了一段文字');
  });

  it('21. 什么都没返回 → 与「答了但答错」分开报，不混成一句', async () => {
    const r = await runTools(textOnly(''));
    expect(r.failure?.kind).toBe('parse');
    expect(r.failure?.error).toContain('也没有返回任何文字');
  });

  it('22. 同时有文字和工具调用时，以工具调用为准', async () => {
    async function* both(): AsyncGenerator<ModelDelta> {
      // 一个块里同时有文字和工具片：扁平结构下是一个 delta，判别联合下必然是两件事。
      yield { type: 'text-delta', text: '这里是一段解释文字' };
      yield* answering('point', TOOL_ARGS, { pieces: 2 });
    }
    const r = await runTools(both);
    expect(r.raw).toBe(TOOL_ARGS);
    expect(r.raw).not.toContain('解释文字');
  });
});

/* ═══════════ 发之前就说，而不是发出去再撞死路 ═══════════ */

describe('guide/runner.ts · 端点被判定为不认强制工具调用时', () => {
  const never = () => {
    throw new Error('不该发起任何模型调用');
  };

  it('开关是「不支持」→ 一次调用都不发，给一条说得清的话', async () => {
    // 省下的不是配额（修复轮本来就不占每步 4 次的上限），是一次白烧的调用和一句
    // 读不懂的错。这条路上用户拿到的是「换一个端点」，而不是「解析失败」。
    // 判决按模型存，所以要写在这一趟真会用到的那个模型名下——写成一个全局字段
    // 的话，类型检查放行、守卫失效，这条测试就悄悄什么都不测了。
    const cfg = withVerdict(DEFAULT_CONFIG, 'unsupported');
    const r = await runGuideToEnd(CTX, cfg, signal(), never as never);
    expect(r.providerCalls).toBe(0);
    expect(r.failure).toMatchObject({ kind: 'transport', retryable: false });
    expect(r.failure?.error).toContain('忽略');
    // 换模型是用户自己能做的事：失败上带着去哪里做。
    expect(r.failure?.fix).toBe('model');
  });

  it.each(['unknown', 'supported'] as const)('开关是「%s」→ 照发，行为与今天完全一致', async (state) => {
    // 默认值必须是照发：今天所有能用的端点都没被探测过。
    const cfg = withVerdict(DEFAULT_CONFIG, state);
    const r = await runTools(toolReplies({ name: 'point', args: TOOL_ARGS }), cfg);
    expect(r.failure).toBeUndefined();
    expect(r.providerCalls).toBe(1);
  });
});

/* ═══════════ 并发工具调用：按 index 归并，而不是假设只有一个 ═══════════ */

describe('guide/runner.ts · 端点一次返回多个工具调用时', () => {
  const OTHER = JSON.stringify({ question: '别的', wants: 'text', options: [] });

  it('25. 两个调用的分片交错到达 → 各自归各自，不会被拼成一坨', async () => {
    // 只读 tool_calls[0] 的实现会把两串 arguments 串成一段非法 JSON，然后报
    // 「模型写了非法 JSON」——一个纯属自己造成的失败。
    async function* interleaved(): AsyncGenerator<ModelDelta> {
      yield { type: 'tool-input-start', name: 'point', index: 0 };
      yield { type: 'tool-input-start', name: 'ask', index: 1 };
      yield { type: 'tool-input-delta', index: 0, delta: TOOL_ARGS.slice(0, 6), raw: TOOL_ARGS.slice(0, 6) };
      yield { type: 'tool-input-delta', index: 1, delta: OTHER.slice(0, 6), raw: OTHER.slice(0, 6) };
      yield { type: 'tool-input-delta', index: 0, delta: TOOL_ARGS.slice(6), raw: TOOL_ARGS.slice(6) };
      yield { type: 'tool-input-delta', index: 1, delta: OTHER.slice(6), raw: OTHER.slice(6) };
      yield finish();
    }
    const r = await runTools(interleaved);
    expect(r.raw).toBe(TOOL_ARGS);
    expect(r.tool).toBe('point');
    expect(() => JSON.parse(r.raw)).not.toThrow();
  });

  it('26. 取的是 index 最小的那个，不是先到的那个', async () => {
    async function* reversed(): AsyncGenerator<ModelDelta> {
      yield* toolCall('ask', OTHER, { index: 1 });
      yield* toolCall('point', TOOL_ARGS, { index: 0 });
      yield finish();
    }
    const r = await runTools(reversed);
    expect(r.tool).toBe('point');
    expect(r.raw).toBe(TOOL_ARGS);
  });

  it('27. 端点不发 index → 当作 0，不崩', async () => {
    // wire schema 里 index 是可选的；不发就意味着一次只答一个。
    async function* noIndex(): AsyncGenerator<ModelDelta> {
      yield* answering('point', TOOL_ARGS);
    }
    const r = await runTools(noIndex);
    expect(r.failure).toBeUndefined();
  });
});

/* ═══════════ finish_reason：只用来解释失败，不用来判定 ═══════════ */

describe('guide/runner.ts · finish_reason', () => {
  const cut = JSON.stringify({ route: [{ at: 'x', goal: 'y' }] }); // 缺 why、ref、action

  const withFinish = (text: string, finishReason: string) =>
    async function* (): AsyncGenerator<ModelDelta> {
      yield* toolCall('point', text);
      yield finish(USAGE, finishReason);
    };

  it('28. finish_reason=length → 失败信息里说清是被截断，而不是"模型写坏了"', async () => {
    // 语料里真出现过一条 arguments 断在半个 token 上，被归档成"模型畸形输出"。
    // 端点当时很可能已经说了，只是没人听。
    const r = await runTools(withFinish(cut, 'length'));
    expect(r.failure?.kind).toBe('parse');
    expect(r.failure?.error).toContain('被截断');
  });

  it('29. 其它取值一概不提——各家口径不一，猜不如不说', async () => {
    // 有的端点对工具调用也回 stop。据此分支就是拿别人的词汇表做判断。
    for (const reason of ['stop', 'tool_calls', 'content_filter', '某个没见过的值']) {
      const r = await runTools(withFinish(cut, reason));
      expect(r.failure?.error, reason).not.toContain('被截断');
      expect(r.failure?.error, reason).toContain('why');
    }
  });

  it('30. 成功时 finish_reason 不影响任何结果', async () => {
    const r = await runTools(withFinish(TOOL_ARGS, 'length'));
    expect(r.failure).toBeUndefined();
    expect(r.raw).toBe(TOOL_ARGS);
  });
});

/* ═══════════ 定向修复：告诉模型哪里错了，而不是让它再猜一次 ═══════════ */

describe('guide/runner.ts · 修复轮的形态', () => {
  const BROKEN = JSON.stringify({ route: [{ at: 'x', goal: 'y' }] }); // 缺 why、ref、action
  let sentBatches: ModelMessage[][] = [];

  /** 带 id 的工具调用——OpenAI 的标准三段式全靠它。 */
  const withId = (id: string, ...argsList: string[]) => {
    let n = 0;
    return async function* (_c: unknown, messages: ModelMessage[]): AsyncGenerator<ModelDelta> {
      sentBatches.push(messages);
      const args = argsList[Math.min(n, argsList.length - 1)]!;
      n += 1;
      yield* answering('point', args, { id });
    };
  };

  it('31. 端点给了 id → 用标准三段式把错误告诉模型', async () => {
    sentBatches = [];
    const r = await runTools(withId('call_abc', BROKEN, TOOL_ARGS));
    expect(r.failure).toBeUndefined();
    expect(r.providerCalls).toBe(2);

    const repair = sentBatches[1]!;
    // 原来的消息一条不动地留在前面——这正是缓存能覆盖到追加处的原因。
    expect(repair.slice(0, 2)).toEqual(sentBatches[0]);
    const assistant = repair.at(-2)!;
    const tool = repair.at(-1)!;
    // 配对本身是通用的，配对的字段名不是（CONTEXT.md `Repair call`）——中立这一
    // 侧只说「这次调用」和「它的结果」，叫 tool_call_id 还是 call_id 是适配器的事。
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'call_abc', toolName: 'point', input: BROKEN });
    expect(tool.role).toBe('tool');
    expect(tool.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call_abc' });
    // 说的是具体哪里不对，不是一句"重来"。
    const back = tool.content[0]!;
    expect(back.type === 'tool-result' ? back.output : '').toContain('why');
  });

  it('32. 端点不给 id → 退回重抽同一个请求，两次消息逐字相同', async () => {
    // 没有 id 的 assistant/tool 对在 OpenAI 上是 400。宁可退回重抽，也不能把
    // 一对答不上来的消息发出去——这条降级不是可选项，是几家兼容端点的现实。
    sentBatches = [];
    const noId = (() => {
      let n = 0;
      const list = [BROKEN, TOOL_ARGS];
      return async function* (_c: unknown, messages: ModelMessage[]): AsyncGenerator<ModelDelta> {
        sentBatches.push(messages);
        const args = list[Math.min(n, list.length - 1)]!;
        n += 1;
        yield* answering('point', args);
      };
    })();
    const r = await runTools(noId);
    expect(r.failure).toBeUndefined();
    expect(r.providerCalls).toBe(2);
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]).toEqual(sentBatches[0]);
    // 而且绝没有多出 assistant/tool 那一对
    expect(sentBatches[1]!.some((m) => m.role === 'tool')).toBe(false);
  });

});
