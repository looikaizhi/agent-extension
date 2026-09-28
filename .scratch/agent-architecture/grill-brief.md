# 拷问材料：Agent 目录架构优化

拷问对象：这个产品真正的模块边界画在哪。
用户的痛点：读不懂整个 agent 架构，想要「积木感」——每个模块职责清楚、加新能力时不用改别处。
用户最初提出的目录分类：agents、tools、skills、workflows、prompts、context、memory、tests、evals。

## 已定的事实（2026-09-11 核实，不必再查）

**前置工作已完成**：S1 退场（`.scratch/s1-retirement/`，十二张票）已落地并验证。
- 一个 Thread 所有者、一个终结流程、Fixed plan；Pack 只剩站点知识。
- 决策记录目录已删，`CONTEXT.md` 是唯一事实源。
- 架构守卫已迁到 TypeScript 编译器 AST（`tests/unit/fixtures/source-scan.ts`）。
- 单测 1607、e2e 183/183 连跑三遍、离线评测全绿。

**今天量到的数**：
- 一个工具的名字散在几个源文件里：need_docs 6、done 7、guide 7、clarify 9。
  涉及 `guide/agent.ts`（schema）、`plan/contract.ts`（解析）、`plan/validate.ts`（校验）、`host/machine.ts`（后果）、`plan/prompt.ts`（描述）、`guide/trace.ts`、`entrypoints/background.ts`、`sidepanel/App.tsx`、`sidepanel/qa.ts`。
- 三组取值被声明了两遍，声明它们的模块彼此不 import：
  - 动作枚举：`guide/agent.ts:183` ⇄ `plan/validate.ts:39 USER_ACTIONS`
  - 完成依据：`guide/agent.ts:244` ⇄ `plan/contract.ts:65 DONE_EVIDENCE`
  - 上一步结果：`guide/agent.ts:136` ⇄ `plan/contract.ts:118 GUIDE_PREVIOUS_STEP`
- 最大文件：machine.ts 1153（S1 退场后涨了，固定计划加进来）、background.ts 953、App.tsx 924、content.ts 651、provider.ts 630、contract.ts 603、protocol.ts 527、project.ts 515、prompt.ts 477、guide.ts 471。
- 当前目录按「运行进程 + 技术层」切，不按 agent 概念切：
  `src/agent/{guide,host,plan,ground}`、`src/agent/{provider,budget}.ts`、`src/core/{extractor,overlay,locator,packs,security}`、`src/entrypoints/{background,content,sidepanel}`、`src/shared`。

**之前的体检与判断（2026-09-10 架构报告，C1–C8）**：
- C1（首推）：给 Intent 一个模块。一个 Intent 横跨 8 个模块，另有三组重复枚举。
- C3：真正该拆出去的是 `copy/`（用户读到的每一句话）与 `authorization/`（这个链接能不能抓），用户的清单里没有这两个词。
- 对九个目录的判断是「采三拒四」：
  - 采：`tools/`（即 C1）；`prompts/`（重点是把「策略」与「拼装」分开）；`evals/`（缺决策评测，是最大缺口）。
  - 可议：`context/`（元素表 / 历史 / 站点知识三处，可能与 prompts 是一件事）。
  - 拒：`agents/`（只有一个 agent）；`skills/`（没有指称对象）；`workflows/`（多步流程由纯归约器承担，另起一个会造出第二个状态机）；`memory/`（没有跨会话记忆，thread 是单次运行状态）。
- 外部审核补充：先收敛契约里重复的枚举，不要机械地「一种 Intent 一个文件」。`tools/` 值得要的是枚举与 discriminated union 有唯一所有者，不是八个文件夹。
- 这是一次宽重构（import 的爆炸半径覆盖全仓），拆票时要走 expand–contract。

## 硬约束（CONTEXT.md 记着，不能被重构推翻）

- 模型调用在 Panel 执行：service worker 里 fetch 超过 30 秒，worker 会被杀。
- 归约器是纯的（零 await / fetch / chrome.*），storage.session 只有 Host 写。单写者是 `host/guide.ts`，AST 守卫守着调用点。
- Provenance 扫描器（`plan/scanner.ts`）是独立重写的第二实现，与解析器零函数共享。
- 元素表用 nonce 包裹（S-01）。
- CLAUDE.md：不保留向后兼容（直接删过时路径）、最简实现、分层演进、不做投机抽象、模块化且职责清晰、不得自行执行任何 git 操作。

## 要拷问到底的（起点，不是全部）

1. 「工具」要不要成为一个模块，边界画在哪？schema / 解析 / 校验 / 后果 / 提示词描述 / 面板渲染，哪几样进去？后果（machine.ts）进不进，会不会撞上纯归约器与单写者？
2. 「策略」（模型该怎么决定）与「拼装」（消息怎么组）分不分家？这关系到决策评测能不能挂上去。
3. 被拒掉的四个词（agents / skills / workflows / memory）：现在就拒并记进 CONTEXT.md，还是留一句「等出现 X 再引入」？
4. 目录的物理位置要不要动？之前一次拷问的结论是「目录位置不是诉求，一处能看到全部才是」；这次用户明确说的是「目录架构优化」，需要重新问定。
5. machine.ts 1153 行里同时住着归约、配额、打转兜底、跨站策略、固定计划、历史记账：要不要拆，按什么拆？

事实是我的活，决定是用户的。
