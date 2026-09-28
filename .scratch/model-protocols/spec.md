# 规格：模型协议可插拔

**Status:** ready-for-agent

> 来源：2026-09-23 的 `/grill-with-docs` 拷问，十六问全部定案，逐条落在下面的 Implementation Decisions 里。所有厂商事实均经一手文档核对（核对日期 2026-09-23）。
>
> 词汇以 `CONTEXT.md` 为准。本规格**新增两条词条**（`Protocol`、`Capability`），**修改四条**（`Provider`、`Repair call`、`Provenance`、`Decision eval`）。

## Problem Statement

**对这个产品的主人：它只会说一种线格式，而原厂正在把那种线格式关掉。**

- `src/agent/provider/provider.ts` 是全仓两个联网点之一（另一个是侧栏的 `fetchDoc`），它把 OpenAI Chat Completions 写死在三处：`${base}/chat/completions` 的路径、`Authorization: Bearer` 的头、`choices[].delta` 的 SSE 解析。`testConnection` 里还有第四处：`GET {base}/models`。

- 更深的一层是，这种线格式**漏进了它上面的每一层**，所以问题不是「换个 provider 文件」能解决的：
  - `agent/agents/guide/agent.ts` 的 `buildMessages` 直接吐 OpenAI 的线上形状（`{role:'assistant', tool_calls:[{id, type:'function', function:{name, arguments}}]}`），而且它跑在**每一个**工具轮上，不只是修复轮——`observe`、`wait_for`、`read_doc` 全都经过它。
  - `agent/agents/guide/runner.ts` 的流聚合写作 `at.name ??= d.tool.name`、`at.id ??= d.tool.id`。这是在**猜**元数据落在哪一片上；这个猜法对 OpenAI 成立（实测 DeepSeek：23 片，三样都在第 1 片），但 Anthropic 有 `content_block_start`、OpenAI Responses 有 `output_item.added`，两家都是**明说**「一个工具调用从这里开始」。
  - `agent/agents/guide/tool-schema.ts` 的 `nullable()` 产出 `{"type":["string","null"]}`——这是 OpenAI Structured Outputs 的写法。源码里只有 2 处调用，渲染到线上是 4 处（`value`、`expect_after`、`must_contain`、`must_contain.name`）。

- `CONTEXT.md` 把这件事写成了**硬契约**。`Repair call` 词条：「那对消息靠 `tool_call_id` 配对，**是 OpenAI 定死的线格式**」。

