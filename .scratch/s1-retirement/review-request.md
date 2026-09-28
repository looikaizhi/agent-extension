# 审核请求：S1 退场计划

**给审核者：** 这份文档是自包含的。它配套两份东西：本目录下的 `spec.md`（规格），以及下面第 6 节的九张票草案（尚未落盘，等审核后再写）。

**仓库：** `/Users/kellylim/agent-extension` — Chrome MV3 网页引导 agent，TypeScript，55 个源文件约 14000 行。内容脚本抽页面可交互元素 → 序列化成带 ref 的 Element table → 进 prompt → 模型用 OpenAI 兼容 tool calling 返回「下一步点哪个 ref」。扩展只高亮，点击由用户完成。

**当前状态：** 代码一行未改。`npm run verify` 全绿（typecheck 0 错、单测 1581、e2e 170/170），`npm run eval` 全门槛通过。

---

## 1. 请审核什么，以及请不要重新争论什么

### 请审核

1. **票的依赖图是否正确** —— 有没有假依赖，有没有漏掉的真依赖。
2. **票 06 是否太大**（见第 6 节的开放问题①）。
3. **删掉 S1 有没有我们还没找到的后果。** 上一次你的审核正是在这里找到了五条我漏掉的缺陷，这次同样请优先往这个方向查。
4. **「带现成步骤开始」这条新输入是否真的覆盖了检视器今天走的全部路径。**
5. **测试缝的选择是否成立**（第 5 节）。

### 请不要重新争论（这些是用户已经拍过板的决定，不是我的建议）

| 决定 | 谁定的 | 我的立场 |
|---|---|---|
| 删掉 S1 整套 | 用户 | 同意。我给的证据见第 3 节 |
| Pack flows 一起删（只留 `siteNotes`） | 用户 | **我建议保留**（搬到 S2 只需六行映射），用户在看到这个事实之后仍选择删。这是知情下的取舍 |
| `docs/adr/` 十二条全删 | 用户 | **我明确反对过一次**，理由是其中三条各钉着一件重新学一遍要花真金白银的事。用户在看到「哪些事实已有等价记录」的核对结果后重申。核对结果见第 4 节 |
| 「为什么删 S1」记进词汇表而不另开第 13 条 ADR | 用户采纳我的建议 | — |
| `toPackYaml` 删、`authorDescriptor` 留 | 用户采纳我的建议 | — |

**但如果这些决定有我们没发现的后果，请务必指出。** 「不要重新争论」指的是不要重新论证取舍，不是不要报告后果。

### 你上一次的审核已经被采纳的三条

（避免你重复劳动。上一次你审的是 `architecture-review-20260910-144459.html`。）

1. **C8 的标题我写错了。** 我写「规格不存在」是假的——`E-1…E-6`、`R-a…R-e`、`CL-1…CL-4` 都定义在 `docs/design.md`（例如 `design.md:192` 有 E-3 的定义表）。真实缺陷降级为「59 处引用指向 12 个不存在的文件名」。已按此修正，见规格第 6 条。
2. **C6 的严重度我报高了。** 两次序列化的差只有固定字面量 `+new`（`project.ts:467`），不是已证实的 nonce 绕过。已从本次规格中移出（列入 Out of Scope 之外的独立项）。
3. **C2 的「五个零调用函数」不严谨。** `matchCount` 有调用——`tests/eval/score.mjs:113`。其余四个我复查确认只有测试碰。

### 你上一次审核里我认为不成立的一条

**`STEP_SKIPPED` 对 S2 是空函数，但那是写明的决定，不是疏漏。** `background.ts:958` 那一行正上方有五行注释：「`skipped` has no S2 meaning yet: re-planning would hand back the very step the user just declined… the honest S2 behaviour is to leave the guide standing」。规格把它列入 Out of Scope，只保证「有明确说明」，不发明新语义。如果你认为这个判断错了，请说。

---

## 2. 背景：两套并存的实现

