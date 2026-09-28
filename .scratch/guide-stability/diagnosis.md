# 引导稳定性:诊断

> **这是诊断,不是方案。** 同目录下的 `spec.md` 是已被否决的「五条补丁」方案,不要照它实施。
>
> 本文的作用是让下一个会话不必重新读一遍代码:所有结论都带 `文件:行号`,已逐条核实(2026-09-16/17)。

---

## 一、五个症状与代码成因

### 1. 模型的计划建立在它没看过的那一页上

> **更正(2026-09-17,实施 02 时逐条查了 t11 原始轨迹)**:下面「`pushState` 让表和标签页都是新地址」这个机制**只解释了少数**。t11 在「要离开的页」上发出的调用是 10 次(判定口径和当初的 11 次略有不同):**8 次**表地址与上一次调用**相同**,是用户点了之后、离开之前,旧页面自己加载完了(控件 161–168 → 339–340),`pageMoved` 把原地变化当成了点击生效;只有 **2 次**是地址先变、DOM 没跟上(控件完全相同)。前者任何比地址的办法都查不出,修法在 05——触发器不再有权提交。详见 05 号票。

t11 191 次在跳调用里 11 次、t09 280 次里 15 次,元素表描述的是用户正在离开的视图。

- `runReplan` 提交前三道闸门:`inTransit`、`!samePage`、零控件(`replan.ts:143-152`)
- `inTransit` 来自 `tab.status === 'loading'`(`background.ts:246`),**同文档切换不触发 loading**——`replan.ts:75` 自己标着「Known gap」
- `samePage` 是 `samePlace(tab.url, table.url)`,只比 origin+pathname;`pushState` 让 `location.href` 立刻变新,于是表和标签页**都是新地址**,这道闸门反而放行
- 结论:**第一次读取就三道全过**,任何「多读几次再提交」的修法都不会被触发

### 2. 正确的计划被画到另一张视图上

- `render()` 第一件事是快速路径 `registry.resolve(cmd.snapshotId, step.ref)`(`content.ts:185-193`)
- `registry.resolve` 的守卫只有 `snapshotId !== this.gen` 加 `isConnected`(`registry.ts:30-34`)
- `gen` **只在完整 `extract()` 时前进**(`extract.ts:173-174`),`extractPageHash()` 刻意不提交
- 结论:守卫的语义是「快照是不是最新的」,不是「页面还是不是同一页」——两件事被当成一件

### 3. 马上要回来的目标被提前放弃

两处,第二处是决定性的:

- 内容脚本:限次重试只在**初次绑定失败**时启动(`content.ts:627`);用尽时只 `stopWatching()`,**无回调**(`content.ts:375`);而 `stopWatching()` 把 `lostWatch` 置回 `null`(`content.ts:346-349`),重画能把整套重启——没有终止条件
- 宿主已把结论写死:内容脚本**一边启动重试、一边返回失败**(`content.ts:624-627`);宿主随即写 `outcomes[cursor]='invalidated'`、盖历史、发「未能定位」(`machine.ts:386-394`);而 `TARGET_FOUND` 只广播面板状态,注释明写「deliberately does *not* re-present」(`background.ts:893-896`)
- 结论:**恢复成功也撤不回历史、收不回那句话**

### 4. 做成了的一步被记成「没做成」

> **更正(2026-09-17,实施 04 时查了 t11 原始轨迹)**:真正出问题的不是「同页展开」——同页展开会被 `pageMoved` 的控件列表那一半察觉,改动前就记成了 `confirmed`。出问题的是**点了、起了作用、只是这一页没变**:t11 里 9 条 `failed` 全是这一类(复制克隆地址 2 次,gitee 在新标签页打开的链接 4 次,阿里云控制台链接 2 次),念给模型的却是「推不动,换一个入口」。另外,round 2 定下的「超时记 `unknown`」也是错的:超时的前提是确实读到了页面、每次都没变,应该记 `none`。

