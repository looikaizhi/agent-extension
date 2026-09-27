import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenterDom, Probe } from '@/core/overlay/dom';
import { createPresenter, type PresenterPorts } from '@/core/overlay/presenter';
import type { OverlayStatus, StepView } from '@/core/overlay/overlay';
import type { TrackerSink } from '@/core/overlay/tracker';
import type { ContentEvent, GuideStep, HighlightCommand, SessionId } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/**
 * `core/overlay/presenter.ts` — CONTEXT.md's `Presentation` on the page side.
 *
 * Everything the presenter decides runs here against a fake page: which
 * element `bind` finds is set by the test, the tracker's and the activation
 * listener's callbacks are captured so the test can fire them, and the page's
 * own clock — its animation frames and its idle moments — is the test's to
 * run. The real primitives (`core/overlay/dom.ts`) are proven in e2e.
 *
 * Nothing here runs on a timer (ticket 06b): every test ends by checking that
 * the presenter left none behind.
 *
 * The look count below is read off `bind`: a step that carries no live handle
 * is rebound on every render, so each look at the page is one call.
 */

/** The page every command below is drawn from, unless a test moves it. */
const REPO = 'https://x.test/repo';

function page() {
  const events: ContentEvent[] = [];
  const painted: OverlayStatus[] = [];
  const target = { id: 'target' } as unknown as Element;
  let found: Element | null = null;
  let looks = 0;
  let scrolls = 0;
  let sink: TrackerSink | null = null;
  let activate: (() => void) | null = null;
  let commit: (() => void) | null = null;
  /** Where the tab is now. */
  let at = REPO;
  /** A snapshot the fast path can still resolve, when a test gives one. */
  let fresh: { snapshotId: string; el: Element } | null = null;
  const mutationListeners = new Set<() => void>();
  let idle: (() => void)[] = [];
  let frames: (() => void)[] = [];
  /** What the target looks like to an actionability probe, frame by frame. */
  let probe: Probe = { visible: true, enabled: true, rect: [0, 0, 10, 10] };
  let covered = false;

  const queue = (list: 'idle' | 'frames', fn: () => void) => {
    if (list === 'idle') idle.push(fn);
    else frames.push(fn);
    return () => {
      if (list === 'idle') idle = idle.filter((f) => f !== fn);
      else frames = frames.filter((f) => f !== fn);
    };
  };

  const dom: PresenterDom = {
    view: () => at,
    // Steps here carry a ref from an old snapshot, so unless a test hands one
    // over the fast path never resolves and every render falls through to `bind`.
    resolve: (snapshotId) => (fresh && fresh.snapshotId === snapshotId ? fresh.el : null),
    scrollTo: () => void (scrolls += 1),
    rectOf: () => [0, 0, 10, 10],
    probe: () => probe,
    track: (_el, _also, s) => {
      sink = s;
      return { detach: () => void (sink === s && (sink = null)) };
    },
    onActivate: (_el, fn) => {
      activate = fn;
      return () => void (activate === fn && (activate = null));
    },
    onCommit: (_el, fn) => {
      commit = fn;
      return () => void (commit === fn && (commit = null));
    },
    onMutation: (fn) => {
      mutationListeners.add(fn);
      return () => void mutationListeners.delete(fn);
    },
    whenIdle: (fn) => queue('idle', fn),
    nextFrame: (fn) => queue('frames', fn),
  };

  const views: StepView[] = [];
  const ports: PresenterPorts = {
    overlay: () => ({ setStep: (v) => void views.push(v), paint: (_rects, status) => void painted.push(status), isOccluded: () => covered }),
    bind: () => {
      looks += 1;
      return found ? { el: found, also: [], refs: ['e1' as Ref] } : { el: null, also: [], refs: [] };
    },
    isSensitive: () => false,
    emit: (e) => void events.push(e),
    dom,
  };

  return {
    presenter: createPresenter(ports),
    events,
    painted,
    views,
    target,
    looks: () => looks,
    scrolls: () => scrolls,
    appear: () => void (found = target),
    vanish: () => void (found = null),
    /** The user activates whatever target the activation listener is on. */
    use: () => activate?.(),
    /** The user finishes typing into whatever target the commit listener is on. */
    type: () => commit?.(),
    /** The tracker reports the element it follows gone. */
    lose: () => sink?.onLost('removed'),
    /** The tab goes to another address — a same-document navigation, say. */
    goTo: (url: string) => void (at = url),
    /** The snapshot `snapshotId` is the current one, and its ref names `target`. */
    snapshot: (snapshotId: string) => void (fresh = { snapshotId, el: target }),
    /** The DOM changes; every observer hears it. */
    mutate: () => mutationListeners.forEach((fn) => fn()),
    /** The main thread goes idle: whatever was waiting for that runs. */
    runIdle: () => {
      const due = idle;
      idle = [];
      due.forEach((fn) => fn());
    },
    /** One animation frame passes. */
    frame: () => {
      const due = frames;
      frames = [];
      due.forEach((fn) => fn());
    },
    pendingIdle: () => idle.length,
    pendingFrames: () => frames.length,
    /** The target as the next actionability probe will read it. */
    setProbe: (next: Partial<Probe>) => void (probe = { ...probe, ...next }),
    setCovered: (c: boolean) => void (covered = c),
  };
}

