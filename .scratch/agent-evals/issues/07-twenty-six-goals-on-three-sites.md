# 07 — 任务集：三个站点、约 26 个目标，由你定稿

> **2026-09-16：删掉 5 个目标，剩 21 个**（github 10、gitee 7、阿里云 4）。删的都是你在报告页上判过「不作数」的：`aliyun-ecs-release`、`aliyun-rds-mysql-lifecycle`、`gitee-maven` 每一趟都不作数，`aliyun-sls-query` 5 趟里 4 趟、`aliyun-oss-lifecycle-fees` 5 趟里 3 趟。参考截图一并删除，`arrival.spec.ts` 的站点数量断言已改。冻结的两批语料（`batch-1`、`on-target`）里属于这些目标的状态照旧保留，否则基线和改动前后的对比数就作废了。

**What to build:**

7 个目标 × 3 遍只能分辨约 28–33 个百分点的差距。扩到约 26 个目标 × 3 遍，大约能分辨 14 个百分点（研究报告第 5.6 节）。

- **数目**：github.com 在现有 7 个之外再加约 3 个；gitee.com 约 8 个；help.aliyun.com 约 8 个。都用第 06 张的格式，带程序化判据。
- **起草**：由做这张票的人起草。
  - 每个站点都要有需要多跳的目标；
  - 跨页导航、同页展开、站内搜索、离开本站都要有；
  - Sighting goal 与 Acting goal 两类都要有。
- **参考路径**：做票的人在真实站点上亲手把每个目标走一遍（用浏览器，不经扩展），记下每一步点了什么、终点 URL，截图为证。走不通的目标不收：一个目标怎么跑都是 0%，多半是题目本身坏了。
- **两个新站点不登录**，目标不能要求登录后才看得到的内容。
- **你定稿**：在草稿上删、改、补，定稿的清单进仓库。

**Blocked by:** 06 — 程序化判据：终点 URL 加最后一步，并能和你的判定对账

**Status:** done

- [x] 约 26 个目标，三个站点的数目大致如上
- [x] 每个目标都有程序化判据，以及一条走通了的参考路径（终点 URL 与截图）
- [x] 用判定函数给每条参考路径判一次，全部判「到」
- [x] harness 能按站点只跑其中一个
- [x] **要你做的**：定稿，清单里写明定稿日期

**进展记录**
- **github 的 7 个目标，判据已由你定稿（2026-09-13）**。第 06 张草稿里留给你的四处：
  - `gh-repo-address`（Acting）：只有用户点过「复制」、克隆地址框或「Code」之后说 done 才算；只走到仓库首页就说 done 不算；
  - `gh-releases`、`gh-contributing`：停在仓库首页、以 done 收尾，都不算；
  - `gh-docs-site`：停在 n8n-docs 仓库页、以 done 收尾，不算；
  - `gh-ci`：停在 `.github/workflows` 目录页、以 done 收尾，算。
