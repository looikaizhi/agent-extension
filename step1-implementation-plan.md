# 第一步实施方案 · 浏览器插件前端 + 两个 Tool

> 2026-08-06
> 范围：只做浏览器插件前端。Agent / LLM / Provider 全部不碰，仅留一个 stub 边界。
> 前置文档：`page-guide-extension-design.md`（总设计）· `AGENTS.md`（工程约束）

---

## 0. 本方案中已实测验证的结论

下列结论不是查文档得出的，是在真实站点 / 真实 MV3 环境里跑出来的。实施时直接采信。

| # | 结论 | 证据 |
|---|---|---|
| V-1 | 抽取性能不是问题 | 真实页面实测 1.4–6.2 ms（MDN 2949 节点 6.2 ms，Stripe 4653 节点 2.8 ms）。策略：先用便宜的 role 过滤拿候选，只对候选做 layout / style / accname |
| V-2 | Top Layer 能赢 z-index 战争 | closed shadow root 内挂 `<dialog>`/`popover` 并 `showModal()`/`showPopover()`，实测稳定盖过 `z-index: 2147483647` 的全屏覆盖层（GitHub / Grafana 出图验证） |
| V-3 | SVG `<mask>` 多洞可用 | `<svg width="100%" height="100%">` + `maskUnits="userSpaceOnUse"` + 多个 `<rect>`，实测同时挖 3 个洞成功。**必须写显式 width/height，漏了会静默失败**（无报错，遮罩不出现） |
| V-4 | 四块 div 拼接遮罩不可用 | 无法支持多洞，而 §4.7 的 `explain`/`diagnose` 返回 `refs: [e08, e12]` 数组，多洞是既定需求 |
| V-5 | open Shadow DOM 在真实站点极常见 | GitHub 32 个、MDN 37 个 shadow root，全部 open，`el.shadowRoot` 可达。**C-08 必须从「应当」升为「必须」** |
| V-6 | closed shadow root 的 MAIN world 劫持可以推迟 | 实测样本中未发现 closed root 造成损失，由 T7 评测数据决定是否投入 |
| V-7 | Chrome for Testing + `--load-extension` 可用 | Chrome for Testing 149（Playwright chromium-1228 自带）正常加载 unpacked 扩展，MV3 SW 起来。**品牌版 Chrome 137+ 确认失败** |
| V-8 | MV3 平台参数 | `chrome.storage.session` / `local` 配额均为 10,485,760 字节（实测读取 `QUOTA_BYTES`）；SW 空闲 30 s 回收；**`fetch()` 响应超 30 s 直接杀 SW**（第二步 Provider 层必须处理） |
| V-9 | 页面 CSP 会拦截测试注入，但不影响产品 | Playwright `addScriptTag` 在 GitHub / MDN / Stripe 全部被 CSP 拒绝；改用 `page.evaluate(源码)`（走 `Runtime.evaluate`）绕过。产品本身不受影响——content script 跑在 isolated world，天然豁免页面 CSP |
| V-10 | 表征消歧的量化结论 | 见 §3.4，这是本方案最重要的实测结果 |

---

## 1. 第一步是什么

### 1.1 定义

**第一步交付的不是「一堆等待接线的前端组件」，而是一个完整可用的产品**：给它一个引导包，它能在真实站点上把用户一步步领到每一个控件前。唯一缺的是「引导包从哪来」——第一步答案是「人写的」，第二步答案才是「模型生成的」。

### 1.2 为什么第一步就是 U-09 演示模式

把完整产品按「谁产出步骤序列」切开：

| | 生产侧 | 消费侧 |
|---|---|---|
| 职责 | 意图理解 → 元素选择 → 步骤规划 | 元素抽取 → 目标定位 → 高亮渲染 → 步骤推进 → 失效处理 |
| 输入 | 用户意图 + 元素表 | **一个步骤序列** |

消费侧的输入只是「一个步骤序列」，**它不关心序列从哪来**。设计文档 §5.5 已经写明 `loadPack` 命中时跳过 `resolve` 直接进 `guide`——这条路径上本来就没有模型。

所以：第一步 = 消费侧全量 + 手写引导包，端到端可用（AGENTS.md 第 3 条）；第二步 = 换掉生产侧，消费侧零改动。**不存在「先搭骨架、后填肉」的中间态半成品。**

> **对总设计文档的修改建议**：§7.1 把演示模式排在 M3（第 8–10 周），定位为「激活漏斗补丁」。这是低估——它应该是 M1 之前的验收载体。按现排期，页面侧组件在前 8 周没有任何独立驱动源，只能靠 Agent 联调才能第一次跑起来，直接违反 AGENTS.md 第 3 条。

### 1.3 能力取舍

| # | 能力 | 判定 | 理由 |
|---|---|:--:|---|
| U-01 | Shadow DOM (closed) 隔离 | **收** | 事后加 = 重写全部浮层挂载。注意：closed 的真实收益**不是**隔离 CSS（open 效果相同），而是防宿主页 JS 通过 `el.shadowRoot` 读取/篡改浮层 |
| U-02 | 目标高亮（脉冲 + 遮罩） | **收** | 产品本体 |
| U-03 | 单步卡片 + 用户确认 | **收** | 明确不做自动推进检测 |
| U-04 | 自动滚动 + 滚动跟随 | **收** | 不跟随则一滚就错位，产品不成立 |
| U-05 | 目标消失失效提示 | **收** | R-04 的唯一出口，且与模型无关 |
| U-06 | Side Panel | **收，砍对话输入框** | 需要跨导航存活的宿主。popup 被排除：它在用户点页面时关闭，而我们每一步都要求用户点页面 |
| U-07 | Token 与成本显示 | **砍** | 无调用则无成本，恒为 0 的面板是投机 |
| U-08 | 意图标识 + 切换 | **砍** | 只有 GUIDE 一种意图，单选项切换器是伪抽象 |
| U-09 | 演示模式 | **收，且它是全部** | §1.2 |
| U-10 | 引导录制 | **砍** | 用「元素检视器 + 手写 YAML」替代，检视器本来就是 Tool 1 的验收面，零额外成本 |
| U-11 | 导出 / 分享 | **半收** | 导入必须；导出砍（导出的就是导进来的那个，无信息增量） |
| C-01/02/06 | 抽取 / 可见性 / role 推断 | 收 | Tool 1 本体 |
| C-07 | 站点指纹 | 收（降级） | 只需 `domain + pathname + landmark`；砍布局哈希 |
| C-08 | Shadow DOM 穿透 | **收（升级为必须）** | V-5 |
| C-09 | iframe 跨帧 | **只收同源** | 跨源必须显式降级，不得静默失败 |
| C-03/04/05 | 视口剪枝 / 参数化 / 档位 | **移出抽取器** | 见 §3.2 |
| §5.3 | 多信号定位器 | **收（词法部分）** | 第一步的技术核心之一 |
| S-03 | 敏感字段拦截 | **收，装在渲染入口** | 见 §4.4 |
| S-04 | 隐藏元素不入表 | 收 | = C-02 |
| S-07 | activeTab + optional host | **收，且必须现在做对** | 已发布扩展改 manifest 权限 = 重新审核 + 存量用户被禁用 |
| S-06 | 域名黑名单 | **砍** | 第一步零网络请求，黑名单不承载风险；随 Provider 一起加 |
| S-08 | 遥测 | **砍** | 第一步不发任何网络请求 |

### 1.4 明确不做

Agent 全部（设计文档 §4 整章）、Provider 全部（P-01~P-11）、Prompt 与输出契约（M-01/02/03/05/06/07）、LangGraph、检查点、成本统计、意图分类、开放对话、连接测试、厂商预设、跨源 iframe、Canvas/WebGL 识别、引导录制、远程包仓库同步。

**第一步不上架 Chrome Web Store。** 第一步零网络请求、零数据收集；第二步会引入「向用户自选端点发送页面元素表」，这是必须披露的数据传输。在 2026-08-01 新政（数据收集必须严格限于已披露的单一用途）下，为一个必然变更的数据披露先建立商店记录是自找审核麻烦。第一步走 unpacked / CRX 内测分发。

---

## 2. 工程骨架

### 2.1 目录结构

```
agent-extension/
├── wxt.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── scripts/check-size.mjs
├── src/
│   ├── entrypoints/
│   │   ├── background.ts            # 12 行：setPanelBehavior
│   │   ├── content.ts               # RPC 服务端 + 抽取器/浮层宿主
│   │   └── sidepanel/
│   │       ├── index.html  main.tsx  App.tsx  panel.css
│   │       └── components/{GoalInput,NodeTable,StatsBar,Inspector}.tsx
│   ├── core/
│   │   ├── extractor/
│   │   │   ├── types.ts             # UINode / LocatorView / PromptTable
│   │   │   ├── extract.ts           # → LocatorView（全集，同步）
│   │   │   ├── project.ts           # describeAll（全集 path+nth）+ project（剪枝），纯函数
│   │   │   ├── walk.ts  visibility.ts  semantics.ts  roles.ts
│   │   │   ├── fingerprint.ts  registry.ts
│   │   ├── overlay/
│   │   │   ├── mount.ts             # closed shadow + Top Layer + 宿主加固
│   │   │   ├── OverlayRoot.tsx  Mask.tsx  Spotlight.tsx  StepCard.tsx
│   │   │   ├── geometry.ts  tracker.ts  overlay.css
│   │   ├── locator/lexical.ts       # 词法打分（第二步 relocate 复用）
│   │   ├── packs/{types,match,bind}.ts + demo/
│   │   └── security/sensitive.ts
│   ├── agent/api.ts                 # ★ 唯一 stub 边界
│   └── shared/{protocol,rpc,types}.ts
└── tests/{unit,dom,e2e,fixtures,eval}/
```

**相对总设计文档 §4.1 明确删除、不留占位**（AGENTS.md 第 1、2 条）：`agent/graph.ts`、`agent/nodes/`、`agent/edges/`、`agent/checkpoint/`、`agent/model/`、`agent/contract/`、`agent/prompt/`、`agent/shim/` 全部不建目录。

**取消 `ui/` 目录**：浮层组件归 `core/overlay/`（与几何、观察器强耦合，拆开只制造跨目录调用），side panel 组件归 entrypoint 内。§4.1 的 `ui/` 会导致「组件在 A、它的定位逻辑在 B」。

### 2.2 依赖

```jsonc
"dependencies": {
  "dom-accessibility-api": "0.7.1",   // computeAccessibleName + getRole，W3C accname 实现
  "react": "19.2.8", "react-dom": "19.2.8"
},
"devDependencies": {
  "wxt": "0.21.3", "@wxt-dev/module-react": "1.2.2",
  "tailwindcss": "4.3.3", "@tailwindcss/vite": "4.3.3",   // 仅 side panel
  "vitest": "4.1.10", "@vitest/browser": "4.1.10",
  "playwright": "1.62.1", "@playwright/test": "1.62.1",
  "aria-query": "5.3.2", "@types/aria-query": "5.0.4",     // 仅测试用，见下
  "typescript": "5.x", "tsx": "4.x", "prettier": "3.x"
}
```

