import { describe, expect, it } from 'vitest';
import {
  clusterRate,
  clusteredWilson,
  minDetectable,
  pairedDiff,
  passAtK,
  passHatK,
  tQuantile,
  wilson,
  type Cluster,
} from '../../evals/stats';

/**
 * Checked against numbers nobody computed with this file.
 *
 * The data: of three passes per goal, how many arrived by the harness's URL
 * test (`arrived`), counted once from the run-six and run-seven logs in
 * `tests/spike/`. The expected values are the ones
 * `docs/research-agent-evaluation-metrics.md` §5.6 computed from those same
 * two logs with τ-bench's and Miller's formulas, before this file existed.
 * Where that report gives no number (the clustered Wilson interval, the edge
 * cases), the expectation is worked by hand below, or is a textbook value.
 */
const GOALS = ['repo-address', 'issues', 'license', 'releases', 'contributing', 'docs-site', 'ci'];
const run = (successes: number[]): Cluster[] => successes.map((c, i) => ({ id: GOALS[i]!, n: 3, c }));
const RUN6 = run([2, 3, 0, 2, 1, 0, 3]); // 11/21
const RUN7 = run([2, 2, 0, 2, 1, 0, 1]); // 8/21

/** Percentage points to one decimal, the precision the report prints. */
const pp = (x: number) => Math.round(x * 1000) / 10;

describe('第六、七轮：与研究报告第 5.6 节逐项一致', () => {
  it('Wilson 区间：11/21 为 32.4%–71.7%，8/21 为 20.8%–59.1%', () => {
    const six = wilson(11, 21);
    const seven = wilson(8, 21);
    expect([pp(six.lo), pp(six.hi)]).toEqual([32.4, 71.7]);
    expect([pp(seven.lo), pp(seven.hi)]).toEqual([20.8, 59.1]);
  });

  it('按目标聚类：成功率 52.4% / 38.1%，目标均值上的 SE 16.0pp / 11.3pp', () => {
    const six = clusterRate(RUN6);
    const seven = clusterRate(RUN7);
    expect([pp(six.rate), pp(six.se!)]).toEqual([52.4, 16.0]);
    expect([pp(seven.rate), pp(seven.se!)]).toEqual([38.1, 11.3]);
    expect([six.clusters, six.trials]).toEqual([7, 21]);
  });

  it('pass^1/2/3：第六轮 0.524 / 0.381 / 0.286，第七轮 0.381 / 0.143 / 0.000；第七轮 pass@3 为 0.714', () => {
    const r3 = (x: number | null) => Math.round(x! * 1000) / 1000;
    expect([1, 2, 3].map((k) => r3(passHatK(RUN6, k).value))).toEqual([0.524, 0.381, 0.286]);
    expect([1, 2, 3].map((k) => r3(passHatK(RUN7, k).value))).toEqual([0.381, 0.143, 0]);
    expect(r3(passAtK(RUN7, 3).value)).toBe(0.714);
    expect(r3(passAtK(RUN6, 3).value)).toBe(0.714);
  });

  it('按目标配对（第六轮 − 第七轮）：+14.3pp，配对 SE 9.9pp，95% 区间 (−5.1, +33.7)', () => {
    const d = pairedDiff(RUN6, RUN7)!;
    expect([pp(d.diff), pp(d.se!), pp(d.ci!.lo), pp(d.ci!.hi)]).toEqual([14.3, 9.9, -5.1, 33.7]);
    expect([d.pairs, d.onlyA, d.onlyB]).toEqual([7, 0, 0]);
  });

  it('最小可检出差距：约 28pp（z）与约 33pp（t，自由度 6）', () => {
    const d = pairedDiff(RUN6, RUN7)!;
    const m = minDetectable(d.se!, d.pairs);
    expect(Math.round(m.z * 100)).toBe(28);
    expect(Math.round(m.t! * 100)).toBe(33);
  });

  it('聚类 Wilson：有效样本量 p(1−p)/SE²，按手算核对', () => {
    // Run six. Cluster means 2/3, 1, 0, 2/3, 1/3, 0, 1; their squares sum to 3,
    // and 7·(11/21)² = 121/63, so the sum of squared deviations is 68/63.
    // SE² = (68/63) / 6 / 7 = 68/2646 (16.0pp); p(1 − p) = 110/441 = 660/2646.
    // n_eff = 660/68 ≈ 9.706 (< 21, no cap). Wilson at p = 11/21, n = 9.706:
    //   z²/n = 0.39579, centre = (0.52381 + 0.19789) / 1.39579 = 0.51706,
    //   half = 1.95996 · √(0.025699 + 0.010195) / 1.39579 = 0.26604
    //   → 0.2510 – 0.7831.
    const six = clusteredWilson(RUN6)!;
    expect(six.lo).toBeCloseTo(0.251, 3);
    expect(six.hi).toBeCloseTo(0.7831, 3);
    // Run seven. Squares sum to 14/9, 7·(8/21)² = 64/63, deviations 34/63.
    // SE² = 34/2646 (11.3pp); p(1 − p) = 104/441 = 624/2646; n_eff = 624/34 ≈ 18.35.
    //   z²/n = 0.20931, centre = (0.38095 + 0.10466) / 1.20931 = 0.40156,
    //   half = 1.95996 · √(0.012850 + 0.002851) / 1.20931 = 0.20308
    //   → 0.1985 – 0.6046.
    const seven = clusteredWilson(RUN7)!;
    expect(seven.lo).toBeCloseTo(0.1985, 3);
    expect(seven.hi).toBeCloseTo(0.6046, 3);
    // Wider than the interval that pretends the 21 trials are independent.
    expect(six.hi - six.lo).toBeGreaterThan(wilson(11, 21).hi - wilson(11, 21).lo);
  });
});

