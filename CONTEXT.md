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
「裁剪」不是它的定义的一部分：它删的是 `Restatement`，删完仍然超预算才按文档顺序切掉末尾，并在表尾写明切掉了多少。**永远不按「和目标有没有关系」决定谁留下**——那个问题需要 Mind2Web 那样专门训练的模型才答得对，词法打分实测会留噪音、丢正解。
_Avoid_: DOM dump, page context, snapshot

**Restatement**：
同一个可交互目标在表里说的第二遍：**一层自身没有可交互角色、只裹着唯一一个可交互后代的空壳**。删它不丢任何可点目标——点那个后代是空壳唯一能提供的东西，所以是**无损**的。
判据是**结构性的，不是名字**。初稿曾写成「名字重复了同页另一条」，实现时被自己的语料证伪：仓库页一行提交里，目录链接、PR 号链接、提交历史链接三者名字互相包含，却指向三个不同的地址——按名字删任何一条都是丢目标。名字像不像不足以判定可删。
判据与用户说哪种语言无关，这是它和「按相关性裁剪」的分界。
_Avoid_: duplicate, noise——它们不说明「重复的是什么」；`Restatement` 特指同一目标的复述，不含同名但可点不同地方的两个控件

**Entrance**：
存在的意义就是把用户带去别处的那类地标——导航、页头页脚、标签栏、菜单、工具条、搜索区、侧栏。
超预算时它们优先留下。**刻意不是全部地标**：`main` 也是地标，按它保底等于保底整片主内容，裁剪就白做了；`region` 与 `form` 同理，任何页面都能拿它们裹住自己的正文。
保底不是豁免——入口自己就超预算时照样切尾巴，表不会被撑破。
_Avoid_: nav, chrome——前者只是其中一种，后者把浏览器界面和页面内容混为一谈

**Sensitive**：
凭据、支付或 2FA 输入框。会出现在元素表里（诊断需要），但永远不可高亮。
_Avoid_: private, protected, secret field

### 流程

**Thread**：
一次多步引导的持久状态，含游标。每个标签页至多一个，存在 `storage.session` 的 `guide:{tabId}` 键下；进入任何终态就删除——删之前先把摘要写进 `Run record`。
计划有两种来源：模型规划，或 `Fixed plan`。
推进它的是一个纯函数（归约器）：不 `await`、不碰网络、不碰 `chrome.*`。这是它能在 service worker 被回收之后靠持久化状态重放、单元测试能在 node 里秒级跑完的全部理由。
_Avoid_: session, conversation, flow state；也不是 workflow 或 memory——前者是能被回放的步骤序列，后者是跨运行的经验，Thread 只活一趟

**Fixed plan**：
调用方交来的一串已经写好的步骤（检视器点的那一行）。落地即画出第一步，**永不调用模型**——包括等待窗口关闭之后。只在用户用过这一步的目标、或按了「跳过」之后才前进；用户自己去了别处、页面自己变了，都只把同一步在当下的页面上重画。步骤带的是 `Descriptor`，不是 `Ref`：`Ref` 只在它所属的快照里有意义。
_Avoid_: pack flow, recipe——站点包里曾经有可执行的流程，那一半已经删掉

> 为什么只剩一套引导实现。旧实现有三条入口：检视器交来的步骤、站点包的流程、本地词法基线。前两条不需要判断——前者现在就是 `Fixed plan`，后者的流程已删、说明站点的那一半成了今天的 `Skill`；第三条依赖一个在真实页面上几乎不可达的定位器：打分器有子串兜底，几百个控件的页面上总能撞上几个，所以「找不到才交给模型」这个放行条件，在 github.com 上四个目标、两种语言里一次都没成立。后果是整个阶段里产品正门在真实网站上一次都没启动过——**139 条 e2e 全绿而多个缺陷仍然存活**，因为每条 e2e 用的都是小 fixture，放行条件只在那里成立。
>
> 本地词法只**部分**退场：候选排序随旧实现走了，打分与中文分词保留——离线评测用它做零模型下界。

