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
  /** Preset id, or 'custom'. Presets only prefill; every one takes the same path. */
  preset: string;
  baseURL: string;
  model: string;
  apiKey: string;
  /** P-05: the user's quota is unknowable to us, so the knob is theirs. */
  maxConcurrency: number;
}

export interface Preset {
  id: string;
  label: string;
  baseURL: string;
  models: readonly string[];
  /** Shown verbatim in the form — a preset that silently fails is worse than none. */
  note?: string;
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
    models: ['deepseek-chat'],
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
  maxConcurrency: 2,
};

export async function loadConfig(): Promise<ProviderConfig> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Partial<ProviderConfig> | undefined;
  return { ...DEFAULT_CONFIG, ...v };
}

export const saveConfig = (c: ProviderConfig): Promise<void> =>
  chrome.storage.local.set({ [KEY]: c });

/** Never render or log the key itself — not in the panel, not in an event log. */
export const maskKey = (k: string): string =>
  k.length <= 8 ? (k ? '••••' : '') : `${k.slice(0, 4)}••••${k.slice(-4)}`;
