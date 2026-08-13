import type { ProviderConfig } from '@/shared/settings';

/**
 * The only file in the extension allowed to touch the network, and the whole of
 * the provider layer for now: P-03, connection testing.
 *
 * It exists before the agent on purpose. §1.5 gates phase one on "安装 → 完成 Key
 * 配置 ≥ 35%", and a form that accepts a key without ever checking it converts
 * a wrong key into a failure ten minutes later, in the middle of a guide, where
 * it looks like the product is broken. Verification at save time is the
 * cheapest thing that protects that funnel.
 *
 * `architecture.spec.ts` asserts that no other source file makes a request, so
 * "the key only ever goes to the endpoint the user configured" is checkable
 * rather than promised.
 */
export interface TestResult {
  ok: boolean;
  /** Shown to the user verbatim, so it has to say what to do next. */
  message: string;
  /** Models the endpoint reports, when it offers a listing. */
  models?: string[];
}

const TIMEOUT_MS = 15_000;

export async function testConnection(cfg: ProviderConfig): Promise<TestResult> {
  const base = cfg.baseURL.replace(/\/+$/, '');
  if (!base) return { ok: false, message: '还没有填写端点地址。' };
  if (!cfg.apiKey && !base.includes('localhost') && !base.includes('127.0.0.1'))
    return { ok: false, message: '这个端点需要 API Key。' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // `/models` first: it is cheap, needs no token budget, and a 401 here is an
    // unambiguous "the key is wrong" rather than something the model said.
    const res = await fetch(`${base}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: ac.signal,
    });

    if (res.status === 401 || res.status === 403)
      return { ok: false, message: `Key 被拒绝（HTTP ${res.status}）。检查 Key 是否复制完整。` };
    if (!res.ok)
      return {
        ok: false,
        message: `端点返回 HTTP ${res.status}。检查地址是否为 OpenAI 兼容路径（通常以 /v1 结尾）。`,
      };

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    const hasModel = models.length === 0 || models.includes(cfg.model);
    return {
      ok: true,
      message: hasModel
        ? `连接成功${models.length ? `，端点提供 ${models.length} 个模型` : ''}。`
        : `连接成功，但端点没有列出「${cfg.model}」。可能仍然可用，也可能需要换一个。`,
      models,
    };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // The local presets fail here far more often than anywhere else, and the
    // browser reports CORS as a generic network error — so name the likely cause.
    if (base.includes('localhost') || base.includes('127.0.0.1'))
      return {
        ok: false,
        message: `连不上本地服务（${msg}）。确认服务已启动，且已允许来自扩展的跨源请求（Ollama：OLLAMA_ORIGINS=chrome-extension://*）。`,
      };
    return { ok: false, message: `连接失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
