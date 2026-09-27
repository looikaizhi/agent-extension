import { describe, expect, it } from 'vitest';
import { scoreAnswer, summarize, type Annotation, type Answer, type Score } from '../../evals/decision/score';
import { TABLES } from './fixtures/golden-guide-envelopes';

/**
 * Decision eval scoring, one answer at a time and then per state.
 *
 * Answers are written the way the endpoint returns them — a tool name and its
 * arguments text — and read by the product's own parser. Annotations are
 * picked from the element table by hand, never produced by the function under
 * test (the golden corpus's rule).
 */
const ROUTE = TABLES.route; // repo home: e1 Code … e5 Settings, e8 help link; nothing sensitive
const SENSITIVE = TABLES.sensitive; // account security: e6–e8, e10, e11 sensitive; e9 「更新密码」

const point = (s: { ref: string; action: string }): Answer => ({
  tool: 'point',
  raw: JSON.stringify({
    previous_step: 'first_plan',
    route: [{ at: '仓库设置页', goal: '把仓库改成 private' }],
    why: '这一步通向目标',
    ref: s.ref,
    action: s.action,
    value: null,
    expect_after: null,
  }),
});
const done: Answer = { tool: 'done', raw: JSON.stringify({ evidence: 'content_on_page', why: '要看的东西已经在这一页上' }) };
const explain = (...refs: string[]): Answer =>
  ({ tool: 'explain', raw: JSON.stringify({ answer: '这个按钮用来新建实例', refs }) }) as Answer;
const ask = (...refs: string[]): Answer => ({
  tool: 'ask',
  raw: JSON.stringify({ question: '你指的是哪一个？', wants: 'choice', options: refs.map((ref) => ({ ref, label: ref })) }),
});

