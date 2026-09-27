import { describe, expect, it } from 'vitest';
import {
  TRACE_MAX_ENTRIES,
  createTrace,
  mergeTrace,
  saysTableIsMissingIt,
  traceKey,
} from '@/agent/agents/guide/trace';
import type { Trace } from '@/shared/types';
import { TRACE_ENABLED_KEY, isFlagOn, type FlagStore } from '@/agent/flags';
import type { RunEvent } from '@/agent/agents/guide/runner';
import { flagStore } from './fixtures/flag-store';
import type { GuideAgentEnvelope } from '@/agent/agents/guide/registry';
import type { Ref } from '@/shared/types';

/** A minimal `point` whose step carries the given rationale. */
const pointSaying = (why: string): GuideAgentEnvelope => ({ intent: 'point', route: [], ref: 'e1' as Ref, action: 'click', why });

/**
 * `agent/agents/guide/trace.ts` — the debug channel behind the run loop.
 *
 * Every test here is really one question: can this file change what the
 * product does? It must not be able to. It is off by default, it runs after
 * the outcome is already decided, and a storage failure inside it is not
 * allowed to become a failed model call.
 */

const ev = {
  request: { kind: 'request', system: 'SYS', user: 'U1' } as RunEvent,
  raw: (text: string) => ({ kind: 'raw', text }) as RunEvent,
  parseError: { kind: 'parse_error', message: '缺少 why' } as RunEvent,
  repair: { kind: 'repair', system: 'REPAIR-SYS', user: 'U-prev' } as RunEvent,
  settled: { kind: 'settled', envelope: { intent: 'point', route: [], ref: 'e1', action: 'click', why: '' } } as unknown as RunEvent,
  violation: { kind: 'violation', reason: '指向敏感字段' } as RunEvent,
};

const clock = () => {
  let t = 1_000;
  return () => (t += 1);
};

