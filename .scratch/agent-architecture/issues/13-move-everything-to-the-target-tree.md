# 13 — 纯搬家到目标目录

**What to build:**

只改路径，不改逻辑。

- agent 的代码按规格 A 的目标结构重排：两个 Agent 各带自己的回答目录，Tool、共用的形状与解析、说明、上下文、Skill、Thread、Provider 各一个目录。
- Descriptor 的绑定与生成，移到以 descriptor 命名的目录。（第 12 张为了让 Pack 退场已经提前搬到 `core/descriptor/`，Pack 目录也已删除；本票只需确认目标结构里它的位置，不必再搬。）
- 说明按三层落位：整体说明进说明目录；各自的门槛已经跟着各自的模块；拼装进上下文目录。
- 架构守卫里的路径、注释里点名的源码文件，同步更新。

**Blocked by:** 04 — 删掉没接线的 settle 模块；07 — Fixed plan 自成一个模块；10 — guide 成为引导的 Output 模块；11 — 问答的 explain、clarify、need_text 成为 Output 模块，clarify 的形状两边共用；12 — Plugin 机制与 Skill

**Status:** done（票头 2026-09-26 补正）

- [x] 目录结构与规格 A 一致；旧目录（按进程和技术分层的四个，以及 Pack 目录）不复存在
- [x] 一条测试列出 agent 下的每个目录名，逐个确认词汇表里有对应词条
- [x] 「同一个地方」的判定落在 thread 目录下，保持叶子文件、零 import
- [x] 除 import 路径外，函数体零改动
- [x] 架构守卫和注释引用守卫全绿
- [x] 到达期望的判定落位：它判的是 guide 回答里的「落地后应当出现什么」，却由归约器在断点处调用，现在留在共用校验里（首步绑定判定 CL-2 同样如此，校验文件因此还在类型上 import 引导的「到达期望」）。搬家时定下它归 guide 模块还是 thread 目录（第 10 张评审）
- [x] 路标与到达期望这两个类型搬进一个不 import 任何东西的类型文件。Thread 状态、线上消息和 Run record 都要用它们。搬完后，线上协议与共享层不再从 guide 模块取类型，线上协议与 guide 模块之间的类型循环随之消失（第 10 张评审）
- [x] 类型检查、单测、e2e、抽取器评测全绿，并且第 01 张冻结的快照逐字节一致

**实现记录**
- **目录**：`src/agent/` 下现在是 `agents/`（`guide/`、`question/`，各带 `output/`）、`tools/`、`envelope/`、`prompts/`、`context/`、`skills/`、`thread/`、`provider/`。
  - 按进程和技术分层的 `guide/`、`host/`、`plan/` 与原来的 `question/` 都已删除；`ground/` 与 Pack 目录在更早的票里已经不在了。
  - 根下留三个不属于任何一个目录的文件：
    - `intents.ts`：两个 agent 的 intent 清单，共享层不许加载它，有守卫。
    - `budget.ts`：侧栏取节点预算的入口。
    - `flags.ts`：trace 开关与 Plugin 开关共用的读法。原来放在 guide 下，但 Plugin 也要读它。
- **每个文件去哪**：
  - `host/*` → `thread/`，文件名不变；单写者在评审后改名为 `thread/writer.ts`（见「评审后续」）。
  - `plan/contract.ts`、`scanner.ts`、`validate.ts` → `envelope/`。
  - `guide/nonce.ts` → `context/`。
  - `provider.ts` → `provider/provider.ts`，保留文件名，注释里点名它的地方都还能对上。
- **说明按三层落位**：原来的 `plan/prompt.ts` 拆成三个文件：
  - `prompts/system.ts`：两个 agent 的系统提示词各段，不属于任何一个 intent 的那部分；
  - `prompts/repair.ts`：修复轮提示词；
  - `context/user-message.ts`：user 消息拼装，包括元素表的 nonce 包裹、历史文本、目标放最后，以及 S-01 那段头注释。

  各 Tool、各 Output 自己的门槛说明原本就跟着各自的模块。
- **到达期望的判定落在 thread 目录**（第 10 张评审留下的决定）：
  - `judgeArrival` 与首步绑定判定 CL-2 搬到 `thread/judge.ts`。「thread 可以停下来问」的原因类型 ClarifyTrigger 搬进 `thread/thread.ts`，它本来就是 Thread 状态的一个字段。
  - **为什么不归 guide 模块**：只有断点能回答它，由归约器在断点处调用。guide 模块已经 import 了 Thread 的帮手（`transitions.ts`），判定要是住进 guide 模块，`transitions.ts` 就得反过来 import 它，形成循环。
  - `envelope/validate.ts` 于是只剩两个 agent 共用的 R-a/R-e，不再 import 任何 guide 的东西。
- **路标与到达期望两个类型搬进 `shared/types.ts`**：
  - 它本来就是零 import 的共享小类型文件；到达期望里要用的 `Ref` 也在这里，所以不必另起一个文件。
  - 线上协议、Thread 状态、Run record、侧栏都从这里取。线上协议与 guide 模块之间的类型循环随之消失。
- **import 与注释**：
  - 用脚本按映射表改写了 66 个文件里的 176 处 import。拆开的三个模块按导入的名字分到各自的新文件。
  - 注释、字符串和教程里点名的旧路径，能唯一对应到新文件的 86 处由脚本改写；对应不到的 18 处（多为拆开的 `prompt.ts`）逐条按上下文手改。