- **原厂在关门。** GPT-6 系列（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`）在 Chat Completions 上**不支持函数调用**，必须走 Responses API。也就是说 `openai` 这条 preset 今天指向的 `gpt-4o-mini` / `gpt-4o` 已经过期，而它的换代机型**在本产品现有的线格式上跑不起来**。这不是「多支持一家」的需求，是现有能力正在失效。

- **连接测试答不了真问题。** `testConnection` 只做 `GET {base}/models`，它能答「Key 对不对、端点在不在、模型名列没列出来」，答不了「这个端点认不认 `tool_choice: required`」——而那是本产品唯一真正依赖、各家差异又最大的一件事。Gemini 的 OpenAI 兼容层至今没有一手证据说明它支不支持 `required`（官方文档只列了 `auto`，并声明支持与模型有关），而它明文写着「未列出的参数一律**静默忽略**」。

- **有一条从未接线的散文兜底。** `runner.ts` 在端点不给工具调用时会把文字当信封解析（`parseTextOutput` → `parseContract`）。**机制本身是好的**——`runner.spec.ts` 的 `describe('guide/runner.ts · 换个端点也要能用')` 今天绿着，手写一个带 `intent` 的文本信封喂进去，它解得出 `point`。

  **坏的是触发条件从没接线**：`parseContract` 要求信封里有 `intent` 字段，而系统提示词从头到尾没教过信封格式、也没出现过 `intent` 这个词（对整份快照 grep 过，零命中）。**没有人告诉过模型可以这么答**，所以真机上这条路一次也没走通过，也永远不会。它是一条只在单元测试里活着的路径。

- 兼容层的降级是**静默**的。Anthropic 官方兼容表：`strict` → Ignored、prompt caching 不支持、`usage.prompt_tokens_details` → **永远为空**、`reasoning_effort` 忽略。用户看到的是「成本面板永远没有缓存数字」，而原因在三层之外。

- `architecture.spec.ts` 里那条白名单测试的名字就叫「**这就是这次重构的理由**」，注释写着：「换掉自定义文本契约、改用工具调用，图的就是『换个模型还能跑』。一个端点专有的字段会悄悄把这句话变成假话。」今天这句话只在 OpenAI 兼容层内部成立。

## Solution

把「怎么和一个模型端点说话」收成一条**可插拔的缝**，缝的两边各只做一件事。

- **`Protocol`**——一种线格式，独立于 `Provider`。适配器是写给 Protocol 的：`openai-chat` 这一个 Protocol 服务着 DeepSeek、Qwen、GLM、Kimi、OpenRouter、SiliconFlow、Ollama、LM Studio 八条 preset。
- **一个 `transport`**——全仓唯一发起模型请求的地方。三个钟（连接 15s / 停滞 30s / 总计 120s）、2MB 上限、abort、按行切 SSE，只写一次，且**不认识任何协议**。
- **一对纯函数**——每个 Protocol 提供 `prepare(ModelRequest) → HttpRequest` 与 `parse(字节流) → AsyncIterable<ModelDelta>`。不 fetch、不计时、无状态。
- **中立类型**——`ModelRequest` / `ModelDelta` / `ToolSpec`，自己写，零新依赖，但形状照抄 Vercel AI SDK 已经踩过的坑（content-parts 数组、namespaced `providerOptions`、`warnings`）。
- **`Capability`**——适配器在**发出去之前**就说得清的三件事，每一项都必须指得出消费它的那一条分支。
- **`warnings`**——适配器丢了什么必须说出来，不许静默降级。

本规格落地两个 Protocol：**`openai-chat`**（现有实现搬家，字节不变）与 **`openai-responses`**（新增，端到端跑通一趟真实引导）。

**承诺：`openai-chat` 上发出去的字节一个不变。** 由搬家那张票里一次性的双向证明保证。

## User Stories

1. 作为用户，我希望在设置里选到的模型端点**今天真的能用**，这样我不必在引导跑到一半时才发现这个模型名已经下线了。
2. 作为用户，我希望能用 OpenAI 的新一代模型（`gpt-6-astra` 一类），这样这个扩展不会随着 Chat Completions 关闭函数调用而失效。
3. 作为用户，我希望按下「测试连接」时，它测的是**这个端点能不能真的驱动这个产品**，而不只是「Key 没被拒」，这样问题在我配置的时候就暴露，而不是在我正需要引导的时候。
4. 作为用户，我希望测试连接告诉我这个端点**认不认强制工具调用**，这样我不会配一个每一步都答不出结论的端点。
5. 作为用户，我希望设置页上明确标出哪些端点是**原生协议**、哪些是**兼容层**，这样我知道自己选的是哪一种。
6. 作为用户，我希望兼容层的那几条明说**哪些能力用不上**（例如没有提示词缓存、成本面板看不到缓存数字），这样我不会把「端点做不到」误当成「产品坏了」。
7. 作为用户，我希望端点不支持强制工具调用时，产品在**发请求之前**就告诉我，而不是发出去、白烧一次调用、再给我一条读不懂的错。
8. 作为用户，我希望我的 API Key 仍然只有一个去处，这样多支持几种协议不会多几个地方碰到我的密钥。
9. 作为用户，我希望模型还在写的时候侧栏仍然实时显示它写到哪了，这样换了协议之后我的体验没有退步。
10. 作为用户，我希望换协议之后引导的质量不下降，这样这次改造对我是纯增益。
11. 作为读这个仓库的人，我希望「协议」在词汇表里有自己的词条，这样我不会把它和「端点」混为一谈。
12. 作为读这个仓库的人，我希望从词条里读得到**为什么协议不是 Provider 的一个字段**，这样下一个人不会把它降级成字段再走一遍弯路。
13. 作为读这个仓库的人，我希望全仓只有一个地方发起模型请求，这样「API Key 只有一个去处」是一条读得到、也测得出的事实。
14. 作为读这个仓库的人，我希望超时、大小上限、取消这些机制只写一遍，这样加一个协议不会把它们抄成第三份、第四份。
15. 作为读这个仓库的人，我希望 `Repair call` 词条给出的理由是**结构性**的（配对本身通用、配对的字段名不通用），而不是「OpenAI 定死的」，这样它在三个协议上都站得住。
16. 作为读这个仓库的人，我希望 `Provenance` 词条写明适配器必须交出模型的原始输出文本，这样「解析器只许丢弃和重组，永不许发明」在新协议上不是靠自觉。
17. 作为读这个仓库的人，我希望 `Capability` 有一条写下来的判据（一项进清单的条件是有一条分支读它），这样下一个想往清单里加东西的人被一句话拦住，而不是靠我口头解释。
18. 作为读这个仓库的人，我希望那条走不通的散文兜底被**删掉**而不是留着，这样我读到的每一条路径都是真的能走的。
19. 作为读这个仓库的人，我希望「发给模型的东西」的快照是**协议无关**的，这样系统提示词改一个字只需要审一份快照，而不是每加一个协议就多审一份。
20. 作为写适配器的人，我希望我只需要写两个纯函数（拼请求、解流），这样我不必重新实现超时、重试、字节上限、SSE 切行。
21. 作为写适配器的人，我希望这两个函数没有 IO、也没有状态，这样我能直接对它们断言，而不必造一个假的 fetch。
22. 作为写适配器的人，我希望有一套中立类型告诉我上游会给我什么、我必须交回什么，这样我不用去读运行循环才知道契约。
23. 作为写适配器的人，我希望我能声明我做不到什么（`Capability`），这样上游会在发请求之前避开，而不是让我在半路失败。
24. 作为写适配器的人，我希望我能声明我丢掉了什么（`warnings`），这样我不必在「静默丢弃」和「报错拒绝」之间二选一。
25. 作为写适配器的人，我希望一个协议专有的字段有地方放（namespaced `providerOptions`），这样我不用把它塞进中立类型污染别家。
26. 作为写适配器的人，我希望流事件是判别联合而不是一堆可选字段，这样我能把 Anthropic 的 `content_block_start`、Responses 的 `output_item.added` **原样**表达出来，而不必压回「元数据在第一片上」的假设。
27. 作为写适配器的人，我希望有一张属于我这个协议的请求体白名单，这样我发出去的每一个字段都被审过，而不是跟着 OpenAI 的名单走。
28. 作为写适配器的人，我希望现有那批 SSE 字节级用例（CRLF、心跳行、跨块切断、UTF-8 切在字符中间、DONE 之后的数据、超限）能直接复用在我的协议上，这样我不用重新想一遍边界。
29. 作为这个仓库的主人，我希望重构不改变 `openai-chat` 发出去的任何一个字节，这样 `merged-2` 的 83.3%（CI 77.7–87.8，噪声地板 ±3pp）基线不作废。
30. 作为这个仓库的主人，我希望这个承诺有一次**真的被验证过**，而不是只写在规格里。
31. 作为这个仓库的主人，我希望「原生 vs 兼容层」和「测过 vs 没测过」是**两个轴**，这样不会出现一个混淆两者的 Tier 数字。
32. 作为这个仓库的主人，我希望过期的 preset 模型名**不排在这次重构后面**，这样一个五分钟的修正不必等一个多会话的改造。
33. 作为这个仓库的主人，我希望不引入运行时依赖，这样扩展的体积和供应链面不因为这次改造而变。

## Implementation Decisions

### D1 · 范围

落地两个 Protocol：`openai-chat`（搬家）与 `openai-responses`（新增，端到端）。

> 为什么不是「只做缝」：只有一个住户的缝一定是合身的，中立类型会长成 OpenAI 的形状——那正是今天的病。第二个协议是唯一能验出缝漏在哪的东西。只做缝交付的是一个**没被证明过的**抽象。
>
> 为什么第二个是 Responses 而不是 Anthropic：原厂在关门，`openai` preset 正在失效。Anthropic Messages 另开一票（见 Out of Scope）。

### D2 · 通用语：自研中立类型，零新依赖

`ModelRequest` / `ModelDelta` / `ToolSpec` / `Capability` / `warnings` 全部自己写。

**不采用 Vercel AI SDK**，两条理由，都不是偏好问题：
1. 它的每个 provider 包**自己 fetch**。`architecture.spec.ts` 断言全仓只有两处 fetch，守的是「API Key 只有一个去处」——这是安全边界，不是洁癖。采用它就得删掉这条断言，换来三个第三方包各自持有用户的密钥。
2. 用不上它的通用面。本产品对模型接口的需求窄得出奇：七个函数、`tool_choice: required`、流式、多轮工具结果回放。`LanguageModelV4` 是为「什么都支持」设计的。

**不采用 OpenAI-as-neutral（LiteLLM 式）**：那正是今天的病。Anthropic 官方兼容表里那一整列 "Ignored" 就是这条路的终点。

**但形状照抄 AI SDK 已经踩过的坑**：content-parts 数组（而不是 `content: string | null`）、namespaced `providerOptions: {anthropic:{…}, openai:{…}}`、`warnings` 数组。拿它的设计，不拿它的 fetch。

**密钥不进适配器。** `prepare` 返回 `{ path, headers, body }`，**`headers` 里不含鉴权**；适配器另外声明 `auth: 'bearer' | 'x-api-key'`，由 `transport` 贴头。

> 为什么这条必须写死：如果 `prepare` 自己产出 `Authorization: Bearer ${apiKey}`，`ModelRequest` 就得携带密钥，于是**每一个适配器都摸到它**——而「API Key 只有一个去处」正是上面拒绝 Vercel AI SDK 的第一条理由。不这么切，这次改造会在自己这边把持有者从 1 个变成 1+N 个，白送掉它最想守的那条线。Anthropic 的 `x-api-key` 用同一个机制表达得出。
>
> `body` 必须是**适配器自己 `JSON.stringify` 完的字符串**，不是结构化对象——理由在 Testing Decisions 的白名单一节。

### D3 · `Protocol` 独立成词条

`CONTEXT.md` 新增 `Protocol` 词条，`Provider` 词条加一句「还带一个 `Protocol`」。

> 为什么不是 Provider 的一个字段：适配器是写给 Protocol 的，不是写给 Provider 的。`openai-chat` 这一个 Protocol 服务着八条 preset；把它降成字段，读代码的人会按 Provider 的数量去数适配器。反过来同一家厂商可以出现在两个 Protocol 下——智谱同时开 OpenAI 兼容（`/api/paas/v4`）和 Anthropic 兼容（`/api/anthropic`），那是两条 Provider 配置、一家厂商。
>
> `_Avoid_`：format、dialect、flavor、vendor（vendor 是厂商，不是协议）。

**运行时它住在 `ProviderConfig` 上，是一个字段，不从 preset 派生。**

> 为什么不从 preset 派生：`custom` 预设（以及本地 Ollama / LM Studio）就选不了协议；而且 D6 之后同一个 `api.openai.com/v1` 要同时服务 `openai-chat` 与 `openai-responses` 两个协议，preset 派生不出来。
>
> 旧存档由 `loadConfig` 的 `{...DEFAULT_CONFIG, ...v}` 兜住（缺字段落到 `openai-chat`）。连带要改两处：侧栏设置里的预设选择器，以及 `evals/options.ts` 的 `providerConfig()`——**后者必须显式给出 `openai-chat`**，这是本规格唯一允许动 `evals/options.ts` 的地方，且不得改动它任何其它字段。

### D4 · Provenance 闸门：`ModelDelta` 强制带 `raw`

适配器必须交出模型的原始输出文本；核心照旧用那份独立重写的扫描器扫。**给不出 raw 的协议不做适配器。**

> 为什么不下沉到适配器：Provenance 的全部价值在「扫描器是**独立重写的第二实现**，与解析器零函数共享」。下沉会变成 N 份扫描器，而「独立第二实现」的成本乘 N、收益不变。
>
> 为什么不做成可关的闸门：词条写的是「永不许发明」，没有分级。
>
> 代价是零：三个主协议全部逐字送原始 JSON 文本——Chat 的 `arguments`、Responses 的 `response.function_call_arguments.delta`、Anthropic 的 `input_json_delta.partial_json`。这条约束今天一个协议都挡不住。

### D5 · 兼容层降级对用户可见

设置页上每条 Provider 标一行「原生 / 兼容层」，兼容层明说哪几样用不上。**只是一行字，不做能力矩阵界面。** 这一行的内容来自 D10 的真调用探测结果，不是写死的表。

> 为什么：本产品的失败模式就是**静默降级**。`CONTEXT.md` 的 `Effect` 词条已经立过同构的规矩——「模型没答好和这一趟没走通是两回事」，而产品从前把它们当一回事，代价是用户只能把目标重打一遍。「这个端点做不到」和「模型没做好」也是两回事。

### D6 · 过期的 preset 模型名：另开一票，但 OpenAI 那条留在本规格

另一张独立的票改这五家（一手核对，2026-09-23）：

| preset | 现在写的 | 应为 |
|---|---|---|
| `moonshot` | `moonshot-v1-8k` / `-32k` | **2026-05-25 已下线**；改 `kimi-k2.6` / `kimi-k2.7-code` |
| `zhipu` | `glm-4-flash` / `glm-4-plus` | GLM-5.3（2026-08-19 上线）/ GLM-5.2 |
| `dashscope` | `qwen-plus` / `qwen-turbo` | `qwen3-max` / `qwen3.8-max` |
| `openrouter` | `openai/gpt-4o-mini` | 现行机型 |
| `siliconflow` | `Qwen/Qwen2.5-7B-Instruct` | 现行机型 |
| `deepseek` | `deepseek-flash` / `deepseek-v4-pro` | ✅ 已是现行，不动 |

**`openai` 那条留在本规格**：`gpt-6-astra` 在 Chat Completions 上不支持函数调用，那条 preset 只有 Responses 适配器落地之后才改得对——现在就改成 gpt-6，等于把一个能用的 preset 换成一个不能用的。

### D7 · 修复轮不是一个特殊概念

中立消息类型本来就有 tool-call part 和 tool-result part；修复轮就是「再放一轮工具结果，内容是错在哪」。中立层不认识「修复」这个词，适配器更不认识。

`CONTEXT.md` 的 `Repair call` 词条改写：删掉「是 OpenAI 定死的线格式」，换成——**这对消息必须在每一个协议上都表达得出来，而配对本身是通用的，配对的字段名不是**：

| Protocol | 模型说的那一半 | 送回去的那一半 | 靠什么配对 |
|---|---|---|---|
| `openai-chat` | `assistant.tool_calls[].id` | `{role:'tool', tool_call_id}` | `tool_call_id` |
| `openai-responses` | `{type:'function_call', call_id}` | `{type:'function_call_output', call_id}` | `call_id` |
| `anthropic-messages` | `{type:'tool_use', id}` | `{type:'tool_result', tool_use_id}` | `tool_use_id` |

词条里「代价实测很低——同一前缀命中缓存，3712 个 prompt token 里 3584 个是缓存命中」这句保留，但要注明它测于 `openai-chat`。

### D8 · Tier 是两个正交的轴

- **轴一：血统** — 原生协议 vs 兼容层。**本规格只保证这一个轴。**
- **轴二：测量** — 有没有自己的 Decision eval 基线。

> 为什么不合成一个数：它们真的正交。DeepSeek 是兼容层但测过 402 次调用；新落地的 Responses 是原生但一次没测。合成一个 Tier 数字会把这两件事混成一句假话。

**基线不按协议重跑。** `merged-2`（134 状态 × 3 = 402 次调用，意图准确率 83.3%，CI 77.7–87.8，噪声地板 ±3pp）在本规格里的角色是**回归闸门**，不是能力度量——`Task eval` 才量能力，而 `CONTEXT.md` 明写它「不当闸门」。Responses 要不要有自己的基线，是它自己那张票的事。

注意 `evals/options.ts` 把 provider 写死成 DeepSeek（连同 `thinking: {type:'disabled'}` 展开到每个请求），`evals/decision/run.mjs` 要求 `DEEPSEEK_API_KEY`。本规格**不改这两处**——改了基线就不可比。

### D9 · 删掉从未接线的散文兜底

删除 `runner.ts` 里 `parseSaid` 的散文分支、`guideAgent.parseTextOutput`，以及 `runner.spec.ts` 里那一整个 `describe('guide/runner.ts · 换个端点也要能用')`。端点不给工具调用时，直接给一条说得清的错。

**这是删一条能用但从未被告知过激活条件的路径，不是删死代码。** 说清楚这一点很重要，否则下一个人会以为它坏了。

> 为什么删而不是接线：
> 1. `CLAUDE.md` 第一条：「不保留向后兼容。直接删除过时路径，而不是添加兼容层、回退逻辑」——它正是一条兼容层回退。
> 2. 接线就要往系统提示词里加一段信封格式说明。这条代价没有被测过，但方向上很不妙：`envelope/contract.ts` 记着当初为什么**移除** `intent` 字段——「钉成单值枚举之后，8 次抽样里仍有 6 次回来装着对用户目标的自由文本复述」。**注意那条实测测的是在工具 schema 里向模型索要 `intent`**，会污染每一次调用；只在兜底路径生效的一句提示是另一回事，它没被测过。拿那条实测去挡这件事是不诚实的，所以理由只能是第 1 条和第 3 条。
> 3. 删掉之后这件事有了更好的表达：发前拦截（见 D14 的三态开关），而不是发出去、拿回一条文字、再走一条从没人告诉过模型的路。

**不要拿「省一次调用」当理由**：修复轮**不占**每步 4 次的预算（`machine.ts` 里 `providerCalls - 1` 只加进 `callCount`，`stepCalls` 每次派发才 +1），这正是 `CONTEXT.md` 的 `Budget` 词条写的「修复轮与文档抓取都算在它们所属的那次调用里，没有各自的配额」。而且删掉兜底一次调用也省不下来——没有工具调用时 `parseSaid` 走哪条分支都返回 `{kind:'error'}`，照样触发修复轮。**省钱的是 D14 的发前拦截，和删不删兜底无关。**

`runner.ts` 里那段解释兜底价值的注释（「the difference between "works on three endpoints" and "works on the ones that speak the wire"」）一并删除。

**并且要如实承认代价**：在 `openai-chat` 这一个协议内部，换端点的容忍度是**下降**的——换来的是跨协议的容忍度。这不是纯增益。

### D10 · `testConnection` 改成两段

1. **`GET {base}/models`**（保留）——便宜、不花 token，而且 401 无歧义。现有注释说得很准：「a 401 here is an unambiguous "the key is wrong" rather than something the model said」。
2. **一次最小的真调用**（新增）——一个玩具函数 + `tool_choice: required`，看回来的是不是工具调用。

第 2 段的结果有两个去处：D5 那一行标注，以及**写回 D14 的三态开关**。三种读数各有说法：回来是工具调用 → 开关写「支持」；回来是文字、工具调用为空 → 开关写「不支持」，并明说这个端点静默忽略了 `tool_choice`、跑不动本产品；HTTP 400 → 开关留在「未知」，把端点的报错原样给用户看（多半是 schema 关键字被拒）。

**两段都必须经 `transport` 发出，不得自己 `fetch`。** 这是 D11(a) 能不能成立的前提：`testConnection` 今天有一次裸 `fetch`，抽出 `transport` 之后它会变成第三个 fetch 点，那 D11(a) 宣称的「收紧」就成了放宽。所以 `transport` 除流式之外还要有一个**非流式**模式（一次性读完、同样三个钟、同样 2MB 上限）。

> 「`transport` 不认识任何协议」这句话因此要精确成：**它不认识任何协议的请求体与响应体**。路径（`/models`、`/chat/completions`）由 `prepare` 给，`transport` 只负责发。

> 为什么值得多花一次几十 token 的调用：它把「静默降级」提前到用户按下「测试连接」的那一刻，而不是等他在引导跑到一半时撞上。这也是唯一能回答 Gemini 那个悬而未决问题的机制——而且是用户自己按一下就有答案。

### D11 · 两条架构守卫

**(a) fetch 点数** — 断言从「只有 provider 层与 fetchDoc 执行器可以发起网络请求」收紧为「只有 `transport` 与 fetchDoc 执行器」，**并新增两条**：
- 适配器目录下不得出现 `fetch`；
- **适配器目录下不得出现 `apiKey`、`Authorization`、`x-api-key`**。这一条守的是 D2 那句「密钥不进适配器」——没有它，D2 只是一句劝告。

**(b) 请求体白名单** — 从「钉死 OpenAI Chat 的 8 个字段」改为**一协议一张白名单**，测试遍历适配器。`PRESET_FIELDS` 那套「每加一个字段都要注明一手文档与实测到的『确实生效』」的规矩**原样保留**。

并且要和 `warnings` 接上：**凡不在本协议白名单内的字段，要么被拒，要么在 `warnings` 里出现过——不许有第三种下场。**

**这条守卫对适配器的返回类型施加两条硬约束**，不满足它就会静默失效：

1. **`body` 必须是适配器自己 `JSON.stringify` 出来的字符串。** 检测器靠 AST 找 `body: JSON.stringify({字面量})` 并把展开就地展平；如果适配器返回结构化对象、交给 `transport` 去 stringify，检测器只能看到 `[…req.body]` 一项，`expect(keys.length).toBeGreaterThan(3)` 当场红——而且它红的原因是判据失效，不是代码有问题，这种红最消耗人。
2. **preset 专有字段的展开必须仍然是可静态识别的一处。** 现在检测器抓的是精确字符串 `…PRESETS.find((p) => p.id === cfg.preset)?.request`。一旦改走 `providerOptions['openai-chat']`，`expect(keys).toContain(PRESET_SPREAD)` 会红，而且那条「每加一个字段都要注明一手文档出处与实测到的『确实生效』」的规矩会**失去抓手**——这是本仓最值钱的一条纪律，不能在重构里顺手丢掉。改 `PRESET_SPREAD` 常量以对上新写法，不要绕过它。

> 为什么白名单更该留着：那条测试的注释说得比谁都清楚——「多数兼容层对不认识的字段是**静默忽略**而不是报错（实测 DeepSeek 连 `__definitely_not_a_field` 都回 200），所以线上不会有任何症状，只会在别家少一个能力」。多协议之后这个风险**变大**而不是变小。

### D12 · 不加 Gemini preset

今天一条都没有，本规格也不加。那条探针 curl 仍未跑。

> 为什么不顺手加：D6 那张票改的是**已经过期**的名字，是在修错的东西；加 Gemini 是**新增一个没验证过**的端点，性质不同，混进去会让那张票从「修正」变成「扩张」。而 D10 落地之后，Gemini 能不能进来会变成用户自己按一下就有答案的事——那时候加才是有根据的。
>
> 已知事实：base `https://generativelanguage.googleapis.com/v1beta/openai/`，Bearer 鉴权；`/models` 返回的 id **不带 `models/` 前缀**；函数调用**有** id；`{"type":["string","null"]}` **明确支持**（「To allow a property to be null, include `"null"` in the type array」）；`additionalProperties` 看字段而定（`parameters` 走 OpenAPI 白名单会剥掉，`parametersJsonSchema` 原样透传，两者互斥）。**唯一未验证的是 `tool_choice: "required"`。** 探针脚本已写好，需用 `gemini-3.8-flash` 跑（`gemini-2.5` 已限制新项目，脚本里默认的 `gemini-2.0-flash` 更是老两代）。