- **为第一处加的功能**：判据里的 done 可以要求「在哪一类步骤之后」（`LastStepPattern` 的 `after`）。harness 在一趟以 done 结束时，记下用户在那之前最后走过的一步的标题。取自 harness 自己点过的跳，不取 Run record 里确认过的步骤——「复制」不会让页面变，产品不会把它记成已确认。
- **四处决定都写成了测试**（`tests/unit/arrival.spec.ts`「你在 2026-09-13 定下的四处」）；另三处本来就是草稿的写法，只在 `goals.ts` 的注释里标明是你定的。
- 验证：类型检查 0；单测 38 个文件 1730 条全绿（新增 4 条）；探针「去掉 done 对前一步的检查」→ 拿仓库地址那条红，还原后哈希一致。
- 你的到达标准记在我的记忆里，这四处也补进去了，起草新站点的判据时照这些先例：摘要页不算，Acting goal 要有生效的一步。
- **草稿写好了（2026-09-13），等你定稿**：`evals/task/goals.ts` 里 26 个目标——github.com 10 个、gitee.com 8 个、help.aliyun.com 8 个；Acting goal 两个（github 与 gitee 各一个「拿仓库地址」）。
  - **参考路径**：每个目标都由我用浏览器（ego-browser，你的 Ego Lite）亲手走过一遍，记在目标的 `reference` 里：点了什么、终点 URL、终点屏幕上是什么、截图、哪天走的。截图是 `evals/task/reference/` 下的 26 张 JPEG，共约 2.7MB。
  - **起点不都是首页**：
    - github 从首页出发，经站内搜索；
    - gitee 从 hutool 仓库页出发：gitee 的搜索结果、README 里的站外链接都在新标签页打开，而引导只跟着它开始的那个标签页，这样的路产品和 harness 都走不下去；
    - 阿里云从各产品的中文文档首页出发：文档首页的产品目录在一个面板里，点击、筛选框、悬停都没能把它打开。代价是这 8 个目标大多一步就到。
  - **从草稿里拿掉的**：gitee 的提交记录（不登录就跳到登录页）；gitee 的官方文档站（链接在新标签页打开，还要经过 gitee 的「即将跳转到外部网站」中转页）；github 的安全策略（`/security/policy` 页存在，但页面上找不到通往它的入口）。
  - **两个站点的界面语言**：ego 浏览器里 gitee 是英文界面、帮助中心首页会跳到英文版。判据里的控件名中英文都认，阿里云的终点 `/zh/` 与 `/en/` 都认，也允许地址后面带 `?spm=…`。
  - **判据的一处补充**：github 仓库页上「Contributing」页签的地址现在是 `#contributing-ov-file`，`gh-contributing` 的判据补上了这种写法。
  - **测试**（`tests/unit/arrival.spec.ts`「任务集」）：每条参考路径的终点判「到」、截图都在、各站目标数是 10、8、8、id 不重复、起点都在自己的站点上、两类目标都有。单测 38 个文件 1759 条全绿；`--site nowhere` 与「gitee 上的 gh-issues」都在开浏览器之前报「选不出任何目标」。
  - **顺带看到的产品缺口**（不在本票修）：用户点的链接在新标签页打开时，引导留在原来的标签页上，不跟过去。gitee 的搜索结果、各站 README 里的外链都是这样。
  - **走的过程中把 github 的搜索用到了限流**（「secondary rate limit」），用的是你 Ego Lite 里的 github 身份，会自己解除。之后剩下的两条路径改为从仓库页接着走，它们前半段和其他路径相同。
- **第一次冒烟**（轮次 `t07-smoke`，`gitee-issues` 与 `aliyun-ecs-billing` 各 1 趟）：两趟都 1 跳就到，程序化判据 2/2。harness 在两个新站点上照常工作：不登录、每趟前清站点状态；harness 的浏览器里 gitee 也是英文界面，阿里云一直停在中文文档里。
- **你的答复（2026-09-13）**：
  - gitee 从 hutool 仓库页出发：接受；
  - 文档要用用户提问的语言，站点没有这种语言时用英文：阿里云的中文题只认 `/zh/`，英文版算「终点不对」；
  - 加一个用阿里云没有文档的语言提问的目标，替换 `aliyun-ecs-release`；
  - gitee 和阿里云要更难一些。
