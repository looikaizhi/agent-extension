import { describe, expect, it } from 'vitest';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import { createTrace } from '@/agent/agents/guide/trace';
import { contributionsFor, pluginsNamed } from '@/agent/context/plugins';
import type { CallModelParams } from '@/agent/thread/effect';
import type { PromptTable } from '@/core/extractor/types';
import { DEFAULT_CONFIG } from '@/shared/settings';
import { differences, rebuild, statesOf, type State } from '../../evals/decision/corpus';
import { TABLES } from './fixtures/golden-guide-envelopes';
import { finish, toolCall } from './fixtures/neutral';

/**
 * Taking a Task eval log apart into Decision eval states, and proving a state
 * replays as the same call.
 *
 * The log rows are made the way the panel makes them: the real run loop, the
 * real trace recorder, and a fresh random wrapper marker on every call — so
 * the check below has the same random bytes to see past that a real log has.
 */
const GITHUB: PromptTable = { ...TABLES.route, snapshotId: 'snap-gh', url: 'https://github.com/n8n-io/n8n' };
const DONE = { tool: 'done', args: JSON.stringify({ evidence: 'content_on_page', why: '列表已经在这一页上' }) };

function scripted(...replies: { tool: string; args: string }[]) {
  let n = 0;
  return async function* () {
    const r = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    yield* toolCall(r.tool, r.args, { id: `call_${n}` });
    yield finish({ prompt: 1, completion: 1, total: 2, estimated: false });
  };
}

/** One log — its first line and one call row — for a call made with `plugins`. */
async function loggedCall(plugins: string[], replies = [DONE]): Promise<Record<string, unknown>[]> {
  const params: CallModelParams = {
    goal: '带我去看这个仓库的 issue 列表',
    table: GITHUB,
    history: { done: [], route: [] },
    contributions: contributionsFor(pluginsNamed(plugins), GITHUB.url),
  };
  const trace = createTrace(() => 1);
  const result = await runGuideToEnd(params, DEFAULT_CONFIG, new AbortController().signal, scripted(...replies) as never, trace.record);
  return [
    { kind: 'header', run: 'run-x', plugins, fingerprint: 'fp-x', goals: ['gh-issues'], passes: 1 },
    {
      kind: 'call',
      pass: 1,
      id: 'gh-issues',
      seq: 1,
      hop: 0,
      effectId: 'eff-1',
      params,
      outcome: { ok: true, value: result.raw, tool: result.tool, providerCalls: result.providerCalls },
      trace: trace.snapshot(),
    },
  ];
}

const only = async (plugins: string[], replies?: { tool: string; args: string }[]): Promise<State> => {
  const { states } = statesOf(await loggedCall(plugins, replies));
  expect(states).toHaveLength(1);
  return states[0]!;
};

describe('抽取：一次调用一个状态', () => {
  it('照侧栏的方式记下的一次调用，抽出来就是一个状态，来历齐全', async () => {
    const s = await only(['skill']);
    expect(s).toMatchObject({ id: 'run-x/gh-issues/P1/1', run: 'run-x', goal: 'gh-issues', pass: 1, hop: 0, fingerprint: 'fp-x', plugins: ['skill'] });
    expect(s.context.table.items).toHaveLength(GITHUB.items.length);
    expect(s.answer).toMatchObject({ ok: true, tool: 'done' });
  });

  it('修复轮属于它修的那次调用，不单独成一个状态', async () => {
    const s = await only(['skill'], [{ tool: 'guide', args: '{"route": [' }, DONE]);
    expect(s.sent.user).toContain('带我去看这个仓库的 issue 列表');
  });

  it('没有 trace 的调用被跳过，并写明原因；日志没有第一行时直接报错', async () => {
    const [header, call] = await loggedCall(['skill']);
    const { states, skipped } = statesOf([header!, { ...call!, trace: null }]);
    expect(states).toEqual([]);
    expect(skipped).toEqual([{ call: 'P1·gh-issues#1', why: expect.stringContaining('没有 trace') }]);
    expect(() => statesOf([call!])).toThrow('日志没有第一行');
  });
});

describe('逐字节核对：用当前代码重拼，要拿回模型当时读到的原文', () => {
  it('没动过的状态：四段都对得上（包裹标记是真随机的，两边都换成固定值再比）', async () => {
    expect(differences(await only(['skill']))).toEqual([]);
    expect(differences(await only([]))).toEqual([]);
  });

  it('trace 的 system 与 tools 是渲染后的文本，不是结构——整条链靠这一点还对得上', async () => {
    // 这条守的是一条会「绿着坏掉」的链。语料拿 trace 的这两个字段当「模型当时
    // 读到的东西」，回比用的是字符串比对；让它们跟着中立类型变成对象，已提交的
    // 每一条语料都会永久对不上，而抽取用「有差异就跳过」来过滤，只会静默产出零
    // 条，一个红都不报。所以它被钉在这里——而且是钉在真的跑过一遍运行循环、真的
    // 记过一次 trace 的状态上，不是钉在一个手写的假事件上。
    const s = await only(['skill']);
    expect(typeof s.sent.system).toBe('string');
    expect(typeof s.sent.user).toBe('string');
    expect(typeof s.sent.tools).toBe('string');
    expect(JSON.parse(s.sent.tools)).toBeInstanceOf(Array);
    expect(s.sent.system.length).toBeGreaterThan(0);
  });

  it.each([
    ['user', (s: State) => ({ ...s, sent: { ...s.sent, user: s.sent.user.replace('issue 列表', 'issue 清单') } })],
    ['system', (s: State) => ({ ...s, sent: { ...s.sent, system: `${s.sent.system} ` } })],
    ['tools', (s: State) => ({ ...s, sent: { ...s.sent, tools: s.sent.tools.replace('"point"', '"points"') } })],
    ['contributions', (s: State) => ({ ...s, contributions: [] })],
  ] as const)('只动了 %s：核对变红，并且只指出这一段', async (part, tamper) => {
    expect(differences(tamper(await only(['skill'])))).toEqual([part]);
  });

  it('按「Skill 开」重拼与原文一致；按「全关」重拼只少站点技能那一段，其余逐字节一致', async () => {
    const s = await only(['skill']);
    const on = rebuild(s, ['skill']);
    const off = rebuild(s, []);
    expect(on.contributions).toHaveLength(1);
    expect(off.contributions).toEqual([]);
    expect(on.user.split(`${on.contributions[0]}\n\n`).join('')).toBe(off.user);
    expect([off.system, off.tools]).toEqual([on.system, on.tools]);
  });
});