### D13 · `ModelDelta` 是判别联合

```
stream-start      { warnings }
text-delta        { text }
tool-input-start  { id, name, index }
tool-input-delta  { index, delta, raw }
finish            { reason, usage }
```

> 为什么不是今天那种扁平结构（`{ content: string; tool?: {...} }`）：决定性的不是美观，是 `at.name ??= d.tool.name` **在猜元数据落在哪一片上**。这个猜法对 OpenAI 成立，而 Anthropic 的 `content_block_start` 和 Responses 的 `output_item.added` 都是**明说**「一个工具调用从这里开始」。扁平结构会把两家明确给出的结构重新压扁回一个需要猜的形状——这正是 D2 拒绝 OpenAI-as-neutral 的同一个理由，只是换到了流这一侧。
>
> 附带好处：D4 的 `raw` 和 D11 的 `warnings` 在判别联合里各有天然位置，在扁平结构里只能再挂两个可选字段。

**两条要如实写进票里，否则实现的人会找一个不存在的东西：**

1. **「猜」没有消失，只是搬进了 `openai-chat` 适配器。** Chat Completions 的线上**确实没有** start 事件，所以 `openai-chat` 的 `parse` 仍然要靠「第一片带 id/name」来合成 `tool-input-start`。判别联合买到的是：Anthropic 和 Responses **不必再猜**，它们的 start 事件原样映射。
2. **`parse` 不是无状态的。** 它要记「这个 index 我发过 start 没有」、SSE 行缓冲、`[DONE]` 见没见过、有没有拿到真的 usage。中立类型这一侧的承诺是**纯粹**（不 IO、不计时、可重放），不是无状态。

