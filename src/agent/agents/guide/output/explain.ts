import { shapeMismatch } from '@/agent/envelope/contract';
import type { Ref } from '@/shared/types';
import type { GuideIntentModule } from '../intent-module';
import { fn, str } from '../tool-schema';

/** At most this many elements back an answer: each is outlined on the page,
 *  and a page where everything is outlined points at nothing. */
export const EXPLAIN_MAX_REFS = 5;

export interface ExplainEnvelope {
  intent: 'explain';
  answer: string;
  /** The elements that back the answer up, in the model's order. Empty when
   *  the answer does not rest on anything on the page. */
  refs: Ref[];
}

function recognizeExplain(obj: Record<string, unknown>): ExplainEnvelope | null {
  if (typeof obj.answer !== 'string') return null;
  // A model declining to name any evidence — by omitting the key or sending
  // `null` — is an ordinary "this answer isn't page-grounded".
  if (obj.refs === undefined || obj.refs === null) return { intent: 'explain', answer: obj.answer, refs: [] };
  if (!Array.isArray(obj.refs) || !obj.refs.every((r) => typeof r === 'string')) return null;
  return { intent: 'explain', answer: obj.answer, refs: obj.refs as Ref[] };
}

/**
 * explain, as the guide agent answers with it — an `Output` that moves
 * nothing: the user asked about the page, and this is the answer, with the
 * elements that back it up.
 *
 * What it does to a run is not decided here. A run that has pointed at
 * nothing when it lands was a question (CONTEXT.md `Question`) and is over; a
 * run that has, goes on, with its step where it was — the reducer reads which
 * one this is off the run itself (`machine.ts`).
 */
export const explain: GuideIntentModule<ExplainEnvelope> = {
  intent: 'explain',
  kind: 'output',
  leavesStepOnScreen: true,
  tool: () =>
    fn('explain', '用户问的是这一页上的东西——是什么、什么意思、在哪——就直接回答。用户要做成一件事时不用它。', ['answer', 'refs'], {
      answer: str('你的回答正文。'),
      refs: {
        type: 'array',
        items: str('元素表里的 ref。'),
        description: `只列出直接支撑这次回答的元素，通常 1～3 个，最多 ${EXPLAIN_MAX_REFS} 个；它们会被逐个框出来给用户看。回答不依据页面内容就给空数组。`,
      },
    }),
  policy: `- **explain**：用户问的是**这一页上的东西**——某个按钮、某段内容是什么、什么意思、在哪——而不是要去做成一件事，就用 explain 直接回答。refs 只列出直接支撑这次回答的元素，通常 1～3 个、最多 ${EXPLAIN_MAX_REFS} 个：它们会被逐个框出来，列得越多越像整页都在闪。用户要做成一件事时，不要拿 explain 代替 point。`,
  recognize: recognizeExplain,
  explain: () => shapeMismatch('explain', 'answer（字符串）+ refs（ref 数组）'),
  claimedRefs: (envelope) => envelope.refs,
  violation: (envelope) =>
    envelope.refs.length > EXPLAIN_MAX_REFS
      ? `explain 列出了 ${envelope.refs.length} 个依据，最多 ${EXPLAIN_MAX_REFS} 个：只留直接支撑回答的那几个`
      : null,
  rationales: (envelope) => [envelope.answer],
  consequence: (state, envelope) => ({ state, effects: [{ kind: 'explain', answer: envelope.answer, refs: envelope.refs }] }),
};
