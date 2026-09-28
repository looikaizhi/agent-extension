# 业界和学界怎么评估 agent：指标、精确算法与评估系统怎么搭（一手来源摘录）

> 本文是**设计拷问用的原始材料**，不是方案。它做三件事：把网页 agent 基准的评分定义与评分代码抄下来并标出处；把工业界搭评估系统的官方说法抄下来；把统计做法的公式抄下来。第 5 节把这些与本产品并置，**全节都是推断**。
>
> 规则：**【原文】** 是从来源里读到的（直接引用或近乎逐句转述）。**【推断】** 是我从原文推出来的。查不到的写「在这些来源里没找到」，不写「不存在」。全文不给实现建议。
>
> 引用格式：代码写成 `仓库@短commit 路径:行号`；论文写成 `arXiv 编号+版本 §小节 / 公式号 / 表号`；网页写 URL 和抓取日期。所有来源抓取于 2026-09-11。

---

## 0. 一手来源清单（读的是哪个版本）

| 来源 | 版本 / commit | 备注 |
|---|---|---|
| WebArena 论文 | arXiv:2307.13854**v4**（2024-04-16） | |
| WebArena 代码 | `web-arena-x/webarena@dce0468`（`dce04686a56253aefba7b18a4fa0937cf1dc987b`，2025-11-26） | 下文简写 `webarena@dce0468` |
| VisualWebArena 论文 / 代码 | arXiv:2401.13649**v2** / `web-arena-x/visualwebarena@89f5af2` | |
| WebVoyager 论文 / 代码 | arXiv:2401.13919**v4**（ACL 2024） / `MinorJerry/WebVoyager@5a78967` | |
| Online-Mind2Web（含 WebJudge） | arXiv:2504.01382**v4**（2025-10-08） / `OSU-NLP-Group/Online-Mind2Web@f0d805e`（2026-05-28） | |
| Mind2Web 论文 / 代码 | arXiv:2306.06070**v3** / `OSU-NLP-Group/Mind2Web@33bd95c` | |
| WorkArena 论文 / 代码 | arXiv:2403.07718**v5** / `ServiceNow/WorkArena@a772230` | |
| BrowserGym 生态论文 / 代码 | arXiv:2412.05467**v4** / `ServiceNow/BrowserGym@9e779f0` | AssistantBench 评分器也从这里读 |
| AssistantBench 论文 | arXiv:2407.15711**v2** | |
| GAIA 论文 / 评分器 | arXiv:2311.12983**v1** / HF Space `gaia-benchmark/leaderboard` 的 `scorer.py`（main，无 commit 号，2026-09-11 抓取） | |
| τ-bench 论文 / 代码 | arXiv:2406.12045**v1** / `sierra-research/tau-bench@59a200c` | |
| Codex（pass@k 估计量） | arXiv:2107.03374**v2** | |
| "Adding Error Bars to Evals"（Evan Miller，Anthropic） | arXiv:2411.00640**v1** | 下文简写「Miller」 |
| ST-WebAgentBench | arXiv:2410.06703**v7**（2026-06-04） / `segev-shlomov/ST-WebAgentBench@67f56dd` | |
| SafeArena | arXiv:2503.04957**v1** | |
| AgentRewardBench | arXiv:2504.08942**v2** / `McGill-NLP/agent-reward-bench@05899fc` | |
| AI Agents That Matter | arXiv:2407.01502**v1** | |
| WebLINX | arXiv:2402.05930**v2** | |
| WebCanvas / Mind2Web-Live | arXiv:2406.12373**v3** | |
| Anthropic "Demystifying evals for AI agents" | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents （2026-01-09 发布） | 下文简写「Anthropic 文」 |
| OpenAI 文档 | https://developers.openai.com/api/docs/guides/{trace-grading,agent-evals,graders,evaluation-best-practices}.md | 旧地址 `platform.openai.com/docs/guides/*` 会 301 到这里 |
| OpenAI Agents SDK tracing | https://openai.github.io/openai-agents-python/tracing/ | |
| LangSmith | https://docs.langchain.com/langsmith/trajectory-evals ，https://docs.langchain.com/langsmith/evaluation-concepts.md | |
| agentevals | `langchain-ai/agentevals@946ad15` | |
| Inspect AI（UK AISI） | `UKGovernmentBEIS/inspect_ai@52b3088`（2026-09-11） | 文档的 `.qmd` 源与实现都从这个 commit 读 |
| Braintrust | https://braintrust.dev/docs/sdks/python/related/autoevals/overview.md | 只读到 autoevals 概览，见 §6 |

本项目侧读的是 `tests/spike/score-run.mjs`、`tests/spike/live-github-run.mjs`（470–495 行 `ROUNDS`）、`src/agent/host/record.ts`、`src/agent/host/thread.ts`、`src/agent/guide/trace.ts`、`src/shared/protocol.ts`（`GuideStep`，108–128 行）、`tests/eval/score.mjs`、`tests/eval/annotations.json`，以及 `tests/spike/live-github-run-log.run6.ndjson` 和 `.run7.ndjson` 两份日志。这些文件本文都没有改。

---

## 1. 先给结论

**问题一：网页 agent 的指标**
1. 任务级成功几乎都是**二值**。判定方法分四类：程序化检查（WebArena、VisualWebArena、WorkArena 查 URL/DOM/数据库；τ-bench 比对数据库哈希）、参考答案匹配（GAIA 的 quasi exact match；WebArena 的 `exact_match`/`must_include`）、LLM 评审（WebVoyager 的 GPT-4V 评审、Online-Mind2Web 的 WebJudge、WebArena 的 `fuzzy_match`）、人工（WebVoyager 与 Online-Mind2Web 都把人工当主口径或金标准）。WebArena 把多个检查器的分数**相乘**（`evaluators.py:336-352`），所以没有部分分。
2. 部分完成只在少数地方有定义：AssistantBench 给答案打部分分（词级 F1，数字按对数距离，字典按键值 F1）；WebCanvas 的 key node 步骤分与 Completion Rate；ST-WebAgentBench 的 PCR（「任一检查通过」即记 1）。
3. 步骤级以 Mind2Web 为代表：Element Accuracy、Operation F1（token 集合 F1）、Step SR（元素与操作都对）、Task SR（所有步都对）。离线协议是「给真实历史，每步独立评」，步骤指标对任务做 **macro 平均**（§4.2；`metric.py:236-272`）。gold 元素不在 top-50 候选里，该步直接记 0（`metric.py:120-125`）。
4. 可靠性用 τ-bench 的 pass^k：$\mathbb{E}_{task}[\binom{c}{k}/\binom{n}{k}]$，是 pass@k（Codex 估计量）的对偶（τ-bench §3「Pass^k metric」；`run.py:180-203`）。效率各家口径不同：Online-Mind2Web 用「步数 ÷ 人类参考步数」只在成功集上平均（式 2），WebCanvas 用 $ES=L/P$，AI Agents That Matter 要求报美元成本加 token 数，Anthropic 文列的是轮数、工具调用数、总 token 以及 TTFT 等延迟。
5. 越界/安全：ST-WebAgentBench 的 CuP（成功**且**零违规）与 Risk Ratio；SafeArena 的拒绝率与 NSS；BrowserGym 的 WebArena 包装在出现未授权域名时直接以 0 分终止（`task.py:173-181`）。

**问题二：评估系统怎么搭**
1. Anthropic 文把术语钉死了：task / trial / grader / transcript（= trace = trajectory）/ outcome / evaluation harness / agent harness。它主张以 **outcome** 为主（「grade what the agent produced, not the path it took」），给多组件任务设部分分，并且必须读 transcript。
2. grader 分三类：代码、模型、人工。各自的优缺点 Anthropic 文有表；OpenAI graders（`string_check`/`text_similarity`/`score_model`/python/`multi`）、LangSmith（human/code/LLM-as-judge/pairwise）、Inspect scorers 的分法大体同构。OpenAI 文档写明 graders 正在被弃用（`graders.md` 第 7–8 行）。
3. capability eval 从低通过率起步，给团队留出爬坡空间；regression eval 应接近 100%。capability 任务饱和后「毕业」进 regression（Anthropic 文）。LangSmith 另分 offline（有参考输出）与 online（生产 trace，无参考输出）。
4. LLM 评审的校准口径是它与人工的一致率、Cohen/Fleiss κ、成功率差（gap），以及 **precision**。WebVoyager 报 κ=0.70；Online-Mind2Web 报一致率 85.7%、gap 3.8%；AgentRewardBench 主张 precision 优先，并发现所有 judge 的 precision 都不到 70%，而规则评估的 recall 只有 55.9%。
5. 离线快照评估的已知代价是「非演示路径被判失败」（Mind2Web 局限性段）。在线评估的代价是网站变化和不可复现，对策有 key node 按 URL 判定（WebCanvas）、复现日志（BrowserGym）、「不可执行」标签 `2`（Online-Mind2Web 人工评估规程）。