**估算 usage 要换地方。** 今天端点不报 usage 时，`provider.ts` 凭 `messages` 的字符数造一个 `estimated: true` 的 usage，兑现「usage 落在最后一个 delta 上」这条硬承诺（`effect.spec.ts` 的注释点名依赖它）。`parse(字节流)` 看不见 messages，算不出 prompt 侧——所以这段归 **`transport` 之上、适配器之外**的那一层（发起调用的那一处），由它在 `finish` 事件上补。`ModelDelta` 的 `finish` 因此要带 `usage?: { …, estimated: boolean }`。

> 顺带记一条**既有缺陷**（不是本规格造成的，但重构会原样搬一遍死重量）：`EffectUsage` 根本没有 `estimated` 字段，`runner.ts` 把它丢了，`App.tsx` 又硬写 `estimated: false`——所以成本面板那句「含估算值」对模型调用**永远不会亮**。本规格不修它，但搬的时候不要把这条链抄得更深；修它是另一张票。

**侧栏的实时草稿分叉跟着改**：`effects.ts` 里那层包住 `complete` 的高阶函数从认 `d.tool?.arguments` 改为认 `tool-input-delta`。**它的性质原样保住**——仍然是包一层高阶函数，运行循环仍然不知道有面板存在。`draftTextOf`（`sidepanel/streaming.ts`）是对累积文本的纯函数，**不受影响**。

