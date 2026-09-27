import { describe, expect, it } from 'vitest';
import { frameOf, mergeTables, sourceFor } from '@/core/extractor/merge';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * 一页里嵌着别的文档时，几份表怎么变成一份。
 *
 * 这一层只管拼接与记账：每一份表在它自己的文档里已经裁过预算，跨文档再裁一次
 * 要重新推 `path`、`nth` 与歧义度，而那几样从来没有共享过一棵 DOM。
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

const table = (over: Partial<PromptTable> = {}): PromptTable => ({
  snapshotId: 's-top', url: 'https://x.test/console', title: '控制台', structureHash: 'h',
  items: [{ ref: 'e1' as Ref, role: 'link', name: '实例', path: [] }],
  omitted: 0, degraded: false, ambiguity: 0, stats, ...over,
});

const billing = (over: Partial<PromptTable> = {}): PromptTable =>
  table({
    snapshotId: 's-frame3', url: 'https://pay.test/widget', title: '账单',
    items: [{ ref: 'f3e1' as Ref, role: 'button', name: '去付款', path: [] }],
    ...over,
  });

describe('mergeTables —— 几份文档拼成一张表', () => {
  it('没有框架时原样返回，连 sources 都不加', () => {
    const top = table();
    expect(mergeTables(top, [])).toBe(top);
  });

  it('框架里的控件接在后面，ref 天然不撞车', () => {
    const merged = mergeTables(table(), [{ frameId: 3, url: 'https://pay.test/widget', table: billing() }]);
    expect(merged.items.map((i) => i.ref)).toEqual(['e1', 'f3e1']);
  });

  it('表的身份仍然是顶层那一页的——三个框架也还是一页', () => {
    const merged = mergeTables(table(), [{ frameId: 3, url: 'https://pay.test/widget', table: billing() }]);
    expect(merged.snapshotId).toBe('s-top');
    expect(merged.url).toBe('https://x.test/console');
  });

  it('每一份文档当时的快照与地址记进 sources——命令要靠它送回对的地方', () => {
    const merged = mergeTables(table(), [{ frameId: 3, url: 'https://pay.test/widget', table: billing() }]);
    expect(merged.sources).toEqual([
      { frameId: 0, snapshotId: 's-top', url: 'https://x.test/console' },
      { frameId: 3, snapshotId: 's-frame3', url: 'https://pay.test/widget' },
    ]);
  });

  it('切掉的条数相加：模型读到的那个数得是「这一页你没看到多少」', () => {
    const merged = mergeTables(table({ omitted: 12 }), [
      { frameId: 3, url: 'https://pay.test/widget', table: billing({ omitted: 5 }) },
    ]);
    expect(merged.omitted).toBe(17);
  });

  it('任何一份读残了，整张就是残的', () => {
    const merged = mergeTables(table({ degraded: false }), [
      { frameId: 3, url: 'https://pay.test/widget', table: billing({ degraded: true }) },
    ]);
    expect(merged.degraded).toBe(true);
  });

  it('歧义度按条数加权——两条的框架不该把三百条的页面拽走', () => {
    const top = table({ ambiguity: 0, items: Array.from({ length: 99 }, (_, i) => ({ ref: `e${i}` as Ref, role: 'link', name: `l${i}`, path: [] })) });
    const merged = mergeTables(top, [{ frameId: 3, url: 'https://pay.test/widget', table: billing({ ambiguity: 1 }) }]);
    expect(merged.ambiguity).toBeCloseTo(0.01, 5);
  });
});

describe('mergeTables —— 读进来的框架不再算「洞」', () => {
  const notes = [{ label: '账单组件', host: 'pay.test' }, { label: '广告', host: 'ads.test' }];

  it('进去过的那个从 frames 里去掉，没进去的留着', () => {
    const merged = mergeTables(table({ frames: notes }), [
      { frameId: 3, url: 'https://pay.test/widget', table: billing() },
    ]);
    expect(merged.frames).toEqual([{ label: '广告', host: 'ads.test' }]);
  });

  it('同一个域名有两个框架、只进去一个 → 只去掉一条', () => {
    // 宁可多报一个洞，也不能少报：少报一个，「表里没有」就又会被读成
    // 「页面上没有」——这正是这条功能要治的病。
    const two = [{ label: 'A', host: 'pay.test' }, { label: 'B', host: 'pay.test' }];
    const merged = mergeTables(table({ frames: two }), [
      { frameId: 3, url: 'https://pay.test/a', table: billing() },
    ]);
    expect(merged.frames).toHaveLength(1);
  });

  it('一个洞都没有时不去动它', () => {
    expect(mergeTables(table({ frames: [] }), [{ frameId: 3, url: 'https://pay.test/w', table: billing() }]).frames).toEqual([]);
  });
});

describe('frameOf / sourceFor —— 一个 ref 该送回哪个文档', () => {
  it('e12 是顶层，f3e12 是 3 号框架', () => {
    expect(frameOf('e12')).toBe(0);
    expect(frameOf('f3e12')).toBe(3);
    expect(frameOf('f12e7')).toBe(12);
  });

  it('单文档的表：顶层的 ref 拿得到它自己的快照与地址', () => {
    expect(sourceFor(table(), 'e1')).toEqual({ frameId: 0, snapshotId: 's-top', url: 'https://x.test/console' });
  });

  it('单文档的表被问到框架里的 ref → null，绝不冒充顶层', () => {
    // 冒充顶层就是拿一个文档的 ref 去对另一个文档的快照，画出来的框会指错东西。
    expect(sourceFor(table(), 'f3e1')).toBeNull();
  });

  it('合过的表：各自的 ref 各自归位', () => {
    const merged = mergeTables(table(), [{ frameId: 3, url: 'https://pay.test/widget', table: billing() }]);
    expect(sourceFor(merged, 'e1')?.snapshotId).toBe('s-top');
    expect(sourceFor(merged, 'f3e1')).toEqual({ frameId: 3, snapshotId: 's-frame3', url: 'https://pay.test/widget' });
    expect(sourceFor(merged, 'f9e1')).toBeNull();
  });
});
