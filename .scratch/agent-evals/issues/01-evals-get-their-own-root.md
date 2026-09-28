# 01 — 评估搬到仓库根目录的 `evals/`

**What to build:**

今天的抽取器评测住在 `tests/eval/`，真机 harness 和它的打分脚本住在「一次性试验」目录 `tests/spike/`。把它们搬进仓库根目录的 `evals/`，一层一个子目录：

- `evals/extract/`：`tests/eval/` 原样搬来（采集、打分、fixture、标注、门槛）。`npm run eval`、`eval:score` 改指这里，门槛和输出不变。
- `evals/task/`：`live-github-run.mjs` 与 `score-run.mjs` 搬来。新增 `npm run eval:task`：先构建再跑 harness，和 `eval` 的写法一样。行为不变，仍是 github.com 7 个目标。
- `evals/decision/`：本票不建。`eval:decision` 随第 13 张出现，不留占位。

另外四件事：

- **`evals/` 要进版本管理，所以不能依赖 `tests/`**：`.gitignore` 忽略了整个 `tests/`。evals 下的代码和数据不得 import `tests/` 下的任何文件。两个 alias loader 搬进 `evals/`，留在 spike 里的脚本改用新位置。evals 下的代码纳入类型检查。
- **删掉已经没用的路径**：
  - harness 里 `PG_TOOLS` 写的 `tools:enabled`：产品里已经没有代码读它。
  - `score-run.mjs` 的 `gate()` 与 `--against`：它们是「tool calling 能不能取代文本信封」那次决定的量具，那次决定早已做完。`baseline-text-envelope.json` 留在 spike，当作那次的记录。
- **`tests/spike/` 只留一次性探针**：`flow-accuracy`、`guide-envelope-smoke`（golden 语料取自它的日志）、`live-guide-run`、三个 probe。旧的真机日志和截图留在原处，它们是当时的记录。
- **路径引用同步**：源码注释、教程、CONTEXT.md 里点名旧路径的地方一并改掉。`docs/` 下的调研与设计文档是当时的记录，不改（规格 A 第 12 张也是这样处理的）。

两层评估都是手动命令，不进 `verify`。

**Blocked by:** None — can start immediately

**Status:** done

- [x] `tests/eval/` 不复存在；`npm run eval` 的每一项数字、每一道门槛都和搬家前一致
- [x] 搬过来的 `score-run.mjs` 给第七轮日志打分，数字与搬家前逐项一致（门槛那一段已删，不比）
- [x] `npm run eval:task` 能起跑：`PG_ROUNDS=1 PG_REPEATS=1` 走完一趟
- [x] 架构守卫新增一条：`evals/` 下没有任何文件 import `tests/` 下的东西（带「至少扫到一个文件」的自检）
- [x] `.gitignore` 不忽略 `evals/` 下的代码与数据
- [x] 代码里不再出现 `tools:enabled`
- [x] `verify` 里没有 `eval`、`eval:task`
- [x] 类型检查、单测、e2e 全绿

**实现记录**
- **搬了什么**：
  - `tests/eval/` 整个 → `evals/extract/`；`live-github-run.mjs`、`score-run.mjs` → `evals/task/`；两个 alias loader → `evals/`。它们按自己所在的位置找 `src/`，同样在仓库下一层，代码不用改。
  - `package.json`：`eval`、`eval:score` 改指 `evals/extract/`；新增 `eval:task`，先构建，再用 alias loader 跑 harness。`verify` 不变。
  - `tests/spike/` 剩下 flow-accuracy、guide-envelope-smoke、live-guide-run、三个 probe，以及旧的日志与截图。两个 spike 脚本改用 `evals/` 下的 alias loader；guide-envelope-smoke 运行时读的采集产物路径改到 `evals/extract/`。
- **类型检查**：`.wxt/tsconfig.json` 的 include 本来就是整个仓库，之后 evals 下的 `.ts` 会自动进类型检查，不用改配置。今天 evals 下都是 `.mjs`，和搬家前一样不做类型检查。
- **版本管理**：`.gitignore` 只加了三项运行产物：
  - 抽取器的采集产物 `evals/extract/captured/`：每次采集都重写，里面带耗时；
  - harness 的日志文件与截图目录：这是 harness 今天写死的输出位置，第 03 张换成各轮次目录下的 `raw/` 时一并改。
- **删掉的**：
  - harness 的 `PG_TOOLS` 分支（写 `tools:enabled`）；
  - `score-run.mjs` 的 `multiStepMargin`、`gate()`、`--against`。头注释改成它现在做什么，并写明它的到达率只是 Arrival 的 URL 那一半；
  - `score-run.mjs` 原来用写死的绝对路径 import 产品的解析器，改成 `@/`，换一台机器也能跑。
- **守卫**：
  - 新增「evals/ 不依赖 tests/」：扫 evals 下每个 `.ts`、`.mjs` 的 import 与字符串字面量（运行时拼出 `path.join(REPO, 'tests/…')` 也算），以及 `package.json` 里每条 eval 命令。带空集自检和三条合成样本。
  - 「注释里的引用必须找得到」的扫描范围加上了 `evals/`。加上之后当场抓到两处：
    - harness 注释还引用着已经退场的决策记录编号（ADR 0012）：删掉编号，保留「400 个节点」这件事实；
    - `score-run.mjs` 注释里的 `./evals/alias-loader-register.mjs`：命令行里 `--import` 必须带 `./`，注释没写错，是守卫把 `./` 当成了文件名的一部分。守卫改为解析前去掉开头的 `./`；探针 P3 证明它没因此变瞎。
- **没改的**：`docs/` 下的调研与设计文档、`step1-implementation-plan.md` 里的旧路径，是当时的记录。`src/agent/provider/provider.ts` 注释里的 `tests/spike` 指的是 golden 语料的来源，那个脚本还在原处。

**变异探针**（4 个全红；临时文件已删，`package.json` 还原后哈希一致）
- P1 evals 下的一个文件 import `tests/` 下的文件 → 新守卫红
- P2 evals 下的一个文件在运行时拼出 `tests/…` 路径 → 新守卫红
- P3 evals 下的一处注释点名不存在的 `./evals/…mjs` → 「注释里点名的源码文件都还在」红
- P4 `eval:score` 改回指向 `tests/eval/` → 新守卫红

**验证**
- 类型检查 0；单测 34 个文件 1661 条全绿（新增 1 条守卫）。
- `npm run eval`：全部门槛通过。与搬家前逐行比对，只有构建耗时和每行的毫秒数不同。
- `score-run.mjs` 给第七轮日志打分：搬家前后，`--json` 与文本输出都逐字一致。
- e2e 191/191。
- `PG_ROUNDS=1 PG_REPEATS=1 npm run eval:task`：真实 DeepSeek，github 已登录。走完 1 趟 7 跳，由打转兜底结束，Run record 读到了；搬过来的 `score-run.mjs` 读得通这份新日志（8 次调用，解析与校验失败都是 0）。
- 顺带看到的（留给第 04 张）：这一趟 7 跳就把 trace 顶到了 24 条上限，`score-run.mjs` 从 trace 数到的首抽只有 7 次，比实际的 8 次调用少一次。