### D14 · `Capability` 只立两项，`forcedToolChoice` 是配置上的三态开关

**`Capability`（协议的属性，适配器声明）——两项：**

| 名字 | 消费它的那条分支 |
|---|---|
| `toolCallId` | D7：端点不给 id 时修复轮降级成原样重发（`runner.ts` 已有这条路） |
| `promptCaching` | D5：设置页那一行标注 |

**`forcedToolChoice` 不是 Capability。** 它是**端点**的属性，不是协议的属性：DeepSeek、通义、智谱、Gemini 全都走同一个 `openai-chat` 适配器，而它们对 `tool_choice: "required"` 的态度各不相同——`settings.ts` 里 DeepSeek 那条 preset 注释就是现成的证据（思考模式下 `required` 直接 400）。**适配器说不出这件事。**

所以它是 `ProviderConfig` 上的一个**三态开关**：`未知 | 支持 | 不支持`，默认「未知 ＝ 照发」。D9 的发前拦截只在「不支持」时生效；D10 的探测负责把「未知」改写成另外两态之一。

> 为什么是三态而不是布尔：默认值必须是「照发」而不是「拦住」——本产品今天所有能用的端点都没探测过，一个布尔会把它们全部误判成不支持。「未知」这一态就是「还没问过，先按能用处理」。