| | S1（旧） | S2（新） |
|---|---|---|
| 入口模块 | `agent/api.ts` 的 `AgentHost` | `agent/host/machine.ts` 纯归约器 + Effect 协议 |
| 状态键 | `thread:{tabId}`（`api.ts:149`，模块私有） | `guide:{tabId}` + `effect:{tabId}`（`host/guide.ts:42-43`） |
| 驱动 | Pack 流程 + 本地词法基线，零模型成本 | 模型 |
| 效果解释器 | `background.ts` 的 `drive()`（约 70 行） | `background.ts` 的 `renderGuideOutcome()`（约 120 行） |
| 路由 | `background.ts:271` 的 `onOwner`：`guideThreadExists()` 为真走 S2，否则走 S1 | 同 |

`route-choice.ts` 的 `chooseGuidePath` 决定新引导走哪条，四条规则按序：无 goal 或调用方自带 steps → S1；Pack 命中 → S1；未配置模型 → S1；否则 → S2。

---

## 3. 已核实的事实（全部我自己 grep/跑正则验证过，请复核）

### 3a. 五条生命周期缺陷

1. **已完成的 S2 Thread 会劫持后续的 S1 引导。** `done` 只写 `status:'completed'`（`machine.ts:666`）不删记录；`guideThreadExists`（`guide.ts`）只查记录存不存在、不查 active；`dropGuideThread` 全仓唯一调用点在 `END_GUIDE` 里（`background.ts:726`），`startGuide` 不删。**触发条件比初判更窄**：新开的若也是 S2 会覆盖同一个 `guide:{id}` 键；只有「S2 完成 → 同一标签页开一条 Pack/baseline 的 S1 引导」才会踩到（S1 写 `thread:{id}`，那条死掉的 S2 记录还在，`onOwner` 仍然选它）。
2. **自然完成不写 Run record。** `writeRunRecord` 唯一调用点也在 `background.ts:717`（`END_GUIDE` 内）。
3. **`SESSION_ENDED/user_closed`（`background.ts:964`）与 `tabs.onRemoved`（`background.ts:1028`）只清 S1**（`agentHost.abort`），S2 的 `guide:`/`effect:` 记录与在途模型调用可能遗留。
4. **`STEP_SKIPPED` 对 S2 是空函数**（`background.ts:963`）—— 见第 1 节，这是决定不是疏漏。
5. **QA 覆盖引导之后只能恢复 S1**：`background.ts:875` 用 `agentHost.exists()` 判断，`:911` 恢复时只读 `thread:`。

**另外**：`background.ts` 有三处按字符串字面量直接读 `thread:${...}`（`:911`、`:979`、`:1033`），各自内联声明了不同的部分 `Thread` 形状，而 `api.ts:149` 的 `keyFor` 是模块私有的。

**这条规则今天已经写在代码里**（`background.ts:712-716` 的注释）：

> Deleting the thread is mandatory (a finished thread left behind makes `guideThreadExists` answer yes forever, and every later flow in this tab gets routed to a run that already ended)

规则写对了，四个结束路径里只有一个执行它。

### 3b. S1 在架构上是净负担

- **它让纯归约器反向依赖被它取代的那条路。** `machine.ts:1`：`import type { HostSignal, TokenUsage } from '@/agent/api'`。除此之外 S2 全线零依赖 S1（`guide.ts` 只在注释里提过 `AgentHost`）。
- **它是这些代码唯一的存在理由**：`api.ts`（403 行）、`drive()`（70 行）、`validate.ts` 的 CL-3/CL-4（19 行，`judgeClarifyEscalation` 本来就零生产调用）、`lexical.ts` 的 `rankCandidates`/`MAX_CANDIDATES`/`LexicalResult`（约 28 行）。
- **`host_signal` 这条归约器输入分支全仓只在测试里被构造过**（`machine.spec.ts:307`），其 handler 是 `return { state, effects: [] }`。

### 3c. S1 今天还剩什么（三条入口的真实分量）