const command = (
  title: string,
  presentationId: string,
  ref: string,
  {
    autoScroll = false,
    action = 'click' as GuideStep['expectedUserAction'],
    mode = 'guide' as HighlightCommand['mode'],
  } = {},
): HighlightCommand =>
  ({
    sessionId: 'tab-1' as SessionId,
    presentationId,
    snapshotId: 'old-snapshot',
    view: REPO,
    mode,
    step: { title, ref: ref as Ref, descriptor: { role: 'link', name: title }, expectedUserAction: action } as GuideStep,
    progress: { index: 0, total: 1 },
    autoScroll,
    skippable: false,
  }) as HighlightCommand;

const ofType = (events: ContentEvent[], type: ContentEvent['type']) => events.filter((e) => e.type === type);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  // No guess about how long anything takes: whatever a test left running,
  // it is not a timer.
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('presenter · 换一次呈现，旧的那一份一起作废', () => {
  it('T1. 用户用过目标、目标随之消失 → 画「正在看新页面」，一直留到宿主画下一步；不报目标消失', async () => {
    // 从前这里有一个 5 秒的宽限：到点就改画「找不到」并报 TARGET_LOST。下一步
    // 什么时候来，由模型和宿主决定，不是这里猜的。
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.use();
    p.lose();
    expect(p.painted.at(-1)).toBe('settling');
    expect(ofType(p.events, 'TARGET_LOST')).toEqual([]);
  });

  it('T6. 新呈现画成「找不到」之后，点旧呈现的目标不再报 STEP_USED——做的不是这一步', async () => {
    // 画成「找不到」不经过挂接跟踪器那条路，旧目标上的点击监听于是还挂着；
    // 用户点它，报上去的却是新那一步——一步没做的事被记成做成了。
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();

    p.vanish();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    const before = p.events.length;
    p.use();

    expect(ofType(p.events.slice(before), 'STEP_USED')).toEqual([]);
    p.presenter.teardown();
  });

  it('T7. 新呈现画成「找不到」之后，旧呈现的跟踪器不再报 TARGET_LOST', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));

    p.vanish();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    const before = p.events.length;
    p.lose();

    expect(ofType(p.events.slice(before), 'TARGET_LOST')).toEqual([]);
    p.presenter.teardown();
  });
});