**Workflow**：
一条存下来、能再次走一遍的步骤序列，从用户确认 `Arrival` 的运行里生成。**尚未实现**。
只有用户在侧栏挑中它才回放。回放时和 `Fixed plan` 一样：只在用户用过这一步之后才前进，不调用模型。唯一的区别是某一步找不到目标时，它交给模型接着规划——页面会变，回放不能在那里停死；Fixed plan 则永不调用模型。
从走通的运行里归纳出、放进 prompt 给模型参考的抽象步骤**不是** Workflow：它不被回放，而是被读，属于 `Memory`。
_Avoid_: recipe, macro, flow

**Route**：
模型给出的粗路标序列，不含 ref、不含控件名，用于全貌展示与账单前置。不驱动任何点击，允许模型编造，靠 `Step` 逐页对真表核实来证伪。

**Place**：
「那一步有没有把人带走」的粒度：只看 origin + pathname。
比 `Snapshot` 粗——同一个 Place 上控件可以来回变化（下拉展开又收回）而仍是同一个地方。
用途：判断那一步有没有把人带走（落点）、兜底判断模型是不是在重复一个原地踏步的步骤、只在同一个 Place 上给新出现的控件打标记，以及判断刚抽出的元素表是不是标签页此刻所在的那一页。
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

**Arrival**：
最终停在对的地方，**并且**屏幕上的最后一步指对了——两者都要。由人或 eval 判定，产品运行时不判：它不知道用户的目标该在哪一页结束。引导结束时产品会问用户一句「到了吗」，用户的回答就是这一趟的 Arrival。「对的地方」长什么样，由目标是 `Sighting goal` 还是 `Acting goal` 决定。
_Avoid_: completed, success——「全部确认」是 `Run record` 的确认程度，不是到了；success 不说明是谁判的

**Step**：
引导里的一步。带一个用户应当执行的动作（`expectedUserAction`），而扩展只负责把它指出来。
_Avoid_: action, instruction, command

**Breakpoint**：
引导停下来、重新看一眼页面、再决定下一步的那个时刻。三种触发：整页导航完成、用户点了我们指的东西、页面结构自己变了。触发只是提出请求，是否真的重新规划由「页面确实变了」这一条判据说了算。
_Avoid_: checkpoint（那是持久化的存档点）, pause, interrupt

**Outcome**：
一步的即时判定结果：`confirmed`（点击且页面确实变了）｜`skipped`｜`failed`（点了但没到）｜`invalidated`（目标消失或被安全规则阻断）。与 `Check` 轴正交——`Outcome` 回答「这一步发生了什么」，`Check` 回答「到达后是否符合期望」。
_Avoid_: result, status（run 级别另有「怎么结束的」与「确认了多少步」）

**Run record**：
一次引导从开始到终态的完整记录，含每步 `Outcome`，以及分开记的两件事：**这一趟怎么结束的**（归约器自己走到的五种：模型说到了、步骤走完了、打转兜底、配额用完、跨站凭据停止；来自外部的四种：用户结束、关浮层、关标签页、被同一标签页上新的一趟接替）与**确认了多少步**（全部、部分、一步都没有）。两者互不推导：前三步都确认了、然后撞上配额的一趟，是「配额用完 + 部分确认」。是 `walked` 证据与导出的唯一数据源。
**确认程度不是 `Arrival`**：「确认」只说明用户点了、页面变了，不说明方向对。真机第七轮有 16 趟全部确认，按 URL 只有 8 趟到了。
_Avoid_: history, log

**Memory**：
跨运行、由产品自己写入、下一次引导时读进 prompt 的经验。**尚未实现**。
难处在写而不在读：什么值得写进去由产品决定，不是来者全收——外部研究里，错误的运行会归纳出错误的经验，一次读进的经验越多效果反而越差。所以只有用户确认 `Arrival` 的那一趟才有资格被写入。
第一版原样存那一趟走过的路（目标、每一步的标题与落到的页面、终点），不经模型加工；每次只取同一站点、目标最接近的一条。
`Thread` 不是 Memory（它只活一趟）；`Run record` 是它的原料，不是它本身；人写的 `Skill` 也不是。
_Avoid_: knowledge, history——前者不说明谁写的，后者在这里指一趟之内已走过的步骤

