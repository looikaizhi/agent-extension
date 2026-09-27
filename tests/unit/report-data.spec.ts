import { describe, expect, it } from 'vitest';
import type { HumanVerdict } from '../../evals/task/arrival';
import { reachOf, reportData, tripKey } from '../../evals/task/report-data';
import { resultOf, type RunResults, type TripResult } from '../../evals/task/results';

/**
 * Every number a Task eval report shows, from constructed results. The
 * expectations are worked by hand from the rows below.
 */
const ISSUES = 'https://github.com/n8n-io/n8n/issues';
const trip = (id: string, pass: number, arrived: boolean, extra: Partial<TripResult> = {}): TripResult => ({
  pass,
  id,
  goal: id,
  endUrl: ISSUES,
  lastStep: { kind: 'done' },
  programmatic: { arrived, missed: arrived ? null : 'url' },
  hops: 2,
  visited: [],
  calls: 3,
  requests: 4,
  tokens: { prompt: 1000, completion: 100, cached: 400 },
  ending: 'model_done',
  confirmation: 'all',
  sensitivePointed: 0,
  shot: null,
  ...extra,
});
const runOf = (id: string, trips: TripResult[], extra: Partial<RunResults> = {}): RunResults => ({
  run: id,
  startedAt: '2026-09-14T00:00:00.000Z',
  goals: [...new Set(trips.map((t) => t.id))],
  passes: 2,
  plugins: ['skill'],
  model: { baseURL: 'https://api.example.com', model: 'm' },
  fingerprint: 'fp',
  trips,
  ...extra,
});

// Three goals, two passes. By the program: gh-issues 2/2, gh-pulls 1/2, gitee-org 0/2.
const RUN = runOf('r2', [
  trip('gh-issues', 1, true),
  trip('gh-issues', 2, true),
  trip('gh-pulls', 1, true),
  trip('gh-pulls', 2, false),
  trip('gitee-org', 1, false),
  trip('gitee-org', 2, false),
]);
const v = (entries: [string, HumanVerdict][]) => Object.fromEntries(entries);

describe('到达：没有判定时用程序化判据，有了就用你的', () => {
  it('没有判定：来源是程序化，率 = 各目标均值 (1 + 0.5 + 0) / 3', () => {
    const d = reportData({ results: RUN });
    expect(d.arrival).toMatchObject({ source: 'program', judged: 0, pending: 6, goals: 3, trips: 6 });
    expect(d.arrival.rate).toBeCloseTo(0.5, 10);
    expect(d.arrival.program).toEqual({ arrived: 3, trips: 6 });
    expect([d.agreement, d.safety.wrongLastStep, d.paired]).toEqual([null, null, null]);
  });

  it('判了一部分：只按判过的趟算，不作数不算；没判的计为 pending', () => {
    const d = reportData({
      results: RUN,
      verdicts: v([
        ['P1-gh-issues', 'arrived'],
        ['P2-gh-issues', 'wrong_last_step'],
        ['P1-gh-pulls', 'void'],
        ['P1-gitee-org', 'wrong_end'],
      ]),
    });
    // By the owner: gh-issues 1/2, gitee-org 0/1; gh-pulls has only a 不作数 and drops out.
    expect(d.arrival).toMatchObject({ source: 'owner', judged: 4, void: 1, pending: 2, goals: 2, trips: 3 });
    expect(d.arrival.rate).toBeCloseTo(0.25, 10);
    expect(d.safety.wrongLastStep).toBe(1);
  });

  it('pass^k 与分站点都按同一组簇算', () => {
    const d = reportData({ results: RUN });
    // pass^2: C(2,2)/C(2,2)=1, C(1,2)=0, 0 → 1/3.
    expect(d.arrival.passK[0]).toBeCloseTo(0.5, 10);
    expect(d.arrival.passK[1]).toBeCloseTo(1 / 3, 10);
    expect(d.arrival.passK[2]).toBeNull();
    const gh = d.arrival.bySite.find((s) => s.site === 'github.com')!;
    const gitee = d.arrival.bySite.find((s) => s.site === 'gitee.com')!;
    expect([gh.rate, gh.goals, gitee.rate, gitee.goals]).toEqual([0.75, 2, 0, 1]);
  });

  it('仪器故障的趟不进任何数，只单独计数', () => {
    const d = reportData({ results: runOf('r', [trip('gh-issues', 1, true), trip('gh-issues', 2, false, { instrumentFailure: 'Plugin 组合对不上' })]) });
    expect([d.run.instrumentFailures, d.arrival.trips, d.arrival.rate]).toEqual([1, 1, 1]);
  });
});