**判据（写进 `Capability` 词条）：一项 capability 进清单的条件，是有一条分支读它，而且它对整个协议成立。**

> 为什么清单这么短：`CLAUDE.md`——「选择能完全满足当前需求的最简实现。避免投机性的抽象、配置和间接层。」`strictSchema`、`parallelToolCalls`、`reasoning`、`usageDetails`、`systemMessage` 今天没有任何分支读它们，立了就是一张会腐烂的表；更要命的是它们中有几项和 `forcedToolChoice` 一样是**端点**级差异，放进协议级的声明里会给出错误答案。

### D15 · `warnings` 只进 Round

`warnings` 落在 `Conversation` 词条里定义的 `Round`（界面上可下拉展开的「思考过程」：调了什么、模型说的理由、拿回了什么、花了多少 token）。**不升到 `Conversation` 上宿主自己的话。**

> 为什么：`warnings` 说的是「给这个端点发请求时丢了 `strict`」——这是**每一次调用都会发生**的常态，不是事件。而 `Conversation` 词条对宿主自己的话立过标准：「拒绝、失败、一趟怎么结束的」，三样都是**事件**。升上去会变成每轮一条一模一样的噪音。
>
> 「第一次出现时说一句、之后只进 Round」需要一个跨调用的记忆，那个位置今天不存在，为它造一个不值得。用户想知道「这个端点少了什么能力」有更好的去处：D5 那行标注 + D10 的探测结果，在设置页上一次说清。

### D17 · 评估这一侧的可比性链，必须在旧路径还活着的时候处理掉

**这是本规格风险最高的一条，也是初稿完全漏掉的一条。**

`evals/fingerprint.ts` 跑一遍真实运行循环，把 `{messages, options}` 整个 `JSON.stringify` 后取 sha256。它的文件头写着：

> Two results are directly comparable only when this matches; when it does not, part of the difference between them is the prompt.

靶子从 `ChatMessage[] + CompleteOptions` 换成中立形状 → **哈希必变，而线上字节没变**。后果有三层：`evals/decision/run.mjs` 会对此后每一次 eval 打印「发给模型的东西不同，这正是要量的差别」——**一句假话**；`extract.mjs` 会警告语料不可重拼；所有历史 run 的指纹永久失去与今后任何一次 run 的可比性。它连里面那个 `recording` 桩都是扁平 `Delta` 形状，判别联合一来它第二次破。

**决定：`fingerprint()` 改成只哈希 `{system, user, tools}` 三段渲染文本。**

> 为什么：它本来就只想回答「发给模型的东西变没变」，而那三段是**协议无关**的。这么改之后，以后再加协议它不会再动——这条可比性契约从此不再被协议重构碰到。代价是一次性重录基准，须在 `results.json` 里留下说明（改了什么、为什么、旧指纹是多少）。

**同一条链上还有第二处：`Trace` → Decision 语料。**

`runner.ts` 的 `requestEvent` 取 `messages[0]?.content` 当 `system: string` 存进 `Trace`；`evals/decision/corpus.ts` 从 `trace.system` / `trace.tools` 造 `State.sent`，`rebuild()` 用 `String(system.content)` 和 `JSON.stringify(outputSchema(ctx))` 回比。content-parts 数组 + 扁平 `ToolSpec` 一来，**已提交的 134 条语料的 `sent` 永久对不上**。

最坏的是它**绿着坏掉**：`on-target.mjs` 用 `if (differences(s).length) continue;` 过滤，会静默产出零条语料，不报错；而 `decision-corpus.spec.ts` 自产自销，两边一起变，**不会红**。`CONTEXT.md` 的 `Decision eval` 词条那句「与模型当时读到的一字不差」会在这一刻变成一句无法再验证的话。

**决定：`Trace` 的 `system` 与 `tools` 保持为渲染后的字符串**，不跟着中立类型变成结构化对象。Trace 的受众是人和语料，不是协议。

**这两件事都必须排在运行循环切换之前**——那时旧路径还活着，重录基准还有参照系可对。切换之后再做，就没有可回头的基准了。

### D16 · `CONTEXT.md` 四改两增

**改：**
- `Provider` — 加上它还带一个 `Protocol`。
- `Repair call` — 按 D7 改写理由，附三协议配对表。
- `Provenance` — 加一句：适配器必须交出模型的原始输出文本，给不出的协议不做适配器。
- `Decision eval` — 按 D8 写明它在这件事里是回归闸门不是能力度量，基线不按协议重跑。

**增：**
- `Protocol` — 后跟「> 为什么不是 Provider 的一个字段」。
- `Capability` — 后跟「> 为什么清单这么短」。

`Warning` **不立词条**——D15 把它钉死在 `Round` 里，没有歧义可言，`Conversation` 词条已经涵盖。

按仓库惯例：**没有 `docs/adr/`**，决定写成 `CONTEXT.md` 词条后的「> 为什么」注记。

## Testing Decisions

### 什么算一个好测试

只测外部行为，不测实现细节。这次重构的特殊之处是它**几乎不产生新行为**——绝大部分测试的正确形态是「原封不动地继续通过」。任何一张票如果需要改写一批行为测试，那多半是它做错了。

### 缝（2026-09-23 与用户确认）

**① `runGuide` ——最高的那条，缝本身原地不动。**
签名已经是 `runGuide(ctx, cfg, signal, completeFn = complete, nonceFor?)`，流式函数本来就是带默认值的参数。重构后它接的换成产出中立 `ModelDelta` 的函数。**被测的行为**——工具循环、配额、修复轮、失败分类——一条都不用重新设计。

**但「只改类型不改结构」是错的，初稿在这里把两件事混了，落票时按下面这张表走：**

| 文件 | 实际要做什么 |
|---|---|
| `runner.spec.ts`、`tool-loop.spec.ts` | **要改结构**：里面十余个手写的扁平 `{content, tool:{index,name,arguments}}` 字面量，判别联合一来全部要重写 |
| `effect.spec.ts`、`decision-replay.spec.ts`、`decision-corpus.spec.ts`、`model-input-snapshot.spec.ts` | 同样手写假 delta / 假 `complete`，**初稿整批漏掉了** |
| `evals/fingerprint.ts` | 同样有一个扁平 delta 的录音桩——**而它不是测试，是进版本管理的评估代码**（见 D17） |
| `budgets.spec.ts`、`one-step.spec.ts`、`route-and-steps.spec.ts` | **零改动**。它们根本不碰 `runGuide` 或 `complete`，测的是 `machine.ts` 归约器。初稿把它们列进这条缝是错的 |

