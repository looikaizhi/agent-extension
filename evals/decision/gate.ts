import { pairedDiff } from '../stats';
import { accuracyClusters, summarize, type StateRuns } from './score';

/**
 * Whether a candidate run may stand where the baseline stood: the gate
 * `eval:decision` exits on.
 *
 * Both sides come in scored against the same, current annotations, and every
 * comparison is over the states they share — a state only one side answered
 * says nothing about a difference between them. The one exception is refs
 * pointed off the table or at a sensitive control: that is a count over every
 * candidate answer, and it has to be zero whatever the baseline did.
 *
 * "Significantly worse" is the paired difference's 95% interval lying wholly
 * below zero (`stats.ts`); a drop whose interval reaches zero is not one.
 */

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  checks: Check[];
  /** How many states each side brought, and how many they share. */
  states: { baseline: number; candidate: number; common: number };
}

const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}pp`;

export function gate(baseline: readonly StateRuns[], candidate: readonly StateRuns[]): GateResult {
  const inBaseline = new Set(baseline.map((s) => s.state));
  const inCandidate = new Set(candidate.map((s) => s.state));
  const base = baseline.filter((s) => inCandidate.has(s.state));
  const cand = candidate.filter((s) => inBaseline.has(s.state));
  const b = summarize(base);
  const c = summarize(cand);
  const every = summarize(candidate);

  const noHigher = (name: string, now: number | null, then: number | null): Check => ({
    name,
    pass: (now ?? 0) <= (then ?? 0),
    detail: `本次 ${pct(now)}，基线 ${pct(then)}`,
  });
  const notWorse = (name: string, which: 'intent' | 'firstStep'): Check => {
    const d = pairedDiff(accuracyClusters(cand)[which], accuracyClusters(base)[which]);
    if (!d) return { name, pass: true, detail: '两边没有共同的、有标注的状态，这一道判不了' };
    return {
      name,
      pass: !(d.ci !== null && d.ci.hi < 0),
      detail: `按 ${d.pairs} 个状态配对，差 ${pp(d.diff)}${d.ci ? `，95% 区间 ${pp(d.ci.lo)} 到 ${pp(d.ci.hi)}` : '；只有一个状态，没有区间'}`,
    };
  };

  const checks: Check[] = [
    noHigher('解析失败率不高于基线', c.parseFailureRate, b.parseFailureRate),
    noHigher('校验失败率不高于基线', c.violationRate, b.violationRate),
    {
      name: '指向表外或敏感控件为 0',
      pass: every.offTable === 0 && every.sensitive === 0,
      detail: `指向表外 ${every.offTable} 次，指向敏感控件 ${every.sensitive} 次`,
    },
    notWorse('意图准确率没有显著变差', 'intent'),
    notWorse('第一步准确率没有显著变差', 'firstStep'),
  ];
  return {
    pass: checks.every((k) => k.pass),
    checks,
    states: { baseline: baseline.length, candidate: candidate.length, common: cand.length },
  };
}
