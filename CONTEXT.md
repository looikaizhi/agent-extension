# Page Guide

一个只读网页的 Chrome 扩展：抽取页面上的可交互元素，交给模型判断用户想去哪里，然后在页面上把目标指出来。只指路，不开车——扩展从不代替用户点击或输入。

## Language

### 页面与元素

**Ref**：
一次快照内对某个元素的短句柄（`e12`）。跨快照无意义。
_Avoid_: id, handle, selector

**Snapshot**：
一次抽取产生的元素集合，带一个 generation 标识。页面结构变化即作废。
_Avoid_: page state, DOM state

**Descriptor**：
不依赖快照的元素身份，由作者能从页面上读出来并写下来的字段组成（role、name、scope、nth）。用于快照失效后重新找到同一个元素。
_Avoid_: locator, selector, query

**Bind**：
把 Descriptor 匹配到当前页面上的元素。合取过滤，不打分、不排序、不打破平局。
_Avoid_: resolve, match, find

**Element table**：
去重后、发给模型的那份元素清单。不含坐标、不含视口信息。
「裁剪」不是它的定义的一部分（ADR 0012）：它删的是 `Restatement`，删完仍然超预算才按文档顺序切掉末尾，并在表尾写明切掉了多少。**永远不按「和目标有没有关系」决定谁留下**——那个问题需要 Mind2Web 那样专门训练的模型才答得对，词法打分实测会留噪音、丢正解。
_Avoid_: DOM dump, page context, snapshot

**Restatement**：
同一个可交互目标在表里说的第二遍：**一层自身没有可交互角色、只裹着唯一一个可交互后代的空壳**。删它不丢任何可点目标——点那个后代是空壳唯一能提供的东西，所以是**无损**的。
判据是**结构性的，不是名字**。初稿曾写成「名字重复了同页另一条」，实现时被自己的语料证伪：仓库页一行提交里，目录链接、PR 号链接、提交历史链接三者名字互相包含，却指向三个不同的地址——按名字删任何一条都是丢目标。名字像不像不足以判定可删。
判据与用户说哪种语言无关，这是它和「按相关性裁剪」的分界。
_Avoid_: duplicate, noise——它们不说明「重复的是什么」；`Restatement` 特指同一目标的复述，不含同名但可点不同地方的两个控件

**Entrance**：
存在的意义就是把用户带去别处的那类地标——导航、页头页脚、标签栏、菜单、工具条、搜索区、侧栏。
超预算时它们优先留下（ADR 0012）。**刻意不是全部地标**：`main` 也是地标，按它保底等于保底整片主内容，裁剪就白做了；`region` 与 `form` 同理，任何页面都能拿它们裹住自己的正文。
保底不是豁免——入口自己就超预算时照样切尾巴，表不会被撑破。
_Avoid_: nav, chrome——前者只是其中一种，后者把浏览器界面和页面内容混为一谈

**Sensitive**：
凭据、支付或 2FA 输入框。会出现在元素表里（诊断需要），但永远不可高亮。
_Avoid_: private, protected, secret field

### 流程

**Thread**：
一次多步引导的持久状态，含游标。每个标签页至多一个。
_Avoid_: session, conversation, flow state

**Route**：
模型给出的粗路标序列，不含 ref、不含控件名，用于全貌展示与账单前置。不驱动任何点击，允许模型编造，靠 `Step` 逐页对真表核实来证伪。

**Place**：
「那一步有没有把人带走」的粒度：只看 origin + pathname。
比 `Snapshot` 粗——同一个 Place 上控件可以来回变化（下拉展开又收回）而仍是同一个地方。
用途只有一个：兜底判断模型是不是在重复一个原地踏步的步骤。
**不**决定要不要重新规划——真机 21 条路径证伪过一次：曾把 landmark/heading 指纹也算进 Place 来当重规划的闸门，
而 GitHub 切 tab、搜索框打字都会新增 heading，同一个页面的指纹每次都变，闸门从未命中。
_Avoid_: page, screen, view——它们都不说明粒度

**Activation scope**：
一次激活（点击/展开）打开的那片子树。**尚未实现**，是「点开之后只看点开的那部分」这个想法的名字。
**不影响抽取**——抽取仍看整页，因为点开的东西通常也能从外面关掉，收窄抽取会把退路一起藏了。
_Avoid_: modal scope——`findModalScope` 是抽取期的收窄，理由是「用户被困在里面」；激活域不困人

**Arrival sketch**：
开局规划时，模型对终点长什么样的一句粗描述（「你会到达一个 n8n 仓库的主页」）。
与 `Route` 同粒度、同样允许编造。**供人辨认，不供机器断言**——它的用处是在我们认为到了的时候拿它去问用户，而不是拿它去比对元素表。
_Avoid_: expect_after——那是单步的、机器可断言的预测；两者粒度和用途都不同
_Avoid_: waypoint, plan

**Sighting goal**：
用户要的是**看到**某个东西（「看看谁提了 issue」「用的是什么许可证」）。**东西显示在这一页上，就是到了**——没有下一步动作要做。对应 `done.evidence` 的 `content_on_page` / `page_address`。
_Avoid_: read-only goal, view goal——它们描述的是权限或界面，不是「什么时候算完」

