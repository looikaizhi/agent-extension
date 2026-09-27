/**
 * BYOK configuration.
 *
 * P-10 says "API Key 本地加密存储，永不出扩展". The second half is enforceable and
 * enforced; the first half is not what it sounds like, so here is the honest
 * version:
 *
 *  - **`storage.local`, never `storage.sync`.** `sync` replicates to Google's
 *    servers. Using it would put the key on someone else's disk while the UI
 *    claimed the opposite — that is the single most important line in this file.
 *  - **Encrypting it locally would be theatre.** Any key the extension can
 *    decrypt unattended is a key anyone with the profile can decrypt. Claiming
 *    "encrypted" would buy nothing and cost the reader's trust.
 *  - **What actually protects it**: extension storage is unreachable from web
 *    pages, the content script never touches storage at all (asserted in
 *    `architecture.spec.ts`), and the key is only ever sent to the endpoint the
 *    user configured.
 */

/**
 * Which wire format this endpoint speaks (CONTEXT.md `Protocol`).
 *
 * The ids live here, beside the rest of what gets stored, because this is a
 * *stored* value — what an adapter does with it is `agent/provider/protocols/`'s
 * business, and its registry is keyed by this type, so an id without an
 * adapter does not compile.
 *
 * It is a field rather than something derived from `preset`: `custom` and the
 * two local presets have no vendor to derive from, and one endpoint address
 * can serve two protocols (`api.openai.com/v1` answers both Chat Completions
 * and Responses).
 */
export type ProtocolId = 'openai-chat' | 'openai-responses';

/**
 * Whether this endpoint honours "you must call one of these tools".
 *
 * The product rests on that one parameter, and endpoints differ on it more
 * than on anything else: DeepSeek, Qwen, GLM and Gemini all speak
 * `openai-chat` and answer differently — DeepSeek 400s outright while
 * thinking is on, and Gemini documents that a parameter it does not list is
 * *silently ignored*. So this is a property of the endpoint, not of the
 * protocol, and an adapter cannot say it (CONTEXT.md `Capability`).
 *
 * Three states, not a boolean, and the default is **send anyway**. Every
 * endpoint that works today has never been probed; a boolean would read all
 * of them as "does not support it" and refuse to call any. `unknown` is "not
 * asked yet, assume it works" — the connection test is what turns it into one
 * of the other two.
 */
export type ForcedToolChoice = 'unknown' | 'supported' | 'unsupported';

export interface ProviderConfig {
  /** Preset id, or 'custom'. A preset prefills the form and may add the
   *  request fields its endpoint needs (`Preset.request`); past that, every one
   *  takes the same path. */
  preset: string;
  /** Missing in anything stored before protocols existed, which `loadConfig`
   *  fills with the default — every endpoint this product could reach then
   *  spoke `openai-chat`, so the fallback is not a guess. */
  protocol: ProtocolId;
  /**
   * What the verification call measured, **per model**: written by step 2,
   * read before every request goes out (`guide/runner.ts`). A model nobody
   * has verified is absent, which reads as `unknown` — "not asked yet, send
   * anyway", the same as it always did.
   *
   * Per model because the measurement is per model: on one endpoint
   * `gpt-6-sol` answers the forced tool call, `deepseek-reasoner` replies with
   * prose and cannot drive this product at all. Holding one verdict for the
   * whole endpoint meant the answer was thrown away every time the user tried
   * a different model — so nothing could ever be *shown* about the candidates,
   * and a model fixed once had to be fixed again on the way back.
   *
   * Kept apart from `requestByModel` rather than merged into one record per
   * model, because the two have different lifetimes: fields are *input* (the
   * user's or the button's, kept until changed), a verdict is a *measurement*
   * that gates calls and must be dropped the moment anything could change the
   * answer — a new address, a new key, another wire.
   */
  verdictByModel: Record<string, ForcedToolChoice>;
  baseURL: string;
  model: string;
  apiKey: string;
  /**
   * Extra fields this endpoint needs in the request body, **kept per model**.
   *
   * They used to be read off the preset at send time, which meant a custom
   * endpoint — an aggregator address is always one — could never have any.
   * That is the whole reason this exists: on 2026-09-25 `qwen3.8-max` on an
   * aggregator refused `tool_choice: required` with «does not support being
   * set to required or object in thinking mode» and answered normally once
   * `enable_thinking: false` came with it.
   *
   * Per model rather than per endpoint because the field is a property of the
   * model: `qwen3.8-max` needs it, `gpt-6-sol` does not. Measured on that same
   * endpoint, sending it to a model that does not need it was harmless — but
   * endpoints change, and OpenAI's own API rejects parameters it does not
   * know. Keeping them apart also means a model that was fixed once stays
   * fixed when the user comes back to it.
   */
  requestByModel: Record<string, Record<string, unknown>>;
  /**
   * Drives `budgetFor()` (`src/core/extractor/project.ts`), which sizes every
   * element table sent to the model. Clamped in `loadConfig()`, not just on
   * the form-save path, because a stored value can be corrupted or missing
   * without ever going through the form (an S0-era config, a hand-edited
   * `chrome.storage.local`).
   */
  contextWindow: number;
}

