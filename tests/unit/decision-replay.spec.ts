import { describe, expect, it } from 'vitest';
import { contributionsFor, pluginsNamed } from '@/agent/context/plugins';
import { ProviderError } from '@/agent/provider/transport';
import type { PromptTable } from '@/core/extractor/types';
import { DEFAULT_CONFIG } from '@/shared/settings';
import type { State } from '../../evals/decision/corpus';
import { RETRIES, replay, type Replay } from '../../evals/decision/replay';
import { decisionReport } from '../../evals/decision/report';
import { passHatK } from '../../evals/stats';
import { TABLES } from './fixtures/golden-guide-envelopes';
import type { ModelMessage } from '@/agent/provider/types';
import { finish, textOf, toolCall } from './fixtures/neutral';

/**
 * `eval:decision` without a network: a state answered again through the real
 * run loop against a scripted endpoint, and the report computed from answers
 * written by hand.
 */
const ROUTE = TABLES.route; // repo home: e5 Settings, nothing sensitive
const GITHUB: PromptTable = { ...ROUTE, url: 'https://github.com/n8n-io/n8n' };
const DONE_ARGS = JSON.stringify({ evidence: 'content_on_page', why: '列表已经在这一页上' });

const STATE: State = {
  id: 'r/gh-issues/P1/1',
  run: 'r',
  goal: 'gh-issues',
  pass: 1,
  hop: 0,
  seq: 1,
  fingerprint: 'fp',
  context: { goal: '带我去看这个仓库的 issue 列表', table: GITHUB, history: { done: [], route: [] } },
  plugins: ['skill'],
  contributions: [],
  sent: { system: '', tools: '', user: '' },
  answer: null,
};

/** An endpoint that plays `script` one request at a time: a 429, a refused key, or `done`. */
function endpoint(script: ('429' | '401' | 'done')[]) {
  let n = 0;
  const users: string[] = [];
  async function* fn(_cfg: unknown, messages: readonly ModelMessage[]) {
    const step = script[Math.min(n, script.length - 1)]!;
    n += 1;
    users.push(textOf(messages[1]));
    if (step === '429') throw new ProviderError('端点暂时不可用（HTTP 429）', 'network', true);
    if (step === '401') throw new ProviderError('Key 被拒绝（HTTP 401）', 'auth', false);
    yield* toolCall('done', DONE_ARGS, { id: `call_${n}` });
    yield finish({ prompt: 10, completion: 2, total: 12, estimated: false });
  }
  return { callFn: fn as never, users, requests: () => n };
}

