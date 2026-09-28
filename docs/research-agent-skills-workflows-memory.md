# Skills / Workflows / Memory：工业框架与网页 agent 研究里它们到底是什么——一手来源摘录

> 本文是**原始素材**，不是设计方案。它做三件事：把 Anthropic、OpenAI Agents SDK、LangGraph/LangMem、browser-use（含 workflow-use）、Stagehand、Skyvern 的官方文档与源码，以及 AWM、SkillWeaver、ASI、Voyager、Mem0、ReasoningBank、WALT、WebXSkill 等论文原文里关于这三个词的内容抄下来并标注出处；把网页导航任务上量出来的正负数字集中列出；在第 5 节把它们和本项目已有概念做**概念映射**（明确标为推断）。
>
> 全文不给实现建议。凡是「我们应该……」的句子都不应出现在这里。
>
> 记号约定：
> - 「**原文**」= 从来源逐字或近逐字摘出的内容（英文原文保留英文）。
> - 「**推断**」= 我根据原文得出的结论，原文并没有这么说。
> - 「**在这些来源里没找到**」= 我查过列出的来源，没有看到；**不等于**不存在。
> - 源码引用写成 `仓库@短 commit 路径:行号`；论文引用写成 arXiv 编号 + 小节 / 表格号。arXiv 的小节号和表号取自抓取当天 arXiv HTML 的最新版本。

---

## 0. 一手来源清单（读的是哪个版本）

抓取日期：2026-09-11。

| 来源 | 版本 / commit | 日期 | 本文简写 |
|---|---|---|---|
| Anthropic Agent Skills 概览 | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview | 抓取日 | Skills 概览 |
| Anthropic Skill 编写最佳实践 | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices | 抓取日 | Skills 最佳实践 |
| Anthropic 工程博客 *Equipping agents for the real world with Agent Skills* | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | 原文标 "Published Oct 16, 2025" | Skills 博客 |
| Claude Code Skills 文档 | https://code.claude.com/docs/en/skills | 抓取日 | CC Skills |
| Claude Code 记忆文档 | https://code.claude.com/docs/en/memory | 抓取日 | CC Memory |
| Claude API memory tool 文档 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool | 抓取日 | Memory tool |
| anthropics/skills | `34040c9c568585f6929bedeaad110ad08f079624` | 2026-09-10 | `skills@34040c9` |
| openai-agents-python | `1705dd62509ebfb3e85e26baedbe43e9f183580f`，`pyproject.toml` 声明 `version = "0.22.2"` | 2026-09-10 | `oai@1705dd6` |
| OpenAI Agents SDK 文档：sessions / handoffs / guardrails | https://openai.github.io/openai-agents-python/sessions/ 、/handoffs/ 、/guardrails/ | 抓取日 | OAI docs |
| LangChain / LangGraph 记忆概念文档 | https://docs.langchain.com/oss/python/concepts/memory | 抓取日 | LG 概念 |
| LangMem 概念指南 | https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ | 抓取日 | LangMem 概念 |
| langchain-ai/langmem | `9d033b47d9ce53e37e92c92241b0496c0278932e`，`version = "0.0.30"` | 2026-09-09 | `langmem@9d033b4` |
| langchain-ai/langgraph（只读了 store 基类） | `e539ac122f4126f6dd850581c1494948cf620e31` | 抓取日的 HEAD | `langgraph@e539ac1` |
| browser-use/browser-use | `50f205533fe10ba35b553d2a3689c77b87bd5d0a`，`version = "0.13.10"` | 2026-09-09 | `bu@50f2055` |
| browser-use 历史 tag | `0.1.41`、`0.2.7`、`0.3.2`、`0.3.3`、`0.4.1` | — | `bu@0.3.3` 等；只用来追溯已删除的 memory 模块。`0.4.0` 的 tarball 下载失败，没读到 |
| browser-use/workflow-use | `5d2d19fe8835cc86f1bf3e04302a5000d590f249` | 2026-08-27 | `wfu@5d2d19f` |
| mem0ai/mem0 | `c7ee362aff94a369af70f13f2b4f853f6793ff4c`，`version = "2.0.20"` | 2026-09-11 | `mem0@c7ee362` |
| browserbase/stagehand（main） | `9f4f878e99ac82cd35480a7dd841dfe3dbb78093`，`packages/sdk-ts/package.json` 声明 `"version": "4.1.0"` | 2026-09-09 | `sh@9f4f878` |
| browserbase/stagehand（tag） | `@browserbasehq/stagehand@3.7.3` | — | `sh@3.7.3`；本地缓存的源码在这里读（见 §2.5） |
| Skyvern-AI/skyvern | `35cfb314f4777ad77130dae087b26aa3ef99c489`，`version = "1.0.52"` | 2026-09-10 | `sky@35cfb31` |
| zorazrw/agent-workflow-memory（AWM 官方代码） | `8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1` | 2025-12-22 | `awm@8c0ff8c` |
| AWM 论文 | arXiv:2409.07429 v1 | 2024-09-11 | AWM |
| SkillWeaver | arXiv:2504.07079 v1 | 2025-04-09 | SkillWeaver |
| ASI（*Inducing Programmatic Skills for Agentic Tasks*） | arXiv:2504.06821 v2（v1 2025-04-09） | — | ASI |
| Voyager | arXiv:2305.16291 v2（v1 2023-05-25） | — | Voyager |
| Mem0 | arXiv:2504.19413 v1 | 2025-04-28 | Mem0 |
| ReasoningBank | arXiv:2509.25140 v2（v1 2025-09-29），arXiv 注记 "Accepted to ICLR 2026" | — | ReasoningBank |
| WALT（*Web Agents that Learn Tools*） | arXiv:2510.01524 v1 | 2025-10-01 | WALT |
| WebXSkill | arXiv:2604.13318 v2（v1 2026-04-14），arXiv 注记 "Accepted to Findings of EMNLP2026" | — | WebXSkill |
| *How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior* | arXiv:2505.16067 v2（v1 2025-05-21）；ACL Anthology 条目 2026.acl-long.27 | — | Experience-Following |

对照用的本项目文件（只读，未修改）：`CONTEXT.md`、`src/core/packs/types.ts`、`src/agent/plan/prompt.ts`、`src/agent/host/record.ts`、`src/agent/host/thread.ts`、`src/agent/host/guide.ts`、`src/agent/guide/agent.ts`。

---

## 1. 结论先行

逐题列出。每条的出处在后文对应小节。

### 问题一：各家的具体含义与数据模型

1. **「skill」至少有两种互不兼容的含义。**（a）Anthropic 与 OpenAI SDK 沙箱：一个带 `SKILL.md` 的文件夹，是**给模型读的说明书**（可附脚本），模型根据 `description` 自己判断何时读入全文（§2.1、§2.2.4）；（b）SkillWeaver / ASI / WALT / WebXSkill / Voyager / browser-use Cloud：一段**可执行程序**，被加入模型的动作空间，调用即执行（§2.4.3、§2.7）。
2. **「workflow」也分两种。**（a）AWM：从成功轨迹里用 LLM 归纳出的**抽象文本子程序**（值被换成 `{product-name}` 之类的占位符），放进 memory 给模型参考，永远由模型逐步落地（§2.7.1）；（b）workflow-use、Skyvern 的 code caching、Stagehand 缓存、browser-use 的 `rerun_history`：**确定性回放脚本**，回放时不调用模型，出错时各家处理不同——Skyvern 自动回落 agent 并重新生成，Stagehand 在回放结果变化时回写缓存，workflow-use 的回落 agent 代码被注释掉了（§2.4、§2.5、§2.6）。
3. **「memory」至少四种**：会话历史（OpenAI `Session`、LangGraph short-term / checkpointer）；跨会话事实与偏好（LangMem semantic、Mem0、Claude Code auto memory、Anthropic memory tool）；从经验提炼的策略（AWM、ReasoningBank、OpenAI 沙箱 memory 的 rollout summaries）；以及 browser-use 叫作 "procedural memory" 的东西——**原文**是每 N 步把本次运行的历史压缩成一条消息，mem0 那边的提示词要求「逐字保留每个输出」（§2.4.1）。**同名的 "procedural memory" 在 LangMem 指对 prompt 规则的优化**（§2.3）。名字相同，东西不同。
4. **进 prompt 的位置与大小各家写得不一样**：Anthropic Skills 的元数据进 system prompt（文档估约 100 token/skill），正文触发后由模型用 bash/Read 读成一条消息（文档建议 5k token 以内、500 行以内）；OpenAI 沙箱 memory 把 `memory_summary.md` 注入 developer prompt，截断到 15,000 token；AWM 在 WebArena 追加到 system message、在 Mind2Web 作为一条 user message；ReasoningBank 取 top-k（默认 k=1）注入 system instruction；OpenAI `Session` 把历史 item 前置到输入里。

### 问题二：网页 agent 上量出的效果（含负面）

1. **正面数字都来自「agent 自己动手」的设置**：AWM 在 WebArena（GPT-4）把 BrowserGym 的 23.5 提到 35.5（相对 +51.1%）；ASI（Claude）40.4 对 AWM 36.3 对 vanilla 32.7；SkillWeaver（GPT-4o）22.6→29.8；ReasoningBank 在三种骨干上分别 +8.3 / +7.2 / +4.6；WALT 在 WebArena 50.1；WebXSkill（GPT-5）69.5 对 vanilla 59.7（§3.1）。
2. **与本项目「每步选一个 ref」最接近的是 Mind2Web 的逐步设置**：AWM 在那里的提升「主要来自更准确的元素选择」（Elem Acc 41.6→50.6），但 Action F1 反而从 60.6 降到 57.3（AWM §3.2.1，表 3）。
3. **骨干更强以后，负面结果开始出现**：ReasoningBank 复现的 AWM 在 Claude-3.7 上总分 40.8，低于无记忆的 41.7；在跨站子集 Multi 上从 10.3 掉到 3.4（ReasoningBank 表 1）。WebXSkill 用 GPT-5 复现 SkillWeaver 与 WALT 的原始实现，分别只有 37.4 和 42.9，远低于 vanilla 的 59.7（WebXSkill 表 2）。
4. **记忆越多不一定越好，质量闸门决定正负**：ReasoningBank 取 1 条经验 49.7，取 4 条降到 44.4；AWM 的 online 版本会从错误轨迹归纳出错误 workflow；offline 与 online 的 workflow 叠加不是相加关系（AWM 附录 C）；非网页的 Experience-Following 研究发现「全部加入」会让成功率走平或下降。
5. **工业侧没有公开数字**：Anthropic、OpenAI、LangMem、Stagehand、Skyvern、workflow-use 的官方材料里都没找到基准数字（Stagehand 只有「10-100x faster」「~50,000 tokens → 0 tokens」一类的文档陈述）。browser-use 的 mem0 memory 在 0.3.3 被 `if self.enable_memory and False:` 关掉（旁注 `# TODO: FIX MEMORY`），到 0.4.1 模块整个消失（§2.4.1）。

