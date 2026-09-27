import { describe, expect, it } from 'vitest';
import { sameHost, structuralRedFlags } from '@/core/security/link-safety';

describe('sameHost — 精确 hostname 比对，不猜"是不是同一家"', () => {
  it('1. 完全相同的 hostname → true', () => {
    expect(sameHost('https://github.com/n8n-io/n8n', 'https://github.com/search?q=n8n')).toBe(true);
  });

  it('2. 子域名不同 → false，不因为「同一家公司」而豁免', () => {
    // 故意的收紧：宁可对同一家公司内部的子域名跳转也弹一次确认，也不去猜
    // 「这两个 host 是不是同一主体」——那道题正是 P-1 被推迟的理由。
    expect(sameHost('https://console.aws.amazon.com/ec2', 'https://docs.aws.amazon.com/ec2')).toBe(false);
  });

  it('3. 端口与协议不参与判定，只看 hostname', () => {
    expect(sameHost('http://example.test:8080/a', 'https://example.test/b')).toBe(true);
  });

  it('4. 大小写不敏感（hostname 本就大小写不敏感）', () => {
    expect(sameHost('https://GitHub.com/a', 'https://github.com/b')).toBe(true);
  });

  it('5. 任一侧解析不出 host → false，宁可多问一次也不要默默放行', () => {
    expect(sameHost('about:blank', 'https://github.com/')).toBe(false);
    expect(sameHost('https://github.com/', '')).toBe(false);
  });

  it('6. 不剥子域名、不查注册域：这两条断言一旦有人加了 eTLD+1 就会红', () => {
    expect(sameHost('https://a.example.co.uk/', 'https://b.example.co.uk/')).toBe(false);
    expect(sameHost('https://pages.github.io/', 'https://user.github.io/')).toBe(false);
  });
});

describe('structuralRedFlags — V-1…V-4，抓取与跳转共用同一份判据', () => {
  const flag = (raw: string) => {
    try {
      return structuralRedFlags(new URL(raw));
    } catch {
      return 'unparseable';
    }
  };

  it('V-2. URL 里内嵌了 userinfo → 拦下', () => {
    // `https://console.example.test@evil.test/` 读起来像官方站，实际去的是
    // evil.test。这是最古老也最有效的一种伪装。
    expect(flag('https://console.example.test@evil.test/docs')).toBe('userinfo');
    expect(flag('https://user:pw@evil.test/docs')).toBe('userinfo');
  });

  it('V-3. 非 http(s) 协议 → 拦下', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.test/x', 'data:text/html,<b>x'])
      expect(flag(u), u).toBe('scheme');
  });

  it('V-4. 私网与环回地址 → 拦下', () => {
    for (const u of [
      'http://127.0.0.1/docs',
      'http://localhost/docs',
      'http://10.1.2.3/docs',
      'http://192.168.1.1/docs',
      'http://172.16.0.1/docs',
      'http://[::1]/docs',
    ])
      expect(flag(u), u).toBe('private_network');
  });

  it('V-1. 同形异义：主机名里混入非 ASCII 或 punycode → 拦下', () => {
    // `аpple.com`（西里尔 а）与 `apple.com` 在屏幕上几乎无法分辨。我们不判断
    // 「它想冒充谁」——那是 P-1 被推迟的那道题——只说「这个主机名不是纯 ASCII，
    // 我读不准」。
    expect(flag('https://xn--pple-43d.com/docs')).toBe('homograph');
    expect(flag('https://аpple.com/docs')).toBe('homograph');
  });

  it('干净的同站与跨站 http(s) 地址 → 没有红旗', () => {
    expect(flag('https://console.example.test/docs')).toBeNull();
    expect(flag('https://docs.other.test/help')).toBeNull();
  });
});