describe('重放：端点说「现在不行」时退避再问，不算模型答错', () => {
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };

  it('两次 429 之后答上：第 3 次算数，等了 1 秒和 2 秒', async () => {
    waits.length = 0;
    const e = endpoint(['429', '429', 'done']);
    const r = await replay(STATE, 1, ['skill'], DEFAULT_CONFIG, { callFn: e.callFn, wait });
    expect(r).toMatchObject({ state: STATE.id, pass: 1, tool: 'done', attempts: 3, providerCalls: 1 });
    expect(r.failure).toBeUndefined();
    expect(waits).toEqual([1000, 2000]);
  });

  it('一直 429：问满之后记为网络错', async () => {
    waits.length = 0;
    const r = await replay(STATE, 1, ['skill'], DEFAULT_CONFIG, { callFn: endpoint(['429']).callFn, wait });
    expect(r.attempts).toBe(RETRIES + 1);
    expect(r.failure).toMatchObject({ kind: 'transport', retryable: true });
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it('Key 被拒不是「现在不行」：不再问', async () => {
    waits.length = 0;
    const r = await replay(STATE, 1, ['skill'], DEFAULT_CONFIG, { callFn: endpoint(['401']).callFn, wait });
    expect(r.attempts).toBe(1);
    expect(r.failure).toMatchObject({ kind: 'transport', retryable: false });
    expect(waits).toEqual([]);
  });

  it('Plugin 组合按这一次指定的来：skill 开时 user 消息里有站点技能那段，none 时没有', async () => {
    const paragraph = contributionsFor(pluginsNamed(['skill']), GITHUB.url)[0]!;
    const on = endpoint(['done']);
    const off = endpoint(['done']);
    await replay(STATE, 1, ['skill'], DEFAULT_CONFIG, { callFn: on.callFn });
    await replay(STATE, 1, [], DEFAULT_CONFIG, { callFn: off.callFn });
    expect(on.users[0]).toContain(paragraph);
    expect(off.users[0]).not.toContain(paragraph);
  });
});

describe('报告：只从回答算', () => {
  const point = (ref: string) =>
    JSON.stringify({
      previous_step: 'first_plan',
      route: [{ at: '仓库主页', goal: '打开设置' }],
      why: '设置在这里',
      ref,
      action: 'click',
      value: null,
      expect_after: null,
    });
  const base = { providerCalls: 1, attempts: 1 };
  // s1 is annotated (Settings is the way in); s2 is not.
  const replays: Replay[] = [
    { ...base, state: 's1', pass: 1, raw: point('e5'), tool: 'point', ms: 1000, usage: { prompt: 100, completion: 10, total: 110, cachedPrompt: 40 } },
    { ...base, state: 's1', pass: 2, raw: point('e2'), tool: 'point', ms: 3000 },
    { ...base, state: 's1', pass: 3, raw: '', ms: 50, attempts: 5, providerCalls: 0, failure: { kind: 'transport', error: 'HTTP 429', retryable: true } },
    { ...base, state: 's2', pass: 1, raw: DONE_ARGS, tool: 'done', ms: 2000, usage: { prompt: 200, completion: 20, total: 220, cachedPrompt: 100 } },
    { ...base, state: 's2', pass: 2, raw: DONE_ARGS, tool: 'done', ms: 4000, attempts: 2 },
    { ...base, state: 's2', pass: 3, raw: DONE_ARGS, tool: 'done', ms: 5000 },
  ];
  const report = decisionReport({
    tables: new Map([
      ['s1', ROUTE],
      ['s2', ROUTE],
    ]),
    replays,
    annotations: [
      { state: 's1', intents: ['point'], acceptable: [{ ref: 'e5', actions: ['click'] }] },
      { state: 'ghost', intents: ['done'] },
    ],
    price: { input: 1, cached: 0.1, output: 2 },
  });

  it('准确率只算有标注的 s1：意图 2/2，第一步 1/2；网络错不进分母', () => {
    const s = report.summary;
    expect([s.states, s.annotated, s.runs, s.transport]).toEqual([2, 1, 6, 1]);
    expect(s.intent!.rate).toBe(1);
    expect(s.firstStep!.rate).toBe(0.5);
  });

  it('pass^k 与第 02 张的函数对同一组回答算出的一致', () => {
    const clusters = [{ id: 's1', n: 2, c: 1 }];
    expect(report.summary.passK.map((p) => p.value)).toEqual([passHatK(clusters, 1).value, passHatK(clusters, 2).value]);
  });

  it('意图分布、token、成本、重试次数、用不上的标注', () => {
    expect(report.intents).toEqual({ point: 2, done: 3 });
    expect(report.tokens).toEqual({ prompt: 300, completion: 30, cached: 140 });
    // (300 − 140)·1 + 140·0.1 + 30·2 = 160 + 14 + 60 per million.
    expect(report.cost).toBeCloseTo(234e-6, 12);
    expect(report.retried).toBe(2);
    expect(report.unknownAnnotations).toEqual(['ghost']);
  });

  it('延迟只算到达了模型的 5 次，按最近秩：中位 3 秒，p90 5 秒', () => {
    expect(report.latency).toEqual({ medianMs: 3000, p90Ms: 5000 });
  });
});
