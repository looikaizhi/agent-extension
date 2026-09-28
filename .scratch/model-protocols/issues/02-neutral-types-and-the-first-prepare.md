# 02 — 中立类型与第一个 `prepare`

**What to build:**

立起「协议」这个概念，并让 `openai-chat` 成为第一个说得出自己形状的协议——**但只做请求这一半**。

三件事：

1. **中立类型**。`ModelRequest` / `ModelDelta` / `ToolSpec` / `Capability` / `warnings`。形状照抄 Vercel AI SDK 踩过的坑：content-parts 数组（不是 `content: string | null`）、namespaced `providerOptions`、`warnings` 数组。**零新依赖。**
   - **给 reasoning part 留出位置**，哪怕 `openai-chat` 永远不填。Responses 要求模型上一轮的 reasoning 块随工具结果原样回传，等到 07 才发现就得回头改这一票。

2. **协议的运行时住处**。它是 `ProviderConfig` 上的一个字段，不从 preset 派生（`custom` 预设与本地端点都要选得了；而且同一个 `api.openai.com/v1` 将来要同时服务两个协议）。旧存档靠默认值兜住，落到 `openai-chat`。连带改侧栏的预设选择器，以及评测的 provider 配置——**后者只加这一个字段，其余一律不动**。

3. **`openai-chat` 的 `prepare`**。纯函数：`ModelRequest` 进，`{ path, headers, body }` 出。
   - **`headers` 里不含鉴权。** 适配器只声明自己要 `bearer` 还是 `x-api-key`，由 `transport` 贴头。密钥不进适配器——「API Key 只有一个去处」是拒绝第三方 SDK 的第一条理由，不能在自己这边把持有者从 1 个变成 1+N 个。
   - **`body` 是适配器自己 `JSON.stringify` 完的字符串**，不是结构化对象。请求体白名单的静态检测器靠 AST 找字面量，交给 `transport` 去 stringify 它就看不见了。

运行循环这一票**还不切换**，它仍然走老路。新旧两条路径同时活着——这正是下面那条证明唯一可能的时刻。

**这一票的核心交付是一条证明：** 同一份配置与上下文下，老路径交给 `fetch` 的请求体字符串，与 `prepare()` 产出的请求体字符串**全等**。

这要求 `JSON.stringify` 的**键序完全一致**。今天是：`model, messages, stream, stream_options, temperature, …preset 展开, tools, tool_choice, parallel_tool_calls`。键序是「字节一个不变」唯一真正的约束——一个字段顺手挪个位置，语义毫无变化，而字节全变。

**不要断言「delta 序列逐项相同」**：Decision 语料里一个字节的 SSE 响应都没有，而且原则上也做不到——今天一个扁平 delta 能同时带文字和工具片，判别联合下必然拆成两个事件，要比就得先写一个翻译器，而翻译器本身就是被测对象。

**Blocked by:** 01

**Status:** done — 2026-09-24（提交留给用户）

- [x] 中立类型五样齐备，含 reasoning part 的位置；无任何新增运行时依赖
- [x] 协议是配置上的字段，旧存档读进来落到 `openai-chat`；`custom` 预设选得了协议
- [x] `prepare` 是纯函数：不 `fetch`、不计时、不读环境
- [x] 架构守卫新增并绿：适配器目录下不得出现 `fetch`、`apiKey`、`Authorization`、`x-api-key`
- [x] 请求体白名单改成一协议一张，静态检测器仍抓得到 preset 字段的展开，`PRESET_FIELDS` 的一手文档纪律原样保留
- [x] **请求体全等证明通过**，键序作为显式断言的一部分
- [x] 证明的广度覆盖 Decision 语料的全部状态；深度仍由模型输入快照提供，两者都在
- [x] 老路径一行未动，模型输入快照逐字节不变
- [x] 类型检查、单测（1064）、e2e（284/284）全绿；抽取器评测的 L-1 / L-3 两条门槛仍未达——先于 01 就已如此，与本票无关
