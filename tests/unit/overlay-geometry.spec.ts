import { describe, expect, it } from 'vitest';
import { bounds, placeCard, placePeek, veilPath } from '@/core/overlay/geometry';

/** The sub-paths of a veil: the viewport first, then one per hole. */
const parts = (d: string) => d.split(' M').length;

describe('veilPath', () => {
  it('整个视口减去每个目标一个洞', () => {
    const d = veilPath(1000, 800, [[100, 100, 50, 20], [300, 300, 40, 40]]);
    expect(d.startsWith('M0 0H1000V800H0Z')).toBe(true);
    expect(parts(d)).toBe(3);
  });

  it('洞比目标四边各宽出一圈，和描边对齐', () => {
    expect(veilPath(1000, 800, [[100, 100, 50, 20]])).toContain('M104 96H');
  });

  it('套在另一个洞里的洞、一模一样的洞都丢掉：奇偶规则会把它们重新填上', () => {
    expect(parts(veilPath(1000, 800, [[100, 100, 200, 200], [120, 120, 20, 20]]))).toBe(2);
    expect(parts(veilPath(1000, 800, [[100, 100, 50, 20], [100, 100, 50, 20]]))).toBe(2);
  });

  it('没有目标：只有整个视口', () => {
    expect(veilPath(1000, 800, [])).toBe('M0 0H1000V800H0Z');
  });
});

describe('placeCard', () => {
  const vw = 1000;
  const vh = 800;

  it('下方放得下就放在目标下面，尖角对着目标中间', () => {
    const at = placeCard([400, 100, 100, 40], vw, vh, 340, 150);
    expect(at).toMatchObject({ side: 'below', top: 158, left: 400 });
    expect(at.pointerX).toBe(50);
  });

  it('下方放不下就放在上面', () => {
    expect(placeCard([400, 700, 100, 40], vw, vh, 340, 150)).toMatchObject({ side: 'above', top: 532 });
  });

  it('贴着右边的目标：卡片收回视口里，尖角仍然指着目标', () => {
    const at = placeCard([950, 100, 40, 30], vw, vh, 340, 150);
    expect(at.left).toBe(652);
    expect(at.pointerX).toBe(318);
  });

  it('目标在视口下方：卡片留在屏上（它就是说「目标在下方」的那张），不指向任何东西', () => {
    const at = placeCard([400, 1200, 100, 40], vw, vh, 340, 150);
    expect(at).toMatchObject({ side: 'free', top: 642, pointerX: null });
  });

  it('目标在视口上方：卡片贴着顶边', () => {
    expect(placeCard([400, -300, 100, 40], vw, vh, 340, 150)).toMatchObject({ side: 'free', top: 8 });
  });

  it('没有目标：居中', () => {
    expect(placeCard(null, vw, vh, 340, 150)).toMatchObject({ side: 'free', left: 330, top: 325, pointerX: null });
  });
});

describe('placePeek', () => {
  it('在描边下面，右边和描边对齐', () => {
    expect(placePeek([360, 88, 124, 44], 1000, 800, 234, 50)).toEqual({ left: 254, top: 144 });
  });

  it('下面没地方就放到上面', () => {
    expect(placePeek([360, 760, 124, 30], 1000, 800, 234, 50).top).toBe(698);
  });
});

describe('bounds', () => {
  it('好几个候选：卡片挨着它们合起来的那一块放，一个也不挡', () => {
    expect(bounds([[520, 140, 40, 20], [520, 170, 40, 20]])).toEqual([520, 140, 40, 50]);
    expect(bounds([])).toBeNull();
  });
});