describe('presenter · 找不到目标：当场交给模型，页面变了接着找（06b）', () => {
  it('N1. 画成「找不到」→ 当场报一次 TARGET_NOT_FOUND，带上是哪一次呈现；不等任何计时', async () => {
    const p = page();
    const res = await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    expect(res).toMatchObject({ ok: true, data: { failure: 'ref_not_found' } });
    expect(ofType(p.events, 'TARGET_NOT_FOUND')).toEqual([{ type: 'TARGET_NOT_FOUND', sessionId: 'tab-1', presentationId: 'tab-1#2' }]);
    expect(p.looks()).toBe(1);
    p.presenter.teardown();
  });

  it('N2. 之后页面变了，等主线程空下来再找一次；目标出现了 → 画上、报 TARGET_FOUND，不再找', async () => {
    const p = page();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    p.mutate();
    expect(p.looks()).toBe(1); // 页面变的那一刻不找：页面多半还在变
    p.appear();
    p.runIdle();
    expect(p.looks()).toBe(2);
    expect(p.presenter.target).toBe(p.target);
    expect(ofType(p.events, 'TARGET_FOUND')).toHaveLength(1);

    p.mutate();
    expect(p.pendingIdle()).toBe(0);
    p.presenter.teardown();
  });

  it('N3. 页面一直在变、目标一直不在 → 一次空闲只找一次，「没找到」也只报过那一次', async () => {
    const p = page();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    for (let i = 0; i < 5; i++) {
      p.mutate();
      p.mutate();
      p.mutate();
      p.runIdle();
    }
    expect(p.looks()).toBe(1 + 5);
    expect(ofType(p.events, 'TARGET_NOT_FOUND')).toHaveLength(1);
    p.presenter.teardown();
  });

  it('N4. 同一次呈现被重画、目标仍然不在 → 不再报第二次', async () => {
    const p = page();
    await p.presenter.show(command('A', 'tab-1#1', 'e1'));
    await p.presenter.show(command('A', 'tab-1#1', 'e1'));
    p.presenter.retry();
    expect(ofType(p.events, 'TARGET_NOT_FOUND')).toHaveLength(1);
    p.presenter.teardown();
  });

  it('N5. 换了呈现 → 旧呈现不再找；新呈现报它自己的一次', async () => {
    const p = page();
    await p.presenter.show(command('A', 'tab-1#1', 'e1'));
    await p.presenter.show(command('B', 'tab-1#2', 'e2'));
    expect(ofType(p.events, 'TARGET_NOT_FOUND').map((e) => (e as { presentationId: string }).presentationId)).toEqual(['tab-1#1', 'tab-1#2']);

    p.mutate();
    p.runIdle();
    // One look per change, for the presentation on screen — not one for each.
    expect(p.looks()).toBe(3);
    p.presenter.teardown();
  });

  it('N6. 还在找目标时页面换了视图 → 不再找', async () => {
    // 那一步属于换走之前的那一页；页面换了视图，结构监听器自会报一条读数。
    const p = page();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.goTo('https://x.test/elsewhere');
    p.mutate();
    p.runIdle();
    const before = p.looks();
    p.mutate();
    p.runIdle();

    expect(p.looks()).toBe(before);
    expect(ofType(p.events, 'TARGET_NOT_FOUND')).toHaveLength(1);
  });

  it('N8. 结束之后，下一趟同号的呈现照样报——呈现身份每一趟从头编号', async () => {
    const p = page();
    await p.presenter.show(command('A', 'tab-1#1', 'e1'));
    p.presenter.teardown();
    await p.presenter.show(command('B', 'tab-1#1', 'e2'));
    expect(ofType(p.events, 'TARGET_NOT_FOUND')).toHaveLength(2);
    p.presenter.teardown();
  });

  it('N9. 看得出正在不在找、找了几次（供 e2e 失败时留下现场）', async () => {
    const p = page();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    expect(p.presenter.watch).toEqual({ watching: true, looks: 0 });
    p.mutate();
    p.runIdle();
    p.mutate();
    p.runIdle();
    expect(p.presenter.watch).toEqual({ watching: true, looks: 2 });
    p.appear();
    p.mutate();
    p.runIdle();
    expect(p.presenter.watch).toEqual({ watching: false, looks: 3 });
    p.presenter.teardown();
  });

  it('N7. 结束了 → 页面再变也不找', async () => {
    const p = page();
    await p.presenter.show(command('A', 'tab-1#1', 'e1'));
    p.presenter.teardown();
    p.mutate();
    expect(p.pendingIdle()).toBe(0);
  });
});