| 条件 | 事实 |
|---|---|
| Pack 命中 | 全仓**一个** pack（github demo），**2 条 flow**（`open-settings`、`find-repo-code-button`），只匹配 `github.com` |
| 未配置模型 | 真实存在。此时 S1 跑词法基线定位——而 **ADR 0011 自己记着**：真实页面上它有子串下限，「几百个控件的页面总会蹭到」，四个真机目标两种语言**全被拦截**；「整个 S2 阶段从产品正门在真实网站上一次都没启动过，139 条 e2e 全绿而多个缺陷仍然存活」 |
| 调用方自带步骤 | 检视器：`App.tsx:586-602` 点一行 → `descriptorOf(item)` + `actionForRole(item.role)` 构造一个 `GuideStep` → `startFlow([step])`。S1 收到之后走 `api.ts` 的 "Path 0"，注释写着「the inspector already knows which element it means, so nothing here extracts」——**存 steps、`present(thread,'locate')`、返回。不抽取、不定位、不规划、不调模型。** |

### 3d. 假绿的架构守卫（我跑正则验证过）

`tests/unit/fixtures/source-scan.ts:77`：

```
MACHINE_IMPORT = /from\s+'(?:@\/agent\/host\/machine|(?:\.\.\/)+host\/machine)'/
```

实际的 import 行，逐行跑过这条正则：

| | 文件 | import 行 |
|---|---|---|
| ✗ 不匹配 | `api.ts:3` | `from './host/machine'` |
| ✗ 不匹配 | `guide.ts:2` | `from './machine'` |
| ✗ 不匹配 | `binding.ts:2` | `from './machine'` |

所以 `architecture.spec.ts:311-322`（「machine.ts 的 step 只能被 agent/api.ts import」）**空过**，而 `:461-465` 的反向验证只测两种源码里不存在的拼法。

**而且被点名的单写者不写**：`api.ts` 函数体里 `step(` 调用 **0** 次、`pageMoved(` **0** 次。真正的单写者是 `host/guide.ts`，无人看守。

### 3e. 词法基线不能整个删（这条修正了我规格的初稿）

`lexical.ts` 的导出与消费者：

| 导出 | 消费者 |
|---|---|
| `rankCandidates` | `api.ts:257`（唯一生产调用点）。`route-choice.ts:21`、`background.ts:599`、`smoke.mjs:1949,2002` 都只是**注释** |
| `MAX_CANDIDATES` | `api.ts` |
| `LexicalResult` | `validate.ts`（喂 `judgeClarifyEscalation`，零生产调用） |
| **`scoreNodes`** | **`tests/eval/score.mjs:16,131`** —— 「零模型下界」，是 `top1_ceiling` 门槛的一半 |
| `tokensOf` | `validate.ts:262` 的 `hasTextualTrace`（CL-4 专用，随 CL-4 一起走）；模块内部 |

**所以 `scoreNodes` 与 CJK 分词必须保留，否则 `npm run eval` 直接红。**

**连带：** `architecture.spec.ts:55-63` 有一条断言「`api.ts` 的源码里不出现 `scoreNodes`」——它的主语（`api.ts`）要被删。这条断言随之删除；它守的那件事（绑定不许打分排序）由同文件里另一条针对 `bind` 的断言继续守着。

### 3f. 悬空文档引用

源码注释里按裸文件名引用的计划文档，**12 个文件名、59 处引用，一个都不存在**：

```
19× 04-effect-protocol.md      13× 05-route-and-steps.md    6× 03-machine-reducer.md
 4× 03-validate.md              4× 02-validate-guide.md     3× 07-panel-loop.md
 2× 09-transition-settled.md    2× 04-prompt.md             2× 02-contract.md
 2× 01-guide-envelope-smoke.md  1× 07-cross-site-and-outcome.md
 1× 05-provenance-scanner-shares-no-code.md
```

`docs/` 里只有 `adr/0001–0012`、`design.md`、`agent-system-tutorial.md`、`research-dom-serialization-and-arrival.md`。**定义在 `design.md` 里活着**（见第 1 节第 1 条）。

### 3g. 六轮真机测量没有被这些缺陷污染

真机脚本每轮之间显式调 `END_GUIDE`（`live-github-run.mjs:570`、`:775`），而那正是今天唯一会 `dropGuideThread` 的地方。**所以那六轮数据是干净的。** 反过来说，脚本的收工方式今天是产品行为的一部分。

---

## 4. 删 ADR 的核对结果

