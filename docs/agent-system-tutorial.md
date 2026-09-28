# Page Guide Agent 系统实现教材

> 本文解释仓库在当前版本中如何用 TypeScript 构建浏览器 Agent。重点是已经运行的代码，不把注释中的未来计划当成现状。

## 1. 先给结论

这个项目不是一个“把整页 HTML 丢给模型，然后让模型操作浏览器”的通用 Agent。

它是一个 Chrome Manifest V3 扩展。扩展读取页面的可交互元素，把它们压缩为有编号的语义表，让模型选择下一步；扩展只负责高亮和观察，最终点击、输入、选择仍由用户完成。

当前架构由两条执行路径组成：

1. 引导（Guide）：手写的纯 reducer 状态机，配合持久化 Effect 协议。计划有两种来源——模型按页面变化持续规划，或检视器交来的固定计划（`Fixed plan`，永不调用模型）。
2. 页面问答 QA：无状态的直接调用链，不创建 Guide Thread。

当前项目没有安装 LangChain、LangGraph 或 XState。`package.json` 中的主要运行时依赖只有 React、React DOM 和 `dom-accessibility-api`。代码注释中出现的 “LangGraph arrives” 是历史路线图文字，不代表当前已经使用 LangGraph。

如果只记住一条原则，应当记住：

> 模型负责作出建议，Host 负责流程权威，Content Script 负责读取和呈现；没有任何模块替用户执行网页操作。

相关入口：

- [package.json](../package.json)
- [后台入口](../src/entrypoints/background.ts)
- [内容脚本入口](../src/entrypoints/content.ts)
- [侧栏 UI](../src/entrypoints/sidepanel/App.tsx)
- [引导的单一写入者](../src/agent/thread/writer.ts)

## 2. 技术栈和编译边界

项目使用：

- WXT `0.21.3`：浏览器扩展框架和构建入口；
- TypeScript `5.9`：领域模型、RPC、状态机和适配器；
- React `19`：Side Panel UI；
- Vitest：单元和架构约束测试；
- Playwright：端到端、测量和抽取评测；
- Chrome MV3：Service Worker、Content Script、Side Panel、Storage 和消息通道。

TypeScript 配置打开了：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "verbatimModuleSyntax": true,
  "jsx": "react-jsx"
}
```

这些选项对 Agent 尤其重要：模型输出、浏览器消息和 DOM 查询都可能缺字段或返回未知值，代码不能假装这些值总是存在。

常用命令：

```bash
npm run dev
npm run typecheck
npm run test
npm run e2e
npm run verify
npm run eval
```

## 3. 浏览器扩展的三个运行环境

Agent 不是运行在一个长寿命 Node.js 进程中。它分散在三个生命周期不同的环境里。

### 3.1 Content Script：页面感知和覆盖层

[content.ts](../src/entrypoints/content.ts) 运行在网页旁边，能访问 DOM。它负责：

- 抽取可交互元素；
- 建立本次快照的 `Ref -> Element` 注册表；
- 把 Agent 的步骤解析回真实元素；
- 绘制高亮、洞和提示卡；
- 被动监听用户的点击、切换和选择；
- 监听页面结构是否发生变化。

它不持有整个 Guide 的游标，也不负责调用模型。页面导航后它可能被重新创建，所以不能成为工作流权威。

### 3.2 Background Service Worker：流程权威

[background.ts](../src/entrypoints/background.ts) 是 Host。它负责：

- 接收 Side Panel 请求；
- 确保 Content Script 已注入；
- 选择 `step-one` 或 `model` 路径；
- 作为 Guide 状态的单写者；
- 把状态存入 `chrome.storage.session`；
- 把模型 Effect 广播给 Side Panel 执行；
- 把步骤转换为 `HIGHLIGHT` 命令；
- 处理导航、用户确认、目标丢失和超时。

MV3 Service Worker 会被浏览器回收。代码因此不能依赖内存中的闭包、Promise 或生成器永远存活，恢复所需的事实必须先持久化。

### 3.3 Side Panel：视图和外部 Effect 执行器

[App.tsx](../src/entrypoints/sidepanel/App.tsx) 与 [effects.ts](../src/entrypoints/sidepanel/effects.ts) 负责：

- 收集用户目标；
- 展示路线、当前步骤、历史、错误和消耗；
- 执行模型请求；
- 执行文档请求的预留协议；
- 将 Effect 结果送回后台；
- 独立执行页面 QA。

模型调用没有放在 Service Worker 中，是因为 Side Panel 更适合承载长连接、流式响应和用户可见的进度；但它不是状态权威，关闭后不能让 Thread 丢失。

## 4. 模块地图

可以把 `src` 理解为五层：

```text
src/
├── entrypoints/                 浏览器进程边界
│   ├── background.ts            Host、Chrome API、消息路由
│   ├── content.ts               DOM、overlay、用户动作观察
│   └── sidepanel/               React UI、模型/网络 Effect
├── agent/
│   ├── agents/                  两个 Agent：guide（引导）与 question（问答），各带 output/
│   ├── tools/                   Tool：need_docs
│   ├── envelope/                Envelope 解析、Provenance 扫描、通用校验
│   ├── prompts/                 系统提示词各段、修复轮提示词
│   ├── context/                 user 消息拼装、nonce、Plugin 贡献
│   ├── skills/                  站点技能（第一个 Plugin）
│   ├── thread/                  归约器、Fixed plan、单写者、Effect、重新规划、Run record
│   └── provider/                OpenAI-compatible SSE 客户端
├── core/
│   ├── extractor/               DOM -> LocatorView -> PromptTable
│   ├── locator/                 本地词法候选排序
│   ├── descriptor/              Descriptor 的绑定与生成
│   ├── overlay/                 高亮与跟踪
│   └── security/                敏感字段、链接安全
└── shared/                      跨进程线协议和共享小类型
```

这是一个相对健康的依赖方向：领域决策代码不直接依赖 `chrome.*`，进程入口通过 port/adapter 调用它。

## 5. 系统中的两种“身份”

网页 Agent 最容易犯的错误之一，是把 DOM 节点身份当成永久身份。项目明确区分了两种标识。

### 5.1 `Ref`：只在一次快照内有效

[shared/types.ts](../src/shared/types.ts) 使用 branded type：

```ts
export type Ref = string & { readonly __brand: 'Ref' };