- `Outcome` 只有 `confirmed | skipped | failed | invalidated`(`thread.ts:18`),而 `confirmed` 的定义是「点击**且**页面确实变了」——两件事捆在一个值里
- 唯一记录「做成了什么」的字段是 `landedAt`,**只在跨 place 时才写**(`transitions.ts:44` 的 `arrived`),原地生效必然留空
- 打转兜底于是拿「`landedAt` 缺失」当「这一步没推动任何人」(`guide.ts:467-477`)
- 等待窗口关闭盖的是 `failed`(`machine.ts:164`),而 `failed` 的文案是「这个控件推不动,换一个入口」(`user-message.ts:117`)
- **还有一条根本不写的路径**:多步骤计划超时前进时直接 `stepForward`(`machine.ts:143`),而 `stepForward`(`transitions.ts:98-107`)不盖章——那条历史**永远停在 `unknown`**

### 5. 调用被焊死,答案永远回不来

> **更正(2026-09-17,实施 06a 时查了 t11/t09 原始轨迹)**:下面三条里,第三条「清扫结果被丢掉」确实存在,但**不是主因**。那 14 次在途调用一次都没有回来过,其中 12 趟的最后一跳,是在新标签页打开的链接之后的「我再看看这一页」;而清扫只在「有调用结果回来」或「侧栏重新挂载」时发生,这两件事在那 14 趟里都没出现。主因是第一条:侧栏跟着活动标签页换绑,宿主派出的调用只广播一次,引导所在的标签页一到后台,调用就没人执行,也没人重发。修法见 06a 号票。

t11 13 趟「替用户结束」里 7 趟、t09 19 趟里 7 趟,结束时线程仍有调用在途。

- 侧栏只回应「当前活动标签页」的请求(`effects.ts:193-194`)
- 在途调用是墓碑(`transitions.ts:116`),清扫被动
- **清扫结果被丢掉了**:`sweepExpiredGuideEffect` 返回的归约里**本来就有**「调用超时」通知(它合成 `ok:false, failureKind:'transport'` 走既有失败分支,`writer.ts:362-387`),而 `background.ts:698` 与 `:721` 都 `await` 了却不用返回值;`:721` 还先清扫再 `peekGuideEffect`,`judgeRecovery`(`effect.ts:181-184`)于是读到 `none`,侧栏挂载时什么都不说

---

## 二、五个症状归结为四个缺失概念

### A. 没有「视图身份」

五个互不兼容的近似物:

| 名字 | 定义 | 含查询参数 |
|---|---|---|
| `samePlace`(`place.ts:14-21`) | origin+pathname | ✗ |
| `pageHash`(`fingerprint.ts:29-36`) | origin+pathname+前 24 个地标 | ✗ |
| `pageMoved`(`machine.ts:79-81`) | pageHash 变 或 控件列表变 | ✗ |
| `PromptTable.url`(`extract.ts:178`) | `redactUrl(location.href)` | ✓ |
| `registry.gen` | 快照序号,每次抽取都变 | 与页面无关 |

→ 症状 1、2,以及 4 的一半。而且互相打架:`?q=a → ?q=b` 且控件相同时,`pageMoved` 为假 → `writer.ts:424` 拒绝提交新表;若同时加了绘制校验,旧高亮也被拒——**两头堵死**。

### B. 没有「这一步做成了什么」

`Outcome` 把「用户点了」和「页面变了」压成一个值;`landedAt` 是唯一的效果记录,且只覆盖跨页那一种。→ 症状 4。

### C. 没有「一次呈现」的身份

状态全挂在可变的模块级变量上:`current` 每收一条 HIGHLIGHT 就被替换(`content.ts:615-617`);`lostWatch` 用尽置 null 后可被重画重启。→ 症状 3。

### D. 等待态没有统一的超时所有权

「谁开启了等待、谁负责超时、超时后谁告诉用户」在每处答案都不同。→ 症状 5,以及**任何新增「等一等」都会制造新的静默卡死**。