### 问题三：代码组织

1. Anthropic 与 OpenAI 沙箱都把 skill 摆成**文件系统目录**（`skills/<name>/SKILL.md` + `scripts/` `references/` `assets/`），靠目录发现来注册；生命周期由宿主（Claude Code / API container / `SandboxAgent` 的 capability）拥有（§4）。
2. memory 在 OpenAI SDK 里分成两个互不相干的模块：`src/agents/memory/`（会话历史协议 `Session`）和 `src/agents/sandbox/memory/`（跨运行经验，两阶段后台生成）。LangGraph 把 short-term 放在 checkpointer、long-term 放在 `BaseStore`（§4）。
3. 浏览器侧的 workflow 都是**独立于 agent 循环的模块**：workflow-use 按 `recorder / builder / workflow / healing / storage / schema` 分目录；Stagehand 3.x 在 `packages/core/lib/v3/cache/`；Skyvern 在 `skyvern/core/script_generations/`，另有 `workflow_script_service.py` 负责存储（§4）。
4. browser-use 的 memory 曾是 `browser_use/agent/memory/`，属于 agent 的内部组件，靠可选依赖 `browser-use[memory]` 开启，现已删除；当前的 `browser_use/skills/` 只是云端 Skills API 的客户端（§2.4）。

### 问题四：与本项目概念的对照（全部是推断）

1. **Pack.siteNotes** 最像「按域名触发、人写、整段常驻 prompt」的 semantic memory，或 Claude Code 的按路径加载 rules；**不像** Anthropic Skill：没有 description、不由模型判断触发、没有渐进加载（§5.1）。
2. **Fixed plan** 属于「确定性回放型 workflow」（workflow-use、Stagehand 缓存、browser-use rerun、Skyvern code）。它和这些方案有两处本质差别：它只高亮、不执行；它永不回落模型，而上面几家都设计了回落或自愈（§5.2）。
3. **Run record** 可以当 episodic 记忆或 workflow 归纳的原料，但它缺研究方法都要求的「每步观察 + 动作目标」。它现有的字段是 goal、终点 url、route、`steps{title,outcome}`、status、evidence、check、calls（§5.3）。
4. **Thread** 只在「线程作用域、持久化的状态」这层意义上像 LangGraph 的 short-term memory；在「累积对话历史」这层意义上不像，因为每次调用都是全新的 system+user（§5.4）。

---

## 2. 问题一：每个词在各家的含义与数据模型

每一项都按同一组问题回答：**存什么**（数据形状）/ **何时写** / **何时读**（检索触发）/ **怎么进 prompt** / **怎么评估** / **已知失败模式**。

### 2.1 Anthropic

#### 2.1.1 Agent Skills

**存什么（原文）**
- 「a skill is a directory that contains a `SKILL.md file`」，文件 「must start with YAML frontmatter that contains some required metadata: `name` and `description`」（Skills 博客）。
- 字段约束（Skills 概览 "Skill structure"）：`name` 「Maximum 64 characters」「only lowercase letters, numbers, and hyphens」「Cannot contain XML tags」「Cannot contain reserved words: "anthropic", "claude"」；`description` 「Must be non-empty」「Maximum 1024 characters」「Cannot contain XML tags」。
- 三层内容（Skills 概览 "How Skills work" 的表）：

| Level | When loaded | Token cost | Content |
|---|---|---|---|
| Level 1: Metadata | Always (at startup) | ~100 tokens per Skill | `name` and `description` from YAML frontmatter |
| Level 2: Instructions | When Skill is triggered | Under 5k tokens | SKILL.md body with instructions and guidance |
| Level 3+: Resources | As needed | None until accessed | Bundled files. Reference files load into context when read. Scripts run through bash, and only their output enters context |

- Claude Code 在规范之外还支持更多 frontmatter 字段：`when_to_use`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context: fork`、`agent`、`paths`、`hooks` 等。上传到 claude.ai 或 Skills API 时只接受 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`，其它字段会报 「Unexpected key(s) in SKILL.md frontmatter」（CC Skills "Frontmatter reference" 与 "Frontmatter for External Distribution"）。
- 规范已迁到 agentskills.io：`skills@34040c9 spec/agent-skills-spec.md` 全文只有一句 「The spec is now located at <https://agentskills.io/specification>」。模板 `skills@34040c9 template/SKILL.md` 只有 `name`、`description` 两个字段加一行 `# Insert instructions below`。

**何时写（原文）**
- 由人编写。最佳实践建议让一个 Claude 实例（"Claude A"）帮忙写，另一个实例（"Claude B"）实际使用来测试（Skills 最佳实践 "Develop Skills iteratively with Claude"）。
- 让 agent 自己写 skill 还只是展望：「Looking further ahead, we hope to enable agents to create, edit, and evaluate Skills on their own」（Skills 博客）。
- 对照：OpenAI 沙箱 memory 的第二阶段会**由 agent 写** `skills/<skill-name>/SKILL.md`（§2.2.5）。

**何时读（原文）**
- Level 1：「Claude loads this metadata at startup and includes it in the system prompt. The `description` is what Claude matches your request against when determining whether to trigger the Skill」（Skills 概览）。
- Level 2：「When you request something that matches a Skill's description, Claude reads SKILL.md from the filesystem using bash. Only then does this content enter the context window.」（Skills 概览）。
- Claude Code：「Claude loads skill descriptions into context on every turn, but full skill content only loads when invoked」；`description` 与 `when_to_use` 合起来 「truncated at 1,536 characters in the skill listing」；`paths` 字段 「Glob patterns that limit when skill activates automatically」；`disable-model-invocation: true` 时 「Description not in context」（CC Skills）。

**怎么进 prompt（原文）**
- API / 通用：元数据在 system prompt 里，示例是一行 `pdf-processing - Extract text and tables from PDF files, ...`；正文通过 `bash: cat pdf-processing/SKILL.md` 进入上下文（Skills 概览 "Example: Loading a PDF processing Skill"）。
- Claude Code：「The rendered `SKILL.md` content enters the conversation as a single message and stays across later turns」「Skill content does not reload on later turns」；自动压缩时 「keeping the first 5,000 tokens of each」（CC Skills "Skill Content Lifecycle"）。
- 体量建议：「Keep SKILL.md body under 500 lines for optimal performance」（Skills 最佳实践 "Token budgets"）。

**怎么评估**
- 概览和博客里**没找到**任何效果数字（WebFetch 对博客的抽取结论也是 "No specific effectiveness metrics"）。
- 最佳实践给的是方法而不是结果：「Create evaluations BEFORE writing extensive documentation」，步骤依次是 identify gaps → create three scenarios → establish baseline without the Skill → write minimal instructions → iterate；附了一个 JSON 评估结构（`skills`、`query`、`files`、`expected_behavior`）；并注明 「There is not currently a built-in way to run these evaluations」（Skills 最佳实践 "Build evaluations first"）。

**已知失败模式（原文）**
- 嵌套引用只被读一部分：「When encountering nested references, Claude might use commands like `head -100` to preview content rather than reading entire files」，所以要求 「Keep references one level deep from SKILL.md」。
- 描述的人称不一致会影响发现：「Always write in third person. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems」。
- 需要观察的使用问题：「Missed connections」「Overreliance on certain sections」「Ignored content」（以上均出自 Skills 最佳实践）。
- 安全：「a malicious Skill can direct Claude to invoke tools or execute code in ways that don't match the Skill's stated purpose」；「Skills that fetch data from external URLs pose particular risk」（Skills 概览 "Security considerations"）。
- 各平台互不同步：「Custom Skills do not sync across surfaces」（Skills 概览 "Limitations and constraints"）。

#### 2.1.2 Anthropic 的 memory：Claude Code 与 memory tool

**Claude Code（原文，CC Memory）**
- 两套机制：CLAUDE.md（人写，「Instructions and rules」）与 auto memory（Claude 写，「Learnings and patterns」），两者都 「loaded at the start of every conversation」。
- auto memory 的形状：`~/.claude/projects/<project>/memory/` 下一个 `MEMORY.md` 索引（「one line per memory」）加若干主题文件；frontmatter 的 `type` 取值为 `user` / `feedback` / `project` / `reference`。
- 读取：「The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation」；主题文件 「reads them on demand」。
- 写入：「Claude doesn't save something every session. It decides what's worth remembering」；「Claude skips anything it can derive from the codebase」。写入时会记录 `modified` 时间戳。
- 进 prompt 的位置：「CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself」。
- 按路径加载的规则：`.claude/rules/*.md` 带 `paths` frontmatter，「only apply when Claude is working with files matching the specified patterns」。

**Claude API memory tool（原文，Memory tool）**
- 「The memory tool operates client-side: Claude requests file operations, and your application executes them」。命令有 `view / create / str_replace / insert / delete / rename`，路径前缀为 `/memories`。
- 读取：「When the memory tool is enabled, Claude automatically checks its memory directory before starting a task」。API 会自动往 system prompt 加一段 `IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE. ... ASSUME INTERRUPTION: Your context window might be reset at any moment`。
- 失败模式与防护：路径穿越（「A malicious path such as `/memories/../../secrets.env`」）；建议做 「Memory expiration」与文件大小上限。
- 评估：文档里**没找到**效果数字。

