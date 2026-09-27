import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEffectListener } from '@/entrypoints/sidepanel/effects';

/**
 * The panel's half of the effect protocol, driven through a fake `chrome`.
 *
 * One property, and it is the one that kept the guide on 「正在想…」 forever:
 * whatever happens in here, the host gets exactly one answer. It holds the
 * call in flight until an `EFFECT_RESULT` arrives and nothing else will send
 * one — so a throw that escapes this listener is a run that can never
 * recover, with the money already spent.
 */

type Listener = (msg: unknown) => void;

function fakeChrome() {
  const listeners: Listener[] = [];
  const sent: Record<string, unknown>[] = [];
  const ports: { name: string; drop: () => void }[] = [];
  const chrome = {
    runtime: {
      // The panel holds one of these for as long as it is there; the host
      // reads its disconnect as 「这个 panel 没了」.
      connect: ({ name }: { name: string }) => {
        const gone: Listener[] = [];
        ports.push({ name, drop: () => gone.forEach((f) => f(null)) });
        return { name, onDisconnect: { addListener: (fn: Listener) => gone.push(fn) } };
      },
      onMessage: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: (fn: Listener) => listeners.splice(listeners.indexOf(fn), 1),
      },
      // The claim is granted; everything after it is what these tests are about.
      sendMessage: async (msg: Record<string, unknown>) => {
        sent.push(msg);
        return msg.type === 'EFFECT_CLAIM' ? { granted: true } : undefined;
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  return { chrome, listeners, sent, ports };
}

const request = {
  type: 'EFFECT_REQUEST',
  threadId: 'tab-1',
  effectId: 'fx-1',
  kind: 'callModel',
  params: { goal: 'g', table: { items: [] }, history: { done: [], route: [] } },
  at: { threadRev: 1, snapshotId: 's1', structureHash: 'h', url: 'https://example.test/' },
  deadline: Date.now() + 60_000,
};

/** Runs the listener over one request and waits for the answer to be sent. */
async function answerFor(loadCfg: () => Promise<never> | Promise<unknown>) {
  const { chrome, listeners, sent } = fakeChrome();
  vi.stubGlobal('chrome', chrome);
  const stop = startEffectListener(loadCfg as never);
  for (const fn of listeners) fn(request);
  for (let i = 0; i < 50 && !sent.some((m) => m.type === 'EFFECT_RESULT'); i++) await new Promise((r) => setTimeout(r, 2));
  stop();
  return sent.find((m) => m.type === 'EFFECT_RESULT') as
    | { effectId: string; outcome: { ok: boolean; error?: string; retryable?: boolean; providerCalls: number } }
    | undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe('sidepanel/effects.ts · 这个 panel 是谁', () => {
  /**
   * The real side panel's messages carry no `sender.documentId` — no frame and
   * no tab either — so the host cannot tell one panel from another by the
   * message alone. It got nothing, refused every claim, and left the run at
   * 「正在想」 for as long as anyone cared to watch. So the panel says who it
   * is, and holds a port that says when it is gone.
   */
  it('认领时报上自己的名字，并且在有名字之前就把端口握住了', async () => {
    const { chrome, listeners, sent, ports } = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    const stop = startEffectListener(async () => ({}) as never);
    expect(ports).toHaveLength(1);
    const [kind, panelId] = ports[0]!.name.split(':');
    expect(kind).toBe('panel');
    expect(panelId).toBeTruthy();

    for (const fn of listeners) fn(request);
    for (let i = 0; i < 50 && !sent.some((m) => m.type === 'EFFECT_CLAIM'); i++) await new Promise((r) => setTimeout(r, 2));
    stop();
    // The same name in both places, or the host cannot connect the claim it
    // granted with the panel that later goes away.
    expect(sent.find((m) => m.type === 'EFFECT_CLAIM')?.panelId).toBe(panelId);
  });

  it('端口断了就再接上——worker 是会被回收的，而 panel 还在；但接不上时要有刹车', () => {
    const { chrome, ports } = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    vi.useFakeTimers();
    const stop = startEffectListener(async () => ({}) as never);

    vi.advanceTimersByTime(1500); // 一条用过一阵子的连接，被回收的 worker 带走了
    ports[0]!.drop();
    expect(ports).toHaveLength(2);
    // And it is the same panel: a new name would orphan whatever it claimed.
    expect(ports[1]!.name).toBe(ports[0]!.name);

    // 接上就断：这正是会烧成死循环的那一种，所以隔两秒再试
    ports[1]!.drop();
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(ports).toHaveLength(3);
    stop();
    vi.useRealTimers();
  });

  it('停下来之后不再重连', async () => {
    const { chrome, ports } = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    startEffectListener(async () => ({}) as never)();
    ports[0]!.drop();
    expect(ports).toHaveLength(1);
  });
});

describe('sidepanel/effects.ts · 无论如何都要回一句', () => {
  it('执行这次调用时抛了异常 → 照样回一条 EFFECT_RESULT，说明失败、可重试、这次请求算花过', async () => {
    const answer = await answerFor(() => Promise.reject(new Error('读配置炸了')));
    expect(answer?.effectId).toBe('fx-1');
    expect(answer?.outcome.ok).toBe(false);
    expect(answer?.outcome.error).toContain('读配置炸了');
    expect(answer?.outcome.retryable).toBe(true);
    // The request may well have gone out before the throw; charging one is the
    // same floor the host's own sweep uses.
    expect(answer?.outcome.providerCalls).toBe(1);
  });

  it('抛的不是 Error 也一样回话，不把宿主晾着', async () => {
    const answer = await answerFor(() => Promise.reject('字符串也能抛'));
    expect(answer?.outcome.ok).toBe(false);
    expect(answer?.outcome.error).toContain('字符串也能抛');
  });
});
