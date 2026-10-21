import { describe, expect, it } from 'vitest';
import { toPromptText } from '@/core/extractor/project';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

const stats = {
  elementsScanned: 1, candidates: 1, visible: 1, emitted: 1, shadowRoots: 0, emptyName: 0,
  modalScoped: false, ms: { total: 1, walk: 1, visibility: 1, semantics: 1, name: 1 },
};

const withItems = (items: PromptItem[]): PromptTable => ({
  snapshotId: 's1', url: 'https://console.example.test/app', title: 't', structureHash: 'h1',
  omitted: 0, degraded: false, ambiguity: 0, stats, items,
});

describe('href 进元素表；只有名字失效时才露出一截去处', () => {
  // 跨站确认要在**跳转之前**念出目的地，所以宿主必须知道「下一步会去哪」。
  // 模型不能给（S-07：永远输出 ref，永远不输出 URL），只能由页面自己说——被
  // 抽取的那个链接元素背书它自己的地址。
  //
  // 但这个字段止步于宿主。判定权在 SW（设计文档 §8.3），模型不需要知道；而且
  // 让模型看见 URL 就是给「看见 URL 就编 URL」开口子，S-01 的敌意夹具正是防这个。
  const link: PromptItem = {
    ref: 'e1' as Ref, role: 'link', name: '打开帮助', path: [],
    href: 'https://docs.other-example.test/help',
  };

  it('1. PromptItem 能携带 href（宿主判定跨站要用）', () => {
    expect(link.href).toBe('https://docs.other-example.test/help');
  });

  it('2. toPromptText 不序列化 href —— 整段提示词里不该出现这个地址的任何片段', () => {
    const text = toPromptText(withItems([link]));
    expect(text).toContain('打开帮助'); // 名字照常给模型
    expect(text).not.toContain('docs.other-example.test');
    expect(text).not.toContain('other-example');
    expect(text).not.toContain('/help');
    expect(text).not.toContain('href');
  });

  // The line this test used to draw was `not.toContain('https://')`, and that
  // was always a proxy: what §8.2 forbids is handing the model a *menu* of
  // page-authored destinations it could pick a request target from. The
  // address the user is already standing on is not on that menu — it is a
  // fact about where they are, it is the browser's own, and no field anywhere
  // in the contract carries a URL out of the model. So the boundary is now
  // stated as what it is, rather than as a blanket ban on the substring.
  it('4. 但当前页面自己的地址是给的 —— 这条边界是「元素的 href」,不是「任何地址」', () => {
    const text = toPromptText(withItems([link]));
    expect(text.split('\n')[0]).toBe('page "console.example.test/app"');
    expect(text).not.toContain('docs.other-example.test'); // 同一段文本里,元素的 href 仍然不在
  });

  it('5. 页面地址上的查询串照给,元素的 href 上的不给', () => {
    const table = { ...withItems([link]), url: 'https://console.example.test/app?tab=logs' };
    const text = toPromptText(table);
    expect(text).toContain('page "console.example.test/app?tab=logs"');
    expect(text).not.toContain('other-example');
  });

  /**
   * 定向那一条（2026-10-01）：名字本身说不清楚时，补上去处的**最后两段路径**。
   *
   * 判据是 `nth`（同 path+role+name 不唯一）或 `nameSource`（名字不是屏幕上的字）。
   * 22 个夹具 355 条控件里这样的占 11%，repo-home 上 39 条、实测 +206 token（+6.0%）。
   * 上面那几条测试的夹具两者都没有，所以它们照旧全绿——**边界正是画在这里**。
   */
  const weak: PromptItem = {
    ref: 'e9' as Ref, role: 'link', name: '详情', path: [], nth: 2,
    href: 'https://console.example.test/instances/i-0abc123',
  };

  it('6. 名字失效的条目补一截去处 —— 两条同名链接因此分得开', () => {
    const text = toPromptText(withItems([weak]));
    expect(text).toContain('→/instances/i-0abc123');
  });

  it('7. 只给路径的最后两段，不给主机 —— §8.2 禁的是「一张可挑的目的地清单」', () => {
    const text = toPromptText(withItems([{ ...weak, href: 'https://evil.example.test/a/b/c/d' }]));
    expect(text).toContain('→/c/d');
    expect(text).not.toContain('evil.example.test');
    expect(text).not.toContain('/a/b/c/d');
  });

  it('8. 名字够用的条目照旧一个字都不给 —— 这才是省下来的那 94%', () => {
    const text = toPromptText(withItems([link]));
    expect(text).not.toContain('→');
  });

  it('9. nameSource 也算名字失效（图标按钮、拿 title 当名字的链接）', () => {
    const icon: PromptItem = {
      ref: 'e7' as Ref, role: 'link', name: 'Settings', path: [], nameSource: 'title',
      href: 'https://console.example.test/org/settings',
    };
    expect(toPromptText(withItems([icon]))).toContain('→/org/settings');
  });

  it('10. 地址解析不了、或根本没有路径段，就什么都不加（不抛）', () => {
    expect(toPromptText(withItems([{ ...weak, href: 'not a url' }]))).not.toContain('→');
    expect(toPromptText(withItems([{ ...weak, href: 'https://a.test/' }]))).not.toContain('→');
    const { href: _drop, ...noHref } = weak;
    expect(toPromptText(withItems([noHref as PromptItem]))).not.toContain('→');
  });

  it('11. 去处也过脱敏 —— 路径里带 token 的回调地址不罕见', () => {
    const cb: PromptItem = {
      ref: 'e5' as Ref, role: 'link', name: '继续', path: [], nth: 1,
      href: 'https://console.example.test/cb/ghp_abcdefghijklmnopqrstuvwxyz123456',
    };
    expect(toPromptText(withItems([cb]))).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('3. 一屏几十条链接也不会把地址漏进提示词（省 token 的那一半）', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ref: `e${i}` as Ref, role: 'link', name: `链接 ${i}`, path: [],
      href: `https://leak-${i}.example.test/x`,
    }));
    const text = toPromptText(withItems(many));
    for (let i = 0; i < 30; i++) expect(text).not.toContain(`leak-${i}`);
  });
});
