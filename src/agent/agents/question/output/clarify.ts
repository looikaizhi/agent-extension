import { clarifyShape, type ClarifyEnvelope } from '@/agent/envelope/contract';
import { itemsFor, type QuestionOutputModule } from '../output-module';

/**
 * clarify, as the question agent answers with it: every candidate listed, and
 * every one of them highlighted — none picked for the user (K-6).
 *
 * Its shape and recognition are the contract's, shared with the guide agent:
 * it is one Intent (CONTEXT.md `Intent`). What a question does with it is this
 * module's.
 */
export const clarify: QuestionOutputModule<ClarifyEnvelope> = {
  intent: 'clarify',
  shape: `clarify —— 问题有歧义，需要用户先选一个
{"intent":"clarify","question":"...向用户提出的澄清问题...","options":[{"ref":"e7","label":"..."}]}
- question：字符串，向用户提出的澄清问题。
- options：数组，每一项是 {"ref":"元素表里的 ref","label":"这个选项的说明文字"}；列出全部候选，不要替用户选一个。`,
  ...clarifyShape,
  answer: (envelope, table) => {
    const options = envelope.options.map((o) => ({ ref: o.ref, label: o.label }));
    return {
      intent: 'clarify',
      message: envelope.question,
      items: itemsFor(
        options.map((o) => o.ref),
        table,
      ),
      options,
    };
  },
};
