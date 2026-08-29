import type { ChatMessage } from '@/agent/provider';
import { toPromptText } from '@/core/extractor/project';
import type { GuideRouteHop } from './contract';
import type { PromptTable } from '@/core/extractor/types';

/**
 * 04-prompt.md — this is where S-01's structural isolation lives (design
 * doc §8.1). The element table is this product's only untrusted input (see
 * CONTEXT.md's `Element table` entry): every control name on it is text an
 * attacker who controls the page could have written. `buildPrompt` never
 * tries to detect whether that text *looks like* an instruction — §8.1 is
 * explicit that heuristic can't be made to work and would misfire on the
 * exact content (an article discussing prompt injection) that must reach
 * the model untouched. What it does instead is structural: wrap the
 * serialized table between a pair of tags carrying a nonce generated
 * *after* extraction, so no page author can predict it while writing the
 * page, and therefore cannot forge a closing tag that ends the wrapper
 * early.
 */

/**
 * The three S1 envelope shapes (`ExplainEnvelope` / `ClarifyEnvelope` /
 * `NeedTextEnvelope` in `contract.ts`), spelled out with field lists and an
 * example each — "return valid JSON" is not enough for a model to hit these
 * exact field names, and `parseContract` rejects anything else.
 */
export const ENVELOPE_SHAPE_GUIDE = `你的回答必须是且只能是以下三种信封（envelope）之一的 JSON 对象，不要输出信封之外的任何文字、解释或代码块标记。

1. explain —— 直接回答用户的问题
{"intent":"explain","answer":"...你的回答文字...","refs":["e12","e7"]}
- answer：字符串，你的回答正文。
- refs：字符串数组，只列出**直接支撑这次回答**的元素，通常 1～3 个，最多 5 个；页面上还有别的相关元素也不要一并列出——refs 会被逐个高亮给用户看，列得越多越像整页都在闪，反而指不出重点。这次回答没有依据页面内容就给空数组 []。

2. clarify —— 问题有歧义，需要用户先选一个
{"intent":"clarify","question":"...向用户提出的澄清问题...","options":[{"ref":"e7","label":"..."}]}
- question：字符串，向用户提出的澄清问题。
- options：数组，每一项是 {"ref":"元素表里的 ref","label":"这个选项的说明文字"}；列出全部候选，不要替用户选一个。

3. need_text —— 回答需要页面正文文字，而元素表里没有
{"intent":"need_text","query":"...你需要读到什么内容才能回答...","blocks":[]}
- query：字符串，说明你需要读到什么内容才能回答。
- blocks：字符串数组，本次没有可引用的正文分块就给空数组 []，不要编造。`;

/**
 * The three envelope shapes 01-guide-envelope-smoke.md adds for `guide`
 * mode: `guide` itself, `clarify` (CL-1's "most common normal path" — a
 * model that self-declares ambiguity), and `need_docs` (§6.1's source ①,
 * routed through a real on-page link element rather than any URL the model
 * might otherwise invent — §8.2 is explicit that the model only ever names a
 * `ref`, never a URL).
 *
 * `route` is spelled out as the one field in this whole prompt the model is
 * *allowed* to invent (design doc §1.3): it carries no `ref` and no control
 * name, so nothing it says there can point the renderer at anything on the
 * page. `steps` is the opposite: every step must name a `ref` that exists on
 * the element table below, because that table — not this instruction — is
 * the only thing standing between "the model is confident" and "the model is
 * confident and wrong" (§1.3's probe: an honest opt-out in the prompt did
 * not stop 4/4 confident fabrications on unknowable products).
 *
 * `guide`'s "离目标更近一点就够了" clause, and the narrower `clarify` trigger
 * beside it, come from the first live multi-page run: 8 of 12 samples came
 * back `clarify` and only 2 came back `guide`. The model was reading "当前页
 * 面上找不到任何合理起点" literally and correctly — on a first page, the
 * control that finishes the job genuinely is not there. But it is not the one
 * this page is being asked about: `steps` is scoped to the current page by
 * design, and every page after this one gets its own call with its own table.
 * So the instruction had to say what a good first step *is*, positively —
 * telling the model to clarify less would only have made `clarify` the more
 * available word.
 */
