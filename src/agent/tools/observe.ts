import type { GuideIntentModule } from '@/agent/agents/guide/intent-module';
import { fn, str } from '@/agent/agents/guide/tool-schema';
import { shapeMismatch } from '@/agent/envelope/contract';

/**
 * observe — a `Tool`: before answering, the model reads the page again as it
 * is at this moment (CONTEXT.md `Tool`).
 *
 * Whether the page has finished arriving is the model's call, not the
 * product's (CONTEXT.md `Reading`): there is no reliable signal for it, and a
 * product that guesses writes its guess down as a fact. So the model says it
 * wants another look, and why; the host reads the page once and hands back
 * what it saw — or that it could not see anything.
 */
export interface ObserveEnvelope {
  intent: 'observe';
  why: string;
}

export const observe: GuideIntentModule<ObserveEnvelope> = {
  intent: 'observe',
  kind: 'tool',
  tool: () =>
    fn('observe', '把此刻的这一页重新读一遍。只在元素表还没反映出页面此刻的样子时用。', ['why'], {
      why: str('你预计此刻的页面和这张表有什么不同，所以要再看一眼。'),
    }),
  // Every look is a model call, and until the per-step budget (09) each one is
  // paid from the run's twelve. The bar says when to look, and — as plainly —
  // that a table already offering a way forward is not a reason to.
  policy:
    '- **observe**：只在你判断这张元素表**还没反映出页面此刻的样子**时用——例如表里只有导航和骨架、正文明显还没加载出来，或者上一步本该弹出的东西还没出现在表里。它会把此刻的页面重新读一遍交给你，之后只用新读到的那张表里的 ref。表里已经有能让用户离目标更近的控件时，不要为了保险再看一眼，直接给 point。',
  recognize: (args) => (typeof args.why === 'string' ? { intent: 'observe', why: args.why } : null),
  explain: () => shapeMismatch('observe', 'why（字符串）'),
  claimedRefs: () => [],
  violation: () => null,
  rationales: (envelope) => [envelope.why],
  consequence: (state, _envelope, { nextEffectId, call }) => {
    // Every model call opens a turn (`tryEmitCallModel`), so this is the one
    // the call belongs to; an empty turn is what it would be if it had none.
    const turn = state.turn ?? { table: state.table, rounds: [] };
    return {
      state: { ...state, turn: { ...turn, pending: { effectId: nextEffectId, call } } },
      effects: [{ kind: 'observe', effectId: nextEffectId }],
    };
  },
};
