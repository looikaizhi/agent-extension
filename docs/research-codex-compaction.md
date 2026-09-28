# Codex / Responses API compaction：机制、客户端责任与 Page Guide 适配判断

> 调研日期：2026-09-22。OpenAI 产品事实只采用 OpenAI 官方文档；浏览器配额采用 Chrome 官方文档；项目判断来自当前仓库源码。文中「**官方事实**」表示来源直接陈述，「**项目事实**」表示源码直接体现，「**判断**」表示基于两者作出的工程推论。

## 1. 结论先行

1. **Codex 的 compaction 不是在浏览器里运行的“压缩算法”。** Codex/App Server 负责压缩模型可见的会话历史；客户端只负责触发、接收生命周期事件，以及继续保存正确的线程或 Responses 状态。Responses API 返回的 compaction item 是加密且不透明的，不供 UI 或人解释。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
2. **正确接入时，它对浏览器 CPU 不是严重负担。** 计算发生在 OpenAI/Codex 侧；浏览器增加的是一次事件处理和少量状态管理。真正可能变大的，是独立 `/responses/compact` 前的整窗上传、客户端保留的 item 数组，以及一次压缩 pass 带来的网络延迟和 token 用量。服务端压缩配合 `previous_response_id` 时，客户端每轮只发送新输入，浏览器负担最小。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
3. **对当前 Page Guide，不建议现在加入 Codex 式 compaction。** 当前模型通道是 OpenAI-compatible `POST /chat/completions`，不是 Responses API；每次重规划本来就是重建出的 system + user 上下文，而非不断追加的完整 Responses item 链（`src/agent/provider/provider.ts:358-425`、`src/agent/context/user-message.ts:58-77`）。迁移到 Responses/App Server 的工程量会明显大于压缩本身。
4. **当前模型上下文已经有硬边界。** 一趟引导最多 12 步、每步最多 4 次调用（`src/agent/thread/transitions.ts:24-34`）；跨运行对话只带最近 3 个 user turn、每行最多 300 字符（`src/entrypoints/background.ts:311-318`、`src/agent/conversation/entries.ts:101-115`）；元素表按窗口上限最多 120/400/800 项（`src/core/extractor/project.ts:25-47`）。因此仓库文档里“完整 Guide history 会增长”的问题是**有上界的重复成本**，不是 Codex 那类可能跑过多个 context window 的无界轨迹。
5. **浏览器里更现实的增长点是“展示历史”，不是“模型历史”。** Side Panel 的 Conversation 按 tab 存在 `chrome.storage.session`，UI 历史与模型输入是两套数据；写满后当前实现会依次尝试保留全部、后一半、最后 10 条（`src/host/conversation-store.ts:5-18,53-90`）。Chrome 官方给 `storage.session` 的总内存配额是 10 MB，且这是扩展共享配额，不是每个 tab 10 MB。[Chrome `storage.session`](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session)

**总判断：** compaction 本身不会“拖垮整个浏览器”；若采用 OpenAI 服务端方案，它主要增加云端计算和偶发等待。但在这个项目里，**为了获得 compaction 而迁移协议会是严重的架构负担，收益却暂时很小**。目前应先量化 prompt 与 session storage；若以后出现真正无界的长任务，再在 OpenAI Responses 专用通道上启用服务端 compaction。

---

## 2. Codex 自身怎样触发 compaction

### 2.1 手动触发

