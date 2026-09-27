import { describe, expect, it } from 'vitest';
import { guideAgent, type UnknownIntentEnvelope } from '@/agent/agents/guide/agent';
import { INTENTS } from '@/agent/intents';
import { DONE_EVIDENCE } from '@/agent/agents/guide/output/done';
import { ASK_WANTS } from '@/agent/agents/guide/output/ask';
import { GUIDE_PREVIOUS_STEP, GUIDE_STEP_ACTIONS, type PointEnvelope } from '@/agent/agents/guide/output/point';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * What the model is offered is what the product accepts.
 *
 * Each of these value sets used to be written twice — once in the tool schema
 * the model reads, once in the parser or validator that judges its answer —
 * by modules that never imported each other. Nothing noticed when the two
 * disagreed: a value the schema offered and the validator refused cost a
 * whole round, and a value the validator accepted but the schema never
 * offered was dead weight nobody could find.
 *
 * So these do not compare two constants. They read the offered set off the
 * schema the model actually receives, then ask the parser and validator which
 * candidates they accept, and require the two sets to be equal — which stays
 * true however the values come to be written, and goes red the moment a
 * second, drifting copy appears on either side.
 */

const stats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const BUTTON = 'e1' as Ref;
const FIELD = 'e2' as Ref;
const TABLE: PromptTable = {
  snapshotId: 's', url: 'https://x.test/', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [
    { ref: BUTTON, role: 'button', name: '保存', path: [] },
    { ref: FIELD, role: 'textbox', name: '名称', path: [] },
  ],
};

/** The schema exactly as the guide agent hands it to the model. */
const tools = guideAgent.outputSchema({ goal: 'g', table: TABLE, history: { done: [], route: [] } });
const toolNamed = (name: string) => tools.find((t) => t.name === name)!.inputSchema as Record<string, any>;
const offeredEnum = (schema: Record<string, any>) => new Set<string>(schema.enum as string[]);

const POINT_ARGS = {
  previous_step: 'first_plan',
  route: [{ at: '这一页', goal: '保存' }],
  why: '保存',
  ref: BUTTON,
  action: 'click',
  value: null,
  expect_after: null,
};

/**
 * Every value either side knows, plus two that neither should. Both sides,
 * because a probe drawn only from the schema never tries a value the schema
 * forgot — and a schema that stopped offering one is exactly the drift to see.
 */
const CANDIDATES = [
  ...new Set([
    ...(toolNamed('point').properties.previous_step.enum as string[]),
    ...(toolNamed('point').properties.action.enum as string[]),
    ...(toolNamed('done').properties.evidence.enum as string[]),
    ...(toolNamed('ask').properties.wants.enum as string[]),
    ...GUIDE_PREVIOUS_STEP,
    ...GUIDE_STEP_ACTIONS,
    ...DONE_EVIDENCE,
    ...ASK_WANTS,
    ...INTENTS,
    'observe',
    'bogus',
  ]),
];
const acceptedAmong = (accepts: (v: string) => boolean) => new Set(CANDIDATES.filter(accepts));

describe('给模型的取值，与识别、校验接受的取值是同一份', () => {
  it('上一步结果：schema 给的，就是识别会保留的', () => {
    const offered = offeredEnum(toolNamed('point').properties.previous_step);
    const kept = acceptedAmong((v) => {
      const r = guideAgent.parseOutput('point', JSON.stringify({ ...POINT_ARGS, previous_step: v }));
      return r.kind === 'ok' && r.envelope.intent === 'point' && r.envelope.previous_step === v;
    });
    expect(kept).toEqual(offered);
  });

  it('完成依据：schema 给的，就是识别会保留的', () => {
    const offered = offeredEnum(toolNamed('done').properties.evidence);
    const kept = acceptedAmong((v) => {
      const r = guideAgent.parseOutput('done', JSON.stringify({ evidence: v, why: '已经显示在这一页上' }));
      return r.kind === 'ok' && r.envelope.intent === 'done' && r.envelope.evidence === v;
    });
    expect(kept).toEqual(offered);
  });

  it('要用户给什么：schema 给的，就是识别会认的', () => {
    const offered = offeredEnum(toolNamed('ask').properties.wants);
    const kept = acceptedAmong((v) => {
      const r = guideAgent.parseOutput('ask', JSON.stringify({ question: '哪一个？', wants: v, options: [{ ref: BUTTON, label: '保存' }] }));
      return r.kind === 'ok' && r.envelope.intent === 'ask' && r.envelope.wants === v;
    });
    expect(kept).toEqual(offered);
  });

  it('动作：schema 给的，就是校验会放行的', () => {
    const offered = offeredEnum(toolNamed('point').properties.action);
    // A value-taking action goes on the field, the rest on the button, so no
    // rule but R-d has anything to say about which action was chosen.
    const passed = acceptedAmong((action) => {
      const onField = action === 'input' || action === 'select';
      const envelope: PointEnvelope = {
        intent: 'point',
        route: POINT_ARGS.route,
        ref: onField ? FIELD : BUTTON,
        action,
        why: '做这一步',
        ...(onField ? { value: '新名字' } : {}),
      };
      return guideAgent.validate(envelope, TABLE).kind === 'ok';
    });
    expect(passed).toEqual(offered);
  });

  it('intent：agent 认得的正是它登记的，也就是 INTENTS；校验认得的与识别认得的是同一份', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      explain: { answer: '在这里', refs: [BUTTON] },
      point: POINT_ARGS,
      // 两个候选：只列一个已经是 violation（那不是让用户选，是替他确认）。
      ask: { question: '哪一个？', wants: 'choice', options: [{ ref: BUTTON, label: '保存' }, { ref: FIELD, label: '名称' }] },
      observe: { why: '页面像是还没加载完' },
      wait_for: { until: 'appears', text: '保存成功', seconds: 5 },
      read_doc: { via_ref: BUTTON, query: '怎么保存' },
      done: { evidence: 'content_on_page', why: '已经在这一页上' },
    };
    const toolNames = tools.map((t) => t.name);
    for (const name of toolNames) expect(guideAgent.parseOutput(name, JSON.stringify(minimal[name])).kind, name).toBe('ok');

    const asArgs = (v: string) => JSON.stringify(minimal[v] ?? {});
    const guideReads = acceptedAmong((v) => guideAgent.parseOutput(v, asArgs(v)).kind === 'ok');
    expect(guideReads).toEqual(new Set(toolNames));
    expect(guideReads).toEqual(new Set(INTENTS));

    const guideValidates = acceptedAmong((v) => {
      const r = guideAgent.parseOutput(v, asArgs(v));
      const envelope = r.kind === 'ok' ? r.envelope : ({ intent: v } as UnknownIntentEnvelope);
      return guideAgent.validate(envelope, TABLE).kind === 'ok';
    });
    expect(guideValidates).toEqual(guideReads);
  });
});