describe('与上一轮配对', () => {
  const PREV = runOf('r1', [trip('gh-issues', 1, false), trip('gh-issues', 2, false), trip('gh-pulls', 1, true), trip('gh-pulls', 2, true)]);

  it('没有上一轮：是 null（页面写「没有可配对的上一轮」）', () => {
    expect(reportData({ results: RUN }).paired).toBeNull();
  });

  it('按共有的目标配对；两轮没都判完时两边都用程序化判据', () => {
    const d = reportData({ results: RUN, previous: { results: PREV } });
    // gh-issues 1 − 0 = +1, gh-pulls 0.5 − 1 = −0.5 → mean +0.25; gitee-org only in this run.
    expect(d.paired).toMatchObject({ previousRun: 'r1', source: 'program' });
    expect(d.paired!.diff!.diff).toBeCloseTo(0.25, 10);
    expect([d.paired!.diff!.pairs, d.paired!.diff!.onlyA, d.paired!.diff!.onlyB]).toEqual([2, 1, 0]);
    expect(d.paired!.detectable!.z).toBeGreaterThan(0);
  });

  it('两轮都判完了，才换成你的判定来比', () => {
    const all = (r: RunResults, h: HumanVerdict) => Object.fromEntries(r.trips.map((t) => [tripKey(t), h]));
    const d = reportData({ results: RUN, verdicts: all(RUN, 'arrived'), previous: { results: PREV, verdicts: all(PREV, 'wrong_end') } });
    expect(d.paired!.source).toBe('owner');
    expect(d.paired!.diff!.diff).toBeCloseTo(1, 10);
  });

  it('两轮没有共同目标：diff 是 null', () => {
    const d = reportData({ results: RUN, previous: { results: runOf('r0', [trip('gh-ci', 1, true)]) } });
    expect(d.paired).toMatchObject({ previousRun: 'r0', diff: null, detectable: null });
  });
});

describe('花费、安全、对账', () => {
  it('成本按单价算（每百万 token）；没给单价是 null', () => {
    const priced = runOf('r', [trip('gh-issues', 1, true)], { model: { baseURL: 'x', model: 'm', price: { input: 2, cached: 0.5, output: 8 } } });
    // (1000 − 400)·2 + 400·0.5 + 100·8 = 1200 + 200 + 800 = 2200 per million.
    expect(reportData({ results: priced }).cost.cost).toBeCloseTo(0.0022, 10);
    expect(reportData({ results: RUN }).cost).toMatchObject({ hops: 12, calls: 18, requests: 24, cost: null });
  });

  it('跨站凭据停止与指向敏感控件都被计数', () => {
    const d = reportData({ results: runOf('r', [trip('gh-issues', 1, false, { ending: 'credentials_stop', sensitivePointed: 1 }), trip('gh-issues', 2, true)]) });
    expect(d.safety).toEqual({ wrongLastStep: null, sensitivePointed: 1, credentialStops: 1 });
  });

  it('对账：以你为准，不作数不计', () => {
    const d = reportData({
      results: RUN,
      verdicts: v([
        ['P1-gh-issues', 'arrived'], // program arrived → tp
        ['P2-gh-pulls', 'arrived'], // program not → fn
        ['P1-gh-pulls', 'wrong_last_step'], // program arrived → fp
        ['P1-gitee-org', 'wrong_end'], // program not → tn
        ['P2-gitee-org', 'void'],
      ]),
    });
    expect(d.agreement).toMatchObject({ judged: 4, void: 1, tp: 1, fp: 1, fn: 1, tn: 1, agreement: 0.5 });
  });
});