**问题三：统计**
1. 均值的标准误用 CLT：$SE=\sqrt{\widehat{Var}(s)/n}$；二值时 $\sqrt{\bar s(1-\bar s)/n}$；95% CI 为 $\bar s\pm1.96\,SE$（Miller 式 1–3）。小样本二值数据，Inspect 推荐 Wilson 区间（`std.py:262-380`）。
2. 同一任务跑多遍、或题目成组抽样时，样本不独立，要用**聚类标准误**（Miller 式 4）或「先对每题求均值再求 SE」（Miller §3.1）；把 K·N 个结果直接合在一起算 SE 是不一致的。
3. 比较两个版本用**配对**差：$SE_{A-B,paired}=\sqrt{Var(s_A-s_B)/n}$（式 7），聚类版见式 8。
4. 样本量公式是 $n=(z_{\alpha/2}+z_\beta)^2(\omega^2+\sigma_A^2/K_A+\sigma_B^2/K_B)/\delta^2$（式 9），反解出最小可检出差距（式 10）。Miller 的示例是 δ=3pp 约需 969 题。Anthropic 文说早期 20–50 个任务就够，理由是那时效应量大。
5. 每题重复 K 次：取 K 使 $\mathbb{E}[\sigma_i^2]/K\ll Var(x)$。在均匀难度的示例里，K=2/4/6 分别把方差降 1/3、1/2、5/9，上限 2/3（§3.1）。另外不要为了降方差去调温度（§3.3）。

**问题四：与本产品对照（全部是推断）**
1. 任务成功率、pass^k、按任务聚类的 CI、配对比较、LLM 评审的一致率与 precision，这些可以原样搬过来。步骤级的 Mind2Web 协议在形状上与「元素表 + 目标 + 历史 → 选 ref」同构。但我们的输出是**多步计划**，而且有 clarify/need_docs/done 这几种非动作意图，它没有对应物；再加上 GitHub 上一个目标常有多条路径，gold 必须是「可接受元素集合」，否则会重现 Mind2Web 自己承认的假阴性。
2. 现有日志里有两个与口径直接相关的事实。其一，`score-run.mjs` 的到达率只按 URL 正则算，不是用户的「URL + 最后一步」口径。其二，run7 中 16 轮的 Run record 状态是 `completed`，其中 8 轮 `arrived=false`，所以 Run record 的 `status` 不是任务成功。
3. 缺的东西：人工判定没有落盘成字段；没有逐步的 gold ref / 可接受集合；Run record 不带 token 与延迟；没有人类参考步数。trace 能恢复每次调用的完整输入输出（离线重放的输入），但默认关闭，且最多保留 24 条。
4. 用现有两份日志、按 Miller 与 τ-bench 的公式算：7 个目标 × 3 遍的配对设计，在 80% 功效下能分辨的差距约 28–33 个百分点（§5.6）。

---

## 2. 问题一：网页 / 浏览器 agent 的指标

### 2.1 任务级

#### 2.1.1 WebArena

**【原文】判定方式分两类。** 信息检索类任务用 $r_{info}(\hat a, a^*)$ 比较预测答案与标注答案，有三个评分函数（arXiv:2307.13854v4 §3.2 "Evaluation Annotation"）：
- `exact_match`：「only $\hat a$ that is identical with $a^*$ receives a score of one」；
- `must_include`：「any $\hat a$ containing $a^*$ receives a score of one」；
- `fuzzy_match`：「we utilize a language model to assess whether $\hat a$ is semantically equivalent to $a^*$ ... we use gpt-4-0613」。

导航类和内容/配置类任务用 $r_{prog}(\mathbf s)$ 程序化检查执行轨迹中的中间状态：先用 **locator**（数据库查询、网站 API 或页面上的 JS 选择器）取回关键内容，再核对标注的关键词，复用 `exact_match` 和 `must_include`（同节）。

**【原文】多个检查器相乘，所以是二值。** `webarena@dce0468 evaluation_harness/evaluators.py:336-352`：

```python
class EvaluatorComb:
    ...
        score = 1.0
        for evaluator in self.evaluators:
            cur_score = evaluator(trajectory, config_file, page, client)
            score *= cur_score
        return score
```

`evaluator_router`（同文件 356-374 行）按任务配置里的 `eval_types` 组合三种检查器：`string_match` / `url_match` / `program_html`。`StringEvaluator` 内部同样是连乘，每个 `must_include` 条目各乘一次（123-170 行）。`URLEvaluator` 的规则是 `"GOLD in PRED"`：参考 URL 的 base path 必须出现在预测 URL 里，参考 query 参数的每个 key 都要匹配，两者相乘（213-241 行）；多个参考 URL 用 `" |OR| "` 分隔（213 行）。

**【原文】LLM 判定里「部分正确」按错算。** `webarena@dce0468 evaluation_harness/helper_functions.py:146-173`：提示要求模型「Conclude the judgement by correct/incorrect/partially correct」；`if "partially correct" in response or "incorrect" in response: return 0.0`。

**【原文】不可达任务。** 论文专门设计了 unachievable 任务，标为 "N/A"，要求 agent 给出等价回应（§3.2）。代码里 `fuzzy_match` 的参考值为 `"N/A"` 时，先做精确匹配，不中再用 `llm_ua_match` 比较「报告的不可达原因」与真实原因（`evaluators.py:150-163`；`helper_functions.py:176-190`）。

**【原文】步数上限与早停。** `webarena@dce0468 run.py:91` 定义 `--max_steps` 默认 30；`run.py:161-200` 的 `early_stop` 在三种情况下停止：到达最大步数、连续 `parsing_failure_th`（默认 3，101-105 行）次解析失败、连续 `repeating_action_failure_th`（默认 3，106-111 行）次重复同一动作（TYPE 除外）。

**【原文】基线数字。** GPT-4 agent 端到端成功率 14.41%，人类 78.24%（摘要；Table 2）。

**【推断】论文与代码对不上的一处。** 论文写 `fuzzy_match` 用 gpt-4-0613，当前 HEAD 的 `helper_functions.py:162` 调用的是 `gpt-4-1106-preview`。报数时应当连同评审模型版本一起报，否则同一条 `fuzzy_match` 在不同 commit 下不是同一个量具。

#### 2.1.2 VisualWebArena

**【原文】** reward 函数 $R: S\times A\rightarrow\{0,1\}$，「returns 1 at the final step if the state transitions align with the expectations of the task objective ... and 0 otherwise」（arXiv:2401.13649v2 §3 开头）。它沿用 WebArena 的 `exact_match` / `must_include` / `fuzzy_match`，另加两种视觉判定（§3.3）：
- `eval_vqa`：用 BLIP-2-T5XL 对图像问一个问题，VLM 的输出包含 groundtruth $a^*$ 就给 1。用途是开放式任务（「Buy me a green hoodie under $10」这类不可能枚举商品 ID 的任务）。
- `eval_fuzzy_image_match`：SSIM 高于阈值 $t\in[0,1]$ 就给 1。

评分代码在 `web-arena-x/visualwebarena@89f5af2 evaluation_harness/evaluators.py`（649 行）。本文只核对了论文定义，没有逐行抄这个文件。

#### 2.1.3 WebVoyager

**【原文】以人工为主口径。** 「We adopt human evaluation as our main evaluation metric ... provide the human evaluators with the complete trajectories ... and ask them to provide a binary judgment」。其中 300 个任务由三名标注者各判一次，用来测标注者之间的一致性（arXiv:2401.13919v4 §5.1）。

**【原文】自动评审。** 用 GPT-4V 做评审，输入是任务、agent 的最终回答和**最后 k 张截图**，k 是超参（§5.1）。报告的一致性数字：
- 人与人之间的 Fleiss κ 在讨论前为 0.7；
- GPT-4V 看完整轨迹时 κ 达到 0.70，与人与人相当；
- 一致率 85.3%（摘要）；
- 每组自动评审跑三次，报均值与标准差（主结果表注）；
- Claude-3-Opus 当评审时 κ=0.6，GPT-4o 当评审时 κ=0.72；
- 评审对自家模型有偏好：「Claude-3-Opus ... demonstrates a clear preference for its own results」（结果讨论段）。

**【原文】评审代码。** `MinorJerry/WebVoyager@5a78967 evaluation/auto_eval.py`：系统提示要求给出 `'SUCCESS'` 或 `'NOT SUCCESS'`（10-25 行）；调用参数 `temperature=0, seed=42`（99 行）；`auto_eval_res = 0 if 'NOT SUCCESS' in gpt_4v_res else 1`（128 行）；`--max_attached_imgs` 默认 1（142 行）。

#### 2.1.4 Online-Mind2Web 与 WebJudge

**【原文】任务集。** 300 个任务，覆盖 136 个网站；按人类完成所需步数 $N_{step}$（称为 reference length）分级：≤5 为 easy，6–10 为 medium，≥11 为 hard（arXiv:2504.01382v4 §2.2）。

**【原文】人工标注是金标准。** 「Each task is labeled by at least two annotators, with a third resolving any conflicts. We measure agreement between all automatic evaluation methods and humans on final binary decisions」（§4.1）。仓库里后来的提交规程更严：至少 3 名独立标注者加 1 名 QA；每名标注者**自己先做一遍任务**，记下自己的步数和轨迹；标签取三值——`0` 失败、`1` 成功、`2` 不可执行（验证码、网站宕机、网站改版、基础设施故障）（`Online-Mind2Web@f0d805e data/schema_v2/DETAILED_HUMAN_EVALUATION_PROCESS.md:13-55`）。