**至少 9 个独立计时常数在猜同一类事**:`SETTLED [0]`、`UNSETTLED [0,300,500,600]`、`AFTER_NAV [0,400,800,1200,2000]`(`background.ts:311/343/349`)、`SETTLING_GRACE_MS 5000`(`content.ts:110`)、`RETRY_MS` 七档(`content.ts:365`)、`STRUCTURE_DEBOUNCE_MS 400`(`content.ts:440`)、`scrollToTarget ≤800ms`、`CALL_MODEL_TIMEOUT_MS 150_000` / `FETCH_DOC_TIMEOUT_MS 30_000`(`effect.ts:161-162`)。

---

## 三、同类产品怎么做(一手来源)

**没有任何一个在「等页面稳定」——那个概念在这些框架里不存在。** 它们做四件事:

| 机制 | 谁 | 具体 |
|---|---|---|
| 逐元素机械检查,只在动作那一刻 | Playwright | visible / **stable** / enabled / editable / receives events;stable = **连续两帧同一 bounding box**;等不到抛 `TimeoutError` |
| 短的固定计时器 | browser-use / Anthropic | `minimum_wait_page_load_time` 0.25s、`wait_for_network_idle_page_load_time` 0.5s、`wait_between_actions` 0.1s;Anthropic 参考实现 `_screenshot_delay = 2.0`(注释:「delay to let things settle before taking a screenshot」) |
| 模型可调用的等待工具 | Playwright MCP / chrome-devtools-mcp / OpenAI CUA | `browser_wait_for`(text / textGone / time,上限 30s);`waitForTextOnPage(text, timeout)`;CUA 把 `wait` 列为模型动作,实现是 `asyncio.sleep(duration)` |
| 动作后的导航/网络沉降 | 仅 Playwright MCP 服务端 | 「after an action, the server waits for triggered navigations and network activity to settle before returning a snapshot」 |

**关键反例**:chrome-devtools-mcp 的 `take_snapshot` **什么都不等**,handler 直接 `response.includeSnapshot(...)`。读取根本没有被稳定性把关。

**决定性差别——等不到的时候产生什么:**

| | 等待失败时产生 |
|---|---|
| Playwright / chrome-devtools | 一个**错误**,agent 看得见 |
| browser-use | 一张**待判断的观察**,交给模型 |
| **本项目** | 一条**写进历史的断言**(`reportSettleTimeout()` → 盖 `failed`;或提交可疑表 → `recordMove` 写 `confirmed` + 判 arrival) |

而 `stamp` 先到先得、盖过不改(`transitions.ts:51`),**这条假事实此后无法纠正**。这是「偶尔测试能过但一直不稳」的机制原因。

**另外两点**:它们等的是**具体的应用可见信号**(某段文字出现、某元素可点),不是抽象的「页面稳定」——Playwright 官方明确把 `networkidle` 标为 discouraged;以及**三个系统都把「再等一会儿」做成模型的工具**,而本项目的模型连这个词都没有(只能输出 `guide`/`done`/`clarify`/`need_docs`)。

来源:playwright.dev/docs/actionability、playwright.dev/mcp/tools/waiting、ChromeDevTools/chrome-devtools-mcp `src/tools/snapshot.ts`、docs.browser-use.com/open-source/customize/browser/all-parameters、anthropics/anthropic-quickstarts `computer-use-demo/.../computer.py`、developers.openai.com/api/docs/guides/tools-computer-use、arXiv 2511.19477、arXiv 2604.09718。

---

## 四、目标形状

```
机制层(产品执行,机械规则,不猜)
  · 可操作性:连续两帧同 bounding box + visible + enabled + 命中测试
  · 快照过期一律硬失败,绝不按描述符重绑
  · 点击观察:记录 T 时刻、E 元素、发起者(用户 / 产品)

证据层(只记事实,不推断)
  · 一次点击发生了(谁、何时、哪个元素)
  · 点击后的一次观察(带出处:等了多久、地址变没变、结构变没变)
  · 用户点了别的控件(仅指路模式可能发生)

判断层(模型,全部通过工具)
  · observe / wait_for / point / act / ask / done / explain
```