关键决策：

- **`dom-accessibility-api` 的 `getRole()` 已完整实现 HTML-AAM 隐式 role 映射**（含 `input[type]` 全分支、`a[href]`、`select[multiple]`、`role="presentation"` 冲突消解），且全程不调 `getComputedStyle`。**不需要 aria-query 做 role 推断。**
- **`aria-query` 只作 devDependency**：它的 `dom` map 在 5.3.2 的实际数据里**只有 `reserved`，没有 `interactive` 字段**（`@types/aria-query` 声明了但数据没有），任何基于 `dom.get(tag).interactive` 的设计会静默失效。它唯一的用处是一条规范一致性测试：断言我们手写的可交互 role 集合 ⊆ ARIA widget 超类闭包 ∪ 显式豁免清单，规范漂移在 CI 报错。**规范正确性的收益拿到，运行时代价为零。**
- **不引入 `zustand`**：side panel 只有约 5 个字段的状态，`useReducer` 足够；且浮层与 side panel 在不同 JS realm，本来就无法共享 store。
- **浮层不用 Tailwind**：Tailwind preflight 注入 shadow root 在 WXT 上是已知痛点（wxt#678 / #1536 / #1658），浮层只有 8 个元素，不值得背这个 bug 类别。Tailwind 只用于 side panel（独立扩展页，无宿主 CSS 冲突）。

### 2.3 权限模型（2026-08-07 定稿）

```ts
manifest: {
  permissions: ['scripting', 'sidePanel', 'storage'],
  host_permissions: ['<all_urls>'],        // 安装时一次性收取，见下方裁决
  side_panel: { default_path: 'sidepanel.html' },
  minimum_chrome_version: '120',           // 把 Top Layer 变成平台契约
}
// content script 静态注册（matches: ['<all_urls>']），由 Chrome 自动注入
```

#### 裁决：权限一定要付，只能选收费时刻

先说清楚平台约束，因为它决定了选项只有两个：

> **Chrome 没有「只读页面」这一档权限。** 有主机权限就能 `executeScript` 注入任意 JS，读 DOM 和操作 DOM 用的是同一把钥匙。而读 DOM 又必须注入脚本才做得到。所以「只读不写」这条边界**只能由代码自身保证，平台不会代劳**。

于是真正的选择是收费时刻：

| | 安装时收（本方案） | 使用时收（activeTab + 按站授权） |
|---|---|---|
| 注入方式 | 静态 `content_scripts`，Chrome 自动注入 | `executeScript` / `registerContentScripts` |
| 安装体验 | 一条最重的警告：「读取和更改您在所有网站上的所有数据」 | 零警告 |
| 使用体验 | 永不打扰 | 单页零弹窗，跨页时问一次 |
| 用户仍可收紧 | ✅ `chrome://extensions` → 网站访问权限 → 「点击时」/「特定网站」 | — |
| 实现成本 | 约 0.5 人日 | 2–2.5 人日 |

**选定：安装时收。** 依据是对本机 27 个已装扩展的实测审计——**22 个是安装即全站访问**，其中 21 个用静态 `content_scripts` 自动注入（沉浸式翻译、MetaMask、Loom、Zotero Connector 等）。静态注入没有任何「运行时时刻」，所以用户体感是「这个插件不需要授权」，实际上同意书在安装那一秒就签过了。反例只有 5 个，其中 Notion Web Clipper 用的正是 activeTab 模型。

> 附带订正：`content_scripts` 里的 `matches` **本身就授予主机权限**，不只 `host_permissions` 算。Backpack 的 `host_permissions` 只写了三个站，但 `content_scripts` 写了 `<all_urls>`，照样拿到全站访问。

#### 代价必须明写：保证从平台强制降级为代码自律

在 activeTab 模型下，用户不点图标时扩展在**平台层面**就够不着页面。现在够得着，只是选择不做。因此以下三条从「锦上添花」变成**唯一防线**，全部由 `tests/unit/architecture.spec.ts` 断言：

1. **`src/` 内不得出现任何操作页面的 API** —— `.click()` / `.focus()` / `dispatchEvent` / `new MouseEvent|KeyboardEvent|PointerEvent` / `execCommand` / `setSelectionRange` / `designMode`。
2. **content script 的指令集是封闭枚举**，且不含执行类动词。新增一个动词必须是一次有可见 diff 的刻意行为，不能混在无关改动里。
3. **抽取管线不得读输入框 `.value`**，`UINode` 字段白名单不含任何页面文本载体（S-05）。

这两条新护栏做过反向验证：注入违规后确实变红。**一条不会红的测试等于没有测试。**

#### WXT 会静默改写 host_permissions

`node_modules/wxt/dist/core/utils/manifest.mjs:197-201`：凡 `registration: 'runtime'` 的 content script，WXT 把它的每条 `matches` 追加进 `host_permissions`。整个第一步里配置写着 `host_permissions: []`、产出却是 `['<all_urls>']`，**这个提权在配置文件、代码审查、e2e 三处全部隐形**，只有读构建产物才看得见。

因此有一条永久断言，装在 e2e 的第一项：**产出 manifest 的 `permissions` / `host_permissions` / `optional_host_permissions` / `content_scripts.matches` 必须与声明逐字一致**，任一方向的漂移都失败。防线建在构建产物上，不能建在源码上。

#### 双实例竞态（静态注册引入，已修）

静态注册后 Chrome 会在 `document_idle` 自行注入，而 `ensureInjected` 可能在此之前已经注入过一次——**同页两个实例，各有各的 `registry` generation**，EXTRACT 被 A 应答、HIGHLIGHT 被 B 应答，结果是永久 `snapshot_stale`。

解法：两个实例共享同一个 isolated world，新实例启动时先调用 `window.__pageGuideShutdown` 让在任者退位（注销消息监听、销毁浮层）。**最新的赢。** 这同时覆盖扩展重载后的孤儿实例。

#### 未采用：`"tabs"` 权限

A/B 实测（Chrome 149）：`tab.url` 的可见性由 `"tabs"` 单独提供，与 host 权限、与 `activeTab` 相互独立。之前把「零 host 权限下读不到 url」诊断成架构问题（F-4）是错的。现在 `<all_urls>` 已经提供了 url 可见性，`"tabs"` 没有必要，而它会额外弹「读取您的浏览记录」。

#### spike 实测记录（结论已并入上文，探针已删除）

| 问题 | 答案 |
|---|---|
| `openPanelOnActionClick: true` 下点图标是否授予 `activeTab` | ❌ 不授予 |
| `action.onClicked` 是否授予 | ✅ 授予（`grantedOrigins: []` 下注入成功） |
| 侧栏能否 `permissions.request` | ✅ 弹真实对话框、授予长期权限、可撤销 |
| `activeTab` 单独能否读 `tab.url` | ✅ 能 |
| `activeTab` 是否跨导航存活 | ❌ 导航即失效 |
| `sidePanel.open()` 是否需要用户手势 | ✅ 需要，**且调用前不能有任何 `await`** |
| 点击工具栏图标能否进 e2e | ❌ `_execute_action` 键盘命令无法经 CDP 触发 |

最后一条是通用约束，值得单独记住：

> **凡是读「当前用户手势」的扩展 API，调用前不能有任何 `await`。**

探针的 `action.onClicked` 里 `sidePanel.open()` 前面有三个 `await`，手势令牌已过期，侧栏再也打不开。这与 LangGraph 的 `interrupt()` 必须是节点第一条语句是**同一个失效模式**，第二步会再撞一次。

`ensureInjected(tabId)` 顺带解决「扩展在页面加载后才安装/重载」这个 bug 类别，是长期正确的原语，不是权宜方案。

---

## 3. Tool 1：页面结构抽取器

### 3.1 核心决策：`extract()` 出全集，`project()` 独立剪枝

总设计文档 §5.1 把「视口 ±1 屏剪枝」「按 contextWindow 定节点上限」写进抽取器。**这是错的，而且是功能性错误，不只是代码组织问题**：

> §5.3 要求 `relocate` 本地优先打分，难点 4 把它列为「大部分重定位零成本」的来源。**如果表已经被视口剪枝，一个滚出屏幕的目标就根本不在搜索空间里**，`relocate` 只能回落到付费的 `resolve`。剪枝在抽取器内 = 本地重定位在最需要它的场景下失效。

同样打中渲染器：`registry` 若只登记投影后的节点，`TARGET_LOST` 之后连重找的对象都没有。

V-1 的实测数据（6.2 ms）抽掉了「抽取贵、不想跑两遍」这个耦合理由。

```
content script（DOM 所有者，全集常驻本帧内存）
  ├─ extract(profile)      → LocatorView    全集：checkVisibility + 非零面积 + 非 aria-hidden/inert
  │                                         不做视口剪枝、不做 maxNodes 截断
  ├─ registry.commit(view)                  ★ 登记全集，不是投影集
  ├─ project(view, budget) → PromptTable    纯函数，本地调用后只回投影结果
  └─ relocate(ref, hints)  → Ref | null     【第二步】对全集本地打分，零模型成本

agent/
  └─ budgetFor(contextWindow) → ProjectBudget   （provider 知识，随厂商预设变化）
```

**全集不跨进程。** 把未剪枝的表序列化过 RPC 会推出几百 KB 页面文本，是 S-05 方向上的净损失。`relocate` 需要的不是一张序列化全表，是一个能查询活 DOM 的接口——结构邻近性、重新测 rect、testid 比对全都要活 DOM。

`project()` 放 `core/extractor/`（不是 `agent/`）：它是纯函数、零 DOM 依赖、零 agent 依赖，而 T7 评测 harness 在任何 agent 代码存在之前就要调用它算 `ambiguity@budget`。

### 3.2 类型定稿

```ts
export type Ref = string & { readonly __brand: 'Ref' };   // `e{n}` | `f{frameId}e{n}`
export type Rect = readonly [number, number, number, number];  // 本帧视口坐标

export interface UINode {
  ref: Ref;
  role: string;                 // 永不为 null，无法判定时 'generic'
  name: string;
  state?: UIState[];
  parent?: Ref;                 // 最近的已抽取祖先（landmark / heading / 模态）
  sensitive?: true;             // 进表（诊断需要），但永不可作为高亮目标
  // ↓ 不进 prompt
  rect: Rect;
  inViewport: boolean;
  frameId: number;
  nameSource: NameSource;       // 仅用于评测与调参
}

export interface LocatorView {  // 全集，只住 content script
  snapshotId: string; url: string; title: string; pageHash: string;
  nodes: UINode[];              // 不剪枝、不截断
  degraded: boolean;            // 看门狗触发
  stats: ExtractStats;
}

export interface PromptItem {
  ref: Ref; role: string; name: string;
  path: readonly string[];      // ["Instances", "i-0abc · running"]
  state?: UIState[];
  nth?: number;                 // 仅在 (path, role, name) 仍不唯一时出现
  sensitive?: true;
}
export interface PromptTable {
  snapshotId: string; items: PromptItem[]; truncated: boolean;
  ambiguity: number;            // 度量用，不进 prompt
}
```