export const makeRef = (frameId: number, n: number): Ref =>
  (frameId === 0 ? `e${n}` : `f${frameId}e${n}`) as Ref;
```

`e12` 看起来是字符串，但 TypeScript 不允许任意字符串不经转换就进入要求 `Ref` 的接口。`Ref` 只对生成它的 `snapshotId` 有意义。

### 5.2 `ElementDescriptor`：跨快照的语义身份

[shared/protocol.ts](../src/shared/protocol.ts) 中的 descriptor 使用用户可理解的属性：

```ts
export interface ElementDescriptor {
  role: string;
  name: string;
  nameMatch?: 'exact' | 'contains' | 'fuzzy';
  scope?: string;
  nth?: number;
}
```

它不保存 XPath、CSS selector 或坐标，而是保存角色、名称、区域和必要时的序号。这样页面重新渲染后仍有机会重新绑定。

原则是：

- `Ref` 快且精确，但会过期；
- descriptor 较慢且可能歧义，但可以跨快照恢复；
- 歧义时显示全部候选，不偷偷挑一个。

## 6. 页面不是以完整 HTML 进入模型

用户担心 context window 被完整 HTML 撑满，这个方向是对的，但当前实现已经不是直接发送 `document.documentElement.outerHTML`。

实际数据流是：

```text
DOM
  -> extract(): LocatorView（本地完整语义视图）
  -> project(): PromptTable（按预算筛选）
  -> toPromptText(): 紧凑文本
  -> buildGuidePrompt(): 模型消息