**Plugin**：
一项可以单独开关的 agent 能力。今天只有一个——`Skill`；之后是 `Workflow` 与 `Memory`，更晚加入的能力也照这个形状接进来。
每个 Plugin 只从固定的几处接进主流程：往 `Context` 里加一段、在引导开始时给出建议、在一趟结束时拿到这一趟的 `Run record`。一趟从头到尾用它开始时开着的那组 Plugin，这组记在它的 `Run record` 里；eval 也按次指定开哪些——「带它 / 不带它」的对照就是这样量出来的。
_Avoid_: extension（那是整个产品）, feature flag（开关只是 Plugin 的一个属性）, addon

**Skill**：
一份写给模型读的说明。第一版是**站点技能**：某个站点的几句事实（这个站怎么称呼东西、哪个控件点了会发生什么），按页面的域名整段加载，随元素表一起进 prompt，不由模型挑；不含可执行的流程——每一步仍由模型规划。它是第一个 `Plugin`，默认开。
带一句描述、由模型判断什么时候读全文，是之后的实验。
可被模型调用、调用即执行的一段程序**不是** Skill——本产品不替用户动手，那一类在这里没有对应物。
_Avoid_: plugin（Skill 是一个 `Plugin` 提供的内容，不是 Plugin 本身）；也不要叫它 tool——Skill 是被读的说明，`Tool` 是被调用的函数（「读某份 Skill 的全文」将来会是一个 Tool）

**Guide**：
一趟引导：用户说出目标，引导 `Agent` 在用户正在看的页面上一步步指出该点哪里，规划落进 `Thread`，直到到达、结束或被接替。也是引导 agent 的名字。
`guide` 同时是引导 agent 的一种 `Output`（给出路标与接下来的几步）。同一个词，说到那个回答时写成代码格式的 `guide`。
_Avoid_: tour, walkthrough

**Question**：
一次无状态的页面问答，由问答 `Agent` 回答。不建 Thread、不动 Thread。
_Avoid_: query, chat turn

### 模型契约

**Agent**：
对模型的一种用法：一段说明，加上它允许模型回答的几种形状（`Intent`），以及怎么读、怎么核对模型写回来的东西。本产品有两个：**引导**（多步、有状态，规划落进 `Thread`）与**问答**（一问一答、无状态，即 `Question`）。两者守同一套 `Envelope` 与 `Provenance` 的规矩。
_Avoid_: bot, assistant；也不要把模型本身叫作 agent——模型是 agent 调用的东西

**Prompt**：
交给模型的一次请求：`Agent` 的说明，加上 `Context`。说明是每个 agent 的系统提示词与修复轮提示词；每个 `Tool`、每种 `Output` 自己的门槛说明跟着它自己走，不算在这里。
_Avoid_: message（一次请求由两条 message 组成）, template

**Context**：
除了说明之外，`Agent` 交给模型的全部东西：元素表、这一趟已经走过的步骤、新出现的控件，以及开着的 `Plugin` 加进来的段落（今天只有 `Skill`）。将来的 `Memory` 也从这里进。
_Avoid_: prompt（`Prompt` 是说明加上 Context）, state

**Provider**：
用户自带的模型端点：地址、密钥、模型名。扩展不附带任何模型。
_Avoid_: backend, LLM, API

**Envelope**：
模型返回的那个 JSON 对象，由 `intent` 区分形状。
_Avoid_: response, payload, output

**Intent**：
模型对本次请求的分类：`guide` | `clarify` | `need_docs` | `done`（引导路径的四个工具，`Intent` 就是模型调用的那个函数名），加上 `explain` | `need_text`（问答路径）。`clarify` 两个 `Agent` 都用：形状同一个，拿它做什么各归各的 agent。
每个 Intent 属于两类之一：`Tool`（结果会送回模型）或 `Output`（说完就结束这次调用）。
_Avoid_: mode, action type
_Avoid_: locate——它从未是一个 `intent`；定位是 `Binding` 轴上的事

**Tool**：
模型在回答之前能用的一个函数，结果会送回模型，由它读完再决定。今天只有 `need_docs`（抓一份站内文档的正文），而且它的循环只接了一半：宿主判定了能抓，却还不会把请求交给侧栏，文档正文也还不会回到模型，所以目前会如实告诉用户做不到。
走不走 tool calling 不决定它是不是 Tool，决定的是结果回不回到模型。
_Avoid_: action（本产品不替用户动手）, function