**S-05 的类型级保证**：`UINode` 没有也永远不会有 `value` / `text` / `html` 字段。配一条单元测试断言 `Object.keys(node)` 恒等于白名单。

`Ref` **从第一天就帧限定**，即使 T3–T5 只跑顶帧（`frameId` 恒为 0）。ref 格式渗透进快照序列化、评测标注、prompt 契约，后改是全局改动（AGENTS.md 第 7 条）。

### 3.3 遍历与可见性

```ts
function walk(root: Document | ShadowRoot, frameId: number, depth: number, out: Candidate[]) {
  if (depth > MAX_SHADOW_DEPTH /* 12 */) return;
  for (const el of root.querySelectorAll('*')) {
    if (el.matches(CANDIDATE_SELECTOR)) out.push({ el, frameId });
    if (el.localName === 'iframe' || el.localName === 'frame') continue;
    const sr = el.shadowRoot;                    // V-5：真实站点大量存在，且都是 open
    if (sr) walk(sr, frameId, depth + 1, out);
  }
}
```

可见性判定，从便宜到贵短路，**我们自己的代码一次 `getComputedStyle` 都不调**：

| 序 | 判定 | 淘汰什么 |
|---|---|---|
| 1 | `el.isConnected` | 已脱离文档 |
| 2 | `el.closest('[aria-hidden="true"], [inert], [hidden]')` | 无障碍树排除 + inert 子树 |
| 3 | `getBoundingClientRect()` → `w < 2 \|\| h < 2` | **`display:none` 全部（rect 恒为 0）** + 零面积 |
| 4 | `el.checkVisibility({ opacityProperty, visibilityProperty, contentVisibilityAuto })` | `visibility:hidden` / `opacity:0` / `content-visibility:auto` |

第 4 步的 `checkVisibility()` 是 Baseline 2024 原生 API，**一次调用覆盖设计文档 C-02 的全部三项 CSS 条件**，比 `getComputedStyle` 快一个量级且代码更少。这不是性能 hack，是更好的 API。

**读写分离**：整个抽取阶段只读不写，第 3 步的首次 `getBoundingClientRect()` 触发一次布局刷新，之后所有 rect 读取命中干净布局树。

**模态作用域剪枝**（总设计文档 C-02 缺失的一条）：命中 `dialog[open]:modal` / `[popover]:popover-open` / `[role=dialog][aria-modal=true]` 时，候选集限制到该子树。约 15 行。它捕获的正是「用户被弹窗卡住来求助」这个最高频场景。

**看门狗替代候选硬上限**：不设 `maxCandidates`（静默丢元素、recall 掉、报告里看不出原因是最差组合）。改为 `extract()` 内若 `performance.now() - t0 > 250ms` 停止遍历并置 `degraded = true`。实测 6.2 ms，它永远不会触发——这正是安全网该有的样子。

### 3.4 表征消歧（本方案最重要的实测结果）

**问题**：按总设计文档 §5.1 的 `UINode`（`role + name`，`rect` 明确不进 prompt），真实页面上大量元素无法互相区分。模型在这些行上的 top-1 上限就是 `1/k` 随机。

**实测**（4 个真实页面，逐步叠加修复）：

| 页面 | A 现状 `role+name` | B `+name质量修复` | C `+等价折叠` | **D `+path分组`** |
|---|---:|---:|---:|---:|
| **不可区分率** ||||
| Stripe docs | 22.2% | 22.2% | 22.2% | **0%** |
| GitHub repo | 18.1% | 9.6% | 3.6% | **0%** |
| MDN docs | 9.3% | 9.3% | 0% | **0%** |
| Grafana Play | 12.5% | 12.5% | 0% | **0%** |
| **top-1 理论上界** ||||
| Stripe docs | 85.2% | 86.1% | 86.1% | **100%** |
| GitHub repo | 85.5% | 93.4% | 98.2% | **100%** |
| MDN docs | 94.8% | 94.8% | 100% | **100%** |
| Grafana Play | 93.8% | 93.8% | 100% | **100%** |

歧义类大小直方图（现状 A）：Stripe `{2:2, 3:5, 5:1}` · GitHub `{2:3, 5:2, 14:1}` · MDN `{2:3, 3:1}` · Grafana `{2:2}`

**结论：现状下结构性歧义单项吃掉 6–15 个百分点的 top-1 上界。** M0-b 门槛 70%、总误差预算 30 点，歧义占掉五分之一到二分之一。这个问题的优先级高于抽取器的任何其他优化。

**三类歧义与对应修复：**

| 类型 | 实例（实测 DOM 路径） | 修复 |
|---|---|---|
| **A 跨区块重复的同一功能** | Stripe `button\|Copy for LLM ×3`，位于 `section#api-section-intro > div.ApiSectionHeader` | `path` 层 0（最近 heading / landmark） |
| **B 表格行内重复的操作** | GitHub `link\|") " ×14`，位于 `tbody > tr#folder-row-N > td.react-directory-row-commit-cell` | `path` 层 1（行标识） |
| **C name 本身是坏的** | 同上，accessible name 算成 `)` | name 质量规则，**不是加字段** |
| **D 无害歧义（等价候选）** | GitHub 同一 commit 的链接 ×5，`href` 完全相同 | 等价折叠 |

**三项修复的实现：**

**(1) `path: string[]` —— 分组表头，不是每节点字段**

这是关键的成本设计：每节点加一个字段 = 150 节点 × 7 token ≈ 1050 token（表本身才 2500）；**做成序列化时的分组表头 = 15 组 × 6 token ≈ 90 token**。同样信息量，成本差一个量级。

```yaml
## Instances                              ← path[0]，每组写一次
### i-0abc123de · running                 ← path[1]（表格行），每行写一次
- ref: e40  role: button  name: "Stop"
- ref: e41  role: button  name: "Terminate"
### i-0f99887c · stopped
- ref: e48  role: button  name: "Start"
```

构造规则（在 `describeAll()` 内，全集上算一次）：

| 层 | 取法 | 为什么是这个取法 |
|---|---|---|
| 0 | 最近的 **landmark 祖先**的 name | landmark 确实包裹内容，祖先遍历成立 |
| 1 | **文档序上最近的前驱标题**，作用域受 landmark **包含**关系约束 | 见下 |
| 2 | 最近的 `tr` / `[role=row]` 祖先的行标识（该行第一个非空 cell 的文本，截断 40 字） | 分辨每行同名操作 |

典型控制台页约 12 组 + 20 行 ≈ 210 token，占 2500 token 表的 **8%**。

**层 1 有两个坑，都是实测撞出来的（2026-08-07）：**

**(a) 标题不是祖先，是前驱兄弟。** 第一版用祖先链找 heading，而 HTML 几乎从不把一节的内容套进它的 `<h2>` 里。后果：Stripe 108 个控件里 96 个 `path` 为空，歧义率 **18.5%**（门槛 ≤5%）。改成文档序前驱标题后降到 8.3%。

**(b) landmark 作用域必须按「包含」判定，不能按「相等」。** 「标题与元素必须在同一 landmark 内」看起来合理，实测很差：Stripe 的控件位于 `div[role="toolbar"]`（toolbar 在 `LANDMARK_ROLES` 里），而标题位于 `main`，两者不相等 → 标题被丢弃 → `path` 塌缩成「Actions」，而每个这样的工具栏都叫 Actions。改成「标题的 landmark 在元素的 landmark 链上」之后：**8.3% → 0%**。

**heading 按 role 判定，不按标签名。** 原先用 `/^h[1-6]$/.test(localName)`，把组件库里遍地的 `<div role="heading" aria-level="2">` 整个丢掉，连带丢掉该节的标签。

**祖先与行标识必须穿 shadow 边界。** `parentElement` 和 `closest()` 都在 shadow root 处停死，导致 GitHub 32 个、MDN 37 个 shadow root 内的控件永远拿不到 `path`。更糟的是**这让度量说谎**——fixture 当时报 `ambiguity: 0%`，部分原因是它的 shadow 内容根本没有参与过比较。

**(2) `nth?: number` —— 兜底序号**

仅在 `(path, role, name)` 仍不唯一时出现，值为同 key 内文档序序号。成本约 4 token × 残余节点，摊到全表 < 1%。

它不给模型语义依据，但给两样东西：投影表内 key 唯一性由构造保证（`bind` 不再可能静默绑错）；用户说「第二个」时模型有可引用的锚点。

**必须在全集上编号，不能在投影集上编号（F-5，2026-08-07 修）。** 第一版把 `assignNth()` 放在剪枝之后，而剪枝依赖视口带、视口带依赖滚动位置——同一个按钮在页首是 `nth: 2`，滚下去就完全没有 `nth`。实测：

```
scrollY=0     e1:nth=1  e2:nth=2
scrollY=2000  e2:nth=无
```

后果是在一处创作的 descriptor 到另一处绑不上，**K-6「唯一命中即正确」的类型级保证被无声作废**。当时的理由是「唯一性是投影集的性质，所以 nth 只能在剪枝后算」——这句话正好说反了：`nth` 是**持久身份**的一部分，因此必须是页面的性质；投影集内的唯一性是 `ambiguity` 度量的问题，是另一件事。

代码上拆成两个函数：`describeAll()` 在全集上算 `path` / `nth`（与视口无关），`project()` 只做选择、不碰身份。另有一条架构护栏禁止 `project.ts` 读取任何实时视口状态——单测跑在 `environment: 'node'` 下，否则这类回归只会表现为一个莫名其妙的 ReferenceError。

**(3) name 质量规则**（`resolveName` 内，成本 0 token，替换而非新增）

```ts
const JUNK = /^[\s\p{P}\p{S}]*$/u;
if (norm.length < 2 || JUNK.test(norm)) {       // 纯标点/符号 = 抽取缺陷，不是名字
  raw = title || ariaDescription || svgTitle || dataTestId || hrefTail;
}
```

**这一条必须在 T1 就做，不能推迟到调优阶段**——实测它单独把 GitHub 的 top-1 上界从 85.5% 抬到 93.4%。

**明确不加的字段**：`rect` 进 prompt（4 个数字 ≈ 12 token/节点 = 全表 +70%，而模型对坐标的空间推理很差，**坚决不进**）；`class` / `data-*` 原样（class 名是随机哈希重灾区，纯噪声烧钱）；`desc`（长度不可控，只作 name 兜底源）。

### 3.5 pageHash

```ts
// FNV-1a 32 位：抽取器全同步，crypto.subtle 是异步的；这只是相等性键，不需密码学强度
pageFingerprint = fnv1a(`${origin}${pathname}\n${landmarks_and_headings.slice(0,24)}`)
```

