import { describe, expect, it } from 'vitest';
import { costOf, modelFrom, pluginsFrom, priceFrom, runIdFrom } from '../../evals/options';

/** The options `eval:task` and `eval:decision` share, read one way. */
describe('eval 命令共用的参数', () => {
  it('Plugin：不写是产品默认开的，none 是全关，没登记的报错', () => {
    expect(pluginsFrom(undefined)).toEqual(['skill']);
    expect(pluginsFrom('none')).toEqual([]);
    expect(pluginsFrom('skill')).toEqual(['skill']);
    expect(() => pluginsFrom('skill,nosuch')).toThrow(/nosuch/);
  });

  it('单价：三个非负数，每百万 token；缓存命中的输入按自己的价', () => {
    expect(priceFrom('1,0.02,4')).toEqual({ input: 1, cached: 0.02, output: 4 });
    expect(priceFrom(undefined)).toBeUndefined();
    expect(() => priceFrom('1,2')).toThrow();
    expect(() => priceFrom('1,-1,2')).toThrow();
    // (1,000,000 − 400,000)·1 + 400,000·0.02 + 100,000·4, per million.
    expect(costOf({ prompt: 1_000_000, cached: 400_000, completion: 100_000 }, { input: 1, cached: 0.02, output: 4 })).toBeCloseTo(1.008, 10);
    expect(costOf({ prompt: 1, cached: 0, completion: 1 })).toBeNull();
  });

  it('端点与模型：参数优先，其次 .env.local，最后是默认；去掉末尾的斜杠', () => {
    expect(modelFrom({}, {})).toEqual({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
    expect(modelFrom({ 'base-url': 'http://x.test/v1//', model: 'm' }, { DEEPSEEK_MODEL: 'e' })).toEqual({ baseURL: 'http://x.test/v1', model: 'm' });
    expect(modelFrom({ price: '1,0,2' }, { DEEPSEEK_BASE_URL: 'http://e.test/v1', DEEPSEEK_MODEL: 'e' })).toEqual({
      baseURL: 'http://e.test/v1',
      model: 'e',
      price: { input: 1, cached: 0, output: 2 },
    });
  });

  it('轮次 id：只能用字母、数字与 . _ -；不写就用开始时间', () => {
    expect(runIdFrom('t13-a')).toBe('t13-a');
    expect(() => runIdFrom('a b')).toThrow();
    expect(runIdFrom(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});