describe('Student t 分位数：与 t 分布表一致', () => {
  it.each([
    [0.975, 1, 12.706],
    [0.975, 6, 2.447],
    [0.8, 6, 0.906],
    [0.975, 30, 2.042],
    [0.8, 1e6, 0.842],
    [0.025, 6, -2.447],
  ])('t(%s, df=%s) = %s', (p, df, expected) => {
    expect(tQuantile(p, df)).toBeCloseTo(expected, 3);
  });
});

describe('边界情况', () => {
  it('0 次成功：下界是 0；全部成功：上界是 1（0/10 的 Wilson 上界是教科书值 0.2775）', () => {
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(0, 10).hi).toBeCloseTo(0.2775, 4);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(10, 10).lo).toBeCloseTo(0.7225, 4);
  });

  it('簇均值没有差别（全没到、全到了）：有效样本量退回总遍数', () => {
    const never = run([0, 0, 0]);
    expect(clusterRate(never)).toEqual({ rate: 0, se: 0, clusters: 3, trials: 9 });
    expect(clusteredWilson(never)).toEqual(wilson(0, 9));
    expect(clusteredWilson(run([3, 3, 3]))).toEqual(wilson(9, 9));
  });

  it('簇之间比独立试验还整齐时，有效样本量封顶在总遍数', () => {
    // Means 1/3, 2/3, 1/3, 2/3: p = 1/2, SE² = (4 · (1/6)² / 3) / 4 = 1/108,
    // so p(1 − p) / SE² = 27 — more independent trials than the 12 that ran.
    expect(clusteredWilson(run([1, 2, 1, 2]))).toEqual(wilson(6, 12));
  });

  it('只有一个簇：SE、聚类区间、配对 SE 与 t 版的可检出差距都算不出（null），不报 0', () => {
    const one = [{ id: 'only', n: 3, c: 2 }];
    expect(clusterRate(one).se).toBeNull();
    expect(clusteredWilson(one)).toBeNull();
    const d = pairedDiff(one, [{ id: 'only', n: 3, c: 1 }])!;
    expect(d.diff).toBeCloseTo(1 / 3, 10);
    expect([d.se, d.ci]).toEqual([null, null]);
    expect(minDetectable(0.1, 1).t).toBeNull();
  });

  it('n < k 的簇不进 pass^k，被单独计数；没有一个簇够 k 遍时是 null', () => {
    const mixed = [
      { id: 'a', n: 2, c: 2 },
      { id: 'b', n: 3, c: 3 },
    ];
    expect(passHatK(mixed, 3)).toEqual({ value: 1, clusters: 1, skipped: 1 });
    expect(passHatK([{ id: 'a', n: 2, c: 2 }], 3)).toEqual({ value: null, clusters: 0, skipped: 1 });
  });

  it('两边没有共同的簇：配对是 null；只有一边有的簇不配对，只计数', () => {
    expect(pairedDiff(run([1, 2]), [{ id: 'elsewhere', n: 3, c: 1 }])).toBeNull();
    const d = pairedDiff(RUN6, RUN7.slice(0, 5))!;
    expect([d.pairs, d.onlyA, d.onlyB]).toEqual([5, 2, 0]);
  });

  it('不是一组合法次数的输入直接报错，不算出一个像样的百分比', () => {
    expect(() => wilson(4, 3)).toThrow(RangeError);
    expect(() => clusterRate([{ id: 'x', n: 0, c: 0 }])).toThrow(RangeError);
    expect(() => clusterRate([{ id: 'x', n: 3, c: 1.5 }])).toThrow(RangeError);
    expect(() => clusterRate([])).toThrow(RangeError);
    expect(() => pairedDiff(run([1, 1]), [...run([1]), ...run([2])])).toThrow(RangeError);
    expect(() => passHatK(RUN6, 0)).toThrow(RangeError);
  });
});
