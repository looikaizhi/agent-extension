import { describe, expect, it } from 'vitest';
import { append, pendingOf, recentTalk, roundOf, stampStep } from '@/agent/conversation/entries';
import type { ToolRound } from '@/agent/context/turn';
import type { ThreadState } from '@/agent/thread/thread';
import { emptyConversation, type ConversationEntry } from '@/shared/conversation';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

const table = (n: number): PromptTable => ({
  snapshotId: 's1',
  url: 'https://example.test/',
  title: 't',
  structureHash: 'h',
  omitted: 0,
  degraded: false,
  ambiguity: 0,
  stats: { elementsScanned: 0, candidates: 0, visible: 0, emitted: n, shadowRoots: 0, emptyName: 0, modalScoped: false, ms: { walk: 0, visibility: 0, semantics: 0, name: 0, total: 0 } },
  items: Array.from({ length: n }, (_, i) => ({ ref: `e${i}` as Ref, role: 'button', name: `按钮 ${i}`, path: [] })),
});

const call = (name: string, args: Record<string, unknown>): ToolRound['call'] => ({ id: 'c1', name, args: JSON.stringify(args) });

const thread = (over: Partial<ThreadState> = {}): ThreadState =>
  ({
    rev: 1, goal: 'g', table: table(1), pointedOn: table(1), route: [], steps: [], cursor: 0, history: [],
    evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 1, spentSteps: 0,
    inflight: null, ...over,
  }) as ThreadState;

describe('roundOf：线程里的一轮，读成用户能看的一行', () => {
  it('observe：带上模型自己说的理由，和读回来的控件数', () => {
    const round: ToolRound = { call: call('observe', { why: '弹窗应该已经出来了' }), result: { kind: 'page', table: table(38) } };
    expect(roundOf(round)).toEqual({ tool: 'observe', why: '弹窗应该已经出来了', got: '读到这一页的 38 个控件' });
  });

  it('observe：这一页读不到', () => {
    const round: ToolRound = { call: call('observe', { why: '看看' }), result: { kind: 'unreadable' } };
    expect(roundOf(round).got).toBe('这一页读不到');
  });

  it('wait_for：等到了 / 没等到 / 没等完', () => {
    const waiting = (met: boolean | null, seconds: number): ToolRound => ({
      call: call('wait_for', { until: 'appears', text: '创建成功', seconds: 10 }),
      result: { kind: 'waited', until: 'appears', text: '创建成功', seconds, met, table: null },
    });
    expect(roundOf(waiting(true, 3.2))).toMatchObject({ tool: 'wait_for', asked: '等「创建成功」出现', got: '等到了（3.2 秒）' });
    expect(roundOf(waiting(false, 10)).got).toBe('没等到（10 秒）');
    expect(roundOf(waiting(null, 4)).got).toBe('没等完：页面换了');
  });

  it('wait_for：等它消失', () => {
    const round: ToolRound = {
      call: call('wait_for', { until: 'gone', text: '加载中', seconds: 5 }),
      result: { kind: 'waited', until: 'gone', text: '加载中', seconds: 1.5, met: true, table: null },
    };
    expect(roundOf(round).asked).toBe('等「加载中」消失');
  });

  it('read_doc：读到了多少字、截没截过；没读到就说原因', () => {
    const asked = { via_ref: 'e7', query: '许可证是什么' };
    expect(roundOf({ call: call('read_doc', asked), result: { kind: 'doc', text: 'x'.repeat(1200), truncated: false } })).toMatchObject({
      asked: '读文档：许可证是什么',
      got: '读到 1200 个字',
    });
    expect(roundOf({ call: call('read_doc', asked), result: { kind: 'doc', text: 'x'.repeat(8000), truncated: true } }).got).toBe('读到 8000 个字（截过）');
    expect(roundOf({ call: call('read_doc', asked), result: { kind: 'no_doc', reason: '这条链接会跳到别的地址' } }).got).toBe('没读到：这条链接会跳到别的地址');
  });

  it('模型的参数坏掉了也要显示这一轮：说得出工具名，说不出的就不说', () => {
    const round: ToolRound = { call: { id: 'c1', name: 'observe', args: '{不是 JSON' }, result: { kind: 'unreadable' } };
    expect(roundOf(round)).toEqual({ tool: 'observe', got: '这一页读不到' });
  });

  it('这一轮花了多少，照实带上', () => {
    const round: ToolRound = { call: call('observe', { why: '看看' }), result: { kind: 'unreadable' } };
    expect(roundOf(round, { prompt: 5320, completion: 271 }).usage).toEqual({ prompt: 5320, completion: 271 });
  });
});