- **函数体零改动的核对**：用 TypeScript 的打印器把新旧两棵 `src` 的每条顶层语句去掉注释、规范格式，不计 import，按多重集合比对：各 529 条，完全一致。新写的只有 `prompts/system.ts` 与 `thread/judge.ts` 的头注释。
- **守卫**：
  - 架构守卫里所有路径跟着改。「共用的解析、校验、提示词不得加载登记处」这一条的范围，由原来的三个文件改为它们拆开后的五个。
  - 新增三条：
    - `agent/` 下每个目录名（单数、首字母大写）在词汇表里都有词条；
    - `thread/place.ts` 零 import；
    - 路标与到达期望的类型住在零 import 的 `shared/types.ts`，线上协议与共享层不从 guide 模块取类型。
  - 4b 那条测试原来按 `agent/host` 过滤文件，搬家后会在空集上恒真。改为过滤 `agent/thread`，并加上「至少扫到一个文件」的自检。
- **词汇表**：新增 **Guide** 词条，让 `guide` 这个目录名有对应（同名的 `guide` Output 在词条里说明）。
- **教程**：目录树换成新结构，Prompt 一节和阅读顺序里的链接指向拆开后的文件。

**变异探针**（12 个全红，全部还原后哈希核对通过）
- 守的是本票新增或改过的规矩：
  - R1 agent 下多一个词汇表里没有的目录
  - R2 `place.ts` 多一个 import
  - R3 路标类型文件多一个 import
  - R4 线上协议又从 guide 模块取类型
  - R5 共享校验又从 guide 模块取类型
  - R6 4b 扫的目录不存在（被新加的自检抓到）
- 确认搬家后原有守卫仍然指着真实文件：
  - R7 说明文件加载了登记处
  - R8 拼装文件加载了登记处
  - R9 归约器闭包里出现 await
  - R10 thread 下多了一个 step 调用者
  - R11 thread 下依赖了运行循环
  - R12 注释点名已不存在的旧路径

**验证**
- 类型检查 0；单测 34 个文件 1660 条全绿（新增 3 条守卫）。
- 快照哈希不变：引导 `66ba2ea8…`、问答 `96778e10…`、Plugin 全关 `be7e4cfb…`。
- e2e 191/191；抽取器评测全部门槛通过。
- 函数体核对：新旧各 529 条顶层语句完全一致（见上）。
- 搬家前的完整备份在会话 scratchpad 的 `before13/`，用来比对，不入仓库。

**评审后续**（两轴评审之后，按用户的「修」改）
- **类型循环真正断开**（Spec a1）：
  - 线上协议原来还经由 trace 绕回 guide Output 模块：协议 → trace → 运行循环 → 门面 → 登记处 → guide 模块 → 协议。
  - `Trace`、`TraceEntry` 是纯数据形状，搬进 `shared/types.ts`；trace 模块、线上协议、侧栏都从那里取。
  - 第三条守卫改为按依赖闭包判定，连 `import type` 也跟着走（依赖闭包的帮手加了 `types` 选项）：线上协议与共享层的闭包里不得出现 `agents/` 下的任何文件。原来只查直接 import，所以看不见这条环。
- **单写者改名为 `thread/writer.ts`**（两轴都提）：
  - `thread/guide.ts`、`agents/guide/`、`output/guide.ts` 三个 guide 并存，读起来分不清。改名是纯路径改动，属于本票。
  - import、注释、测试名、架构守卫和教程一并改了。
- **`thread/judge.ts` 的头注释改成实话**（Standards）：
  - 只有 `judgeArrival` 读 guide 回答的字段。
  - `judgeFirstStepBind` 没有生产调用者，归约器处理 `bind_result` 时读的是渲染器的实时报告。它随搬家过来，删掉它是另一件事，记为遗留。
  - 注释里「R-a 在上面」改为指向 `envelope/validate.ts`。
- **小问题**：
  - 拆分脚本漏的 3 个分号已补上；
  - 运行循环里一处相对路径 import 改用 `@/`；
  - `context/user-message.ts` 的头注释不再自称 prompt builder；
  - `docs/design.md` 模块布局里的旧路径更新了，含早已删掉的 `ground/docs.ts` 和 `provider.ts`。
- **目录名守卫改用显式映射表**（Standards）：原来靠「去掉末尾 s、首字母大写」推出词条，遇到 `status` 这类名字会误判。现在新目录必须先在表里写明它对应哪个词条。
- **遗留，不在本票修**：
  - `prompts/system.ts` 里的工具选择收尾讲的是 guide 回答的 route 与 value，开头也写死了「默认是 guide」。按规格，它们应该跟着 guide 模块。但挪过去会改拼装顺序，快照要重新核对，已记进 decisions.md 的例外。
  - 删掉无人调用的 `judgeFirstStepBind`。
  - `budget.ts` 只是一层转手导出。
  - 两处 nonce 的重新生成循环重复。
  - 个别文件从同一模块分两行 import。
  - `flags.ts` 留在 agent 根下：trace 开关不属于 Context，放进 `context/` 反而不对。

**评审后续的验证**
- 变异探针 8 个全红，全部还原后哈希核对通过：
  - S1 线上协议又用 `import type` 从 trace 取类型
  - S2 另一个共享文件用类型碰到 agent
  - S3 envelope 用类型碰到 agent
  - S4 叶子类型文件多了一个 import
  - S5 agent 下多了一个没写进映射表的目录
  - S6 映射表把目录指向词汇表里没有的词
  - S7 thread 下多了一个 step 调用者（守卫认得改名后的单写者）
  - S8 注释还点名改名前的单写者
- 类型检查 0；单测 34 个文件 1660 条全绿。
- 快照哈希：引导 `66ba2ea8…`、问答 `96778e10…`、Plugin 全关 `be7e4cfb…`，都没变。
- e2e 191/191；抽取器评测全部门槛通过。
- 函数体核对：新旧 src 顶层语句各 529 条，仍然零差异。

> 票头补记（2026-09-26）：这张票的实现早就落地了，票头一直没改。上面的实现记录就是当时写的。