export interface Preset {
  id: string;
  label: string;
  baseURL: string;
  /** Which wire this vendor's endpoint speaks. Absent means `openai-chat`,
   *  which is what eight of these nine are. */
  protocol?: ProtocolId;
  /**
   * Names to start from, and nothing more. The endpoint's own `/models` is the
   * source once the user presses 「连接」 — a name written down here is a name
   * that can go stale, and on 2026-09-25 five of the nine below had: they were
   * models that no longer existed anywhere. These stay because a form with an
   * empty model box is worse than one with a name to replace, and because the
   * local presets answer for themselves.
   */
  models: readonly string[];
  /** Shown verbatim in the form — a preset that silently fails is worse than none. */
  note?: string;
  /** Fields this endpoint needs in every chat request beyond the OpenAI shape
   *  (`provider.ts` adds them). */
  request?: Readonly<Record<string, unknown>>;
}

/**
 * Every preset is an OpenAI-compatible endpoint (P-01), including the local
 * ones: Ollama and LM Studio both serve that shape, so "local model" needs no
 * extra component — only the CORS caveat below.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    // The one preset that is not `openai-chat`, and it has to be: the GPT-6
    // family does not support function calling on Chat Completions at all
    // («Use the Responses API for function calling»), and function calling is
    // the whole of how this product asks a question. Pointing this preset at a
    // current model on the old wire would be pointing it at a model that
    // cannot answer.
    protocol: 'openai-responses',
    // `sol` first, not `astra`: this is the first preset, so its first model is
    // what a fresh install calls. Measured through an aggregator 2026-09-25 —
    // astra's first byte lands at 13.3s / 16.2s / 16.4s across three draws,
    // which is over `transport`'s 15s connect budget; sol answers in 2-3s.
    // A reasoning model spends its thinking before the first byte, which is
    // exactly what that clock measures.
    models: ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    // Both models think by default, and thinking refuses the product's
    // `tool_choice: 'required'` outright — measured 2026-09-14: HTTP 400
    // "Thinking mode does not support this tool_choice"; with thinking
    // disabled, 200 and the tool call. Unlike the fields `provider.ts` warns
    // are silently dropped, this one is visibly honoured.
    request: { thinking: { type: 'disabled' } },
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    // `moonshot-v1-*` went offline 2026-05-25. Replaced per the vendor's own
    // model list, and corroborated 2026-09-25 against a live aggregator that
    // carries both of these names and neither of the old ones.
    models: ['kimi-k2.6', 'kimi-k2.7-code'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    // GLM-4 是上一代；5.3 于 2026-08-19 上线。同上，2026-09-25 在一个聚合端点上
    // 核过：glm-5.3 / glm-5.2 都在，glm-4-flash / glm-4-plus 都不在。
    models: ['glm-5.3', 'glm-5.2'],
  },
  {
    id: 'dashscope',
    label: '通义 / DashScope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen-max'],
    // Qwen 的思考模式和 DeepSeek 一样拒收 `tool_choice: required`，只是开关名不同。
    // 实测 2026-09-25：qwen3.8-max 带 required → 400「The tool_choice parameter
    // does not support being set to required or object in thinking mode」；加上
    // `enable_thinking: false` → 200 且调用了工具。DeepSeek 那条拼法
    // （`thinking: {type}`）在这里反而 400，两家不能共用一个字段。
    // 这个字段发给本预设的每一个模型都试过：qwen-max 带上它也照样 200。
    request: { enable_thinking: false },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    // ⚠️ 未核实。OpenRouter 用 `vendor/model` 这套命名，手上那个聚合端点 424 个
    // 模型里只有一个带斜杠的，对这一条给不出任何证据——要改得有一把 OpenRouter
    // 的 Key 去查它自己的目录。
    models: ['openai/gpt-4o-mini'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    // ⚠️ 未核实，理由同 OpenRouter：SiliconFlow 用 `Vendor/Model` 这套命名。
    // （同一个模型在别处叫 `qwen2.5-7b-instruct`，实测可用——但那不是这个端点的写法。）
    models: ['Qwen/Qwen2.5-7B-Instruct'],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    // Without this the preset's success rate is near zero and the failure looks
    // like a network error, which sends people hunting in the wrong place.
    note: 'Ollama 默认拒绝来自扩展的跨源请求。启动前设置 OLLAMA_ORIGINS=chrome-extension://* 。',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    baseURL: 'http://localhost:1234/v1',
    models: ['local-model'],
    note: '在 LM Studio 的 Local Server 面板启动服务后再测试连接。',
  },
  { id: 'custom', label: '自定义端点', baseURL: '', models: [] },
];

const KEY = 'provider';

export const DEFAULT_CONFIG: ProviderConfig = {
  preset: 'openai',
  // Read off the preset rather than written again: the two disagreeing would
  // mean a fresh install pointed at a model on a wire that cannot call it.
  protocol: PRESETS[0]!.protocol ?? 'openai-chat',
  verdictByModel: {},
  baseURL: PRESETS[0]!.baseURL,
  model: PRESETS[0]!.models[0]!,
  apiKey: '',
  requestByModel: {},
  contextWindow: 32_000,
};

/** What a preset fills in for its own models — the same fields for every model
 *  it lists, which is how they were measured (`dashscope`'s note records the
 *  second model being tried with it too). */