export const GUIDE_ENVELOPE_SHAPE_GUIDE = `你的回答必须是且只能是以下四种信封（envelope）之一的 JSON 对象，不要输出信封之外的任何文字、解释或代码块标记。

1. guide —— 目标可以达成，给出粗路标全貌与在当前页面上能做的具体步骤
{"intent":"guide","route":[{"at":"...在哪一页/哪个区域...","goal":"...要在那里完成什么..."}],"steps":[{"ref":"e04","action":"click","why":"...选择这一步的理由...","expect_after":{"via_ref":"e04","must_contain":{"role":"button","name":"..."}}}]}
- route：数组，粗路标序列，只描述"在哪一页、要完成什么"，绝不写出任何具体控件名或 ref——这是给用户看全貌、供账单前置估算用的概览，不驱动任何点击。你没有看到那些页面，允许凭你对这类产品的一般了解给出合理推测，错了代价很小。目标一页就能完成时，route 可以只有一项。
- steps：数组，至少一项，每一项只能引用**下面这张元素表里真实存在**的 ref。绝不能引用表里没有的 ref，也绝不能引用"下一页才会出现"的控件——你现在只能看见这一页，只能规划这一页上能做的动作；等用户走到下一页，你会收到新的元素表，再规划下一步。
- 大多数目标要跨好几个页面才能完成，所以**这一页上正确的一步，通常只是"离目标更近一点"，而不是"直接完成目标"**。当这一页没有最终目标控件、但有能把用户带得更近的入口（导航项、链接、搜索框、菜单、按钮）时，就输出 guide，让 steps 指向那个入口，并在 why 里说明它通向哪里。
  - ref：字符串，必须是元素表里出现过的 ref。
  - action：字符串，从 click / input / select / toggle / scroll / observe 中选一个，说明用户接下来应当对这个元素做什么操作。
  - value：可选字符串，只在 action 是 input 时给——你要用户往这个框里输入的**具体文字**。搜索框尤其要给：先想清楚这个站点的搜索怎么写才能命中，再把那段文字写进来（比如要找某个组织下的项目，就写出组织限定加关键词，而不是只写组织名）。只有用户自己才知道的内容（实例名、备注）就省略这个字段。
  - why：字符串，选择这一步的理由。
  - expect_after：可选字段。只有在你确实有把握判断"点了/填了这一步之后会出现什么"时才给，没有把握就整个省略这个字段，不要编造。
    - via_ref：字符串，元素表里那个会导致跳转或变化的 ref（通常与 ref 相同）。
    - must_contain：可选。落地后应当出现的控件形状 {"role":"...","name":"..."}，给不出就省略，不要编。

2. clarify —— 你必须先得到用户的回答才能继续：目标本身有歧义（这一页上有多个同样合理的对象，你无法判断用户指的是哪一个），或者这一页上连一个能让用户更接近目标的入口都没有
{"intent":"clarify","question":"...向用户提出的澄清问题...","options":[{"ref":"e7","label":"..."}]}
- question：字符串，向用户提出的澄清问题。
- options：数组，每一项是 {"ref":"元素表里的 ref","label":"这个选项的说明文字"}；列出全部候选，不要替用户选一个；页面上确实没有任何候选就给空数组 []。

3. need_docs —— 需要读一份站内文档的正文才能确定下一步该怎么做
{"intent":"need_docs","via_ref":"e88","query":"...你想从那份文档里找到什么..."}
- via_ref：字符串，必须是元素表里那个指向文档/帮助/wiki 的链接元素的 ref，不是 URL——你从不输出 URL，只输出 ref。
- query：字符串，说明你需要从那份文档里读到什么内容才能继续规划。

4. done —— 用户要做的事已经做完，这一页上再没有任何能推进目标的可操作控件
{"intent":"done","why":"...凭当前这张元素表的哪些内容判断已经做完了..."}
- why：字符串，说明你凭元素表里的什么判断已经做完。
- **只要元素表里还有一个能让用户更接近目标的可操作控件，就输出 guide 指向它，不要输出 done。** 目标涉及的东西出现在页面上，只说明看得见，不说明做完了：用户说"把地址复制下来"，地址显示出来了、而表里还有一个复制按钮，那就指那个复制按钮。
- done 留给这一页上确实再没有这种控件的时候；不确定就照常给 guide 或 clarify。`;

/**
 * The two marks `toPromptText` (`project.ts`) actually emits. This text has
 * to track that function's real symbols verbatim — see project.spec.ts's
 * "整份输出的确切形状" test for what the byte-level output looks like — not
 * a paraphrase of intent, or the model is told about marks that never
 * appear on a real line.
 */
