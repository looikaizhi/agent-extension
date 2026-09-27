import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  PRESETS,
  presetRequestByModel,
  requestFieldsFor,
  saveConfig,
  verdictFor,
  withNoVerdicts,
  withVerdict,
  withRequestFields,
  type ProviderConfig,
} from '@/shared/settings';

describe('DEFAULT_CONFIG', () => {
  it('contextWindow 默认值是 32000', () => {
    expect(DEFAULT_CONFIG.contextWindow).toBe(32_000);
  });

  it('协议默认跟着第一条预设走，而不是另写一遍', () => {
    // 两处各写一遍，就会出现「gpt-6 配 Chat Completions」这种新装即坏的组合：
    // 那一代模型在旧线上根本不支持函数调用。
    expect(DEFAULT_CONFIG.protocol).toBe(PRESETS[0]!.protocol ?? 'openai-chat');
    expect(DEFAULT_CONFIG.model).toBe(PRESETS[0]!.models[0]);
  });

  it('「认不认强制工具调用」默认是「未知」——也就是照发', () => {
    // 默认值不能是「拦住」：今天所有能用的端点都没被探测过，一个布尔会把它们
    // 全部误判成不支持，为了防住一个没验证过的端点而打断每一个能用的配置。
    expect(verdictFor(DEFAULT_CONFIG)).toBe('unknown');
  });
});

/**
 * `chrome.storage.local` is unavailable under vitest's `environment: 'node'`
 * (no jsdom, no fake browser) — `loadConfig`/`saveConfig` are the only two
 * functions in this module that touch it, so a minimal in-memory stand-in
 * mirroring the real API's `{[key]: value}` record shape is the whole fixture
 * these tests need.
 */
function stubStorage(initial: Record<string, unknown> = {}): void {
  const store: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
      },
    },
  });
}

describe('loadConfig()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('完整写有 contextWindow 的配置 → 原样返回', async () => {
    const stored: ProviderConfig = {
      preset: 'custom',
      protocol: 'openai-chat',
      verdictByModel: {},
      baseURL: 'https://x.test/v1',
      model: 'm',
      apiKey: 'sk-x',
      requestByModel: {},
      contextWindow: 50_000,
    };
    stubStorage({ provider: stored });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(50_000);
  });

  it('S0/早期保存、没有 contextWindow 字段的旧配置 → 补齐为 32000，不抛错', async () => {
    // Cast past the type: this is exactly the shape an old save left behind,
    // which the type system would no longer let anyone construct on purpose.
    stubStorage({ provider: { preset: 'custom', baseURL: 'https://x.test/v1', model: 'm', apiKey: '' } });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(32_000);
  });

  it('协议字段出现之前保存的配置 → 落到 openai-chat，而不是跟着今天的默认值走', async () => {
    // 那时候这个产品只会说一种线格式，所以这是事实不是猜测。更要紧的是它**不能**
    // 继承今天的默认值：默认值现在是 Responses，照搬过去等于把别人能用的
    // DeepSeek / Ollama 地址指到一条它根本不服务的线上。
    stubStorage({ provider: { preset: 'custom', baseURL: 'https://x.test/v1', model: 'm', apiKey: '', contextWindow: 32_000 } });
    expect((await loadConfig()).protocol).toBe('openai-chat');
  });

  it('一次都没存过（新装）→ 整份默认值，协议就是那条预设自己的', async () => {
    stubStorage();
    expect((await loadConfig()).protocol).toBe(DEFAULT_CONFIG.protocol);
  });

  it('这个开关出现之前保存的配置 → 落到「未知」，照发', async () => {
    stubStorage({ provider: { preset: 'custom', baseURL: 'https://x.test/v1', model: 'm', apiKey: '', contextWindow: 32_000 } });
    expect(verdictFor(await loadConfig())).toBe('unknown');
  });

  it('contextWindow 是字符串（损坏配置）→ 回退为 32000', async () => {
    stubStorage({ provider: { preset: 'custom', baseURL: 'x', model: 'm', apiKey: '', contextWindow: 'lots' } });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(32_000);
  });

  it('contextWindow 是 NaN（损坏配置）→ 回退为 32000', async () => {
    stubStorage({ provider: { preset: 'custom', baseURL: 'x', model: 'm', apiKey: '', contextWindow: NaN } });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(32_000);
  });

  it('contextWindow 低于下限（100）→ 夹到下限 4000，不是回退到默认值', async () => {
    stubStorage({ provider: { preset: 'custom', baseURL: 'x', model: 'm', apiKey: '', contextWindow: 100 } });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(4_000);
  });

  it('contextWindow 高于上限（9999999）→ 夹到上限 2000000', async () => {
    stubStorage({ provider: { preset: 'custom', baseURL: 'x', model: 'm', apiKey: '', contextWindow: 9_999_999 } });
    const c = await loadConfig();
    expect(c.contextWindow).toBe(2_000_000);
  });

  it('saveConfig 之后再 loadConfig，合法区间内的值原样往返，不被夹也不被替换', async () => {
    stubStorage();
    const c: ProviderConfig = {
      preset: 'custom',
      protocol: 'openai-chat',
      verdictByModel: {},
      baseURL: 'https://x.test/v1',
      model: 'm',
      apiKey: 'sk-x',
      requestByModel: {},
      contextWindow: 8_000,
    };
    await saveConfig(c);
    const roundTripped = await loadConfig();
    expect(roundTripped.contextWindow).toBe(8_000);
  });
});