- **CLI / UI 命令。** `/compact` 会总结当前可见聊天，用简洁摘要替换较早 turn，从而释放 context；官方建议长时间运行后使用。[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#keep-transcripts-lean-with-compact)
- **App Server RPC。** `thread/compact/start` 以 `{ threadId }` 手动触发线程历史压缩；RPC 立即返回 `{}`，实际进度继续走同一 `threadId` 上的标准 `turn/*` 与 `item/*` 通知。[Codex App Server — Trigger thread compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)

### 2.2 自动触发

- Codex 配置项 `model_auto_compact_token_limit` 是自动历史压缩的 token 阈值；未设置时采用模型默认值。[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#model_auto_compact_token_limit)
- `model_auto_compact_token_limit_scope` 决定阈值统计完整活动上下文（`total`，默认）还是只统计 compaction 保留前缀之后的新增部分（`body_after_prefix`）。[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#model_auto_compact_token_limit_scope)
- Codex hooks 的 `PreCompact` / `PostCompact` 明确把 trigger 分为 `manual` 与 `auto`，因此自动和手动不是 UI 推测，而是运行时可观测的两类来源。[Codex hooks](https://learn.chatgpt.com/docs/hooks#precompact)

### 2.3 App Server 事件语义

- 压缩在 item 层表示为 `contextCompaction: { id }`；它和其他 item 一样先发 `item/started`，再发 `item/completed`。`item/completed` 的最终 item 应被视为权威状态。[Codex App Server — Items](https://learn.chatgpt.com/docs/app-server#items)
- 旧的 `thread/compacted` notification 已废弃，客户端应消费 `contextCompaction` item。[Codex App Server — Items](https://learn.chatgpt.com/docs/app-server#items)
- 对一个浏览器 UI，最小实现只需把 `contextCompaction` 当作普通的非文本活动项：started 时显示“正在整理上下文”，completed 时结束状态。没有 delta 文本需要拼接，也不需要在浏览器里生成摘要。这个结论是对上述事件契约的**实现判断**。

### 2.4 App Server 客户端不必把所有历史常驻浏览器内存

- `thread/read` 默认只读线程摘要，只有 `includeTurns: true` 才返回 turns；它不会 resume 线程或订阅事件。[Codex App Server — Read a stored thread](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
- `thread/turns/list` 支持 cursor 分页，且 `itemsView` 可以选择 `notLoaded`、`summary` 或 `full`；`thread/items/list` 也支持分页读取持久化 item。[Codex App Server — List thread turns](https://learn.chatgpt.com/docs/app-server#list-thread-turns)
- **判断：** 若使用 App Server，浏览器可以只缓存当前可见页和活动 turn；历史由 App Server 保存并按需分页。这样 compaction 不会迫使 React 树或浏览器内存持有完整 transcript。

---

## 3. Responses API 的两种 compaction

### 3.1 服务端 compaction（随 `/responses` 自动发生）

在 `POST /responses` / `client.responses.create` 里设置：

```json
{
  "context_management": [
    { "type": "compaction", "compact_threshold": 200000 }
  ]
}
```

**官方事实：** 渲染后的 token 数跨过阈值时，服务端在当前 response 内执行压缩，不需要单独调用 `/responses/compact`；同一 response stream 会包含加密 compaction item，服务端在继续推理前先裁掉旧上下文。[OpenAI Compaction guide — Server-side compaction](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction)

客户端有两种续接方式：

1. **`previous_response_id` 链。** 每轮只发送新的 user message 和最新 response id；不要手动裁剪 item。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction)
2. **无状态 input-array 链。** 把 response output（包括 compaction item）追加到下一次 input；收到新的 compaction item 后，可以删除它之前的 items，缩小请求并降低长尾延迟。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction)

### 3.2 独立 `/responses/compact`

**官方事实：** 这是一个完全无状态、兼容 ZDR 的显式 endpoint。客户端把完整 context window（messages、tools 和其他 items）发给它；输入本身仍必须先装得进模型 context window。[OpenAI Compaction guide — Standalone compact endpoint](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint)

返回值是一个新的 compacted context window，而不是用于续接的普通 response id。它通常不只包含 compaction item，也可能保留旧窗口中的若干 items；整个返回窗口是下一轮的 canonical input，**客户端不得再自行裁掉其中的内容**。[OpenAI Compaction guide — Standalone compact endpoint](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint)

API reference 还明确返回 `usage`，含本次 compaction pass 的 cached、reasoning 和 total token 统计；`output` 则是 compact 后的 item 列表。[Responses API — Compact conversation](https://developers.openai.com/api/reference/resources/responses/methods/compact)

### 3.3 三种客户端状态责任

| 模式 | 客户端下一轮必须保存/发送 | 可以删除什么 | 浏览器侧特点 |
|---|---|---|---|
| Responses + `previous_response_id` | 最新 response id + 新输入 | 不手动裁剪服务端链；UI transcript 另存 | 最小网络与内存状态，但依赖服务端 conversation chain |
| Responses + 无状态数组 + server-side compaction | 最新 compaction item 及它之后的 items | 可以删最新 compaction item 之前的 items | 浏览器仍维护 item 数组，但压缩后会缩小 |
| 独立 `/responses/compact` | **完整保存并原样传回** `compacted.output`，再追加新输入 | 不得裁剪 endpoint 返回窗口 | 最可控/ZDR，但触发时必须上传整个旧窗口，且要管理 canonical window |

表中规则均来自 [OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction)；“UI transcript 另存”是工程判断，因为加密 compaction item 不可供人阅读，而产品仍需展示旧聊天。

---

## 4. 负担到底落在哪里

| 维度 | 负担位置 | 结论 |
|---|---|---|
| 压缩计算 / CPU | OpenAI/Codex 服务端 | 浏览器不总结、不做 embedding、不跑模型；本地只收发 JSON 和事件。对浏览器 CPU 通常很轻。 |
| 触发时延 | 服务端推理路径 | Server-side 模式在同一个 response stream 内先压缩再继续推理；standalone 模式额外多一次完整请求。官方明确 compaction 旨在平衡质量、成本和延迟，并建议裁掉旧 items 以降低后续长尾延迟；因此“触发轮会有一次尖峰、后续轮可能更快”是合理判断，但官方没有给固定毫秒数。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction) |
| Token / 金钱 | 发起 compaction 的 API pass，以及后续较小 prompt 带来的节省 | `/responses/compact` 返回本 pass 的 usage，说明它有可计量 token 消耗；是否回本取决于压缩后还会继续多少轮。官方未给统一 break-even，不能宣称“总是更便宜”。[Responses compact API](https://developers.openai.com/api/reference/resources/responses/methods/compact) |
| 网络 | 客户端到服务端 | `previous_response_id` 最轻；无状态数组在首次触发前会重复上传增长中的 item；standalone 触发时上传整个仍可装入窗口的上下文。压缩之后的 canonical window 更小。 |
| 浏览器内存 | 客户端是否保留完整模型 item 数组、是否把完整 transcript 全量渲染 | compaction 只能缩模型上下文，不会自动替产品清理可见聊天。UI transcript 应独立分页/虚拟化/限额；不要尝试从 opaque item 重建可见历史。 |
| 持久化 | App Server 或扩展自己的 storage | App Server 可保存并分页 thread；当前 Page Guide 使用扩展共享的 10 MB `storage.session`。这是两个完全不同的持久化责任。[Codex App Server](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming) · [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session) |

**判断：** 对浏览器真正危险的不是“有一个 compaction item”，而是错误实现——例如在 standalone 模式下永久同时保留“完整旧窗口 + compacted window + UI transcript”，或每次 render 都把所有历史节点挂进 DOM。正确实现可以把模型窗口、可见 transcript、App Server/thread id 三者分开。

---

## 5. 与当前 Page Guide 的具体对照

### 5.1 当前架构没有可直接 compact 的 Responses item 链

- **项目事实：** Provider 只有 `ChatMessage { role, content, tool_calls, tool_call_id }`，实际请求是 `${base}/chat/completions` 的 SSE stream（`src/agent/provider/provider.ts:35-57,358-425`）。
- **项目事实：** 每次 Guide 调用重新构造消息；历史被渲染成一段结构化中文文本放进 user message，而不是保留原始 assistant/tool item 链（`src/agent/context/user-message.ts:58-77,143-158,200-224`）。
- **项目事实：** 一步内部发生 tool round 时才临时回放 assistant tool call + tool result；一步结束后 `turn` 会关闭（`src/agent/thread/transitions.ts:329-355`）。

**判断：** OpenAI 的 opaque compaction item 不能直接塞进当前 `ChatMessage` 模型。要用它，至少要新增 Responses wire parser、output-item union、stream events、tool item 回放、canonical window 持久化与 provider capability 分流。这不是一个“小功能开关”。

### 5.2 当前 prompt 增长已被多层限制

- Guide 历史最多 12 个已花费步骤；单步最多 4 个模型调用（`src/agent/thread/transitions.ts:24-34,320-346`）。
- 跨 run 的自然对话仅带最近 3 个 user turn，并把每条文本截到 300 字符（`src/entrypoints/background.ts:311-318`、`src/agent/conversation/entries.ts:101-115`）。
- 每轮最大块通常是当前页 Element table；其 node cap 是 120/400/800，而不是无限增长（`src/core/extractor/project.ts:25-47`）。
- Debug trace 关闭时不上传/持久化；打开时最多 24 entries（`src/agent/agents/guide/trace.ts:25-44`）。

现有稳定性评测也支持这个判断。对 `evals/task/runs/t13-guide-stability-smoke/raw/log.ndjson` 的 95 次模型调用统计：平均 prompt 为 6,885 tokens，P95 为 11,633，最大为 13,115；显著低于项目默认的 32k context window。最大请求的参数 JSON 为 72,655 bytes，其中最新页面 Element table 占 71,299 bytes，而 Guide history 只有 630 bytes。也就是说，这个样本里最大的请求约 98% 来自**当前页面快照**，并不是可被历史 compaction 回收的旧对话。

**判断：** 当前最值得优化的仍是每轮 Element table 的信息质量和重复成本，而不是给 12 条以内的 history 再做一次有损模型摘要。仓库现有 `docs/agent-system-tutorial.md` §21.1 所说“先测量 system/history/table/output token 占比”依然是正确前置条件。

### 5.3 还要守住不可信内容边界

- 当前实现把页面表格与重新读取的文档正文放进带随机 nonce 的 `<untrusted_page_content>` 包装，明确将它们视为唯一的不可信输入（`src/agent/context/user-message.ts:10-55,193-224,296-322`）。
- **判断：** 若以后做本地/模型生成的摘要，不能把页面文本或工具读取结果摘要成普通的“可信历史”，否则可能把页面中的提示注入内容洗白后跨轮保留。最小安全方案应只压缩扩展自己产生的结构化状态；原始页面内容继续留在 nonce 包装中，或直接由新快照替代。

### 5.4 当前浏览器存储问题与模型 compaction 是两件事

- Conversation 为每个 tab 单独保存在 `storage.session`，对话会跨 run 留存，但模型只读取其中被 `recentTalk()` 选出的很小一段（`src/host/conversation-store.ts:5-27`、`src/agent/conversation/entries.ts:84-115`）。
- 存储满时，当前代码已降级为保留后一半或最后 10 条，并显示 dropped 计数，而不是让模型 context 无界增长（`src/host/conversation-store.ts:53-90`）。
- Chrome `storage.session` 的 10 MB 是整个扩展的共享内存配额；当前同一配额还容纳 thread 的 element tables 和可选 traces。[Chrome `storage.session`](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session)

**判断：** 如果将来用户感到 Side Panel 越聊越卡，优先解的是 UI 列表虚拟化和主动 retention；调用 LLM 做 compaction 既不能替代可见历史，也会引入成本和事实丢失风险。

---

## 6. 建议的最小方案

### 现在：不实现模型 compaction，只补测量

建议先记录四个已经能从现有边界拿到的量：

1. 每次调用的 `prompt`、`cachedPrompt`，以及 system / element table / guide history / recent talk 各自估算 token；
2. 每个 tab 的 Conversation entry 数、序列化字节数，以及整个 `storage.session.getBytesInUse(null)`；
3. Side Panel entry 数与一次 render 的耗时；
4. 引导长度分布：真实运行有多少到 8、10、12 步。

只有数据证明 history 而不是 Element table 成为主要 prompt 成本，或产品取消 12 步上限、开始支持跨多个 context window 的长任务时，才需要模型 compaction。

### 将来确实需要时：只在 OpenAI Responses 专用路径启用服务端 compaction

最小可行形状：

1. 为 OpenAI Responses 增加独立 provider 路径，不改变现有兼容端点的 `/chat/completions` 合约；
2. 优先使用 `previous_response_id` + `context_management.compact_threshold`，避免浏览器保存/重传整条 Responses item 链；
3. 可见 Conversation 继续由现有 host store 管理，绝不拿 opaque compaction item 当 UI 摘要；
4. UI 只消费 `contextCompaction`/compaction output 的状态，显示一次非阻塞的“正在整理上下文”；
5. 评测必须覆盖：完成过的步骤、当前假设、目标 URL、工具结果、未解决 blocker 是否在压缩后仍被模型正确使用。

不建议为了 compaction 单独引入 App Server。App Server 是完整的 thread/turn/item runtime，含连接握手、线程持久化、订阅、工具请求与审批；如果产品未来决定整体采用 Codex runtime，它的自动/手动 compaction 会自然随之获得，但它不是当前轻量 BYOK 浏览器扩展的局部替换件。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

也不建议首选 standalone `/responses/compact`：它最适合需要显式、无状态、ZDR 控制的长工作流，但会让浏览器负责收集完整窗口、额外上传一次、保存并原样回放 canonical compacted window。对本项目，这比 server-side + response id 更重。[OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint)

---

## 7. 一手来源

- OpenAI, [Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- OpenAI, [Responses API: Compact a response](https://developers.openai.com/api/reference/resources/responses/methods/compact)
- OpenAI, [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- OpenAI, [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- OpenAI, [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- Chrome for Developers, [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage)