**刻意不包含可交互元素**：§4.5 要求「pageHash 变化即作废步骤序列」，若哈希对每个按钮的出现/消失敏感，它会在任何异步加载后变化，导致步骤序列被不停作废。路由 + landmark/标题层级才是「页面换了」的正确粒度。

### 3.6 ref 注册表与快照代际

```ts
class RefRegistry {
  private gen = '';                                 // 当前 snapshotId
  private map = new Map<Ref, WeakRef<Element>>();   // WeakRef：不钉住已移除的 DOM
  resolve(snapshotId: string, ref: Ref): Element | null {
    if (snapshotId !== this.gen) return null;       // ★ 快照代际不符，直接拒绝
    const el = this.map.get(ref)?.deref() ?? null;
    return el?.isConnected ? el : null;
  }
}
```

`snapshotId` 校验是 R-04 的**本地防线**——不依赖 agent、不依赖检查点规则，是 content script 自己能判断的事实。

---

## 4. Tool 2：高亮渲染器

### 4.1 挂载：closed Shadow DOM + Top Layer

四层防护，缺一不可：

| 层 | 手段 | 挡住什么 |
|---|---|---|
| 1 | `mode: 'closed'` | 宿主页 JS 拿不到 `host.shadowRoot`，无法读取/篡改浮层 |
| 2 | shadow 边界 + `all: initial` | 宿主 CSS 进不来，我们的 CSS 出不去 |
| 3 | **宿主元素内联 `!important`** | 宿主页的 `div { display:none !important }` 干不掉我们 |
| 4 | **Top Layer**（`popover="manual"` + `showPopover()`） | z-index 战争 + 祖先 transform 劫持 |

第 3 层的细节很重要——shadow root 保护不了**宿主元素本身**：

```ts
// LOCK 里没有 display —— 见下方两条纪律
const LOCK = [['position','fixed'],['inset','0'],['pointer-events','none'],
              ['visibility','visible'],['opacity','1'],
              ['transform','none'],['filter','none'],['clip-path','none'],['contain','none']];

function hardenHost(host: HTMLElement, isVisible: () => boolean) {
  const apply = () => {
    LOCK.forEach(([p,v]) => host.style.setProperty(p, v, 'important'));
    const visible = isVisible();
    host.style.setProperty('display', visible ? 'block' : 'none', 'important');
    if (visible !== host.matches(':popover-open')) {
      try { visible ? host.showPopover() : host.hidePopover(); } catch {}
    }
  };
  host.setAttribute('popover', 'manual');
  apply();
  const guard = new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.append(host);
    apply();
  });
  guard.observe(host, { attributes: true, attributeFilter: ['style','class','popover'] });
  guard.observe(document.documentElement, { childList: true });  // ← 删除记录产生在父节点上
  return guard;  // destroy() 必须先 disconnect，否则自愈逻辑会把宿主复活
}
```

这段伪代码的前一版有两个 bug，实现照抄后成了 F-2 / F-3，实测确认（见 `before-step2.md`）：

**纪律一：加固逻辑只能复述期望状态，不能断言常量。** 上一版把 `display: block` 写进 `LOCK`，于是 `hide()` 写 `display:none` → 触发这个 observer → `apply()` 把 `block` 写回去。**加固吃掉了隐藏**，黑幕永久留在用户页面上，只能刷新才能摆脱。把两处写入都从同一个 `isVisible()` 派生，谁先触发都不会打架。

> 顺带一提，这个自反馈环之所以没把标签页直接卡死，是因为 CSSOM 的 `setProperty` 在值与优先级都未变时不更新 `style` 属性、因而不产生变更记录。这是收敛的**唯一**依据——任何一处改成无条件写属性，就是无上限的微任务循环。e2e 里那条「连续 50 次删除宿主」就是守这个的。

**纪律二：observer 要观察的是「谁会记录这次变更」，不是「谁被变更」。** 上一版只观察 `host` 自身的 attributes，而节点被移除的 `childList` 记录产生在**父节点**上，所以 `if (!host.isConnected)` 一次都不会执行——第 3 层是死代码，页面一行 JS 就能永久干掉浮层。

**内联 `!important` 胜过样式表 `!important`**——CSS 级联中 author origin 的 important 声明里，`style` 属性优先级高于样式表。这场仗可以赢。

**Top Layer 的语义保证**（V-2 实测确认）：渲染在所有普通内容之上，与 z-index 无关；不受任何祖先的层叠上下文 / `transform` / `filter` / `contain` / `overflow` 影响（这也顺带解决 `position: fixed` 被祖先 transform 劫持）；`popover="manual"` 不参与 auto/hint 栈，不抢焦点，不做 light dismiss——正是「常驻但不打扰」。

**不写降级分支**：Chrome 114+ 全面支持，`minimum_chrome_version: '120'` 把它变成平台契约（AGENTS.md 第 1 条：不做回退逻辑）。

### 4.2 遮罩：SVG mask（V-3 / V-4）

```tsx
<svg class="pg-mask" width="100%" height="100%" aria-hidden="true">
  <defs>
    <mask id="pg-hole" maskUnits="userSpaceOnUse">
      <rect x="0" y="0" width="100%" height="100%" fill="white"/>
      {holes.map(([x,y,w,h],i) =>
        <rect key={i} x={x-PAD} y={y-PAD} width={w+PAD*2} height={h+PAD*2} rx="6" fill="black"/>)}
    </mask>
  </defs>
  <rect x="0" y="0" width="100%" height="100%" fill="rgb(0 0 0 / .55)" mask="url(#pg-hole)"/>
</svg>
```

> ⚠️ **`<svg>` 的 `width="100%" height="100%"` 是必需的。** 漏掉会因 SVG 固有尺寸（300×150）而**静默失败**——不报错，遮罩就是不出现。这是实测踩到的坑。

- `.pg-mask { pointer-events: none }` —— **遮罩绝不拦截点击**。这是「只指路不开车」的直接推论：用户必须能点页面上任何东西，包括聚光圈外的。会捕获点击的模态遮罩把引导变成了胁迫。
- 更新只改 `<rect>` 的 4 个属性（用 ref 直接 `setAttribute` 绕过 React diff），无重排。
- Chrome 里 SVG 几何属性可 CSS 过渡：`.pg-mask rect { transition: x .18s, y .18s, width .18s, height .18s }`。

### 4.3 几何与跟随

| 场景 | 处理 |
|---|---|
| 滚动 | `getBoundingClientRect()` 返回视口坐标，浮层宿主 `position: fixed` 且在 Top Layer，**同一坐标系，直接用** |
| CSS transform | rect 已是变换后的轴对齐包围盒。旋转元素得到偏大的框——可接受 |
| `position: fixed` 目标 | 同为视口坐标，天然对齐，**无需特殊处理** |
| 浏览器缩放 | rect 与浮层同为 CSS px，同步缩放 |
| pinch zoom | 元素对齐无需校正；仅卡片需用 `visualViewport` 做可视区约束 |
| 祖先有 `filter`/`transform`/`contain` | **Top Layer 免疫，这一整类 bug 消失** |

```
class TargetTracker {
  观察器（ResizeObserver + IntersectionObserver + MutationObserver
          + window scroll[capture] + resize + visualViewport + transitionend/animationend）
      → 只置 dirty 位，不做任何工作
  单个 rAF 循环 tick()：
      只读阶段：isConnected / checkVisibility / rect
      失效判定：连续 3 帧无 rect → emitLost（躲开 React 重挂载的瞬时断链）
      只写阶段：位移 > 0.5px 才写
      自休眠：稳定 20 帧（≈330ms）后停止排帧，等观察器叫醒
}
```

四条硬规则：**只有一个 rAF 且会自己睡着**（常驻 rAF 会让 GPU 永不进省电态）；**观察器只置位不干活**（MutationObserver 在控制台页每秒可能触发上百次）；**严格读写分离**（否则每帧强制回流）；**> 0.5px 才写**（躲亚像素抖动）。

`scroll` 用 **capture 阶段**监听 window：scroll 事件不冒泡但走捕获，一次监听即可收到页面内任意滚动容器的滚动，不需要枚举滚动祖先。

自动滚动用 `scrollIntoView({ block: 'center' })`：原生支持嵌套滚动容器与 shadow DOM，`block: 'center'` 同时规避 sticky header 遮挡；`prefers-reduced-motion` 下 behavior 降为 `auto`；用 `scrollend` 事件 + 800ms 超时兜底。

### 4.4 退化场景（每一种都必须可见，不得静默失败）

| 场景 | 检测 | 行为 |
|---|---|---|
| 滚出视口 | IntersectionObserver | 卡片贴边显示方向箭头「目标在上方 ↑ / 下方 ↓」，**不报错** |
| 被遮挡 | `elementFromPoint(中心)` 不是目标或其后代 | 保留外框，提示「目标被其他内容遮挡」。**绝不代用户关闭遮挡物** |
| 真的没了 | MutationObserver + 3 帧确认 | 先自动重解析一次；失败进失效屏：目标的 role/name 描述 + [重试定位] [跳过此步] [结束引导] |
| 同源 iframe 内 | `frameId ≠ 0` | 支持，rect 沿 frame 链合成偏移 |
| 跨源 iframe 无权限 | `sendMessage(…, {frameId})` 抛错 | `reason: 'in_unreachable_frame'`，框出整个 iframe + 文字降级说明 + 授权按钮。**绝不显示空框** |
| closed shadow root 内 | 抽取阶段就拿不到，ref 不存在 | `reason: 'ref_not_found'`。这是 recall 问题，由评测指标反映 |
| **敏感字段** | 步骤的**任一** ref（`ref` 或 `alsoRefs` 中的任意一个）`sensitive === true` | **渲染器直接拒绝整步**，`reason: 'sensitive_blocked'`；不做「过滤掉敏感的那几个、其余照画」的降级 |
| 快照过期 | `plan.snapshotId !== registry.gen` | `reason: 'snapshot_stale'`，要求重新抽取 |

### 6.3 跨页恢复：流程归宿主（2026-08-07 落地）

判据只有一条：**状态归属于「生命周期覆盖它、且拥有恢复机制」的那个进程。**

| 候选 | 何时死 | 有无恢复机制 |
|---|---|---|
| 侧栏 | 关面板即死 | 无 |
| content script | **每次导航必死** | 无 |
| **service worker** | 30 秒空闲被回收 | **有**：任何消息唤醒 + `chrome.storage.session` |
| checkpoint（第二步） | 浏览器重启 | 它本身就是恢复机制 |

流程原先归 content script——**四个里最差的一个**：它活不过「用户点了我们指的那个东西、页面跳转了」这件事，而那恰恰是引导中最常发生的事。

