# 09 — 第一轮完整的真机评估，由你判定

**What to build:**

用定稿的约 26 个目标，每个跑 3 遍：Skill 开（默认组合），真实 DeepSeek，github.com 已登录。生成报告页，你判定，拉回，重新生成。

- 这一轮有三个用处：
  - Task eval 的第一个数，之后每一轮都和它配对；
  - Decision eval 语料的来源（第 11 张）；
  - 预填标注的来源（第 12 张）：只有你判了 ✓ 的趟拿来预填。
- 花费：约为第七轮的 3–4 倍（第七轮 21 趟用了 81 万 token）。

**Blocked by:** 04 — harness 记下每一次模型调用的完整输入；05 — harness 不再替产品制造失败：跨站确认卡，与串轮的账号状态；07 — 任务集：三个站点、约 26 个目标，由你定稿；08 — 真机报告页：统计量、你的判定存进页面数据库、再拉回仓库

**Status:** done（2026-09-15，以 t11 完成：26 个目标 × 2 遍，你判完全部 52 趟）

## gitee 要重跑（2026-09-14）

- t09 的 gitee 部分是**匿名、英文界面**跑的：各趟开始时的登录身份全是空，元素表里是 Sign in、Code、Issues。gitee 把 harness 的浏览器当成海外访问，默认给英文界面和海外登录页（只能用邮箱加验证码）。
- harness 现在：
  - 用 `GITEE_ACCOUNT`、`GITEE_PASSWORD` 登录。走 `https://gitee.com/login#lang=zh-CN` 的账号密码表单，判断登录用经典页面上的 `gon`：登录后的首页是 React 工作台，那里没有 `gon`。
  - 每趟开始前设 `user_locale=zh-CN`，界面是中文（你定的：中文界面）。
  - 有账号的站点一律登录后才跑：登录不上会在浏览器里等你手动完成，最多 3 分钟，仍不行就停下，不再匿名跑。github 也照此办理。
  - 记录头里多了 `accounts`，写明登录了哪些站点、设了哪些 cookie。
- 冒烟 `t10-gitee-login`（gitee-closed-issues、gitee-repo-address 各 1 遍）：登录上了，界面是中文；两个都没到。
  - 看已关闭的 issue：中文界面的选项卡是「已完成 4164」（`state=closed`）和「已关闭 4」（`state=rejected`），模型点了「已关闭」。**你定：两个都算**，判据已改（`goals.ts` 的 gitee-closed-issues）。
  - 拿仓库地址：仍在分支下拉和「代码」之间打转，与登录无关。
- 所以本票的 gitee 部分要用新的 harness 重跑，判定也按重跑的来。

## 改为 t11：全部目标各 2 遍（2026-09-15，你定）

- 为了尽快收尾规格 B，不再判 t09，改为用新的 harness 把 26 个目标全部重跑一轮 `t11`，每个 **2 遍**（票上原写 3 遍），共 52 趟。
- 影响：报告里只有 pass^1、pass^2，没有 pass^3；每个目标的到达率只有 0、½、1 三档，区间会比 3 遍宽。
- 之后第 12 张的第一批从 t11 挑，第 15 张的 Task eval 配对也对 t11。
- **t11 已跑完**（2026-09-15 18:15 开始，闲时价）：
  - 52 趟，仪器故障 0；github、gitee 每趟开始时都已登录，阿里云不需要登录；记录头写着 gitee 的 `user_locale=zh-CN`。
  - 程序化判据到了 24/52：github 13/20，gitee 3/16，阿里云 8/16。结束方式：模型说到了 34 趟，harness 替用户结束 13 趟，打转兜底 5 趟。
  - 报告页生成时不配对上一轮：t09 的 gitee 是匿名、英文界面，又是 3 遍，拿来配对会误导。
  - t11 的报告页：https://claude.ai/code/artifact/a0fd2bdf-b2b3-4cdd-99a9-7e56c1992993（取代上面 t09 那张）

## 模型（2026-09-14 定）

- 用 `deepseek-flash`（DeepSeek-V4.1-Flash），**关思考**。
- 以前各轮配的 `deepseek-chat` 是旧名，官方宣布 2026-07-24 停用，`/models` 里已经没有它。实测它现在回传的 `model` 是 `deepseek-flash`，`system_fingerprint` 与直接调 `deepseek-flash` 相同，也没有推理内容。所以 t06-a、t07 跑的就是这个模型的非思考模式，和这一轮可以配对。
- 新名字默认开思考，而开思考会拒收产品的 `tool_choice: required`（HTTP 400）。所以 deepseek 预设带上 `thinking: {type: 'disabled'}`（`Preset.request`，由 `provider.ts` 发出）；架构护栏的请求体白名单为预设字段另立了一份按厂商的清单。
- 冒烟 `t09-flash-smoke`（gh-issues × 1）：两次调用都成功；那一趟停在模型的澄清上，没到。
- 成本按闲时单价（每百万 token：输入 ¥1、缓存命中 ¥0.02、输出 ¥4）估；跑进工作日高峰（北京时间 9–12、14–18 点）的部分实际是两倍。

- [x] 约 78 趟全部跑完。仪器故障的趟（元素表为空、Plugin 组合对不上、harness 没点成）单列，不当作对模型的观测——`t09`：78 趟，仪器故障 0 趟
- [x] 报告页已发布，页首写明这是第一轮、没有可配对的上一轮——https://claude.ai/code/artifact/2f3497ab-a400-4855-9c99-43eb79171d7a
- [x] **要你做的**：判完全部的趟——t11 的 52 趟全部判完（2026-09-15）：到了 23、终点错 21、不作数 8、最后一步错 0
- [x] 判定已拉回仓库，对账一节已出现——`evals/task/runs/t11/verdicts/`
  - 正式到达率 52.2%（36.0%–67.9%）：github 65.0%，gitee 35.7%，阿里云 50.0%；pass^1 0.522，pass^2 0.333。
  - 对账：一致率 93.2%，precision 95.5%，recall 91.3%。
  - 安全违规全是 0；成本 ¥0.85（闲时价）。
- [x] 抽查三趟：日志里每次模型调用都有完整输入（第 04 张）——P1-gh-releases、P2-gitee-other-branch、P3-aliyun-rds-mysql-lifecycle：`params` 四样（目标、元素表、历史、注入内容）与 `trace` 三样（系统提示、工具、消息）都在。全轮 358 次调用里有 7 次发出后没等到回答（`outcome` 为空，因而没有 `trace`），按「未回答」计；其中 `gitee-javadoc` 三遍都在第 1 跳
