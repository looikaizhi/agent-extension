import { describe, expect, it } from 'vitest';
import { groundFromPageLink } from '@/agent/tools/read-doc';
import type { Ref } from '@/shared/types';

const HERE = 'https://console.example.test/instances';
const ref = 'e7' as Ref;

describe('groundFromPageLink — 判定权在宿主，它自己不发任何请求', () => {
  it('1. 页面上一条干净的 http(s) 链接 → 批准，并交出已解析的绝对地址', () => {
    const d = groundFromPageLink(ref, 'https://docs.example.test/ec2/stop', HERE);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.url).toBe('https://docs.example.test/ec2/stop');
  });

  it('2. 四条结构红旗任意一条命中 → 拒绝，并说清是哪一条', () => {
    for (const [href, why] of [
      ['https://console.example.test@evil.test/d', 'userinfo'],
      ['file:///etc/passwd', 'scheme'],
      ['http://127.0.0.1/d', 'private_network'],
      ['https://xn--pple-43d.com/d', 'homograph'],
    ] as const) {
      const d = groundFromPageLink(ref, href, HERE);
      expect(d.ok, href).toBe(false);
      if (!d.ok) expect(d.reason, href).toBe(why);
    }
  });

  it('3. 地址根本解析不出来 → 拒绝，而不是把一个没验证过的字符串交给抓取', () => {
    const d = groundFromPageLink(ref, 'not a url at all', HERE);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('unresolvable');
  });

  it('4. 页面上没有这条链接（模型给的 ref 已经失效）→ 拒绝，不抛错', () => {
    // 页面结构可能在模型给出 via_ref 之后、宿主真正解析之前就变了（§5.3 的
    // 一般规律）。找不到就如实说找不到。
    const d = groundFromPageLink(ref, undefined, HERE);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('unresolvable');
  });

  it('5. 决定本身不含任何网络行为——同一输入两次调用产出完全相同的结果', () => {
    const a = groundFromPageLink(ref, 'https://docs.example.test/x', HERE);
    const b = groundFromPageLink(ref, 'https://docs.example.test/x', HERE);
    expect(a).toEqual(b);
  });
});