describe('append：宿主是唯一的写者', () => {
  const said = { at: 1, kind: 'said' as const, text: '带我去看 issue' };

  it('每写一条，rev 加一，id 不重复，顺序就是发生的顺序', () => {
    const one = append(emptyConversation(7), said);
    const two = append(one, { at: 2, kind: 'step', text: '点 Issues', detail: '就是它' });
    expect(two.rev).toBe(2);
    expect(two.entries.map((e) => e.kind)).toEqual(['said', 'step']);
    expect(new Set(two.entries.map((e) => e.id)).size).toBe(2);
    expect(two.tabId).toBe(7);
  });

  it('原来的那一份不被改动', () => {
    const one = append(emptyConversation(7), said);
    append(one, { at: 2, kind: 'note', text: '读不到这个页面' });
    expect(one.entries).toHaveLength(1);
  });
});

describe('stampStep：一步后来怎么样了，记到显示它的那一条上', () => {
  it('按呈现身份找到那一条，写上结果', () => {
    const c = append(append(emptyConversation(7), { at: 1, kind: 'said', text: 'g' }), {
      at: 2, kind: 'step', text: '点 Issues', step: { index: 0, total: null, presentationId: 'tab-7#1' },
    });
    const after = stampStep(c, 'tab-7#1', 'used');
    expect(after.entries[1]!.step!.outcome).toBe('used');
    expect(after.rev).toBe(c.rev + 1);
  });

  it('找不到那一条就什么都不改（迟到的消息不该凭空造一条）', () => {
    const c = append(emptyConversation(7), { at: 1, kind: 'said', text: 'g' });
    expect(stampStep(c, 'tab-7#9', 'used')).toBe(c);
  });
});

describe('pendingOf：此刻在做什么，从线程算出来', () => {
  const ask: ConversationEntry = { id: 'e1', at: 1, kind: 'ask', text: '要哪一个？' };

  it('没有线程 → 就绪', () => {
    expect(pendingOf(null, { panelOpen: true })).toEqual({ kind: 'idle' });
  });

  it('调用在途、有侧栏在 → 正在想', () => {
    const state = thread({ inflight: { effectId: 'fx', kind: 'callModel', at: { threadRev: 1, snapshotId: 's1', structureHash: 'h', url: 'u' } } });
    expect(pendingOf(state, { panelOpen: true })).toEqual({ kind: 'thinking' });
  });

  it('调用在途、一个侧栏都没开 → 在等侧栏（06c）', () => {
    const state = thread({ inflight: { effectId: 'fx', kind: 'callModel', at: { threadRev: 1, snapshotId: 's1', structureHash: 'h', url: 'u' } } });
    expect(pendingOf(state, { panelOpen: false })).toEqual({ kind: 'waiting_for_panel' });
  });

  it('宿主正在执行模型要的工具 → 说出是哪个工具', () => {
    const state = thread({ turn: { table: table(1), rounds: [], pending: { effectId: 'fx', call: call('wait_for', { until: 'appears', text: 'x', seconds: 3 }) } } });
    expect(pendingOf(state, { panelOpen: true })).toEqual({ kind: 'running_tool', tool: 'wait_for' });
  });

  it('等用户答跨站确认', () => {
    expect(pendingOf(thread({ pendingCrossSite: 'docs.example.test' }), { panelOpen: true })).toEqual({
      kind: 'waiting_for_user',
      what: 'cross_site',
    });
  });

  it('最后一条是模型的提问、又没有调用在途 → 等用户回答', () => {
    expect(pendingOf(thread(), { panelOpen: true, lastEntry: ask })).toEqual({ kind: 'waiting_for_user', what: 'ask' });
  });

  it('这一趟已经结束 → 就绪，哪怕最后一条是提问', () => {
    expect(pendingOf(thread({ ending: 'answered' }), { panelOpen: true, lastEntry: ask })).toEqual({ kind: 'idle' });
  });

  it('屏上有一步、没有调用在途 → 就绪：轮到用户动手了', () => {
    expect(pendingOf(thread({ steps: [{ descriptor: { role: 'button', name: 'Issues' }, expectedUserAction: 'click', title: '点 Issues' }] }), { panelOpen: true })).toEqual({ kind: 'idle' });
  });
});