### 2.2 OpenAI Agents SDK

#### 2.2.1 Sessions（会话历史 = short-term memory）

- **存什么（源码）**：`oai@1705dd6 src/agents/memory/session.py:43-83` 定义 `Session` 协议：`session_id: str`、`session_settings`、`get_items(limit)`、`add_items(items)`、`pop_item()`、`clear_session()`。docstring 写着 「Session stores conversation history for a specific session」。存的是 `TResponseInputItem` 列表，也就是用户输入、助手回复、工具调用这些原始 item。
- **何时写 / 何时读（原文，OAI docs sessions）**：「Before each run: The runner automatically retrieves the conversation history for the session and prepends it to the input items」；「After each run: All new items generated during the run (user input, assistant responses, tool calls, etc.) are automatically stored in the session」。
- **怎么进 prompt**：前置到输入 item 列表。`SessionSettings(limit=N)` 只取最近 N 条；`session_input_callback` 自定义历史与新输入的合并方式（OAI docs sessions；实现位于 `oai@1705dd6 src/agents/run_internal/session_persistence.py:197`、`:354-416`）。
- **实现**：`SQLiteSession`、`RedisSession`、`SQLAlchemySession`、`MongoDBSession`、`OpenAIConversationsSession`、`OpenAIResponsesCompactionSession`（「compact stored conversation history with the Responses API」）、`EncryptedSession`、`AdvancedSQLiteSession`（OAI docs sessions）。
- **评估 / 失败模式**：在这些来源里没找到。

#### 2.2.2 Handoffs

- 原文（OAI docs handoffs）：「Handoffs are represented as tools to the LLM. So if there's a handoff to an agent named `Refund Agent`, the tool would be named `transfer_to_refund_agent`」；新 agent 「gets to see the entire previous conversation history」；可以用 `input_filter` 改写传过去的历史；`nest_handoff_history` 是默认关闭的 beta，作用是 「compacts summarizable history into ordered assistant summary segments」。
- 与这三个词的关系：handoff 是**由模型选择**的路由，不是确定性 workflow。它和 memory 的交集只在「交接时带多少历史」这一点（推断）。

#### 2.2.3 Guardrails

- 原文（OAI docs guardrails）：「Input guardrails run only for the first agent in the chain」「Output guardrails run only for the agent that produces the final output」；输入 guardrail 默认与 agent 并行运行，也可设为阻塞；tripwire 触发时抛 `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered`；tool guardrails 「wrap FunctionTool instances」。
- 与 skills / workflows / memory 的直接关联：在这些来源里没找到。

#### 2.2.4 Sandbox Skills capability（beta）

- **存什么（源码）**：`oai@1705dd6 src/agents/sandbox/capabilities/skills.py:122-128` 定义 `SkillMetadata(name, description, path)`。注入给模型的开场白（`:28-32`）是：「A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path」。
- **何时读（源码原文，`:48-82`）**：「If the user names a skill ... OR the task clearly matches a skill's description shown above, you must use that skill for that turn. ... Do not carry skills across turns unless re-mentioned.」渐进加载的步骤是：「After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow」；「load only the specific files needed ... don't bulk-load everything」；「If `scripts/` exist, prefer running or patching them」。
- 懒加载模式（`:84-119`）：「call `load_skill` for that skill first, then open its `SKILL.md`」；文档里对应 `LocalDirLazySkillSource`（`oai@1705dd6 docs/sandbox_agents.md:42-72`）。
- **推断**：这与 Anthropic 的 Skill 是同一种形状（目录 + SKILL.md + 按描述触发 + 渐进加载）；不同之处是 OpenAI 把「触发规则」写成了 SDK 注入的提示词文本。
- **评估 / 失败模式**：在这些来源里没找到数字；提示词里自带一条兜底：「If a skill can't be applied cleanly ... state the issue, pick the next-best approach, and continue」。

#### 2.2.5 Sandbox Memory capability（beta，跨运行经验）

- **定位（原文，`oai@1705dd6 docs/sandbox/memory.md`）**：「It is separate from the SDK's conversational `Session` memory, which stores message history. Memory distills lessons from prior runs into files in the sandbox workspace.」
- **存什么（原文目录布局）**：`sessions/<rollout-id>.jsonl` 存原始运行记录；`memories/` 下有 `memory_summary.md`、`MEMORY.md`、`rollout_summaries/<rollout-id>_<slug>.md`、`skills/`，以及中间产物 `raw_memories.md`、`phase_two_selection.json`、`raw_memories/<rollout-id>.md`。
- **何时写（原文）**：「After a run finishes, the sandbox runtime appends that run segment to a conversation file. Accumulated conversation files are processed when the sandbox session closes.」分两个阶段：
  - Phase 1 逐条抽取 rollout，产出 `{"rollout_summary","rollout_slug","raw_memory"}`。提示词的质量闸门是：「"Will a future agent plausibly act better because of what I write here?"」；「No-op is allowed and preferred」（`oai@1705dd6 src/agents/sandbox/memory/prompts/rollout_extraction_prompt.md`）。
  - Phase 2 做合并，写 `MEMORY.md`、`memory_summary.md`、`skills/<skill-name>/`（`.../memory_consolidation_prompt.md`）。
  - 默认模型：`phase_one_model = "gpt-5.4-mini"`，`phase_two_model = "gpt-5.5"`（`oai@1705dd6 src/agents/sandbox/config.py:48`、`:59`）。
- **何时读 / 怎么进 prompt（源码）**：`capabilities/memory.py:15` 定义 `_MEMORY_SUMMARY_MAX_TOKENS = 15_000`；`:50-89` 读 `memory_summary.md`，截断后渲染进 instructions。文档原文：「At the start of a run, the SDK injects a small summary (`memory_summary.md`) ... into the agent's developer prompt」，之后 agent 自己用 shell 搜 `MEMORY.md`。读取提示词给的预算是 「ideally <= 4-6 search steps before main work」（`.../memory_read_prompt.md`）。
- **遗忘（原文）**：「If recent raw memories exceed `max_raw_memories_for_consolidation` (defaults to 256), Phase 2 keeps only memories from the newest conversations and removes older ones.」（`docs/sandbox/memory.md`；`config.py:45`）
- **过期（原文）**：「Memory can become stale. Agents are instructed to treat memories as guidance only and trust the current environment.」`live_update` 默认 `True`（`config.py:125-129`），允许 agent 在运行中修正 `MEMORY.md`。
- **评估**：在这些来源里没找到数字。

### 2.3 LangGraph / LangChain / LangMem

- **short-term 与 long-term（原文，LG 概念）**：short-term 是 「thread-scoped memory, tracks the ongoing conversation by maintaining message history within a session」，用 checkpointer 持久化状态；long-term 「stores user-specific or application-level data across sessions and is shared across conversational threads」，按自定义 namespace 组织。
- **Store 的数据形状（源码）**：`langgraph@e539ac1 libs/checkpoint/langgraph/store/base/__init__.py`：`class Item`（`:51`），`namespace: tuple[str, ...]`；`class BaseStore`（`:708`）；`get(namespace, key)`（`:756`）；`search(...)`（`:779`）；`put(namespace, key, value, ..., ttl=...)`（`:856`）。TTL 需要子类显式声明 `supports_ttl = True`（`:724-727`）。文档把它比作 「a custom namespace (similar to a folder) and a distinct key (like a file name)」（LG 概念）。
- **三分法（原文，LangMem 概念表）**：

| Memory Type | Purpose | Agent Example | Storage |
|---|---|---|---|
| Semantic | Facts & Knowledge | User preferences; knowledge triplets | Profile or Collection |
| Episodic | Past Experiences | Few-shot examples; conversation summaries | Collection |
| Procedural | System Behavior | Core personality and response patterns | Prompt rules or Collection |

  - semantic 分两种：Collection 「grow unbounded」，需要处理冲突；Profile 是 「a single document that represents the current state」，新信息来了就更新这一份（LangMem 概念）。
  - episodic：「preserves successful interactions as learning examples」，要捕捉 「the situation, the thought process that led to success, and why that approach worked」（LangMem 概念）。LG 概念文档说它通常实现为 「few-shot example prompting」。
  - procedural：LangMem 用 prompt 优化实现。`langmem@9d033b4 src/langmem/prompts/__init__.py:1-17` 列出 `create_prompt_optimizer(model, kind="metaprompt"|"gradient"|"prompt_memory")`。LG 概念文档的描述是 「Reflection」 或 meta-prompting：「prompting the agent with its current instructions...along with recent conversations」。
- **何时写（原文）**：分两条路。「Hot Path」在对话中实时提取，会增加延迟；「Background」在事后或空闲一段时间后处理（LangMem 概念；LG 概念同义）。
- **何时读 / 怎么进 prompt**：LangMem 提供 `create_manage_memory_tool`（`langmem@9d033b4 src/langmem/knowledge/tools.py:25`）和 `create_search_memory_tool`（`:362`），读写可以由**模型通过工具调用**发起；也可以由开发者代码调 `store.search` 自己拼进 prompt。LangMem 文档没有规定放在哪条消息、给多少 token——在这些来源里没找到。
- **写入器接口（源码）**：`langmem@9d033b4 src/langmem/knowledge/extraction.py:536-545` 定义 `create_memory_manager(model, *, schemas=(Memory,), instructions=..., enable_inserts=True, enable_updates=True, enable_deletes=False)`。注意删除默认是关的。
- **评估**：LangMem 官方文档没找到数字。Mem0 论文把 LangMem 当作 LOCOMO 上的基线之一（Mem0 §4 "Baselines"），但那是对话记忆，不是网页任务。
- **失败模式（原文）**：Collection 需要 「manage conflicts by updating or deleting outdated entries」（LangMem 概念）。其余在这些来源里没找到。

