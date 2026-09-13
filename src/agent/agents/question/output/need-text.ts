import { shapeMismatch } from '@/agent/envelope/contract';
import type { QuestionOutputModule } from '../output-module';

export interface NeedTextEnvelope {
  intent: 'need_text';
  query: string;
  blocks: string[];
}

/**
 * `need_text`'s fixed copy. A constant, not a sentence built from the model's
 * own `query`/`blocks` fields — those are validated model output (provenance
 * already checked them), but weaving them into prose here would read as "here
 * is what the page says", which is exactly the fabrication 07 forbids. The
 * honest thing this intent can say is that the text could not be read at all.
 */
export const NEED_TEXT_MESSAGE = '我还读不到这个页面的正文——正文管线要到后面的阶段才有。';

/** need_text — the answer needs the page's body text, which the element table
 *  does not carry. */
export const needText: QuestionOutputModule<NeedTextEnvelope> = {
  intent: 'need_text',
  shape: `need_text —— 回答需要页面正文文字，而元素表里没有
{"intent":"need_text","query":"...你需要读到什么内容才能回答...","blocks":[]}
- query：字符串，说明你需要读到什么内容才能回答。
- blocks：字符串数组，本次没有可引用的正文分块就给空数组 []，不要编造。`,
  recognize: (obj) => {
    if (typeof obj.query !== 'string') return null;
    if (!Array.isArray(obj.blocks) || !obj.blocks.every((b) => typeof b === 'string')) return null;
    return { intent: 'need_text', query: obj.query, blocks: obj.blocks as string[] };
  },
  explain: () => shapeMismatch('need_text', 'query（字符串）+ blocks（字符串数组）'),
  // `blocks` are body-block ids, not refs (need_text 不做 blocks 归属校验), so
  // it claims none.
  claimedRefs: () => [],
  answer: () => ({ intent: 'need_text', message: NEED_TEXT_MESSAGE, items: [] }),
};