describe('presenter · 可操作性：画上之后看两帧，点不了就报一条读数（06b）', () => {
  it('A1. 两帧都可见、启用、没被挡、位置不变 → 不报', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([]);
    expect(p.pendingFrames()).toBe(0);
    p.presenter.teardown();
  });

  it.each([
    ['禁用', { enabled: false }, false, 'disabled'],
    ['被别的内容挡住', {}, true, 'covered'],
  ] as const)('A2. %s → 报 STEP_NOT_ACTIONABLE，带上原因和是哪一次呈现', async (_name, probe, covered, why) => {
    const p = page();
    p.appear();
    p.setProbe(probe);
    p.setCovered(covered);
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([]); // 一帧还说不了
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([{ type: 'STEP_NOT_ACTIONABLE', sessionId: 'tab-1', presentationId: 'tab-1#1', why }]);
    p.presenter.teardown();
  });

  it('A3. 连续两帧位置不同 → 还在动', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.setProbe({ rect: [0, 40, 10, 10] });
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([{ type: 'STEP_NOT_ACTIONABLE', sessionId: 'tab-1', presentationId: 'tab-1#1', why: 'moving' }]);
    p.presenter.teardown();
  });

  it('A4. 看不见 → 不在这里报：那是目标消失，跟踪器会报', async () => {
    const p = page();
    p.appear();
    p.setProbe({ visible: false });
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([]);
    p.presenter.teardown();
  });

  it('A5. 不重试：一次呈现只判一次，同一次呈现重画也不再判', async () => {
    const p = page();
    p.appear();
    p.setProbe({ enabled: false });
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toHaveLength(1);
    expect(p.pendingFrames()).toBe(0);
    p.presenter.teardown();
  });

  it('A6. 还没看完两帧就换了呈现 → 旧的那次判定作废，不以新那一步的名义说话', async () => {
    const p = page();
    p.appear();
    p.setProbe({ enabled: false });
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.vanish();
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toEqual([]);
    p.presenter.teardown();
  });

  it('A7. 页面变了之后才找到的目标 → 画上之后同样判一次', async () => {
    const p = page();
    p.setProbe({ enabled: false });
    await p.presenter.show(command('New issue', 'tab-1#2', 'e9'));
    p.appear();
    p.mutate();
    p.runIdle();
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toHaveLength(1);
    p.presenter.teardown();
  });

  it('A10. 结束之后，下一趟同号的呈现照样判', async () => {
    const p = page();
    p.appear();
    p.setProbe({ enabled: false });
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.frame();
    p.frame();
    p.presenter.teardown();
    await p.presenter.show(command('Other', 'tab-1#1', 'e2'));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toHaveLength(2);
    p.presenter.teardown();
  });

  it('A9. 要用户去操作的一步（guide）判；回答的依据（explain）不判——那不是要用户去点的', async () => {
    const p = page();
    p.appear();
    p.setProbe({ enabled: false });
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1', { mode: 'guide' }));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toHaveLength(1);

    p.snapshot('old-snapshot');
    await p.presenter.show(command('Issues', 'tab-1#1:explain', 'e1', { mode: 'explain' }));
    p.frame();
    p.frame();
    expect(ofType(p.events, 'STEP_NOT_ACTIONABLE')).toHaveLength(1);
    p.presenter.teardown();
  });

  it('A8. 要滚动时当场滚到位，不等滚动结束——免得自己的滚动被判成「还在动」', async () => {
    const p = page();
    p.appear();
    const res = await p.presenter.show(command('Issues', 'tab-1#1', 'e1', { autoScroll: true }));
    expect(p.scrolls()).toBe(1);
    expect(res.ok && res.data.resolved).toBe('e1');
    p.presenter.teardown();
  });
});