**单 agent。** 现有两个 agent 的实质差别只有:`question` 无状态(「nothing it does acts on a `Thread`」,`question/output-module.ts:32`)、**不用 tool calling**(`question/agent.ts:17-18`)、1 主调用 + ≤1 修复;`guide` 有状态、用 tool calling。两者已共享 envelope 契约,`clarify` 各实现一份。走 tool-based 之后,「解释这一页」只是一个不推进状态的工具。

**两种模式的关键性质:只在「谁发起点击」这一点上不同,下游完全一样。** 代劳模式产品自己知道点击时刻;指路模式通过目标上的 capture 阶段 click 监听(`content.ts:330`)**同样精确知道**。之后「等稳定 → 重新观察 → 模型判断」两边一致。所以「都支持」不是两倍工作——前提是架构围绕「T 时刻在 E 元素上发生了一次点击」这个共同事件来建。

**工具集随模式变**:代劳模式注册 `act`,指路模式**不注册**——模型看不到就不可能调用。用结构保证,不用提示词保证。

---

## 五、三个待决策 → 已决(grilling round 1,2026-09-17)

> 1. **代劳定为第二阶段**,指路先行 → 理由与开启条件见 `CONTEXT.md` 的 `Tool` 注记
> 2. **模型一次只给一步**。`Route` 保留(粗路标,不驱动点击),但不再落成可推进的 `steps`;`Fixed plan` 是唯一例外。
> 3. **配额换成「每步模型调用上限 + 整趟步数上限」**(建议 ≤4 / ≤12),**不用墙钟**——真机每跳最多等约 45 秒而模型超时 150 秒,墙钟判据在真机上跑不出来。
> 4. **缺失概念 C 由 `Presentation` 承担**:宿主签发 id,内容脚本不得自行续命。已进 `CONTEXT.md`。
> 5. **修复策略保留引导那一种**(原请求整个重发 + `tool_call_id` 配对);问答那种「不含页面的修复」随合并消失。
> 6. **接受 154 条冻结语料不可比,且现在不重录**(`batch-1` 123 + `on-target` 31)。旧语料留作历史,不再当闸门;等模型输入稳定后再录。

**round 2 续决(2026-09-17)**

> 7. **`Outcome` 拆成两个正交字段**:`action`(`taken`/`skipped`/`unavailable`)与 `effect`(`moved`/`changed_in_place`/`none`/`unknown`)。**`failed` 这个值消失**——它旧日同时表示「点了没到」与「超时了」。`record.ts:77` 必须一起改,否则效果照样被丢。
> 8. **四个环境触发器全部降级为「一次带出处的读数」**,不再自行推进状态;latest-wins 队列随之可删。注:`CONTEXT.md` 的 `Breakpoint` 词条旧日只写了三个,**漏掉 `target-lost`**,而它正是症状 3。
> 9. **指路阶段工具集六个**:`observe` / `wait_for` / `point` / `ask` / `read_doc` / `done`。`wait_for` 独立成工具不并进 `observe`(三家同类产品一致做法);`act` 不注册。
> 10. **`quota_exhausted` 保留,但只由「整趟步数用完」触发**;每步调用用完不结束这趟,而是强制收敛(指出当前最好的一步,指不出来就 `ask`)。`docFetchCount` 并进每步预算。
> 11. **`explain` 成为不推进状态的工具,独立问答 agent 消失**。「不建 Thread」以行为为判据保留:**一趟里一次 `point` 都没有,就不写 `Run record`**。
> 12. **代劳的开启条件**已写进 `CONTEXT.md` 的 `Tool` 注记(三条同时满足)。

**round 3 续决(2026-09-17)——四个缺失概念至此全部有归属**

