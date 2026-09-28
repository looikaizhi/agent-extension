# 主流 LLM 消息格式调研

调研日期：2026-09-23

## 结论

不存在一个被所有 LLM 原生采用的统一消息线格式。主流实现可以归入四个家族：

1. **Role-message**：`messages[]`，每条消息有 `role` 与 `content`。
2. **Content-block**：仍按消息组织，但 `content`/`parts` 是有类型的块，工具调用和工具结果也是块。
3. **Typed-item**：消息只是上下文条目的一种；工具调用、工具结果、推理状态和 compaction 都是独立 item。
4. **Token-template**：应用先提供结构化消息，再用模型专属模板渲染为一条带特殊 token 的序列。

各家高度共享的是语义原语，不是 JSON 字段名。跨厂商系统应保存规范化语义，再由 provider adapter 转换为厂商格式。

## 一、API / runtime 线格式

| 格式或平台 | 外层结构 | 指令 | 普通对话 | 工具循环 | 推理/压缩状态 | 家族 |
|---|---|---|---|---|---|---|
| OpenAI Chat Completions | `messages[]` | `developer` / `system` message | `user`、`assistant`，`content` 可为字符串或内容块 | assistant 的 `tool_calls[]`；独立 `tool` message 用 `tool_call_id` 回填 | 部分模型/兼容商增加非标准推理字段；没有通用 compaction item | Role-message |
| OpenAI Responses / Codex | `input[]`、`output[]` typed Items；也可用 `previous_response_id` | 顶层 `instructions` 或 `system` / `developer` message item | `message` item，内部含 typed content | 独立 `function_call` 与 `function_call_output` item，以 `call_id` 关联 | 独立 `reasoning`、`compaction` item；compaction 可为不透明加密状态 | Typed-item |
| Anthropic Messages / Claude | 顶层 `system` + `messages[]` | 顶层 `system`；输入消息没有 `system` role | 消息 role 主要为 `user` / `assistant`，`content[]` 为 blocks | assistant 的 `tool_use` block；结果是下一条 `user` message 内的 `tool_result` block | `thinking` / `redacted_thinking` block；必须按规则原样回传 | Content-block |
| Google Gemini GenerateContent | `systemInstruction` + `contents[]` | 顶层 `systemInstruction` | role 为 `user` / `model`；消息正文为 `parts[]` | model part 中的 `functionCall`；user part 中的 `functionResponse` | part 可带不透明 `thoughtSignature`，特定多步工具调用必须原样回传 | Content-block |
| AWS Bedrock Converse | `system[]` + `messages[]` | 独立 `system` content blocks | role 为 `user` / `assistant`；`content[]` 是 `ContentBlock` union | assistant `toolUse` block；user `toolResult` block，以 `toolUseId` 关联 | 可含 `reasoningContent`；具体支持取决于底层模型 | Content-block / gateway |
| Cohere Chat v2 | `messages[]` | `system` message | `user` / `assistant`，正文通常为 typed content | assistant 的 `tool_plan` + `tool_calls`；独立 `tool` message 通过 `tool_call_id` 返回结果 | `tool_plan` 是 Cohere 特有的计划字段；工具结果可用 document blocks 并生成引用 | Role-message + blocks |
| Mistral Chat | `messages[]` | `system` message | `user` / `assistant` | assistant `tool_calls[]`；`tool` message 带 `tool_call_id`、`name`、`content` | 推理能力依模型/API 版本，基本工具线格式接近 OpenAI Chat | Role-message |
| DeepSeek Chat | OpenAI-compatible `messages[]` | `system` message | `user` / `assistant` | OpenAI 风格 `tool_calls` / `tool_call_id` | 常见扩展为 assistant `reasoning_content`；保留推理时必须遵守模型规则 | Role-message + vendor extensions |
| Qwen / DashScope | OpenAI-compatible `messages[]`；另有 Responses 兼容接口 | `system` message | `user` / `assistant` | OpenAI 风格工具调用与工具结果 | `reasoning_content`、`enable_thinking`、`preserve_thinking` 等为模型/平台扩展 | Role-message 或 Typed-item compatibility |
| Kimi、GLM、MiniMax 等兼容端点 | 多数暴露 OpenAI-compatible Chat schema | 通常为 `system` | 通常为 `user` / `assistant` | 通常为 `tool_calls` / `tool_call_id` | 常增加 thinking、搜索、缓存等非 OpenAI 标准字段；须按端点能力判断 | Role-message compatibility |
| xAI、Groq、OpenRouter、Together、Fireworks 等 | 通常提供 OpenAI-compatible Chat/Responses facade | 跟随所兼容端点 | 跟随所兼容端点 | 表面字段接近 OpenAI | 路由、推理、引用、内置工具等扩展并不完全可互换 | Gateway / compatibility |
| Ollama native chat | `messages[]` + `tools[]` | 由消息/模型模板处理 | 每条消息有 `role` / `content`，可带图像 | assistant message 可含 `tool_calls`；结果格式受本地模型模板影响 | assistant message 可含 `thinking`；`think` 控制项由模型决定 | Role-message + local runtime |

