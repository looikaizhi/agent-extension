# 01 — 只留一个 plan source

**What to build:** 线程只有一种来源——模型规划。`planSource: 'model' | 'fixed'` 这个字段，以及 `fixed` 那一整台状态机，全部删除。

**为什么（用户 2026-09-26 定）：** 主场景是跨页去做成一件事，而**每一步之后页面就变了**——预先算好的计划在那里必然失败。真跑记录印证：t09 + t11 共 130 趟、382 跳里，**71% 的跳在这一步之后就翻页**（同一 URL 上连续 1 跳的段：161 / 109 段），最长连段 5 跳。

而 `fixed` 的实际形状是**一台多步引擎服务一个只发一步的功能**：产品里唯一的生产者是检视器的「指给我」，永远只交接一步。这正是 CLAUDE.md 说的投机性抽象——为「交接一串步骤」建的，而那个需求从未出现。它也从来没有真跑过（唯一入口不经过模型），`step_skipped` 那条推进通道连 e2e 都没走过。

---

## 删掉的

| | |
|---|---|
| `agent/thread/fixed-plan.ts` | 166 行，整个文件 |
| `planSource` | 字段 + 13 处分支：`stepOnScreen`、`callBlocked`、`present`、`applySaid`、`retryGuideCall`、`paintStep`、`GET_CONVERSATION` 的钉住卡片 |
| `start_fixed` / `step_skipped` | 两种 `MachineInput`、两个处理函数、两条 dispatch 分支 |
| `SKIP_STEP` RPC · `STEP_SKIPPED` 事件 | 宿主两个处理器、`presenter.skip()`、浮层两个按钮（步骤行「跳过」+ 失效屏「跳过此步」）、侧栏「跳过这一步」 |
| `skippable` / `canSkip` | `HighlightCommand`、`PinnedStep`、`StepView`、读回状态、ask/explain 两条命令里的 `skippable: false` |
| `StepAction: 'skipped'` | 删了之后没有生产者——模型驱动的引导跳过之后会重新规划、把同一步原样递回来 |
| `Evidence: 'handpicked'` · `WireEvidence` 同名值 | 同上；`describeEvidence` 少一个分支 |

## 「指给我」变成什么（用户选的「只框不跟」）

新的 `outlineByHand()`：抽一次页（只为拿 `view` 与 `snapshotId`——宿主没有 `tabs` 权限，地址只能问内容脚本）→ 结束这个标签页上在跑的引导（一个浮层一个主人）→ 用 `mode: 'guide'` 画那一个框 → 对话里留一行「已经在页面上框出「X」」。

- **不开线程。** 浮层照样报 `used` / `target_lost` 这些读数，到宿主发现没有线程就丢掉——这正是「不跟」。
- **仍然按 descriptor 重绑**（所以选 `guide` 而不是 `explain`：后者快照一失效就报 `snapshot_stale` 消失）。页面重渲染，框还在。
- 丢掉的三样：不再跟踪你用没用它、不写 Run record、没有「跳过」。

## 顺带一处判据变化

`present()` 以前对固定计划报 `{index: cursor, total: steps.length}`（屏上「步骤 2 / 5」），模型那条路报 `total: null`（「第 3 步」）。现在只剩后者——**模型一次只给一步，谁也不知道还剩几步，写一个总数就是编的。**

---

**Status:** done（2026-09-26）

- [x] 全仓只剩一种 plan source；`planSource` 字段不存在
- [x] 「指给我」只画不跟，且页面重渲染后框仍在
- [x] 类型检查 ✅、单测 **1108** ✅（比改前少 28 条，全是随固定计划删的）、e2e **267/267** ✅（少 17 条，同上）

## e2e 里删掉的覆盖，以及为什么不算损失

| 删掉的断言 | 为什么 |
|---|---|
| 点了目标 → 游标前进 | 固定计划独有的推进语义 |
| 失效屏上的按钮能推进流程 | 那个按钮（跳过）整个不存在了；失效屏「卡片能接收点击」这一条留着 |
| 刷新 / 用户自己去了别处 → 不前进、重画同一步 | **模型那条路的设计恰好相反**：页面一变就重新规划，而且调用在途时刻意不重画手上那一步（L-4，见 `stepOnScreen`） |
| 模型规划的引导不提供「跳过」 | 没有任何引导提供它了 |

**唯一真实的缺口**：真浏览器里「用户点了目标 → 宿主把它变成读数唤醒模型」这条链现在没有 e2e。前半句（真点击产出 `STEP_USED`）仍由「用过不是丢了」那一段覆盖；后半句由 `readings.spec.ts` 的宿主层用例覆盖（假 store、非浏览器）。

## 过程里的一次险情

删 `readings.spec.ts` 的固定计划整块时，把紧挨其后的三个共用夹具（`harness` / `idleWithStepOnScreen` / `T`）一起剪掉了。这个文件是**未提交的新文件**，`git show HEAD:` 里没有——最后是从上一个会话的对话记录里把原文取回来的，并补上 `GuideEffectDeps` 后来新增的 `recent` 字段。
