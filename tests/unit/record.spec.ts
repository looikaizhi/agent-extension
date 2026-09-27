import { describe, expect, it } from 'vitest';
import { buildRunRecord, judgeConfirmation, trimRecords, type RunRecord } from '@/agent/thread/record';
import { writeRunRecord } from '@/agent/thread/record-store';
import type { Ending, ThreadState } from '@/agent/thread/thread';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

const stats = {
  elementsScanned: 1, candidates: 1, visible: 1, emitted: 1, shadowRoots: 0, emptyName: 0,
  modalScoped: false, ms: { total: 1, walk: 1, visibility: 1, semantics: 1, name: 1 },
};
const TABLE: PromptTable = {
  snapshotId: 's1', url: 'https://github.com/n8n-io/n8n', title: 't', structureHash: 'h1',
  omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'link', name: 'Issues', path: [] }],
};

const thread = (o: Partial<ThreadState> = {}): ThreadState => ({
  rev: 4, goal: '看 n8n 的 issue', table: TABLE, pointedOn: TABLE, route: [{ at: '仓库页', goal: '进 Issues' }],
  steps: [], cursor: 0, history: [],
  evidence: 'model', check: 'unknown', callCount: 3, stepCalls: 0, spentSteps: 0,
    inflight: null, ...o,
});
const onScreen = (title: string) => ({ title, url: TABLE.url });
const changed = (title: string) => ({ ...onScreen(title), action: 'taken' as const, effect: { kind: 'changed_in_place' as const } });
const unchanged = (title: string) => ({ ...onScreen(title), action: 'taken' as const, effect: { kind: 'none' as const } });
const unavailable = (title: string) => ({ ...onScreen(title), action: 'unavailable' as const });

const ENDINGS = [
  'model_done', 'steps_walked', 'loop_backstop', 'quota_exhausted', 'credentials_stop',
  'user_ended', 'overlay_closed', 'tab_closed', 'superseded',
] as const satisfies readonly Ending[];

describe('judgeConfirmation — 确认了几步，只按历史算', () => {
  it('1. 每一步都 confirmed → 全部', () => {
    expect(judgeConfirmation([changed('搜索'), changed('打开仓库')])).toBe('all');
  });

  it('2. 有过 confirmed 但不是全部 → 部分', () => {
    expect(judgeConfirmation([changed('搜索'), onScreen('打开仓库')])).toBe('some');
  });

  it('3. 一个 confirmed 都没有 → 一步都没有', () => {
    expect(judgeConfirmation([onScreen('搜索'), unavailable('打开仓库')])).toBe('none');
  });

  it('4. 一步都没走过 → 一步都没有，而不是「零步全部确认」', () => {
    expect(judgeConfirmation([])).toBe('none');
  });

  it('5. 判据是「有没有非 confirmed 的一步」，不是「游标走没走到终点」', () => {
    // 计划里点名的缺陷：S1 让 skipped 和 confirmed 走同一段游标推进代码，于是
    // 「每一步都点跳过」会产出 walked 级别的最强证据——而 walked 正是「先跑通」
    // 这句承诺的地基。游标在终点，但没有任何一步被证明走通过。
    const walkedToEndButNothingConfirmed = thread({
      cursor: 3,
      steps: [{} as never, {} as never, {} as never],
      history: [onScreen('一'), onScreen('二'), onScreen('三')],
    });
    expect(judgeConfirmation(walkedToEndButNothingConfirmed.history)).toBe('none');
  });

  it('5b. 含一条 failed 的运行绝不是全部确认——「点了但没到」不是走通', () => {
    // 判据是「有没有非 confirmed 的一步」，所以 failed 天然落进「部分」或「一步
    // 都没有」，不需要为它单开一条分支。若判据哪天改成看游标位置，这条会立刻红。
    expect(judgeConfirmation([changed('搜索'), unchanged('点了没反应的按钮')])).toBe('some');
    expect(judgeConfirmation([unchanged('一'), unchanged('二')])).toBe('none');
  });
});

describe('buildRunRecord — 落进存储的摘要', () => {
  it('6. 前几步已确认、随后撞上配额 → 记为「配额用完 + 部分确认」，两件事互不推导', () => {
    const quota = thread({
      ending: 'quota_exhausted',
      history: [changed('搜索'), changed('打开仓库'), onScreen('进 Issues')],
    });
    const rec = buildRunRecord('run-q', quota, 1, 'quota_exhausted', []);
    expect(rec.ending).toBe('quota_exhausted');
    expect(rec.confirmation).toBe('some');
  });

  it('6b. 同一段历史，十种结束方式都不改变确认程度——结束方式与确认程度是两件事', () => {
    for (const ending of ENDINGS) {
      const state = thread({ history: [changed('搜索'), unchanged('打开仓库')] });
      const rec = buildRunRecord('run-e', state, 1, ending, []);
      expect(rec.ending, ending).toBe(ending);
      expect(rec.confirmation, ending).toBe('some');
    }
  });

  it('7. 带上 S3 蒸馏要用的字段：goal / route / 每步 action 与 effect / 结束方式 / 确认程度 / evidence / 开着的 Plugin', () => {
    const state = thread({ history: [changed('搜索'), onScreen('打开仓库')], evidence: 'documented' });
    const rec = buildRunRecord('run-1', state, 1_700_000_000_000, 'user_ended', ['skill']);

    expect(rec.runId).toBe('run-1');
    expect(rec.at).toBe(1_700_000_000_000);
    expect(rec.goal).toBe('看 n8n 的 issue');
    expect(rec.url).toBe(TABLE.url);
    expect(rec.route).toEqual([{ at: '仓库页', goal: '进 Issues' }]);
    expect(rec.steps).toEqual([
      { title: '搜索', action: 'taken', effect: { kind: 'changed_in_place' } },
      { title: '打开仓库' },
    ]);
    expect(rec.ending).toBe('user_ended');
    expect(rec.confirmation).toBe('some');
    expect(rec.evidence).toBe('documented');
    expect(rec.calls).toBe(3);
    expect(rec.plugins).toEqual(['skill']);
  });
});

