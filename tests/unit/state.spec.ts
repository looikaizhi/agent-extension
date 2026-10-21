import { describe, expect, it } from 'vitest';
import { resolveState } from '@/core/extractor/semantics';

/**
 * 控件状态：哪些跟着每一次抽取一起发给模型，哪些只在诊断时才发。
 *
 * 这一组以前整个关在 `profile !== 'interactive'` 后面，而产品从头到尾只用 `'interactive'`
 * （`background.ts` 的两处 EXTRACT），所以除了 `disabled` 之外**一条都没到过模型手里**，
 * 而且既没有测试也没有一个夹具用过 `aria-expanded`——两边同时为空，谁都发现不了。
 *
 * 用一个最小的假元素，不用 DOM：`resolveState` 只碰 `getAttribute` 和四个属性。
 * 单元层是 node 环境（`vitest.config.ts`），真实 DOM 上的行为由 e2e 兜。
 */

type Fake = { attrs?: Record<string, string>; disabled?: boolean; checked?: boolean; readOnly?: boolean; required?: boolean };

const el = (f: Fake = {}) =>
  ({
    getAttribute: (n: string) => f.attrs?.[n] ?? null,
    disabled: f.disabled,
    checked: f.checked,
    readOnly: f.readOnly,
    required: f.required,
  }) as unknown as Element;

const at = (f: Fake) => resolveState(el(f), 'interactive') ?? [];

describe('控件状态 — 引导每一步都要看的那一组', () => {
  it('1. 什么都没有时不发空数组，发 undefined', () => {
    expect(resolveState(el(), 'interactive')).toBeUndefined();
  });

  it('2. disabled：属性与 aria 两种写法都认', () => {
    expect(at({ disabled: true })).toEqual(['disabled']);
    expect(at({ attrs: { 'aria-disabled': 'true' } })).toEqual(['disabled']);
  });

  /**
   * 这一条是整组里最值钱的：实测里有一趟引导把同一个按钮点了五次，
   * 而它要的控件就在那个按钮展开的面板里。`collapsed` 就是那句「里面还有东西」。
   */
  it('3. expanded / collapsed：展开与收起都说，因为「里面还有东西」和「已经开着了」都会改变下一步', () => {
    expect(at({ attrs: { 'aria-expanded': 'true' } })).toEqual(['expanded']);
    expect(at({ attrs: { 'aria-expanded': 'false' } })).toEqual(['collapsed']);
  });

  it('4. checked / mixed：已经打开的开关不该被再指一次', () => {
    expect(at({ attrs: { 'aria-checked': 'true' } })).toEqual(['checked']);
    expect(at({ checked: true })).toEqual(['checked']);
    expect(at({ attrs: { 'aria-checked': 'mixed' } })).toEqual(['mixed']);
    expect(at({ attrs: { 'aria-checked': 'false' } })).toEqual([]);
  });

  it('5. selected / current：已经选中的标签页、已经在的那一页，指了也白指', () => {
    expect(at({ attrs: { 'aria-selected': 'true' } })).toEqual(['selected']);
    expect(at({ attrs: { 'aria-current': 'page' } })).toEqual(['current']);
    expect(at({ attrs: { 'aria-current': 'false' } })).toEqual([]);
    expect(at({ attrs: { 'aria-selected': 'false' } })).toEqual([]);
  });

  it('6. readonly：和 disabled 同一种失败——指着它让用户填，填不进去', () => {
    expect(at({ readOnly: true })).toEqual(['readonly']);
    expect(at({ attrs: { 'aria-readonly': 'true' } })).toEqual(['readonly']);
  });

  /**
   * 这三条说的是「这个表单域本身怎么样」，不是「该不该指这一个控件」。
   * 前者是填表时的细节，后者才是引导每一步要答的问题——所以留在诊断档里。
   */
  it('7. required / invalid / busy 留在 +context，不进每一次抽取', () => {
    const gated: Fake[] = [{ required: true }, { attrs: { 'aria-invalid': 'true' } }, { attrs: { 'aria-busy': 'true' } }];
    for (const f of gated)
      expect(resolveState(el(f), 'interactive')).toBeUndefined();

    expect(resolveState(el({ required: true }), '+context')).toEqual(['required']);
    expect(resolveState(el({ attrs: { 'aria-invalid': 'spelling' } }), '+context')).toEqual(['invalid']);
    expect(resolveState(el({ attrs: { 'aria-busy': 'true' } }), '+context')).toEqual(['busy']);
  });

  it('8. 只发真值：每一条「默认」写法都不出现在结果里', () => {
    expect(
      at({
        attrs: {
          'aria-disabled': 'false',
          'aria-checked': 'false',
          'aria-selected': 'false',
          'aria-current': 'false',
          'aria-readonly': 'false',
        },
        disabled: false,
        checked: false,
        readOnly: false,
      }),
    ).toEqual([]);
  });

  it('9. 多个状态按固定顺序出现 —— 渲染出来的字节要稳定，快照才有意义', () => {
    expect(at({ disabled: true, attrs: { 'aria-expanded': 'false', 'aria-selected': 'true' } })).toEqual([
      'disabled',
      'collapsed',
      'selected',
    ]);
  });
});