```

### 6.1 抽取

[extract.ts](../src/core/extractor/extract.ts) 遍历普通 DOM 和可访问的 open Shadow DOM，并综合：

- ARIA/原生 role；
- accessible name；
- 可见性；
- 表单状态；
- 所属语义区域；
- 是否敏感；
- 链接地址；
- 几何信息和文档顺序。

抽取结果首先留在本地。这样 overlay 和 late binding 可以访问较完整的候选，而模型只接收投影后的子集。

### 6.2 投影和预算

[project.ts](../src/core/extractor/project.ts) 将完整元素集合压缩为 `PromptTable`。预算来自 [budget.ts](../src/agent/budget.ts)：

- 小于 16k context：最多 60 个节点；
- 16k 到 64k：最多 150 个节点；
- 大于 64k：最多 250 个节点。

当前评分主要考虑视口距离、常见主操作角色、名称是否为空和敏感惩罚。它不理解用户目标，因此仍可能把与任务真正相关、但位置较远的元素裁掉。

### 6.3 Prompt 序列化

`toPromptText()` 使用紧凑格式：

```text
## Settings › Account
e12 button "Delete account"
e13 textbox "Email" [required]
e14 textbox "Password" !secret
```

它用分组标题代替每行重复 path，并省略重复字段名。代码注释记录的测量显示，同一批 150 个元素从 7623 字符降到 4366 字符。

需要注意，`PromptTable` 中虽然还有 `url`、`title`、`pageHash` 和每项的 `href` 等数据，当前 `toPromptText()` 并没有把所有这些元数据都序列化进节点文本。理解“类型里有字段”和“模型实际看到了字段”的差别非常重要。

## 7. 路由：一次 Guide 到底由谁回答

`startGuide`（[background.ts](../src/entrypoints/background.ts)）只做一个判断：

1. 调用方已经交来步骤（检视器点的那一行）→ **固定计划**：落地即画出第一步，永不调用模型；
2. 否则 → **模型规划**。没有配置模型时直接说明「还没有配置模型」，不启动引导。

本地词法 baseline 已经不在路由里。它曾经横在模型前面，只有它判「找不到」才放行，而在真实页面上这个判定几乎从不成立——见 [CONTEXT.md](../CONTEXT.md) 的 `Fixed plan` 条目。

## 8. （历史）第二套引导实现

早期还有一套 `StepOneHost`，用 `AsyncIterable` 事件流表达中断，状态存在 `thread:{id}`。它已经整体删除：三条入口里，检视器交来的步骤变成了固定计划，站点包的流程删掉、说明站点的那一半成了今天的 Skill，本地词法基线在真实页面上几乎不可达。现在只有下一节的 reducer 一套实现。

## 9. 纯 reducer 状态机

模型 Guide 的核心在 [machine.ts](../src/agent/thread/machine.ts)：

```ts
export function step(
  state: ThreadState | null,
  input: MachineInput,
): { state: ThreadState; effects: MachineEffect[] };
```

这是 `(旧状态, 事实) -> (新状态, 待执行命令)`。它不访问 Chrome、不发网络请求、不读系统时间，也不直接写 storage。

`MachineInput` 包括：

- `start`：开始新目标；
- `effect_result`：模型或外部读取结果；
- `host_signal`：用户确认、跳过、导航、目标丢失；
- `bind_result`：高亮绑定结果；
- `cross_site_decision`：跨站确认；
- `step_settle_timeout`：等待页面稳定结束；
- `page_changed`：新页面表已准备好。

`MachineEffect` 包括：

- `present`：展示当前步骤；
- `callModel`：请求模型规划；
- `fetchDoc`：请求文档；
- `clarify`：向用户提问；
- `requestCrossSiteConfirm`：请求跨站确认；
- `done`：提出完成；
- `notify`：显示消息。

这就是“Decision 与 Execution 分离”：状态机决定要做什么，外层 adapter 决定怎样调用 Chrome、模型、fetch 或 UI。

### 9.1 `ThreadState` 中的重要事实

[thread.ts](../src/agent/thread/thread.ts) 保存：

- `rev`：线程修订号；
- 原始 `goal`；
- 当前 `PromptTable`；
- 模型给出的 route 和 steps；
- 当前 cursor；
- 已走过的历史；
- binding/evidence/check 三条独立状态轴；
- `inflight` effect tombstone；
- 模型调用和文档读取计数；
- 当前 Thread status。

`rev` 在每次 reducer 调用时递增。Effect 还保存发出时的 `WorldAt`：`threadRev`、`snapshotId`、`pageHash` 和 `url`。结果回来后，Host 可以判断它是否属于当前世界。

### 9.2 为什么 reducer 要保持纯净

纯函数带来三个直接收益：

1. 每个状态转移都能在 Vitest 中用普通对象重放；
2. Chrome Service Worker 重启不会改变决策语义；
3. 将来若替换模型 SDK或编排框架，不必搬动抽取、安全和 UI 逻辑。

## 10. 持久化 Effect 协议

模型调用发生在 Side Panel，但状态权威在 Background。两者通过 [effect.ts](../src/agent/thread/effect.ts)、[guide.ts](../src/agent/thread/writer.ts) 和共享消息协议协作。

核心顺序是：

```text
Background                           Side Panel
    |                                    |
    | reducer 产生 callModel             |
    | 写 guide:{threadId}                |
    | 写 effect:{threadId}               |
    |---- EFFECT_REQUEST --------------->|
    |                                    | claim(effectId)
    |                                    | 调用模型
    |<------------- EFFECT_RESULT -------|
    | 校验 effectId / WorldAt             |
    | reducer 接受或丢弃结果              |
    | 持久化新状态                         |