### 2.4 browser-use（含 workflow-use）

#### 2.4.1 memory：用 mem0 生成的 "procedural memory"——已关闭、已删除

**版本史（源码）**

| 版本 | 状态 | 出处 |
|---|---|---|
| `0.1.41` | 已有 `browser_use/agent/memory/`；`enable_memory: bool = False`，`memory_interval: int = 10` | `bu@0.1.41 browser_use/agent/service.py:150-153` |
| `0.2.7` | 默认开启 `enable_memory: bool = True`；文档写着 「Browser Use includes a procedural memory system using Mem0 that automatically summarizes the agent's conversation history at regular intervals to optimize context window usage during long tasks.」 | `bu@0.2.7 browser_use/agent/service.py:169`；`bu@0.2.7 docs/customize/agent-settings.mdx:229-251` |
| `0.3.2` | 仍然开启（`if self.enable_memory:`） | `bu@0.3.2 browser_use/agent/service.py:304` |
| `0.3.3` | 被硬关：`# TODO: FIX MEMORY` / `if self.enable_memory and False:` | `bu@0.3.3 browser_use/agent/service.py:308-309` |
| `0.4.1` | `browser_use/agent/` 下已无 `memory/`，但 `pyproject.toml:20` 仍声明 `"mem0ai>=0.1.106"` | 目录列表；`bu@0.4.1 pyproject.toml:20` |
| `0.13.10`（当前） | 全仓库搜不到 `mem0` | `bu@50f2055` 全文搜索 |

`0.4.0` 的 tarball 下载失败，所以只能确定删除发生在 0.3.3 之后、0.4.1 之前（含 0.4.1）。删除原因：在代码和 release 摘要里都没找到，只有 `# TODO: FIX MEMORY` 这一条旁注。

**存什么（源码，`bu@0.3.3 browser_use/agent/memory/views.py`）**
- `MemoryConfig` 的字段有 `agent_id`、`memory_interval`（默认 10，`gt=1, lt=100`，`:16-17`），嵌入器默认 `huggingface` / `all-MiniLM-L6-v2` / 384 维（`:20-22`），向量库默认 `faiss`，路径 `/tmp/mem0`（`:29-53`）。
- 实际被使用的内容是一段文本摘要，形状由 mem0 的提示词决定（见下）。

**何时写（源码）**
- 每走 `memory_interval` 步触发一次：`if self.enable_memory and self.memory and self.state.n_steps % self.memory.config.memory_interval == 0: self.memory.create_procedural_memory(self.state.n_steps)`（`bu@0.3.3 browser_use/agent/service.py:653-655`；`bu@0.1.41 .../service.py:409-411` 相同）。

**怎么生成（源码）**
- `bu@0.3.3 browser_use/agent/memory/service.py:110-165`：保留 `message_type in {'init','memory'}` 的消息，其余消息（至少 2 条）交给 `self.mem0.add(messages=..., agent_id=..., memory_type='procedural_memory', metadata={'step': current_step})`（`:167-181`），拿回的文本包成**一条 `UserMessage`**（`message_type='memory'`），**替换掉**被处理的那些消息。
- 一个小不一致：超时设的是 `future.result(timeout=5)`（`:143`），日志文本却写 「timed out after 30 seconds」（`:145`）。
- mem0 那边的实现：`mem0@c7ee362 mem0/memory/main.py:1993-2035` 的 `_create_procedural_memory` 用系统提示词 `PROCEDURAL_MEMORY_SYSTEM_PROMPT` 加上 「Create procedural memory of the above conversation.」 生成摘要，再做嵌入存库。提示词原文（`mem0@c7ee362 mem0/configs/prompts.py:326-359`）：「You are a memory summarization system that records and preserves the complete interaction history ... **Every output produced by the agent must be recorded verbatim as part of the summary.**」要求逐步记录 「Agent Action」「Action Result (Mandatory, Unmodified)」「Navigation History」等。

**何时读（源码）**
- browser-use 的 memory 模块里只调用了 `mem0.add`，**没有任何 `search` 调用**（`bu@0.3.3 browser_use/agent/memory/service.py` 全文）。生成的摘要直接留在当前消息历史里；存进向量库的那份在这些代码里没有被读回。
- **推断**：这个 "procedural memory" 实质上是**单次运行内的上下文压缩**，不是跨会话记忆。

**当前版本里剩下的「memory」（源码）**
- `AgentOutput` 里每步有一个 `memory` 字段（`bu@50f2055 browser_use/agent/service.py:117-119` 打日志）；`ActionResult.long_term_memory` 会被拼进下一步的 action results（`bu@50f2055 browser_use/agent/message_manager/service.py:335-337`）。两者都只在同一次运行内有效。

**评估**：在这些来源里没找到任何效果数字。

#### 2.4.2 browser-use 自己的「确定性回放」：`rerun_history`

- **存什么**：`AgentHistoryList`（`bu@50f2055 browser_use/agent/views.py:590`），可以 `save_to_file` / `load_from_file`（`:622`、`:690`）。每步记录模型输出、动作，以及被交互元素 `DOMInteractedElement`（`browser_use/dom/views.py:982`）。
- **回放（源码，`bu@50f2055 browser_use/agent/service.py:3103-3134`）**：`rerun_history(history, max_retries=3, skip_failures=False, ...)`。元素重新定位采用逐级匹配（`:3529-3544` 的 docstring）：「1. EXACT: Full element_hash match ... 2. STABLE: Hash with dynamic CSS classes filtered out ... 3. XPATH ... 4. AX_NAME: Accessible name match from accessibility tree ... 5. ATTRIBUTE: Unique attribute match (name, id, aria-label)」。
- 变量替换：`load_and_rerun(history_file, variables)`（`:3881-3907`）。`browser_use/agent/variable_detector.py` 的做法（`:9-18` docstring）是：先看元素属性（id、name、type、placeholder、aria-label），再看值的格式（email、电话、日期）。
- 评估：在这些来源里没找到数字。

#### 2.4.3 browser-use 的「skills」：两样不同的东西

1. **云端 Skills（可执行 API）的客户端**：`bu@50f2055 browser_use/skills/`。`SkillService` 从 Browser Use API 拉取技能（`service.py`）。`Skill` 模型的字段是 `id / title / description / parameters / output_schema`（`views.py:23-47`）。Agent 构造参数 `skills` / `skill_ids`（`agent/service.py:146-149`、`:335-348`）；`_register_skills_as_actions` 把每个技能注册成**一个独立 action**，执行时把浏览器 cookies 一并传给云端（`:836-900`）。用通配符 `'*'` 时 「limited to first 100 skills」（`skills/service.py`）。
   - 官方文档（https://docs.browser-use.com/cloud/legacy/skills）已把它标为 legacy：「Existing skills still run; new skills are no longer created」；`skills.create`、`skills.refine` 返回 `410 Gone`；替代方案是 「rerunnable scripts. A Cloud agent learns the task once and saves the working code in its workspace, so every later run reuses it.」（该页经 WebFetch 抽取，逐字性以原页为准。）
2. **Anthropic 风格的 SKILL.md（给外部 coding agent 用的 CLI 说明书）**：`bu@50f2055 browser_use/skills/browser-use/SKILL.md`，frontmatter 有 `name: browser-use`、`description: ...`。其中 「Domain skills are off by default. Set `BH_DOMAIN_SKILLS=1`」，开启后 「read every file in the matching `$BH_AGENT_WORKSPACE/domain-skills/<site>/` directory before inventing an approach」；「`goto_url(...)` returns up to 10 skill filenames for the navigated host」（`:32-34`、`:229-231`）。**推断**：这是「按主机名分目录的站点知识」，由导航动作触发列出文件名。

#### 2.4.4 workflow-use：录制 → 生成 → 确定性回放

- **定位（原文，`wfu@5d2d19f README.md`）**：「create and execute deterministic workflows with variables which fallback to Browser Use if a step fails」（`:15`）；「This project is in very early development so we don't recommend using this in production」。
- **存什么（源码，`wfu@5d2d19f workflows/workflow_use/schema/views.py`）**：
  - `WorkflowDefinitionSchema` 包含 `workflow_analysis`、`name`、`description`、`version`、`default_wait_time`、`steps`（至少 1 步）、`input_schema`（`:216-238`）。校验器要求最后一步是 extract（`:240` 起 `validate_ends_with_extract`）。
  - 步骤类型分确定性和 agent 两类：`navigation / click / input / select_change / key_press / scroll / go_back / go_forward / extract_page_content / extract`，以及 `agent`（`:79-182`）。
  - 元素定位：`target_text` 标为 「PRIMARY: Text-based semantic targeting (non-brittle)」，辅以 `container_hint`、`position_hint`、`interaction_type`；`cssSelector`、`xpath`、`elementHash` 标为 `[LEGACY]`；另有 `selectorStrategies` 作为多策略回退（`:30-60`）。
  - 每步可带 `verification_checks` 与 `expected_outcome`（`:12-20`）。
- **何时写（源码）**：两条路。
  - 人工录制：Chrome 扩展用 `rrweb.record` 加 `click/input/change/keydown/...` 监听（`wfu@5d2d19f extension/src/entrypoints/content.ts:1-2`、`:122`、`:206-213`），把录到的事件交给 LLM builder。builder 的提示词要求把「经常变化的内容」改成 `"type": "agent"` 步骤，并把输入参数化为 `{input_name}`（`workflows/workflow_use/builder/prompts.py`）。
  - 生成模式：「browser-use completes the task once」→ 「Execution history → semantic workflow with parameters」（README "How It Works"）。`docs/DETERMINISTIC.md` 描述了一种不用 LLM、直接把动作映射成步骤的转换器（`healing/deterministic_converter.py`）。
