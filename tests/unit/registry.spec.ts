import { describe, expect, it, vi } from 'vitest';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * Registration is the only way in.
 *
 * With the registry emptied, every registered intent has to vanish from
 * everything the guide agent does — the tools the model is offered, the policy
 * in its system message, and recognition on both paths an answer can arrive
 * by. If any of them still knew one, a second copy of the intent would be
 * living somewhere outside its module, and adding or removing an intent would
 * again mean finding every place that remembers it.
 *
 * The positive half is the byte snapshot (`model-input-snapshot.spec.ts`):
 * with the real registry, every tool and policy line is there, in place.
 */
vi.mock('@/agent/agents/guide/registry', () => ({
  GUIDE_INTENT_MODULES: [],
  moduleFor: () => undefined,
  isRegistered: () => false,
  moduleOf: () => {
    throw new Error('nothing is registered');
  },
}));

const { guideAgent } = await import('@/agent/agents/guide/agent');
const { ask } = await import('@/agent/agents/guide/output/ask');
const { done } = await import('@/agent/agents/guide/output/done');
const { point } = await import('@/agent/agents/guide/output/point');
const { readDoc } = await import('@/agent/tools/read-doc');

const stats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const TABLE: PromptTable = {
  snapshotId: 's', url: 'https://x.test/', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [{ ref: 'e1' as Ref, role: 'link', name: '帮助文档', path: [], href: 'https://x.test/docs' }],
};
/** Arguments each intent would be accepted with, were it registered. */
const ARGS: Record<string, Record<string, unknown>> = {
  point: {
    previous_step: 'first_plan',
    route: [{ at: '这一页', goal: '看文档' }],
    why: '去帮助文档',
    ref: 'e1',
    action: 'click',
    value: null,
    expect_after: null,
  },
  ask: { question: '要看哪一份？', wants: 'choice', options: [{ ref: 'e1', label: '帮助文档' }] },
  read_doc: { via_ref: 'e1', query: '怎么保存' },
  done: { evidence: 'content_on_page', why: '已经显示在这一页上' },
};

describe('登记是 intent 进入引导 agent 的唯一入口', () => {
  it('去掉登记：模型一个工具也看不到', () => {
    const names = guideAgent.outputSchema({ goal: 'g', table: TABLE, history: { done: [], route: [] } }).map((t) => t.name);
    expect(names).toEqual([]);
  });

  it('去掉登记：系统提示词里没有任何一个模块的那一条', () => {
    for (const m of [point, ask, readDoc, done]) expect(guideAgent.instructions, m.intent).not.toContain(m.policy);
  });

  it('去掉登记：四种回答全被识别拒掉', () => {
    // 只剩一条路了：端点报回来的函数名就是 intent，没登记就读不出。
    for (const intent of Object.keys(ARGS)) {
      const viaTool = guideAgent.parseOutput(intent, JSON.stringify(ARGS[intent]));
      expect(viaTool.kind, intent).toBe('error');
      if (viaTool.kind === 'error') expect(viaTool.message, intent).not.toContain('undefined');
    }
  });
});