describe('trimRecords — 蒸馏机制到来之前的软上限', () => {
  const rec = (n: number): RunRecord => ({
    runId: `r${n}`, at: n, goal: 'g', url: 'u', route: [], steps: [],
    ending: 'model_done', confirmation: 'all', evidence: 'model', check: 'unknown', calls: 1, plugins: [],
  });

  it('8. 未满 50 条时照常追加，最新的在最后', () => {
    const out = trimRecords([rec(1), rec(2)], rec(3));
    expect(out.map((r) => r.runId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('9. 已有 50 条时第 51 条到达 → 淘汰最旧的一条,总数保持 50', () => {
    const existing = Array.from({ length: 50 }, (_, i) => rec(i));
    const out = trimRecords(existing, rec(999));
    expect(out).toHaveLength(50);
    expect(out[0]?.runId).toBe('r1'); // r0 被淘汰
    expect(out.at(-1)?.runId).toBe('r999');
  });
})

describe('writeRunRecord — 写入前先查配额，不静默失败', () => {
  const store = () => {
    const data: Record<string, unknown> = {};
    return {
      data,
      get: async (k: string) => ({ [k]: data[k] }),
      set: async (o: Record<string, unknown>) => void Object.assign(data, o),
      bytesInUse: async () => JSON.stringify(data).length,
      quota: 100_000,
    };
  };

  it('10. 正常写入 → 记录落在 run:records 下，能被读回来', async () => {
    const s = store();
    const state = thread({ history: [changed('搜索')] });
    const res = await writeRunRecord(s, buildRunRecord('run-a', state, 1, 'user_ended', []));
    expect(res.ok).toBe(true);
    const back = ((await s.get('run:records')) as { 'run:records'?: RunRecord[] })['run:records'];
    expect(back?.map((r) => r.runId)).toEqual(['run-a']);
  });

  it('11. 剩余配额不足 → 返回明确错误，绝不静默丢弃这次写入', async () => {
    // §10.1 的既有纪律：任何写入都要先查配额。静默失败是最难发现的一种失败——
    // 用户会以为记录还在，S3 会以为这次运行从没发生过。
    const s = { ...store(), quota: 10 }; // 比一条记录还小
    const res = await writeRunRecord(s, buildRunRecord('run-b', thread(), 1, 'user_ended', []));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/配额|空间/);
  });

  it('12. 已有 50 条时写第 51 条 → 最旧的被淘汰，总数保持 50', async () => {
    const s = store();
    s.data['run:records'] = Array.from({ length: 50 }, (_, i) => ({
      runId: `old-${i}`, at: i, goal: 'g', url: 'u', route: [], steps: [],
      ending: 'model_done', confirmation: 'all', evidence: 'model', check: 'unknown', calls: 1, plugins: [],
    }));
    await writeRunRecord(s, buildRunRecord('run-new', thread({ history: [changed('x')] }), 9, 'user_ended', []));
    const back = (s.data['run:records'] as RunRecord[]);
    expect(back).toHaveLength(50);
    expect(back[0]?.runId).toBe('old-1');
    expect(back.at(-1)?.runId).toBe('run-new');
  });
});

describe('Run record 与确认程度：按 action × effect 记（04）', () => {
  const MOVED_TO = 'https://x.test/repo';

  it('每一步记 action 与 effect，去向随 moved 一起记下；还没定结果的一步两者都不写', () => {
    const state = thread({
      history: [
        { title: '打开仓库', url: TABLE.url, action: 'taken', effect: { kind: 'moved', to: MOVED_TO } },
        { title: '复制地址', url: TABLE.url, action: 'taken', effect: { kind: 'none' } },
        { title: '进 Issues', url: TABLE.url },
      ],
    });
    expect(buildRunRecord('r', state, 1, 'user_ended', []).steps).toEqual([
      { title: '打开仓库', action: 'taken', effect: { kind: 'moved', to: MOVED_TO } },
      { title: '复制地址', action: 'taken', effect: { kind: 'none' } },
      { title: '进 Issues' },
    ]);
  });

  it('确认了几步：执行了、页面也有变化才算；点了但这一页没变、跳过、找不到都不算', () => {
    const moved = { title: 'a', url: TABLE.url, action: 'taken' as const, effect: { kind: 'moved' as const, to: MOVED_TO } };
    const inPlace = { title: 'b', url: TABLE.url, action: 'taken' as const, effect: { kind: 'changed_in_place' as const } };
    const none = { title: 'c', url: TABLE.url, action: 'taken' as const, effect: { kind: 'none' as const } };
    // 「做了但还没结算」——没有 effect，就不算被证明过。跳过那一种已经不存在了：
    // 模型驱动的引导没有「跳过」，因为重规划会把同一步原样递回来。
    const unsettled = { title: 'd', url: TABLE.url, action: 'taken' as const };
    expect(judgeConfirmation([moved, inPlace])).toBe('all');
    expect(judgeConfirmation([moved, none])).toBe('some');
    expect(judgeConfirmation([none, unsettled])).toBe('none');
  });
});