describe('presenter · 用户用了这一步的目标，就报一条读数', () => {
  it('U1. 点了要点的目标 → 报「点了」，带上它属于哪一次呈现', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.use();
    expect(ofType(p.events, 'STEP_USED')).toEqual([{ type: 'STEP_USED', sessionId: 'tab-1', presentationId: 'tab-1#1', how: 'clicked' }]);
    p.presenter.teardown();
  });

  it('U2. 要填的目标，填完了（change）→ 报「填了」；点进去不算', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('搜索', 'tab-1#1', 'e1', { action: 'input' }));
    p.use();
    expect(ofType(p.events, 'STEP_USED')).toEqual([]);
    p.type();
    expect(ofType(p.events, 'STEP_USED')).toEqual([{ type: 'STEP_USED', sessionId: 'tab-1', presentationId: 'tab-1#1', how: 'typed' }]);
    p.presenter.teardown();
  });
});

describe('presenter · 卡片上的步号', () => {
  it('固定计划的一步：第几步、一共几步；模型的一步：只有第几步', async () => {
    const p = page();
    p.appear();
    await p.presenter.show({ ...command('A', 'tab-1#1', 'e1'), progress: { index: 1, total: 3 } });
    await p.presenter.show({ ...command('B', 'tab-1#2', 'e2'), progress: { index: 4, total: null } });
    expect(p.views.map((v) => v.progress)).toEqual([{ index: 1, total: 3 }, { index: 4, total: null }]);
    p.presenter.teardown();
  });

  it('回答的依据不是哪一趟的第几步：卡片上不带步号', async () => {
    const p = page();
    p.snapshot('old-snapshot');
    const { progress: _none, ...outline } = command('依据', 'tab-1#1:explain', 'e1', { mode: 'explain' });
    await p.presenter.show(outline);
    expect(p.views.at(-1)).not.toHaveProperty('progress');
    p.presenter.teardown();
  });

  it('回答的依据只框出来、不出步骤卡片——话在消息卡片上说；要用户去操作的一步照常出卡片', async () => {
    const p = page();
    p.appear();
    await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    p.snapshot('old-snapshot');
    await p.presenter.show(command('依据', 'tab-1#1:explain', 'e1', { mode: 'explain' }));
    expect(p.views.map((v) => v.outline)).toEqual([undefined, true]);
    p.presenter.teardown();
  });
});

describe('presenter · 画之前先认页面：一步只画在它所属的那一页（症状 2）', () => {
  it('V1. 快照还是最新的、元素也还连着，但页面已经换了视图 → 拒绝，什么都不画，也不按描述符去找', async () => {
    // 同文档切换（pushState）不产生新快照：旧日的守卫只问「快照是不是最新的」，
    // 于是一步属于 /repo 的计划被画在了 /repo/issues 上。
    const p = page();
    p.snapshot('old-snapshot');
    p.appear();
    p.goTo('https://x.test/repo/issues');
    const res = await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));

    expect(res.ok && res.data.failure).toBe('view_moved');
    expect(p.painted).toEqual([]);
    expect(p.looks()).toBe(0);
    expect(p.presenter.current).toBeNull();
  });

  it('V2. 只差 fragment（文档站滚动）→ 还是同一页，照画', async () => {
    const p = page();
    p.snapshot('old-snapshot');
    p.goTo(`${REPO}#readme`);
    const res = await p.presenter.show(command('Issues', 'tab-1#1', 'e1'));
    expect(res.ok && res.data.failure).toBeUndefined();
    expect(res.ok && res.data.resolved).toBe('e1');
    p.presenter.teardown();
  });
});
