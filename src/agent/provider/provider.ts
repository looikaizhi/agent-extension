import { withRequestFields, type ForcedToolChoice, type ProviderConfig } from '@/shared/settings';
import { callModel, isLocalEndpoint } from './call';
import { isThinkingRefusal, THINKING_WALL } from './advice';
import type { ModelMessage, ToolSpec } from './types';
import { describeProviderError, fetchOnce, ProviderError } from './transport';

/**
 * Connection testing (P-03), and what is left of the provider layer once a
 * wire format is somebody else's job: whether this endpoint can be called at
 * all, and whether pressing the button reaches it.
 *
 * Generating used to live here too — `complete()`, the OpenAI message shapes,
 * the SSE parser. All of it is gone: `protocols/openai-chat.ts` writes and
 * reads that wire, `transport.ts` sends, `call.ts` joins them. What remains is
 * the part that was never about a wire format.
 *
 * It exists before the agent on purpose. §1.5 gates phase one on "安装 → 完成 Key 配置 ≥ 35%", and a form that
 * accepts a key without ever checking it converts a wrong key into a failure
 * ten minutes later, in the middle of a guide, where it looks like the product
 * is broken. Verification at save time is the cheapest thing that protects
 * that funnel.
 *
 * **Two steps, and they cannot be one.** `listModels` needs only an address
 * and a key; `verifyModel` is a real call and therefore needs a model to make
 * it *with*. While the model was something the user typed from memory the two
 * could share a button — 9 preset model names were checked against a live
 * aggregator on 2026-09-25 and 5 of them no longer existed, which is what
 * typing a model name from memory is worth. Ask the endpoint first, choose,
 * then measure the one that was chosen.
 */

/** Step 1: the address answers, the key is accepted, and here is what it has. */
export interface ListResult {
  /** Whether the user can go on and pick a model. An endpoint that offers no
   *  listing is *not* a failure — plenty do not, and the model can be typed. */
  ok: boolean;
  /** Shown to the user verbatim, so it has to say what to do next. */
  message: string;
  /** Candidates, minus the families that cannot call a tool. Empty when the
   *  endpoint offers no listing. */
  models: string[];
}

/** Step 2: one real call with the model that was chosen. */
export interface VerifyResult {
  ok: boolean;
  message: string;
  /**
   * What the probe learned about this endpoint, to be stored with the rest of
   * its configuration. Absent when the probe never ran — a wrong key or an
   * unreachable address is answered before it, and guessing on its behalf is
   * how a working endpoint gets refused later.
   */
  forcedToolChoice?: ForcedToolChoice;
  /**
   * Which kind of "no" this was, when the answer was one the user can do
   * something about. `thinking` means a field can fix it and the page offers
   * the button that finds which one; `busy` means the endpoint is loaded and
   * the only thing to do is press the same button again in a minute.
   *
   * `refused` is the same offer with less certainty behind it: the model
   * turned down the forced tool call and the endpoint did not say why.
   * Measured 2026-09-25 on an aggregator — the *same* request answered
   * «does not support being set to required or object in thinking mode»
   * without `stream`, and a bare «openai_error» with it. This product always
   * streams, so on that endpoint the reason never arrives and a rule that
   * waits for the word "thinking" would never fire where it is needed.
   *
   * Absent for everything else on purpose: an unmeasured error given a
   * confident label is how somebody ends up chasing the wrong thing.
   */
  wall?: 'thinking' | 'refused' | 'busy';
}

/**
 * Names that say the model is not a chat model at all — an embedder, a
 * reranker, a voice, a picture. None of them can call a tool, so none of them
 * can drive this product, and a 424-entry list is unreadable with them in it.
 *
 * Exactly the families the endpoint's own names announce, and **no other
 * guessing**. "In `/models`" does not mean "works" — the same catalogue that
 * carried these also carried `gemini-3-pro` (503), `gemini-2.5-flash` (500)
 * and `qwen3.8-max` (400 unless `enable_thinking: false`). Those are not
 * knowable from a name; that is what step 2 measures, one model at a time.
 */
const NOT_A_CHAT_MODEL = /embedding|embed-|rerank|tts|whisper|audio|image|video|dall-e/i;

export const toolCapableModels = (ids: readonly string[]): string[] => ids.filter((id) => !NOT_A_CHAT_MODEL.test(id));

/**
 * The checks both steps share, in the order that gives the most specific
 * sentence: no address, then an unparseable one, then a missing key.
 *
 * `new URL()` here only to surface a specific "not a valid URL" message —
 * `isLocalEndpoint` does the same parse but swallows that error, which would
 * read as "端点需要 API Key" instead of the real problem.
 */
function addressProblem(cfg: ProviderConfig): string | null {
  const base = cfg.baseURL.replace(/\/+$/, '');
  if (!base) return '还没有填写端点地址。';
  try {
    new URL(base);
  } catch {
    return `端点地址不是合法 URL：${cfg.baseURL}`;
  }
  if (!cfg.apiKey && !isLocalEndpoint(base)) return '这个端点需要 API Key。';
  return null;
}