- **第二轮起草：换掉 8 个一步就到的目标，每个都要两步以上**，参考路径同样亲手走过、截了图：
  - `gitee-issues` → `gitee-closed-issues`：仓库 → Issues → Closed 4164。gitee 把终点改写成 `q=is:closed`，判据两种写法都认。英文界面里还有一个也叫 Closed 的页签（`state=rejected`，已拒绝），判据不认它；
  - `gitee-pulls` → `gitee-merged-pulls`：仓库 → Pull Requests → Merged 658；
  - `gitee-branches` → `gitee-other-branch`：仓库页的分支下拉框 → v7-dev，在当前标签页切换。分支页上的分支链接会在新标签页打开，所以不走那条路；
  - `gitee-core-module` → `gitee-core-pom`：仓库 → hutool-core → pom.xml；
  - `aliyun-ecs-release` → `aliyun-ecs-billing-ms`：用马来文问 ECS 有哪几种计费方式，起点是 ECS 的**中文**文档首页，路径是「简体中文」→「English」→ Billing，只认英文版；
  - `aliyun-ecs-billing` → `aliyun-ecs-billing-switch`：ECS 首页 → 产品计费 → 包年包月转按量付费；
  - `aliyun-oss-storage-classes` → `aliyun-oss-lifecycle-fees`：OSS 首页 → 生命周期 → 生命周期费用说明。原想用「按最后修改时间删除旧文件」的规则文档，但「生命周期」页上找不到，就换成这篇终点明确的；
  - `aliyun-rds-quickstart` → `aliyun-rds-mysql-lifecycle`：RDS 首页 → RDS MySQL数据库 → 大版本生命周期说明。
- **验证**：类型检查 0；单测 38 个文件 1760 条全绿。「文档用用户的语言」写成了测试：中文题停在英文版上判「终点不对」；马来文题只有英文版算到，停在中文版上也判「终点不对」。截图仍是 26 张，被替换的 8 张已删。
- **第二次冒烟**（轮次 `t07-harder`，4 个新换上的难目标各 1 趟）：程序化判据判到 1/4。
  - `gitee-closed-issues`：到了，2 跳（Issues → Closed 4164），两个同叫 Closed 的页签没选错；
  - `gitee-other-branch`：没到。v7-dev 本来就是元素表里的一个链接，模型两次都没指它，指的是包住整个分支下拉框的大元素（generic），harness 点它的中心没打开下拉框，被打转兜底停下。目标本身走得通，是模型挑控件的问题；
  - `aliyun-ecs-billing-ms`（马来文）：没到。模型用马来文作答，但一直在中文文档里挑链接，中文的计费页就说到了。更要紧的是元素表里没有语言切换控件：表没被截断（截掉 0 项），顶栏其他控件都在，但有几个没有名字的按钮，语言切换多半就是其中一个只有图标的按钮；
  - `aliyun-oss-lifecycle-fees`：没到，0 跳。开局模型答的是 need_docs（想先读讲生命周期费用的文档），这条循环还没接通，产品只能说做不到，这一趟就停了。目标本身走得通。
- **你的定稿（2026-09-14）**：
  - 马来文那条去掉，换回 `aliyun-ecs-release`（「这台 ECS 我不用了，怎么把它释放掉？」）。截图从当时的原图重新转了一张；马来文那张已删。「文档用用户的语言」这条规则保留在判据的注释和测试里：现在 26 个目标都是中文提问，只认 `/zh/`；
  - 其余清单照第二轮起草定稿：github 10 个，gitee 8 个（`gitee-repo-address`、`gitee-closed-issues`、`gitee-merged-pulls`、`gitee-other-branch`、`gitee-core-pom`、`gitee-org`、`gitee-javadoc`、`gitee-maven`），help.aliyun.com 8 个（`aliyun-ecs-billing-switch`、`aliyun-ecs-create`、`aliyun-ecs-regions`、`aliyun-ecs-release`、`aliyun-oss-lifecycle-fees`、`aliyun-rds-billing`、`aliyun-rds-mysql-lifecycle`、`aliyun-sls-query`）；
  - `goals.ts` 头注释写明了定稿日期。
- **冒烟摸出的三个产品缺口**（都不在规格 B 里修，另外开票）：
  - 链接在新标签页打开时，引导留在原来的标签页上，不跟过去（gitee 的搜索结果、分支页、README 外链）；
  - need_docs 的循环只接了一半，模型想先读文档时，产品只能说做不到（decisions.md 已记）；
  - 只有图标、没有无障碍名字的按钮，模型认不出是什么（阿里云的语言切换）。