```

[guide.ts](../src/agent/thread/writer.ts) 的 `applyGuideInput()` 是 S2 调用 reducer 的唯一位置。它保证：

1. 先加载最新状态；
2. 如果返回的 `effectId` 与当前 inflight 不同，直接丢弃；
3. 调用纯 reducer；
4. 先持久化 Thread 和 Effect；
5. 持久化完成后才发送 `EFFECT_REQUEST`。

“先写后发”不是风格问题。如果先发请求后 Service Worker 被回收，返回结果可能找不到对应的 inflight 事实。

### 10.1 至多一个外部 Effect

Thread 的 `inflight` 是 tombstone。只要它存在，状态机就不会再发第二个付费调用。这使并发规则结构化，而不是依靠 UI 按钮的临时禁用。

### 10.2 重复 Side Panel 和 Effect Claim

Chrome 可能有多个绑定同一 tab 的 panel 实例，都收到广播。每个 executor 在真正请求前发送 `EFFECT_CLAIM`，只有第一个获得执行权，避免重复扣费。

### 10.3 超时和恢复

Effect 带 deadline。后台在后续消息唤醒时执行被动 sweep：

- 未过期：报告 still-running；
- 已过期：合成一个 retryable failure；
- 已完成或不存在：不恢复。

Panel 重开时先查询 `PANEL_GUIDE_INFLIGHT`，不会盲目重发请求。

## 11. 一次 Model Guide 的完整时序

下面按照真实跨进程路径走一遍。

1. 用户在 Side Panel 输入目标，`App.tsx` 发送 `START_GUIDE`。
2. Background 确保 tab 中存在 Content Script；没有交来步骤就读取模型配置，未配置时直接说明并停止。
3. Model 路径要求 Content Script 执行 `EXTRACT`，得到预算内 `PromptTable`。
4. Background 以 `start` 调用 `applyGuideInput()`。
5. reducer 创建 Thread，产生 `callModel`，并写入 inflight。
6. Host 先把 `guide:` 与 `effect:` 记录写入 session storage，再广播 `EFFECT_REQUEST`。
7. Side Panel claim 成功后，用 `buildGuidePrompt()` 构造消息，通过 Provider 发出请求。
8. Panel 对模型文本执行 parse、必要时一次 repair，以及结构/引用安全校验。
9. Panel 把原始模型文本连同 `effectId` 和 `WorldAt` 作为 `EFFECT_RESULT` 返回。
10. Background 检查 effect 是否仍是当前 inflight，再交给 reducer。
11. 合法 `guide` envelope 替换 Thread 中的 route/steps，reducer 产生 `present`。
12. Background 将 `present` 转成 Content Script 的 `HIGHLIGHT`。
13. Content Script 先按当前快照 Ref 快速绑定；失败时用 descriptor 在完整本地表中 late-bind。
14. Content Script 再次阻止敏感目标，绘制 overlay，并返回 `HighlightAck`。
15. Background 将 ack 转成 `bind_result`，更新 binding 状态。
16. 用户本人点击或切换控件；Content Script 只是被动发出 `STEP_CONFIRMED`。
17. Background 等页面稳定，重新抽取；如果 `pageHash`、URL 或结构确实变化，就以 `page_changed` 进入下一轮规划。
18. 循环继续，直到需要澄清、失败、用户结束，或模型提出 done。

重要点是：模型每轮看到的是新的页面投影和完整 Guide history，而不是继续信任已经过期的 DOM 引用。

## 12. Prompt、解析和运行时校验

### 12.1 Prompt 构造

[user-message.ts](../src/agent/context/user-message.ts) 的 `buildGuideUserMessage()` 与 [system.ts](../src/agent/prompts/system.ts) 的各段说明组合：

- 固定 system instruction；
- 用户原始目标；
- 当前压缩后的 `PromptTable`；
- 已走过的 Guide history；
- 页面不可信内容的 nonce 边界。

网页文字被视为数据而非指令，这可以减轻页面中的 prompt injection，但不能把它变成绝对安全边界。

### 12.2 模型契约

[contract.ts](../src/agent/envelope/contract.ts) 定义 Guide envelope 的 discriminated union：

- `guide`：路线和可执行的下一步建议；
- `clarify`：候选歧义，需要用户选择；
- `need_docs`：需要站点文档；
- `done`：模型认为目标可能已经完成。

QA 使用另一套更小的 envelope：`explain`、`clarify`、`need_text`。

### 12.3 不信任模型输出

模型响应在运行时只是 `unknown`/string，不因为 TypeScript 声明就自动安全。

[scanner.ts](../src/agent/envelope/scanner.ts) 和 `parseContract()` 会从可能带前后文本的输出中扫描 JSON，检查 provenance 和可识别 shape。若第一次解析失败，调用方最多执行一次修复请求。

[validate.ts](../src/agent/envelope/validate.ts) 再检查：

- intent 是否在允许集合中；
- guide steps 是否非空；
- action 是否为允许值；
- 每个 ref 是否存在于当前表；
- 目标是否敏感；
- 结构是否与 envelope 类型一致。

这能证明输出“可消费且引用当前页面”，不能证明模型建议在业务语义上正确。

## 13. Provider：为什么没有直接使用 SDK

[provider.ts](../src/agent/provider/provider.ts) 是一个小型 OpenAI-compatible SSE client。它负责：

- 构造 chat completion 请求；
- 解析 SSE 增量；
- connect、stall、total 三类超时；
- 限制 response bytes；
- 读取或估算 token usage；
- 把错误归类为可重试、认证、限流、上下文过长等情况。

它通过依赖注入接收 fetch/clock 等能力，便于测试。

目前不引入 LangChain 的合理原因是：这里需要的是一个受控的单一 Provider 边界，不是大量 chain/tool abstraction。添加框架只有在删除更多自有复杂度时才有价值。

## 14. QA 为什么不建 Thread

“问这个页面”在 [qa.ts](../src/entrypoints/sidepanel/qa.ts) 和 `App.tsx` 中走一条无状态路径：

```text
PANEL_EXTRACT
  -> build QA prompt
  -> provider.complete
  -> parseContract
  -> optional one repair
  -> validateEnvelope
  -> render answer / explain highlight
