import { describe, expect, it } from 'vitest';
import { annotationFrom, checkedAnnotations, docIdOf, keysFromAnswers } from '../../evals/decision/annotations';
import type { State } from '../../evals/decision/corpus';
import * as select from '../../evals/decision/select';
import { TABLES } from './fixtures/golden-guide-envelopes';

/**
 * Picking a labelled batch, and reading the owner's labels back.
 */
const make = (site: string, position: select.Position, intent: string, n: number): select.Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${site}/${position}/${intent}/${i}`, site, position, intent }));

// github: mostly middle-of-journey point, one ask. gitee: runs out after 6.
// aliyun: two read_doc among many point.
const POOL = [
  ...make('github.com', 'middle', 'point', 100),
  ...make('github.com', 'opening', 'point', 10),
  ...make('github.com', 'end', 'done', 8),
  ...make('github.com', 'middle', 'ask', 1),
  ...make('gitee.com', 'opening', 'point', 4),
  ...make('gitee.com', 'end', 'done', 2),
  ...make('help.aliyun.com', 'middle', 'point', 40),
  ...make('help.aliyun.com', 'opening', 'read_doc', 2),
  ...make('help.aliyun.com', 'end', 'done', 10),
];
const site = (ids: string[], s: string) => ids.filter((id) => id.startsWith(`${s}/`));

describe('挑一批：按规则，重跑挑出同一批', () => {
  const ids = select.selectBatch(POOL, 30);

  it('三个站点平分；gitee 只有 6 个，剩下的名额由另两个站点平分', () => {
    expect(ids).toHaveLength(30);
    expect([site(ids, 'gitee.com').length, site(ids, 'github.com').length, site(ids, 'help.aliyun.com').length]).toEqual([6, 12, 12]);
  });

  it('站点内轮流从各组取：开局、临近终点、少见的回答都挑得到', () => {
    const gh = site(ids, 'github.com');
    expect(gh.some((id) => id.includes('/opening/'))).toBe(true);
    expect(gh.some((id) => id.includes('/end/done/'))).toBe(true);
    expect(gh).toContain('github.com/middle/ask/0');
    expect(site(ids, 'help.aliyun.com').filter((id) => id.includes('/read_doc/'))).toHaveLength(2);
    // 100 middle-point github states do not crowd the rest out.
    expect(gh.filter((id) => id.includes('/middle/point/')).length).toBeLessThanOrEqual(4);
  });

  it('输入顺序打乱，挑出的仍是同一批；要的比有的多，就全给', () => {
    expect(select.selectBatch([...POOL].reverse(), 30)).toEqual(ids);
    expect(select.selectBatch(POOL, 1000)).toHaveLength(POOL.length);
  });
});

describe('每个状态的位置与当时的回答', () => {
  const state = (hop: number, pass: number, answer: State['answer']): State =>
    ({
      id: `r/gh-issues/P${pass}/${hop}`,
      run: 'r',
      goal: 'gh-issues',
      pass,
      hop,
      seq: hop,
      fingerprint: 'fp',
      context: { goal: '看 issue', table: { ...TABLES.route, url: 'https://github.com/n8n-io/n8n' }, history: { done: [], route: [] } },
      plugins: [],
      contributions: [],
      sent: { system: '', tools: '', user: '' },
      answer,
    }) as State;
  const done = { ok: true as const, tool: 'done', value: JSON.stringify({ evidence: 'content_on_page', why: '已经在这一页' }), providerCalls: 1 };

  it('第 0 跳是开局，一趟最后一跳是临近终点，其余是中途；只有一跳的算开局', () => {
    const got = select.describe([state(0, 1, null), state(1, 1, null), state(2, 1, done), state(0, 2, null)]);
    expect(got.map((c) => [c.id, c.position, c.intent, c.site])).toEqual([
      ['r/gh-issues/P1/0', 'opening', 'none', 'github.com'],
      ['r/gh-issues/P1/1', 'middle', 'none', 'github.com'],
      ['r/gh-issues/P1/2', 'end', 'done', 'github.com'],
      ['r/gh-issues/P2/0', 'opening', 'none', 'github.com'],
    ]);
  });
});

describe('标注拉回：读数据库文档，对着元素表核对', () => {
  const S = (id: string, table = TABLES.route) => ({ id, context: { table } }) as unknown as State;
  const states = [S('r/a/P1/1'), S('r/b/P1/2', TABLES.sensitive)];

  it('文档可以是正文，也可以带着元数据包一层；不是 point 的不留那一步', () => {
    expect(annotationFrom({ data: { state: 'r/a/P1/1', intents: ['done'], acceptable: [{ ref: 'e5', actions: ['click'] }] } })).toEqual({ state: 'r/a/P1/1', intents: ['done'] });
    expect(annotationFrom({ state: 'r/a/P1/1', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click', 'input'] }] })).toEqual({
      state: 'r/a/P1/1',
      intents: ['point'],
      acceptable: [{ ref: 'e5', actions: ['click', 'input'] }],
    });
  });

  it('意图不认识、动作不认识、一步没有动作：报错', () => {
    // `explain` 从 2026-09-22 起是一等意图，所以这里拿一个真的不能当答案的来试：
    // `observe` 是模型的工具，不是一次答复。
    expect(() => annotationFrom({ state: 'x', intents: ['observe'] })).toThrow(/意图/);
    expect(() => annotationFrom({ state: 'x', intents: [] })).toThrow(/一个正确意图都没有/);
    expect(() => annotationFrom({ state: 'x', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['hover'] }] })).toThrow(RangeError);
    expect(() => annotationFrom({ state: 'x', intents: ['point'], acceptable: [{ ref: 'e5', actions: [] }] })).toThrow(RangeError);
  });

  it('表外的 ref、敏感控件、point 却一步没勾、语料里没有的状态：整批报错', () => {
    expect(() => checkedAnnotations([{ state: 'r/a/P1/1', intents: ['point'], acceptable: [{ ref: 'e99', actions: ['click'] }] }], states)).toThrow(/不在/);
    expect(() => checkedAnnotations([{ state: 'r/b/P1/2', intents: ['point'], acceptable: [{ ref: 'e6', actions: ['input'] }] }], states)).toThrow(/敏感/);
    expect(() => checkedAnnotations([{ state: 'r/a/P1/1', intents: ['point'], acceptable: [] }], states)).toThrow(RangeError);
    expect(() => checkedAnnotations([{ state: 'r/zzz/P1/1', intents: ['done'] }], states)).toThrow(/没有这个状态/);
  });

  it('从「到了」的趟生成标准答案：意图照当时，指路时收当时那一步；没回答、读不出、别的 agent 的都跳过', () => {
    const answered = (id: string, tool: string | undefined, value: string, table = TABLES.route) =>
      ({ ...S(id, table), answer: { ok: true, tool, value, providerCalls: 1 } }) as unknown as State;
    const point = JSON.stringify({
      previous_step: 'first_plan',
      route: [{ at: '仓库主页', goal: '打开设置' }],
      why: '设置在这里',
      ref: 'e5',
      action: 'click',
      value: null,
      expect_after: null,
    });
    const done = JSON.stringify({ evidence: 'content_on_page', why: '已经在这一页' });
    const { annotations, skipped } = keysFromAnswers([
      answered('r/b/P1/2', 'done', done),
      answered('r/a/P1/1', 'point', point),
      { ...S('r/c/P1/3'), answer: null } as unknown as State,
      answered('r/d/P1/4', 'point', 'not json'),
      // 当时答了 explain 的那一跳，现在也能当标准答案——这一条正是加 explain 的目的。
      answered('r/e/P1/5', 'explain', JSON.stringify({ answer: '设置在右上角', refs: [] })),
    ]);
    expect(annotations).toEqual([
      { state: 'r/a/P1/1', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click'] }] },
      { state: 'r/b/P1/2', intents: ['done'] },
      { state: 'r/e/P1/5', intents: ['explain'] },
    ]);
    expect(skipped.map((s) => s.state)).toEqual(['r/c/P1/3', 'r/d/P1/4']);
  });

  it('全部合法：按状态排好返回；文档 id 把 / 换成 ~', () => {
    const got = checkedAnnotations(
      [
        { state: 'r/b/P1/2', intents: ['done'] },
        { state: 'r/a/P1/1', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click'] }] },
      ],
      states,
    );
    expect(got.map((a) => a.state)).toEqual(['r/a/P1/1', 'r/b/P1/2']);
    expect(docIdOf('t11/gh-issues/P1/3')).toBe('t11~gh-issues~P1~3');
  });
});
