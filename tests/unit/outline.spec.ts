import { describe, expect, it } from 'vitest';
import type { PromptItem } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { buildOutline } from '@/shared/outline';
import { makeRef } from '@/shared/types';

/**
 * How the elements behind an `explain` answer, or the options of an `ask`,
 * become one framing on the page. The painting itself goes through
 * background.ts (WXT's `defineBackground` global, not a pure module) and is
 * proven in e2e instead.
 */

const item = (over: Partial<PromptItem> = {}): PromptItem => ({
  ref: makeRef(0, 1),
  role: 'button',
  name: 'Create instance',
  path: ['Instances'],
  ...over,
});

describe('buildOutline（问答引用 → GuideStep）', () => {
  it('refs.length === 0 → 不构造任何 HIGHLIGHT 命令', () => {
    expect(buildOutline([], '标题')).toBeNull();
  });

  it('refs.length === 1 → 设置 ref，不设置 alsoRefs', () => {
    const step = buildOutline([item({ ref: makeRef(0, 7) })], '这是什么');
    expect(step?.ref).toBe(makeRef(0, 7));
    expect(step?.alsoRefs).toBeUndefined();
  });

  it('refs.length > 1 → 不设置 ref，alsoRefs 等于完整的 refs', () => {
    const items = [item({ ref: makeRef(0, 1) }), item({ ref: makeRef(0, 2), name: 'Stop' })];
    const step = buildOutline(items, '两个候选');
    expect(step?.ref).toBeUndefined();
    expect(step?.alsoRefs).toEqual([makeRef(0, 1), makeRef(0, 2)]);
  });

  it("expectedUserAction 恒为 'observe'", () => {
    const single = buildOutline([item()], 't');
    const multi = buildOutline([item({ ref: makeRef(0, 1) }), item({ ref: makeRef(0, 2) })], 't');
    expect(single?.expectedUserAction).toBe('observe');
    expect(multi?.expectedUserAction).toBe('observe');
  });

  it('descriptor 与直接调用 descriptorOf 对同一个 PromptItem 的结果一致', () => {
    const it1 = item({ ref: makeRef(0, 9), name: 'Password policy', path: ['Security', 'Access'] });
    const step = buildOutline([it1], 't');
    expect(step?.descriptor).toEqual(descriptorOf(it1));
  });
});
