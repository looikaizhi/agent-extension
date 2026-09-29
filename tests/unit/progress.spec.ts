import { describe, expect, it } from 'vitest';
import { progressCells, stepLabels } from '@/shared/progress';

describe('stepLabels', () => {
  it('模型规划的一趟不知道总共几步：只说这是第几步', () => {
    expect(stepLabels(1, null)).toEqual({ hud: 'STEP 02', depth: '第 2 步' });
  });

  it('固定计划知道总数，两种写法都带上它', () => {
    expect(stepLabels(0, 1)).toEqual({ hud: 'STEP 01 / 01', depth: '第 1 步，共 1 步' });
    expect(stepLabels(11, 12)).toEqual({ hud: 'STEP 12 / 12', depth: '第 12 步，共 12 步' });
  });
});

describe('progressCells', () => {
  it('总数未知：做过的、这一步，末端是开着的', () => {
    expect(progressCells(1, null)).toEqual(['done', 'cur', 'more']);
    expect(progressCells(0, null)).toEqual(['cur', 'more']);
  });

  it('总数已知：剩下几步就画几格', () => {
    expect(progressCells(0, 1)).toEqual(['cur']);
    expect(progressCells(1, 4)).toEqual(['done', 'cur', 'todo', 'todo']);
  });

  it('走了很多步，只画最近几格做过的，不把每一格挤成一条缝', () => {
    expect(progressCells(9, null)).toEqual(['done', 'done', 'done', 'done', 'cur', 'more']);
  });
});