describe('按模型分的请求字段', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('预设把自己那套字段填给它列出的每一个模型', () => {
    // dashscope 那条注释记着：这个字段对本预设的两个模型都试过，都 200。
    const dashscope = PRESETS.find((p) => p.id === 'dashscope')!;
    expect(presetRequestByModel(dashscope)).toEqual(
      Object.fromEntries(dashscope.models.map((m) => [m, { enable_thinking: false }])),
    );
  });

  it('没有必需字段的预设什么也不填', () => {
    expect(presetRequestByModel(PRESETS.find((p) => p.id === 'openai')!)).toEqual({});
  });

  it('只把当前模型的那一套发出去', () => {
    const cfg = { ...DEFAULT_CONFIG, model: 'a', requestByModel: { a: { x: 1 }, b: { y: 2 } } };
    expect(requestFieldsFor(cfg)).toEqual({ x: 1 });
    expect(requestFieldsFor({ ...cfg, model: 'c' })).toEqual({});
  });

  it('改一个模型的字段，不碰别的模型', () => {
    const cfg = { ...DEFAULT_CONFIG, model: 'a', requestByModel: { a: { x: 1 }, b: { y: 2 } } };
    expect(withRequestFields(cfg, { z: 3 }).requestByModel).toEqual({ a: { z: 3 }, b: { y: 2 } });
  });

  it('存坏了的字段表整个丢掉，而不是让它进到请求体里', async () => {
    // 与 contextWindow 同一条理由：这个值会进请求体，坏掉的一份会让每一次调用
    // 都失败，而不是只毁掉一个设置项。
    stubStorage({ provider: { ...DEFAULT_CONFIG, requestByModel: 'nonsense' } });
    expect((await loadConfig()).requestByModel).toEqual({});
  });

  it('坏掉的是其中一条 → 只丢那一条，剩下的照样在', async () => {
    stubStorage({ provider: { ...DEFAULT_CONFIG, requestByModel: { good: { a: 1 }, bad: 7, alsoBad: [1] } } });
    expect((await loadConfig()).requestByModel).toEqual({ good: { a: 1 } });
  });
});

describe('按模型存的验收结果', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没量过的模型读作「未知」——也就是照发', () => {
    const cfg = withVerdict({ ...DEFAULT_CONFIG, model: 'a' }, 'supported');
    expect(verdictFor(cfg)).toBe('supported');
    expect(verdictFor({ ...cfg, model: 'b' })).toBe('unknown');
  });

  it('换个模型再换回来，上次量到的还在——这正是按模型存的理由', () => {
    // 以前判决是一个全局字段，换模型就被清成「未知」，于是没有任何东西可以显示
    // 给用户看，修好过的模型回来还得再修一次。
    let cfg = withVerdict({ ...DEFAULT_CONFIG, model: 'good' }, 'supported');
    cfg = withVerdict({ ...cfg, model: 'bad' }, 'unsupported');
    expect(verdictFor({ ...cfg, model: 'good' })).toBe('supported');
    expect(verdictFor({ ...cfg, model: 'bad' })).toBe('unsupported');
  });

  it('改了这个模型的请求字段 → 它的判决作废，别的模型不受影响', () => {
    // 那个判决是带着旧字段量出来的，换了输入就不再是对现在这套配置的测量。
    let cfg = withVerdict({ ...DEFAULT_CONFIG, model: 'a' }, 'supported');
    cfg = withVerdict({ ...cfg, model: 'b' }, 'supported');
    const after = withRequestFields({ ...cfg, model: 'a' }, { enable_thinking: false });
    expect(verdictFor(after)).toBe('unknown');
    expect(verdictFor({ ...after, model: 'b' })).toBe('supported');
    expect(after.requestByModel).toEqual({ a: { enable_thinking: false } });
  });

  it('全部作废：换端点 / 换 Key / 换协议时用的那一下，字段留着', () => {
    const cfg = withRequestFields(withVerdict({ ...DEFAULT_CONFIG, model: 'a' }, 'supported'), { x: 1 });
    const moved = withNoVerdicts(cfg);
    expect(moved.verdictByModel).toEqual({});
    expect(moved.requestByModel).toEqual({ a: { x: 1 } });
  });

  it('存坏了的判决整张丢掉；只坏一条就只丢那一条', async () => {
    // 这个值会拦下真实的调用，所以看不懂的词一个都不能留。
    stubStorage({ provider: { ...DEFAULT_CONFIG, verdictByModel: { a: 'supported', b: 'maybe', c: 7 } } });
    expect((await loadConfig()).verdictByModel).toEqual({ a: 'supported' });
    stubStorage({ provider: { ...DEFAULT_CONFIG, verdictByModel: 'nonsense' } });
    expect((await loadConfig()).verdictByModel).toEqual({});
  });
});

describe('那张表只装量到过的东西', () => {
  it('写「未知」等于把这一条删掉，而不是留下一个像结论的词', () => {
    // 端点忙（真机上撞到过 503）什么都没量出来；出口按钮写回「未知」也是。两种
    // 情况都不该在表里留一行看起来像发现的东西。
    const cfg = withVerdict({ ...DEFAULT_CONFIG, model: 'a' }, 'supported');
    const cleared = withVerdict(cfg, 'unknown');
    expect(cleared.verdictByModel).toEqual({});
    expect(verdictFor(cleared)).toBe('unknown');
  });

  it('删一条不碰别的', () => {
    let cfg = withVerdict({ ...DEFAULT_CONFIG, model: 'a' }, 'supported');
    cfg = withVerdict({ ...cfg, model: 'b' }, 'unsupported');
    expect(withVerdict({ ...cfg, model: 'a' }, 'unknown').verdictByModel).toEqual({ b: 'unsupported' });
  });
});
