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
/**
 * How to pick a control, and how far to plan once picked.
 *
 * Stated as rules about *kinds* of controls and *kinds* of state change —
 * never as the particular controls one site happens to have. An earlier
 * version of this text named Copilot, Chat and Assistant, quoted `Model:` /
 * `Send` / `Token` as the giveaway neighbours, and illustrated the
 * follow-through with a literal search-and-type. All of that came from one
 * live corpus on one site, and a model that matches those strings has learned
 * that corpus, not the judgement. The first control it meets whose name is not
 * on the list gets picked by `role` again.
 *
 * The two halves are one block because splitting them regressed the second.
 * The selection rules came first, from a run where 21 first hops split 10/8
 * between a dashboard's assistant chat box and its real global search, every
 * one of the ten reasoning that typing needs a `textbox` and that was the only
 * `textbox`. Those rules alone measured better on aim and worse on
 * everything: search-entry hit rate 38% → 57%, multi-step plans 43% → 0%.
 * Three rules all phrased as "how to choose one control" collapsed the
 * model's horizon onto choosing one control — and the half that was lost is
 * the half that carries a user *through* a control that only reveals
 * something. Four of seven journeys then died on an opened dialog with
 * nothing planned for it.
 *
 * So the second half is framed by what an action *does to the page* — leaves
 * it, changes it in place, or enters data — because that is what decides
 * whether a plan is finished, on any site. Only leaving the page ends what
 * can be planned; the other two leave the user standing where they are, and a
 * plan that stops there has surfaced a means without using it.
 *
 * The assistant rule is the third attempt at one control, and the first two
 * failed for a reason worth writing down. A site's own chat box was picked as
 * the "general entrance" on 2 of 7 live journeys, and later burned the whole
 * 12-call quota on 3 of 14 — the guide walks into the conversation and keeps
 * planning inside it.
 *
 * The first attempt named products (Copilot / Chat / Assistant / AI / 助手).
 * That is a list to memorise, not a judgement: the first assistant whose name
 * is not on it gets picked again.
 *
 * The second leaned on the scope rule above ("名字里限定了归属的控件…"), and
 * that reads backwards for this case. These controls are *named to sound
 * universal* — "Ask anything", "有什么可以帮你", "describe what you need" —
 * with the product name trailing like branding. A rule keyed on "does the
 * name limit its scope" cannot fire on a name that claims no limit.
 *
 * The third attempt asked the model to notice what the control wants from the
 * user — "it asks you to say something in your own words" — and that failed
 * too, in a way worth recording: the model never classified the box as an
 * assistant at all. Its own stated reason for picking it was 「点击**搜索框**
 * 以定位 n8n 项目」. A search box's placeholder says exactly the same thing
 * ("Ask anything", "问我任何问题"), so a rule that fires on the box's own
 * wording cannot separate them, and everything downstream of "once you have
 * recognised an assistant" never runs.
 *
 * So this one reads the group instead, which is the one place the difference
 * is unambiguous and already on screen. The live table has the assistant's
 * textbox sitting beside 「Model: Auto」, 「Send now (enter)」, 「Add files, and
 * spaces」 and 「View token usage」; the real search entry sits among Homepage,
 * Dashboard and Create new. No search box anywhere has a model picker next to
 * it. It is also not a new axis — it is the neighbours rule one bullet above,
 * applied to the one case that keeps costing whole journeys.
 *
 * The closing clause is why this is expensive rather than merely useless: the
 * panel really does change the page, so a "did this step work" check answers
 * yes, and the journey continues inside a conversation that goes nowhere.
 *
 * The same-ref-twice mechanic is the one implementation fact that has to be
 * said outright: a control that does not exist yet has no ref, and reusing
 * the ref of whatever reveals it is the only way to express "make it appear,
 * then act on it". It is already legal — `validateEnvelope` checks that each
 * ref exists, not that refs are distinct.
 *
 * Placed before `MARK_GUIDE`, not after: `!secret` sits near the end of the
 * system message and the distance from it to the end must not grow — see
 * golden-guide-envelopes.ts's header for what happens when it does.
 */