/** "Make this repository private": the way in is Settings. */
const TO_SETTINGS: Annotation = { state: 's-settings', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click'] }] };

describe('这一步：元素与动作分开判', () => {
  it('元素和动作都在可接受集合里：步骤成功', () => {
    const s = scoreAnswer(ROUTE, point({ ref: 'e5', action: 'click' }), TO_SETTINGS);
    expect(s).toMatchObject({ outcome: 'answered', intent: 'point', intentCorrect: true, success: true });
    expect(s.firstStep).toEqual({ element: true, action: true, success: true });
  });

  it('元素对、动作错：不成功', () => {
    expect(scoreAnswer(ROUTE, point({ ref: 'e5', action: 'input' }), TO_SETTINGS).firstStep).toEqual({
      element: true,
      action: false,
      success: false,
    });
  });

  it('元素错、动作对（集合里接受 click，模型点错了控件）：不成功，但动作记为对', () => {
    const s = scoreAnswer(ROUTE, point({ ref: 'e2', action: 'click' }), TO_SETTINGS);
    expect(s.firstStep).toEqual({ element: false, action: true, success: false });
    expect(s.success).toBe(false);
  });

  it('元素和动作都错', () => {
    expect(scoreAnswer(ROUTE, point({ ref: 'e6', action: 'toggle' }), TO_SETTINGS).firstStep).toEqual({
      element: false,
      action: false,
      success: false,
    });
  });

  it('一个目标有两条路：可接受集合里两个 ref，选哪个都算对', () => {
    const twoWays: Annotation = {
      state: 's-two',
      intents: ['point'],
      acceptable: [
        { ref: 'e5', actions: ['click'] },
        { ref: 'e1', actions: ['click'] },
      ],
    };
    expect(scoreAnswer(ROUTE, point({ ref: 'e5', action: 'click' }), twoWays).success).toBe(true);
    expect(scoreAnswer(ROUTE, point({ ref: 'e1', action: 'click' }), twoWays).success).toBe(true);
  });
});

describe('指向敏感控件的 ref 被记下', () => {
  it('ask 的候选里有敏感控件：被记下', () => {
    const asked: Annotation = { state: 's-ask', intents: ['ask'] };
    const s = scoreAnswer(SENSITIVE, ask('e6', 'e2'), asked);
    expect([s.intentCorrect, s.sensitive, s.offTable]).toEqual([true, ['e6'], []]);
  });

  // 回答的依据会被逐个框在用户的页面上，所以它和 point 的那一个 ref 一样算
  // 「指给用户看的东西」。闸门对这两项的容忍度是零，与基线无关。
  it('explain 拿来当依据的那几个 ref 同样算：敏感的、表外的都记下', () => {
    const answered: Annotation = { state: 's-explain', intents: ['explain'] };
    const s = scoreAnswer(SENSITIVE, explain('e6', 'e999'), answered);
    expect([s.intentCorrect, s.sensitive, s.offTable]).toEqual([true, ['e6'], ['e999']]);
  });
});

describe('意图', () => {
  it('该停的时候停：标注 done，答 done——对，没有那一步可判', () => {
    const s = scoreAnswer(ROUTE, done, { state: 's-done', intents: ['done'] });
    expect(s).toMatchObject({ intentCorrect: true, firstStep: null, success: true });
  });

  it('该走的时候停了：标注 point，答 done——意图错，那一步三项都是否', () => {
    const s = scoreAnswer(ROUTE, done, TO_SETTINGS);
    expect(s).toMatchObject({ intent: 'done', intentCorrect: false, success: false });
    expect(s.firstStep).toEqual({ element: false, action: false, success: false });
  });

  it('该问的时候没问：标注 ask，答 point——意图错', () => {
    const s = scoreAnswer(ROUTE, point({ ref: 'e5', action: 'click' }), { state: 's-ask', intents: ['ask'] });
    expect(s).toMatchObject({ intentCorrect: false, firstStep: null, success: false });
  });

  it('该回答的时候回答了：标注 explain，答 explain——对，没有那一步可判', () => {
    const s = scoreAnswer(ROUTE, explain('e5'), { state: 's-explain', intents: ['explain'] });
    expect(s).toMatchObject({ intentCorrect: true, firstStep: null, success: true });
  });

  it('该指路的时候回答了：标注 point，答 explain——意图错（2026-09-21 真机上的那个错）', () => {
    const s = scoreAnswer(ROUTE, explain(), TO_SETTINGS);
    expect(s).toMatchObject({ intent: 'explain', intentCorrect: false, success: false });
  });

  it('问答的信封（explain）是意图错，不是解析失败', () => {
    const explain: Answer = { tool: 'explain', raw: JSON.stringify({ answer: '设置在右上角', refs: [] }) };
    const s = scoreAnswer(ROUTE, explain, TO_SETTINGS);
    expect(s).toMatchObject({ outcome: 'answered', intent: 'explain', intentCorrect: false, success: false });
  });
});

describe('三种失败各自怎么计', () => {
  it('修复后仍读不出：解析失败，意图算错', () => {
    const s = scoreAnswer(ROUTE, { tool: 'point', raw: '{"route": [', failure: { kind: 'parse' } }, TO_SETTINGS);
    expect(s).toMatchObject({ outcome: 'parse', intentCorrect: false, success: false });
  });

  it('被校验拒掉：算失败，但它指向的表外 ref 照样记下（闸门要看这个数）', () => {
    const refused = { ...point({ ref: 'e999', action: 'click' }), failure: { kind: 'violation' as const } };
    const s = scoreAnswer(ROUTE, refused, TO_SETTINGS);
    expect(s).toMatchObject({ outcome: 'violation', intentCorrect: false, success: false, offTable: ['e999'] });
  });

  it('网络错：什么都没说，不算对也不算错', () => {
    const s = scoreAnswer(ROUTE, { raw: '', failure: { kind: 'transport' } }, TO_SETTINGS);
    expect(s).toMatchObject({ outcome: 'transport', intentCorrect: null, firstStep: null, success: null });
  });
});

describe('标注本身不合法时直接报错', () => {
  it('可接受的 ref 不在表里、是敏感控件、意图 point 却没给集合', () => {
    expect(() => scoreAnswer(ROUTE, done, { state: 'x', intents: ['point'], acceptable: [{ ref: 'e99', actions: ['click'] }] })).toThrow(RangeError);
    expect(() => scoreAnswer(SENSITIVE, done, { state: 'x', intents: ['point'], acceptable: [{ ref: 'e6', actions: ['input'] }] })).toThrow(RangeError);
    expect(() => scoreAnswer(ROUTE, done, { state: 'x', intents: ['point'] })).toThrow(RangeError);
  });
});

describe('汇总：一个状态是一个簇', () => {
  const sc = (success: boolean, intentCorrect: boolean, first?: boolean, extra: Partial<Score> = {}): Score => ({
    outcome: 'answered',
    intentCorrect,
    firstStep: first === undefined ? null : { element: first, action: first, success: first },
    offTable: [],
    sensitive: [],
    success,
    ...extra,
  });
  const transport: Score = { outcome: 'transport', intentCorrect: null, firstStep: null, offTable: [], sensitive: [], success: null };

  // S1 — point: right intent all three times, the step right twice.
  // S2 — done: right all three times.
  // S3 — point: a parse failure, a wrong step pointing off the table, and a network error.
  const states = [
    { state: 's-settings', annotation: TO_SETTINGS, scores: [sc(true, true, true), sc(true, true, true), sc(false, true, false)] },
    { state: 's-done', annotation: { state: 's-done', intents: ['done'] } as Annotation, scores: [sc(true, true), sc(true, true), sc(true, true)] },
    {
      state: 's3',
      annotation: { ...TO_SETTINGS, state: 's3' },
      scores: [
        sc(false, false, false, { outcome: 'parse' }),
        sc(false, false, false, { offTable: ['e999'] }),
        transport,
      ],
    },
  ];

  it('计数：网络错单列，比率只算到达模型的 8 次', () => {
    const s = summarize(states);
    expect([s.states, s.runs, s.transport, s.parseFailures, s.violations, s.offTable, s.sensitive]).toEqual([3, 9, 1, 1, 0, 1, 0]);
    expect(s.parseFailureRate).toBeCloseTo(1 / 8, 10);
    expect(s.violationRate).toBe(0);
  });

  it('意图准确率 = 各状态均值的均值：(3/3 + 3/3 + 0/2) / 3', () => {
    const s = summarize(states);
    expect(s.intent!.rate).toBeCloseTo(2 / 3, 10);
    expect(s.intent!.states).toBe(3);
  });

  it('那一步的准确率只算该给 point 的状态：(2/3 + 0/2) / 2', () => {
    expect(summarize(states).firstStep!.rate).toBeCloseTo(1 / 3, 10);
  });

  it('pass^k 按状态算：pass^1 = (2/3 + 1 + 0)/3，pass^2 = (1/3 + 1 + 0)/3，pass^3 只剩跑满 3 遍的两个状态', () => {
    const [p1, p2, p3] = summarize(states).passK;
    expect(p1!.value).toBeCloseTo(5 / 9, 10);
    expect(p2!.value).toBeCloseTo(4 / 9, 10);
    expect(p3).toEqual({ value: 0.5, clusters: 2, skipped: 1 });
  });

  it('稳定对、稳定错、时对时错各一个', () => {
    expect(summarize(states).stability).toEqual({ alwaysRight: 1, alwaysWrong: 1, mixed: 1 });
  });

  it('没有该给 point 的状态时，那一步的准确率是 null，不是 0', () => {
    expect(summarize([states[1]!]).firstStep).toBeNull();
  });

  const unlabelled = (extra: Partial<Score> = {}): Score => ({
    outcome: 'answered',
    intentCorrect: null,
    firstStep: null,
    offTable: [],
    sensitive: [],
    success: null,
    ...extra,
  });

  it('没标注的状态：失败与指向照数，准确率、pass^k、稳定性不算它', () => {
    const s = summarize([...states, { state: 's4', scores: [unlabelled({ offTable: ['e999'] }), unlabelled({ outcome: 'parse' }), transport] }]);
    expect([s.states, s.annotated, s.runs, s.transport, s.parseFailures, s.offTable]).toEqual([4, 3, 12, 2, 2, 2]);
    expect(s.intent!.rate).toBeCloseTo(2 / 3, 10);
    expect(s.intent!.states).toBe(3);
    expect(s.passK[2]).toEqual({ value: 0.5, clusters: 2, skipped: 1 });
    expect(s.stability).toEqual({ alwaysRight: 1, alwaysWrong: 1, mixed: 1 });
  });

  it('一个都没标：准确率与 pass^k 是空的，不是 0', () => {
    const s = summarize([{ state: 's4', scores: [unlabelled(), unlabelled()] }]);
    expect([s.annotated, s.intent, s.firstStep]).toEqual([0, null, null]);
    expect(s.passK).toEqual([]);
    expect(s.stability).toEqual({ alwaysRight: 0, alwaysWrong: 0, mixed: 0 });
  });
});

describe('没有标注：只算不需要答案的那部分', () => {
  it('答了：意图记下，对错是 null', () => {
    expect(scoreAnswer(ROUTE, point({ ref: 'e5', action: 'click' }))).toMatchObject({
      outcome: 'answered',
      intent: 'point',
      intentCorrect: null,
      firstStep: null,
      success: null,
    });
  });

  it('读不出、被拒：结局照记，被拒的回答照数它指向了什么', () => {
    expect(scoreAnswer(ROUTE, { tool: 'point', raw: 'not json' })).toMatchObject({ outcome: 'parse', intentCorrect: null, success: null });
    const refused = scoreAnswer(SENSITIVE, { ...point({ ref: 'e6', action: 'input' }), failure: { kind: 'violation' } });
    expect(refused).toMatchObject({ outcome: 'violation', sensitive: ['e6'], intentCorrect: null, success: null });
  });
});