/**
 * 「刚才说过的话」——新的一趟带给模型的上文（票 04）。
 *
 * 一次 `explain` 落地就结束这一趟，所以每句提问都是一趟独立的运行：模型从前
 * 连自己上一轮答过什么都看不见。真机上用户说「那我要怎么打开看到**这些产品**
 * 呢」，而「这些产品」指的是模型上一轮列出来的东西——提示词里却没有任何指代
 * 对象。
 */
describe('recentTalk：这一趟之前说过的话', () => {
  const talked = (...kinds: [ConversationEntry['kind'], string][]): ConversationEntry[] =>
    kinds.map(([kind, text], i) => ({ id: `1:${i}`, at: i, kind, text }) as ConversationEntry);
  const few = { turns: 3, chars: 300 };

  it('带上两边的原话：用户说的和它自己答的，最近的在最后', () => {
    const entries = talked(
      ['said', '这一页有什么产品？'],
      ['answer', '有网络解锁器、代理类型、数据集。'],
      ['said', '那我要怎么打开看到这些产品呢'],
    );
    expect(recentTalk(entries, few)).toEqual([
      { who: 'user', text: '这一页有什么产品？' },
      { who: 'guide', text: '有网络解锁器、代理类型、数据集。' },
    ]);
  });

  it('这一趟自己那句话不带——消息末尾已经写着它了', () => {
    const entries = talked(['said', '第一句'], ['answer', '答第一句'], ['said', '现在这一句']);
    expect(recentTalk(entries, few).some((t) => t.text === '现在这一句')).toBe(false);
  });

  it('只带两边说过的话：指过的步骤和宿主自己的提示都不带', () => {
    // 指过的步骤连同结局已经在这一趟的 history 里；note 是宿主的记账。
    const entries = talked(['said', '带我去 issue'], ['step', '第 1 步：Issues'], ['note', '调用失败：连接超时'], ['said', '现在这一句']);
    expect(recentTalk(entries, few)).toEqual([{ who: 'user', text: '带我去 issue' }]);
  });

  it('只留最近几轮', () => {
    const entries = talked(
      ['said', '第 1 轮'], ['answer', '答 1'],
      ['said', '第 2 轮'], ['answer', '答 2'],
      ['said', '第 3 轮'], ['answer', '答 3'],
      ['said', '第 4 轮'], ['answer', '答 4'],
      ['said', '现在这一句'],
    );
    const talk = recentTalk(entries, { turns: 2, chars: 300 });
    expect(talk.map((t) => t.text)).toEqual(['第 3 轮', '答 3', '第 4 轮', '答 4']);
  });

  it('一句太长就截断——上文是给指代找对象的，不是把整页再抄一遍', () => {
    const entries = talked(['said', '甲'.repeat(50)], ['said', '现在这一句']);
    expect(recentTalk(entries, { turns: 3, chars: 10 })[0]).toEqual({ who: 'user', text: `${'甲'.repeat(10)}…` });
  });

  it('这是第一句话 → 什么都不带', () => {
    expect(recentTalk(talked(['said', '第一句']), few)).toEqual([]);
    expect(recentTalk([], few)).toEqual([]);
  });
});