describe('按 URL 分三类（给你判定时参考，不是分数）', () => {
  it('停在目标、踩到过又走开、从没到过', () => {
    expect(reachOf(trip('gh-issues', 1, true))).toBe('stayed');
    expect(reachOf(trip('gh-issues', 1, false, { endUrl: 'https://github.com/n8n-io/n8n', visited: [ISSUES, 'https://github.com/n8n-io/n8n'] }))).toBe('passed');
    expect(reachOf(trip('gh-issues', 1, false, { endUrl: 'https://github.com/issues/assigned', visited: ['https://github.com/issues/assigned'] }))).toBe('never');
  });
});

describe('一趟的结果从日志行和调用行来', () => {
  const row = {
    pass: 1,
    id: 'gh-issues',
    goal: '看 issue',
    endUrl: ISSUES,
    lastStep: { kind: 'done' as const },
    verdict: { arrived: true, missed: null },
    hops: [{ urlAfter: 'https://github.com/search?q=n8n' }, { urlAfter: ISSUES }],
    record: { calls: 3, ending: 'model_done', confirmation: 'all' },
  };
  const table = { items: [{ ref: 'e1' }, { ref: 'e2', sensitive: true as const }] };
  // Written the way the endpoint returns them and read by the product's parser.
  const call = (tool: string | undefined, value: string) => ({
    params: { table },
    outcome: { ok: true, tool, value, usage: { prompt: 10, completion: 2, cachedPrompt: 4 } },
  });
  const point = (ref: string) =>
    JSON.stringify({
      previous_step: 'first_plan',
      route: [{ at: '仓库主页', goal: '打开 issue 列表' }],
      why: '这一步通向目标',
      ref,
      action: 'click',
      value: null,
      expect_after: null,
    });
  const done = JSON.stringify({ evidence: 'content_on_page', why: '要看的东西已经在这一页上' });
  const ask = (...refs: string[]) => JSON.stringify({ question: '你指的是哪一个？', wants: 'choice', options: refs.map((ref) => ({ ref, label: ref })) });

  it('每跳之后的地址、调用数、token（日志行没记就从调用加起来）、最后一帧', () => {
    const r = resultOf(row, [call('point', point('e1')), call('done', done)], '07-P1ghissues-2.png');
    expect(r).toMatchObject({ visited: ['https://github.com/search?q=n8n', ISSUES], hops: 2, calls: 2, requests: 3, shot: '07-P1ghissues-2.png' });
    expect(r.tokens).toEqual({ prompt: 20, completion: 4, cached: 8 });
    expect(r.sensitivePointed).toBe(0);
  });

  it('回答指向敏感控件（那一步、ask 候选）才计数；被拒掉的回答不计', () => {
    const refused = { params: { table }, outcome: { ok: false } };
    const r = resultOf(row, [call('point', point('e2')), call('ask', ask('e2')), refused]);
    expect(r.sensitivePointed).toBe(2);
  });

  it('没走工具的回答读不出来，也就不计数——那条散文兜底已经删了', () => {
    // 产品不再有第二种读法：intent 就是端点报回来的函数名。真机语料 165 条里
    // 零条回答是没有工具调用来的，所以这里数出 0 不是漏算，是如实。
    const fenced = '```json\n' + JSON.stringify({ intent: 'ask', ...JSON.parse(ask('e1', 'e2')) }) + '\n```';
    expect(resultOf(row, [call(undefined, fenced)]).sensitivePointed).toBe(0);
  });
});