落地形态：宿主持有 `{steps, cursor, url}`，镜像进 `chrome.storage.session` 的 `flow:{tabId}`（**不能只放模块变量**，SW 30 秒空闲就被回收，远短于用户读一步说明的时间）；`tabs.onUpdated` 的 `complete` 触发恢复；`tabs.onRemoved` 清除。

**恢复规则按证据判定，不靠假设：**

| 情形 | 判定 | 理由 |
|---|---|---|
| URL 未变（刷新） | 重放**当前**步 | 刷新不是进展 |
| URL 变了 | 先试**下一**步；绑不到再退回当前步 | 导航通常正是用户照做了——他点了我们指的链接。但「用户导航了」不等于「用户做了我们要求的事」，所以要留退路 |

**任务 8 让恢复变得几乎免费**：恢复只需发一条 `HIGHLIGHT`，渲染器自己会按 descriptor 重绑。宿主不需要先 EXTRACT，也不需要知道新页面长什么样。

**`chrome.runtime.sendMessage` 永远不会投递给发送方自身**——SW 收不到自己发的消息。e2e 因此从**真实的侧栏页面**驱动宿主，走的正是运行时那条 panel → host 路径。

---

**三态必须在 UI 上可区分。** 把「滚出视口」报成「找不到」是产品事故——用户会以为引导坏了。

**S-03 的位置必须是渲染入口，不是模型输出校验**：元素表里的 role/name 不足以判断敏感性（`textbox|"验证码"` 与 `textbox|"项目名称"` 在表征上无结构差异），真正的证据在活体 DOM 上（`type=password`、`autocomplete=cc-*|one-time-code`、表单上下文）。装在渲染入口的好处是**与步骤来源无关**——预录包写错了同样被拦，第二步接上模型时这道闸已经在线上跑了几周。

**「渲染入口」的判定必须按「能在屏幕上出现的 ref 全集」，不是主 ref。** 第一版只查了 `step.ref`，而 `alsoRefs` 同样在遮罩上挖洞、同样把字段聚光给用户看——`explain` / `diagnose` 返回的 `refs: []` 走的正是这条路（F-1）。也就是说，模型将来唯一会用的那条路径当时恰恰没有闸，而上一句「已经跑了几周」的保证是假的。同理，**被拒绝的 plan 不得被采纳为当前 plan**，否则它还能通过「重试定位」再次进入渲染。

---

## 5. Stub 边界

### 5.1 唯一的 stub：`src/agent/api.ts`

```ts
export interface ResolveRequest {
  goal: string;
  snapshot: LocatorView;      // ★ 收快照，不收序列化后的 YAML
  contextWindow: number;
  locale: string;
  history: ConversationTurn[];
  signal: AbortSignal;        // ★ 流式与取消从第一天就有位置
}

export interface ResolveResult {
  intent: 'guide'|'locate'|'explain'|'diagnose'|'clarify'|'chat';
  confidence: number;
  steps: GuideStep[];
  answer?: string;
  suggestGuide?: boolean;
  usage?: TokenUsage;                        // 零成本路径为 undefined，比 {0,0,0} 诚实
  source: 'pack' | 'baseline' | 'model';     // ★ 零成本路径在类型上是一等公民
}

export async function resolve(req: ResolveRequest): Promise<ResolveResult>;
export function preroute(goal: string): { needsPage: boolean; profile: ExtractProfile };
```

**为什么这两个签名是长期正确的**：

1. 收 `LocatorView` 而非 YAML 字符串 —— **prompt 渲染、元素表序列化、`<untrusted_page_content>` 包裹、契约解析全部在边界之内**，第二步这些东西怎么改都不外溢。
2. 收 `AbortSignal` —— 流式（P-07）与取消（SESSION_ABORT）不需要以后加参数。
3. 返回 `GuideStep[]` 而非原始 YAML —— 一个类型两个消费者（渲染器输入契约 + agent 输出契约），不会分叉。
4. `source` 字段让零成本路径与付费路径在类型上分离 —— 难点 4 的成本可见性是协议的一部分，不是事后补的 UI。

### 5.2 边界签名（2026-08-07 定稿）

```ts
export interface AgentHost {
  start(input: StartInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume(threadId: ThreadId, report: HostSignal, signal: AbortSignal): AsyncIterable<AgentEvent>;
  abort(threadId: ThreadId): Promise<void>;
}
```

原签名是 `resolve(req): Promise<ResolveResult>`，扛不住第二步，四个独立的致命点：

1. **Promise 只能 resolve 一次，而 `guide` 是 N 次 `interrupt()`。** 一次调用表达不了「显示第 1 步 → 等用户 → 显示第 2 步」。它当初看起来能工作，纯粹是因为游标被放进了 content script——错误的所有者。**修所有权和修签名是同一件事的两个侧面。**
2. **流式没有出口。** `AbortSignal` 买到的是取消，不是渐进输出。
3. **SW 的 30 秒 fetch 上限需要「可观测的进度」驱动保活**，而 `await resolve()` 期间宿主对内部一无所知。
4. **`intent` 被冻进了跨模块契约**，而 §9 明确写着不冻结 intent 枚举。

**流在 `await_user` 处结束，恢复即开新流。** 这与 LangGraph 的 `graph.stream(input, cfg)` / `graph.stream(new Command({resume}), cfg)` 是 1:1 的，第二步不需要适配层。

**`HostSignal` 同时承载用户动作与渲染结果**（`confirmed` / `skipped` / `navigated` / `reloaded` / `unresolved`）。把渲染结果也送回 host 是刻意的：「这一步能不能指出来」是流程所有者需要的证据，跨页恢复的「先试下一步、绑不到就退回」规则因此能落在一个地方，而不是散在宿主和 agent 两边。

**线程状态归 host**，存 `chrome.storage.session` 的 `thread:{sessionId}`——不能只放模块变量，SW 空闲 30 秒即被回收，而回收会连生成器一起杀掉。第二步这条记录由 LangGraph checkpoint 接管；在那之前**它就是 checkpoint**。

**`budgetFor` 迁出到 `agent/budget.ts`**：token 预算是模型上下文窗口的性质，不是 agent 的性质。留在 `api.ts` 里意味着侧栏为了算一个抽取预算就要 import 整个 agent 模块——而那个模块马上要长出 LangGraph、provider 和 checkpoint saver。

结果：**`api.ts` 只剩一个消费者 `background.ts`**，侧栏不再 import 任何 agent 代码。

### 5.3 stub 实现 = 真实的两条零调用路径

```ts
export async function resolve(req: ResolveRequest): Promise<ResolveResult> {
  // 路径 1：演示引导包（U-09 / G-06 / §5.5）—— 命中即完整多步引导，零模型调用
  const flow = matchPack(location.href, req.goal);
  if (flow) return { intent:'guide', confidence:1, steps: flow.steps, source:'pack' };

  // 路径 2：本地词法基线 —— 对快照的 name 做打分（core/locator/lexical.ts）
  const top = scoreNodes(req.goal, req.snapshot.nodes)[0];
  return { intent:'locate', confidence: top?.score ?? 0,
           steps: top ? [{ ...descriptorOf(top.node), action:'click',
                           detail:'（本地词法基线，未调用模型）' }] : [],
           source:'baseline' };
}
```

**这不是脚手架，有三个可留存的价值**：不配任何 API Key 就能看到高亮（AGENTS.md 第 3 条）；`bind` 逻辑第二步原样复用（`loadPack` 零成本路径）；**词法基线是 M0-b 的下界，也是 §5.3 `relocate` 的本地打分器**——它放在 `core/locator/` 而非 `agent/`，因为词法匹配是确定性本地计算，属于「看」不属于「想」。

### 5.3 明确不做 stub

Provider / `complete()`（第一步不发网络请求，空文件是投机性结构）、契约 schema / YAML 解析（没有模型输出）、Checkpointer（没有图）、Token 计数（`usage` 可选）。

### 5.4 `GuideStep` 同时携带 `ref` 与 `descriptor`

这是两位 agent 交叉评审后的合并结论，解决「ref 是临时序号 vs 渲染必须校验代际」的冲突：

| 层 | 载体 | 回答 | 生命周期 |
|---|---|---|---|
| **身份** | `ElementDescriptor` | 我们要指的是哪个东西 | 跨会话、跨改版，可离线书写 |
| **句柄** | `ref` | 在这一次快照里它是第几号 | 单次快照内 |
| **守卫** | `snapshotId` | 这个句柄还新鲜吗 | 单次快照内 |

```ts
interface GuideStep {
  ref?: Ref;                   // 本快照句柄；【可选】——未绑定的步骤不带它
  descriptor: ElementDescriptor;  // 跨快照身份，relocate 用、导出成包用
  alsoRefs?: readonly Ref[];   // explain/diagnose 次级高亮，或多候选时的全部候选
  expectedUserAction: UserAction; title: string; detail?: string; confidence: number;
}
```

**`ref` 必须可选（2026-08-07 收口）。** 原先它是必填，于是「绑不到」只能伪造成 `'' as Ref`，渲染层收到后只能报「元素不存在」——把「还没绑」和「找不到」压成了同一个结果，而这两者要走的路完全相反（前者去 bind，后者去 relocate）。现在三种结果三种形状：唯一命中带 `ref`；多命中带 `alsoRefs`（渲染层全部框出，不挑）；未绑定两者都不带。

**`action` 改名 `expectedUserAction`。** 旧名字读起来像「扩展会去点」，而它描述的是*用户*该做的动作，没有任何代码消费它去执行。第二步这些值由模型产出，一个叫 `action: 'click'` 的字段离被接上执行器只差一次看起来合理的提交。护栏挡得住，但名字本身不该发出邀请。

**绑定发生在渲染那一刻，由 content script 完成（2026-08-07 定稿）。** 调用方——引导包、词法基线、第二步的模型——一律只产出 descriptor。理由是时序上的硬约束：`ref` 命名的是「某一页某一刻某次快照里的某个元素」，而第 3 步的目标在第 1 步显示时通常还不在 DOM 里（对话框没开、页面没跳），**任何调用方都造不出那个 ref**。模型同样如此——它没见过那一页。

由此还有三条推论：

- **绑定的搜索范围必须是全集，不是投影表**（F-6）。投影表是为了塞进 prompt 而剪枝的；拿它当搜索空间，会让「下一步在页面下方」这种完全正常的步骤绑不到东西。**Token 预算约束的是我们「说什么」，永远不该约束我们「能找到什么」。**
- **过期快照不再是拒绝，而是重绑的触发条件。** `registry.resolve` 自带快照守卫，句柄失效就返回 null，然后走 descriptor。
- **`alsoRefs` 没有自己的 descriptor，因此无法重绑**；其中任意一个失效就如实报 `snapshot_stale`，而不是悄悄少画几个洞。

**descriptor 不因绑定成功而被丢弃**：`relocate` 发生在快照失效之后，那时 `ref` 已作废，能重新解析的只有 descriptor。第二步模型路径没有 bind 步骤（模型直接产出本快照 ref），但 SW 写入 plan 时**必须回填该 ref 对应的 descriptor**，否则模型路径的引导一旦目标移位就无法自愈——而且这样 U-11「模型生成的流程 → 引导包」变成一行代码。

