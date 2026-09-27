import { describe, expect, it } from 'vitest';
import { memory, memoryText, walkedPaths } from '@/agent/context/memory';
import type { RunRecord } from '@/agent/thread/record';

/**
 * 这台浏览器在这个站点上走通过的路（票 04 第四层）。
 *
 * 每走完一趟就留下一条 `Run record`——目标、最后落在哪一页、走过哪几步。那份
 * 记录一直在写，却从来没有人读：同一个站点上问第二次同类问题，产品什么都不
 * 记得。
 *
 * 只记**走通了的**：模型说到了，而且确实走过步骤。一次「东西本来就在这一页上」
 * 的到达不是一条路。
 */

const run = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    runId: 'r1',
    at: 1_000,
    goal: '看 issue 列表',
    url: 'https://github.com/n8n-io/n8n/issues',
    route: [],
    steps: [{ title: 'Issues' }],
    ending: 'model_done',
    confirmation: 'all',
    evidence: 'model',
    check: 'confirmed',
    calls: 2,
    plugins: [],
    ...over,
  }) as RunRecord;

describe('walkedPaths：哪些算走通过的路', () => {
  it('模型说到了、而且真的走过步骤 —— 才算', () => {
    expect(walkedPaths([run()]).map((p) => p.goal)).toEqual(['看 issue 列表']);
  });

  it('没走过任何一步的「到了」不是一条路——东西本来就在那一页上', () => {
    expect(walkedPaths([run({ steps: [] })])).toEqual([]);
  });

  it('没到就不记：用完配额、用户中途结束、一次提问，都不是走通了', () => {
    const endings = ['quota_exhausted', 'answered', 'user_ended', 'loop_backstop'] as const;
    expect(walkedPaths(endings.map((ending, i) => run({ runId: `r${i}`, ending } as Partial<RunRecord>)))).toEqual([]);
  });

  it('按站点挑，最近的在前', () => {
    const paths = walkedPaths(
      [
        run({ runId: 'a', at: 1, url: 'https://github.com/x/issues', goal: '旧的' }),
        run({ runId: 'b', at: 9, url: 'https://github.com/y/pulls', goal: '新的' }),
        run({ runId: 'c', at: 5, url: 'https://gitee.com/z', goal: '别的站' }),
      ],
      'github.com',
    );
    expect(paths.map((p) => p.goal)).toEqual(['新的', '旧的']);
  });
});

describe('memoryText：说给模型听的那一段', () => {
  it('把目标和走过的步骤写成线索，并说明页面可能已经变了', () => {
    const text = memoryText([run({ steps: [{ title: 'Issues' }, { title: 'Filters' }] })], 'https://github.com/n8n-io/n8n');
    expect(text).toContain('这个站点上，以前在这台浏览器上走通过这些');
    expect(text).toContain('页面可能已经变了');
    expect(text).toContain('「看 issue 列表」：Issues → Filters');
  });

  it('这个站点上没走通过什么 → 一个字都不说', () => {
    expect(memoryText([run({ url: 'https://gitee.com/z' })], 'https://github.com/n8n-io/n8n')).toBeUndefined();
    expect(memoryText([], 'https://github.com/n8n-io/n8n')).toBeUndefined();
  });

  it('只说最近三条，步骤也只说前三步——它是提示，不是档案', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      run({ runId: `r${i}`, at: i, goal: `目标 ${i}`, steps: [1, 2, 3, 4, 5].map((n) => ({ title: `第 ${n} 步` })) }),
    );
    const text = memoryText(many, 'https://github.com/n8n-io/n8n') ?? '';
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(text).toContain('第 3 步');
    expect(text).not.toContain('第 4 步');
    // 最近的三条，不是最早的三条。
    expect(text).toContain('目标 5');
    expect(text).not.toContain('目标 0');
  });

  it('地址读不出来的记录不会把整段带歪', () => {
    expect(memoryText([run({ url: '不是地址' })], '也不是地址')).toBeUndefined();
  });
});

describe('memory 作为一个 Plugin', () => {
  it('默认开着，名字进得了 Run record', () => {
    expect([memory.name, memory.defaultOn]).toEqual(['memory', true]);
  });

  it('没有走过的路时不贡献任何一段', () => {
    expect(memory.contextFor('https://github.com/n8n-io/n8n', [])).toBeUndefined();
    expect(memory.contextFor('https://github.com/n8n-io/n8n')).toBeUndefined();
  });
});