**已经有等价记录的**（删了不丢东西，`CONTEXT.md` 记得比 ADR 更细）：词法打分会丢正解（`Element table` 条目）、Restatement 的结构性判据（`Restatement`）、Entrance 优先保留且刻意不含 `main`（`Entrance`）、Place 曾把指纹算进去而闸门从未命中（`Place`）、两次 violation 各报废一整轮（`Repair call`）、前缀缓存 3712 里 3584 命中（`Repair call`）、L-4 是唯一硬零指标（`L-4`）、解析器永不许发明值（`Provenance`）、模型调用在侧栏（`Panel`）、Thread/Question 分工（两条）。

**ADR 0012 那 120 行的价值基本全在词汇表里了**——这是我未核对就担心的那条，事实上它最安全。

**会留下真空洞、必须并进词汇表的五条：**

1. 宿主进程里 `fetch` 超 30 秒 worker 被杀（`Panel` 条目只说了结果不说原因）
2. `storage.session` 只有 SW 能写
3. `machine.ts` 是纯归约器
4. `scanner.ts` 是独立重写的第二实现、零函数共享（`Provenance` 只记规则不记机制）
5. 139 条 e2e 全绿而产品正门一次没启动过

外加两条本次产生的：为什么删 S1、词法基线的候选排序部分退场。

---

## 5. 测试缝

**新缝只有一个。** `host/guide.ts` 新增一个生命周期函数，`GuideEffectDeps` 加一个 Run record 端口。测在 `route-and-steps.spec.ts`——那个文件**已经**用内存 `ThreadStore` 驱动这个缝，而且它的 harness **已经在记录存储调用顺序**（`order` 数组），这正是「先落盘、再删线程」需要断言的东西。

其余全落在现有缝：新输入分支 → `machine.spec.ts`（驱动 `step()`，纯对象进纯对象出）；守卫 → `architecture.spec.ts` + `source-scan.ts`；删除的完整性 → typecheck 零错误。

**端到端只证明接线，不再证明逻辑。**

**我要修正规格里的一句话**（这句话在 `spec.md` 的 Further Notes 里，我还没改）：规格写「三条 e2e 断言必须排在删除之前」——**那三条今天全是红的**（`done`、关浮层、关标签页现在都不清理），没法当「先补的网」。正确的形状是每条断言和它的接线**同一张票**落地，而真正的网是「`END_GUIDE` 这条已有的 e2e 断言在整个过程中一直绿」。**请把这一处当成已知待修，不是遗漏。**

---

## 6. 九张票草案（尚未落盘）

| # | 标题 | Blocked by | 交付 |
|---|---|---|---|
| 01 | 归约器不再向旧实现借类型 | 无 | `TokenUsage` 并入宿主 Effect 用量类型；`HostSignal` 与其死输入分支一起删。行为零变化。**这是预重构**：做完之后 06 删旧实现时不必再碰归约器 |
| 02 | 一趟引导结束，只有一个所有者 | 无 | 生命周期函数接管那五件事；Effect 依赖对象加 Run record 端口；「显式结束引导」改为调它。**行为零变化**，现有 e2e 断言即为网。新增单测含「落盘在删除之前」的顺序断言 |
| 03 | 模型说 `done` 就真的结束 | 02 | `done` 走同一路径。**劫持缺陷随之消失。** 加一条 e2e |
| 04 | 关浮层、关标签页也走同一个结束 | 02 | 两条平台监听器改为调它。在途模型调用被取消。加两条 e2e |
| 05 | 检视器走归约器的「带现成步骤开始」 | 01 | 新输入形态；检视器改走它。**旧实现还在，两条路并存**，套件绿 |
| 06 | 删掉旧实现，键空间收敛 | 03, 04, 05 | 删约 520 行；旧键空间退场；三处字面量读取改具名函数；QA 恢复修好；未配置模型时给明确说明。typecheck 零错即为「不留半条路」的证明 |
| 07 | Pack 只提供站点知识 | 06 | 删 `flows`/`PackFlow`/`PackStep`/`matchFlow`/`toPackYaml`。`siteNotes` 与 `packsFor` 留 |
| 08 | 单写者断言改成断言调用点，并且自检 | 06 | 断言调用点而非 import；加「至少匹配一处」的前置断言 |
| 09 | 决策记录退场，事实并入词汇表 | 06 | 删 `docs/adr/`；七条事实并入词汇表；59 处改指；加悬空引用守卫 |

