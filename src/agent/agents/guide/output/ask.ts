import { shapeMismatch } from '@/agent/envelope/contract';
import type { AskOption, AskWants, Never, Ref } from '@/shared/types';
import type { GuideIntentModule } from '../intent-module';
import { fn, str } from '../tool-schema';

/** What the model needs from the user: one of the options it listed, or words
 *  only the user has. The two used to be two intents (`clarify` and
 *  `need_text`) with one consequence — the thread stops and waits. The schema
 *  offers exactly these and recognition accepts nothing else. */
export const ASK_WANTS = ['choice', 'text'] as const satisfies readonly AskWants[];
type _EveryWantOffered = Never<Exclude<AskWants, (typeof ASK_WANTS)[number]>>;

export interface AskEnvelope {
  intent: 'ask';
  question: string;
  wants: AskWants;
  /** Every candidate, in the model's own order — none picked for the user
   *  (K-6). Empty when `wants` is `text`. */
  options: AskOption[];
}

function recognizeAsk(obj: Record<string, unknown>): AskEnvelope | null {
  if (typeof obj.question !== 'string') return null;
  if (!(ASK_WANTS as readonly string[]).includes(obj.wants as string)) return null;
  if (!Array.isArray(obj.options)) return null;
  const options: AskOption[] = [];
  for (const raw of obj.options) {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.ref !== 'string' || typeof o.label !== 'string') return null;
    options.push({ ref: o.ref as Ref, label: o.label });
  }
  return { intent: 'ask', question: obj.question, wants: obj.wants as AskWants, options };
}

/**
 * ask, as the guide agent answers with it — an `Output`: the model cannot go
 * on without the user, and says so instead of guessing.
 */
export const ask: GuideIntentModule<AskEnvelope> = {
  intent: 'ask',
  kind: 'output',
  // The description carries the *bar* for reaching for it, not just a label.
  // It was a one-liner first — `clarify: '先问用户'` — and four tools offered
  // as peers with cheap-sounding labels moved the model from 1% asking to 16%,
  // with journeys running half as long: it stopped whenever a page had no link
  // pointing straight at the goal, on pages that had a search box. A label
  // describes; a bar decides.
  //
  // Asking for words is where credentials would come from, and the first
  // capture with `text` did it: told 「帮我登录一下，然后把新的银行卡信息填进去」
  // on a settings page, the model asked the user for their account. The user
  // answers by writing into the goal, and the goal goes to the model endpoint —
  // so the bar says outright that these are never asked for.
  tool: () =>
    fn('ask', '只在必须先得到用户回答才能继续时用：这一页上连一个能让用户更接近目标的入口都没有，或目标本身有歧义。搜索框、导航、菜单都算入口。', ['question', 'wants', 'options'], {
      question: str(),
      wants: {
        type: 'string',
        enum: [...ASK_WANTS],
        description: '你要用户给什么。choice=从 options 里选一个；text=给一段只有他知道的文字（名字、编号、要找的具体对象），这时 options 填空数组。绝不用 text 要账号、密码、验证码、卡号这类凭据或支付信息。',
      },
      options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'label'],
          // No `ref` enum here, unlike `point.ref`, and the reason is
          // arithmetic: a second copy of the enum costs roughly 4 tokens per
          // element on *every* call, and across the live runs asks named 13
          // refs, none of them outside the table. R-e rejects one if it ever
          // happens. Revisit when it does, not before.
          properties: { ref: str('元素表里的 ref。'), label: str() },
        },
      },
    }),
  policy: `- **ask**：只在你**必须先得到用户的回答才能继续**时用——目标本身有歧义（这一页上有多个同样合理的对象，你无法判断用户指的是哪一个），或者要继续必须有一段只有用户知道的信息（名字、编号、要找的具体对象），或者这一页上连一个能让用户更接近目标的入口都没有。**绝不向用户要账号、密码、验证码、卡号这类凭据或支付信息**：用户的回答会写进发给你的话里，这些只能由他自己填在页面上。**"这一页上没有直接通向目标的链接"不是理由**：搜索框、导航项、菜单、筛选器、任何一列可点的条目，都是入口；有其中任何一个就该给 point。元素表带 truncated 时更不能这么说——你根本没看全。要用户选的时候列出全部候选，不要替用户选一个。`,
  recognize: recognizeAsk,
  explain: () => shapeMismatch('ask', 'question（字符串）+ wants（choice 或 text）+ options（{ref,label} 数组）'),
  claimedRefs: (envelope) => envelope.options.map((o) => o.ref),
  // Two shapes of "ask" that cannot be answered as an ask. Both go back
  // through the repair round, so the wording is what the model reads next —
  // it has to say which way out to take, not just what was wrong.
  //
  // One option is the interesting one: 「把这台实例删掉」 on a page whose only
  // candidate is the 删除实例 button was answered with 「你要点下面这个按钮
  // 吗？」 and that one button listed. Asking bought nothing — this product
  // never clicks, so pointing at it is already the safe move — and cost a
  // round trip. Measured across two live runs (601 calls) it happened once,
  // so this is a cheap guard on a rare shape, not a fix for a common one.
  violation: (envelope) => {
    if (envelope.wants !== 'choice') return null;
    if (envelope.options.length === 0)
      return 'ask 要用户选一个，却一个选项都没有列出：要么把候选列进 options，要么把 wants 写成 text';
    if (envelope.options.length === 1)
      return 'ask 只列出一个候选——那不是让用户选，是在替他确认。这一页上只有这一个合适的控件时，直接用 point 指它；确实有多个同样合理的对象才用 ask，并把它们全部列出来';
    return null;
  },
  rationales: (envelope) => [envelope.question],
  consequence: (state, envelope) => {
    // CL-1 (§5.8): the thread waits on the question with its step intact
    // rather than ending. What the user says next reaches it as a reading
    // (`said`), and so does anything the page does meanwhile.
    return {
      state,
      effects: [{ kind: 'ask', question: envelope.question, wants: envelope.wants, options: envelope.options }],
    };
  },
};
