import { describe, expect, it, vi, afterEach } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { buildToolResultText } from '@/agent/context/user-message';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import { waitForText, type WaitPorts } from '@/core/wait/wait-for-text';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * `wait_for` (CONTEXT.md `Tool`): the model says what it expects to appear —
 * or go — and how long it is willing to wait, capped at ten seconds.
 *
 * The wait is the model's, so its timeout is the model's to hear about
 * (CONTEXT.md `Reading`): 「等了 N 秒，没等到 X」 goes back to it with the page
 * as it is now. Nothing is stamped and nothing is written into the history —
 * a wait that ran out is not a step that failed.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const PAGE: PromptTable = {
  snapshotId: 's1', url: 'https://x.test/instances', title: 't', structureHash: 'h1', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'button', name: '删除实例', path: ['实例操作'] }],
};
const DIALOG: PromptTable = {
  ...PAGE,
  snapshotId: 's2',
  structureHash: 'h2',
  items: [...PAGE.items, { ref: 'e2' as Ref, role: 'button', name: '确认删除', path: ['确认对话框'] }],
};
const WAIT = { until: 'appears', text: '确认删除', seconds: 5 };

const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);

/** A step on screen, not yet settled, and the model woken with a call out. */
function waiting(args: unknown = WAIT) {
  const s: ThreadState = {
    rev: 2, goal: '把这台实例删掉', table: PAGE, pointedOn: PAGE, route: [], cursor: 0, evidence: 'model', check: 'unknown',
    callCount: 2, stepCalls: 0, spentSteps: 0,
    steps: [{ ref: 'e1' as Ref, descriptor: { role: 'button', name: '删除实例' }, expectedUserAction: 'click', title: '删除实例' }],
    history: [{ title: '删除实例', url: PAGE.url }],
    inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 2, snapshotId: 's1', structureHash: 'h1', url: PAGE.url } },
    turn: { table: PAGE, rounds: [] },
  };
  return step(s, {
    kind: 'effect_result', effectId: 'fx-1', at: s.inflight!.at,
    outcome: { ok: true, providerCalls: 1, tool: 'wait_for', value: JSON.stringify(args), callId: 'call_w' },
    nextEffectId: 'fx-wait',
  });
}

describe('wait_for 经登记处就位', () => {
  it('模型说出等什么（出现或消失的一段文字）、最多等几秒', () => {
    const tools = guideAgent.outputSchema({ goal: 'g', table: PAGE, history: { done: [], route: [] } });
    const w = tools.find((t) => t.name === 'wait_for')?.inputSchema as {
      required: string[];
      properties: { until: { enum: string[] } };
    };
    expect(w.required).toEqual(['until', 'text', 'seconds']);
    expect(w.properties.until.enum).toEqual(['appears', 'gone']);
    expect(guideAgent.instructions).toContain('**wait_for**');
  });

  it('说不出等什么（空文字）→ 拒绝', () => {
    const parsed = guideAgent.parseOutput('wait_for', JSON.stringify({ ...WAIT, text: '  ' }));
    if (parsed.kind !== 'ok') throw new Error('fixture must parse');
    expect(guideAgent.validate(parsed.envelope, PAGE).kind).toBe('violation');
  });
});

describe('一次等待', () => {
  it('模型要等 → 内容脚本去等，没有模型调用在途；秒数封顶在 10', () => {
    const { state, effects } = waiting({ ...WAIT, seconds: 30 });
    expect(ofKind(effects, 'waitFor')).toEqual([{ kind: 'waitFor', effectId: 'fx-wait', until: 'appears', text: '确认删除', seconds: 10 }]);
    expect(state.inflight).toBeNull();
    expect(state.turn?.pending?.effectId).toBe('fx-wait');
  });

  it('秒数不到 1 按 1 秒等', () => {
    expect(ofKind(waiting({ ...WAIT, seconds: 0 }).effects, 'waitFor')[0]?.seconds).toBe(1);
  });

  it('等不到 → 这一轮连同此刻的页面交回模型，不盖章、不写历史', () => {
    const { state } = waiting();
    const back = step(state, {
      kind: 'tool_result',
      effectId: 'fx-wait',
      result: { kind: 'waited', until: 'appears', text: '确认删除', seconds: 5, met: false, table: PAGE },
      nextEffectId: 'fx-2',
    });
    expect(back.state.history).toEqual(state.history);
    expect(back.state.history.at(-1)?.action).toBeUndefined();
    expect(ofKind(back.effects, 'notify')).toEqual([]);
    expect(back.state.turn?.rounds.at(-1)?.result).toMatchObject({ kind: 'waited', met: false });
    expect(ofKind(back.effects, 'callModel')).toHaveLength(1);
  });

  it('等到了 → 之后按此刻读到的那张表核对', () => {
    const { state } = waiting();
    const back = step(state, {
      kind: 'tool_result',
      effectId: 'fx-wait',
      result: { kind: 'waited', until: 'appears', text: '确认删除', seconds: 1.2, met: true, table: DIALOG },
      nextEffectId: 'fx-2',
    });
    expect(back.state.table).toBe(DIALOG);
    expect(ofKind(back.effects, 'callModel')[0]?.table).toBe(DIALOG);
  });
});

