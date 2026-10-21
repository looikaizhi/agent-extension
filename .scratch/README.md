# `.scratch/` —— 十三条规格流的索引

这里放的是**决定与证据**，不是代码文档。代码「是什么、怎么用」看注释与 `CONTEXT.md`；这里回答的是**「当时为什么这么定」**，以及——更重要的——**「以后别重做什么」**。

> **先读这一页，别逐个文件翻。** 2026-09-26 有过一次教训：`agent-architecture` 有 8 张票的票头写着 `ready-for-agent`，而票身里躺着完整的实现记录；照票头读会得出「8 张没做」的错误结论。票头已在同一天补正，这份索引是为了不再需要逐个文件去确认。
>
> **票头与票身冲突时，以代码为准。** 这个仓库的票是一次性写完的，落地之后未必有人回来改状态。

---

## 一句话状态表

| 规格流 | 是什么 | 状态 |
|---|---|---|
| `agent-architecture` | 规格 A：Agent 目录架构（意图模块、Plugin 接缝、目标树） | **14/14 done** |
| `agent-evals` | 规格 B：Agent 评估（决策语料、真机任务、报告页） | **15 张：14 done + 1 won't do** |
| `agent-workflows-memory` | 规格 C：Workflow / Memory / 新站点 Skill | **结帐了，见 `CLOSED.md`** |
| `conversation-panel` | 侧栏变成一段对话，宿主拥有它 | **4/4 done** |
| `element-table-dedup` | 元素表只删重复，不按相关性裁剪 | **大半已由 guide-stability 落地**，见 `spec.md` 开头 |
| `guide-stability` | 引导稳定性：单 Agent、工具循环、一次一步 | **31/31 done** |
| `harness-gaps` | 评测脚手架的四个盲区（含嵌入框架） | **5/5 done**（03 的第二层 2026-09-27 完成） |
| `model-config-flow` | 先连上再挑模型 · 端点要的字段 · 标出验收过的 | **3/3 done** |
| `model-protocols` | 模型协议可插拔（transport / 适配器 / 中立类型） | **9/9 done** |
| `one-plan-source` | 只留一个 plan source，删掉固定计划 | **1/1 done** |
| `s1-retirement` | 让 Thread 只有一个所有者 | **12/12 done** |
| `tour` | 顺序介绍这一页的每一项 | **证据不足，搁置** |
| `extractor-semantics` | 抽取器补语义（地标 role / 定向 href / 邻近文字）+ 两条安全收口 | **待做，段 3 有一个待拍板的岔路** |

---

## 以后别重做什么（这份索引真正的用处）

**别再提 Workflow / 回放。** `agent-workflows-memory/CLOSED.md` 写清了三条理由：定位矛盾（回放只在「熟悉的站」回本，而产品做的是陌生控制台）、**71% 的跳在这一步之后页面就变了**（t09+t11 共 130 趟 382 跳的实测）、以及它要的那台多步引擎已经删掉且删对了。

**别再提 Memory。** 同一份 `CLOSED.md`：第一版做过，2026-09-27 删掉。入库判据是「模型说 done」而实测只有 **71%** 真到了；取的是最近 3 条不看目标；默认开着；效果一次都没量过。完整的「为什么删」在 `CONTEXT.md` 的 `Memory` 词条后面。

**别再提多套 Provider 配置、Anthropic 原生适配器。** 产品定位已定：**配一个端点用到底**。见 `model-config-flow/issues/01` 的 Out of Scope——同一条 OpenAI 兼容线上就有 20 个 `claude-*`，原生那条线没有必要。

**别再提「按模型名猜要发什么字段」。** `model-config-flow/issues/02` 里有直接反证：同一家的 `qwen3-235b-a22b-thinking-2507` 好好的，而名字上看不出来的 `qwen3.7-plus` 撞墙。

**别再提「把同一页的 4-5 步一次规划完」。** 量过：省 18% 的调用，换来「在还没看到结果的页面上预测第 2、3 步」这一整类新错误。见 `tour/issues/01` 文末。

**别再拿 `element-table-dedup` 的票当待办。** 10 张里 02/03/05/07/09 已由 guide-stability 落地、01/06/10 是尺子（按不跑测评的决定不做）、04 有意不做（`observe` 保留）、08 已完成。

---

## 不可再生的实测数据在哪

这些数字**重做一次要花真钱**（真实 API 调用），有些已经再也测不到了——端点与模型都在变。

- **`model-protocols/`**：九条厂商预设的模型名核验（2026-09-25，五条已失效）、DeepSeek 与通义的思考模式拒收 `tool_choice: required`（两家拼法互发都 400）、`gpt-6-astra` 首字节 13.3/16.2/16.4s 撞 15s 连接钟、Anthropic 原生端点实测可达。
- **`model-config-flow/`**：聚合端点上 424 个模型的抽样——哪些 503、哪些 500、哪些 400、哪些 429；以及**同一个请求 `stream=false` 给出真正的报错、`stream=true` 只回 `openai_error`**。
- **`one-plan-source/`**：t09 + t11 的「连续几跳落在同一个 URL 上」分布。
- **`guide-stability/`**：31 张票里散着六轮真机的证据。
- **`harness-gaps/issues/03`**：iframe 两层的边界与第二层做完之后的核对。

`.scratch/model-protocols/xty-models.md` 是那个聚合端点 2026-09-25 的 424 个模型全目录。

---

## 目录里还有什么

- `*/spec.md` —— 一条流的问题陈述、解法、用户故事、Out of Scope。
- `*/issues/NN-*.md` —— 单张票：要做出来的东西、为什么、验收清单，以及**做完之后补的实现记录**（含有意的偏离）。
- `conversation-panel/evidence/` —— 那条流用到的证据材料。
