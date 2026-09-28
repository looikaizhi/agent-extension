# 07 — 第二个协议：OpenAI Responses

**What to build:**

用户可以用 OpenAI 新一代模型（`gpt-6-astra` 一类）跑完一趟真实引导。

**这一票是整条缝唯一的验收。** 只有一个住户的缝一定是合身的——第二个协议是唯一能验出中立类型漏在哪的东西。凡是在这里发现「中立类型表达不出来」的，回头改类型，不要在适配器里打补丁。

**Responses 与 Chat Completions 的差别，逐条**（一手文档，2026-09-23）：

- **tools 是扁平的**：`{type:"function", name, description, parameters, strict}`，**不嵌在 `function` 下**。这是最容易踩的一条。
- 输入项：`{type:"function_call", call_id, name, arguments}` / `{type:"function_call_output", call_id, output}`
- 配对靠 **`call_id`**，不是 `tool_call_id`
- `tool_choice` 支持 `"auto"` / `"required"` / `{type:"function",name}` / `{type:"allowed_tools",…}`
- **reasoning item 必须随工具结果回传**——这是 02 为什么要给 reasoning part 留位置的原因
- 流式事件名不同：`response.output_item.added`（**明确的工具调用开始**，不用再猜）、`response.function_call_arguments.delta`（`delta` 是原始 JSON 文本，provenance 保得住）、`response.completed`

**字节边界那一类 fixture 一条都不用写**——`transport` 已经一次性覆盖了。只需要内容那一列。这正是 01 那么切的收益，在这里第一次兑现。

一协议一张请求体白名单，在这里第一次被真正行使：Responses 的白名单和 Chat 的不同，静态守卫要能分别检查。

**Blocked by:** 05

**Status:** done — 2026-09-25（真机已跑通，用户确认；提交留给用户）

- [ ] **真机一趟没跑**——要 OpenAI Key，留给仓库主人。设置页的「协议」下拉里现在能选到 OpenAI Responses；preset 改成 gpt-6 是 08 的事，现在手填模型名即可
- [x] provenance 在这个协议上通过：`tool-input-delta` 的 `raw` 与 `delta` 同源（逐条断言），整条链上真跑一遍运行循环、解析成功即是扫描通过
- [x] reasoning item 随工具结果正确回传，多轮工具对话不报错
- [x] 修复轮在这个协议上走得通，靠 `call_id` 配对
- [x] Responses 自己的请求体白名单已立，静态守卫分协议检查并绿
- [x] 只写了内容那一列的 fixture，字节边界那一列一条没写
- [x] **改了类型，没在适配器里打补丁**：`ModelDelta` 新增 `reasoning` 事件。为什么——Responses 要求把它自己发的 reasoning item 随工具结果原样回传，而判别联合里原来没有任何一种事件说得出「模型推理了一段」。第二个协议要的第一样东西就是缝里缺的那一样，这正是这张票存在的理由。回传的是端点自己的 item（装在 `providerOptions` 里原样带着），不是照摘要重建一个——那等于凭空造一个续传凭证
- [x] 类型检查、单测（1092）全绿；e2e 与抽取器评测见下
- [x] 那个 reasoning item 的来回要穿过 6 层，全部照 `callId` 已有的那条路走：运行循环 → `RunResult` → `EffectOutcome` → 归约器 → `ToolCall` → `buildMessages`。宿主一个字节都不读它
- [ ] ⚠️ **`temperature` 没法验**：Responses 的参数表里有它，但 gpt-6 这类推理机型收不收，我这边核不到一手文档。现在照发；真机那一趟如果 400 在这个字段上，改适配器一行即可
