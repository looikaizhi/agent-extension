# 15 — 用 Skill 走一遍「带 / 不带」

**What to build:**

之后每加一个 Plugin（Workflow、Memory、新站点的 Skill），证明它有效都走同一套流程：先在 Decision eval 上做带 / 不带的配对比较，再在 Task eval 上确认不退步。用现有的唯一一个 Plugin——Skill——先把这套流程走一遍，顺带量出 github 的站点技能值多少。

- **Decision eval**：第一批里 github 的状态，分别用 `skill` 与 `none` 跑，按状态配对。
- **Task eval**：github 的目标用 `none` 跑 3 遍，与第 09 张那一轮（Skill 开）按目标配对。
- **写成说明**，放在 `evals/`：
  - 三条命令各测哪一层；
  - 改提示词、换模型、加 Plugin 之前，必须跑 `eval:decision`；
  - 证明一个 Plugin 有效的步骤。
- 结论写进这张票的实现记录。要不要改 Skill 的默认值另外决定，本票不改。

**Blocked by:** 09 — 第一轮完整的真机评估，由你判定；14 — 冻结基线，Decision eval 成为闸门

**Status:** won't do（2026-09-15，你定：Skill 不是主力，要等架构成熟才考虑加，不需要现在判它的效果）

- 已经跑过的 `t12-github-none`（Skill 关）和报告页留作备查，不下结论；下面「进度」里的数只是程序化判据的初步值，你没有判过。
- `evals/README.md` 里「证明一个 Plugin 有效」的流程照旧有效，以后真要加 Plugin 时照它走。

## 进度（2026-09-15）

- **Task eval 这一层**：
  - `t12-github-none`：github 的 10 个目标，Skill 关，各 2 遍，共 20 趟；仪器故障 0，每趟都已登录。记录的 Plugin 组合为空，97 次调用里没有一次带 Plugin 的段落。
  - 与 t11（Skill 开）按目标配对，暂用程序化判据：Skill 关 − Skill 开 = **−25.0pp**，95% 区间 −46.9pp 到 −3.1pp，配了 10 个目标；这样的配对能分辨的最小差距约 31pp（z）。
  - 要等你判完 t12，两轮都用你的判定时，结论才算数。
- **Decision eval 这一层**：等第 12 张的标注。

- [ ] 两层各出一份配对比较，写明配对了几个状态或目标、差与区间
- [ ] **要你做的**：判完 Skill 关的那一轮
- [ ] 说明写好：照着它能从零跑完两层——`evals/README.md` 已写（2026-09-14），「照着能从零跑完」要等本票真正跑两层时验证
- [ ] 类型检查、单测全绿