### 5.5 `ElementDescriptor`：字段必须人可手写

设计约束：**每个字段都是作者在页面上肉眼能读到并写下来的东西。** 排除 XPath、CSS 路径、坐标、结构指纹。

```yaml
target:
  role: button                     # 必填
  name: "Copy for LLM"             # 必填
  name_match: exact                # exact(默认) | contains | fuzzy
  # ── 以下按优先级择需填写，能唯一即停 ──
  scope: "Payment methods"         # ① 最近的可命名祖先区块/标题文本 ← 主力判别器
  text: "Copy"                     # ② 元素自身可见文本（区别于 aria-label 来的 name）
  near: "Region"                   # ③ 视觉/DOM 邻接的标签文本（表单、表格行杀手锏）
  attr: { href: "/settings/keys" } # ④ 白名单属性：href / data-testid / id / name
  nth: 2                           # ⑥ 最后手段：【同 scope 内】的序号，标记为脆弱步骤
```

**匹配语义是合取过滤，不是加权打分。** 填了的字段全部必须满足，不凑分、不 tie-break——这让手写字段的行为对作者可预期。

`scope` 存的必须是**文本身份**而非 `ref`（ref 不跨快照）。唯一允许的模糊是 `name_match: fuzzy`；fuzzy 命中多个 = 歧义，不 tie-break。

### 5.6 绑定：逐步惰性 + 禁止 tie-break

**`bindFlowToSnapshot`（整流程一次性绑定）是个真 bug，必须改成 `bindStep`（逐步惰性绑定）**：

- 步骤 3 的目标在步骤 1 时通常**根本不存在**（向导下一页的控件、点开后才出现的菜单项）。整流程绑定会对它们返回 NotFound，而系统**无法区分「真的不存在」和「还没轮到出现」**。
- 引导跨页导航后快照必然更新，早先绑好的 ref 全部作废。

```ts
type BindResult = { kind: 'unique'; ref: Ref }
                | { kind: 'ambiguous'; refs: Ref[] }
                | { kind: 'not_found' };
```

**`bind` 内部禁止任何打分排序与 tie-break。** 静默绑错只可能诞生于「在多个候选中挑一个」这个动作；取消这个动作，静默错误就被压缩成「唯一命中但那一个是错的」这个残余子集。这是类型级保证，不是运行时检查。

**歧义左移到创作期**：检视器生成 descriptor 时**立刻回代匹配当前页面并显示命中数，命中数 ≠ 1 则不允许采用**，必须补判别字段直到唯一，且自动建议最小判别字段集。包导入时同样做静态歧义检查。

> 这条最关键：它把误差源**分离**了。做到之后，运行期出现的多候选/无命中**只可能由页面变化造成**，不可能由「descriptor 写得差」造成。没有这条分离，指标测出来的是两种原因的混合物，不可归因、不可改进。

**执行期多候选的产品行为**（不让终端用户挑——他不知道包作者想指哪个，而他正是因为不知道才来用这个扩展）：

| 候选数 | 行为 |
|---|---|
| 1 | 正常聚光高亮 |
| 2–3 | 同时框出全部候选（弱化描边，不打聚光）+ 显示各候选的 scope，卡片文案「这一步的目标是这 N 个之一，请按说明判断」 |
| ≥ 4 | 不画框，直接进失效屏（画 14 个框等于没画） |

多洞遮罩已为 `refs: []` 建好，零渲染成本复用。

**「指错了」入口**：卡片提供 → 打开检视器并预填该步 → 用户点选正确元素 → 生成消歧后的 descriptor 片段复制到剪贴板。**不做自动写回本地包**（需要「原包 vs 用户改动」的可变副本与合并管理，属 M-06 之后）。

---

## 6. 跨进程协议

### 6.1 第一步需要 Service Worker 吗——需要，但只有 12 行

| 能力 | 谁做 |
|---|---|
| 点击图标打开 side panel | **必须 SW**：`chrome.sidePanel.setPanelBehavior` 只能在持久上下文调 |
| side panel → content script（抽取/高亮） | **不需要**：side panel 是扩展页，可直接 `chrome.tabs.sendMessage` 并 await |
| content script → side panel（事件） | **不需要**：`chrome.runtime.sendMessage` 广播 |
| 注入 content script | **不需要**：side panel 有 `scripting` 权限 |

```ts
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  });
});
```

**这不是「以后要改」的临时方案**：协议定义为 **tab 作用域的 RPC**，`sendToTab(tabId, req)` 谁调都一样。第二步 SW 成为图的宿主后，`extract` 节点调的是同一个 `sendToTab`，content script 侧一行不改。这正是 §5.4「浮层状态由 content script 独立持有」的架构含义。

### 6.2 类型

```ts
export interface ContentRpcMap {
  PING:      { req: {};                                     res: { version: string; frameId: number } };
  EXTRACT:   { req: { profile: ExtractProfile; budget: ProjectBudget }; res: PromptTable };
  HIGHLIGHT: { req: { command: HighlightCommand };          res: HighlightAck };
  CLEAR:     { req: {};                                     res: null };
}

export interface HighlightPlan {
  sessionId: string;
  snapshotId: string;          // ★ 必须等于当前快照，否则拒绝渲染
  mode: 'guide'|'locate'|'explain'|'diagnose';
  step: GuideStep;             // 单步。序列与游标不在这里
  progress: { index: number; total: number };  // 只用于画「步骤 2 / 5」，改不了它
  autoScroll: boolean;
}

export interface HighlightAck {
  resolved: Ref | null;        // 真正画上去的那个元素；null ⇔ failure 有值
  rect: Rect | null;           // 顶帧视口坐标，已跨帧合成
  scrolled: boolean;
  candidates?: readonly Ref[]; // 命中多个时的全部候选，全部框出，一个都不挑（K-6）
  failure?: 'snapshot_stale'|'ref_not_found'|'sensitive_blocked'|'not_visible'|'frame_unreachable';
}

export const RPC_TYPES = ['PING','EXTRACT','HIGHLIGHT','CLEAR','DEBUG_GET_OVERLAY_STATE'] as const;

export type ContentEvent =
  | { type:'STEP_CONFIRMED'; sessionId: SessionId; stepIndex: number }
  | { type:'STEP_SKIPPED';   sessionId: SessionId; stepIndex: number }
  | { type:'TARGET_LOST';    sessionId: SessionId; ref: Ref; reason:'removed'|'hidden'|'zero_area' }
  | { type:'SESSION_ENDED';  sessionId: SessionId;
      reason:'user_closed'|'navigated'|'aborted'|'completed' };  // 'completed' 由流程所有者发
```

**相对总设计文档 §5.4 的改动：**

| 改动 | 理由 |
|---|---|
| 去掉 `requestId` | `chrome.tabs.sendMessage` 在 MV3 返回 Promise，请求—响应天然配对。加它是纯间接层 |
| 新增 `HighlightAck` | 渲染会失败（ref 失效 / 不可见 / 跨源帧 / 敏感字段），**没有 ack 则 agent 会以为用户看到了高亮，实际什么都没发生，然后继续推进步骤** |
| 新增 `snapshotId` | R-04 的本地防线 |
| ~~`HIGHLIGHT` 携带整个 plan~~ → **单步 `HighlightCommand`** | **2026-08-07 推翻。** 原理由「SW 被回收时卡片上的下一步不知道去哪」反向成立：SW 有恢复机制（消息唤醒 + checkpoint），content script **每次导航必死且没有任何恢复机制**——它是四个候选里最差的所有者。游标改归流程所有者（现在是侧栏，第二步是 LangGraph checkpoint），content script 只渲染手上这一步、只回报用户做了什么。`advance()` 已删除 |
| **`RPC_TYPES` 白名单 + 编译期一致性证明** | `onRequest` 按白名单在门口拒收未知动词，而不是让它落进一个恰好没有分支的 switch。protocol.ts 里有一条类型级证明保证白名单与 `ContentRpcMap` 不会漂移。扩展持有 `<all_urls>`，「只读不写」是本代码库的性质而非平台保证，所以指令集必须是封闭且可断言的 |
| **渲染失败收成单通道** | 原先失败有两条路：`{ok:false, code}` 和 `{ok:true, data:{rendered:false, reason}}`。每个调用方都要查三层，而且各查各的子集。现在 `ok:false` 只表示「消息没送到」，渲染层的一切判断都在 `HighlightAck` 里，`failure` 缺席 ⇔ 画上去了 |
| **`sessionId` 变品牌类型并由 tabId 派生** | K-9：一个标签页一个会话，且第二步 `sessionId ≡ threadId`。把这个不变量做成结构性的，而不是靠约定 |
| **事件带上 tabId** | content script 不知道自己的 tabId，只能从 `sender` 带出来。没有它，侧栏只能假设每个事件都来自它当前看着的那个标签页——用户引导到一半切个标签页，这个假设就错了 |
| `SESSION_ABORT` 拆成 `CLEAR` + `SESSION_ENDED` | 原文的「双向」消息在类型上表达不了，实际是两件事 |
| `Ref` 含 frameId，`Rect` 声明为本帧坐标 | 跨 iframe 时 `getBoundingClientRect()` 是本帧视口坐标，顶帧直接用会偏移到错误位置 |

---

## 7. 验证流程

### 7.1 单元测试：两个 vitest project

**抽取器在 jsdom 里根本测不了**——jsdom 的 `getBoundingClientRect()` 恒返回全 0，没有 `checkVisibility`，没有真实布局与层叠。用 jsdom 测抽取器等于测了个寂寞。

```ts
projects: [
  { name:'logic', environment:'node',   include:['tests/unit/**'] },
  { name:'dom',   include:['tests/dom/**'],
    browser:{ enabled:true, provider:'playwright', instances:[{browser:'chromium'}], headless:true } },
]
```

**`logic`（Node，纯逻辑）**

| 文件 | 测什么 |
|---|---|
| `project.spec.ts` | 打分排序确定性；同分按文档序稳定；`maxNodes` 边界（N-1/N/N+1）；`truncated` 标记；**主内容区元素在超预算时必须胜过导航区元素**；`path` 构造；`nth` 仅在必要时出现 |
| `ambiguity.spec.ts` | 合成用例：同名跨区块、同名同表格行、纯标点 name、等价 href —— 断言各自被正确的机制消解 |
| `fingerprint.spec.ts` | 滚动后不变；新增按钮后不变；路由变化后改变；landmark 文案改动后改变 |
| `lexical.spec.ts` | 词法基线 top-1；空 query；全空 name |
| `sensitive.spec.ts` | `type=password`、`autocomplete=current-password/cc-number/cc-csc/one-time-code`、中英文关键词矩阵；**误报测试**：`name="password_policy_link"` 的链接不应被判敏感 |
| `bind.spec.ts` | `unique`/`ambiguous`/`not_found` 三态；**断言实现中不存在任何 tie-break 分支** |
| `roles.spec.ts` | 用 `aria-query` 断言可交互 role 集合不与 ARIA widget 超类闭包漂移 |
| **`architecture.spec.ts`** | **代替 ESLint 的三条硬约束**：① `core/extractor/**` 不得出现 `getComputedStyle(`；② `src/**` 不得读取 `.value` 用于构造 `UINode`（S-05 护栏）；③ `UINode` 运行时 key 集合恒等于类型白名单 |