export const CHOICE_GUIDE = `挑控件、以及挑定之后要规划到哪里，按下面两组判断。

**一、按控件做什么来挑，不按它长什么样来挑：**
- 名字说明这个控件做什么，role 只说明它长什么样。"需要输入"不等于"要找一个 role 是 textbox 的控件"——把输入框唤出来的那个控件常常是按钮、链接或菜单项，判断依据是它的名字，不是它的 role。
- 名字里限定了归属的控件，只做它所归属的那件事。名字指明它属于某个功能、某个模式、某个具体对象时，它就只在那个范围内生效，不是同类操作的通用入口；用它只会进入那个范围，不会推进你真正的目标。
- 同一分组里的其它控件说明这一片是什么区域，一个控件的用途不会超出它所在区域的用途。名字含糊时，看它的邻居在做什么，比硬猜这个名字更可靠。
- **助手的输入框，看它的分组认，不看它自己的名字认。** 这类输入框的名字往往就写着"问我任何问题""Ask anything"，和搜索框的提示语一模一样，光读名字分不出来——上一条说的"用邻居判断这一片是什么区域"，在这里是唯一可靠的办法。**看同一个分组里还有什么**：出现选模型、发送、上传附件、新建对话、用量统计这类控件，那一片就是一个对话面板，那个输入框是它的输入口。往里面填字只会换来一段回答，用户还站在原地——但页面确实变了，很容易被当成"这一步生效了"，接着一路在对话里绕。**同一页上另有站内搜索时，搜索才是入口**；只有用户的目标本身就是"问这个助手"，才选它。

**二、一次规划到"用户离开这一页"为止：**
- 先判断这一步会造成哪一类变化：**跳到另一个页面** / **让这一页显示出新的东西**（展开、弹出、切换、显示更多）/ **填入内容**。
- 只有第一类是你能规划的终点。用户去了你没见过的页面，那里的事等你收到新的元素表再说。
- 后两类，用户仍然站在这一页。那一步之后要做什么，属于**这一次**规划，必须写进同一份 steps，不要留给下一次。
- 新出现的控件还不在元素表里时，就重复引用**把它显示出来的那个 ref**，用 action 区分先后。这是合法的，也是表达"先让它出现，再对它操作"的唯一写法。
- 收尾自检：走完你写的最后一步，用户是**更接近目标了**，还是只是**现在可以去做了**？如果是后者，这份计划还没写完。`;

/**
 * What `toPromptText` (`project.ts`) actually emits. This text has to track
 * that function's real symbols verbatim — see project.spec.ts's "整份输出的确切
 * 形状" test for what the byte-level output looks like — not a paraphrase of
 * intent, or the model is told about marks that never appear on a real line.
 *
 * The `page` line is the one thing here the model cannot get from any other
 * part of the prompt, and saying what it is for is the point: five live
 * journeys re-proposed a control the user had just used because nothing in
 * context distinguished the page before the click from the page after it.
 *
 * What it must *not* say is that an unchanged `page` means the step failed.
 * It said exactly that, and `CHOICE_GUIDE`'s second half says the opposite —
 * a step that expands a menu or opens a dialog leaves the user on the same
 * page by design, and is a legitimate half of a plan. Both were in the same
 * system message, and the last live run repeated a step on 16 of 47 hops.
 *
 * The verdict itself has since moved out of here entirely: the `guide` tool
 * requires a `previous_step` field, so the model states what the last step
 * accomplished before it plans the next one, instead of being told in prose
 * how to infer it. This line is back to describing what `page` *is*, which is
 * the only thing here the model cannot get from anywhere else.
 *
 * The login paragraph is the constructive half of `!secret`, and it loosens
 * nothing. Both prohibitions stand exactly as they were: the model may not
 * reference a sensitive ref, and may not write a `value` for one. What it may
 * do — and previously had no way to express — is point at the submit control
 * beside them and say, in `why`, that the user signs in first with their own
 * credentials. Without that, a login wall is a dead end: every operable
 * control on the page is either forbidden or the submit button, so the guide
 * had nothing left to offer but a question. Telling someone "填完之后按这里"
 * is not proposing what to type; only a `value` would be, and that stays out.
 */