**Output**：
`Agent` 对一次调用的最终回答，说完这次调用就结束。引导 agent 的是 `guide` / `clarify` / `done`（经 tool calling 交回），问答 agent 的是 `explain` / `clarify` / `need_text`（经 JSON 文本交回）。
怎么交回是通道的事，换通道不改变它是 Output。
_Avoid_: response, result

**Provenance**：
解析结果中每个值都能在模型原始输出的同一路径上找到对应字面量。解析器只许丢弃和重组，永不许发明。
校验它的扫描器是**独立重写的第二实现**，与解析器零函数共享：找 `{`、读字符串、跳尾逗号都自己做，唯一共享的 `JSON.parse` 只用来解码一个已被独立切出的字面量。复用解析器的函数，两者就会一起错，校验就只是在验证解析器和自己一致。扫描器只接受模型的原始输出文本，永不接受解析器清洗过的中间产物。
_Avoid_: validation, integrity, fidelity

**Repair call**：
输出不可用之后的一次重抽，只说清上一次错在哪。每次请求至多一次，绝不成环。
**引导路径上两种不可用都走它**：解析失败（`parse_error`），以及校验失败（`violation`，如 action 不在枚举内、ref 不在本次快照内）。问答路径只修复解析失败：核对不过的回答如实报出，不重抽。原先只有前者有修复轮，后者只标了 `retryable: true` 而没有任何东西消费——实测两次 `violation` 各报废一整轮，因为被拒之后线程原封保留上一份已经证明走不通的计划。

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
这条流程的知识从哪来：`walked` > `handpicked` > `documented` > `model`。运行时盖章。
`handpicked` 是 `Fixed plan` 的取值：用户在元素表里亲手指定了元素。它比文档和推断都直接，但没有人证明它能走通，所以排在 `walked` 之后。
_Avoid_: confidence, trust level

**Check**：
到达期望验证的结果：`pass` | `unknown` | `skipped`。
_Avoid_: verification, validation

**Binding**：
此刻能不能把它指出来：`bound` | `ambiguous` | `unbound`。渲染器盖章。
_Avoid_: resolution status

### 评估

**Decision eval**：
离线评测：拿真机上录下的一个状态（目标、这一趟已走过的步骤、当时的元素表，与模型当时读到的一字不差），让 `Agent` 再答一次，看这一跳答得对不对——意图对不对，第一步指的元素与动作在不在人标的可接受集合里。便宜、输入固定，用来防退步，可以当闸门。
_Avoid_: offline test, benchmark

**Task eval**：
真机评测：在真实网站上跑一组目标，看最后有没有 `Arrival`。人的判定是正式分数，程序化判据拿它校准。贵、嘈杂，用来量能力，不当闸门。
_Avoid_: e2e（e2e 用小 fixture 证明接线，不量效果）, live run

### 进程

**Host**：
service worker。唯一跨导航存活的进程，拥有 Thread、所有平台 effect 与全部授权判定。`storage.session` 里的流程状态只有它写——侧栏是视图兼 effect 执行者，不拥有流程。
_Avoid_: background, worker, SW

**Panel**：
侧栏。视图，兼外部世界 effect 的执行者——模型调用与文档抓取在这里发生。
为什么在这里而不在 Host：service worker 里 `fetch()` 响应超过 30 秒即终止 worker，`setTimeout` 也不保活——模型调用的流式超时与长达 60 秒的退避在那里活不下来。这是 SW 确定做不到的一条，不是可以先凑合的权宜。
_Avoid_: sidebar, UI

**Effect**：
Host 委托 Panel 执行的一次外部世界动作（`callModel` 或 `fetchDoc`），由一对消息（请求/结果）完成，具备幂等、超时、取消、恢复语义。
_Avoid_: side effect, action（这里特指跨进程委托的那一次往返，不是通用编程术语）

**Content script**：
页面里的那一份。只做抽取与高亮，只听 Host 一个指挥者。
_Avoid_: injected script, page agent
