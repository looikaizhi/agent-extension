import { shapeMismatch } from '@/agent/envelope/contract';
import type { Ref } from '@/shared/types';
import { itemsFor, type QuestionOutputModule } from '../output-module';

export interface ExplainEnvelope {
  intent: 'explain';
  answer: string;
  refs: Ref[];
}

/** explain — the question answered, with the elements that back the answer up. */
export const explain: QuestionOutputModule<ExplainEnvelope> = {
  intent: 'explain',
  shape: `explain —— 直接回答用户的问题
{"intent":"explain","answer":"...你的回答文字...","refs":["e12","e7"]}
- answer：字符串，你的回答正文。
- refs：字符串数组，只列出**直接支撑这次回答**的元素，通常 1～3 个，最多 5 个；页面上还有别的相关元素也不要一并列出——refs 会被逐个高亮给用户看，列得越多越像整页都在闪，反而指不出重点。这次回答没有依据页面内容就给空数组 []。`,
  recognize: (obj) => {
    if (typeof obj.answer !== 'string') return null;
    // `refs` is the one optional S1 field (see the contract.spec.ts comment on
    // slice 16 for why this specific field): a model declining to name any
    // evidence, whether by omitting the key or sending `null`, is an ordinary
    // "this answer isn't page-grounded" — both normalize to the same `[]`.
    if (obj.refs === undefined || obj.refs === null) return { intent: 'explain', answer: obj.answer, refs: [] };
    if (!Array.isArray(obj.refs) || !obj.refs.every((r) => typeof r === 'string')) return null;
    return { intent: 'explain', answer: obj.answer, refs: obj.refs as Ref[] };
  },
  explain: () => shapeMismatch('explain', 'answer（字符串）'),
  claimedRefs: (envelope) => envelope.refs,
  answer: (envelope, table) => ({ intent: 'explain', message: envelope.answer, items: itemsFor(envelope.refs, table) }),
};