export const MARK_GUIDE = `元素表开头两行说明你现在在哪一页：
- page：当前页面的地址（主机名+路径+查询串，省略协议与锚点）。**这是你判断"用户有没有被带到新页面"的唯一依据**——同页展开、弹出不会改变它，那一类变化要看元素表里有没有多出原先没有的控件。
- title：当前页面的标题。
- truncated：这一行只在元素表被裁剪过时出现。**看到它就意味着你没有看到这一页的全部**——"表里没有"不等于"页面上没有"。这时不要据此断定这一页没有入口、也不要据此断定目标不在这里；照常从你能看到的里面挑一个能让用户更近一步的。表的最后还会多出一行「[表到此为止 · 这一页还有 N 个元素没有列出]」，N 是确切的个数。被略去的不是页面上连续的一段：导航、页头页脚、侧栏这类入口会优先保留，所以**没列出来的更可能是正文里的东西，而不是入口**。

元素按层级缩进：以冒号结尾的行是分组（地标区域、标题、表格行），缩进在它下面的元素属于这个分组。同一个分组名可能出现多次，那表示页面上确实有两段分开的、同名的区域。

元素表里的名字可能带两种标记：
- 名字前的 ~（例如 ~"delete-file"）：这个名字不是用户在屏幕上能看到的文字，而是从 title/href/testid 等属性猜出来的兜底名字，说“点击写着 xxx 的按钮”是不成立的，因为屏幕上根本没画出这几个字。
- 名字后的 !secret（例如 "登录密码" !secret）：这是凭据、支付或验证码一类的敏感输入框，禁止在 refs/options 里引用它，也绝不为它写 value。

这一页要先登录才能继续时（表里有 !secret 的账号密码框，旁边有一个提交按钮），不要就此停下来问用户：**指向那个提交按钮**（登录 / Sign in / 继续），在 why 里说明请他先自己把账号密码填好再点。填什么只有他自己知道——你不引用那两个框，也不替他写内容，你做的是把"填完之后按哪里"指出来。`;

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

/**
 * What the deleted envelope-shape guide said that a JSON Schema cannot.
 *
 * On the tool-calling path the schema *is* the shape, so describing the same
 * field lists in prose costs money to say everything twice — measured at +30%
 * per call before this text replaced it. But the shape guide was never only
 * shape: it also carried the policy for *which* envelope to reach for, and
 * deleting it wholesale moved the model from 24-of-24 `guide` answers to 5 of
 * 8 `clarify`. Stalling to ask a question is not a cheaper right answer; it is
 * the journey not happening. So the policy stays and only the field lists go.
 *
 * Nothing here names a site. The entrances it lists ("搜索框、导航项、菜单、
 * 筛选器、任何一列可点的条目") are shapes any page can have; an earlier draft
 * said 「仓库列表」 and an earlier `value` example talked about finding a
 * project under an organisation, both of which are one forge's vocabulary
 * wearing the clothes of a general rule.
 *
 * `done` is keyed on the goal being *reached*, not on the page having run
 * out of controls. The earlier wording — "这一页上确实再没有任何能推进目标的
 * 可操作控件" — was the same trigger `clarify` already has ("连一个能让用户更
 * 接近目标的入口都没有"), so two tools competed for one condition and the
 * model had nothing to separate them by. It showed: journeys ended in `done`
 * on goals that were never started (the corpus caught it twice), and 7 of 14
 * live rounds finished that way. The two are opposites and now say so.
 *
 * Kept deliberately short. The tool `description` fields are short for the
 * same reason and it is not only cost: a long, semantic description on the
 * `guide` function ("目标可以达成：给出粗路标全貌…") pulled the model into
 * reading a property named `intent` as "the user's intent" and filling it with
 * the goal restated. Short labels there, judgement here.
 */