- **存在哪（原文）**：`workflows/storage/metadata.json`（索引）加上 `workflows/<id>.workflow.json`（README "Storage"）。
- **何时读 / 执行（源码，`wfu@5d2d19f workflows/workflow_use/workflow/service.py`）**：
  - `_execute_step`（`:630-720`）的分支：extract 步走轻量 LLM 抽取；click/input 步若没有 `cssSelector` 但有 `target_text`，走 `SemanticWorkflowExecutor`；其余走确定性控制器。
  - 失败时直接 `raise`。回落 agent 的代码**被注释掉了**（`:691-696`）；agent 步失败抛出的异常文本是 「(Agent fallback is disabled)」（`:709`）。构造参数 `fallback_to_agent: bool = True`（`:50`）仍在，但没有生效路径。
  - README 路线图自己写着：「Improve LLM fallback when step fails (currently really bad)」（`:251`）。
- **评估**：只有 `docs/DETERMINISTIC.md` 的一张对比表（生成速度 5-10s 对 20-40s、每次执行成本 $0 对 $0.03-0.30），没有成功率数字。

### 2.5 Stagehand

- **act 缓存与 agent 缓存（原文，`sh@9f4f878 packages/docs/v3/best-practices/caching.mdx`）**：
  - Browserbase 服务端缓存：「The cache key is generated from the instruction, page content, and options you pass. On a cache hit, the response is returned directly from the server with no LLM inference and no token cost」。
  - 本地缓存：「When you specify a `cacheDir`, Stagehand saves every action and agent step to a local file on first run, then replays those cached actions on subsequent runs with no LLM calls」。
  - agent 缓存键：「instruction, start URL, agent execution options, and agent configuration」。
  - 变量：「The cache key is built from the variable *keys*, not the values」。
- **数据形状（源码，`sh@3.7.3 packages/core/lib/v3/types/private/cache.ts:76-84`）**：`CachedActEntry { version: 1; instruction; url; variableKeys: string[]; actions: Action[]; actionDescription?; message? }`。agent 回放步骤是一个联合类型，包括 `act / fillForm / goto / scroll / wait / navBack / keys`（`:86-120`）。
- **缓存键（源码）**：`sh@3.7.3 packages/core/lib/v3/cache/ActCache.ts:188-199` 对 `JSON.stringify({instruction, url, variableKeys})` 取 sha256。`AgentCache.ts:526-540` 同理，取的是 `{instruction, startUrl, ..., configSignature}`。
- **自愈 / 回写（源码）**：`ActCache.ts:264-275`：回放成功且 `haveActionsChanged(entry.actions, actions)` 时调 `refreshCacheEntry`，把新动作写回。`AgentCache.ts:580-618`：回放各步，只要有一步变化就 `refreshAgentCacheEntry`。本地存储是 `cacheDir` 下的 JSON 文件（`CacheStorage.ts:22-30`、`:62-91`）。
- **v4（当前 main）**：`sh@9f4f878 packages/docs/v4/migrations/v3.mdx:507-516`：「`enableCaching` is gone. v4 caches `act()`, `observe()`, and `extract()` results on Browserbase's servers instead, keyed on the instruction, page content, and options」；`packages/docs/v4/basics/act.mdx:350`：「`cache` requires a Browserbase browser and a Browserbase API key. It has no effect on local browsers.」main 分支 `packages/sdk-ts/src` 里搜不到 `cacheDir`。v4 是否保留本地 `cacheDir`：没核实。
- **评估（文档陈述，非基准）**：「Cached agent workflows run 10-100x faster」；示例注释里写 「First run: Uses LLM inference (~20-30 seconds, ~50,000 tokens) / Subsequent runs: Uses cached actions (~2-3 seconds, 0 tokens)」（`packages/docs/v3/best-practices/deterministic-agent.mdx`）。
- **失败模式（原文）**：「The page URL factors in to the cache key. If the action is being made on a page with a dynamic URL, caching may not work as expected」；「If the page content or structure changes, the action won't get a cache `HIT` and the LLM will be called」；分析脚本、A/B 测试、广告 「can inject DOM nodes that shift the cache key on every load」（caching.mdx）。
- skills / memory：Stagehand 文档与源码里都没找到这两个概念。

### 2.6 Skyvern

- **workflow 是什么（原文，`sky@35cfb31 fern/workflows/introduction.mdx`）**：「Skyvern's workflow consists of a sequence of workflow blocks」。定义格式是 YAML（「All of our workflows are defined in **YAML** format」，`fern/workflows/creating-workflows.mdx`），通过 `POST api.skyvern.com/api/v1/workflows` 创建，存在服务端。
- **数据形状（源码）**：`sky@35cfb31 skyvern/schemas/workflows.py:475-505` 的 `BlockType` 共 31 种，包括 `task / for_loop / while_loop / conditional / code / navigation / extraction / login / validation / goto_url / human_interaction / ...`。参数类型有 `workflow / context / aws_secret / output`（creating-workflows.mdx）。`AIFallbackMode`（`:509-521`）：「`fallback`: attempt the selector first; fall back to AI on failure. `proactive`: always use AI; the selector (if any) is a hint only.」
- **code caching（原文，`sky@35cfb31 docs/developers/features/code-caching.mdx`）**：
  - 「When Skyvern's agent completes a task or agent run, it records the actions it took and generates reusable code from them. ... If the cached code fails because a page changed, Skyvern falls back to the agent automatically and regenerates the cache.」
  - 用法：先 `run_with="agent"`，之后 `run_with="code"`。
  - 粒度：「Agents cache per block」。
  - 渐进缓存：「Run 1 covers branch A, run 2 covers branch B」。
  - 「Not cached: conditional evaluation blocks, wait blocks, and code blocks always run live」。
- **实现位置（原文，`sky@35cfb31 skyvern/core/script_generations/CLAUDE.md`）**：`generate_script.py`、`transform_workflow_run.py`、`skyvern/services/workflow_script_service.py`（「Caching logic, script storage」）、`skyvern/forge/sdk/workflow/service.py` 的 `generate_script_if_needed`；「ALL top-level blocks must have ... A non-null `run_signature` field. Without these, the system falls back to `run_with: agent`.」字段 `run_with: str = "agent"`（`skyvern/schemas/workflows.py:1656`），`ai_fallback: bool = True`、`generate_script_on_terminal: bool = False`（`skyvern/forge/sdk/workflow/models/workflow.py:211`、`:216`）。
- **跨运行状态**：`persist_browser_session` 「uses the same `user_data_dir` for each run and updates it at the end of each run」（creating-workflows.mdx）。**推断**：这是浏览器状态（登录态、cookie）层面的跨运行记忆，不是给模型看的记忆。
- skills、给模型看的 memory、效果数字：在这些来源里没找到。

### 2.7 研究

#### 2.7.1 Agent Workflow Memory（AWM，arXiv:2409.07429）

- **存什么（§2.2 原文）**：一条 workflow 包括 「a textual description of the workflow」 和 「a series of steps」，每步由三部分组成：「(1) A description of the current environment state in NL ... (2) The reasoning process ... (3) an action represented as an executable program」。
- **归纳方式（§2.3）**：用 LM 从经验里抽取「finer granularities」的子任务，并「replacing "dry cat food" with a more general name "{product-name}"」；按模型输出里的双换行切分后分别存储。
- 附录 A.2 的 Mind2Web 示例（原文）：
  ```
  # shopping: search_and_sort
  Given that you are on the Amazon search results page, this workflow searches for a product and sorts the results.
  [textbox] Search Amazon  ->  TYPE: {search-term}
  [button] Go  ->  CLICK
  [span] Sort by:  ->  CLICK
  [option] {sort-option}  ->  CLICK
  ```
- **何时写**：
  - offline：「takes in all training examples from a website by concatenating them into a single prompt」，测试前一次性归纳（§2.3 "Offline Scenario"）。
  - online：每道测试题做完后，用 Pan et al. (2024) 的 LM 评估器给出二值判定，判为成功才归纳并加入（§2.3 "Online Scenario"）。
  - rule 版本：按动作序列去重，再删掉不可执行的步骤（附录 B）。
- **何时读 / 怎么进 prompt**：
  - 按网站分组：「we group examples by their associated websites, and respectively run AWM on each group」（§3）。**全部** workflow 都进 memory，没有逐条检索（§2.3 offline：「the agent uses the same workflow memory」）。
  - 官方代码：WebArena 的做法是 `sys_msg += '\n\n' + open(self.flags.workflow_path).read()`，即追加到 system message（`awm@8c0ff8c webarena/agents/legacy/agent.py:116-117`），文件按站点存为 `workflow/{website}.txt`（`webarena/pipeline.py:23`、`:38`）；Mind2Web 的做法是 `memory = [[{"role": "user", "content": workflow_text}]]`，作为一条 user message（`mind2web/memory.py:15-21`）。
  - 数量：「7.3–7.4 workflows per example」（附录 A.3，表 10）。token 数：在这些来源里没找到。
- **评估**：见 §3.1 表。
- **失败模式（原文）**：
  - Action F1 下降：「the augmented workflows may guide the agent to take certain actions aligning to the workflows, which are not always relevant to the particular environment state at hand ... agents still encounter some challenges in identifying places to diverge from the workflow guidelines」（§3.2.1 "Learn to diverge from workflow guidelines"）。
  - online 的错误累积：「AWM online induces workflows from model-predicted trajectories that are not always correct, thus can lead to incorrect workflows that degrade model performance」（§3.2.2）。
  - offline 与 online 不兼容：「workflows induced offline and online are not fully compatible with each other ... the offline workflows seem to impair the generative quality and utility efficacy of online workflows」（附录 C，表 11）。
  - 把 workflow 当动作调用时：模型只在 「merely 18.5% of the tasks」 中调用；动态弹出项的场景下，「the action to choose pop-up airports is executed without seeing the intermediate states」（§5，图 7）。
  - 在 workflow 里附过滤后的 HTML 反而更差：「the filtered HTML has a substantial number of irrelevant items (missing all correct elements 47% of the time)」（§4.3，表 8）。

#### 2.7.2 SkillWeaver（arXiv:2504.07079）