“OpenAI-compatible”只表示主要请求/响应轮廓兼容，不表示角色集合、推理状态、流式事件、工具约束、图片格式或错误语义完全相同。

## 二、模型 prompt / 训练数据格式

| 格式 | 基本结构 | 重点 |
|---|---|---|
| Hugging Face chat template | 应用传 `[{role, content, ...}]`，Jinja `chat_template` 将其渲染成 tokens | 逻辑消息可以统一，但特殊 token、空白、工具编码必须匹配模型训练格式 |
| OpenAI Harmony（gpt-oss） | 消息有 `system/developer/user/assistant/tool` role；assistant 还带 `analysis/commentary/final` channel、recipient 和控制 token | 是接近 Responses 语义的模型级序列格式，不等于普通 Chat Completions JSON |
| Meta Llama 3.x/4 prompt format | `system/user/assistant/tool` 语义被渲染为 `<|start_header_id|>`、`<|eot_id|>` 等特殊 token；工具调用另有约定 | 版本之间工具格式可变化，不能把某版模板视作通用协议 |
| ChatML | 典型形式为 `<|im_start|>{role}\n...<|im_end|>` | 影响了许多开源模型与 Qwen 类模板，但具体 token 和 role 支持仍不同 |
| Llama 2 `[INST]` | `[INST] <<SYS>>...<</SYS>> user [/INST] assistant` | 偏文本模板，工具和 typed blocks 不是一等公民 |
| ShareGPT / Vicuna | 常见训练数据为 `conversations[]`，条目用 `from` / `value`；渲染后常为 `USER:` / `ASSISTANT:` | 是数据集/训练格式，不应直接作为生产 API 领域模型 |
| Alpaca | `instruction`、可选 `input`、`output`，渲染为 `### Instruction` / `### Response` | 主要是单轮指令微调格式，不足以表达现代 agent 工具轨迹 |
| ChatGLM / OpenAssistant / Dolly 等旧模板 | 以各自 role 标签和分隔符串接 | 都属于模型专属序列化模板；今天通常由 tokenizer/chat template 层封装 |

## 三、真正共同的基本结构

几乎所有现代 agent 协议都可以还原为以下语义：

1. **Instruction**：系统/开发者指令及其权限层级。
2. **Message**：用户输入与助手可见输出。
3. **Content block**：文本、图像、音频、文件、引用等模态块。
4. **Tool definition**：工具名、说明、参数 JSON Schema 与执行策略。
5. **Tool call**：稳定 ID、工具名、参数、可选状态。
6. **Tool result**：对应 call ID、结果内容、成功/错误状态。
7. **Reasoning state**：可见摘要或不透明签名/加密状态；不是所有平台都提供。
8. **Continuation state**：完整历史、response/conversation ID，或需要回传的不透明状态。
9. **Checkpoint / compaction**：摘要或不透明压缩状态；目前不是通用能力。
10. **Transport metadata**：stream event、finish reason、usage、cache usage、错误；通常不应混进模型上下文领域对象。

