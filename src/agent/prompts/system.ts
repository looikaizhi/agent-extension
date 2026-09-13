/**
 * Each agent's system-prompt sections (CONTEXT.md `Prompt`): the policy that
 * belongs to no one intent. What each `Tool` and `Output` says about when to
 * reach for it lives with its own module; the page, the history and the goal
 * are assembled in `context/user-message.ts`.
 */

/** A small count as these sentences write it — 两, not 二, before a measure
 *  word. Past ten it falls back to digits; nothing registers that many. */
const count = (n: number) => (n >= 0 && n <= 10 ? '零一两三四五六七八九十'[n]! : String(n));

/**
 * The opening of the question agent's answer-shape guide. Each answer's own
 * paragraph — its field list and an example — comes from its module
 * (`question/output/`), numbered in registry order: "return valid JSON" is
 * not enough for a model to hit these exact field names, and the parser
 * rejects anything else. The count is the registry's, handed in by the agent,
 * so adding an answer does not mean coming back to edit this sentence.
 */
export const answerShapeOpening = (kinds: number) =>
  `你的回答必须是且只能是以下${count(kinds)}种信封（envelope）之一的 JSON 对象，不要输出信封之外的任何文字、解释或代码块标记。`;

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
 * then act on it". It is already legal — `refsViolation` checks that each
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
- 行尾的 +new：**上一步之后才出现的控件**，只在页面没有跳转时才会出现（点开了菜单、展开了面板、弹出了对话框）。用户刚才那一下就是为了让它出现，所以它多半就是下一步要用的东西；反过来，如果这一次一个 +new 都没有，说明上一步没让页面显示出任何新东西。

这一页要先登录才能继续时（表里有 !secret 的账号密码框，旁边有一个提交按钮），不要就此停下来问用户：**指向那个提交按钮**（登录 / Sign in / 继续），在 why 里说明请他先自己把账号密码填好再点。填什么只有他自己知道——你不引用那两个框，也不替他写内容，你做的是把"填完之后按哪里"指出来。`;

/**
 * No `locale` parameter reaches `buildQuestionUserMessage` (product decision, §0.3 of
 * the design doc): the only signal for what language to answer in is the
 * literal language of `goal` itself, and this instruction is therefore a
 * fixed string, never templated per call. Separately, §0.3's own finding is
 * that referring to controls works from the table's real (page) language
 * regardless of the question's language, so this also tells the model not
 * to translate names it copies out of the table.
 */
export const LANGUAGE_GUIDE = `请使用用户这次提问所使用的语言作答，判断依据是这句提问本身的字面语言，而不是页面内容的语言——页面是中文而用户用马来文提问时，回答用马来文。引用元素表里的控件时按表里实际写的名字原样引用，不要翻译或改写成提问的语言。`;

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
 * This is the opening of that policy, which belongs to no one intent. Each
 * intent's own line comes from its module, in registry order, and
 * `TOOL_CHOICE_CLOSING` follows them (`guide/agent.ts` assembles the whole).
 * How many tools there are is the registry's count, handed in by the agent.
 *
 * Nothing in the policy names a site. The entrances `clarify`'s line lists
 * ("搜索框、导航项、菜单、筛选器、任何一列可点的条目") are shapes any page can have; an earlier draft
 * said 「仓库列表」 and an earlier `value` example talked about finding a
 * project under an organisation, both of which are one forge's vocabulary
 * wearing the clothes of a general rule.
 *
 * Kept deliberately short. The tool `description` fields are short for the
 * same reason and it is not only cost: a long, semantic description on the
 * `guide` function ("目标可以达成：给出粗路标全貌…") pulled the model into
 * reading a property named `intent` as "the user's intent" and filling it with
 * the goal restated. Short labels there, judgement in the policy lines.
 */
export const toolChoiceOpening = (tools: number) =>
  `${count(tools)}个工具对应${count(tools)}种回答，按下面挑。**默认是 guide**，另外${count(tools - 1)}个都要有明确理由才用：`;

/**
 * Where the tool-choice policy resumes after the lines each registered intent
 * brings (`guide/agent.ts` assembles the whole).
 *
 * `route` is spelled out as the one field in this whole prompt the model is
 * *allowed* to invent (design doc §1.3): it carries no `ref` and no control
 * name, so nothing it says there can point the renderer at anything on the
 * page. `steps` is the opposite: every step must name a `ref` that exists on
 * the element table below, because that table — not this instruction — is
 * the only thing standing between "the model is confident" and "the model is
 * confident and wrong" (§1.3's probe: an honest opt-out in the prompt did
 * not stop 4/4 confident fabrications on unknowable products).
 */
export const TOOL_CHOICE_CLOSING = `route 只描述"在哪一页、要完成什么"，绝不写出任何具体控件名或 ref。往搜索框填 value 时，先想清楚这个站点的搜索怎么写才能命中：把目标里能缩小范围的限定词一起写进去，而不是只写一个名字。`;
