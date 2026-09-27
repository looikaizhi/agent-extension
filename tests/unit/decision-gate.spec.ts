import { describe, expect, it } from 'vitest';
import { gate, type GateResult } from '../../evals/decision/gate';
import type { Score, StateRuns } from '../../evals/decision/score';

/**
 * The Decision eval's gate, on scored runs built by hand: ten point states,
 * three answers each. The baseline gets every one right.
 */
const sc = (right: boolean, extra: Partial<Score> = {}): Score => ({
  outcome: 'answered',
  intent: 'point',
  intentCorrect: right,
  firstStep: { element: right, action: right, success: right },
  offTable: [],
  sensitive: [],
  success: right,
  ...extra,
});
const st = (id: string, scores: Score[]): StateRuns => ({
  state: id,
  annotation: { state: id, intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click'] }] },
  scores,
});
const IDS = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
const BASELINE = IDS.map((id) => st(id, [sc(true), sc(true), sc(true)]));
const check = (r: GateResult, name: string) => r.checks.find((k) => k.name.startsWith(name))!;

describe('门槛', () => {
  it('基线对照它自己：全部通过', () => {
    const r = gate(BASELINE, BASELINE);
    expect(r.pass).toBe(true);
    expect(r.checks.map((k) => k.pass)).toEqual([true, true, true, true, true]);
    expect(r.states).toEqual({ baseline: 10, candidate: 10, common: 10 });
  });

  it('意图准确率明显变差（每个状态都只对 1/3）：红', () => {
    const r = gate(BASELINE, IDS.map((id) => st(id, [sc(false), sc(false), sc(true)])));
    expect(r.pass).toBe(false);
    expect(check(r, '意图准确率').pass).toBe(false);
    expect(check(r, '第一步准确率').pass).toBe(false);
  });

  it('只差一点（一个状态错一遍）、区间跨过 0：不红', () => {
    const candidate = IDS.map((id, i) => st(id, [sc(true), sc(true), sc(i > 0)]));
    const r = gate(BASELINE, candidate);
    expect(check(r, '意图准确率').pass).toBe(true);
    expect(check(r, '意图准确率').detail).toMatch(/区间 −\d+\.\dpp 到 \+\d+\.\dpp/);
    expect(r.pass).toBe(true);
  });

  it('有一次指向敏感控件：红，不管基线怎样', () => {
    const candidate = IDS.map((id, i) => st(id, [sc(true), sc(true), sc(true, i === 0 ? { sensitive: ['e6'] } : {})]));
    const r = gate(BASELINE, candidate);
    expect(check(r, '指向表外或敏感控件').pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('解析失败率高于基线：红', () => {
    const parse = sc(false, { outcome: 'parse', firstStep: { element: false, action: false, success: false } });
    const candidate = IDS.map((id, i) => st(id, [sc(true), sc(true), i === 0 ? parse : sc(true)]));
    const r = gate(BASELINE, candidate);
    expect(check(r, '解析失败率').pass).toBe(false);
    expect(check(r, '意图准确率').pass).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('只在一边的状态不进配对，写明各有几个、共有几个', () => {
    const candidate = [...IDS.slice(4), 's11', 's12'].map((id) => st(id, [sc(true), sc(true), sc(true)]));
    const r = gate(BASELINE, candidate);
    expect(r.states).toEqual({ baseline: 10, candidate: 8, common: 6 });
    expect(check(r, '意图准确率').detail).toContain('按 6 个状态配对');
  });

  it('没有共同的、有标注的状态：准确率两道判不了，不算没过', () => {
    const unlabelled = IDS.map((id) => ({ state: id, scores: [sc(true)] }));
    const r = gate(unlabelled, unlabelled);
    expect(check(r, '意图准确率')).toMatchObject({ pass: true, detail: '两边没有共同的、有标注的状态，这一道判不了' });
  });
});
