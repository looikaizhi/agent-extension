import { describe, expect, it } from 'vitest';
import { redactUrl, sameView } from '@/shared/view';

/**
 * `LocatorView.url` is the one field of the snapshot that travels verbatim to
 * the user's model endpoint, so it gets its own tests.
 */
describe('redactUrl', () => {
  it('保留 query 与 fragment —— 它们常常是两个页面唯一的区别', () => {
    expect(redactUrl('https://github.com/a/b?tab=issues')).toBe('https://github.com/a/b?tab=issues');
    expect(redactUrl('https://console.aws.amazon.com/s3/home?region=us-east-1')).toContain('region=us-east-1');
    expect(redactUrl('https://app.example.com/dash#/settings/billing')).toBe(
      'https://app.example.com/dash#/settings/billing',
    );
  });

  it('抹掉按惯例命名的凭据参数', () => {
    expect(redactUrl('https://x.test/p?access_token=abc123')).toBe('https://x.test/p?access_token=REDACTED');
    expect(redactUrl('https://x.test/p?api_key=sk-live-9')).toBe('https://x.test/p?api_key=REDACTED');
    expect(redactUrl('https://x.test/p?q=hello&session=deadbeef')).toBe(
      'https://x.test/p?q=hello&session=REDACTED',
    );
  });

  it('剥除 userinfo —— https://github.com@evil.com 对人读作 GitHub', () => {
    expect(redactUrl('https://github.com@evil.test/p')).toBe('https://evil.test/p');
    expect(redactUrl('https://u:pw@x.test/p')).toBe('https://x.test/p');
  });

  it('不误伤仅含子串的参数，也不误伤业务语义的 code / key', () => {
    // Each of these is real page context this product depends on: a data
    // source's identity, what a diagnosis reads, and a DynamoDB console URL.
    const keep = 'https://x.test/p?stock_code=600519&error_code=429&sort_key=ts&author=alice&keyword=k';
    expect(redactUrl(keep)).toBe(keep);
  });

  it('OAuth 回调：code 与 state 同现时 code 是授权码', () => {
    expect(redactUrl('https://x.test/cb?code=grant&state=xyz')).toBe(
      'https://x.test/cb?code=REDACTED&state=xyz',
    );
    // 单独的 code 是业务编码，不动
    expect(redactUrl('https://x.test/p?code=US')).toBe('https://x.test/p?code=US');
  });

  it('SPA 路由 + fragment 令牌：路由保留，令牌抹掉', () => {
    // The earlier rule ("only rewrite a fragment that is entirely parameters")
    // let this exact shape through untouched — an id_token straight into the
    // prompt. Both halves have to survive the fix.
    expect(redactUrl('https://x.test/app#/callback?id_token=abc')).toBe(
      'https://x.test/app#/callback?id_token=REDACTED',
    );
    const route = 'https://x.test/app#/settings/billing';
    expect(redactUrl(route)).toBe(route);
  });

  it('无命中时原样返回，不做规范化重编码', () => {
    const odd = 'https://x.test/p?q=a%20b&r=%E4%B8%AD';
    expect(redactUrl(odd)).toBe(odd);
  });

  it('隐式 OAuth 把令牌放在 fragment 里，同样处理', () => {
    const out = redactUrl('https://x.test/cb#access_token=abc&token_type=bearer');
    expect(out).toContain('access_token=REDACTED');
    expect(out).not.toContain('abc');
  });

  it('不误伤只是名字里含子串的参数', () => {
    // `author` contains "auth"; `keyword` contains "key". Both must survive, or
    // the redactor would be quietly destroying ordinary page context.
    expect(redactUrl('https://x.test/p?author=alice&keyword=kubernetes')).toBe(
      'https://x.test/p?author=alice&keyword=kubernetes',
    );
  });

  it('无法解析的输入原样返回，不抛错', () => {
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl('about:blank')).toBe('about:blank');
  });
});

describe('sameView：完整 URL 去掉 fragment（CONTEXT.md 的 View）', () => {
  it('只差 fragment 是同一个视图 —— 文档站滚动会改它，而滚动不是换页', () => {
    expect(sameView('https://x.test/docs#install', 'https://x.test/docs#usage')).toBe(true);
    expect(sameView('https://x.test/docs', 'https://x.test/docs#usage')).toBe(true);
  });

  it('查询参数不同是两个视图 —— ?q=a 与 ?q=b 是两页搜索结果', () => {
    expect(sameView('https://x.test/search?q=a', 'https://x.test/search?q=b')).toBe(false);
    expect(sameView('https://x.test/issues', 'https://x.test/issues?page=2')).toBe(false);
  });

  it('路径不同是两个视图', () => {
    expect(sameView('https://x.test/repo', 'https://x.test/repo/issues')).toBe(false);
  });

  it('一边脱敏过、一边是原样 → 仍是同一个视图：元素表上的地址脱敏过，标签页的地址没有', () => {
    // 不先脱敏再比，带 `session=` 这类参数的页面上两者永远不相等，
    // 重规划的「表与标签页是不是同一页」就永远不放行。
    expect(sameView('https://x.test/p?q=a&session=deadbeef', 'https://x.test/p?q=a&session=REDACTED')).toBe(true);
  });

  it('无法解析的地址按原样比较', () => {
    expect(sameView('not a url', 'not a url')).toBe(true);
    expect(sameView('not a url', 'also not a url')).toBe(false);
  });
});