- **存什么（§2 原文）**：「"API" refers to a Python function containing Playwright code for a browser automation」；每个 API 带 「a function signature, docstring, and code body」，docstring 里包含 「a usage log recording previous executions of the function and a description of the prerequisite state of the website」。
- **何时写**：离线探索网站，分三个阶段：Skill Proposal → Skill Synthesis（练习 + reward model + API 合成）→ Skill Honing（自动生成测试并调试）（§2）。
- **何时读**：「we introduce an API selection module that filters only relevant APIs from the API library. This module also removes APIs that do not satisfy pre-conditions」；选出的 API 加入动作空间（§3.3 Agent Implementation）。
- **评估**：见 §3.1。
- **失败模式（原文）**：
  - 「(1) failure to identify the appropriate API and (2) generating wrong parameters」（§4.3 "Limitation in Skill Use"）。
  - 「On websites with high API support, such as GitLab and Maps, the performance of the synthesized APIs is not as good」（§4.2，图 3）。
  - 验证标准被钻空子：「our criteria for a function to be "verified" was to have it be called without producing an exception ... malfunctioning APIs could be marked as verified simply because they silenced all exceptions」（附录 D.2.1）。

#### 2.7.3 ASI（Agent Skill Induction，arXiv:2504.06821）

- **存什么**：可执行的 skill 程序，例如 `search_product(name)`，「wrap primitive actions or prior skills as executable programs」，并加入动作空间（§1、§2.3）。
- **何时写**：online，边解题边归纳。先判断轨迹正确，再用改写后的轨迹前缀去执行验证，只有验证通过的程序才加入（§2.3 "Skill Verification"）。
- **评估**：见 §3.1。
- **失败模式与关键消融（原文）**：
  - 「ASI produced programs pass verification for only 15.6% of the turns, whereas AWM adds new skills for 31.4% of the time」（§3.3 "Verified Induction Improves End Success Rate"）。
  - 把程序放进 memory 而非动作空间会出问题：「we observe many cases where the agent tries to call the skill programs but unsuccessfully, since they are not supported in the action space」；「Textual Representations Suit Memory Better」（§3.3，表 3）。
  - 跨站：「some skills may be incompatible with alternative website designs hence less useful」（§1；§5 表 6）。
  - 思考文本被压缩：「reducing the thought content from 87.9 to 13.4 tokens per step」（§2.3）。

#### 2.7.4 Voyager（arXiv:2305.16291，Minecraft，非网页）

- **存什么（图 4 说明原文）**：「The key is the embedding vector of the program description (generated by GPT-3.5), while the value is the program itself.」
- **何时写**：「This iterative process repeats until self-verification validates the task's completion, at which point we add this new skill to the skill library」（§2.3）。
- **何时读**：「we query the skill library with the embedding of self-generated task plans and environment feedback」（§2.2）。
- **评估**：「Voyager w/o skill library exhibits a tendency to plateau in the later stages」；去掉 self-verification 让发现物品数 「significant drop (−73%)」（§3.4 消融）。
- **失败模式**：「Occasionally, self-verification module may also fail, such as not recognizing spider string as a success signal」（§4 Limitations and Future Work）。

#### 2.7.5 Mem0（arXiv:2504.19413，对话记忆，非网页）

- **存什么 / 何时写**：从对话中抽取候选事实，然后进入 update phase：「For each fact, the system first retrieves the top s semantically similar memories using vector embeddings」，再决定对每条事实执行何种记忆管理操作（§2，附录 B Algorithm 1）。
- **评估（摘要原文）**：LOCOMO 基准上，「Mem0 achieves 26% relative improvements in the LLM-as-a-Judge metric over OpenAI」；「Mem0 attains a 91% lower p95 latency and saves more than 90% token cost」（对比的是 full-context）。
- 与网页 agent 的关系：论文里没有网页任务；browser-use 用到的是 mem0 库里另一条 procedural_memory 路径（§2.4.1），不是论文评估的那条事实记忆路径（**推断**，依据是 `mem0@c7ee362 mem0/memory/main.py:794`、`:854` 对 `procedural_memory` 走单独分支）。

#### 2.7.6 ReasoningBank（arXiv:2509.25140，ICLR 2026）

- **存什么（§3.2 原文）**：每个记忆项包含 「(i) a title ... (ii) a description ... one-sentence summary ... (iii) the content, which records the distilled reasoning steps, decision rationales, or operational insights」；「abstract away low-level execution details」（§3.2 "Memory Schema"）。
- **何时写**：任务结束后，由 LLM-as-a-judge 在没有真值的情况下判定成功或失败；成功轨迹提炼策略，失败轨迹提炼「counterfactual signals and pitfalls」；每条轨迹 「at most three memory items」（§3.2；附录 A.1）。合并方式是 「newly generated items are directly added without additional pruning」（附录 A.2）。
- **何时读 / 怎么进 prompt**：用 `gemini-embedding-001` 嵌入任务查询，「top-k most similar experiences (default k=1)」；「Retrieved items are injected into the agent's system instruction」（§3.2；附录 A.2）。
- **评估**：见 §3.1。
- **失败模式 / 敏感性（原文）**：
  - 检索条数：「from 39.0 without memory to 49.7 with one experience ... 46.0 with 2, 45.5 with 3, and 44.4 with 4 ... excessive experiences may introduce conflicts or noise」（附录 C.1）。
  - 判官准确率：「72.7%」；在模拟 70%–90% 准确率时结果变化不大（§5，图 8）。

#### 2.7.7 WALT（arXiv:2510.01524）

- **存什么（摘要原文）**：「reverse-engineers latent website functionality into reusable invocable tools」，工具形如 `search(query)`、`create(listing)`，覆盖 「discovery (search, filter, sort), communication (post, comment, upvote), and content management (create, edit, delete)」。
- **评估**：见 §3.1。
- **注意**：WALT 的执行骨干含 GPT-5（§4 原文 「gains are not due to a stronger underlying LLM (GPT-5) alone」），而它表 1 里 AWM、ASI、SkillWeaver 那几行引用的是各自论文的数字（骨干分别是 GPT-4、Claude、GPT-4o）。**推断**：表 1 的横向比较跨了骨干模型。

#### 2.7.8 WebXSkill（arXiv:2604.13318，Findings of EMNLP 2026）

- **存什么 / 何时写**：从 2,500 条合成轨迹里抽取技能，「verify each skill's action sequence by executing it in a test environment and discard any skill that fails to run」（§3.1）。
- **何时读**：URL-based skill graph 检索。消融结果：「A flat-library search reaches 59.1%, DOM matching reaches 65.6%, and the proposed URL-based skill graph reaches 69.5%」（§5.2）。
- 两种部署模式：grounded（执行）与 guided（「exposing skills as procedural guidance rather than fixed scripts」，Limitations）。
- **失败模式（原文）**：
  - 「post-skill reasoning (38%) is the largest failure category ... No skill invoked (36%) means the agent bypassed available skills entirely」。
  - 「Execution reliability varies sharply by site, from 96% on Shopping down to 52% on CMS」（§5.4）。
  - Limitations：「such skills ... are tightly coupled to site-specific DOM structures and are therefore inherently difficult to transfer across sites」。

#### 2.7.9 Experience-Following（arXiv:2505.16067，非网页）

- **实验对象**：RegAgent（合成回归任务）、EHRAgent、AgentDriver、CIC-IoT Agent，骨干主要为 GPT-4o-mini（§3.1）。**不含网页 agent。**
- **发现（摘要原文）**：「high similarity between a task input and the input in a retrieved memory record often results in highly similar agent outputs」；由此带来 「error propagation」 和 「misaligned experience replay」 两个问题。
- **加入策略（§3.2 原文）**：「the add-all and some coarse addition approach exhibits flat or declining success rates」；「The fixed-memory baseline maintains strong results ... sometimes even surpassing runs guided by coarse evaluators」；严格评估器则能持续提升。
- **删除策略（§4 原文）**：「with a reliable utility evaluator, history-based deletion can improve agent performance」。

---

## 3. 问题二：网页 / 浏览器 agent 专属证据

### 3.1 正面数字（每个数字都标来源）

| 方法 | 基准 / 设置 | 基线 → 方法 | 来源 |
|---|---|---|---|
| AWM (online) | WebArena 812 题，GPT-4 | BrowserGym 23.5 → 35.5（+12.0 绝对，+51.1% 相对）；BrowserGym_ax-tree 15.0；人写 workflow 的 SteP 33.0；平均步数 7.9 → 5.9 | AWM §3.1.1，表 1 |
| AWM | WebArena 跨模板子集 | BrowserGym_ax-tree 20.5 → 33.2 | AWM §3.1.3，表 2 |
| AWM (offline) | Mind2Web cross-task，GPT-4 | Elem Acc 41.6→50.6；Step SR 36.2→45.1；task SR 2.0→4.8；**Action F1 60.6→57.3（下降）** | AWM §3.2.1，表 3 |
| AWM (online) | Mind2Web cross-website / cross-domain Step SR | 30.1→33.9 / 18.6→35.5 | AWM §3.2.2，表 4 |
| SkillWeaver | WebArena，GPT-4o | 22.6 → 29.8（+32% 相对）；GPT-4o-mini 9.2 → 14.1 | SkillWeaver 表 1 |
| SkillWeaver | 4 个真实网站（Online-Mind2Web 抽样） | 40.2 → 56.2；其中 Car 11.1 → 11.1（无变化） | SkillWeaver 表 2 |
| ASI | WebArena，Claude | vanilla 32.7 / AWM 36.3 / ASI 40.4；步数 5.6 / 5.9 / 5.0 | ASI §3.2，表 1 |
| ASI | 长程组合任务 | 例：Shopping vanilla 41.7 / AWM 68.3 / ASI 100.0 | ASI §4，表 4 |
| ReasoningBank | WebArena 684 题（去掉 Map） | 相对无记忆 +8.3（Gemini-2.5-flash 40.5→48.8）、+7.2（pro 46.7→53.9）、+4.6（Claude-3.7 41.7→46.3） | ReasoningBank §4.2，表 1 |
| WALT | WebArena / VisualWebArena | 50.1 / 52.9；自家不带工具的基线在 VWA 上相对最多 +30.7% | WALT §4，表 1、图 3 |
| WebXSkill | WebArena，GPT-5 | vanilla 59.7 → grounded 69.5 | WebXSkill 表 2 |
| WebXSkill | WebVoyager（11 个在线站点），GPT-5 | vanilla 71.9 → grounded 86.1 | WebXSkill 表 3 |