**② 适配器对 `prepare` / `parse` ——本规格新增的唯一一条缝，而且它替掉一个 mock。**
`provider-sse.spec.ts` 今天自述：「`complete()` is the seam. Every test here drives it through a **mocked `fetch`**」。拆缝之后两边都是纯函数：给一个 `ModelRequest`，断言 `prepare` 产出的 `HttpRequest`；喂一串 `Uint8Array`，断言 `parse` 吐出的 `ModelDelta`。**不需要 fetch、不需要 Response、不需要 mock。**

**切点画在哪（初稿在这里自相矛盾，现在定死）：`transport` 产出「行」，`parse` 吃「行」，不吃字节。**

> 为什么：字节边界那一类问题——UTF-8 切在字符中间、行跨块切断、CRLF——是 **SSE 通用**的，不是哪个协议的。让每个适配器各写一遍，正是 `sse-streams.ts` 存在要防的那个 bug 类，抄三份就中三次。`: heartbeat` 注释行同理（SSE 规范的东西），由 `transport` 丢掉。而 `[DONE]` 是 **OpenAI 的约定**（Anthropic 没有），归 `parse`。
>
> 将来真出现一个非 SSE 的流式协议（例如 Gemini 原生的 JSON 数组流），`transport` 再长一个裸字节模式。**今天不建**——`CLAUDE.md`：避免投机性的抽象。

`tests/unit/fixtures/sse-streams.ts` 的 fixture **形状逐字不变**（已经是 `Uint8Array[]`），它的注释点明了为什么必须是：「The chunk boundaries are the thing under test, so a fixture that joined its pieces into one string before encoding would test nothing」。但这 13 个 fixture **按切点分给两条缝**：

| 归 ④ `transport`（字节 → 行） | 归 ② `parse`（行 → delta） |
|---|---|
| CRLF 行尾、行跨块切断、UTF-8 切在字符中间、末行无换行、心跳注释行、超限 | `[DONE]` 之后还有数据、流里的 error 对象、usage 块在末尾 / 缺 `total_tokens` / 完全没有、两条完整行 |

Responses 协议加一份同构的 fixture（事件名不同：`response.output_item.added`、`response.function_call_arguments.delta`、`response.completed`），**只需要右边那一列**——左边那一列已经被 `transport` 一次性覆盖了，这正是这么切的收益。

**③ 文件快照 ——靶子改成中立 `ModelRequest`。**
`model-input-snapshot.spec.ts` 今天渲染 `ChatMessage`，改为渲染中立的 `ModelRequest`。

> 为什么是中立形状而不是线上字节：中立 `ModelRequest` 的快照是**协议无关**的，一份覆盖所有协议。渲染线上字节则每加一个协议多一份快照，系统提示词改一个字要在 N 份里分别审；而且 OpenAI 适配器里一个纯排版改动（键序、空白）会让快照变红，明明模型看到的东西一个字没动。

**代价是一次性的，必须用一次性的证明补上。** 快照文件本身会变，所以「零字节变化」不能再当重构的证明。

**证明住在 `prepare` 那张票里，不是运行循环切换那张票**——那是新旧两条路径**同时活着**的唯一时刻，切换票里旧路已删，证明就做不了了。

**断言恰好一条：同一份 cfg + ctx 下，老路径交给 `fetch` 的 `init.body` 字符串，与 `prepare()` 产出的 body 字符串全等。**

这要求 `JSON.stringify` 的**键序完全一致**。今天的键序是：

```
model, messages, stream, stream_options, temperature, …preset 展开, tools, tool_choice, parallel_tool_calls
```

**键序是「字节一个不变」唯一真正的约束**，初稿通篇没提它——一个字段顺手挪个位置，语义毫无变化，而字节全变。写进验收项。

**不要断言「delta 序列逐项相同」**，两条理由：
1. **没有数据源。** Decision 语料里一个字节的 SSE 响应都没有——`answer` 字段存的是已经解析完的结果，不是流。
2. **原则上也做不到。** 今天一个扁平 `Delta` 能同时带 `content` 和 `tool` 片（`runner.spec.ts` 里就有这个用例），判别联合下必然拆成两个事件。要「逐项相同」就得写一个 old↔new 翻译器，而翻译器本身就是被测对象。

Decision 语料可以用来给**请求侧**加广度（134 个状态各跑一遍 `prepare`），但它只覆盖 `{system, tools, user}` 三段字符串，不覆盖请求体的其余字段；深度仍然由现有的 `model-input-snapshot.spec.ts` 提供。两者都要，谁也不替谁。

绿了之后，在**运行循环切换那张票**里删掉这条断言和旧快照，换成中立 `ModelRequest` 的新快照。证明发生一次，不留机器。这不是兼容层——它是迁移证明，`CLAUDE.md` 的「不保留向后兼容」针对的是长期存在的回退路径。

**④ `transport` 的三个钟 ——仍然要 mock fetch，但只剩钟。**
连接 15s / 停滞 30s / 总计 120s、2MB 上限、abort，这些必须有一个假的 fetch 才测得了——那是不可约的，它就是唯一真正发请求的地方。但它**不再认识任何协议**。`provider-sse.spec.ts` 因此一分为二：钟归 ④，解析归 ②，两边都只测一件事。

### 各模块的测试归属

| 模块 | 缝 | 现有用例怎么办 |
|---|---|---|
| `transport`（三个钟、2MB、abort、SSE 切行） | ④ mock fetch | 从 `provider-sse.spec.ts` 拆出超时那一半 |
| `openai-chat` 的 `prepare` / `parse` | ② 纯函数 | 从 `provider-sse.spec.ts` 拆出解析那一半，fixture 照用 |
| `openai-responses` 的 `prepare` / `parse` | ② 纯函数 | 新增同构 fixture |
| 中立类型 / `warnings` / `Capability` | ② + `architecture.spec.ts` | 新增 |
| 工具循环、配额、修复轮、失败分类 | ① `runGuide` | **只改类型** |
| 发给模型的东西 | ③ 文件快照 | 靶子改中立形状，附一次性双向证明 |
| fetch 点数、请求体白名单 | `architecture.spec.ts` 静态分析 | 按 D11 改写 |
| `draftTextOf` | `streaming.spec.ts` | **不受影响** |
| `testConnection` 两段探测 | ④ mock fetch | 新增；两段都走 `transport`（D10） |
| `evals/fingerprint.ts` | 自身 | 改哈希三段渲染文本，重录基准（D17） |
| `Trace` 的 `system` / `tools` | `trace.spec.ts` + `decision-corpus.spec.ts` | **保持为渲染后的字符串**，不跟着中立类型变结构（D17） |
| `smoke.mjs` 的 OpenAI 打桩 | e2e | 随 openai preset 改协议一起改打桩 URL |