agent 应用通常还需要厂商 API 没有统一定义的三类字段：

- **provenance / trust**：内容来自用户、系统、网页、工具还是模型，是否可信。
- **lifetime / retention**：只在一次 call、一步、一个 run、整个 session 中有效；是否必须保留、可总结或可替换。
- **status / visibility**：工具是否完成/失败，内容是用户可见还是仅供模型续接。

## 四、四种最小骨架

### 1. Role-message

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "c1", "function": { "name": "read", "arguments": "{}" } }] },
    { "role": "tool", "tool_call_id": "c1", "content": "..." }
  ],
  "tools": []
}
```

### 2. Content-block

```json
{
  "system": "...",
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "..." }] },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "c1", "name": "read", "input": {} }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": "..." }] }
  ]
}
```

Gemini 将 `assistant` 称为 `model`，将 `content` 称为 `parts`，并使用 `functionCall` / `functionResponse`；Bedrock 使用 `ContentBlock` 的 `toolUse` / `toolResult`。

### 3. Typed-item

```json
{
  "input": [
    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] },
    { "type": "function_call", "call_id": "c1", "name": "read", "arguments": "{}" },
    { "type": "function_call_output", "call_id": "c1", "output": "..." },
    { "type": "reasoning", "encrypted_content": "..." },
    { "type": "compaction", "encrypted_content": "..." }
  ]
}
```

### 4. Token-template

```text
<special-system-token>instructions
<special-user-token>request
<special-assistant-token>answer-or-tool-call
```

真实 token、换行、结束符和工具表示全部由具体模型模板决定。

## 五、对当前项目的含义

当前项目的 `ChatMessage` 是典型 OpenAI-compatible Role-message：`system | user | assistant | tool`、字符串 `content`、assistant `tool_calls` 和 tool `tool_call_id`。对当前只调用 OpenAI-compatible `/chat/completions` 的范围，这个结构是合适的。

如果未来新增 Anthropic 原生 Messages、Gemini 原生 API 或 OpenAI Responses，不应继续往 `ChatMessage` 上堆兼容字段。更稳妥的边界是内部保存少量规范化 item：

```ts
type ContextItem =
  | { type: 'instruction'; authority: 'system' | 'developer'; content: ContentBlock[] }
  | { type: 'message'; role: 'user' | 'assistant'; content: ContentBlock[] }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; callId: string; content: ContentBlock[]; status: 'ok' | 'error' }
  | { type: 'reasoning_state'; data: unknown; opaque: boolean }
  | { type: 'checkpoint'; data: unknown; opaque: boolean };
```

然后由 `OpenAIChatAdapter`、`OpenAIResponsesAdapter`、`AnthropicAdapter`、`GeminiAdapter` 各自负责排序、字段命名和合法性约束。不要解析、改写或跨供应商转换不透明 reasoning/compaction state。

在第二个原生协议真正进入产品前，不需要提前重构；届时再引入 canonical item 层，收益才会超过复杂度。

## 官方资料

- [OpenAI：从 Chat Completions 迁移到 Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Anthropic：Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic：处理工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [Google：Gemini function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)
- [Google：Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [AWS：Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Cohere：Chat v2 tool use](https://docs.cohere.com/v2/docs/tool-use-overview/)
- [Mistral：Function calling](https://docs.mistral.ai/studio/conversations/function-calling)
- [Ollama：Chat API](https://docs.ollama.com/api/chat)
- [Hugging Face：Chat message patterns](https://huggingface.co/docs/transformers/en/chat_content_patterns)
- [Hugging Face：Writing a chat template](https://huggingface.co/docs/transformers/chat_templating_writing)
- [OpenAI：Harmony response format](https://github.com/openai/harmony/blob/main/docs/format.md)
- [Meta：Llama 3.3 prompt format](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/prompt_format.md)
- [DeepSeek：Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- [阿里云百炼：Qwen OpenAI-compatible Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