### 三个开放问题（这是我最想要你意见的地方）

**① 票 06 是否太大？** 它一张要删 520 行、跨 4 个模块、退一个键空间、改三处读取、修一条恢复路径。可拆成 06a（删旧实现 + 键空间退场）和 06b（三处读取 + QA 恢复），代价是 06a 落地时 QA 恢复会短暂指向一个已删的存在性判断——**中间状态是坏的**。`/to-tickets` 明说宽重构可以这样但要共享集成分支。**我倾向不拆**，宁可一张大票也不要坏的中间状态。

**② 09 的阻塞边只有一半是真的。** 59 处改指里有一部分指向的注释会随 06 一起删，但删 ADR 目录和并事实进词汇表随时能做。是否拆成「09a 词汇表 + 删 ADR（无阻塞）」和「09b 改指 + 加守卫（挂 06）」？

**③ 03 和 04 是否该合并？** 形状完全一样（把一个结束路径接到 02 上 + 加 e2e）。我分开的理由是 03 修掉的是用户会看见的劫持缺陷、可以单独演示，04 修的是资源泄漏。

---

## 7. 硬约束（重构不得推翻）

- **SSE 必须在侧栏** —— SW 里 `fetch` 响应超 30 秒 worker 被终止。这是平台事实。
- **`machine.ts` 是纯归约器** —— 零 `await`/`fetch(`/`chrome.*`，有正则守卫（`source-scan.ts:69`）。注意该守卫**只**检查这三样，它看不见「安全授权（`:529`）、pack 查找（`:506`）与六个用户可见字符串已经搬进了这个纯归约器」。
- **`scanner.ts` 是独立重写的第二实现**，绝不 import `contract.ts`。
- **Element table 用带 nonce 的标签包裹**，nonce 在抽取之后生成。
- **`CLAUDE.md`**：不保留向后兼容（直接删过时路径，不加兼容层）；最简实现；分层演进（绝不用一个可用的产品换未完成的复杂度）；组件模块化职责边界清晰；优先用已有依赖；**不得自行执行任何 Git 操作**。

（前四条今天记在 `docs/adr/`，本次将并入 `CONTEXT.md` —— 见第 4 节。）

---

## 8. 我在这次过程中被自己或数据证伪的四处

列出来是为了让你不必重新发现，也为了让你判断我的证据标准。

1. **我说 pack flows 必须跟着 S1 死** → 查出 S1 的转换只是六行纯映射（`api.ts` 里 `hit.flow.steps.map(...)`），flows 本可近乎免费搬到 S2。用户在知道这个事实之后仍选择删。
2. **我说 `author.ts` 会跟着死** → 错，它被 `content.ts:6` import（`authorDescriptor`、`toPackYaml`）。由此才产生「检视器的导出怎么办」这个问题。
3. **我担心删 ADR 会丢掉 0012 那 120 行的教训** → 查出 `CONTEXT.md` 已经记得更细。代价比我说的小得多。
4. **我说词法基线整个删掉（写进了规格初稿）** → 查出 `tests/eval/score.mjs` 用 `scoreNodes`，删了 `npm run eval` 会红。规格已修正（第 3e 节）。

---

## 9. 复现命令

```
npm run typecheck        # 应 0 错
npm run test             # 33 个文件 1581 用例
npm run e2e              # 170/170（会先 wxt build）
npm run eval             # 全门槛通过
```

真机脚本（**花真钱、不进 CI**）：

```
npx wxt build && node --experimental-strip-types \
  --import ./tests/alias-loader-register.mjs \
  tests/spike/live-github-run.mjs
```

历史真机日志（同格式，每份 42 行 = 21 轮 × start/end）：`tests/spike/live-github-run-log.run3.ndjson`、`.run4.`、`.run5.`，当前 `.ndjson` 是第六轮。