```

QA 不创建 Thread，原因是它没有“显示一步并等待用户动作”的生命周期。把所有模型请求都塞进引导状态机，会让简单问答也承担 Thread、cursor 和恢复的概念。

若 QA 答案引用控件，Panel 会把提问时的 `snapshotId`、URL 和已解析 `PromptItem` 发送给 Host。Host 再检查 tab 当前 URL，Content Script 再检查 snapshot。任何一层变化都拒绝复用旧引用。

当前 `need_text` 只表示“仅靠交互元素不足以回答”；正文读取管线尚未实现。

## 15. 重绑定、重规划和页面稳定

### 15.1 Late binding

高亮时首先使用本快照 registry 中的 `Ref`。如果 Ref 已过期，Content Script 依据 descriptor 在新的完整表中匹配。

结果分为：

- `bound`：唯一匹配，可高亮；
- `ambiguous`：多个候选，全部只画轮廓，不擅自选择；
- `unbound`：没有候选，反馈给 Host 重新规划。

相关代码：

- [binding.ts](../src/agent/thread/binding.ts)
- [descriptor bind](../src/core/descriptor/bind.ts)
- [registry.ts](../src/core/extractor/registry.ts)

### 15.2 Latest-wins 重规划

[replan.ts](../src/agent/thread/replan.ts) 对快速连续变化使用 latest-wins 队列，并在不同场景使用稳定等待窗口。这样 React 页面的一连串 mutation 不会造成每一次都调用模型。

当前窗口大致是：

- 已稳定页面：立即检查；
- 尚未稳定：0、300、500、600ms；
- 导航后：0、400、800、1200、2000ms。

只有新表与 Thread 规划时的页面确实不同，才产生 `page_changed`。

曾经有一个「页面是否已经停止变化」的纯判定模块，接进重新规划后，真机上的跳数减半，所以撤了下来，模块也已删除。它留下的测量与教训，写在 `entrypoints/background.ts` 放等待窗口的那段注释里。

## 16. 安全模型：Guide，不是 Executor

安全边界首先体现在协议设计，而不是 prompt 里一句“不要点击”。

Content RPC 是封闭白名单：

```ts
export const RPC_TYPES = [
  'PING',
  'EXTRACT',
  'HIGHLIGHT',
  'CLEAR',
  'INSPECT',
  'DEBUG_GET_OVERLAY_STATE',
] as const;
```

没有 `CLICK`、`TYPE`、`SUBMIT` 或通用 `EXECUTE`。Content Script 只观察用户真实动作，不模拟动作。

此外还有：

- 敏感字段在抽取、模型校验和最终绘制边界多次拦截；
- 跨站链接在展示前要求确认；
- QA highlight 不能在页面变化后重新绑定为另一个元素；
- 歧义候选全部显示，不做隐藏 tie-break；
- 用户看到的 focus 按钮只定位，不激活控件。

相关代码：

- [sensitive.ts](../src/core/security/sensitive.ts)
- [link-safety.ts](../src/core/security/link-safety.ts)
- [architecture tests](../tests/unit/architecture.spec.ts)

## 17. TypeScript 在这里不是“给 JavaScript 加注释”

项目使用 TS 直接表达架构约束。

### 17.1 Discriminated union 表达有限状态语言

`MachineInput`、`MachineEffect`、`Envelope`、`AgentEvent`、`ContentResponse` 都有稳定 tag。新增一种输入时，编译器会指出需要更新的 switch。

UI 也可以使用穷尽分支：

```ts
function renderEnvelope(value: Envelope) {
  switch (value.kind) {
    case 'guide':
      return renderGuide(value);
    case 'clarify':
      return renderClarify(value);
    case 'need_docs':
      return renderNeedDocs(value);
    case 'done':
      return renderDone(value);
  }
}
```

### 17.2 Mapped type 保持 RPC 请求与结果同步

`ContentRpcMap` 是协议唯一事实源，`ContentRequest` 从它推导：

```ts
export type ContentRequest = {
  [K in RpcType]: { type: K } & ContentRpcMap[K]['req'];
}[RpcType];
```

`RPC_TYPES` 是运行时白名单，`VerbsAgree` 则在编译期证明白名单和 type map 没有漂移。

### 17.3 `Extract`、`Exclude`、`Omit` 精确切割联合类型

Effect adapter 不需要重复声明“可派发 Effect”，可以从 `MachineEffect` 中提取：

```ts
type ExternalEffect = Extract<
  MachineEffect,
  { kind: 'callModel' | 'fetchDoc' }