describe('guide/trace.ts · createTrace — 记录的是真发出去的东西', () => {
  it('1. system 只存一份，不随每条记录重复', () => {
    // 系统消息约 8KB 且每次逐字相同；跟着 24 条记录各存一遍，整份 trace 就
    // 基本只剩这一个字符串了。
    const t = createTrace(clock());
    t.record(ev.request);
    t.record(ev.raw('A'));
    t.record(ev.request);
    const snap = t.snapshot()!;
    expect(snap.system).toBe('SYS');
    expect(JSON.stringify(snap.entries)).not.toContain('SYS');
  });

  it('2. 修复请求自带 system——那一份确实不一样（§5.9 的独立最小对话）', () => {
    const t = createTrace(clock());
    t.record(ev.request);
    t.record(ev.repair);
    const entry = t.snapshot()!.entries.find((e) => e.kind === 'repair');
    expect(entry).toMatchObject({ kind: 'repair', system: 'REPAIR-SYS', user: 'U-prev' });
  });

  it('3. settled 只记 intent，不再存一遍信封', () => {
    // 信封的原文就是紧挨着的上一条 raw，一字不差；再存一次等于把 trace 翻倍
    // 去说同一句话。
    const t = createTrace(clock());
    t.record(ev.raw('{"intent":"point"}'));
    t.record(ev.settled);
    expect(t.snapshot()!.entries.at(-1)).toMatchObject({ kind: 'settled', intent: 'point' });
  });

  it('4. 六种事件都记得下来，顺序与时间戳都保留', () => {
    const t = createTrace(clock());
    for (const e of [ev.request, ev.raw('A'), ev.parseError, ev.repair, ev.raw('B'), ev.violation]) t.record(e);
    const snap = t.snapshot()!;
    expect(snap.entries.map((e) => e.kind)).toEqual(['request', 'raw', 'parse_error', 'repair', 'raw', 'violation']);
    const times = snap.entries.map((e) => e.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('21. 工具 schema 像 system 一样只存一份：取自请求事件，不进任何一条记录', () => {
    // 回放一次调用时，模型能拿哪些工具作答，和它被问了什么同样要紧。运行循环的
    // 请求事件本来就带着它，只是以前没存。
    const t = createTrace(clock());
    t.record({ kind: 'request', system: 'SYS', user: 'U1', tools: 'TOOLS' } as RunEvent);
    t.record(ev.raw('A'));
    const snap = t.snapshot()!;
    expect(snap.tools).toBe('TOOLS');
    expect(JSON.stringify(snap.entries)).not.toContain('TOOLS');
  });

  it('5. 一个事件都没有 → snapshot 是 null，调用方不必自己数长度', () => {
    expect(createTrace(clock()).snapshot()).toBeNull();
  });

  it('6. snapshot 是拷贝：拿到之后继续 record 不会改动它', () => {
    const t = createTrace(clock());
    t.record(ev.request);
    const snap = t.snapshot()!;
    t.record(ev.raw('later'));
    expect(snap.entries).toHaveLength(1);
  });
});

describe('agent/flags.ts · 开关默认关，且读不到就是关', () => {
  it('7. 没有这个键 → 关', async () => {
    expect(await isFlagOn(flagStore({}), TRACE_ENABLED_KEY)).toBe(false);
  });

  it('8. 只有布尔真才算开——字符串 "true"、1 都不算', async () => {
    expect(await isFlagOn(flagStore({ [TRACE_ENABLED_KEY]: true }), TRACE_ENABLED_KEY)).toBe(true);
    expect(await isFlagOn(flagStore({ [TRACE_ENABLED_KEY]: 'true' }), TRACE_ENABLED_KEY)).toBe(false);
    expect(await isFlagOn(flagStore({ [TRACE_ENABLED_KEY]: 1 }), TRACE_ENABLED_KEY)).toBe(false);
  });

  it('9. 存储读取抛异常 → 关，而且不把异常抛给正在等结果的那次调用', async () => {
    const broken: FlagStore = {
      get: async () => {
        throw new Error('storage unavailable');
      },
    };
    await expect(isFlagOn(broken, TRACE_ENABLED_KEY)).resolves.toBe(false);
  });

});

describe('guide/trace.ts · mergeTrace — 一条线程的历史按条数封顶', () => {
  const entriesOf = (n: number, tag: string): Trace => ({
    system: 'SYS',
    tools: 'TOOLS',
    entries: Array.from({ length: n }, (_, i) => ({ at: i, kind: 'raw' as const, text: `${tag}${i}` })),
  });

  it('10. 首次写入 → 就是这一次的内容', () => {
    expect(mergeTrace(undefined, entriesOf(2, 'a')).entries.map((e) => (e as { text: string }).text)).toEqual(['a0', 'a1']);
  });

  it('11. 追加在已有之后，不是覆盖', () => {
    const merged = mergeTrace(entriesOf(2, 'a'), entriesOf(2, 'b'));
    expect(merged.entries.map((e) => (e as { text: string }).text)).toEqual(['a0', 'a1', 'b0', 'b1']);
  });

  it('12. 超过上限丢最旧的，而不是拒绝写入', () => {
    const merged = mergeTrace(entriesOf(TRACE_MAX_ENTRIES, 'a'), entriesOf(3, 'b'));
    expect(merged.entries).toHaveLength(TRACE_MAX_ENTRIES);
    expect((merged.entries.at(-1) as { text: string }).text).toBe('b2');
    expect((merged.entries[0] as { text: string }).text).toBe('a3');
  });

  it('13. 存的是旧版本留下的、已经认不出的形状 → 从头开始，而不是让消息处理器崩掉', () => {
    for (const junk of [null, 'a string', 42, { entries: 'not an array' }, {}]) {
      expect(() => mergeTrace(junk, entriesOf(1, 'b'))).not.toThrow();
      expect(mergeTrace(junk, entriesOf(1, 'b')).entries).toHaveLength(1);
    }
  });

  it('14. system 与工具 schema 都用这一次的——提示词改过之后，旧的那份已经不再描述新记录', () => {
    const old: Trace = { system: 'OLD-SYS', tools: 'OLD-TOOLS', entries: [] };
    expect(mergeTrace(old, { system: 'NEW-SYS', tools: 'NEW-TOOLS', entries: [] })).toMatchObject({
      system: 'NEW-SYS',
      tools: 'NEW-TOOLS',
    });
  });
});

/**
 * 「模型说它要的东西不在表里」这个诊断。裁剪改成只删复述之后，它是判断裁剪到底修没修好的
 * 唯一运行时证据——所以探针本身要能拿真机数据校准，而不是拍脑袋定几个词。
 */
describe('guide/trace.ts · not_in_table 诊断', () => {
  // 下面 6 条是真机 86 条 why 里命中的原文（抽样），4 条否定例也是原文。
  it.each([
    '当前停留在 n8n 仓库主页，仓库的 CI 配置在 Actions 选项卡里。但本页元素表中没有直接可见的 Actions 链接，先查看仓库导航区域寻找入口。',
    '判断这一页上是否有指向 Actions 的导航入口需要先观察仓库页面上方的标签栏，这些标签不在当前元素表列出范围内。',
    '页面已截断，未列出 Releases 相关的仓库导航链接，需要滚动查看。',
    '要查看仓库的开源许可证，需要进入仓库导航里的 LICENSE.md 文件页。被裁剪的元素表没有全部列出来。',
    '这一页是仓库首页，没有列出 Releases 链接（元素已裁剪），应先从仓库代码页切换到 Releases。',
    '仓库文件列表里没有 .github/workflows 目录被列出，需要在仓库导航里找入口。',
  ])('16. 认得出真话：%s', (why) => {
    expect(saysTableIsMissingIt(why)).toBe(true);
  });

  it.each([
    '这一步与上一步是同一 ref——先向搜索框输入仓库名，再在建议列表中选择匹配项进入仓库页。',
    '全局搜索按仓库名匹配，结果列表里第一个正是目标仓库 n8n-io/n8n，点它进入该仓库页面。',
    '我们已进入 n8n-io/n8n 仓库页，文件列表里有 CONTRIBUTING.md 文件，点它以打开贡献指南正文。',
    '在搜索结果的仓库列表里，n8n-io/n8n 就是目标仓库。',
  ])('17. 不把「读表读得好好的」当成抱怨：%s', (why) => {
    // 只匹配「表里」而不要求附近有否定，这四条全会误报——它们说的是模型
    // 成功地从表里挑到了东西。真机数据上这就是 4/13 的误报率。
    expect(saysTableIsMissingIt(why)).toBe(false);
  });

  it('18. 记在 settled 之后，且只诊断——不改变任何行为', () => {
    const t = createTrace(() => 1);
    t.record({ kind: 'settled', envelope: pointSaying('本页元素表中没有直接可见的 Actions 链接') });
    const kinds = t.snapshot()!.entries.map((e) => e.kind);
    expect(kinds).toEqual(['settled', 'not_in_table']);
  });

  it('19. 模型没抱怨就不记——这条事件的用处是数它出现几次', () => {
    const t = createTrace(() => 1);
    t.record({ kind: 'settled', envelope: pointSaying('点这个链接进入仓库主页。') });
    expect(t.snapshot()!.entries.map((e) => e.kind)).toEqual(['settled']);
  });

  it.each([
    ['ask', { intent: 'ask', question: '本页元素表中没有直接可见的 Actions 链接，你要看哪一个？', wants: 'text', options: [] }],
    ['done', { intent: 'done', evidence: 'content_on_page', why: '本页元素表中没有直接可见的 Actions 链接，但要的内容已经在这一页上' }],
  ] as const)('20. %s 的理由也在诊断之列——由它自己的模块说哪句是理由', (_intent, envelope) => {
    const said = 'question' in envelope ? envelope.question : envelope.why;
    const t = createTrace(() => 1);
    t.record({ kind: 'settled', envelope: envelope as unknown as GuideAgentEnvelope });
    expect(t.snapshot()!.entries.slice(1)).toEqual([{ at: 1, kind: 'not_in_table', said }]);
  });
});

describe('guide/trace.ts · 键名', () => {
  it('15. 按线程分键，且不与宿主的 guide:<threadId> 撞上', () => {
    expect(traceKey('tab-7')).toBe('trace:tab-7');
    expect(traceKey('tab-7')).not.toContain('guide:');
  });
});