**`dom`（真 Chromium）**

| 文件 | 测什么 |
|---|---|
| `walk.spec.ts` | 3 层嵌套 open shadow root；slot 内容不重不漏；iframe 边界停止；`MAX_SHADOW_DEPTH`；**closed shadow root 内元素确认不在结果中**（把已知损失固化为契约） |
| `visibility.spec.ts` | 8 种隐藏方式各一例：`display:none`/`visibility:hidden`/`opacity:0`/零面积/`hidden`/`aria-hidden` 祖先/`inert` 祖先/`content-visibility:auto` |
| `modal-scope.spec.ts` | 三种模态下背景元素**必须不在表内** |
| `semantics.spec.ts` | role 推断表；accname 优先级链；80 字截断；**JUNK name 规则**；`nameSource` 分类 |
| `overlay-geometry.spec.ts` | **核心**：遮罩洞与 `getBoundingClientRect()` 误差 ≤ 1px；`scrollBy` 后 2 帧内重新对齐；祖先加 `transform: translateZ(0)` 后仍对齐（Top Layer 免疫性回归） |
| `overlay-zorder.spec.ts` | 页面有 `z-index: 2147483647` 全屏遮罩时 `elementFromPoint` 命中我们的宿主；祖先有 `filter: blur()` 时同样 |
| `mask-multihole.spec.ts` | **3 个洞同时挖**（V-3 的回归测试）；断言 `<svg>` 有显式 width/height |
| `tracker.spec.ts` | `el.remove()` 后 3 帧内发 `TARGET_LOST`；React 式「移除后同帧重插」**不得**误报；稳定 20 帧后 rAF 停止排帧 |
| `sensitive-render.spec.ts` | 对 `sensitive` ref 调 HIGHLIGHT → `rendered === false`，且**页面上没有任何浮层元素被添加** |
| `stale-snapshot.spec.ts` | 旧 `snapshotId` → `reason === 'snapshot_stale'` |

### 7.2 E2E（Playwright）

```ts
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',                    // ★ V-7：Chrome for Testing 可用，品牌版 Chrome 不可用
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extensionId = new URL(sw.url()).host;
```

> **备选路径**（必须用品牌版 Chrome 时）：`--remote-debugging-port` + `--enable-unsafe-extension-debugging`，再用 CDP `Extensions.loadUnpacked` 加载，`Target.getTargets` 找 `service_worker` 目标后 `Runtime.evaluate`。已实测可用。

**驱动 side panel**：side panel 无法编程打开（需用户手势），但它就是一个普通扩展页——直接 `page.goto('chrome-extension://<id>/sidepanel.html')` 当普通标签页驱动，`chrome.tabs` / `chrome.scripting` 全部可用。

**因为浮层是 closed shadow root，E2E 选择器穿不进去**——用扩展内 debug 消息通道读取浮层状态（`DEBUG_GET_OVERLAY_STATE` 返回当前步、目标 rect、状态枚举）。**这个通道不是测试专用品**：第二步 side panel 本来就需要知道浮层状态，是同一条消息。

用例：① 冒烟（安装→打开 fixture→抽取→节点表非空）；② 端到端高亮（点表格第 3 行→遮罩洞对齐该元素）；③ 注入韧性（先开页面后重载扩展→`ensureInjected` 恢复）；④ 跨帧（同源 iframe 内按钮可高亮且 rect 合成正确）；⑤ 导航失效（→ `SESSION_ENDED{navigated}`）；⑥ 性能门禁。

**视觉回归：做，但只做 10 张。** 浮层是我们自己渲染的（不受页面随机性影响），且遮罩/挖洞/卡片摆位的 bug 用几何断言抓不全。10 个场景：正常按钮 / 长文本按钮 / 视口边缘 / 巨大目标 / iframe 内 / 模态内 / 多洞 explain / 暗色主题 / RTL / 失效卡片。关闭一切动画 + `reducedMotion:'reduce'` + 固定 `1440×900` / `deviceScaleFactor:1` / `--force-color-profile=srgb`，`maxDiffPixelRatio: 0.002`。

> **几何断言是第一道防线，截图是第二道。顺序不能反**——截图告诉你「变了」，几何断言才告诉你「错在哪」。

### 7.3 性能门禁：棘轮 + 量级护栏

绝对阈值做抽取器门禁**形式上就是错的**——页面重量在真实语料里跨 20 倍，任何单一绝对值要么误报要么永不触发。

```jsonc
// tests/eval/perf-baseline.json  —— 提交进仓库，随优化手动下调
{ "mdn-docs":{"p50":6.2,"n":2949}, "stripe-docs":{"p50":2.8,"n":4653},
  "github-repo":{"p50":2.7,"n":2025}, "grafana-play":{"p50":1.4,"n":346} }
```

| 门禁 | 规则 | 抓什么 |
|---|---|---|
| **棘轮（主）** | `p50 > baseline.p50 × 1.4 + 0.5ms` | **40% 的回归**。MDN 上 = 9.2 ms 报警，而非 150 ms |
| **量级护栏** | 任意页面 `total > 50 ms` | 防「掉进另一个性能量级」（如误加全树 `getComputedStyle`） |
| **降频** | CDP 4× 节流下 `total > 120 ms` | 低端机可用性 |
| 统计量 | **N=30 取 p50**；p95 只报告不门禁 | 6 ms 量级上 p95 被 GC/调度噪声主导，做门禁必然 flaky |
| 基线下调 | `p50 < baseline × 0.8` 连续两次 → 提示更新基线（不失败） | 防基线因一次侥幸慢跑而永久放宽 |

`+0.5ms` 常数项是给 Grafana 这类小页面的——1.4 ms 的 40% 只有 0.56 ms，纯噪声就能触发。

### 7.4 评测语料：为 M0-b 铺路

核心洞察：

> **top-1 准确率 = recall@budget × 表征可区分性 × 模型条件准确率。**
> 前两项**完全不需要模型就能测**，而它们是设计文档自己指出的主要变量。第一步交付的就是这个可离线回放的度量闭环。

**Tier A：黄金 fixture（进仓库，~20 个）** —— 手写 HTML+CSS，每个只针对一个结构模式：嵌套 shadow DOM、slot、同源/跨源 iframe、模态、`inert`、虚拟滚动、`content-visibility:auto`、sticky header、canvas-only、无 aria 的 div-button、`aria-labelledby` 链、**重名按钮（区块不同）**、**表格行内重名操作**、RTL、暗色。文件小、可 review、零 flake。

**Tier B：真实控制台语料（不进主仓库，独立私有仓）**

抓取工具用 Playwright headed，用户手动登录后按键触发：

```
html = document.documentElement.getHTML({ serializableShadowRoots: true, shadowRoots: allRoots })
```

> **不用 MHTML**：CDP `Page.captureSnapshot` 很方便，但 **MHTML 不序列化 shadow DOM**——而 shadow DOM 恰恰是现代 SaaS 控制台的主体（V-5）。`getHTML({serializableShadowRoots:true})` + `setHTMLUnsafe()` 是唯一能保真回放 shadow 结构的路径。无法处理的页面退回 MHTML 并标注 `shadowLost: true`，报告分组统计。

样式内联（CORS 拦截的样式表交给 Node 侧 `page.request.get()` 抓取后内联）；移除所有 `<script>`；**强制脱敏**（邮箱 / AWS account id / IP / ARN / 手机号 / 身份证）；记录 viewport 与 scrollY。用户在浮层里点选「这一步的正确目标」，工具记下稳定选择器。

**指标（全部零模型）：**

| 指标 | 定义 | 第一步门槛 |
|---|---|---|
| `recall@budget` | 标注目标出现在投影表中的比例 | **≥ 95%**（< 90% 时 top-1 ≥ 70% 数学上不可能） |
| `recall` 分组 | 按 shadow / iframe / 模态 / div-button 分组 | **告诉我们下一个该修什么** |
| `ambiguity_raw` | `role\|name` 不唯一的节点占比 | 记录（基线 9.3–22.2%） |
| **`ambiguity@budget`** | 加 `path`/`nth` 后不唯一的节点占比 | **≤ 5%** |
| **`target_ambiguity`** | **标注目标中不唯一的比例** | **≤ 3%** |
| `top1_ceiling` | `(1/N)·Σ 1/kᵢ` | **≥ 92%**（当前实测方案 D 达 100%） |
| `emptyName` | 含 JUNK 规则后 | ≤ 10% |
| `baseline top-1`（词法） | 记录，无门槛 | M0-b 的下界；也回答「这个任务到底需不需要 LLM」 |

> **`target_ambiguity` 比 `ambiguity@budget` 更重要**：页面级平均会掩盖「用户真正想点的那个恰好是歧义的」。而恰恰是重复功能（`Copy`、`Delete`、`Edit`）最常成为引导目标——**歧义节点被选为目标的概率高于均匀分布**，所以页面级指标有乐观偏差。

**这套东西第二步不用改一行**：把 `scoreNodes` 换成 `await resolve()`，同一个 `replay.ts` 直接产出 M0-b 要的真实 top-1。

### 7.5 descriptor 解析分层指标

原「D-2 解析成功率 ≥ 95%」把「无命中」和「多命中」混在一个数里，而两者的产品后果差一个数量级：

| 分类 | 定义 | 门槛 |
|---|---|---|
| **L-0 创作期唯一性** | 检视器产出的 descriptor 在生成当刻命中数 = 1 **且绑回被点的那个元素** | **100%（强制，非统计量）** |
| **L-1 唯一且正确** | 命中 1 个且 = 标注目标 | ≥ 90% |
| **L-2 多候选（含正确目标）** | 命中 2–3 个且正确目标在其中 | ≤ 8%，这些步在包校验报告中标红 |
| **L-3 无命中** | 命中 0 个 | ≤ 2% |
| **L-4 唯一但错误** | 命中 1 个且 ≠ 标注目标 | **0 —— 唯一的硬门槛**，任何一例必须归因到根因 |

**L-0 的两个条件缺一不可（2026-08-07 落地）。** 只数命中个数不检查身份，正是 L-4 被认证为安全的方式——命中 1 个不等于命中对的那个。`authorDescriptor` 因此在每一档都做 `bindStep(...).ref === item.ref` 的身份核对，任一档不满足就继续往上爬；爬到顶还不满足，就**如实报告 `correct: false`**，而不是硬凑一个看起来唯一的 descriptor。