### 3.2 负面 / 不利结果

| 现象 | 数字 | 来源 |
|---|---|---|
| workflow 引导损害「何时偏离」的判断 | Mind2Web Action F1 60.6 → 57.3（AWM offline） | AWM §3.2.1，表 3 |
| offline 与 online workflow 叠加反而更差 | Mind2Web cross-task task SR：offline 4.8，online 4.0，叠加 1.6 | AWM 附录 C，表 11 |
| 跨域时 offline workflow 的 task SR 低于无 workflow | cross-domain task SR：MindAct 1.0 → AWM_offline 0.7 | AWM 表 4 |
| workflow 附上过滤后的 HTML 反而下降 | GPT-3.5 Step SR：只有描述 34.6，描述加 HTML 32.9 | AWM §4.3，表 8 |
| 把 workflow 做成可调用动作，模型很少用 | 只有 18.5% 的任务调用；task SR 4.8 → 3.6 | AWM §5，表 9 |
| 更强骨干下 AWM 低于无记忆 | Claude-3.7：No Memory 41.7 → AWM 40.8；Mind2Web cross-domain SSR（flash）31.9 → 30.1 | ReasoningBank 表 1、表 3 |
| 跨站点时记忆坍塌 | WebArena Multi（29 题）：flash 10.3 → AWM 3.4；pro 6.9 → 3.4 | ReasoningBank 表 1；§4.2 原文 「strong baselines such as AWM fail to provide gains and even degrade in this setting」 |
| 把失败轨迹喂给 success-only 方法反而更差 | AWM 44.4 → 42.2（WebArena-Shopping） | ReasoningBank §5，图 7 |
| 检索更多经验反而更差 | k=1 49.7 → k=4 44.4 | ReasoningBank 附录 C.1 |
| 已发表的技能方法在 GPT-5 下低于 vanilla | vanilla 59.7；SkillWeaver 37.4；WALT 42.9（原始实现，由 WebXSkill 作者复现）。原文：「SkillWeaver and WALT in their original implementations are inferior to MAP」 | WebXSkill 表 2，§4.2 |
| 可执行技能难以跨站 | 「tightly coupled to site-specific DOM structures」 | WebXSkill Limitations；ASI §1、§5 |
| 技能执行可靠性差距大 | Shopping 96%，CMS 52% | WebXSkill §5.4 |
| 程序技能放进记忆而非动作空间 | 同为 verified：program 进 memory 36.4 < text 进 memory 39.0 < 作为 action 40.1（Shopping 站） | ASI §3.3，表 3 |
| 真实网站：技能对最后几步无帮助 | Car 站 11.1 → 11.1；「the agent still encountered failures during the final steps that demanded strong environment understanding」 | SkillWeaver §4.1，表 2 |
| 在线站点本身会过期 | 「exclude Allrecipes, Booking, Google Flights, and Google Search because site changes or reCAPTCHA make their tasks invalid」 | WebXSkill §4.1 |
| 缓存随页面变化失效 | 动态 URL、页面结构变化都会导致 MISS | Stagehand caching.mdx "Limitations" |
| 工业侧 memory 被关、被删 | browser-use 0.3.3 `and False`，0.4.1 删除 | §2.4.1 |
| 工业侧 workflow 回落被关 | workflow-use 的回落 agent 代码被注释；README 自述 「currently really bad」 | §2.4.4 |

### 3.3 可比性警告（推断）

- ReasoningBank 与 WebXSkill 表里的 AWM、SkillWeaver、WALT 数字都是**第三方复现**，与原论文的骨干、题集（ReasoningBank 去掉了 Map）、提示词都不同，不能直接和原论文的数字比。
- 所有 WebArena 数字都是 agent **执行动作**时的端到端成功率；Mind2Web 是**离线逐步**元素预测。和本项目「每步选一个 ref、由人执行」最接近的是 Mind2Web 的 Elem Acc / Step SR，而不是 WebArena 的 SR。
- 在「只指路不执行」的设置下测过 memory、workflow 或 skill 的研究：在这些来源里没找到。

---

## 4. 问题三：代码组织

| 框架 | skills 放哪 / 格式 | workflows 放哪 / 格式 | memory 放哪 / 格式 | 注册方式 | 生命周期归谁 |
|---|---|---|---|---|---|
| Anthropic Claude Code | `~/.claude/skills/<name>/SKILL.md`、`.claude/skills/<name>/SKILL.md`、嵌套的 `<subdir>/.claude/skills/`、插件的 `<plugin>/skills/<name>/SKILL.md`；辅助文件放在 `scripts/`、`reference.md` 等（CC Skills "Where Skills Live"） | 没有独立 workflow 概念；「Task content」类 skill 设 `disable-model-invocation: true` 当手动流程用（CC Skills "Skill Content Types"） | `CLAUDE.md` 层级 + `.claude/rules/*.md`；auto memory 放在 `~/.claude/projects/<project>/memory/MEMORY.md` + 主题文件（CC Memory） | 目录发现；文件监听，改动即时生效（「Live Change Detection」） | Claude Code 宿主 |
| Anthropic API | `/v1/skills` 上传；请求里 `container` 带 `skill_id`；依赖 code execution tool（Skills 概览） | — | memory tool：开发者实现 `/memories` 处理器，存储自选（Memory tool） | API 上传 / 工具声明 | 开发者应用 |
| anthropics/skills 仓库 | `skills/<name>/`（如 `pdf/`、`skill-creator/`）、`spec/agent-skills-spec.md`（指向 agentskills.io）、`template/SKILL.md`（`skills@34040c9` 目录） | — | — | — | — |
| OpenAI Agents SDK | `src/agents/sandbox/capabilities/skills.py`；运行时 skill 放在沙箱内 `skills_path`，可从宿主 `LocalDir` 懒拷入（`docs/sandbox_agents.md:42-72`） | 没有 workflow 模块；`src/agents/handoffs/` 是模型选择的路由 | 会话：`src/agents/memory/`（`session.py`、`sqlite_session.py`、`openai_conversations_session.py`、`openai_responses_compaction_session.py`）。经验：`src/agents/sandbox/memory/`（`manager.py`、`phase_one.py`、`phase_two.py`、`storage.py`、`prompts/*.md`）+ `capabilities/memory.py` | `SandboxAgent(capabilities=[Memory(), Skills(...), Shell(), Filesystem()])`；会话通过 `Runner.run(..., session=...)` 传入 | 会话由 runner 每轮读写；沙箱 memory 由 `SandboxMemoryGenerationManager`（`manager.py:43`）按会话持有，运行后入队，会话关闭时 flush（`:72-146`） |
| LangGraph / LangMem | — | —（LangGraph 的图本身是开发者写的流程，不在本题范围） | short-term：checkpointer（按 thread）；long-term：`BaseStore`（`langgraph@e539ac1 libs/checkpoint/langgraph/store/base/__init__.py:708`）。LangMem：`src/langmem/knowledge/{extraction.py,tools.py}`（semantic / episodic）、`src/langmem/prompts/{optimization.py,metaprompt.py,gradient.py}`（procedural）、`src/langmem/short_term/summarization.py` | store 实例交给图或工具；memory 工具交给 agent | 开发者：hot path（工具）或 background（独立任务） |
| browser-use | `browser_use/skills/`（云 API 客户端 + 给外部 agent 的 `browser-use/SKILL.md`）；站点知识放 `$BH_AGENT_WORKSPACE/domain-skills/<host>/` | `Agent.rerun_history` / `load_and_rerun`（`browser_use/agent/service.py:3103`、`:3881`）+ `variable_detector.py`；历史存为 `AgentHistory.json` | 曾有 `browser_use/agent/memory/{service.py,views.py}`（0.1.41–0.3.3，可选依赖 `browser-use[memory]`），现已删除 | Agent 构造参数（`skills=`、`enable_memory=`） | Agent 实例 |
| workflow-use | — | `workflows/workflow_use/{recorder,builder,workflow,healing,storage,schema,controller,mcp}`；录制扩展在 `extension/`；可视化在 `ui/`；文件为 `*.workflow.json` / `*.workflow.yaml`；索引为 `storage/metadata.json` | — | CLI（`cli.py create-workflow / generate-workflow / run-workflow-no-ai / run-stored-workflow`） | `Workflow` 执行器；存储由 `WorkflowStorageService` 负责 |
| Stagehand 3.x | — | 缓存即回放：`packages/core/lib/v3/cache/{ActCache.ts,AgentCache.ts,CacheStorage.ts,serverAgentCache.ts}`；类型在 `types/private/cache.ts`；文件为 `cacheDir` 下的 JSON | — | 构造参数 `cacheDir` / `serverCache` | `Stagehand` 实例；命中则回放，结果变化则回写 |
| Stagehand 4.x（main） | — | 服务端缓存（仅 Browserbase） | — | `Stagehand.create({ cache: true })` | Browserbase 服务端 |
| Skyvern | — | 定义：`skyvern/schemas/workflows.py`、`skyvern/forge/sdk/workflow/{models/,service.py}`，YAML 经 API 存数据库；代码缓存：`skyvern/core/script_generations/` + `skyvern/services/workflow_script_service.py` | 仅浏览器 profile（`persist_browser_session`） | REST API | 服务端；`generate_script_if_needed` 决定是否重新生成 |
| AWM 官方代码 | — | `webarena/workflow/<site>.txt`、`mind2web/workflow/`；归纳脚本 `webarena/induce_prompt.py`、`induce_rule.py`、`mind2web/{offline,online}_induction.py`；判官 `webarena/autoeval/` | 同左（workflow 就是 memory） | 命令行参数 `--workflow_path` | 实验 pipeline 脚本 |