export const MARK_GUIDE = `元素表里的名字可能带两种标记：
- 名字前的 ~（例如 ~"delete-file"）：这个名字不是用户在屏幕上能看到的文字，而是从 title/href/testid 等属性猜出来的兜底名字，说“点击写着 xxx 的按钮”是不成立的，因为屏幕上根本没画出这几个字。
- 名字后的 !secret（例如 "登录密码" !secret）：这是凭据、支付或验证码一类的敏感输入框，禁止在 refs/options 里引用它，也不得提议用户填写它。`;

/**
 * No `locale` parameter reaches `buildPrompt` (product decision, §0.3 of
 * the design doc): the only signal for what language to answer in is the
 * literal language of `goal` itself, and this instruction is therefore a
 * fixed string, never templated per call. Separately, §0.3's own finding is
 * that referring to controls works from the table's real (page) language
 * regardless of the question's language, so this also tells the model not
 * to translate names it copies out of the table.
 */
export const LANGUAGE_GUIDE = `请使用用户这次提问所使用的语言作答，判断依据是这句提问本身的字面语言，而不是页面内容的语言——页面是中文而用户用马来文提问时，回答用马来文。引用元素表里的控件时按表里实际写的名字原样引用，不要翻译或改写成提问的语言。`;

/**
 * Restated next to the goal, not only in the system prompt.
 *
 * The first real-model smoke run answered a Malay question in Chinese: the
 * system-prompt instruction sat ~600 tokens away from the point of
 * generation, with the whole Chinese element table in between, and the
 * table's language won. Moving the goal *after* the table and repeating the
 * requirement inline is what actually made it hold — see `USER_TEMPLATE`.
 */
const GOAL_LEAD_IN = '用户的提问如下。请用与这句提问相同的语言作答：';

const WRAP_TAG = 'untrusted_page_content';

/**
 * The nonce is generated *after* extraction, from the extension's own
 * `crypto.randomUUID()` — a page author writing hostile control names has no
 * way to see it before it exists, so no name on the page can ever forge a
 * closing tag that matches it. This is the whole mechanism S-01 relies on
 * (design doc §8.1): structural unpredictability, not content filtering.
 */
function nonceFor(serialized: string): string {
  let candidate = crypto.randomUUID();
  // The one edge case that needs explicit handling (04-prompt.md Gotchas):
  // if the serialized table happens to already contain the candidate
  // string, a forged closing tag using that same string would no longer be
  // distinguishable from the real one — regenerate rather than assume the
  // odds are low enough to ignore.
  while (serialized.includes(candidate)) candidate = crypto.randomUUID();
  return candidate;
}

function wrap(serialized: string, nonce: string): string {
  return `<${WRAP_TAG} nonce="${nonce}">${serialized}</${WRAP_TAG} nonce="${nonce}">`;
}