>;
```

这比复制一个相似 interface 更不容易随状态机演进而漂移。

### 17.4 Port interface 隔离平台能力

[ports.ts](../src/agent/thread/ports.ts) 定义 `ThreadStore`、`PageAccess`、`RecordStore` 等小接口。Agent 层只依赖能力，不依赖 Chrome 实现。

典型测试 adapter 可以只是内存 Map：

```ts
const values = new Map<string, unknown>();

const store: ThreadStore = {
  async get(key) {
    return values.has(key) ? { [key]: values.get(key) } : {};
  },
  async set(items) {
    for (const [key, value] of Object.entries(items)) values.set(key, value);
  },
  async remove(key) {
    values.delete(key);
  },
};
```

### 17.5 `readonly` 表达所有权

Prompt items、route、steps 和候选经常是 `readonly`。调用方不能随手原地修改跨模块数据，而是必须明确构造下一状态。

### 17.6 `unknown` 是跨边界的正确起点

Storage、Chrome message、JSON 和模型输出不应直接 `as Envelope`。类型系统只约束编译时，运行时边界仍需 decoder/validator。

## 18. 怎样在当前架构中添加一个 Agent 能力

不要从 UI 组件里直接加 fetch 和状态变量。按下面顺序工作更稳妥。

### 场景 A：添加一个纯决策分支

例如新增“用户拒绝某类步骤”：

1. 在 `MachineInput` 增加带 tag 的输入；
2. 在 reducer 添加转移；
3. 只返回新状态和已有/新增 Effect；
4. 先写 reducer 单元测试；
5. 再在 Background 把真实浏览器事件翻译为该输入。

### 场景 B：添加一个外部 Effect

例如真正完成 `fetchDoc`：

1. 明确 reducer 需要保存哪些授权与恢复事实；
2. 在 `MachineEffect` 增加或完成 effect shape；
3. 在 Effect wire contract 加 request/result；
4. `applyGuideInput()` 必须先持久化再发送；
5. Side Panel executor 先 claim，再执行网络调用；
6. 结果必须带 `effectId` 和原始 `WorldAt`；
7. 测试重复投递、超时、panel 重开和 stale result；
8. 最后才接 UI。

### 场景 C：添加新的 DOM 信息

例如让模型看到链接目标：

1. 确认 extractor 已能安全读取；
2. 在本地完整 view 中保留；
3. 决定 projection 是否裁剪；
4. 明确写进 `toPromptText()`，否则模型仍看不到；
5. 更新 token/字符预算测量；
6. 增加 prompt snapshot 和真实页面 eval。

## 19. 测试体系应该怎样阅读

项目测试不只验证函数返回值，还用测试锁住架构性质。

### 19.1 单元测试

重点目录是 [tests/unit](../tests/unit)。典型覆盖：

- `machine.spec.ts`：状态转换；
- `effect.spec.ts`：持久化顺序、重复投递、超时和 claim；
- `route-and-steps.spec.ts`：规划、route 和 replan；
- `contract.spec.ts` / validator 相关测试：模型输出边界；
- extractor、binding、security、overlay 的纯逻辑。

### 19.2 架构测试

`architecture.spec.ts` 会检查：

- RPC 白名单没有执行型 verb；
- `src/agent` 没有直接依赖 Chrome API；
- reducer 的调用位置保持单一；
- Effect wire 收发没有渗入纯 Agent 层。

这类测试把“架构说明”变成可以失败的约束。

### 19.3 E2E 和 Eval

`npm run e2e` 构建扩展后执行浏览器 smoke。`npm run eval` 则捕获真实/固定页面上的抽取结果并评分。

但要区分两种绿色：

- 元素抽取得对、协议没有错；
- Agent 真的为用户目标选对了下一步。

前者全绿不能证明后者。仓库中的 live run 日志说明，真实页面上仍会发生语义误判和循环，因此需要独立的任务成功率评测。

## 20. 当前已经确认的缺口

以下不是抽象批评，而是当前代码边界中的具体未完成项。

### 20.1 `fetchDoc` 类型存在，但 Host 没有真正派发

Side Panel executor 和 wire 类型已经有 `fetchDoc` 形状，但 [guide.ts](../src/agent/thread/writer.ts) 的 `toEffectRequest()` 当前只会真正转换 `callModel`。遇到 `need_docs` 时，代码会清掉无法投递的 inflight，并提示文档读取不可用，以避免线程永久卡死。

### 20.2 `done` 仍是提案，不是完整终态

模型的 `done` 会产生完成提案，但当前没有实现“用户确认后把 Thread 可靠地转为 completed 并收尾”的完整闭环。UI 文案因此只能表达“看起来已经到了”。

### 20.3 上下文仍会随历史增长

虽然页面已从 HTML 压缩为 `PromptTable`，每次重规划仍会携带完整 Guide history。长任务会重复发送早期事实，context window 和注意力会逐步被稀释。

### 20.4 投影是目标无关的

当前 node ranking 不使用 goal。预算紧张时，真正相关元素可能在进入模型前就被裁掉。此时再优化 system prompt 也无法恢复模型从未看到的信息。

### 20.5 结构校验不等于语义校验

validator 可以拒绝不存在的 Ref、敏感字段和错误 action，却无法判断“删除账号”是否真的应该点击当前这个 Delete 按钮，也无法证明目标已经完成。

### 20.6 正文问答未接通

QA 的 `need_text` 分支存在，但正文抽取、分块和检索还没有生产实现。

### 20.7 （已解决）双 Host

曾经有两套引导实现并存（`thread:` + `AsyncIterable` 与 `guide:` + reducer/Effect），共享浏览器事件却各有持久化与恢复协议，退出入口也只清理其中一套。旧实现已经删除，现在所有结束方式——结束引导、关浮层、关标签页、归约器的五种终态——都走同一个终结流程。

## 21. 对 context window、system prompt、HTML 工具的诊断

用户最初提出的三个方向都成立，但优先级需要更精确。

### 21.1 Context window

当前不是“完整 HTML 直接进模型”，真正问题是：

- PromptTable 选择目标无关；
- 多轮重复携带完整历史；
- 当前页信息、历史证据、系统规则处在同一注意力竞争空间；
- token budget 只控制节点数，没有按任务阶段分配信息预算。

建议先测量每轮 system/history/table/output 的 token 占比，以及“正确目标是否进入 PromptTable”的 recall，再决定是否做摘要或检索。

### 21.2 System prompt

System prompt 目前同时承担安全、输出格式、路线规划和页面理解。继续堆规则很容易让优先级互相干扰。

更稳妥的拆法是把确定性工作移出 prompt：

- 输出结构由 schema/validator 保证；
- 安全由协议和 Host 拒绝保证；
- 候选生成由 extractor/retriever 保证；
- prompt 只要求模型在已给候选中作语义判断并解释依据。

### 21.3 HTML 解析工具

当前 extractor 已比原始 HTML 好很多，但它把“抽取所有可交互元素”和“为特定目标检索候选”混在一次目标无关 projection 中。

下一步应保持完整 `LocatorView` 在本地，再引入两阶段检索：

1. 用 goal 对 role/name/scope/href/可见文本做宽召回；
2. 用模型或轻量 reranker 对较小候选集排序；
3. 若低置信或缺失，允许模型请求特定区域/正文，而不是重读整页。

这样优化的是“模型看见什么”，通常比把 system prompt 写得更长有效。

## 22. 是否适合迁移到 LangChain / LangGraph

### 22.1 LangChain

不建议为了“项目是 Agent”而整体迁移到 LangChain。当前 Provider、prompt builder、contract parser 和 validator 都是小而清晰的深模块。用 LangChain wrapper 替换它们，未必减少代码或提升可靠性。

LangChain 更适合在确实需要以下能力时局部引入：

- 多 Provider 的标准化与 tracing；
- 成熟的 document loader/splitter/retriever；
- 结构化输出 adapter 能实际删除现有解析代码；
- 与既有观测平台集成。

如果引入，应该留在 Side Panel/外部 Effect 层，不能让 DOM、Chrome message 和安全边界依赖 LangChain 类型。

### 22.2 LangGraph

LangGraph 比 LangChain 更贴近 S2 的问题，因为项目确实有：

- 可恢复状态；
- 人在环中断；
- 条件分支；
- 外部 Effect；
- 页面变化后的循环规划。

但当前手写 reducer 已经解决了最关键的确定性和持久化问题。迁移只有在 LangGraph 能可靠替代 `machine.ts`、部分 `guide.ts` 和 checkpoint 协议，并在 MV3 生命周期中通过恢复测试时才值得。

建议的边界不是全量重写：

```text
Content / Extractor / Overlay / Security       保留
Chrome RPC 与 Effect claim                     保留
Provider adapter                               保留或局部换
Reducer + checkpoint orchestration             候选迁移到 LangGraph
```

先做一个小型 spike：只实现 `start -> callModel -> present -> interrupt -> resume -> replan`，并测试 Service Worker 被回收、Panel 关闭、结果重复投递、页面已变化四种情况。只有它比当前协议更简单且不削弱安全性质，才继续迁移。

## 23. 推荐的演进顺序

按照对效果和风险的比值，建议顺序是：

1. 建立任务级语义 eval：记录每轮候选 recall、选中目标、是否循环、最终成功；
2. 给 PromptTable 增加 goal-aware retrieval，先解决“正确元素根本没进入上下文”；
3. 把历史拆成近期原文 + 结构化摘要 + 已确认事实，限制重复 token；
4. 收窄 system prompt，把 schema、安全和状态一致性交给代码；
5. 补全 `done` 用户确认闭环；
6. 根据产品需要接通 `need_text` 或 `need_docs`，不要同时铺两条半成品路径；
7. 最后用 spike 数据决定是否采用 LangGraph。

这个顺序不会用一个未完成的大框架迁移替换当前可运行产品，也让每一步都能独立测量收益。

## 24. 推荐阅读顺序

第一次进入代码库，可以按以下顺序阅读：

1. [package.json](../package.json) 与 [tsconfig.json](../tsconfig.json)：确认真实依赖和编译约束；
2. [shared/protocol.ts](../src/shared/protocol.ts)：理解跨进程语言；
3. [background.ts](../src/entrypoints/background.ts)：看所有入口如何汇合；
4. [content.ts](../src/entrypoints/content.ts)：看页面能力和安全边界；
5. [extract.ts](../src/core/extractor/extract.ts) 与 [project.ts](../src/core/extractor/project.ts)：理解模型实际看到什么；
6. [thread.ts](../src/agent/thread/thread.ts) 与 [machine.ts](../src/agent/thread/machine.ts)：理解引导状态；
7. [guide.ts](../src/agent/thread/writer.ts) 与 [effects.ts](../src/entrypoints/sidepanel/effects.ts)：理解跨进程 Effect；
8. [system.ts](../src/agent/prompts/system.ts)、[user-message.ts](../src/agent/context/user-message.ts)、[contract.ts](../src/agent/envelope/contract.ts)、[validate.ts](../src/agent/envelope/validate.ts)：理解模型边界；
9. [tests/unit](../tests/unit)：用可执行例子反向确认理解。

## 25. 练习：从读懂到能修改

### 练习 1：追踪一次点击

从 Content Script 的用户事件开始，找出它如何变成 reducer 的一次输入（`step_used`、`page_changed` 或 `step_settle_timeout`），最终怎样更新 cursor。画出涉及的 message tag 和 storage key。

### 练习 2：构造 stale Effect

在 reducer/Effect 单测中：

1. 启动 Thread 并得到 effect A；
2. 让页面变化并产生 effect B；
3. 再投递 A 的结果；
4. 断言 Thread 没有被旧结果覆盖。

### 练习 3：测量候选召回

准备十个真实目标，为每个目标标注正确 DOM 元素。只运行 extract/project，统计正确元素进入 60、150、250 node 表的比例。这个数据可以直接验证 context 问题发生在模型之前还是模型之内。

### 练习 4：最小化 system prompt

保留相同 PromptTable 和模型，逐项把可由 validator 保证的规则从 prompt 移出，比较契约成功率、语义成功率和 token 数。不要只看 JSON parse 成功率。

## 26. 术语表

- **Host**：持有流程权威、把外部事实送进状态机的后台进程。
- **Thread**：一个 tab 中可恢复的 Guide 会话状态。
- **Snapshot**：一次页面抽取结果的版本边界。
- **Ref**：仅在一个 Snapshot 内有效的元素句柄。
- **Descriptor**：可跨 Snapshot 尝试重新绑定的语义描述。
- **PromptTable**：预算内、准备给模型看的交互元素投影。
- **Reducer**：从旧状态和输入计算新状态与 Effect 的纯函数。
- **Effect**：状态机决定需要发生、但必须由外部执行的动作。
- **Tombstone**：记录当前 inflight Effect 的持久化事实。
- **WorldAt**：Effect 发出时所对应的 Thread/Page 世界版本。
- **Skill**：人写的站点说明，按页面域名整段放进引导的 user 消息；第一个 Plugin，默认开。
- **Late binding**：Ref 失效后，以 descriptor 在新页面快照中重新寻找目标。
- **QA**：一次性页面问答，不创建 Guide Thread。

## 27. 总结

这个项目用 TypeScript 构建 Agent 组件的核心方法，不是堆很多 class，而是把不确定性放在明确边界上：

- 用 branded type 区分临时元素引用和普通字符串；
- 用 discriminated union 定义状态机、模型契约和 RPC 语言；
- 用纯 reducer 集中流程判断；
- 用 port interface 隔离 Chrome 与网络；
- 用持久化 Effect 协议对抗 Service Worker 回收、重复消息和过期结果；
- 用运行时 parser/validator 防止模型输出越过类型边界；
- 用封闭 RPC 和多层安全检查保证它始终是 Guide，而不是 Executor。

当前效果问题不应简单归因于“context 太小”或“prompt 不够强”。更准确的诊断是：目标无关的候选投影可能先丢失关键信息，完整历史又持续稀释注意力，而结构校验只能保证输出合法，不能保证语义正确。

因此，最有价值的下一步是先建立任务级证据，再改善 goal-aware retrieval 和历史压缩；框架迁移应服务于统一状态与恢复协议，而不是成为另一个需要维护的抽象层。