**推断（仅就组织形态）**：
- 各家都没有把 skills、workflows、memory 放在同一个模块里。
- 「给模型读的知识」（Anthropic / OpenAI 的 skills、OpenAI 沙箱 memory、Claude Code memory）一律落成**文件目录 + Markdown**，并由宿主负责发现与注入。
- 「确定性回放」（Stagehand、Skyvern、workflow-use、browser-use rerun）一律落成**独立于 agent 主循环的缓存或回放模块**，只在失败时回到 agent。

---

## 5. 问题四：与本项目现有概念的对照（**全部为推断**）

本节只做概念映射，不给做法。本项目的定义以 `CONTEXT.md` 为准，字段取自下列源码。

### 5.1 Pack.siteNotes

- **本项目事实**：`src/core/packs/types.ts:11-15` 定义 `GuidePack { name; match: { domains: string[] }; siteNotes: string }`。`src/agent/plan/prompt.ts:440-449`：siteNotes 放在 **user message** 里、不可信页面块之前（`关于这个站点，你需要知道：\n${siteNotes}`）。注释说明不放 system message 是为了保住前缀缓存。
- **最像**：
  - 一份**按 namespace（域名）划分、单文档的 semantic memory**，对应 LangMem 的 「Profile」 形态：一份文档代表当前状态。
  - 在触发方式上，更像 Claude Code 的 **`.claude/rules` 加 `paths`**（确定性匹配才加载），或 browser-use 的 **`domain-skills/<host>/`**（按主机名定位）。
  - 在「常驻 prompt 的一小段摘要」这一点上，像 OpenAI 沙箱的 `memory_summary.md`。
- **站不住的映射**：
  - 说它是 Anthropic 意义上的 Skill：它没有 `description`，不由模型判断触发，没有 Level 2/3 渐进加载，也没有脚本。
  - 说它是 LangMem 意义上的 procedural memory：procedural 由 prompt optimizer 从对话中**自动改写**，siteNotes 是人写的。
  - 说它是 memory（agent 写入）：它是人写的配置性知识，更接近 CLAUDE.md，而不是 auto memory。

### 5.2 Fixed plan

- **本项目事实（CONTEXT.md）**：调用方交来的一串写好的步骤，「永不调用模型」；步骤带 `Descriptor`（role、name、scope、nth），不带 `Ref`；只在用户用过这一步的目标或按了「跳过」之后才前进。
- **最像**：确定性回放型 workflow——workflow-use 的 `run-workflow-no-ai`、Stagehand 的缓存回放、browser-use 的 `rerun_history`、Skyvern 的 `run_with="code"`。
  - `Descriptor` 与 workflow-use 的 `target_text + container_hint + position_hint`（`schema/views.py:45-60`）形状接近，与 browser-use 的 `AX_NAME` / `ATTRIBUTE` 匹配层级（`service.py:3538-3543`）也接近。
  - Fixed plan 的来源是检视器里人亲手点选（`Evidence = handpicked`），在「来自人的示范」这一点上类似 workflow-use 的人工录制。
- **与这些方案的差别（站不住的部分）**：
  1. 上面几家都**执行**动作；Fixed plan 只高亮。
  2. 它们都设计了**回到模型**的路径：Skyvern 回落 agent 并重新生成；Stagehand 在变化时回写；browser-use rerun 对 extract 步用 `ai_step_llm`；workflow-use 设计了回落（虽然当前被注释）。Fixed plan 明确「永不调用模型」，最接近的是 workflow-use 回落被注释后的实际行为。
  3. Fixed plan **不是** AWM 意义上的 workflow：AWM 的 workflow 是带占位符的抽象文本，交给模型参考；Fixed plan 从不经过模型。

### 5.3 Run record 能否成为 episodic memory 或 workflow 归纳的原料

- **本项目事实**：`src/agent/host/record.ts:19-34` 的 `RunRecord` 字段是 `runId`、`at`、`goal`、`url`（终点）、`route`、`steps: { title; outcome }[]`、`status`、`evidence`、`check`、`calls`；上限 `RUN_RECORD_CAP = 50`（`:80`）；存储键 `'run:records'`（后移至 `src/agent/host/record-store.ts`）；终态时写入（`src/agent/host/guide.ts:458`）。CONTEXT.md：「目前没有任何东西读它来影响下一次引导」。
- **各研究要求的原料**：
  - AWM 要 「an NL instruction and a trajectory of steps」，每步含观察与动作（AWM §2.1）。
  - ReasoningBank 的判官要 「user query, trajectory ... final state of the website, and model output」（附录 A.1）。
  - ASI 要可执行、可复验的动作序列。
  - OpenAI 沙箱 memory 要整段运行对话（JSONL）。
  - LangMem episodic 要 「the situation, the thought process that led to success, and why that approach worked」。
- **能对上的部分**：
  - `goal` 对应 instruction；`steps[].title` 是每步的自然语言描述，接近 AWM workflow 步骤里的「reasoning / description」部分。
  - `status`、`check`、每步 `outcome` 提供了研究方法要额外花一个 LLM 判官才能拿到的**结果信号**。其中 `confirmed` 意味着「用户点了、页面确实变了」，是真人执行留下的信号。
  - 对照：ReasoningBank 的判官准确率只有 72.7%；Experience-Following 的结论是评估器越严格，记忆越有用。
- **对不上的部分**：
  - 缺每步的**观察**（当时的元素表或页面状态）和**动作目标的身份**（Descriptor 或 ref），因此无法按 AWM 的「状态描述 → 动作」格式归纳，也无法像 Fixed plan 那样回放。
  - `confirmed` 只说明页面变了，不说明方向对了。它与 AWM online / ReasoningBank 的「任务是否成功」判定不是同一个信号。
  - 50 条上限对应一种「只保留最新」的遗忘策略，与 OpenAI 沙箱 「keeps only memories from the newest conversations」 同类；AWM 与 ReasoningBank 实验里则不删除。
- **研究证据对「原料」的附带警告**：Experience-Following 发现不加筛选地加入记忆会让成功率走平或下降；ReasoningBank 显示 k 从 1 增大后成功率反而下降；AWM online 会从错误轨迹归纳出错误 workflow（§3.2）。

### 5.4 Thread 是不是 short-term memory

- **本项目事实（CONTEXT.md、`src/agent/host/thread.ts`）**：
  - 每个标签页至多一个，存在 `storage.session` 的 `guide:{tabId}` 下，进入终态即删除。
  - 推进它的是一个纯函数归约器。
  - 每次模型调用是全新的 system+user 两条消息，历史被渲染进 user message（`prompt.ts` 注释：「History sits between the untrusted page block and the goal」）。
- **像的部分**：LangGraph 的 short-term memory 是 「thread-scoped」 并由 checkpointer 持久化状态。Thread 同样是「线程作用域、可恢复的持久状态」。
- **不像的部分**：
  - OpenAI `Session` 和 LangGraph short-term 的核心是**累积消息历史**，每轮前置到输入。Thread 不累积对话。
  - 因此 browser-use 那种「每 N 步压缩历史」的 procedural memory、OpenAI 的 `OpenAIResponsesCompactionSession`，在本项目里都没有对应物：没有东西在累积。
  - LangGraph 的 thread 默认持久存在；本项目的 Thread 在终态即删，只把摘要留给 Run record。

### 5.5 Question（页面问答）

- 无状态，不建 Thread。它在 memory 维度上对应「无 session」的单次调用。三类研究里都没有针对「页面问答」的 memory 或 skill 实验，在这些来源里没找到。

### 5.6 汇总表（推断）

| 本项目概念 | 最接近的外部概念 | 映射成立的维度 | 映射不成立的维度 |
|---|---|---|---|
| Pack.siteNotes | LangMem semantic Profile；Claude Code path-scoped rules；browser-use `domain-skills/<host>/` | 按站点作用域；人写；常驻 prompt | 不是 Anthropic Skill（无描述触发、无渐进加载）；不是 agent 写的 memory |
| Fixed plan | workflow-use 确定性 workflow；Stagehand 缓存回放；browser-use `rerun_history`；Skyvern `run_with=code` | 预写步骤 + 元素身份信息 + 零模型调用 | 不执行动作；无回落或自愈；不是 AWM 式抽象文本 workflow |
| Run record | AWM experience；ReasoningBank 轨迹；OpenAI 沙箱 rollout | 有 goal、每步自然语言、结果信号 | 缺每步观察与目标身份；`confirmed` ≠ 任务成功 |
| Thread | LangGraph short-term（thread-scoped checkpointed state） | 线程作用域、持久、可恢复 | 不累积消息历史；终态即删 |
| Evidence 轴（`walked` > `handpicked` > …） | AWM online 的成功判定、ASI 的执行验证、Experience-Following 的评估器严格度 | 都是「这条知识可信到什么程度」的标签 | 研究里的判定用于决定**是否写入**记忆；本项目 Evidence 目前只用于盖章与导出 |

---

## 6. 查不到 / 未核实的清单

- Anthropic Agent Skills、OpenAI 沙箱 Skills / Memory、LangMem、Stagehand、Skyvern、workflow-use 的**效果数字**：在这些来源里没找到。
- browser-use 删除 memory 的**原因**与精确版本（0.4.0 未读到）：没找到。
- Stagehand v4 是否保留本地 `cacheDir`：没核实；main 分支 `packages/sdk-ts/src` 里搜不到 `cacheDir`。
- Voyager 的检索条数（top-k）：本次抽取中没有核实到原文，故未写。
- Mem0 update phase 的具体操作名：本次只核实到「对每个事实检索 top s 相似记忆后决定操作」，未逐字核实操作名，故未写。
- browser-use Cloud Skills 文档页只经 WebFetch 摘要读取，逐字性以原页为准。
- 「只指路不执行」设置下的 memory / workflow / skill 实验：在这些来源里没找到。