**【原文】WebJudge 的形式。** 式 (1)：$O=\operatorname{Evaluator}(T,A,I)$，二分类，取值 Success 或 Failure。三个步骤（§3）：
1. Key Point Identification：从任务描述里抽出关键点 $K=(k_1,\dots,k_m)$；
2. Key Screenshot Identification：对每张截图打 1–5 的相关分，**不低于阈值 δ 的截图保留**；
3. Outcome Judgement：结合任务、关键点、保留的截图和动作序列下结论。

论文还比较了「逐关键点判定、全部满足才算成功」的细粒度模式（附录 B.1）。代码对应：`src/methods/webjudge_online_mind2web.py:88-153`，其中 153 行是 `if int(score) >= score_threshold:`；阈值默认 3，见 `src/run.py:170` 的 `parser.add_argument('--score_threshold', type=int, default=3)`；最后的成功率是 `success_num / len(task_dirs)`（`run.py:157-160`）。

**【原文】与人工的一致性。**
- WebJudge（o4-mini）一致率 85.7%，成功率差 3.8%；WebJudge-7B 一致率 87%，差 3.9%，且每条轨迹固定只调用两次 API（§4.2）。
- 同一评审管线跑 3 遍，六个 agent 成功率的平均标准差 1.1%，最大 1.8%（§4.2）。
- 按评审模型平均，GPT-4o 版 83.6%，o4-mini 版 85.7%（§4.3，Table 3）。
- WebVoyager 那种评审一致率低，主因是 agent 最终回答里有幻觉；只看最后一张截图的方法会漏掉中间步骤；轨迹越长，这两类方法的一致率下降越明显（§4.3）。
- README 要求用 o4-mini 做评审（`README.md:259`）。

**【原文】效率指标。** 设 $S_i$ 为 agent 在任务 $i$ 上走的步数，$\hat S_i$ 为人类参考步数，只在成功集合上平均：

$$E=\frac{1}{|\mathcal T_{succ}|}\sum_{i\in\mathcal T_{succ}}\frac{S_i}{\hat S_i}\quad\text{(式 2，越低越好)}$$

同节的发现：失败任务的步数明显多于成功任务，在 Browser Use、Claude Computer Use 3.7、Operator 上接近两倍；Operator 平均约为人类参考的 2.6 倍（§5.1）。

#### 2.1.5 BrowserGym / WorkArena

**【原文】任务接口。** 每个任务实现 `setup()`、`teardown()`、`validate()` 和可选的 `cheat()`。`validate()`「can involve operations such as querying a database, validating the URL and the content of the current page, or looking at the messages sent by the agent in the chat. The method returns a reward, an optional user message for the chat, and a `done` flag」。`cheat()` 是写死的 Playwright 解法（oracle），「can notably be used to assess the feasibility of tasks」（arXiv:2403.07718v5，任务接口段）。代码签名见 `ServiceNow/BrowserGym@9e779f0 browsergym/core/src/browsergym/core/task.py:44-58`。

**【原文】WorkArena 各类任务怎么验证**（§3 各任务类别段）：
- 列表过滤/排序：客户端验证列表满足条件；
- 表单：查数据库，看 agent 建的记录值对不对；
- 知识库问答：答案落在一组可接受答案里即可，例如「8.5/10」「85%」都算对；
- 下单：查数据库核对订单；
- 菜单导航：「simply verifies that the agent has arrived at the expected location」。

**【原文】BrowserGym 对 WebArena 的包装。** `browsergym/webarena/src/browsergym/webarena/task.py:169-217`：
- 173-181 行：任何打开的标签页一旦不在授权域名列表内，就 `return 0, True, "", {"error": "Unauthorized url, terminating task"}`；
- 187-192 行：取最后一条 assistant 消息当作 stop 答案；如果最后一条是 `infeasible`，答案记为 `"N/A"`；
- 214-217 行：`score > 0` 或已经 STOP 时 `done=True`。

**【原文】报法。** 「we use the task success rate ... and compute the standard error ($\sigma/\sqrt N$)」（arXiv:2412.05467v4 §6.1）。每个基准都带有建议的 action set、**每个任务的建议 seed 数**、建议最大步数；AssistantBench 没有任务随机化，所以一个 seed 就够（同论文，基准元数据段）。影响复现性的因素包括包版本、API 模型更新、网站变化、LLM 非确定性；AgentLab 为此把 benchmark 版本、包版本、commit、操作系统和时间戳写进 reproducibility journal（同论文，"Factors affecting reproducibility" 段）。

#### 2.1.6 AssistantBench（部分分）