export const presetRequestByModel = (p: Preset): Record<string, Record<string, unknown>> =>
  p.request ? Object.fromEntries(p.models.map((m) => [m, { ...p.request }])) : {};

/** The fields that go out with a call, for the model the call names. */
export const requestFieldsFor = (cfg: ProviderConfig): Record<string, unknown> =>
  cfg.requestByModel[cfg.model] ?? {};

/** The same configuration with different fields under the current model —
 *  what a trial run needs, and what gets stored once one of them works.
 *
 *  It drops this model's verdict along the way: that verdict was measured with
 *  the *old* fields, and a measurement taken under different inputs is not a
 *  measurement of what is configured now. */
export const withRequestFields = (cfg: ProviderConfig, fields: Record<string, unknown>): ProviderConfig => {
  const { [cfg.model]: _stale, ...verdicts } = cfg.verdictByModel;
  return { ...cfg, requestByModel: { ...cfg.requestByModel, [cfg.model]: fields }, verdictByModel: verdicts };
};

/**
 * Whether this endpoint honours "you must call one of these tools" **for the
 * model that is configured**. Absent means nobody has asked, which is
 * `unknown` — and `unknown` sends (see `ForcedToolChoice`).
 */
export const verdictFor = (cfg: ProviderConfig): ForcedToolChoice => cfg.verdictByModel[cfg.model] ?? 'unknown';

