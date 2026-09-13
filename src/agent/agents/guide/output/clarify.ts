import { clarifyShape, type ClarifyEnvelope } from '@/agent/envelope/contract';
import type { GuideIntentModule } from '../intent-module';
import { fn, str } from '../tool-schema';

/**
 * clarify, as the guide agent answers with it — an `Output`: the model cannot
 * go on without the user's answer, and says so instead of guessing.
 *
 * Its shape, its recognition and the refs it claims are shared with the
 * question agent and live in the contract: it is one Intent (CONTEXT.md
 * `Intent`). What the guide does with it — the thread parks on the question —
 * is this module's.
 */
export const clarify: GuideIntentModule<ClarifyEnvelope> = {
  intent: 'clarify',
  // The description carries the *bar* for reaching for it, not just a label.
  // It was a one-liner first — `clarify: '先问用户'` — and four tools offered
  // as peers with cheap-sounding labels moved the model from 1% clarify to
  // 16%, with journeys running half as long: it stopped and asked whenever a
  // page had no link pointing straight at the goal, on pages that had a search
  // box. A label describes; a bar decides.
  tool: () =>
    fn('clarify', '只在必须先得到用户回答才能继续时用：这一页上连一个能让用户更接近目标的入口都没有，或目标本身有歧义。搜索框、导航、菜单都算入口。', ['question', 'options'], {
      question: str(),
      options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'label'],
          // No `ref` enum here, unlike `guide.steps[].ref`, and the reason is
          // arithmetic rather than principle: a second copy of the enum costs
          // roughly 4 tokens per element on *every* call — about a tenth of a
          // call on an 86-item page — and across the live runs `clarify`
          // named 13 refs, none of them outside the table. R-e rejects one if
          // it ever happens. Revisit when it does, not before.
          properties: { ref: str('元素表里的 ref。'), label: str() },
        },
      },
    }),
  policy: `- **clarify**：只在你**必须先得到用户的回答才能继续**时用——目标本身有歧义（这一页上有多个同样合理的对象，你无法判断用户指的是哪一个），或者这一页上连一个能让用户更接近目标的入口都没有。**"这一页上没有直接通向目标的链接"不是理由**：搜索框、导航项、菜单、筛选器、任何一列可点的条目，都是入口；有其中任何一个就该给 guide。元素表带 truncated 时更不能这么说——你根本没看全。列出全部候选，不要替用户选一个。`,
  ...clarifyShape,
  violation: () => null,
  rationales: (envelope) => [envelope.question],
  consequence: (state, envelope) => {
    // CL-1 (§5.8): not a contract mismatch — `clarify` is one of the four
    // functions a guide call may answer with, and the model reaches for it
    // often enough to matter (10% of calls in the last live run). The thread
    // parks on the question with its steps intact rather than ending: the
    // user answers by asking again more specifically, and `page_changed`
    // still re-plans underneath them if the page moves meanwhile.
    return {
      state: { ...state, clarify: 'CL-1' },
      effects: [{ kind: 'clarify', question: envelope.question, options: envelope.options }],
    };
  },
};