**【原文】** 支持三种答案类型（arXiv:2407.15711v2，"To automatically evaluate answers" 段）：
- 字符串：预测词与 gold 词之间的 F1；列表答案沿用 Dua et al. (2019) 的对齐实现；
- 数字：「to let models get partial credit when close to the answer ... give a score of zero once the prediction $A'$ is an order of magnitude from the gold answer $A$」，即 $\max\{0,1-\log\frac{\max(A,A')}{\min(A,A')}\}$；
- 字典：同键的值按各自类型打分，缺键记 0；gold 键值对的平均分记为 recall，预测键值对的平均分记为 precision，返回两者的 F1。

另外报 **answer rate**（给出答案的任务占比）和 **precision**（不弃权时的平均准确率）。

**【原文】代码。** `BrowserGym@9e779f0 browsergym/assistantbench/src/browsergym/assistantbench/evaluation/`：
- `evaluate_utils/evaluate_numbers.py:7-17`：`if pred > gold: return max(0, 1 - np.log(pred / gold))`；
- `evaluate_utils/evaluate_strings.py:105-120`：词袋 F1；
- `evaluate_utils/evaluate_dicts.py:57-68`：recall/precision/F1，多个字典之间做最大对齐后取平均；
- `evaluator.py:102-132`：`question_scorer` 返回 `(accuracy, has_ans)`。

**【推断】** 代码用的是**自然对数** `np.log`，所以预测偏离到约 e≈2.72 倍时就得 0 分，而不是论文措辞里的「一个数量级」（10 倍）。论文公式没写对数的底。

#### 2.1.7 GAIA

**【原文】** 「each question calls for an answer that is either a string (one or a few words), a number, or a comma separated list ... There is only one correct answer. Hence, evaluation is done via quasi exact match between a model's answer and the ground truth (up to some normalization that is tied to the 'type' of the ground truth)」（arXiv:2311.12983v1，评估段）。

`scorer.py:29-104` 的规则：gold 是数字时，把预测归一化成数字后比较是否相等；gold 含 `,` 或 `;` 时按列表处理，长度不等直接判错，否则逐元素比较；其余情况按字符串处理，去掉所有空白、转小写、去标点后比较相等。结果为二值。

**【原文】** web browsing 是 GAIA 标注的能力类别之一，论文按能力类别报分（能力分项表）。**在读到的正文里没找到**「网页相关子集」的独立评分口径，也没找到它的具体题数占比。评分器对所有题一视同仁。

#### 2.1.8 部分完成的另外两种定义

**【原文】WebCanvas 的 key node。** key node 是「indispensable steps ... regardless of the path taken」；判定时优先用 **URL 状态**而不是元素交互，以抵抗页面布局变化（arXiv:2406.12373v3 §2.2）。评分分两层（§2.3）：
- 步骤分：到达一个 key node 并通过该节点的判定函数，就得一分。判定目标可以是 URL、元素路径或元素值；匹配方式可以是 exact、include 或 semantic（LLM）。步骤分的占比记为 **Completion Rate**。
- 任务分：Task Finish Score 要求完成全部 key node，对应 Task Success Rate；Efficiency Score 为 $ES=L/P$，其中 $L$ 是轨迹长度，$P$ 是获得的步骤分总数。

**【原文】ST-WebAgentBench 的 PCR。** 「Let $\tilde C_t=1$ when any check succeeds: $\mathrm{PCR}=\frac1T\sum_t\tilde C_t$」（arXiv:2410.06703v7 §3.3）。

**【原文】Anthropic 文。** 「For tasks with multiple components, build in partial credit. A support agent that correctly identifies the problem and verifies the customer but fails to process a refund is meaningfully better than one that fails immediately.」（Step 5）

#### 2.1.9 一张对照表（由上文原文整理）

| 基准 | 成功怎么判 | 部分分 | 人工在哪里 |
|---|---|---|---|
| WebArena | 程序化（URL / 页面 DOM 的 locator / 答案匹配），多检查器相乘 | 无 | 人类基线 78.24% |
| VisualWebArena | 同上，另加 VQA 与 SSIM | 无 | — |
| WebVoyager | 人工二值为主，GPT-4V 评审为辅 | 无 | 主口径 |
| Online-Mind2Web | 人工为金标准，WebJudge 自动评审 | 无（标签 0/1/2） | 金标准；需 3 名标注者 + QA |
| WorkArena / BrowserGym | `validate()`：查数据库、URL、页面、聊天消息 | 无 | `cheat()` 用来验证可行性 |
| AssistantBench | 答案匹配 | 有：F1、对数距离、字典 F1 | — |
| GAIA | quasi exact match | 无 | — |
| WebCanvas | key node（优先按 URL） | 有：Completion Rate | 人工标注 key node |
| τ-bench | 数据库终态哈希一致，且输出里含必须信息 | 无 | — |

### 2.2 步骤级

#### 2.2.1 Mind2Web：四个指标的精确定义

**【原文】** arXiv:2306.06070v3 §4.2：

> For evaluation, we first calculate **Element Accuracy** that compares the selected element with all acceptable elements, and **Operation F1** that calculates token-level F1 score for the predicted operation. This is the same as accuracy for Click, but considers the correctness of the input value for Type and Select Option. Each step of the task is evaluated independently with the ground truth action history provided. We then define **Step Success Rate** and **Success Rate** (for the whole task). A step is regarded as successful only if both the selected element and the predicted operation are correct. A task is regarded successful only if all steps have succeeded. ... For step-wise metrics, we report macro average across tasks.

写成公式（记号是我加的，含义与上段一致）。设任务 $t$ 有 $N_t$ 步，第 $j$ 步的预测元素为 $\hat e_{tj}$，可接受元素集合为 $G_{tj}$，预测操作串为 $\hat o_{tj}$，gold 操作串为 $o_{tj}$：
- $EA_{tj}=\mathbf 1[\hat e_{tj}\in G_{tj}]$
- $F1_{tj}=\mathrm{F1}(\mathrm{set}(\hat o_{tj}.\mathrm{split}()),\mathrm{set}(o_{tj}.\mathrm{split}()))$
- $SSR_{tj}=\mathbf 1[EA_{tj}=1\wedge F1_{tj}=1]$
- 报告值 $\overline{EA}=\frac1T\sum_t\frac1{N_t}\sum_j EA_{tj}$（macro），$F1$ 与 $SSR$ 同理；$SR=\frac1T\sum_t\mathbf 1[\forall j: SSR_{tj}=1]$

**【原文】代码。** `OSU-NLP-Group/Mind2Web@33bd95c src/action_prediction/metric.py`：
- 53-63 行：操作串形如 `"CLICK"`、`"TYPE Queen"`，即动作加值；
- 65-81 行：`calculate_f1` 在**去重后的 token 集合**上算 F1，两边都为空时返回 1；
- 99-106 行：候选生成的 Recall@k（k∈{5,10,20,50}），即 gold 元素排进前 k 的样本占比；
- 120-125 行：只保留排名 < top_k（默认 50）的正候选；**一个都不剩时这一步直接记 0**；
- 221-228 行：预测元素属于 `pos_ids` 即 element_acc=1；`step_acc` 要求 `action_f1==1` 且 `element_acc==1`；
- 236-259 行：按 `annotation_id`（任务）先求均值，再对任务求均值，即 macro；
- 267-272 行：同时返回 micro 版（`element_acc`、`action_f1`、`step_acc`）和 macro 版（`marco_*`，拼写原样）。

在我读的 22-272 行里**没找到**单独计算 task success rate 的变量。Task SR 的定义以论文原文为准。

**【原文】离线协议的边界。** GPT-4 只在每个设置下评了 50 个任务，并用 top-50 候选（Table 2 注）。局限性段 "Evaluation with Offline/Online Environments"：「we evaluate the system with cached offline environments ... a downside to this is that the task will fail immediately if an action was not cached during data collection, potentially leading to false negatives due to the existence of multiple paths」。

**【原文】泛化切分。** Cross-Task（252 个任务）、Cross-Website（177 个）、Cross-Domain（912 个），分别检验对同站新任务、同领域新网站、全新领域的泛化（§4.1）。

#### 2.2.2 WebLINX：逐轮打分（最接近「指出一个元素」）

**【原文】** WebLINX 认为「整任务成功」不适用于对话式导航，因为目标随对话演化，所以改用 turn-level 指标（arXiv:2402.05930v2 §4.1）：
- Intent Match：$IM(a',a)=\mathbf 1[\text{intent 相同}]$；
- 元素相似度：$IM(a',a)\times\frac{\mathcal B_{ref}\cap\mathcal B_{pred}}{\mathcal B_{ref}\cup\mathcal B_{pred}}$，即边界框 IoU。它偏好视觉上重叠大的元素；预测元素比参考大很多或小很多都会被惩罚，即使完全包含在参考内；完全不重叠则为 0；
- 文本：$IM\times\mathrm{chrF}$（字符 6-gram 的 F1）；URL 按段切分后算 F1，称 URLF。

逐轮得分：元素类动作（click、textinput、submit）取 IoU；文本类（load、say）取 F1；textinput 取 IoU×F1。**整体分是逐轮得分的 micro 平均**（§4.2）。

#### 2.2.3 离线 vs 在线的实测差距

**【原文】** WebCanvas 从 Mind2Web-Live 测试集随机抽了 40 个实例，分别在线、离线测，并报 Task SR(0) 和 Task SR(1)——后者容许错一步或一个 key node（arXiv:2406.12373v3 Table 4）。

### 2.3 效率：各家怎么报

| 来源 | 口径（原文） |
|---|---|
| Online-Mind2Web | 式 2 的 $E$（成功集上 agent 步数与人类参考步数之比的平均），另报成功与失败任务各自的平均步数（§5.1） |
| WebCanvas | $ES=L/P$（§2.3） |
| WebArena | 不作指标，只作预算：最多 30 步，连续 3 次解析失败或 3 次重复动作即早停（`run.py:91-111,161-200`） |
| BrowserGym | 每个基准有建议最大步数（§ 基准元数据段） |
| AI Agents That Matter | 「downstream evaluation should account for dollar costs, rather than proxies」；「downstream evaluations of agents should include input/output token counts in addition to dollar costs, so that anyone ... can instantly recalculate the cost using current prices」；以准确率–成本的 **Pareto 前沿**作图，前沿约束为凸（arXiv:2407.01502v1 §2–§3）。同一框架也可以用于延迟（§3 末） |
| Anthropic 文 | `tracked_metrics`：`n_turns`、`n_toolcalls`、`n_total_tokens`；延迟：`time_to_first_token`、`output_tokens_per_sec`、`time_to_last_token`（编程 agent 示例 YAML）。「latency, token usage, cost per task, and error rates can be tracked on a static bank of tasks」（"Why build evaluations?"）。浏览器 agent 需要在 token 效率与延迟之间权衡：DOM 快但费 token，截图慢但省 token（"Computer use agents"） |

### 2.4 可靠性：pass@k、pass^k 与多次试验的方差

**【原文】pass@k（Codex）。** 每题生成 $n\ge k$ 个样本（论文里 $n=200$，$k\le100$），数出正确样本数 $c$：

$$\text{pass@}k=\mathbb E_{\text{Problems}}\left[1-\binom{n-c}{k}\Big/\binom{n}{k}\right]\quad\text{(arXiv:2107.03374v2 §2.1 式 1)}$$

**【原文】pass^k（τ-bench）。** 「pass^k (pass hat k), defined as the chance that **all** $k$ i.i.d. task trials are successful, averaged across tasks ... if a task is run for $n$ trials and $c$ of those trials end up successful ($r=1$), unbiased estimates for pass^k and pass@k would be:」

$$\text{pass}^k=\mathbb E_{task}\left[\binom{c}{k}\Big/\binom{n}{k}\right],\qquad \text{pass@}k=1-\mathbb E_{task}\left[\binom{n-c}{k}\Big/\binom{n}{k}\right]$$

默认报 pass^1 = pass@1 = $\mathbb E[r]=\mathbb E[c/n]$（arXiv:2406.12045v1 §3 "Pass^k metric" 段）。

**【原文】代码。** `sierra-research/tau-bench@59a200c tau_bench/run.py:180-203`：`is_successful` 判定 reward 落在 1±1e-6 内；按 task_id 累计成功次数 `c`；`sum_task_pass_hat_k += comb(c, k) / comb(num_trials, k)`，最后除以任务数。reward 本身是数据库终态哈希与标准答案执行后的哈希一致、且回复里含必需输出，否则为 0（`tau_bench/envs/base.py:124-164`）。

**【原文】Inspect 的实现。** `inspect_ai@52b3088 src/inspect_ai/scorer/_reducer/reducer.py`：`pass_at(k)`（164-205 行，Chen 2021 的数值稳定写法）；`pass_k(k)`（208-244 行，「Computed as the draw-without-replacement estimator `C(correct, k) / C(total, k)`」）；`at_least(k)`（130-160 行）。用法是 `epochs=Epochs(5, ["mean", "pass_at_5"])`（`docs/metrics.qmd:128-133`，327-368 行）。

**【原文】Anthropic 文的解读。** 「pass@k and pass^k diverge as trials increase. At k=1, they're identical ... By k=10, they tell opposite stories」；「pass@k for tools where one success matters, pass^k for agents where consistency is essential」；示例：单次成功率 75%，3 次全过 ≈ (0.75)³ ≈ 42%（"How to think about non-determinism"）。

**【原文】各家怎么报方差。**

| 来源 | 做法 |
|---|---|
| WebVoyager | 评审跑三次，报均值 ± 标准差 |
| Online-Mind2Web | 评审跑三次，报标准差（平均 1.1%，最大 1.8%） |
| AI Agents That Matter | 每个 agent 跑五次；并指出「agent evaluations are rarely accompanied by error bars」，且许多报告分数高于他们复现五次的最大值（§4 的第 3 点） |
| BrowserGym | $\sigma/\sqrt N$ |
| WebCanvas | 表里报 ± |

各家的方法论详见 §4。

### 2.5 越界 / 安全类指标

**【原文】ST-WebAgentBench**（arXiv:2410.06703v7 §3.3）。$C_t=1$ 当且仅当所有成功检查都通过；$V^t_d$ 为维度 $d$ 上的违规计数，共 6 个维度：
- $\mathrm{CR}=\frac1T\sum_tC_t$
- $\mathrm{CuP}_t=C_t\,\mathbf 1[\sum_dV^t_d=0]$，$\mathrm{CuP}=\frac1T\sum_t\mathrm{CuP}_t$
- $\mathrm{pCuP}_t=\tilde C_t\,\mathbf 1[\sum_dV^t_d=0]$
- $\mathrm{RiskRatio}_d=\frac{\sum_tV^t_d}{\#\text{Policies}_d}$

原文还说 CuP「penalizes over-cautiousness as well as recklessness」。代码 `ST-WebAgentBench@67f56dd stwebagentbench/evaluation_harness/evaluators.py:73-88` 的 `create_report_point` 记录 `violated`、`dormant`、`violating_step`、`violating_action`。其中 **dormant** 指「触发条件从未出现、策略不可能被违反」（624-637 行注释）。

**【原文】SafeArena**（arXiv:2503.04957v1 §4.2）。三个自动指标：任务完成率（沿用 WebArena 的判定）、拒绝率、归一化安全分：

$$\text{NSS}=1-\frac{\sum_{i=1}^N\mathcal R(S_i)\,\mathcal R(H_i)}{\sum_{i=1}^N\mathcal R(S_i)}$$

其中每个有害任务 $H_i$ 都配一个对应的安全任务 $S_i$。人工评估用 ARIA 四级：立即拒绝、延迟拒绝、尝试但失败、完成（§4.3）。

**【原文】AgentRewardBench。** 专家为每条轨迹标三个标签：是否成功、是否有 **side effects**、是否陷入重复循环（arXiv:2504.08942v2 §3）。

**【原文】BrowserGym 的 WebArena 包装**在出现未授权域名时直接以 0 分终止（见 §2.1.5）。

**【推断】** 本文读到的网页基准里，「越权 / 有害动作率」有三种口径：按策略维度计的违规率（ST-WebAgentBench）、有害与安全任务配对的拒绝率（SafeArena）、按轨迹标注的副作用标签（AgentRewardBench）。

---

## 3. 问题二：评估系统怎么搭（工业实践）

### 3.1 术语（Anthropic 文 "The structure of an evaluation"）

**【原文】**
- **task**（又称 problem / test case）：一个有明确输入与成功标准的测试；
- **trial**：对一个 task 的一次尝试，「Because model outputs vary between runs, we run multiple trials」；
- **grader**：给 agent 某一方面打分的逻辑，一个 task 可以有多个 grader，每个 grader 含多个 assertion（checks）；
- **transcript**（= trace = trajectory）：一次 trial 的完整记录，包括输出、工具调用、推理和中间结果；
- **outcome**：trial 结束时环境的终态，例如「A flight-booking agent might say 'Your flight has been booked' ... but the outcome is whether a reservation exists in the environment's SQL database」；
- **evaluation harness**：跑评估的基础设施；**agent harness（scaffold）**：让模型成为 agent 的系统，「When we evaluate 'an agent,' we're evaluating the harness and the model working together」；
- **evaluation suite**：同一目标下的一组 task。

### 3.2 任务集怎么组织

**【原文】Anthropic 文 "Going from zero to one"：**
- Step 0：「20-50 simple tasks drawn from real failures is a great start ... in early agent development, each change ... often has a clear, noticeable impact, and this large effect size means small sample sizes suffice」。
- Step 1：从手工检查、bug tracker 和支持工单里转化出任务。
- Step 2：「A good task is one where two domain experts would independently reach the same pass/fail verdict」；每个任务配一个 reference solution，用来证明任务可解、grader 配置正确；「a 0% pass rate across many trials (i.e. 0% pass@100) is most often a signal of a broken task」。
- Step 3：**正反两面都要测**（该做与不该做），避免 class-imbalanced。例子是 Claude.ai 网页搜索的 undertriggering 与 overtriggering。
- Step 4：每个 trial 从干净环境开始；共享状态会造成相关失败或虚高。

**【原文】LangSmith**（evaluation-concepts.md，Best practices）：先手工整理 10–20 个高质量样例；上线后把历史 trace 转成样例（负反馈、长延迟、报错的 run）；数据集用 split（ML 式、按类别、分阶段放量）和版本管理，CI 固定到某个数据集版本。

**【原文】Mind2Web** 用 Cross-Task / Cross-Website / Cross-Domain 做分层 holdout（§4.1）。**AI Agents That Matter** 按泛化层级统计「有合适 holdout 的基准」有多少，结论是多数没有（§5，holdout 表）。

### 3.3 grader 的类型与适用场景

**【原文】Anthropic 文 "Types of graders for agents"（表格原样整理）：**

| 类型 | 方法 | 优点 | 缺点 |
|---|---|---|---|
| 代码 | 字符串匹配（exact/regex/fuzzy）、二值测试、静态分析、outcome 验证、工具调用验证（用了哪些工具、参数）、transcript 分析（轮数、token） | 快、便宜、客观、可复现、易调试 | 对合理变体脆弱、缺乏细腻度、难评主观任务 |
| 模型 | rubric 打分、自然语言断言、pairwise、reference-based、多评审共识 | 灵活、可扩展、能捕捉细微差别、适合开放任务 | 非确定、比代码贵、**需要与人工校准** |
| 人工 | 专家评审、众包、抽检、A/B、标注者间一致性 | 金标准 | 贵、慢 |

「For each task, scoring can be weighted (combined grader scores must hit a threshold), binary (all graders must pass), or a hybrid」。Step 5 的建议：「choosing deterministic graders where possible, LLM graders where necessary ... and using human graders judiciously」。

**【原文】OpenAI graders**（graders.md）：
- 返回 0–1 的分数，允许部分分（13 行）；
- 类型：`string_check`（`eq`/`neq`/`like`/`ilike`，105-118 行）、`text_similarity`（`fuzzy_match`、`bleu`、`cosine` 等，配 `pass_threshold`）、`score_model`、python、`multi`；
- 多组合的例子：先查被调用工具的名字，再查参数；并提醒参数判定对 `1` 与 `1.0` 这类细微差异「prone to under-rewarding」（91-93 行）；
- **「OpenAI is deprecating graders as part of the evals and fine-tuning workflows they support」**（7-8 行）。

**【原文】LangSmith**（evaluation-concepts.md 187-230 行）：human（annotation queues，有单条与 pairwise 两种）、code（确定性规则）、LLM-as-judge（reference-free 与 reference-based，few-shot 能提升效果）、pairwise（直接打分难、比较容易时用）。另区分 reference-free（离线在线都能用）与 reference-based（只能离线用）。

**【原文】Inspect**（`docs/scorers.qmd:8-18`）：scorer 有四种形态——从输出里抽答案、文本相似度、另一个模型判定、其他 rubric（如格式有效性）；scorer 同时声明聚合 metric，例如 `accuracy()`、`mean()`、`stderr()`。

**【原文】Braintrust autoevals**（overview.md）：打包了 LLM-as-a-judge、启发式（如 Levenshtein）、统计式（如 BLEU）三类评估器；「Many of these evaluations are adapted from OpenAI's evals project」。

### 3.4 capability eval vs regression eval

**【原文】Anthropic 文 "Capability vs. regression evals"：**「Capability or 'quality' evals ask, 'What can this agent do well?' They should start at a low pass rate ... Regression evals ask, 'Does the agent still handle all the tasks it used to?' and should have a nearly 100% pass rate」；「capability evals with high pass rates can 'graduate' to become a regression suite」。Step 7 讲饱和：「An eval at 100% tracks regressions but provides no signal for improvement」。

**【原文】LangSmith**（Evaluations vs testing）：「Evaluation measures performance according to metrics ... Testing asserts correctness ... regression tests can assert that new versions must outperform baseline versions on relevant metrics」。

**【原文】OpenAI best practices** 要求设立持续评估（CE）：每次改动都跑评估，并持续扩充评估集（evaluation-best-practices.md 61、83 行）。

### 3.5 trajectory（过程）评估 vs outcome（结果）评估

**【原文】Anthropic 文 Step 5：**「There is a common instinct to check that agents followed very specific steps like a sequence of tool calls in the right order. We've found this approach too rigid and results in overly brittle tests ... it's often better to grade what the agent produced, not the path it took」。但它的示例 YAML 同时含 `tool_calls` 断言和 `transcript: max_turns: 10` 约束（对话 agent 示例），也就是说过程约束仍作为 grader 之一存在。

**【原文】LangSmith / agentevals** 的轨迹匹配有四种模式（`agentevals@946ad15 python/agentevals/trajectory/match.py:21-38`）：
- `strict`：顺序与内容完全一致；
- `unordered`：顺序不限；
- `subset`：输出轨迹是参考轨迹的子集，「Ensuring agent doesn't exceed expected scope」；
- `superset`：输出轨迹是参考轨迹的超集，「Verifying minimum required actions are taken」。

工具参数匹配有 `exact`/`ignore`/`subset`/`superset`（85-87 行）。轨迹 LLM 评审可以带参考轨迹，也可以不带；`continuous=True` 时给 0–1 的分，否则为布尔值（`trajectory/llm.py:98-136`）。文档说轨迹匹配「deterministic, fast, and cost-effective」，LLM 评审「more flexible ... less deterministic」（trajectory-evals 页）。

**【原文】OpenAI trace grading：**「assigning structured scores or labels to an agent's trace—the end-to-end log of decisions, tool calls, and reasoning steps」；「Unlike black-box evaluations, trace evals provide more data to better understand why an agent succeeds or fails」（trace-grading.md）。agent-evals.md 的建议路径是**先用 trace 调行为，知道了「好」长什么样之后，再转到可重复的数据集和 eval run**。

**【原文】Online-Mind2Web** 发现「只看最后截图」的评审漏掉中间步骤，「看全部截图」的评审 token 超载；WebJudge 取的是折中方案——保留关键中间截图（§3、§4.3）。

### 3.6 LLM-as-judge 与人工一致率怎么校准

**【原文】报告口径：**

| 来源 | 口径 |
|---|---|
| WebVoyager | 一致率（label overlap）+ κ；与人-人 κ 对照（0.7） |
| Online-Mind2Web | 一致率 + 成功率差 + agent 排名是否一致（Table 3/4）；评审重复 3 次看稳定性 |
| AgentRewardBench | 主报 **precision** = TP/(TP+FP)，理由是在 RFT/RL 场景下假阳性会污染数据（§4 "precision" 段；`agent_reward_bench/eval/metrics.py:89-100`）；同时报 recall、F1、TNR、NPV（211-225 行）。结论：「no judge achieves above 70% precision」；规则评估的 recall 只有 55.9%，「severely underestimate the true performance」（Results 段）。标注者间一致率 89.3%（§3） |

**【原文】做法建议：**
- Anthropic 文 Step 5：「LLM-as-judge graders should be closely calibrated with human experts」；给评审一条退路，信息不足时返回 "Unknown"；「grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions」；「Once the system is robust, it's sufficient to use human review only occasionally」。系统化人工研究的定位是「Reserve systematic human studies for calibrating LLM graders」（"How evals fit" 段）。
- OpenAI best practices（403-440 行）：LLM 评审的偏差包括**位置偏差**（回答的先后顺序）和**冗长偏差**；pairwise 或 pass/fail 更可靠；「validate agreement against your human labels before optimizing for cost or latency」；等评审「consistently agrees with human annotations」之后再放量。
- WebVoyager 观察到评审偏好自家模型的输出（§5 讨论段）。

**【推断】** 本文读到的来源里，一致率的计算都是在「同一批轨迹、二值标签」上做的：WebVoyager 与 AgentRewardBench 用 κ 或 precision/recall，Online-Mind2Web 用一致率加 gap。**没找到**要求多大样本量才算完成校准的明确数字。

### 3.7 transcript / trace 怎么用

**【原文】Anthropic 文 Step 6：**「You won't know if your graders are working well unless you read the transcripts and grades from many trials ... When a task fails, the transcript tells you whether the agent made a genuine mistake or whether your graders rejected a valid solution」。例证：CORE-Bench 上 Opus 4.5 最初 42%，修掉 grader bug（如 "96.12" 对 "96.124991…" 判错）并放宽 scaffold 后升到 95%。

**【原文】OpenAI Agents SDK tracing：** trace 由 span 组成；trace 有 `workflow_name`、`trace_id`、`group_id`（把同一对话的多条 trace 连起来）、`metadata`；span 有 `started_at`/`ended_at`、`parent_id`、`span_data`（区分 Agent、Generation 等类型）；默认开启，ZDR 组织不可用。

**【原文】LangSmith** 的 online 评估在生产 run 和 thread 上跑，没有参考输出；offline 在带参考输出的 dataset 上跑（evaluation-concepts.md 21-46 行）。

**【原文】BrowserGym** 的 AgentXRay 能在同一 task seed 上重放同一动作序列，并对比两次 prompt 的 diff，用来监控真实网站随时间的变化（arXiv:2412.05467v4，复现性段）。

### 3.8 离线回放 vs 在线真网站

**【原文】**
- 离线（Mind2Web）：「cached offline environments ... allows us to test using snapshots of complex real-world websites. However ... the task will fail immediately if an action was not cached ... potentially leading to false negatives」（局限性段）。
- 自托管可交互环境（WebArena、VisualWebArena、WorkArena）：程序化检查可以直接查后端数据库。Anthropic 文说 WebArena「using URL and page state checks ... along with backend state verification for tasks that modify data (confirming an order was actually placed, not just that the confirmation page appeared)」（"Computer use agents"）。
- 在线真网站（WebVoyager、Online-Mind2Web、WebCanvas）：
  - 规则判定「sensitive to website changes, such as functional updates or URL modifications」（Online-Mind2Web §3）；
  - WebCanvas 的对策是 key node 优先按 URL、定时回放加告警加人工复查（§2.2、§3.2）；
  - Online-Mind2Web 的对策是标签 `2`（不可执行）和持续替换过时任务（§2.2；人工规程 51-55 行）；
  - WebVoyager 只做无需登录的任务并人工监控（伦理段）。
- 复现性：BrowserGym 列出包版本、API 模型更新、网站变化、LLM 非确定性四类因素（复现性段）。

**【原文】** 在这些来源里**没找到**以 HAR 录制作为评估回放介质的做法。Mind2Web 数据集提供的是 MHTML/DOM 快照（本仓库 `docs/research-dom-serialization-and-arrival.md` §2.4 已摘录）。

### 3.9 与其他方法的关系

**【原文】Anthropic 文 "How evals fit with other methods"** 的表列出六种方法：自动评估、生产监控、A/B、用户反馈、人工读 transcript、系统化人工研究，逐项给了优缺点。定位：「Automated evals are especially useful pre-launch and in CI/CD ... Production monitoring kicks in post-launch ... A/B testing validates significant changes once you have sufficient traffic ... Reserve systematic human studies for calibrating LLM graders」；并用 Swiss Cheese Model 作比喻。

---

## 4. 问题三：统计做法（公式与来源）

以下公式出自 Miller（arXiv:2411.00640v1）的对应小节。

### 4.1 单个分数的标准误与置信区间

**【原文】** 把题目看作从超总体中独立抽出的 $n$ 题，第 $i$ 题得分 $s_i=x_i+\epsilon_i$，$x_i$ 是条件均值，$\sigma_i^2=Var(\epsilon_i)$（§2.1）：

$$SE_{CLT}=\sqrt{\frac{1}{n}\cdot\frac{1}{n-1}\sum_i(s_i-\bar s)^2}\quad(1)\qquad SE_{Bernoulli}=\sqrt{\bar s(1-\bar s)/n}\quad(2)\qquad CI_{95\%}=\bar s\pm1.96\,SE\quad(3)$$

- 分数不是 0/1 时（如 F1），用 (2) 会偏保守；
- Miller 认为 CLT 适用时 bootstrap 不必要；
- 建议报告时写题数，并把 SE 放在括号里（Table 2）；
- Inspect 的 `stderr()` 实现就是 (1)：`np.std(values, ddof=1) / np.sqrt(n)`（`std.py:121-168`）。

**【原文】小样本二值数据。** Inspect 另有 `ci()`，默认为 Student-t 区间（自由度 $n-1$，聚类时为簇数 −1），以及 `ci_wilson()`，「Prefer this over `ci()` for binary scores ... the bounds always stay within [0, 1] and remain well calibrated for small samples and proportions near 0 or 1」（`docs/metrics.qmd:60-64`）。`ci_wilson` 的实现（`std.py:354-380`）是标准 Wilson 区间：中心 $\frac{\hat p+z^2/2n}{1+z^2/n}$；聚类时用 Korn-Graubard 有效样本量 $\hat p(1-\hat p)/\hat v$（上限为 $n$），临界值换成自由度为「簇数 −1」的 t（294-299、357-376 行）。

### 4.2 不独立的样本：聚类标准误

**【原文】** §2.2 式 4：

$$SE_{clustered}=\left(SE_{CLT}^2+\frac{1}{n^2}\sum_c\sum_i\sum_{j\ne i}(s_{i,c}-\bar s)(s_{j,c}-\bar s)\right)^{1/2}$$

这个公式介于「簇内完全相关」（每簇只相当于一个观测）与「完全不相关」之间。真实数据上，聚类 SE 可达朴素 SE 的 3 倍以上（Table 4，DROP 3.05×）。报告时要连同簇数一起报（Table 3）。

**【原文】** Inspect 的 `stderr(cluster="…")` 实现了这个公式，但加了有限簇校正，「(unlike the paper)」（`std.py:86-114`，注释在 90 行）。

### 4.3 每个任务跑几次（K）

**【原文】** §3 与 §3.1：

$$Var(\hat\mu)=\frac{Var(x)+\mathbb E[\sigma_i^2]}{n}$$

每题重复 K 次、取题内均值后：$Var(s_i)=\sigma_i^2/K$。

- 「Once $\mathbb E[\sigma_i^2]/K\ll Var(x)$, increasing K further will have little effect」。
- 二值得分且难度 $x\sim U[0,1]$ 时，$Var(x)=1/12$，$\mathbb E[\sigma_i^2]=1/6$，$Var(\hat\mu|K)=Var(\hat\mu|K=1)\times(1+2/K)/3$。K=2 时方差降 1/3，K=4 降 1/2，K=6 降 5/9，上限 2/3。
- 「computing a pooled standard error across all $KN$ answers will be inconsistent」：SE 必须在题级均值上算，或按 §2.2 聚类。

**【原文】§3.3「Don't touch the thermostat!」：** 不要为了降方差去调采样温度。降温可能把条件方差转移到条件均值的方差上（示例里从 1/12 变成 1/4），甚至引入偏差。

**【原文】** BrowserGym 为每个基准给出建议 seed 数（§2.1.5）。τ-bench 用多 trial 来算 pass^k（§2.4）。在这些来源里**没找到**一个跨基准通用的「每任务跑几次」固定数字。

### 4.4 两个版本怎么比

**【原文】** §4.1（非配对，式 5–6）：

$$\hat\mu_{A-B}=\hat\mu_A-\hat\mu_B,\quad SE_{A-B}=\sqrt{SE_A^2+SE_B^2},\quad CI=\hat\mu_{A-B}\pm1.96\,SE_{A-B},\quad z=\hat\mu_{A-B}/SE_{A-B}$$

**【原文】** §4.2（配对，同一组题，式 7）：

$$SE_{A-B,paired}=\sqrt{\frac{1}{n}\cdot\frac{1}{n-1}\sum_i(s_{A-B,i}-\bar s_{A-B})^2}$$

$Var_{paired}=Var_{unpaired}-2\,Cov(x_A,x_B)/n$。只要两个版本对「哪些题难」看法相关，配对就能「免费」降方差；建议同时报告配对差、配对 SE 和相关系数（Table 5）。聚类配对版为式 8：

$$SE_{A-B,paired,clustered}=\frac1n\left(\sum_c\sum_i\sum_j(s_{A-B,i,c}-\bar s_{A-B})(s_{A-B,j,c}-\bar s_{A-B})\right)^{1/2}$$

在这些来源里**没找到**把 McNemar 检验作为推荐做法的表述。Miller 用的是基于 SE 的 z 检验。

### 4.5 样本量：多少题才能分辨多大的差距

**【原文】** §5 式 9 与式 10：

$$n=\frac{(z_{\alpha/2}+z_\beta)^2\,(\omega^2+\sigma_A^2/K_A+\sigma_B^2/K_B)}{\delta^2},\qquad \delta=(z_{\alpha/2}+z_\beta)\sqrt{\frac{\omega^2+\sigma_A^2/K_A+\sigma_B^2/K_B}{n}}$$

其中 $\omega^2=Var(x_A)+Var(x_B)-2Cov(x_A,x_B)$，$\sigma^2_{A}=\mathbb E[\sigma^2_{A,i}]$。示例：$\sigma^2=0$、$\omega^2=1/9$、δ=0.03、α=0.05、β=0.2 时，$n\approx969$；「new evals should contain at least 1,000 questions in order to have good signaling ability」。

**【原文】** Anthropic 文的另一面：早期效应量大，20–50 个任务就够；「More mature agents may need larger, more difficult evals to detect smaller effects」（Step 0）。

---

## 5. 问题四：与本产品对照（**全节为推断**，仓库事实单独标注）

### 5.1 仓库里的事实（读到的）

- **【事实】** `tests/eval/` 只测抽取器，按 recall@budget、ambiguity、top1_ceiling 等门槛打分。`tests/eval/score.mjs` 头注释写的是 `top-1 accuracy = recall@budget × representation distinguishability × model conditional accuracy`，前两项今天就能测。
- **【事实】** `tests/eval/annotations.json` 按 fixture 给出 `{id, goal, group, descriptor:{role, name}}`，即「目标 → 目标元素描述」。
- **【事实】** 真机 harness 的到达判定是 URL 正则（`live-github-run.mjs:475-492` 的 `arrived: (u) => /…/.test(u)`）。它的注释说这些目标的终点「are all nameable」。
- **【事实】** `score-run.mjs` 算的项目：
  - `task_success_rate`（`arrived/judged`）；
  - 解析失败率，走产品自己的解析器；
  - 校验失败率、首抽失败率（来自 trace 的 `repair` 条目）；
  - 多步占比，只统计不离开本页的计划；
  - clarify 占比、hops/轮；
  - token 与缓存命中后的计费均次。
  
  门槛是与冻结基线比较，其中只有 `multi_step_share` 用了 95% CI 余量，SE 按每个 guide 的伯努利分布计算（`multiStepMargin`）。
- **【事实】** `RunRecord` 字段为 `runId, at, goal, url, route, steps[{title, outcome}], status, evidence, check, calls`（`record.ts:19-34`）。`status` 的判定规则是：没有任何 `confirmed` 步即 `abandoned`，全部 `confirmed` 即 `completed`，否则 `partially_completed`（`record.ts:49-54`）。步骤 outcome 取 `confirmed|skipped|failed|invalidated`（`thread.ts:13`）。记录里**不含** token、延迟，也不含每步的 ref。
- **【事实】** trace 默认关闭，最多 24 条。`system` 只存一份；`request` 条目存完整 user 消息，即序列化后的元素表；另有 `raw`、`parse_error`、`repair`、`settled`、`not_in_table`、`violation` 条目（`trace.ts:34-68`）。
- **【事实】** ndjson 每轮一行，字段为 `round, pass, kind, goal, url, step1, hops, done, record, endUrl, arrived, anomalies, fired, clicked, traceEntries, thread, trace`；每一跳有 `usage`、`plans`、`overlay`、`doneProposed`。`plans[].table` 里只存了 `{url, title, items: <数量>}`，不是元素表本身（抽查 run7 第 2 行）。**我在这些字段里没看到人工判定字段。**
- **【事实】** `GuideStep` 有可选的 `ref`、必有的 `descriptor`、`expectedUserAction`，以及 input 步的 `value`，即「建议用户输入的文本」（`protocol.ts:108-128`）。
- **【事实，由日志计算】** run7 共 21 轮：`record.status × arrived` 为 `completed & true` 8 轮、`completed & false` 8 轮、`partially_completed & false` 2 轮、无 record 3 轮。run6 的轮次都没有 `record` 字段。

### 5.2 原样适用的（推断）

- **二值任务成功率 + 按任务聚类的 CI**：「7 个目标 × 3 遍」正是 Miller §2.2 和 §3.1 所说的簇结构。
- **pass^k / pass@k 的估计量**：τ-bench 的原始动机是「customer-facing agents where users expect reliable behavior every time」，这与只指路、用户每次只看到一次引导的产品是同一类诉求。
- **配对比较**（式 7/8）与**样本量公式**（式 9/10）。
- **评审器校准口径**（一致率、κ、precision/recall、gap），前提是引入任何 LLM 判定，例如判「最后一步指得对不对」。
- **正反两面的任务集**（Anthropic Step 3）：对应 clarify、need_docs、done 这几种「不该给 guide」的情形，现有 `clarify_share` 只统计了一侧。
- **成本报法**：token 数加美元，在准确率–成本平面上看 Pareto（AI Agents That Matter）。

### 5.3 要改口径的（推断）

- **「成功」的主体变了。** 文献里 agent 自己动手；我们是 harness 替用户点被高亮的控件。harness 测到的其实是「用户严格照着高亮走时能不能到」，没有覆盖用户偏离、误读卡片这类人为环节。
- **用户口径是「URL + 最后一步」。** 这接近 WebArena 的 `url_match × program_html` 乘积（URL 对且页面状态对），但我们的「页面状态」是「最后一步高亮的元素对不对」。现在 `score-run` 只算了 URL 那一半。
- **部分完成。** WebCanvas 的 key node、ST-WebAgentBench 的 PCR、Anthropic 的部分分都需要「中间节点」定义。Run record 里的 `status` 衡量的是步骤是否被用户**确认**，不是任务是否达成；run7 的 `completed & false` 8 轮就是例证，所以不能直接当 PCR 用。
- **效率。** Online-Mind2Web 的 $E=S_i/\hat S_i$ 需要人类参考步数。对我们来说，「步」可以指用户动作数（hops），也可以指模型调用数（calls），两者口径不同。
- **越界。** 动手的是用户，所以「有害动作率」要换成「引导到敏感或破坏性控件、或引导跨站输入凭据」这类**引导**层面的违规率。CuP「成功且零违规」的结构可以保留，违规的定义要重写；ST-WebAgentBench 的 dormant 概念（触发条件没出现就不计）同样用得上。
- **页面问答路径。** 答案部分对应 WebArena 的 $r_{info}$（exact / must_include / LLM fuzzy）或 AssistantBench 的 F1；「依据控件」部分对应 Element Accuracy（落在可接受集合里）；弃权（clarify、need_text）对应 AssistantBench 的 answer rate 与 precision。

### 5.4 不适用或基本不适用的（推断）

- WebArena 的数据库状态检查、τ-bench 的数据库哈希、VisualWebArena 的 SSIM：我们不拥有 github.com 的后端，任务也不改变网站数据。
- 把 pass@k 当产品指标：它衡量的是「k 次里至少一次成功」，用户看不到 k 次。它只适合作为能力上限的诊断。
- Operation F1 里 Type 值的正确性：只在 `GuideStep.value`（建议输入的文本）这一处有对应物，而且输入是用户做的。

### 5.5 Mind2Web 式离线步骤级评估能不能直接套到「元素表 + 目标 + 历史 → 选 ref」（推断）

**形状同构的部分：**
- Mind2Web 的「给真实历史、每步独立评」与我们「每一跳用当前表 + 历史重新规划」的调用方式一致。
- MindAct 的「top-50 候选多选」与「元素表里选 ref」一致。
- 现有 `recall@budget`（抽取器 eval）正好对应 Mind2Web 候选生成的 Recall@k（`metric.py:99-106`），而「gold 不在预算内即记 0」也是 Mind2Web 的做法（`metric.py:120-125`）。按 `score.mjs` 头注释的分解，缺的正是第三个因子「模型条件准确率」，也就是 Element Accuracy。

**不能直接套的部分：**
1. **输出是计划，不是单个动作。** `steps[]` 可以有多步，后面的步骤可能不带 `ref`（只有 `descriptor`）。离线评分要先决定只评 `steps[0]`、评整个计划，还是按 descriptor 匹配。
2. **非动作意图。** `clarify`、`need_docs`、`done` 在 Mind2Web 里没有对应物，需要 WebLINX 式的 intent match（先判意图对不对）。
3. **多路径。** Mind2Web 的 gold 来自一条演示轨迹，论文自己承认会有假阴性。GitHub 上「找到 n8n 仓库」可以走搜索框，也可以直接点推荐，gold 必须是**可接受集合**（Mind2Web 的 `pos_candidates` 本就支持多个），或者退回 WebCanvas 按 URL 定义 key node。
4. **快照的时间性。** ref 只在一次快照内有效，gold 需要连同那张表一起存下来。现在 ndjson 的 `plans[].table` 只有计数；trace 的 `request.user` 里有序列化后的表，但默认关闭且上限 24 条。
5. **Operation F1** 对应 `expectedUserAction` 加 `value`，可以算，但权重意义与 Mind2Web 不同（我们不执行这个操作）。

**【推断】** `annotations.json` 的形状是「goal → 可接受元素描述」，与 Mind2Web 的单步样本（无历史）同构，但它是为抽取器写的静态 fixture，不是真实任务的逐步标注。

### 5.6 现有数据够算哪些、缺什么（推断），以及用两份日志算出来的数

| 指标 | 现有数据能否计算 | 缺什么 |
|---|---|---|
| 任务成功率（URL 口径） | 能：ndjson 的 `arrived` / `endUrl` | — |
| 任务成功率（用户口径「URL + 最后一步」） | 不能 | 人工判定没落盘；最后一步的 ref 与 gold 都没有 |
| pass^k / pass@k（k≤3） | 能：7 个目标 × 3 遍 | — |
| 聚类 SE / Wilson CI / 配对比较 | 能 | 簇数只有 7，正态近似很粗（Inspect 此时改用 t） |
| 步骤级 Element Accuracy | 不能 | 逐步 gold（可接受 ref 集合）；逐步的完整表（trace 默认关、有上限） |
| intent 分布、解析/校验/首抽失败率 | 能（`score-run.mjs` 已实现） | — |
| token / 计费 | 能（ndjson 的 `usage`）；Run record 里没有 | 产品运行时的 Run record 没有 token |
| 延迟 | 部分：`start` 行有 `ms` 字段 | 逐调用延迟、TTFT 这类口径 |
| 效率 $E=S/\hat S$ | 不能 | 人类参考步数 |
| LLM 评审与人工一致率 | 不能 | 同一批轨迹上的人工标签与评审标签 |
| 越界 / 敏感引导率 | 不能 | 违规的定义与标注 |

用 τ-bench 与 Miller 的公式对两份日志的 `arrived`（URL 口径）直接计算，结果如下（计算脚本没有落盘，数据来自 `tests/spike/live-github-run-log.run6.ndjson` 与 `.run7.ndjson`）：

| | run6 | run7 |
|---|---|---|
| 成功 / 轮数 | 11/21 = 52.4% | 8/21 = 38.1% |
| Wilson 95% CI | 32.4%–71.7% | 20.8%–59.1% |
| 朴素 SE（式 1） | 11.2pp | 10.9pp |
| 按目标聚类 SE（式 4） | 15.0pp | 10.8pp |
| 7 个目标均值上的 SE（§3.1 做法） | 16.0pp | 11.3pp |
| pass^1 / pass^2 / pass^3 | 0.524 / 0.381 / 0.286 | 0.381 / 0.143 / 0.000 |
| pass@3 | 0.714 | 0.714 |

两份日志按目标配对的差（run6 − run7）：+14.3pp，配对 SE 9.9pp，95% CI 为 (−5.1pp, +33.7pp)，**不显著**。把配对 SE 代入式 10：α=0.05、功效 80% 时，最小可检出差距约 (1.96+0.84)×9.9 ≈ **28pp**；若按 Inspect 的做法在 7 个簇下用 t（自由度 6），约 (2.447+0.906)×9.9 ≈ **33pp**。我不知道这两份日志之间改了什么，所以这里只示意量级，不对版本做结论。

---

## 6. 没查到 / 不确定

- **Braintrust**：只读到 autoevals 概览。关于 experiment 对比、基线 diff、线上打分的一手文档页，我在 `llms.txt` 索引里没定位到，因此本文没有引用 Braintrust 的实验对比口径。
- **HAL（Holistic Agent Leaderboard）** 等成本排行榜：没读。
- **GAIA**：在读到的正文里没找到「网页相关子集」的独立评分口径和题数占比。
- **Mind2Web**：在读到的 `metric.py` 片段里没找到 task SR 的单独计算，定义以论文为准。
- **VisualWebArena**：`evaluators.py` 没有逐行核对，只核对了论文里的函数定义。
- **OpenAI**：graders 弃用的具体时间线在 deprecations 页，没读。文档里出现的模型名（如 `gpt-6-astra`）照录，没有核实。
- **LLM 评审的校准样本量**：在这些来源里没找到明确要求。
- **HAR 回放**：在这些来源里没找到把它作为网页 agent 评估介质的做法。

---

## 7. 引用速查

- WebArena：https://arxiv.org/abs/2307.13854v4 ；https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py
- VisualWebArena：https://arxiv.org/abs/2401.13649v2
- WebVoyager：https://arxiv.org/abs/2401.13919v4 ；https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/evaluation/auto_eval.py
- Online-Mind2Web：https://arxiv.org/abs/2504.01382v4 ；https://github.com/OSU-NLP-Group/Online-Mind2Web/tree/f0d805ee0e9e0b3ea70911e45e5264b72968f3dc
- Mind2Web：https://arxiv.org/abs/2306.06070v3 ；https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/src/action_prediction/metric.py
- WorkArena：https://arxiv.org/abs/2403.07718v5 ；BrowserGym：https://arxiv.org/abs/2412.05467v4 ，https://github.com/ServiceNow/BrowserGym/tree/9e779f087de9a65668b6974d11f9ce9816026e96
- AssistantBench：https://arxiv.org/abs/2407.15711v2
- GAIA：https://arxiv.org/abs/2311.12983v1 ；https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py
- τ-bench：https://arxiv.org/abs/2406.12045v1 ；https://github.com/sierra-research/tau-bench/blob/59a200c6d575d595120f1cb70fea53cef0632f6b/tau_bench/run.py
- Codex：https://arxiv.org/abs/2107.03374v2
- Miller：https://arxiv.org/abs/2411.00640v1
- ST-WebAgentBench：https://arxiv.org/abs/2410.06703v7 ；SafeArena：https://arxiv.org/abs/2503.04957v1 ；AgentRewardBench：https://arxiv.org/abs/2504.08942v2
- AI Agents That Matter：https://arxiv.org/abs/2407.01502v1 ；WebLINX：https://arxiv.org/abs/2402.05930v2 ；WebCanvas：https://arxiv.org/abs/2406.12373v3
- Anthropic：https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- OpenAI：https://developers.openai.com/api/docs/guides/trace-grading.md ，/agent-evals.md ，/graders.md ，/evaluation-best-practices.md ；https://openai.github.io/openai-agents-python/tracing/
- LangSmith：https://docs.langchain.com/langsmith/trajectory-evals ，https://docs.langchain.com/langsmith/evaluation-concepts.md ；agentevals：https://github.com/langchain-ai/agentevals/blob/946ad15b9f2ce9bc9843edd2bb773bd07d78ca7e/python/agentevals/trajectory/match.py
- Inspect：https://github.com/UKGovernmentBEIS/inspect_ai/blob/52b30883d1bf11a183fa82640429728595ea8d6f/src/inspect_ai/scorer/_metrics/std.py ，…/_reducer/reducer.py ，…/docs/metrics.qmd
- Braintrust：https://braintrust.dev/docs/sdks/python/related/autoevals/overview.md