阶梯是**最弱优先**的：`{role,name}` → `+scope`（内层）→ `+scope`（外层）→ `+nth`。每多一个字段就多一样改版能打断的东西，所以纯位置的 `nth` 排在最后并被标为脆弱。一个不必要的 `scope` 是缺陷，不是无害的谨慎。

**我们要保证的从来不是「总能找到」，而是「绝不指错」。** L-2/L-3 都会导向可见的产品行为（多目标提示 / 失效屏），用户不会被误导去点错按钮；L-4 是静默的，用户会真的去点错的按钮。

### 7.6 手工验收清单

在 **AWS 控制台 / Grafana / Kubernetes Dashboard** 三个真实站点上逐条走：

- [ ] 1. 点图标 → side panel 打开，无报错
- [ ] 2. 点「抽取」→ 3 秒内出现节点表，`stats.ms.total` 显示且 < 50 ms
- [ ] 3. 节点表里能找到当前页主操作按钮，name 与 role 正确
- [ ] 4. 折叠的侧边栏 / 未展开的下拉里的项**不在**表中
- [ ] 5. 滚到页面中部再抽取 → 投影表随视口变化
- [ ] 6. 打开模态框再抽取 → **表里只有模态框内的元素**
- [ ] 7. 点表中任一行 → 遮罩 + 脉冲框**严丝合缝套住那个元素**
- [ ] 8. 目标在视口外 → 自动平滑滚到居中，滚完框才稳定
- [ ] 9. 滚动页面 → 框跟随，**无抖动无滞后**；停止约 0.3 s 后 Performance 面板看不到持续 rAF
- [ ] 10. 侧边栏内部滚动（嵌套容器）→ 框同样跟随
- [ ] 11. 调窗口大小 / Ctrl+缩放 → 框保持对齐
- [ ] 12. DevTools 里 `$0.remove()` 掉目标 → 约 50 ms 内出现失效卡片，side panel 收到 `TARGET_LOST`
- [ ] 13. 页面注入 `z-index: 2147483647` 元素 → 浮层仍在最上层
- [ ] 14. 页面 `<html>` 加 `filter: blur(0px)` → 浮层仍对齐（Top Layer 免疫性）
- [ ] 15. 页面注入 `div { display: none !important }` → 浮层宿主仍可见
- [ ] 16. 控制台执行 `document.querySelector('pg-overlay').shadowRoot` → 返回 `null`
- [ ] 17. 含密码框的登录页 → 密码框在表里且 `sensitive: true`；对它高亮 → **拒绝渲染，页面上无任何浮层元素**
- [ ] 18. 抽取后改页面再用旧 `snapshotId` 高亮 → 拒绝并提示重新抽取
- [ ] 19. 输入「创建一个安全组」→ 词法基线选中并高亮，面板显示「本地基线 · 零成本」
- [ ] 20. 一个引导包从第 1 步走到最后一步，**中途无失效屏**；其中至少 2 个包跨页面导航（SPA 路由 + 整页刷新各一）
- [ ] 21. 目标滚出视口 → 显示方向箭头，**不进失效屏**（三态可区分性）
- [ ] 22. 目标被模态遮挡 → 显示「被遮挡」，**扩展不关闭该模态**
- [ ] 23. 跨源 iframe 内的目标 → 显示降级文案 + 框出 iframe，**不显示空框**
- [ ] 24. Figma 上打开面板 → 「本页面无可识别控件」，**不是 spinner 或空白**
- [ ] 25. `chrome://extensions` 上 → 「本页面不允许扩展运行」
- [ ] 26. 导入格式非法的 YAML 包 → 显示具体校验错误（哪一行、哪个字段），不崩溃
- [ ] 27. 检视器：hover 任一控件均显示条目或「未入表 + 原因」，无「什么都不显示」
- [ ] 28. 全程 DevTools **发起 0 个网络请求**；Console 无 error；宿主页自身功能不受影响

---

## 8. 实施顺序

每个任务结束时都必须有**一个能跑起来的东西**（AGENTS.md 第 3 条）。

| # | 任务 | 交付后「什么能跑起来」 |
|---|---|---|
| **T0** | WXT + React + TS 骨架；`background.ts`（12 行）；`content.ts` 只实现 `PING`；side panel 一个按钮；`protocol.ts` + `rpc.ts` + `ensureInjected` | 扩展能装、图标能打开 side panel、点按钮能 PING 到 content script 并显示页面标题。**跨进程链路全通** |
| **T1** | `walk` + `visibility` + `semantics`（**含 JUNK name 规则与兜底链**）+ `roles` + `types`；`EXTRACT` RPC | side panel 显示当前页的 `UINode` 表。**在 AWS 控制台上肉眼可验** |
| **T2** | `extract → LocatorView`（全集）与 `project()`（视口带 + 打分 + `path` + `nth`）两个可独立测试的单元；`fingerprint` + `registry` + `sensitive` | 面板可切 profile / maxNodes，表随之变化；StatsBar 显示分阶段耗时与截断标记；敏感字段标红 |
| **T3** | `overlay/mount` + `Mask`（多洞）+ `Spotlight` + `StepCard` + `geometry`；`HIGHLIGHT` RPC + `HighlightAck` | **★ 两个 tool 首次闭环：点表格一行 → 页面上那个元素被框住。第一个真正的产品瞬间** |
| **T4** | `tracker`；`scrollToTarget`；`TARGET_LOST`；失效屏三态 | 高亮在滚动/缩放/DOM 变化中稳定跟随；目标消失有明确提示。**浮层从「一次性画」升级为「活的」** |
| **T5** | `agent/api.ts` stub；`locator/lexical.ts`；`packs/`（类型 + 匹配 + `bindStep` + 2 个演示包）；元素检视器（含创作期唯一性强制） | **★ 用户在 side panel 输入自然语言 → 扩展高亮它的最佳猜测，不需要任何 API Key。第一步的产品形态完成** |
| **T6** | `allFrames` 注入 + 帧 rect 合成中继；`frame_unreachable` + 权限申请 UI | iframe 内的元素也能被抽取和高亮 |
| **T7** | `eval/capture.ts` + `replay.ts` + 标注 schema；抓 15–20 个真实控制台页面 | `pnpm eval` 打印 recall / ambiguity / top1_ceiling / 耗时分布 / 分组损失。**M0-b 的度量闭环建成** |
| **T8** | **数据驱动的调优**（入口条件由 T7 数字决定，不提前做） | recall ≥ 95% 且 `ambiguity@budget` ≤ 5% 且 `top1_ceiling` ≥ 92%，可以放心进第二步 |
| **T9** | 视觉回归基线 + CI（typecheck / test / e2e / eval / check-size） | CI 绿灯即可发 dev 版 |

**T8 的候选项（全部待数据触发，不提前做）**：`cursor:pointer` 二遍扫描（若 div-button 导致 recall 掉）；`<svg><title>` / 图标名兜底（若 `emptyName` 高）；MAIN world `attachShadow` 劫持（若 closed shadow root 损失显著）；`elementFromPoint` 遮挡命中测试（若遮挡误选显著）。

> **T8 是刻意留白的。** 那些启发式全是「看起来该做」的东西，但每条都会增加复杂度和误报面。AGENTS.md 第 2 条要求最简实现——**在 T7 给出数字之前，我们并不知道它们中哪几条是必要的。** 把它们排在度量之后，是这套流程里最重要的纪律。

**总周期估计**：T0–T5 约 2.5–3 周，T6–T9 约 1.5–2 周。

---

## 8.5 已拍板的决策（2026-08-06）

| 决策 | 结论 |
|---|---|
| 第一步不上架 Chrome Web Store，走 unpacked 本地分发 | ✅ 采纳 |
| `minimum_chrome_version: '120'`，Top Layer 作为平台契约，不写 z-index 降级分支 | ✅ 采纳 |
| T7 评测语料的登录态重型控制台页面 | 由项目方自行测试与抓取 |

---

## 9. 现在必须锁定的长期决策

| # | 决策 | 后改的代价 |
|---|---|---|
| K-1 | **`Ref` 从第一天帧限定**（`f{n}e{m}`），即使先只跑顶帧 | ref 格式渗透进快照序列化、评测标注、prompt 契约，后改是全局改动 |
| K-2 | **`resolve()` 收 `LocatorView` 而非序列化 YAML** | prompt 渲染放在 agent 边界内，是第二步能自由更换契约格式而不惊动前端的前提 |
| K-3 | **浮层用 Top Layer 而非 z-index，且不写降级分支** | 靠 `minimum_chrome_version` 把它变成平台契约，消灭三整类 bug |
| K-4 | **`extract()` 出全集，`project()` 独立** | 否则第二步 `relocate` 本地重定位在最需要它的场景下失效 |
| K-5 | **`GuideStep` 同时带 `ref` 与 `descriptor`** | 否则模型路径的引导一旦目标移位就无法自愈 |
| K-6 | **`bind` 禁止 tie-break，返回三态** | 类型级消灭「静默绑错」这一整类失败 |
| K-7 | **敏感字段拦截装在渲染入口** | 与步骤来源无关，第二步接模型时这道闸已跑了几周 |
| K-8 | **权限模型 `activeTab` + `optional_host_permissions` + 动态注册** | 已发布扩展改 manifest 权限 = 重新审核 + 存量用户被禁用 |
| K-9 | **`sessionId ≡ 未来的 threadId`**，绑定 tabId + 会话序号 | 避免第二步 LangGraph 引入第二套会话标识 |

**明确不冻结**（故意不定同样重要）：`intent` 枚举、抽取 profile 分档、token / 成本模型、prompt 模板与 YAML 输出契约、provider 配置结构、检查点格式、澄清与重规划的交互语义。

> 这些的形状取决于第二步 M0-a spike 的结果与真实端点的兼容性实测。现在定 = 猜，猜错了要么将错就错、要么推倒重来，两者都违反 AGENTS.md。**第一步不为它们预留任何字段、枚举或配置项。**

---

## 10. 遗留风险

| 风险 | 说明 | 处置 |
|---|---|---|
| 消歧结论的样本量 | §3.4 只有 4 个页面，且**没有一个是登录态的重型控制台**（AWS IAM、K8s Dashboard 均未测到） | T7 语料必须覆盖，`ambiguity@budget` 与 `target_ambiguity` 是验收指标 |
| `UntrackedValue` 的 API 稳定性 | 第二步会用到，其 channel 实现标了 `@internal` | 锁版本；第一步不涉及 |
| WXT 仍是 0.x | 0.21.3，次版本间可能有破坏性变更 | 锁版本，升级走独立 PR |
| closed shadow root 的损失未知 | 实测样本中未发现，但样本小 | T7 分组统计给出数字后再决定是否做 MAIN world 劫持 |
| 第二步的 SW `fetch` 30 s 上限 | V-8，本方案不涉及但第二步必踩 | 已记入总设计文档修改建议 |
