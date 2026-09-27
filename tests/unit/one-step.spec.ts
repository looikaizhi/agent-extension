import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { buildGuideUserMessage } from '@/agent/context/user-message';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/**
 * The model points at one step at a time (CONTEXT.md `Agent`, `Guide`).
 *
 * A plan of several steps was planned against a page the second step would
 * never see, and the one path that walked it — advancing on a settle timeout —
 * moved the cursor without saying what happened to the step it left, so that
 * step stayed undecided forever. One step at a time needs no tool loop: a step
 * that opens a dialog changes the page, the page change wakes the next call,
 * and the model points at what appeared.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const SAVE = 'e1' as Ref;
const NAME = 'e2' as Ref;
const TABLE: PromptTable = {
  snapshotId: 's1', url: 'https://x.test/settings', title: 't', structureHash: 'h1', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [
    { ref: SAVE, role: 'button', name: '保存', path: ['个人资料'] },
    { ref: NAME, role: 'textbox', name: '显示名称', path: ['个人资料'] },
  ],
};
const ctx = { goal: '把显示名称改成 Kai', table: TABLE, history: { done: [], route: [] } };

const POINT = {
  previous_step: 'first_plan',
  route: [{ at: '设置页', goal: '改名并保存' }],
  why: '先把新名字填进显示名称',
  ref: NAME,
  action: 'input',
  value: 'Kai',
  expect_after: null,
};

function thread(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    rev: 1, goal: ctx.goal, table: TABLE, pointedOn: TABLE, route: [], steps: [], cursor: 0, history: [],
    evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 0, spentSteps: 0,
    inflight: { effectId: 'fx-1', kind: 'callModel', at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: TABLE.url } },
    ...overrides,
  };
}
const answered = (tool: string, args: unknown) =>
  step(thread(), {
    kind: 'effect_result', effectId: 'fx-1', at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: TABLE.url },
    outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args) }, nextEffectId: 'fx-2',
  });
const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);

describe('模型能调用的函数', () => {
  it('引导这一侧指路用 point、问用户用 ask，没有 guide 也没有 clarify', () => {
    expect(guideAgent.outputSchema(ctx).map((t) => t.name)).toEqual(['point', 'ask', 'explain', 'observe', 'wait_for', 'read_doc', 'done']);
  });

  it('point 只指一步：没有 steps 数组，这一步的字段就在顶层，why 写在 ref 前面', () => {
    const params = guideAgent.outputSchema(ctx).find((t) => t.name === 'point')!.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.properties).not.toHaveProperty('steps');
    expect(params.required).toEqual(['previous_step', 'route', 'why', 'ref', 'action', 'value', 'expect_after']);
  });
});

describe('point', () => {
  it('识别并通过校验，拿到的就是那一步', () => {
    const parsed = guideAgent.parseOutput('point', JSON.stringify(POINT));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.envelope).toMatchObject({ intent: 'point', ref: NAME, action: 'input', value: 'Kai' });
    expect(guideAgent.validate(parsed.envelope, TABLE).kind).toBe('ok');
  });

  it('只点一下填值的控件是不会有反应的一步 → 拒绝，并说清该怎么改', () => {
    const parsed = guideAgent.parseOutput('point', JSON.stringify({ ...POINT, action: 'click', value: null }));
    if (parsed.kind !== 'ok') throw new Error('fixture must parse');
    const verdict = guideAgent.validate(parsed.envelope, TABLE);
    expect(verdict.kind).toBe('violation');
    if (verdict.kind === 'violation') expect(verdict.reason).toContain('input');
  });

  it('线程里装的永远只有这一步，路标照旧记下', () => {
    const { state, effects } = answered('point', POINT);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({ ref: NAME, expectedUserAction: 'input', value: 'Kai' });
    expect(state.route).toEqual(POINT.route);
    expect(ofKind(effects, 'present')).toHaveLength(1);
  });

  it('屏上那一步是这一趟里的第几步：模型一次只给一步，所以只说第几步，不说一共几步', () => {
    const first = answered('point', POINT);
    expect(ofKind(first.effects, 'present')[0]).toMatchObject({ index: 0, total: null });

    // Two steps already walked: the one pointed now is the third.
    const walked = [{ title: '设置', url: TABLE.url, action: 'taken' as const }, { title: '个人资料', url: TABLE.url, action: 'taken' as const }];
    const third = step(thread({ history: walked }), {
      kind: 'effect_result', effectId: 'fx-1', at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: TABLE.url },
      outcome: { ok: true, providerCalls: 1, tool: 'point', value: JSON.stringify({ ...POINT, previous_step: 'worked' }) }, nextEffectId: 'fx-2',
    });
    expect(ofKind(third.effects, 'present')[0]).toMatchObject({ index: 2, total: null });
  });
});

describe('ask', () => {
  // 两个候选：只列一个是 violation——ask 是「有歧义才问」，不是「替他确认」。
  const ASK_CHOICE = { question: '改哪一个名字？', wants: 'choice', options: [{ ref: NAME, label: '显示名称' }, { ref: SAVE, label: '保存' }] };
  const ASK_TEXT = { question: '要改成什么名字？', wants: 'text', options: [] };

  it('要用户选一个，或者给一段文字——两种都认', () => {
    for (const args of [ASK_CHOICE, ASK_TEXT]) {
      const parsed = guideAgent.parseOutput('ask', JSON.stringify(args));
      expect(parsed.kind, args.wants).toBe('ok');
      if (parsed.kind === 'ok') expect(guideAgent.validate(parsed.envelope, TABLE).kind, args.wants).toBe('ok');
    }
  });

  it('要用户选一个却一个选项都没给 → 拒绝', () => {
    const parsed = guideAgent.parseOutput('ask', JSON.stringify({ ...ASK_CHOICE, options: [] }));
    if (parsed.kind !== 'ok') throw new Error('fixture must parse');
    expect(guideAgent.validate(parsed.envelope, TABLE).kind).toBe('violation');
  });

  it('线程停下来等用户，问题连同「要什么」一起交出去', () => {
    const { state, effects } = answered('ask', ASK_TEXT);
    expect(state.inflight).toBeNull();
    expect(ofKind(effects, 'ask')).toEqual([{ kind: 'ask', question: ASK_TEXT.question, wants: 'text', options: [] }]);
  });
});

describe('用户点了之后不前进', () => {
  it('模型规划的一步用户点了、页面没变 → 游标不动、不亮第二步；记下做了，交给模型再看这一页', () => {
    const shown: GuideStep = { ref: SAVE, descriptor: { role: 'button', name: '保存' }, expectedUserAction: 'click', title: '保存' };
    const prior = thread({ inflight: null, steps: [shown, { ...shown, title: '不该亮起来的第二步' }], history: [{ title: '保存', url: TABLE.url }] });
    const again = { ...TABLE, snapshotId: 's-again' };
    const { state, effects } = step(prior, { kind: 'reading', reading: { kind: 'used', how: 'clicked' }, table: again, nextEffectId: 'fx-3' });
    expect(state.cursor).toBe(0);
    expect(ofKind(effects, 'present')).toHaveLength(0);
    expect(state.history).toEqual([{ title: '保存', url: TABLE.url, action: 'taken' }]);
    expect(ofKind(effects, 'callModel')).toHaveLength(1);
  });
});

describe('念给模型的「这一页没变」', () => {
  const history = {
    route: [{ at: '设置页', goal: '保存' }],
    done: [{ title: '复制', url: TABLE.url, action: 'taken' as const, effect: { kind: 'none' as const } }],
  };
  const said = buildGuideUserMessage(ctx.goal, TABLE, history, [], undefined, 'n');

  it('不再说这个控件推不动——复制、在新标签页打开，做成了这一页也不变', () => {
    expect(said).not.toContain('推不动');
    expect(said).not.toContain('没能推动页面');
    expect(said).toContain('新标签页');
  });

  it('本该让这一页出现新东西的一步没做到时，仍然给出出路——说出路，不说禁令', () => {
    expect(said).toContain('换一个控件');
    expect(said).not.toContain('不要再指');
  });
});

describe('系统提示词', () => {
  it('默认给 point，不再要求一次规划到离开这一页、也不再教人重复引用同一个 ref', () => {
    expect(guideAgent.instructions).toContain('默认是 point');
    expect(guideAgent.instructions).not.toContain('一次规划到');
    expect(guideAgent.instructions).not.toContain('重复引用');
  });
});
