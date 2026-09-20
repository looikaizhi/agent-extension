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

export interface ProviderConfig {
  /** Preset id, or 'custom'. A preset prefills the form and may add the
   *  request fields its endpoint needs (`Preset.request`); past that, every one
   *  takes the same path. */
  preset: string;
  baseURL: string;
  model: string;
  apiKey: string;
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
    models: ['gpt-4o-mini', 'gpt-4o'],
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
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
  },
  {
    id: 'dashscope',
    label: '通义 / DashScope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
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
  baseURL: PRESETS[0]!.baseURL,
  model: PRESETS[0]!.models[0]!,
  apiKey: '',
  contextWindow: 32_000,
};

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

export async function loadConfig(): Promise<ProviderConfig> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Partial<ProviderConfig> | undefined;
  return { ...DEFAULT_CONFIG, ...v, contextWindow: normalizeContextWindow(v?.contextWindow) };
}

export const saveConfig = (c: ProviderConfig): Promise<void> =>
  chrome.storage.local.set({ [KEY]: c });