> 13. **概念 A 收成一个 `View` = 完整 URL 去掉 fragment**,不掺结构。`samePlace`/`pageHash`/`pageMoved` 三个删掉;`registry.gen` 降级为「快照新不新鲜」。结构指纹保留但只回答「东西变没变」。→ `CONTEXT.md` 的 `View` 词条
> 14. **概念 D:每个等待由发起它的那一层拥有,超时只产生读数、永不产生断言。** 删掉 7 个猜测性计时常数,只留机制层两帧 + 宿主两个传输超时。→ `CONTEXT.md` 的 `Reading` 注记
> 15. **`need_text` 并进 `ask`**(后果相同,都是 Thread 停下来等用户)。
> 16. **`Check` 保留,输入钉死成 `effect`**:`expect_after` 预测一个 `effect` 值,Check 只做预测与实际的对账。
>
> **四条硬决定不单独成文。** 本仓库已让决策记录退场,`CONTEXT.md` 是唯一事实源(`.scratch/s1-retirement/spec.md`),并由架构守卫强制。grilling 期间一度建了决策记录目录,违反了这条、让单测变红,已并回词条注记:`Agent`(一个 agent、一次一步)、`Tool`(代劳是有条件的第二阶段)、`View`(页面身份只由地址决定)、`Reading`(产品不等页面稳定)。

下面是这三个决策当初的分析,保留作依据。

1. **代劳模式要不要开。** 这是**产品定位决定,不是工程决定**:
   - RPC 动词集合现在封闭为六个:`PING` / `EXTRACT` / `HIGHLIGHT` / `CLEAR` / `INSPECT` / `DEBUG_GET_OVERLAY_STATE`,**无执行动词**
   - `architecture.spec.ts` 把 `el.click()`、`form.submit()`、`el.dispatchEvent()`、合成 `KeyboardEvent`、`document.execCommand()`、`input.select()` 全部断言为 acting 并禁止;而 `el.focus({preventScroll:true})` 被明确断言**不算**(这正是「跳到目标」的实现)
   - manifest 注释:`<all_urls>` 之下「我们只读」这个保证**已不由平台强制,而是活在 architecture.spec.ts 里**
   - **指路模式天然免疫 prompt injection 的最严重后果**:页面里的恶意指令最多让扩展高亮一个错误按钮,用户仍是最后一道闸。代劳一开,这道闸没了
   - 连带:Task eval 的「到达」判据(最终 URL + 最后一步)在代劳模式下语义不同
   - **倾向**:先做单 agent + 工具循环 + 指路模式,代劳作为第二阶段——指路模式的机制层代劳全要用,先做不浪费;反过来先做代劳,指路那套还得补

2. **合并后保留哪种修复策略**:`question` 的「全新最小对话、从不重看页面」(设计文档 §5.9)vs `guide` 的「整个请求重发加一条注记」。

3. **配额换成什么度量**:现在是「一次引导最多 12 次模型调用」。工具循环下每次 `observe`、每次 `wait_for` 都是一次调用,12 次会很快用完。

---

## 六、不可消除的限制(不要再尝试解决)

- **无法判断 SPA 是否渲染完成**——没有可靠信号。骨架屏尤其:先换骨架再填内容时,地标结构已经变了,任何结构指纹都会认为「新视图到了」。
- **无法验证剪贴板是否真的写入**——`done` 的 `step_completed` 永远只是模型的声称。
- 目标是让剩下的限制**数量少、被明确命名、每个恰好有一条兜底路径**,而不是散落在五个文件里互相绊倒。

---

## 七、已验证的代码事实清单(省下一次通读)