describe('交回模型的那句话', () => {
  const said = (met: boolean | null, table: PromptTable | null = PAGE, until: 'appears' | 'gone' = 'appears') =>
    buildToolResultText({ kind: 'waited', until, text: '确认删除', seconds: met ? 1.2 : 10, met, table }, 'N');

  it('等不到：说等了几秒、没等到什么，再给此刻的页面', () => {
    expect(said(false)).toContain('等了 10 秒，没等到「确认删除」出现');
    expect(said(false)).toContain('<untrusted_page_content nonce="N">');
  });

  it('等到了：说等了多久', () => {
    expect(said(true)).toContain('等到了');
    expect(said(true)).toContain('1.2 秒');
  });

  it('等消失：说的是消失', () => {
    expect(said(false, PAGE, 'gone')).toContain('没等到「确认删除」消失');
  });

  it('没能等完（页面在等的时候离开或刷新了）、此刻也读不到 → 两件事都如实说', () => {
    const text = said(null, null);
    expect(text).toContain('没能等完');
    expect(text).toContain('读不到这一页');
  });
});

describe('内容脚本那一半：盯着页面变化，条件一成立就回', () => {
  afterEach(() => vi.useRealTimers());

  /** A page whose visible text the test sets, and whose mutations it fires. */
  function fakePage(initial: string) {
    let text = initial;
    let onChange: (() => void) | null = null;
    let now = 0;
    const frames: (() => void)[] = [];
    let disconnected = false;
    const ports: WaitPorts = {
      readText: () => text,
      observe: (cb) => {
        onChange = cb;
        return () => {
          disconnected = true;
          onChange = null;
        };
      },
      frame: (cb) => void frames.push(cb),
      after: (ms, cb) => {
        const t = setTimeout(cb, ms);
        return () => clearTimeout(t);
      },
      now: () => now,
    };
    return {
      ports,
      set: (t: string) => {
        text = t;
        onChange?.();
      },
      flushFrame: () => frames.splice(0).forEach((f) => f()),
      tick: (ms: number) => {
        now += ms;
        vi.advanceTimersByTime(ms);
      },
      get disconnected() {
        return disconnected;
      },
      get frames() {
        return frames.length;
      },
    };
  }

  it('一开始就成立 → 立刻回，不挂监听', async () => {
    vi.useFakeTimers();
    const p = fakePage('实例列表 确认删除');
    await expect(waitForText(p.ports, 'appears', '确认删除', 5000)).resolves.toEqual({ met: true, waitedMs: 0 });
  });

  it('等着等着出现了 → 在变化之后的那一帧回，带上等了多久', async () => {
    vi.useFakeTimers();
    const p = fakePage('实例列表');
    const waited = waitForText(p.ports, 'appears', '确认删除', 5000);
    p.tick(800);
    p.set('实例列表 确认 删除'); // not yet: the words are split
    p.flushFrame();
    p.set('实例列表\n确认删除');
    p.flushFrame();
    await expect(waited).resolves.toEqual({ met: true, waitedMs: 800 });
    expect(p.disconnected).toBe(true);
  });

  it('一帧里来了很多次变化 → 只读一次页面文字', async () => {
    vi.useFakeTimers();
    const p = fakePage('');
    const read = vi.spyOn(p.ports, 'readText');
    void waitForText(p.ports, 'appears', '确认删除', 5000);
    read.mockClear();
    for (let i = 0; i < 50; i++) p.set(`第 ${i} 次`);
    expect(p.frames).toBe(1);
    p.flushFrame();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('到时没等到 → 回「没等到」，并且不再盯着页面', async () => {
    vi.useFakeTimers();
    const p = fakePage('实例列表');
    const waited = waitForText(p.ports, 'appears', '确认删除', 5000);
    p.tick(5000);
    await expect(waited).resolves.toEqual({ met: false, waitedMs: 5000 });
    expect(p.disconnected).toBe(true);
  });

  it('变化来了、那一帧却一直没来（后台标签页不跑动画帧）→ 到时再看最后一眼，照实报「等到了」', async () => {
    vi.useFakeTimers();
    const p = fakePage('实例列表');
    const waited = waitForText(p.ports, 'appears', '确认删除', 5000);
    p.tick(2000);
    p.set('实例列表 确认删除'); // a frame is asked for, and never runs
    p.tick(3000);
    await expect(waited).resolves.toEqual({ met: true, waitedMs: 5000 });
  });

  it('等它消失：还在就等，没了就回', async () => {
    vi.useFakeTimers();
    const p = fakePage('正在加载…');
    const waited = waitForText(p.ports, 'gone', '正在加载', 5000);
    p.tick(300);
    p.set('实例列表');
    p.flushFrame();
    await expect(waited).resolves.toEqual({ met: true, waitedMs: 300 });
  });
});
