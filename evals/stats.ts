/**
 * The statistics both evals report, as pure functions.
 *
 * One input shape for both layers: a cluster ran `n` times and succeeded `c`
 * times. In a Task eval a cluster is a goal; in a Decision eval it is a state.
 * The runs inside one cluster are not independent — a goal is as hard on the
 * third pass as on the first — so every standard error here is taken over
 * cluster means, never over the pooled trials (Miller §3.1; formulas and
 * sources in §4 of the evaluation-metrics research note, kept outside this
 * repository). Treating run 6's
 * 21 trials as 21 independent samples puts its standard error at 11.2 points;
 * over its 7 goals it is 16.0.
 *
 * Critical values are z = 1.96 throughout, the way that note's §5.6 computed
 * its paired interval. Student's t appears only in `minDetectable`, where with
 * seven clusters the difference is worth showing.
 *
 * No imports, so no I/O and nothing from the product: the tests check these
 * functions against numbers computed independently from runs six and seven,
 * and nothing else should be able to move them.
 */

export interface Cluster {
  /** The goal or the state — what pairs one run with another. */
  id: string;
  /** Trials that count. A trial judged 不作数 is not one of them, and a
   *  cluster left with none is dropped by the caller, not passed as `n: 0`. */
  n: number;
  /** Of those trials, the successes. */
  c: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

/** z for a two-sided 95% interval. */
export const Z_95 = 1.959963984540054;
/** z for 80% power. */
const Z_80 = 0.8416212335729143;

/** Throws on anything that is not a count: a rate computed from nonsense
 *  would still print as a percentage. */
function check(clusters: readonly Cluster[]): void {
  const seen = new Set<string>();
  for (const k of clusters) {
    if (!Number.isInteger(k.n) || !Number.isInteger(k.c) || k.n < 1 || k.c < 0 || k.c > k.n)
      throw new RangeError(`簇 ${k.id}：n=${k.n}、c=${k.c} 不是一组合法的次数（要求 n ≥ 1、0 ≤ c ≤ n）`);
    if (seen.has(k.id)) throw new RangeError(`簇 ${k.id} 出现了两次：配对与聚类都按 id 认簇`);
    seen.add(k.id);
  }
}

/** Wilson score interval for a rate `p` observed over `n` trials. `n` need
 *  not be whole — `clusteredWilson` passes an effective sample size. */
function wilsonAt(p: number, n: number): Interval {
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At p = 0 the lower bound is exactly 0 and at p = 1 the upper bound exactly
  // 1; floating point lands a rounding error short of either.
  return { lo: p === 0 ? 0 : Math.max(0, centre - half), hi: p === 1 ? 1 : Math.min(1, centre + half) };
}

/**
 * Wilson interval for `c` successes in `n` trials, treated as independent.
 * Stays inside [0, 1] and holds up at small `n` and at rates near 0 or 1,
 * where the normal approximation does neither.
 */
export function wilson(c: number, n: number): Interval {
  check([{ id: 'wilson', n, c }]);
  return wilsonAt(c / n, n);
}

/** Mean, and its standard error with n − 1 in the variance; `null` for a
 *  single value, which has no spread to measure. */
function meanAndSe(xs: readonly number[]): { mean: number; se: number | null } {
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  if (xs.length < 2) return { mean, se: null };
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  return { mean, se: Math.sqrt(ss / (xs.length - 1) / xs.length) };
}

export interface ClusterRate {
  /** The mean of the cluster means — equal to the pooled rate when every
   *  cluster ran equally often, and the one that stays fair when not. */
  rate: number;
  /** Standard error over the cluster means; `null` with one cluster. */
  se: number | null;
  clusters: number;
  trials: number;
}

export function clusterRate(clusters: readonly Cluster[]): ClusterRate {
  check(clusters);
  if (!clusters.length) throw new RangeError('没有簇：成功率无从谈起');
  const { mean, se } = meanAndSe(clusters.map((k) => k.c / k.n));
  return { rate: mean, se, clusters: clusters.length, trials: clusters.reduce((a, k) => a + k.n, 0) };
}

/**
 * Wilson interval that knows the trials come in clusters.
 *
 * Inspect's `ci_wilson` does this with the Korn–Graubard effective sample
 * size: the number of independent trials that would give the observed
 * variance, p(1 − p) / v̂, capped at the real number of trials. Here v̂ is the
 * square of `clusterRate`'s standard error. Unlike Inspect, the critical value
 * stays z — see the header.
 *
 * With no spread between cluster means (every goal arrived equally often,
 * including never or always) the effective size is 0/0 or x/0; the trials
 * are the only sample size left. `null` with one cluster.
 */
export function clusteredWilson(clusters: readonly Cluster[]): Interval | null {
  const { rate, se, trials } = clusterRate(clusters);
  if (se === null) return null;
  const v = se * se;
  const nEff = v === 0 ? trials : Math.min(trials, (rate * (1 - rate)) / v);
  return wilsonAt(rate, nEff);
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export interface PassK {
  /** `null` when no cluster ran at least `k` times. */
  value: number | null;
  /** Clusters that entered the mean. */
  clusters: number;
  /** Clusters that ran fewer than `k` times: the estimator is undefined for
   *  them, so they are left out and counted here rather than scored. */
  skipped: number;
}

function passK(clusters: readonly Cluster[], k: number, perCluster: (x: Cluster) => number): PassK {
  check(clusters);
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k=${k}：要求正整数`);
  const used = clusters.filter((x) => x.n >= k);
  const value = used.length ? used.reduce((a, x) => a + perCluster(x), 0) / used.length : null;
  return { value, clusters: used.length, skipped: clusters.length - used.length };
}

/**
 * pass^k (τ-bench): the chance that `k` runs of the same cluster all
 * succeed, averaged over clusters — C(c, k) / C(n, k) per cluster. The number
 * a user who meets the guide more than once lives with.
 */
export function passHatK(clusters: readonly Cluster[], k: number): PassK {
  return passK(clusters, k, (x) => choose(x.c, k) / choose(x.n, k));
}

/**
 * pass@k (Codex): the chance that at least one of `k` runs succeeds. A user
 * sees one run, never k, so this is a ceiling on capability, not a product
 * number.
 */
export function passAtK(clusters: readonly Cluster[], k: number): PassK {
  return passK(clusters, k, (x) => 1 - choose(x.n - x.c, k) / choose(x.n, k));
}

export interface PairedDiff {
  /** Mean over paired clusters of (rate in `a`) − (rate in `b`). */
  diff: number;
  /** Paired standard error (Miller eq. 7); `null` with one pair. */
  se: number | null;
  ci: Interval | null;
  pairs: number;
  /** Clusters in only one of the two runs — not compared, only counted. */
  onlyA: number;
  onlyB: number;
}

/**
 * Two versions compared cluster by cluster. Pairing removes what the two runs
 * agree on — which goals are hard — from the error, which is why it separates
 * differences an unpaired comparison cannot. Only clusters present in both are
 * paired. `null` when there is none.
 */
export function pairedDiff(a: readonly Cluster[], b: readonly Cluster[]): PairedDiff | null {
  check(a);
  check(b);
  const inB = new Map(b.map((x) => [x.id, x]));
  const d: number[] = [];
  for (const x of a) {
    const y = inB.get(x.id);
    if (y) d.push(x.c / x.n - y.c / y.n);
  }
  if (!d.length) return null;
  const { mean, se } = meanAndSe(d);
  return {
    diff: mean,
    se,
    ci: se === null ? null : { lo: mean - Z_95 * se, hi: mean + Z_95 * se },
    pairs: d.length,
    onlyA: a.length - d.length,
    onlyB: b.length - d.length,
  };
}

/**
 * The smallest difference a paired comparison with standard error `se` would
 * detect at α = 0.05 and 80% power (Miller eq. 10). Reported twice: with z,
 * and with t on clusters − 1 degrees of freedom, which is what a handful of
 * clusters honestly supports. `t` is `null` with fewer than two clusters.
 */
export function minDetectable(se: number, clusters: number): { z: number; t: number | null } {
  const t = clusters < 2 ? null : (tQuantile(0.975, clusters - 1) + tQuantile(0.8, clusters - 1)) * se;
  return { z: (Z_95 + Z_80) * se, t };
}

/* ═══════════ Student's t, for `minDetectable` ═══════════
 *
 * The regularized incomplete beta by its continued fraction (modified Lentz),
 * the t distribution through it, and the quantile by bisection. A library for
 * one quantile would be the only statistics dependency in the repository.
 */

/** ln Γ(x) for x > 0, Lanczos approximation (g = 7, nine terms). */
function lnGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const y = x - 1;
  let a = g[0]!;
  for (let i = 1; i < g.length; i++) a += g[i]! / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  const guard = (v: number) => (Math.abs(v) < TINY ? TINY : v);
  let c = 1;
  let d = 1 / guard(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 / guard(1 + even * d);
    c = guard(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 / guard(1 + odd * d);
    c = guard(1 + odd / c);
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges fast only on one side of the mean; use the symmetry
  // I_x(a, b) = 1 − I_{1−x}(b, a) on the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

function tCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** The `p` quantile of Student's t with `df` degrees of freedom. */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) throw new RangeError(`tQuantile(${p}, ${df})：要求 0 < p < 1、df > 0`);
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