**Acting goal**：
用户要的是**完成**某个动作（「把仓库地址拿到手」）。**看见不算到，必须有一步已经生效**——地址显示出来了而表里还有复制按钮，那就该指那个复制按钮。对应 `done.evidence` 的 `step_completed`。
_Avoid_: write goal, mutation——扩展从不代替用户动手，「动作」指的是用户执行的那一步

> 这两类的区别只写在提示词里，schema 不加字段：`done.evidence` 的三个枚举值已经把分野做完了。分不开的后果实测过——把「出现在页面上不说明做完了」当通则写，压在六个 `Sighting goal` 上，模型判断出「到了」却没有工具说得出口，只好发一个说了等于没说的 `observe` 步骤。

**Step**：
引导里的一步。带一个用户应当执行的动作（`expectedUserAction`），而扩展只负责把它指出来。
_Avoid_: action, instruction, command

**Breakpoint**：
引导停下来、重新看一眼页面、再决定下一步的那个时刻。三种触发：整页导航完成、用户点了我们指的东西、页面结构自己变了。触发只是提出请求，是否真的重新规划由「页面确实变了」这一条判据说了算。
_Avoid_: checkpoint（那是持久化的存档点）, pause, interrupt

**Outcome**：
一步的即时判定结果：`confirmed`（点击且页面确实变了）｜`skipped`｜`failed`（点了但没到）｜`invalidated`（目标消失或被安全规则阻断）。与 `Check` 轴正交——`Outcome` 回答「这一步发生了什么」，`Check` 回答「到达后是否符合期望」。
_Avoid_: result, status（`status` 专指 run 级别的三个终态）

**Run record**：
一次引导从开始到终态的完整记录，含每步 `Outcome` 与 run 的三个终态（`completed` | `partially_completed` | `abandoned`）之一。是 `walked` 证据与导出的唯一数据源。
_Avoid_: history, log

**Pack**：
手写或导出的站点流程，零模型成本。
_Avoid_: recipe, template, macro

**Question**：
一次无状态的页面问答。不建 Thread、不动 Thread。
_Avoid_: query, chat turn

### 模型契约

**Envelope**：
模型返回的那个 JSON 对象，由 `intent` 区分形状。
_Avoid_: response, payload, output

**Intent**：
模型对本次请求的分类：`guide` | `clarify` | `need_docs` | `done`（引导路径的四个工具，`Intent` 就是模型调用的那个函数名），加上 `explain` | `need_text`（问答路径）。
_Avoid_: mode, action type
_Avoid_: locate——它从未是一个 `intent`；定位是 `Binding` 轴上的事

**Provenance**：
解析结果中每个值都能在模型原始输出的同一路径上找到对应字面量。解析器只许丢弃和重组，永不许发明。
_Avoid_: validation, integrity, fidelity

**Repair call**：
输出不可用之后的一次重抽，只说清上一次错在哪。每次请求至多一次，绝不成环。
**两种不可用都走它**：解析失败（`parse_error`），以及校验失败（`violation`，如 action 不在枚举内、ref 不在本次快照内）。原先只有前者有修复轮，后者只标了 `retryable: true` 而没有任何东西消费——实测两次 `violation` 各报废一整轮，因为被拒之后线程原封保留上一份已经证明走不通的计划。

**两条路径的修复轮形状不同，这是有意的：**
- **问答路径**（`buildRepairPrompt`）是一次全新的最小对话，只含上一次输出与期望形状，**不含页面内容**。
- **引导路径**把原请求整个重发，再追加一对 `assistant`(tool_calls) / `tool` 消息说明哪里不对。**不这样不行**：那对消息靠 `tool_call_id` 配对，是 OpenAI 定死的线格式，凭空出现的 assistant 轮次没有对应的用户提问；而且要修「ref 不在快照内」这类错，模型手上必须有那张表才挑得出合法的 ref。代价实测很低——同一前缀命中缓存，3712 个 prompt token 里 3584 个是缓存命中。
_Avoid_: retry, second attempt

### 失效分级

**L-0…L-4**：
定位结果的分级。L-1 唯一且正确、L-2 多候选、L-3 无命中、**L-4 唯一但错误**。
_Avoid_: accuracy tier, confidence level

**L-4**：
唯一地、自信地指错。唯一的硬零指标——「找不到」用户会重问，「指错了」用户会照做。
_Avoid_: false positive, miss

### 三个正交轴

**Evidence**：
这条流程的知识从哪来：`walked` > `documented` > `model`。运行时盖章。
_Avoid_: confidence, trust level

**Check**：
到达期望验证的结果：`pass` | `unknown` | `skipped`。
_Avoid_: verification, validation

**Binding**：
此刻能不能把它指出来：`bound` | `ambiguous` | `unbound`。渲染器盖章。
_Avoid_: resolution status

### 进程

**Host**：
service worker。唯一跨导航存活的进程，拥有 Thread、所有平台 effect 与全部授权判定。
_Avoid_: background, worker, SW

**Panel**：
侧栏。视图，兼外部世界 effect 的执行者——模型调用与文档抓取在这里发生。
_Avoid_: sidebar, UI

**Effect**：
Host 委托 Panel 执行的一次外部世界动作（`callModel` 或 `fetchDoc`），由一对消息（请求/结果）完成，具备幂等、超时、取消、恢复语义。
_Avoid_: side effect, action（这里特指跨进程委托的那一次往返，不是通用编程术语）

**Content script**：
页面里的那一份。只做抽取与高亮，只听 Host 一个指挥者。
_Avoid_: injected script, page agent