- `stamp`(`transitions.ts:28-56`)先到先得;`landedAt` 允许后到的输入补写(`:51-53`);`arrived = landedAt !== undefined && !samePlace(landedAt, last.url)`(`:44`)
- 历史条目三个创建点,均为 `outcome: 'unknown'`:`guide.ts:513`、`transitions.ts:104`、`fixed-plan.ts:76`
- 盖章路径:`transitions.ts:90`(confirmed+landedAt)、`machine.ts:164`(failed)、`machine.ts:392`/`:421`(invalidated)、`fixed-plan.ts:102`/`:154`
- `GuideHistoryEntry` = `{title, url, outcome, landedAt?}`(`thread.ts:121-140`)
- `record.ts:77` 只写 `{title, outcome}`,**丢掉 `landedAt`**;`judgeConfirmation`(`:58-61`)只认 `confirmed` 且要求 `confirmed === history.length` 才算 `all`
- `pageMoved` 只有两个真实调用点:`machine.ts` 的 `handlePageChanged`、`writer.ts:424`
- `bindingFromAck`(`binding.ts:27-31`)三分支:`resolved !== null` → bound;有 candidates → ambiguous;其余 → unbound
- `claimEffect` 发生在花钱之前(`effects.ts:196-207`:`if (!claim?.granted) return;` 在 `loadCfg()` 与 `runCallModelEffect` 之前)——去掉侧栏过滤**不会重复计费**
- `ensureReady` 先 PING、只有无人应答才注入(`shared/rpc.ts`)——幂等
- `chrome.tabs.onUpdated` 监听器要求 `info.status === 'complete'`(`background.ts:924-925`),同文档导航不触发
- 内容脚本**没有**任何被动的 document 级 click 监听;唯一的全局 click 在 inspect 模式,且**吞掉**点击(`content.ts:547-564`)
- `alarms` **不在**权限里(现有:`scripting` / `sidePanel` / `storage`)
- 线程状态存 `chrome.storage.session`,扩展重载即清空——**不需要迁移,也不需要兼容层**
- `src/agent/tools/` 只有一个文件 `need-docs.ts`,且 `need_docs` 循环未接通
- 浮层三个按钮:跳到目标(title 写明「扩展不代你操作」)/ 跳过 / 结束;**没有**「我点好了」
- 真机 harness 每跳最多等约 45 秒(`live-github-run.mjs:679-681`),而模型超时 150 秒——**闹钟类修复在真机上跑不出来,只能单测验收**
- t11 结束方式 × 人工判定:`model_done` 34(到达 23 / 判错终点 9 / 不作数 2)、`user_ended` 13(**0** / 8 / 5)、`loop_backstop` 5(**0** / 4 / 1),共 52 趟。**被外围终止的 18 趟一趟都没到**

---

## 八、下一步

**路由已定(经 `/ask-matt`)**:`/grill-with-docs` → `/to-spec` → `/to-tickets` → 逐票 `/implement`(票间 `/clear`)。

**不走 `/wayfinder`**:它的判据是「去路尚不可见」,且明确「never a well-scoped feature」。本文一、二、三、四节已经把雾清掉了,剩下的是一个大但可见的改动加三个决定。

**前置条件已满足**:`CONTEXT.md` 在;本地 tracker 约定已在用(`.scratch/agent-architecture/issues/01..14`、`.scratch/agent-evals/issues/…`),新票放 `.scratch/guide-stability/issues/`;**不需要 `/setup-matt-pocock-skills`**。**没有 ADR 目录,而且是刻意没有**——决策记录已经退场(`.scratch/s1-retirement/spec.md`),由架构守卫保证;难以回退的决定照 `CONTEXT.md` 已有的 `> 为什么…` 注记体例并进词条。

### grilling 必须覆盖的(除第五节那三个决策之外)

1. **上一次架构 pass 的不变量哪些保留、哪些推翻。** 现在这个「两个 agent + output module」的形状,正是 `.scratch/agent-architecture/issues/` 那 14 张票的产物——尤其 `05-the-question-agent-gets-its-own-definition`、`08-need-docs-becomes-the-first-tool-module`(这张票定的 need_docs 至今没接通)、`09/10/11-...output-module...`。单 agent + 工具循环会直接推翻其中几张,要明说是哪几张。
2. **Task eval 的到达判据在两种模式下语义不同。** 现判据是「最终 URL + 最后一步」(人工判定标准);代劳模式下「最后一步指着哪里」还成不成立,要重新定义。
3. **冻结语料的代价。** 线程状态在 `chrome.storage.session`,扩展重载即清空,**没有数据迁移问题**;但只要模型输入变了,`t13-baseline` 与两批冻结语料(`batch-1`、`on-target`)就不可比。这是要主动接受的成本,不是能绕过的。
4. **缺失概念 C(一次呈现的身份)在新架构里由谁承担。**
5. **配额度量换掉之后,`quota_exhausted` 这个结束方式还存不存在。**