### 本仓的既有做法（写新测试时照着）

- `tests/unit/provider-sse.spec.ts` — 手搓 `ReadableStream<Uint8Array>` 驱动流式路径，每个用例把块边界编码进 fixture。
- `tests/unit/fixtures/sse-streams.ts` — fixture 以 `Uint8Array[]` 表达，因为块边界本身是被测对象。
- `tests/unit/runner.spec.ts` — 把假的流式函数作为参数注入运行循环；文件头注释说明这个文件为什么存在、它钉住哪几条性质。
- `tests/unit/model-input-snapshot.spec.ts` — `toMatchFileSnapshot`，随机包裹标记固定为常量以保证可重复。
- `tests/unit/architecture.spec.ts` — 对源码做静态分析下断言，每条断言的注释写明它守的是什么以及违反会怎样。

### 闸门

每张票都要过：类型检查、单测、e2e、抽取器评测全绿。

额外的：`prepare` 那张票要过一次性的请求体全等证明（含键序）；`fingerprint` 那张票要在 `results.json` 里留下重录说明；**Decision eval（`merged-2`）在运行循环切换之后跑一次确认不退步**——它是回归闸门，不是能力度量。

**一条容易被绕过的**：`decision-corpus.spec.ts` 自产自销（两边一起变就不会红），`on-target.mjs` 静默产出零条语料也不报错。所以 D17 那张票的验收不能只看绿，**必须手动跑一次语料抽取，确认抽得出非零条**。

## Out of Scope

- **Anthropic Messages 适配器。** 另开一票。它一次解锁三家（Claude、GLM 的 `/api/anthropic`、Kimi 的 Anthropic 兼容端点——后两条来自二手来源，动手前须一手确认）；要处理 `max_tokens` 必填、`anthropic-version: 2023-06-01` 头、顶层 `system`、`tool_choice: {type:"any"}`、以及 `thinking.budget_tokens` 在新模型上不再接受（改用 `effort`）。
- **Gemini 原生协议（`generateContent`）**，以及任何 Gemini preset。等探针。
- **Tier 的第二个轴（测量）**：Responses 自己的 Decision eval 基线。
- **`evals/decision/run.mjs` 的评分与闸门逻辑**：不动，动了基线就不可比。**`evals/options.ts` 只允许加一个 `protocol: 'openai-chat'` 字段**（D3），其余一律不动。
- ⚠️ **`evals/fingerprint.ts` 不在 Out of Scope——它必然要改**，见 D17。初稿把它漏在这份名单的保护之外，而它恰恰是唯一真正判定「两次 run 可不可比」的东西。
- **五家过期的 preset 模型名**：D6 的独立票（`openai` 那条除外，它在本规格内）。
- **提示词缓存、reasoning / thinking 参数、Structured Outputs 的实际使用**：`Capability` 里只声明有没有，不在本规格里用起来。
- **代劳（`act`）**：与本规格无关，其重开条件见 `CONTEXT.md` 的 `Tool` 注记。
- **`tool-schema.ts` 的 `nullable()`**：它产出 OpenAI Structured Outputs 的写法，但 Gemini 明确支持同样的 type 数组，Responses 也用同一套。**本规格不动它**；真要改是 Anthropic 那张票的事（Anthropic 的 `input_schema` 是另一套）。

## Further Notes

- **仓库规矩：不执行任何 Git 操作。** 所有改动由仓库主人自己提交。`.scratch/` 与 `docs/` 不进仓库。
- **没有 `docs/adr/`。** 决定写成 `CONTEXT.md` 词条后的「> 为什么」注记。
- **不引入任何运行时依赖。** 本仓今天的运行时依赖只有 `react`、`react-dom`、`dom-accessibility-api` 三个，本规格之后仍然是三个。
- **一手核对过的协议形状**（2026-09-23）：

  *OpenAI Responses* — tools 是**扁平**的 `{type:"function", name, description, parameters, strict}`（不嵌在 `function` 下，这是与 Chat Completions 最容易踩的差别）；输入项 `{type:"function_call", call_id, name, arguments}` / `{type:"function_call_output", call_id, output}`；`tool_choice` 支持 `"auto"` / `"required"` / `{type:"function",name}` / `{type:"allowed_tools",…}`；reasoning item 必须随 tool output 回传；流式 `response.function_call_arguments.delta` 的 `delta` 是原始 JSON 文本。

  *OpenAI 模型* — `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`，1.05M 上下文，reasoning 档位 low/medium/high/xhigh/max。「Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort` values other than `none`」，且「Use the Responses API for function calling. Chat Completions does not support function calling with GPT-6 Astra」。

- **未验证、需要仓库主人跑的一件事**：Gemini OpenAI 兼容层认不认 `tool_choice: "required"`。探针脚本在本会话的 scratchpad 里（`gemini-probe.sh`），需把 `MODEL` 改成 `gemini-3.8-flash`。最坏读数是 `200 + content 有文字 + tool_calls 为空`——那正是 D9 要删掉的死路会吃掉的那种情况。本仓没有 Gemini key，我跑不了。

- **e2e 里有一条会静默失效的安全网。** `tests/e2e/smoke.mjs` 对 `https://api.openai.com/v1/chat/completions` 打桩，并断言 0 次请求；注释写明它的作用是「如果这道闸将来被意外削弱、又开始发请求了，桩会把它挡在 CI 的真实网络之外」。openai preset 一改成 Responses，真正会被打到的是 `/v1/responses`——**这个桩不再拦任何东西，而断言照样绿**，漏出去的请求直奔真实 OpenAI。改 preset 的那张票必须同步改打桩 URL。（另外两处走自定义端点的 `QA_BASE/chat/completions` 不受影响。）

- **`Turn` 词条里那句「没有轮次时不过线，那次调用与没有工具循环时逐字节相同」**：这句话在中立类型之后仍然成立，但它现在是**每个适配器各自**的承诺。搬家票的双向证明覆盖 `openai-chat`；Responses 那张票要为自己重立一次。