export const TOOL_CHOICE_POLICY = `四个工具对应四种回答，按下面挑。**默认是 guide**，另外三个都要有明确理由才用：

- **guide**：只要这一页上还有一个能让用户离目标更近的控件，就用它。大多数目标要跨好几个页面才能完成，所以这一页上正确的一步通常只是"离目标更近一点"，而不是"直接完成目标"——导航项、链接、搜索框、菜单、按钮都算入口，在 why 里说明它通向哪里。
- **clarify**：只在你**必须先得到用户的回答才能继续**时用——目标本身有歧义（这一页上有多个同样合理的对象，你无法判断用户指的是哪一个），或者这一页上连一个能让用户更接近目标的入口都没有。**"这一页上没有直接通向目标的链接"不是理由**：搜索框、导航项、菜单、筛选器、任何一列可点的条目，都是入口；有其中任何一个就该给 guide。元素表带 truncated 时更不能这么说——你根本没看全。列出全部候选，不要替用户选一个。
- **need_docs**：需要先读一份站内文档的正文才能确定下一步。
- **done**：**用户要做的事已经做完了。** **"走不下去"和"已经做完"是相反的两件事：走不下去给 clarify，做完了才给 done。** 先分清用户要的是哪一种：
  - **他要看到某个东西**（看 issue 列表、看有哪些版本、读某份文件、确认用的是什么许可证）——**东西显示在这一页上，就是做完了**，没有下一步动作要做。这时给 done，evidence 用 content_on_page 或 page_address。不要因为"还能再点点别的"就继续给 guide。
  - **他要完成某个动作**（把地址拿到手、把某项改掉、把东西提交出去）——**看见不算做完，必须有一步已经生效**。地址显示出来了、而表里还有一个复制按钮，那就指那个复制按钮，给 guide 不给 done。

route 只描述"在哪一页、要完成什么"，绝不写出任何具体控件名或 ref。往搜索框填 value 时，先想清楚这个站点的搜索怎么写才能命中：把目标里能缩小范围的限定词一起写进去，而不是只写一个名字。`;

/**
 * The system message for the tool-calling path: the same judgement the text
 * path gets, minus the field lists the schema now carries.
 */
export const GUIDE_TOOL_SYSTEM = [TOOL_CHOICE_POLICY, CHOICE_GUIDE, MARK_GUIDE, LANGUAGE_GUIDE].join('\n\n');

/**
 * The guide's user message: the page, where this guide has already been, and
 * the goal — in that order.
 *
 * Only the user half lives here now. The system half used to spell out four
 * envelope shapes with their field lists; the tool schema carries that, so
 * saying it again would be paying twice to describe one thing (measured at
 * +30% per call). What the schema cannot say — which tool to reach for, how
 * to pick a control, how to read the page header — is `GUIDE_TOOL_SYSTEM`.
 */
export function buildGuideUserMessage(
  goal: string,
  table: PromptTable,
  history?: GuideHistory,
  siteNotes?: string,
  /** Supplied by `guide/nonce.ts` so consecutive calls on one snapshot share a
   *  cacheable prefix. Omitted here means "mint a fresh one", which is what
   *  every caller outside the run loop wants. */
  nonce = nonceFor(toPromptText(table)),
): string {
  const serialized = toPromptText(table);
  // Site notes come from a human-authored pack (ADR 0011), so they go *before*
  // the untrusted block and never inside it — putting our own text under the
  // nonce would teach the model that content in there can be trusted, which is
  // the one thing S-01's wrapper exists to deny.
  //
  // In the user message rather than the system message on purpose: the system
  // message must stay byte-identical across every site for the endpoint's
  // prefix cache to hit (measured at 896–1664 cached tokens per call), and a
  // per-site paragraph up there would cost that on every single request.
  const notes = siteNotes ? `关于这个站点，你需要知道：\n${siteNotes}` : '';
  // History sits between the untrusted page block and the goal — after the
  // page so it is ours and not the page author's last word, before the goal so
  // `GOAL_LEAD_IN`'s ordering discipline survives (the model answers in the
  // language of whatever it read most recently).
  const past = history ? historyText(history) : '';
  return [notes, wrap(serialized, nonce), past, `${GOAL_LEAD_IN}\n${goal}`].filter(Boolean).join('\n\n');
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
