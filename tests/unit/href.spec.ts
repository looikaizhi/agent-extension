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

describe('href 进元素表，但绝不进提示词', () => {
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

  it('3. 一屏几十条链接也不会把地址漏进提示词（省 token 的那一半）', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ref: `e${i}` as Ref, role: 'link', name: `链接 ${i}`, path: [],
      href: `https://leak-${i}.example.test/x`,
    }));
    const text = toPromptText(withItems(many));
    for (let i = 0; i < 30; i++) expect(text).not.toContain(`leak-${i}`);
  });
});