/** The local presets fail on CORS far more often than on anything else, and
 *  the browser reports that as a generic network error — so name the likely
 *  cause rather than leaving the user to guess at a blank failure. */
function reachFailure(cfg: ProviderConfig, e: unknown): string {
  const msg = describeProviderError(e);
  return isLocalEndpoint(cfg.baseURL.replace(/\/+$/, ''))
    ? `连不上本地服务（${msg}）。确认服务已启动，且已允许来自扩展的跨源请求（Ollama：OLLAMA_ORIGINS=chrome-extension://*）。`
    : msg;
}

/**
 * **Step 1.** Address plus key, and nothing else: `GET /models`.
 *
 * It is cheap, needs no token budget, and a 401 here is an unambiguous "the
 * key is wrong" rather than something a model said.
 *
 * Through `transport` like every other request this product makes. A `fetch`
 * of its own here would be a second place the key travels from, which is
 * exactly what the one-socket rule exists to prevent — and it is why the
 * non-streaming mode exists at all.
 */
export async function listModels(cfg: ProviderConfig): Promise<ListResult> {
  const problem = addressProblem(cfg);
  if (problem) return { ok: false, message: problem, models: [] };

  try {
    const res = await fetchOnce(cfg, { path: '/models', method: 'GET', auth: 'bearer' });

    if (res.status === 401 || res.status === 403)
      return { ok: false, message: `Key 被拒绝（HTTP ${res.status}）。检查 Key 是否复制完整。`, models: [] };

    // Anything else that is not a listing does not block the user: an endpoint
    // may simply not offer one, and the model name can be typed. Saying "失败"
    // here would stop somebody whose endpoint works.
    if (!res.ok)
      return {
        ok: true,
        message: `这个端点没有给出模型列表（HTTP ${res.status}）——直接手填模型名，再点「验收并保存」。地址通常以 /v1 结尾。`,
        models: [],
      };

    let ids: string[];
    try {
      const body = JSON.parse(res.body) as { data?: Array<{ id?: string }> };
      ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    } catch {
      return { ok: true, message: '这个端点的模型列表读不出来——直接手填模型名，再点「验收并保存」。', models: [] };
    }

    const models = toolCapableModels(ids);
    const hidden = ids.length - models.length;
    if (models.length === 0)
      return { ok: true, message: '连上了，但这个端点没有列出任何可用于对话的模型——手填一个模型名试试。', models: [] };
    return {
      ok: true,
      message: `连上了，这个端点有 ${models.length} 个模型可选${hidden ? `（另外 ${hidden} 个是向量 / 语音 / 图像模型，不能调用工具，已隐去）` : ''}。选一个，再点「验收并保存」。`,
      models,
    };
  } catch (e) {
    // `transport` already named what went wrong — a timeout says which clock
    // ran out, a network failure says so — so that sentence is the whole
    // message rather than a cause wrapped in a second one.
    return { ok: false, message: reachFailure(cfg, e), models: [] };
  }
}

/**
 * The tool the second step calls with.
 *
 * A toy function and "you must call one of them" — the single parameter this
 * whole product rests on, and the one endpoints disagree about most. It costs
 * a few dozen tokens and buys the answer to a question nothing else can ask:
 * `/models` says the key is good and the address is right, and says nothing
 * at all about whether the endpoint will do the one thing it is needed for —
 * nor whether *this* model will, which is why the call names one.
 */
const PROBE_TOOL: ToolSpec = {
  name: 'connection_check',
  description: '连接测试：直接调用这个函数，ok 字段随便填一个短字符串。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } },
  strict: true,
};

/**
 * **Step 2.** One real call, as small as it can be, with the chosen model.
 *
 * Three readings, three sentences, and each writes the switch (`settings.ts`):
 * a tool call means supported; text with no call means the endpoint silently
 * ignored the parameter and cannot drive this product; an HTTP error means
 * nothing was learned, so the switch stays `unknown` and the endpoint's own
 * words go to the user — usually a schema keyword it refused.
 */
