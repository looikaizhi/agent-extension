import { describe, expect, it } from 'vitest';
import { asAppearance, DEFAULT_APPEARANCE, shadeOf } from '@/shared/appearance';

/**
 * The pure half of 外观 (CONTEXT.md `Appearance`): what a stored value reads as,
 * and what 跟随系统 paints. Painting it onto an element needs a document and is
 * proven where one exists (e2e).
 */

describe('asAppearance', () => {
  it('读回存下的风格与明暗', () => {
    expect(asAppearance({ style: 'hud', mode: 'night' })).toEqual({ style: 'hud', mode: 'night' });
  });

  it('没存过、存坏了，都读成默认——宁可看起来不一样，也不给出一个画不出来的值', () => {
    expect(asAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(asAppearance('hud')).toEqual(DEFAULT_APPEARANCE);
    expect(asAppearance({ style: 'neon', mode: 'dusk' })).toEqual(DEFAULT_APPEARANCE);
  });

  it('坏掉的只是其中一项时，另一项照旧', () => {
    expect(asAppearance({ style: 'hud', mode: 'dusk' })).toEqual({ style: 'hud', mode: DEFAULT_APPEARANCE.mode });
    expect(asAppearance({ style: 'neon', mode: 'day' })).toEqual({ style: DEFAULT_APPEARANCE.style, mode: 'day' });
  });
});

describe('shadeOf', () => {
  it('跟随系统：系统是暗的就画黑夜，否则画白天', () => {
    expect(shadeOf('system', true)).toBe('night');
    expect(shadeOf('system', false)).toBe('day');
  });

  it('选定了白天或黑夜，就不看系统', () => {
    expect(shadeOf('day', true)).toBe('day');
    expect(shadeOf('night', false)).toBe('night');
  });
});