export function buildPrompt(goal: string, table: PromptTable): ChatMessage[] {
  const serialized = toPromptText(table);
  const nonce = nonceFor(serialized);
  const system = [ENVELOPE_SHAPE_GUIDE, MARK_GUIDE, LANGUAGE_GUIDE].join('\n\n');
  // Page content first, the user's own question last. Two reasons, both
  // learned from the first real-model run rather than reasoned about up
  // front: the model answers in the language of whatever it read most
  // recently, so the goal has to be the last thing it reads; and putting our
  // framing after the untrusted block means the final instruction in context
  // is ours, not text the page author controls.
  const user = `${wrap(serialized, nonce)}\n\n${GOAL_LEAD_IN}\n${goal}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * `guide` mode's prompt builder. Deliberately a
 * near-duplicate of `buildPrompt` rather than a parameterised merge of the
 * two: nonce generation, wrapping and the goal-last ordering are the one
 * mechanism both share, and are reused verbatim (`nonceFor`, `wrap`,
 * `GOAL_LEAD_IN`) rather than reinvented — see the Seam note in
 * 01-guide-envelope-smoke.md. Everything else (which shape guide, which
 * fields the model may invent) differs enough between the two call sites
 * that a shared "mode" parameter would just be an if-branch wearing a
 * function signature.
 *
 * Same ordering discipline as `buildPrompt`, learned the same way (first
 * real-model run, see `GOAL_LEAD_IN`'s doc comment): the field-shape guide
 * for `route`/`steps`/`expect_after` is long, but it stays in the system
 * message, *before* the element table. `goal` remains the last thing in the
 * user message, after the table — moving it earlier "to sit closer to the
 * now-longer shape guide" is exactly the regression that comment warns
 * against.
 */
/**
 * Where the guide has already been. Assembled by the host from
 * `ThreadState.history`/`ThreadState.route`, never by this file.
 *
 * Both halves exist because a replan is a brand-new conversation — the model
 * is handed a goal and a table and nothing else. Five live rounds on
 * github.com all ended the same way: on the page the user had just been sent
 * to, the model proposed the very step that sent them there. It was not
 * failing; with no record of what it had said and no shape for "you have
 * arrived", pointing at the most goal-shaped control was the best of the
 * three moves it had.
 */
export interface GuideHistory {
  /** Steps already put on screen, oldest first. */
  done: readonly { title: string; url: string; outcome: string; landedAt?: string }[];
  /** The waypoints given last time, so the next set continues the journey
   *  rather than restarting it. Still replaced wholesale in `ThreadState`
   *  (05's rule, unchanged) — continuity comes from what the model *reads*,
   *  never from us concatenating what it writes. */
  route: readonly GuideRouteHop[];
}

const OUTCOME_TEXT: Record<string, string> = {
  confirmed: '照做了，页面确实变了',
  invalidated: '这一步的目标在页面上找不到了',
  unknown: '还没有确认',
};

/**
 * Stated as accomplished fact plus an exit, never as a prohibition. "不要再指
 * 同一个控件" would drag that control into context and make it *more*
 * available, not less; saying where the user has already been, and that `done`
 * exists, removes the reason to repeat instead.
 */
function historyText(history: GuideHistory): string {
  if (history.done.length === 0 && history.route.length === 0) return '';
  const parts: string[] = [];
  if (history.route.length > 0) {
    parts.push(
      `你上一次给出的粗路标是：${history.route.map((h) => `${h.at} → ${h.goal}`).join('；')}——那是站在**上一页**给出的。用户已经照做并到了新的页面，所以这条路标里已经走完的部分不用再走一遍；请基于下面这张新的元素表，重新给出从**现在这一页**往前的路标。`,
    );
  }
  if (history.done.length > 0) {
    const lines = history.done.map(
      (d, i) =>
        `${i + 1}. 在 ${d.url} 让用户操作了「${d.title}」——${OUTCOME_TEXT[d.outcome] ?? d.outcome}` +
        (d.landedAt ? `，之后到了 ${d.landedAt}` : ''),
    );
    parts.push(`你在这条引导里已经让用户做过这些（最早的在前）：\n${lines.join('\n')}`);
    parts.push('如果根据下面这张元素表判断目标已经达成，就输出 done。');
  }
  return parts.join('\n\n');
}

export function buildGuidePrompt(goal: string, table: PromptTable, history?: GuideHistory): ChatMessage[] {
  const serialized = toPromptText(table);
  const nonce = nonceFor(serialized);
  const system = [GUIDE_ENVELOPE_SHAPE_GUIDE, MARK_GUIDE, LANGUAGE_GUIDE].join('\n\n');
  // History sits between the untrusted page block and the goal — after the
  // page so it is ours and not the page author's last word, before the goal so
  // `GOAL_LEAD_IN`'s ordering discipline survives (the model answers in the
  // language of whatever it read most recently).
  const past = history ? historyText(history) : '';
  const user = [wrap(serialized, nonce), past, `${GOAL_LEAD_IN}\n${goal}`].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * §5.9 of the design doc: a repair call is a brand-new minimal conversation,
 * never the original one with the bad output appended. Resending the page
 * content would both cost money a second time and hand an attacker-authored
 * string to the model a second time for no reason — so this function's
 * signature has no place to put a `PromptTable` or a `goal` even if a caller
 * wanted to, which is the point (see slice 14 in prompt.spec.ts).
 */
export function buildRepairPrompt(previousOutput: string, expectedShape: string): ChatMessage[] {
  const system = [
    '你上一次的输出未能被解析为合法的信封（envelope）结构，这是一次独立的修复请求：看不到原始问题，也看不到页面内容，只有你上一次的输出和下面这份形状说明。',
    expectedShape,
    '请只输出修正后的 JSON 对象本身，不要包含任何解释性文字、道歉或代码块标记。',
  ].join('\n\n');
  const user = `你上一次的原始输出如下，请对照上面的形状说明修正它：\n\n${previousOutput}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