/**
 * What step 2 learned, written down under the model it was learned about.
 *
 * `unknown` *removes* the entry instead of storing the word: this table means
 * "what has been measured", and nothing was. A busy endpoint (HTTP 503, seen
 * on the first live run of this) would otherwise leave a row behind that reads
 * like a finding, and the escape hatch out of a wrong verdict would file a new
 * one. `verdictFor` answers `unknown` for an absent model anyway, so the two
 * spellings never differed in behaviour — only in how honest the stored table
 * was about what it holds.
 */
export const withVerdict = (cfg: ProviderConfig, verdict: ForcedToolChoice): ProviderConfig => {
  const { [cfg.model]: _was, ...rest } = cfg.verdictByModel;
  return { ...cfg, verdictByModel: verdict === 'unknown' ? rest : { ...rest, [cfg.model]: verdict } };
};

/** Everything measured about this endpoint, forgotten — for a new address, a
 *  new key or another wire, where none of it was measured. The *fields* stay:
 *  they are what the user (or the fix button) put in, and a stale one costs one
 *  refusal that the page already knows how to walk out of. */
export const withNoVerdicts = (cfg: ProviderConfig): ProviderConfig => ({ ...cfg, verdictByModel: {} });

/** Below common local-model context windows (4k-class); anything under this
 *  is almost certainly a mistyped value, not a deliberate choice. */
const MIN_CONTEXT_WINDOW = 4_000;
/** An order of magnitude past the largest context window obtainable today —
 *  only here to catch an extra zero or two typed by mistake. `budgetFor`
 *  stops responding to this number past 64,000 anyway, so this bound is not
 *  meant to be a precise product ceiling. */
const MAX_CONTEXT_WINDOW = 2_000_000;

/** Non-numeric (missing, `NaN`, a string) gives no usable direction, so it
 *  falls back to the default rather than being clamped toward anything. A
 *  number outside the bounds is clamped to the nearer bound instead — the
 *  user did pick a direction, and clamping honors that instead of silently
 *  discarding it. */
function normalizeContextWindow(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_CONFIG.contextWindow;
  return Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, v));
}

/**
 * A configuration that predates the protocol field spoke `openai-chat` —
 * whatever endpoint it stored, that was the only wire this product had. It
 * must *not* inherit today's default, which follows the first preset and is
 * now Responses: filling it in that way would repoint somebody's working
 * DeepSeek or Ollama address at a wire it does not serve.
 *
 * A fresh install is the other case and takes the default whole: no stored
 * value at all means the preset's own protocol, which is the only one its
 * models can answer on.
 */
export async function loadConfig(): Promise<ProviderConfig> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Partial<ProviderConfig> | undefined;
  return {
    ...DEFAULT_CONFIG,
    ...v,
    ...(v ? { protocol: v.protocol ?? 'openai-chat' } : {}),
    requestByModel: normalizeRequestByModel(v?.requestByModel),
    verdictByModel: normalizeVerdicts(v?.verdictByModel),
    contextWindow: normalizeContextWindow(v?.contextWindow),
  };
}

/** Only the three words this switch has are kept. A corrupt entry would gate
 *  calls on a value nothing can interpret; dropping it reads as `unknown`,
 *  which is the honest reading — nobody measured that model. */
function normalizeVerdicts(v: unknown): Record<string, ForcedToolChoice> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const ok = (x: unknown): x is ForcedToolChoice => x === 'unknown' || x === 'supported' || x === 'unsupported';
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, ForcedToolChoice] => ok(e[1])));
}

/** Anything that is not a table of per-model objects is dropped whole, for the
 *  same reason `normalizeContextWindow` exists: this value reaches the request
 *  body, and a corrupt one (an older config, a hand-edited `storage.local`)
 *  would break every call rather than one setting. Entries that are not
 *  objects are dropped individually — the rest of the table is still good. */
function normalizeRequestByModel(v: unknown): Record<string, Record<string, unknown>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, Record<string, unknown>] => Boolean(e[1]) && typeof e[1] === 'object' && !Array.isArray(e[1]),
    ),
  );
}

export const saveConfig = (c: ProviderConfig): Promise<void> =>
  chrome.storage.local.set({ [KEY]: c });