export async function verifyModel(cfg: ProviderConfig): Promise<VerifyResult> {
  const problem = addressProblem(cfg);
  if (problem) return { ok: false, message: problem };
  if (!cfg.model.trim()) return { ok: false, message: '还没有选模型：先点「连接」拿到列表，或者直接手填一个。' };

  const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: '调用 connection_check 函数。' }] }];
  let calledATool = false;
  try {
    for await (const d of callModel(cfg, messages, new AbortController().signal, { tools: [PROBE_TOOL], toolChoice: 'required' })) {
      if (d.type === 'tool-input-start') calledATool = true;
    }
  } catch (e) {
    // Nothing was learned about the switch, so it stays `unknown`. The
    // endpoint's own words go through unedited either way: a refused schema
    // keyword is a sentence its author can act on, and a paraphrase of it is
    // not. What changes is what gets said *after* those words.
    const words = describeProviderError(e);

    // Loaded, not broken. Measured 2026-09-25: three of ten probes on one
    // aggregator came back «当前分组上游负载已饱和» — a user told only that
    // "验收失败" reads that as their own mistake and starts changing settings
    // that were right.
    if (e instanceof ProviderError && e.kind === 'network' && e.retryable)
      return {
        ok: false,
        forcedToolChoice: 'unknown',
        wall: 'busy',
        message: `这会儿端点忙，没测成（${words}）。这不是配置的问题——过一会儿再点一次「验收并保存」就行。`,
      };

    // The endpoint named the reason, so the sentence can be certain.
    if (isThinkingRefusal(words))
      return {
        ok: false,
        forcedToolChoice: 'unknown',
        wall: 'thinking',
        message: `${THINKING_WALL}\n端点原话：${words}`,
      };

    // It refused and did not say why — the common case on an aggregator,
    // which drops the upstream sentence on the streaming path. Offering the
    // same button here is the honest move: nothing is claimed about the
    // cause, and one press *measures* whether it was thinking after all.
    if (e instanceof ProviderError && e.kind === 'contract')
      return {
        ok: false,
        forcedToolChoice: 'unknown',
        wall: 'refused',
        message: `「${cfg.model}」拒绝了这次调用，端点只回了这一句：${words}\n最常见的原因是这个模型开着「思考模式」——点下面的按钮，我替你试着关掉它再验一次。`,
      };

    return {
      ok: false,
      forcedToolChoice: 'unknown',
      message: `这次验收调用没成功：${words}`,
    };
  }
  if (calledATool)
    return {
      ok: true,
      forcedToolChoice: 'supported',
      message: `验收通过：「${cfg.model}」认「必须调用工具」——本产品需要的就是这一条。`,
    };
  return {
    ok: false,
    forcedToolChoice: 'unsupported',
    message: `「${cfg.model}」静默忽略了「必须调用工具」，只回了文字——本产品在它上面跑不动。在这个端点上换一个模型吧。`,
  };
}

/**
 * The two ways to say "stop thinking", in the order they are tried.
 *
 * Two, because the vendors disagree and an endpoint accepts exactly one of
 * them: measured 2026-09-25, `qwen3.8-max` answers with `enable_thinking:
 * false` and refuses `thinking: {type:'disabled'}` with the very same
 * sentence; DeepSeek's own endpoint is the other way round (2026-09-14).
 * Qwen's spelling goes first because every wall measured so far was Qwen's.
 */
const THINKING_OFF: readonly Record<string, unknown>[] = [{ enable_thinking: false }, { thinking: { type: 'disabled' } }];

export interface FixResult {
  ok: boolean;
  message: string;
  /** The fields to store under this model. Present only when they worked —
   *  half-fixing a configuration is worse than not touching it. */
  fields?: Record<string, unknown>;
  forcedToolChoice?: ForcedToolChoice;
}

/**
 * The button behind「关掉思考，再试一次」: try one spelling, then the other,
 * and keep whichever the endpoint actually accepted.
 *
 * **It measures rather than guesses**, and that is the whole design. The two
 * spellings cannot be told apart from anything visible — not from the model's
 * name (`qwen3-235b-a22b-thinking-2507` never hits the wall while
 * `qwen3.7-plus` does), not from the refusal itself (both vendors word it the
 * same way), and not from the endpoint's address (an aggregator serves every
 * vendor from one). A table mapping names to fields would be wrong the first
 * time a catalogue changed; two small calls are right every time.
 *
 * It stops as soon as the wall is gone, even when what is behind it is bad
 * news — a model that answers with text has been measured, and measuring it
 * again with a different field would not change that.
 */
export async function disableThinkingAndVerify(cfg: ProviderConfig): Promise<FixResult> {
  const refusals: string[] = [];
  for (const fields of THINKING_OFF) {
    const r = await verifyModel(withRequestFields(cfg, fields));
    if (r.ok)
      return {
        ok: true,
        fields,
        forcedToolChoice: r.forcedToolChoice,
        message: `已经关掉思考（这个端点认的是 ${JSON.stringify(fields)} 这种写法），${r.message}`,
      };
    // `refused` counts as the same wall: an endpoint that drops the upstream
    // reason (measured on an aggregator's streaming path) gives exactly this
    // and nothing else, so stopping on it would stop before the second
    // spelling — the one the first refusal might have been about.
    if (r.wall !== 'thinking' && r.wall !== 'refused')
      return {
        ok: false,
        message: r.message,
        // The field is kept only when something was actually measured through
        // it. `unsupported` is a measurement; a busy endpoint or a timeout is
        // not, and storing a field that nothing has confirmed would leave the
        // configuration carrying a guess.
        ...(r.forcedToolChoice === 'unsupported' ? { fields, forcedToolChoice: r.forcedToolChoice } : {}),
      };
    refusals.push(`${JSON.stringify(fields)} → ${r.message.split('\n').pop() ?? r.message}`);
  }
  return {
    ok: false,
    message: `两种写法都试过了，这个模型还是拒绝，所以一个字段都没写进去。原因不一定是思考模式——在这个端点上换一个模型会省事得多。\n${refusals.join('\n')}`,
  };
}
