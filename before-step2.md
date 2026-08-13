# 进入第二步（接入 Agent）之前的必办清单

> 2026-08-07
> 输入：高级开发工程师 agent + 高级架构工程师 agent 的独立审计，加上主控的真实浏览器实测
> 结论：**当前「19/19 e2e 全绿」是不可信的。** 它建立在一个永远不会出货的权限配置上，且测试覆盖不到已确认的 7 个缺陷。
>
> **2026-08-07 收尾：15 项全部处理完毕，放行第二步。** e2e 19 → 70，单测 34 → 55，评测闭环建成且全部门槛通过（`L-4 = 0%`）。逐条判据见 §8。

---

## 0. 一句话总结

两位 agent 从不同入口出发，指向同一个根因：

> **引导流程的状态没有唯一所有者。** 现在侧栏和 content script 各拥有一半，而第二步的 LangGraph 会成为第三个。清单里绝大多数问题都是它的推论。

而开发工程师额外发现了一个**更前置的阻塞**：把权限模型改对之后，扩展当前完全跑不起来。所以顺序是「先权限、再所有权、再度量」。

> **2026-08-07 更新**：权限一项已经走完，但**结论与当初预设相反**。实测 + 对本机 27 个已装扩展的审计之后，权限模型定为「安装时一次性收取 `<all_urls>` + 静态注入」，原计划的授权子系统整体不做（方案 §2.3）。任务 1、3 已完成，e2e 由 19 项增至 32 项。

---

## 1. 已实测确认的缺陷（12 条，全部有复现证据）

不是代码阅读推断，是在真实 Chrome for Testing + 真实扩展安装里跑出来的。

### 1.1 安全与产品级 P0

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| **F-1** ✅ | **`alsoRefs` 绕过 S-03 敏感字段拦截** | `steps:[{ref:创建按钮, alsoRefs:[密码框]}]` → `{"rendered":true}`，密码框被挖洞聚光 | `content.ts:82` 只查 `step.ref`，`content.ts:92-94` 直接解析 `alsoRefs` 画洞。**而 `explain`/`diagnose` 返回的 `refs:[]` 走的正是这条路**——K-7 声称「模型来之前这道闸已跑了几周」，实际上模型要走的那条路没有闸 |
| **F-2** ✅ | **`CLEAR` 完全不生效，黑幕永久留在用户页面** | CLEAR 后：`display:"block"`, `inline priority:"important"`, `:popover-open:true` | `overlay.ts:200` 的 `hide()` 写 `display:none` → 触发 `overlay.ts:112` 自己的 MutationObserver → `apply()` 把 `display:block !important` 写回。**加固逻辑吃掉了隐藏逻辑**，自反馈环。用户只能刷新页面才能摆脱 |
| **F-3** ✅ | **第 3 层加固是死代码** | 页面 `host.remove()` 后 1 秒，浮层不自愈 | observer 只观察 `host` 自身的 attributes，而 childList 变更记录产生在**父节点**上。`if (!host.isConnected)` 永远不执行。页面一行 JS 就能永久干掉浮层 |

> F-2 / F-3 的同一个 bug 也存在于方案 §4.1 的 `hardenHost` 伪代码里——实现是照抄的。文档要一起改。
>
> **2026-08-07 更新：F-1 / F-2 / F-3 已修复**（任务 1），方案 §4.1 与 §4.4 的伪代码/契约已同步改正，e2e 由 19 项增至 30 项。

### 1.2 阻塞第二步的功能缺陷

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| **F-4** ⚠️ | ~~**权限改对后扩展完全跑不起来**~~ **诊断已更正** | 加 `build:manifestGenerated` hook 抹掉 `host_permissions` 后：`tabs.query({})` 只返回 id、**没有 url**；`executeScript` → `Cannot access contents of the page` | 症状属实，但**归因错了**。权限 spike 的 A/B 证明：`tab.url` 的可见性由 `"tabs"` 权限单独提供，与 host 权限相互独立——声明 `"tabs"` 后零 host 权限也读得到 url。所以这不是架构死路。**最终裁决又走了第三条路**：权限模型定为安装时收取 `<all_urls>`，url 可见性由 host 权限直接提供，`"tabs"` 不需要，这条缺陷整体消失。见方案 §2.3 |
| **F-5** ✅ | **`nth` 随滚动位置改变，descriptor 不可复现** | 三个同名 Copy 铺开在长页面：`scrollY=0` → 1 号按钮 `nth=2`；`scrollY=2000` → 同一个按钮 **无 nth** | `assignNth()` 在 `prune()` **之后**跑，而 prune 依赖 `withinBands` 依赖滚动位置。顶部创作的 `nth:2` 到了别处 `bindStep` 过滤 `it.nth===2` 命中 0 个。**K-6「唯一命中即正确」的类型级保证被作废** |
| **F-6** ✅ | **离屏步骤必然 `not_found`** | 目标推到 y=5550（带宽上限 1800）→ 不进投影表 → `bindStep` 返回 `not_found` | 引导包里一个完全合法的「下一步在页面下方」的步骤直接失败 |
| **F-7** ✅ | **「重试定位」按钮是死的** | SPA 重建按钮（删掉再用同 id/文本插回）后重试 → `{"rendered":false,"reason":"ref_not_found"}` | `onRetry: () => void render()` 拿同一个失效 ref 再查一次 registry，必然还是 null。**descriptor 里写着 `role=button, name="Create instance"`，元素也确实存在，但没有任何代码去读它** |
| **F-8** ✅ | **整流程一次性绑定 → demo 包走不过第 2 步** | `api.ts:75` `for (const [i,ps] of hit.flow.steps.entries())` 对全部步骤预绑定 | 第 2 步的目标在第 1 步时**根本不在 DOM 里**（`github.ts` 的 `open-settings` 正是如此），绑不到就写 `ref:'' as Ref` → 渲染时必进失效屏。**方案 §5.6 明确判定这是 bug，实现里做的正是它**。这也是「只能做简单匹配」的真实原因之一——不是词法弱，是多步走不通 |

### 1.3 表征质量缺陷（直接影响 M0-b）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| **F-9** ✅ | **`pathOf` 结构上找不到标题** | Stripe 108 个控件里 **96 个 path 为空**，歧义率 **18.5%**（门槛 ≤5%） | `pathOf` 只向上走祖先链，但 HTML 里标题几乎从不是按钮的祖先，是**前面的兄弟**。设计验证原型用的是「文档序最近前驱标题」，所以测出 0%；实现改成祖先遍历后信号没了 |
| **F-10** ✅ | **`<div role="heading">` 被整个丢弃 + 祖先/行标识不穿 shadow 边界** | `extract.ts:58` 用 `/^h[1-6]$/.test(localName)` 判定；`nearestStructuralAncestor` 用 `parentElement`、`rowLabelOf` 用 `closest()` | GitHub 32 个、MDN 37 个 shadow root 里的元素**永远拿不到 path**。**这让度量说谎**：fixture 上 `ambiguity=0%` 是因为 fixture 的 shadow 区只有 2 个不重名按钮 |
| **F-11** ⚠️ | **MDN 抽取 341 ms** | 细分：walk 16 / visibility 8 / **name 300（2053 次 × 0.146ms）** | ~~真因是对 2127 个可见元素全算 name 而 project 只留 97 个~~ **归因错误**：产出就是 **2053** 个节点（MDN 侧栏约 2000 个链接），任务 8 之后绑定要搜全集，这些名字每一个都真的需要。不是浪费，是单次 `computeAccessibleName` 本身贵（它对名字子树里每个子节点调 `getComputedStyle`）。见 §4.6 |
| **F-12** ✅ | **`degraded` 传不出去 + rowLabel 拼接无分隔符** | `PromptTable` 的 key 里没有 `degraded`；产出 `'Latest commit 3 peoplechore(deps): bump '` | 250ms 看门狗真触发时，侧栏和未来的 Agent **完全不知道这次抽取是残缺的**——方案说的「可观测的降级」现在是无声的 |

### 1.4 另外两条代码级隐患（未实测，但代码可证）

- ~~**tracker 闭包捕获了第 0 步的 `step`**~~ ✅ 任务 4 已修：每步重建 tracker，`onLost` 从 `current` 读 ref。
- **`content.ts:89-108` `render()` 无重入保护**：`await scrollToTarget(el)` 最长阻塞 800ms，期间用户点「结束」→ `teardown()` 置 `plan=null` → `plan!.snapshotId` 抛 TypeError。

---

## 2. 根因裁决：状态所有权

判据只有一条：**状态归属于「生命周期覆盖该状态、且拥有恢复机制」的那个进程。**

| 候选 | 何时死 | 有无恢复机制 |
|---|---|---|
| 侧栏 | 关面板即死 | 无 |
| **content script** | **每次导航必死** | **无** |
| SW | 30 秒空闲 | **有**（消息唤醒 + checkpoint） |
| LangGraph checkpoint | 浏览器重启 | 它就是恢复机制 |

而 `cursor` 现在归 content script——**四个候选里最差的那个**。方案 §6.2 当初的理由是「SW 被回收时卡片上的下一步不知道去哪」，这个理由反向成立：SW 被回收有恢复机制，content script 导航即死且没有任何机制。

### 最终归属

| 状态 | 唯一所有者 | 载体 |
|---|---|---|
| `threadId`、tab ↔ thread 映射 | **宿主（第二步的 SW）** | `chrome.storage.session` · `thread:tab:{tabId}` |
| 流程状态：`goal` / `steps` / **`cursor`** / `usage` / 历史 | **LangGraph checkpoint**（宿主内） | `ChromeStorageSaver` |
| 快照与元素身份：`snapshotId`、`ref→Element`、全集、`sensitiveRefs` | **content script** | 进程内存，不序列化 |
| 呈现状态：当前画哪一步、rect、tracker | **content script** | 进程内存 |
| 会话视图：消息流、成本、按钮态 | **侧栏** | React state，从事件流重建 |

三条可执行推论：

1. ~~**cursor 归图**~~ ✅ **已完成（任务 4）**：`advance()` 已删除，`HighlightCommand{step, progress}` 已落地。content script 现在纯粹「渲染当前一步 + 回报用户动作」。游标暂归侧栏——**第二步把它平移进 checkpoint 时，content script 一行不用改**，这正是收口的目的。
2. ~~**侧栏是纯视图**~~ ✅ 任务 11 已完成：侧栏只发 `START_GUIDE` / `END_GUIDE`，只渲染 `GUIDE_STATE`。**关掉侧栏引导继续**，e2e 里是在侧栏关闭之后才导航的。
3. **content script 只有一个指挥者**：⚠️ **部分完成**。引导的驱动已收归宿主，但侧栏的「抽取本页元素」按钮仍直连 content script 发 `EXTRACT`。任务 8 之后这不再能打断引导（步骤按 descriptor 重绑，不依赖调用方的 snapshotId），所以危害已经消除；但直连本身还在，留给任务 9 一并收口。

---

## 3. `agent/api.ts` 签名必须现在改

现在是 `resolve(req): Promise<ResolveResult>`。**扛不住第二步**，四个独立致命点：

1. **Promise 只能 resolve 一次**，而 `guide` 是 N 次 `interrupt()`。今天能工作，恰恰是因为挂起/恢复的责任被偷偷塞进了 content script 的 `advance()`——**签名撑得住正是因为状态所有权是错的**。这两个问题是同一个问题。
2. **流式没有出口**。`AbortSignal` 只买到取消，没买到流式。
3. **SW 的 30 秒 fetch 上限需要「可观测的进度」驱动保活**。`await resolve()` 期间宿主对内部一无所知。而保活策略（Port 心跳 / offscreen / 分块）要等 M0-a spike 才能定——事件流让三种策略都不改契约。
4. **`intent` 被冻结进了跨模块契约**，而方案 §9 明确写着「不冻结 intent 枚举」。

### 目标签名

```ts
export interface AgentHost {
  start(input: StartInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume(threadId: ThreadId, r: UserResume, signal: AbortSignal): AsyncIterable<AgentEvent>;
  abort(threadId: ThreadId): Promise<void>;
}

export type AgentEvent =
  | { kind: 'phase';      phase: 'preroute'|'pack'|'extract'|'resolve'|'relocate' }
  | { kind: 'delta';      text: string }
  | { kind: 'answer';     text: string; refs: readonly Ref[] }
  | { kind: 'show';       step: GuideStep; index: number; total: number; mode: HighlightMode }
  | { kind: 'await_user'; index: number }          // interrupt() 的落地点
  | { kind: 'ambiguous';  index: number; scopes: readonly string[] }
  | { kind: 'usage';      usage: TokenUsage; source: AgentSource }
  | { kind: 'error';      message: string; retryable: boolean }
  | { kind: 'done';       reason: 'completed'|'aborted'|'expired'|'failed' };
```

### 实际落地时的两处偏离（2026-08-07）

**一、消费事件流的是宿主，不是侧栏。** 上文写的是「侧栏用 `for await` 消费事件流」，那是在侧栏还持有流程时写的。任务 11 把流程归给了宿主，于是消费者也必须是宿主——侧栏随时可能被关掉，而生成器一旦中断就没有恢复点。宿主消费之后再把事件广播出去供侧栏渲染，侧栏因此保持为纯视图。

**二、多了一个 `HostSignal`，把渲染结果也送回 host。** 原设计里 `resume` 只接收用户动作。实际做下来，「这一步能不能指出来」同样是流程所有者需要的**证据**——跨页恢复的「先试下一步、绑不到就退回」规则要靠它才能落在一个地方。所以 `unresolved` / `navigated` / `reloaded` 与 `confirmed` / `skipped` 走同一道门。

**`ambiguous` 事件没有实现**：歧义在流程产出时不可知，只有渲染时可知，所以它由 `HighlightAck.candidates` 上报，不经过 agent 事件流。

**这是更小的边界，不是更大的抽象**——`table` / `contextWindow` / `history` / `intent` 四个字段全部消失（`history` 今天传的就是 `[]`，是死字段）。而 `AsyncIterable + resume` 与 LangGraph 的 `graph.stream(input,cfg)` / `graph.stream(new Command({resume}),cfg)` 是 1:1 的，**不需要适配层**。

成本对比：现在改 = `api.ts` 60 行 + `App.tsx` 25 行，**这两个文件是唯二的消费者**。第二步改 = api + 宿主 + Port 协议 + protocol + content + App + e2e，且是在 LangGraph、checkpoint、provider 都已就位、故障面最大时改。

---

## 4. 权限 spike（已完成，结论已并入方案 §2.3）

**`setPanelBehavior({openPanelOnActionClick:true})` 之下，点击工具栏图标是否授予 `activeTab`、`tab.url` 是否可读？**

这个答案决定权限子系统的全部形状，不能靠猜：

- **如果授予**：点图标 → 拿到 activeTab → 可读 url → 可注入。授权屏只在跨页导航后需要。
- **如果不授予**：必须改成 action 的 `onClicked` 显式处理（放弃 `openPanelOnActionClick`），或在侧栏放一个显式「授权本站点」按钮作为唯一入口。

### 执行情况（2026-08-07，`spike/permission-probe`，Chrome for Testing 149）

已确定的三条：

| 发现 | 证据 | 对任务 3 的影响 |
|---|---|---|
| **`tab.url` 的可见性来自 `"tabs"` 权限，与 host 权限、与 `activeTab` 相互独立** | 同一探针，仅增删 `"tabs"`：有则 `url` 可读、无则 `null`；两种情况下 `executeScript` 都被拒 | **推翻 F-4 的归因**。且我们选择不声明 `"tabs"`（「读取您的浏览记录」警告），于是**授权前不知道站点**成为一条主动接受的约束 |
| **`sidePanel.open()` 强制要求用户手势** | SW 中直接调用 → `may only be called in response to a user gesture.` | 宿主**不能**自行打开侧栏。任何「出错了、把面板叫出来」的恢复流程都不成立，必须靠用户动作 |
| **`_execute_action` 键盘命令无法经 CDP 注入触发** | 命令已注册（`⇧⌘Y`），但 `Input.dispatchKeyEvent` 后 `action.onClicked` 无记录 | **点击图标这条路无法进 e2e**。任务 3 的验收必须承认存在一段人工验证，不能假装它被自动化覆盖了 |

**Q1 的答案是「不授予」**（2026-08-07 人工点击实测，品牌版 Chrome，github.com）：

```
url:            "https://github.com/"      ← 来自 "tabs" 权限，不是 activeTab
executeScript:  THREW: Cannot access contents of url "https://github.com/"
grantedOrigins: []
```

**`openPanelOnActionClick: true` 之下，点击工具栏图标不授予 `activeTab`。** 方案 §2.3 里「点图标 → 拿到 activeTab → 可读 url → 可注入」这条路径不成立。

> 这个结论极易误判：侧栏确实开了、url 确实读得到，只有注入是失败的。探针把 `url 可读` 与 `executeScript 可注入` 拆成两行显示，才没有把「`tabs` 权限给的 url」当成「activeTab 给的授权」。

同一次实测还拿到一条**通用性更强的约束**：

> **需要「当前用户手势」的扩展 API，调用前不能有任何 `await`。**

探针的 `action.onClicked` 监听器里，`sidePanel.open()` 前面有三个 `await`（记日志、读模式、跑探测），手势令牌到那时已过期，`open()` 抛错、侧栏再也打不开。这与 LangGraph 的 `interrupt()` 必须是节点第一条语句是**同一个失效模式**：凡是读「当前执行上下文」的 API，都必须先于一切 await。任务 3 里 `permissions.request()` 与 `sidePanel.open()` 都属于这一类。

**Q2 的答案是「授予」**：`action.onClicked` 触发后 `grantedOrigins: []` 之下 `executeScript` 成功，`activeTab` 单独也能读到 `tab.url`，但导航即失效。侧栏内 `permissions.request` 可用、弹真实对话框、授予可撤销的长期权限。

**但这条链最终没有被采用。** 决策依据是对本机 27 个已装扩展的审计：22 个是安装即全站访问，21 个用静态 `content_scripts`——「不需要授权」是错觉，同意书签在安装那一秒。权衡后选择同样的模型，成本从 2–2.5 人日降到 0.5，代价是安装时一条最重警告，以及**保证从平台强制降级为代码自律**（由两条新增架构护栏承担）。完整裁决见方案 §2.3。

---

## 4.5 消歧修复后的真实站点实测（2026-08-07，任务 7 之后）

`npm run measure`，五个真实页面，与修复前记录的基线对比：

| 站点 | 控件 | 歧义率 | 有 path | 耗时 | degraded |
|---|---|---|---|---|---|
| github-repo | 150 | 0%（= 原 0%） | 90% | 18.7ms（原 13） | false |
| github-issues | 145 | **1.4%（原 11%）** | 93.1% | 24.8ms（原 15） | false |
| mdn-element | 97 | 2.1%（原 3.1%） | 38.1% | **336.8ms** | **true** |
| stripe-api | 108 | **0%（原 18.5%）** | 47.2% | 28.9ms（原 32） | false |
| grafana-play | 28 | 7.1%（原 6.3%） | **0%** | 5.9ms | false |

三条结论：

1. **`ambiguity@budget ≤ 5%` 的门槛，五站里四站已达标。** 修复前 stripe 18.5%、github-issues 11%，都是硬超标。
2. **grafana 的 7.1% 是页面下限，不是抽取器缺陷。** 实测该页 **0 个标题**（`h1-h6` 与 `[role=heading]` 合计为 0），4 个 landmark 里只有 1 个有名字——`path` 无从构建。这是 T8 启发式（`cursor:pointer` 二遍扫描、`<svg><title>` 兜底）该被数据触发的场景，而不是继续雕琢 `pathOf`。
3. **mdn 的 `degraded: true`** —— 250ms 看门狗真的触发了，这次抽取是残缺的，**因此 mdn 那一行的所有数字都不可信**。这是 F-12 修复后第一次测量就抓到的东西；在此之前它是无声的。修它是任务 12（F-11 性能）。

> 顺带修掉一条 flaky：「多候选时浮层处于 ambiguous 态」读状态时抢在 tracker 的 rAF 之前，读到的是上一步残留值。它一直是竞态，只是之前恰好赢了。改成轮询后连跑三次稳定。

---

## 4.6 性能调查结论（2026-08-07，任务 12）

### 快路径实测：不采用

试过「无 `aria-*` / 无特殊后代时直接用 `textContent`」的快路径，同时跑两条路量分歧：

| 站点 | 快路径覆盖 | 分歧率 |
|---|---|---|
| mdn | 34.2% | 0.14%（1/702） |
| github | 32.6% | 2.60%（2/77） |
| stripe | 68.2% | 0.86%（2/232） |

分歧样例：

```
a:      fast="TypeScript99.9%"  slow="TypeScript 99.9%"   ← 缺分隔符（F-12 同一类，可修）
button: fast="JavaScriptJS"     slow="JavaScript"          ← 混入 CSS 隐藏文本（不可修）
```

第二类修不了——判断 `display:none` 需要 `getComputedStyle`，而那正是要省掉的开销。

**不采用的理由**：MDN 覆盖率仅 34%，最多省 100ms（341 → 240），而名字算错会直接导致 **L-4「唯一但错误」——方案里唯一的硬零门槛**。用一个硬零门槛的风险换一个非目标页面 30% 的耗时，不划算。

### 实际改了什么

1. **`degraded` 从「慢」改为「不完整」。** 原实现是 `total > 250ms`，而看门狗只装在 `walk` 里。MDN 的 walk 只花 16ms、表是**完整**的，却被标成 degraded；反过来，一个真被截断的快页面和它长得一模一样。**一个既表示「慢」又表示「残缺」的标志，两件事都说不清。** 慢由 `stats.ms` 如实报告。
2. **给命名循环加了预算。** 它原本**一点预算都没有**——看门狗只守 walk，病态页面可以在这里无限阻塞主线程。现在总预算 1500ms（刻意放宽：只有病态页面会碰到），触发即 `degraded: true`。
3. **`stats.ms.name` 变成常驻指标**，任务 13 的棘轮基线要用它。

### 目标页面上根本没有性能问题

| 站点 | total | 是否目标场景 |
|---|---|---|
| grafana-play | 5.3ms | ✅ 控制台 |
| github-repo | 22.6ms | ✅ |
| stripe-api | 44.1ms | ✅ |
| **mdn-element** | **341ms** | ❌ 2000 链接的文档页 |

**留作已知上限，由数据触发再处理**（与 T8 启发式同一条纪律）：如果任务 13 的评测语料里出现目标类页面撞上这个数量级，再回来做惰性命名——那需要把 `bindStep` 改成先按 role 过滤再按需算名字，是对全代码库测试覆盖最好的那部分做大改，现在没有数据支持这么做。

> 顺带记录：任务 7 之后 github 13→22.6ms、stripe 32→44.1ms。代价来自多产出的 `div[role=heading]` 节点、`rowLabelOf` 的 TreeWalker 与 `parentAcross`。仍远在护栏内，如实记下以便棘轮。

---

## 4.7 评测闭环首跑结果（2026-08-07，任务 13）

```
recall@budget      100%   ≥95%   ✅      L-1 唯一且正确   100%   ≥90%   ✅
ambiguity@budget     0%   ≤5%    ✅      L-2 多候选         0%   ≤8%    ✅
target_ambiguity     0%   ≤3%    ✅      L-3 无命中         0%   ≤2%    ✅
top1_ceiling       100%   ≥92%   ✅      L-4 唯一但错误     0%   =0%    ✅
emptyName            0%   ≤10%   ✅      baseline top-1（词法）  80%（无门槛）
```

### 真值必须是几何的

每个 fixture 用 `data-eval="<id>"` 标出目标；采集时读它的**实际 rect**，再让渲染器解析标注的 descriptor，比对两个 rect。**抽取器无法靠「和自己保持一致」通过**——那正是一个度量工具最不能有的失效模式。

### 首跑抓到的两个真实产品缺口

**一、`<div tabindex="0">` 被抽出来然后扔掉。** `isInteractive` 认可它(tabindex 兜底)，于是 `extract` 付钱抽了；但它的 role 是 `generic`，不在 `PRIMARY_INTERACTIVE_ROLES` 里，`project` 又把它丢掉。**整个 div-button 家族被抽取、被丢弃、永远无法被引导到。** 修法：`UINode.focusable` 标记，投影时一并视为目标。

**二、`role=generic` 的可聚焦元素名字为空。** `computeAccessibleName` 返回空是**符合规范的**——generic 不支持 name-from-content。但对我们没用：用户看见「Publish draft」几个字，就会照着问。既然我们**就是因为它可聚焦才抽它的**，它的标签就是它的文字。该判断留在 `extract.ts` 而不是 `resolveName`，让后者保持规范忠实。

**三、名字截断从尾部砍，砍掉的正是区分信息。** 语料里两个按钮前 80 字符完全相同，尾部截断把它们变成同一个字符串——**我们自己制造的歧义**。长名字是 ARN、路径、URL、策略名，区分点几乎总在尾部。改成中间截断（保留首尾）。

### 一条方法论纪律

`ambiguity@budget` 第一次跑出 9.4%，全部来自 `dup-unresolvable`——一个我**专门写来无法区分**的 fixture。把标定于真实页面的页面级门槛套在刻意对抗的语料上是**范畴错误**。

处理方式不是豁免，是**换一种断言**：该 fixture 标记 `adversarial`，不计入页面级歧义率，但必须断言「每个不可区分项都分到了稳定的 `nth`」——那正是 `nth` 存在的理由。页面级歧义率的正式门槛跑在真实站点语料上（`npm run measure`）。

### 采集/打分分离

`capture.mjs`（浏览器，产出 `captured/*.json`）与 `score.mjs`（纯 Node）分开，因为 `project()` 是纯函数。**第二步把 `scoreNodes` 换成 `await resolve()`，`score.mjs` 一行不改就产出真实 top-1。**

---

## 5. Todolist

依赖关系严格，标 ⛔ 的是阻塞第二步。

| # | 任务 | 依赖 | 人日 | ⛔ | 完成后什么能跑起来 |
|---|---|---|---|:--:|---|
| ~~**1**~~ | ✅ **已完成** — 修 F-1/F-2/F-3：`apply()` 改为从 `visible` 复述期望状态（而非把 `display:block` 写死进 `LOCK`）；observer 加观察 `documentElement` 的 childList，`destroy()` 先 `disconnect`；S-03 移到渲染入口最前并覆盖 `ref + alsoRefs` 全体，被拒 plan 不采纳 | — | 实际 0.4 | ✅ | 「清除高亮」真的清除；页面删掉宿主后自愈；`alsoRefs` 指向密码框被拒。**e2e 26→30 项**，新增 11 条断言含对抗性围攻 |
| **2** | **权限 spike**（§4） | — | 0.5 | ⛔ | 一份写进方案的确定答案 |
| ~~**3**~~ | ✅ **已完成（2026-08-07，形态已变）** — 权限模型定稿为「安装时收」：静态 `content_scripts` + 显式 `host_permissions: ['<all_urls>']`，删掉 `activeTab` / `optional_host_permissions`；e2e 首项断言产出 manifest 与声明逐字一致；架构测试加两条硬护栏（禁一切操作页面 API、指令集封闭无执行动词，均已反向验证会红）；修复静态注册引入的双实例竞态 | 2 | 实际 0.5 | ✅ | 原计划的授权屏 / `permissions.request` / 三态注入**整体不做了**——见方案 §2.3 的裁决与 27 个已装扩展的审计 |
| ~~**4**~~ | ✅ **已完成** — `HighlightPlan{steps[],cursor}` → `HighlightCommand{step, progress}`，`advance()` 已删除，游标归侧栏（第二步平移进 checkpoint，content script 不动）；`HighlightAck` 加 `resolved`/`candidates`，渲染失败收成单通道；`StepAction`→`expectedUserAction`；`GuideStep.ref` 变可选（三种绑定结果三种形状）；`RPC_TYPES` 白名单 + 编译期一致性证明；`SessionId` 品牌类型由 tabId 派生；`SESSION_ENDED` 加 `'completed'`；`onEvent` 回传 tabId | 3 | 实际 0.6 | ✅ | **关掉侧栏引导可以继续**（游标不在浮层里了）；多候选真的全部框出而不是报错退出；**协议自此冻结** |
| ~~**5**~~ | ✅ **已完成** — `project()` 拆成 `describeAll()`（全集算 path/nth，与视口无关）+ `project()`（只做选择，不碰身份）；新增 3 条单测，其中 2 条已反向验证会红；补一条架构护栏禁止 `project.ts` 读取任何实时视口状态 | 4 | 实际 0.3 | ✅ | 同一元素的 descriptor 在任意滚动位置可复现，有单测断言 |
| **6** | **vitest browser project**：6 个 DOM spec（visibility / walk / semantics / overlay-geometry / tracker / mask-multihole）。`@vitest/browser` 和 `playwright` **已装但零使用**（违反 AGENTS.md 第 6 条） | — | 1.5–2 | ⛔ | 洞与 rect 误差 ≤1px、tracker 20 帧后停止排帧，都有断言而非肉眼 |
| ~~**7**~~ | ✅ **已完成** — `pathOf` 改用文档序最近前驱标题（landmark 作用域按**包含**而非相等）；heading 按 role 判定；祖先与行标识穿 shadow 边界；rowLabel 文本加分隔符；`degraded` 进 `PromptTable` | 6 | 实际 0.7 | ✅ | **stripe 歧义率 18.5% → 0%，github-issues 11% → 1.4%**。真实站点实测见下 |
| ~~**8**~~ | ✅ **已完成（形态已变）** — 绑定下沉到 content script：`api.ts` 的整流程预绑定整段删除，引导包只产出 descriptor；渲染器在**展示那一刻**按 descriptor 绑定，搜索范围是**全集**而非投影表；顺带修掉 F-6、F-7，以及一个只有在浮层已显示时才会出现的致命 bug | 4 | 实际 0.8 | ✅ | **多步引导能走过第 2 步**；「重试定位」真的能找回；视口外的目标能绑上；`ResolveResult.ambiguous` 删除（歧义只有渲染时可知） |
| ~~**9**~~ | ✅ **已完成** — `resolve(): Promise<ResolveResult>` → `AgentHost.start/resume/abort` 返回 `AsyncIterable<AgentEvent>`；流在 `await_user` 处**结束**（这就是 `interrupt()`），恢复即开新流；线程状态归 host，`chrome.storage.session` 的 `thread:{sessionId}`；`budgetFor` 迁 `agent/budget.ts` | 8 | 实际 0.6 | ✅ | **`api.ts` 只剩一个消费者（`background.ts`）**，侧栏不再 import 任何 agent 代码；`intent` / `history` / `contextWindow` 退出跨模块契约 |
| ~~**10**~~ | ✅ **已完成** — `rankCandidates` 返回与 `bind` 同构的三态（`unique` / `ambiguous` / `none`），并列在**类型层面无法被静默解决**；2–3 个近似并列全部框出（复用多洞遮罩），>3 个改为「请说得更具体」而非失效屏 | 8 | 实际 0.3 | | K-6 的保证覆盖到 baseline / relocate；架构护栏禁止 `api.ts` 出现 `scoreNodes` 与 `)[0]` |
| ~~**11**~~ | ✅ **已完成** — 宿主（SW）持有 `{steps, cursor, url}`，镜像进 `chrome.storage.session` 按 tabId；`tabs.onUpdated` 恢复；侧栏降为纯视图（`START_GUIDE` / `END_GUIDE` + `GUIDE_STATE`）；`TARGET_LOST` 触发重绑 | 3, 8 | 实际 0.7 | ✅ | **跨页引导端到端跑通**：关掉侧栏 → 整页导航 → 自动恢复并前进到第 2 步，高亮 rect 与新页面目标逐像素一致；同 URL 刷新不算前进 |
| ~~**12**~~ | ⚠️ **已调查，计划中的优化不做** — 原诊断（「对 2127 个可见元素全算名字，project 只留 97 个，付 22 倍」）**是错的**：产出就是 2053 个节点，任务 8 之后绑定要搜全集，每个名字都真的需要。实际做了三件事：`degraded` 改为表示【不完整】而非【慢】、给命名循环加了原本完全没有的预算、命名耗时变成常驻指标 | 6, 7 | 实际 0.4 | | MDN 仍是 341ms 且 `degraded: false`（完整但慢）。详见 §4.6 |
| ~~**13**~~ | ✅ **已完成** — 20 个 Tier A fixture + 标注 schema + `capture.mjs`（浏览器）/ `score.mjs`（纯 Node）+ `npm run eval`。真值是**几何的**：读标注元素的实际 rect，与渲染器解析出来的 rect 比对，抽取器无法靠「自圆其说」通过 | 7, 12 | 实际 0.9 | ✅ | **全部门槛通过，L-4 = 0%**。第一次跑就抓到 2 个真实产品缺口（见 §4.7） |
| ~~**14**~~ | ✅ **已完成** — 页面内点选元素 → `authorDescriptor` 沿「最弱优先」阶梯升级（`name` → `scope` → `outer-scope` → `nth`）→ 产出可粘贴的引导包片段。**L-0 按约束执行**：唯一 *且* 绑回被点的那个元素，两者缺一即如实报告不安全 | 13 | 实际 0.5 | ✅ | 悬停描边（不加暗幕）、点击被吞不传给页面、产物回绑逐像素一致。8 条单测 + 6 条 e2e |
| ~~**15**~~ | ✅ **已完成** — 六条判据逐条核对，见 §8 | 13, 14 | 实际 0.2 | | **放行** |

**合计 18–22 人日 ≈ 4 周**（方案 §8 原估 T6–T9 约 1.5–2 周，低估约一倍——差额主要在权限和逐步绑定）。

**并行建议**：6（DOM 测试）与 2/3（权限）无依赖可并行；13 的 fixture 撰写是纯手写 HTML，可与 8/11 并行。

---

## 6. 明确不做

### 6.1 不要加强词法基线（最重要的一条）

用户反馈「只接受简单的按钮匹配或文本匹配」，但**加强词法排序是错误的结论**：

1. **两个消费者都不需要它更强。** M0-b 下界的价值在于**稳定和诚实**，不在于高——调强它等于在同一份语料上同时调优基线和评估对象，测量污染且不可逆，「这个任务到底值不值得上 LLM」这个问题只能问一次。而 relocate 的输入**不是自由文本 goal，是 `ElementDescriptor`**，正确算法是 `bind.ts` 的合取过滤，已经存在且比 trigram 更强也更可预期。
2. **加强词法 = 做 Agent 要替代的事**（AGENTS.md 第 2 条）。真做强需要同义词表、中文分词、动词→role 推断、指代消解——全是意图理解，第二步接上模型后一行不留地删掉。
3. **用户感受到的弱，主要不是打分器的问题**：多步引导包走不过第 2 步（F-8）、多候选没有 UI（`api.ts:96` 直接 `ranked[0]`）、`<div role="heading">` 和 shadow 内容拿不到 path（F-9/F-10）。**修完 8 + 7 + 10，感知会明显上一个台阶，而词法打分器一行没动。**

唯一该改的一处已列为任务 10：`lexical.ts` 返回排序数组、`api.ts` 盲取 `[0]`——K-6 在类型层面禁止 `bind` 做 tie-break，而 baseline 路径正在做同一件事，**且 baseline 就是第二步 relocate 的打分器，K-6 的保证会从这条路整个漏掉**。

### 6.2 其余

| 不要做 | 理由 |
|---|---|
| **T6 iframe 的 rect 合成 / `allFrames` 注入** | 跨源 iframe 的注入就是权限问题。在权限定形之前写帧中继 = 对一个还没定的模型写猜测。**但 frameId 的协议形状必须现在定**（任务 4）——形状和实现要分开 |
| **Tier B 登录态语料采集工具** | 独立子项目（getHTML 序列化 + 样式内联 + 合规脱敏），§8.5 已指派项目方，且需真人登录采集。Tier A 就能建成 harness，Tier B 到货零改动接入 |
| **10 张视觉回归基线** | 浮层马上要动三处（多候选、失效屏、权限屏），现在建基线就是建了就废 |
| **checkpoint / 时间旅行 / 会话历史存储** | LangGraph 自带。任务 11 只做「一条 tab 作用域的恢复记录」，那是 checkpoint 的**内容**不是竞争品 |
| **把浮层拆成 React 组件**（方案 §2.1 列的 `Mask.tsx`/`Spotlight.tsx`/`StepCard.tsx`） | 现在 310 行原生实现更简单，且 tracker 每帧直接 `setAttribute` 绕开 diff 正是它快的原因。**方案这条已被实现推翻，且推翻是对的——建议从方案里删掉，别留着当技术债** |
| **T8 的全部启发式**（`cursor:pointer` 二遍扫描、图标名兜底、MAIN world `attachShadow` 劫持、遮挡命中测试） | 方案 §8 说「T8 是刻意留白的」。**但入口条件是评测数字，而数字在任务 7 修完之前不可信。** 顺序是 7 → 13 → 才谈 T8 |
| **Provider / 流式 / 成本 UI / 域名黑名单 / 遥测 / 引导包导出** | §1.4 已砍，无异议 |

### 6.3 现在故意不定的

`intent` 枚举（要主动从边界上摘掉，而不是保持现状）· YAML 输出契约与 Zod schema · provider 配置结构与厂商预设 · checkpoint 序列化格式与去抖窗口 · SW `fetch` >30s 的保活策略（事件流边界使三种方案都不改契约，**这正是「现在定边界、不定策略」的典型**）· 抽取 profile 分档内容 · relocate 多信号权重 · 引导包磁盘 YAML 格式

> 判据：**边界要现在定死，策略要留白。** 上面每条的共性是「改它只影响一个文件」；第 5 节每条的共性是「改它要动 3 个进程」。

---

## 7. 需要同步修正的方案文档

| 位置 | 问题 |
|---|---|
| §4.1 `hardenHost` 伪代码 | 两个 bug（自反馈环、observer 观察对象错），实现照抄了（F-2/F-3） |
| §5.1 / K-2 | 说 `resolve()` 收 `LocatorView`，与 §3.1「全集不跨进程」自相矛盾。实现收 `PromptTable` 是对的——第二步 `resolve` 跑在 SW 里，物理上拿不到 content script 内存里的全集 |
| §2.3 | 漏了前置问题：权限做对之后 `tabs.query` 拿不到 url，而 `packsFor(url)`/`matchFlow(url,goal)` 完全建立在它之上 |
| §2.1 | overlay 的 React 组件拆分已被实现推翻，建议删除 |
| §7.4 | 把 `top1_ceiling ≥ 92%` 当放行门槛，但在 F-9/F-10 修完前该指标**系统性偏高** |
| §8 | 周期估计低估约一倍 |
| 设计文档 §4.3 | `elements: Annotation<UINode[]｜null>` 与 K-4 冲突，应为 `table: PromptTable｜null` |

---

## 7.5 真机测试暴露的四个缺陷（2026-08-07，用户实测）

放行之后用户在 github.com 与 developer.mozilla.org 上实测，抓到四个 e2e 全绿也没覆盖到的问题。

### F-13 失效屏上的按钮全是死的（P0）

**现象**：引导包第 1 步定位失败 → 失效屏正常弹出 → 点「跳过此步」「结束引导」**毫无反应**。

**根因**：`content.ts` 的 `if (res.data.failure) current = previous;`。这行是任务 1 为 S-03 加的——「被拒绝的 plan 不得被采纳」。但**失效屏是被画出来的**：它此刻是用户唯一能操作的东西。回滚 `current` 之后，浮层上显示着一步，而 content script 不记得它是哪一步，于是 `report()` 直接 return，三个按钮全部沉默。

**修法**：判据从「是否失败」改为**「是否画了东西」**。`render()` 返回 `{ res, painted }`；只有**没画任何东西**的拒绝才不留痕迹。

> 这是一条通用教训：「失败」和「没有呈现」是两件事，而把它们当成一件事，正好会在用户最需要出口的时刻把出口关掉。

### F-14 面板显示「第 1 / 0 步」

`background.ts` 的 `error` 分支把 `index/total` 写死成 `0/0`，因为 `AgentEvent.error` 不带进度。改为由 host 在 `error` 事件里带上 `thread.cursor` 与 `steps.length`——进度是 agent 自己的状态，它知道。

### F-15 视口带在预算还有富余时就丢信息（P0）

**现象**：MDN 首页问「开发文档」→「在当前页面上没有找到与描述匹配的控件」；滚到页脚再问 → 找到了。

**根因**：`project()` 先按 ±1 屏硬过滤，再按 `maxNodes` 剪枝。**两套预算机制，而前一套更粗**——fixture 上 21 个控件、预算 150，却仍然丢掉了 1400px 外的按钮。用户的抱怨「它只能指向当前的画面」精确地描述了这个行为。

**修法两条：**
1. **视口带不再做过滤，只做打分**（视口内 4 / 带内 2 / 带外 1）。预算是唯一需要裁剪的东西，远近只决定谁先被裁。
2. **本地词法匹配拿全页**（`LOCAL_BUDGET`）。token 预算约束的是发给模型的东西，而本地匹配什么都不发。

实测效果（MDN 首页，页面顶部）：

```
「开发文档」   → 找到，自动滚到 y=2193 并高亮   （原：没有找到）
「学习 Web 开发」→ 找到，自动滚到 y=2253
「MDN 社区」   → 找到，自动滚到 y=2253
```

真实站点投影表容量随之上升：mdn `有 path` 38.1% → 60%，github-issues / stripe 均由 111–143 项升到 150（预算上限）。

### F-16 失效屏不说它在找什么

「找不到这一步的目标」没有宾语，而最可能在读这句话的人正是写 descriptor 的作者。现在附一行 `找的是：button｜Open user account menu（在「X」内）`。

### F-17 用户照做了，引导一动不动（P0）

**现象**：卡片说「点右上角头像」，用户点了，菜单展开了，引导原地不动；而且菜单里已经出现的下一步目标也不会被指出来。

**根因**：引导**只对「用户点我们的按钮」有反应，完全不看页面**。两个缺口：

1. 没有观察目标被激活。§2.3 U-03 写的是「不自动跳步」，但那条规则是为了**没有证据时别乱跳**；用户点了我们指的那个元素，正是最直接的证据。加一个被动的 capture 监听（`passive`，永不 `preventDefault`）——**监听是读，不是写**，「只指路，不开车」一行没变。
2. 失效屏是静态的。目标出现了也不会重试。

### F-18 失效屏的重试不能只靠 DOM 变化

第一版监视器只在 `MutationObserver` 触发时重试。听起来够用，实际不够：**刚加载完的静态页面根本不产生任何变化**。宿主在页面差几毫秒就绪时渲染了一次，拿到 `ref_not_found`，然后再也没人重试——跨页引导因此**稳定失败**，而不是偶发。它唯一一次「通过」是我插桩时恰好多加了一毫秒延迟。

改成**退避重试（250/500/900/1500/2500/4000/6000ms）+ 变化加速**。变化只把下一次尝试提前，不额外增加次数，所以频繁重绘的页面也不会让我们无限抽取。

### F-19 `render()` 无重入保护（P0，早就记下却一直没修）

`before-step2.md` §1.4 记过这条，一直没做。它在跨页场景下是致命的：

```
A: previous=null, current=A, 开始 await scrollToTarget（最长 800ms）
B:               current=B, 开始 await
A 醒来: painted=false → current = previous = null   ← 抹掉了 B 的赋值
B 醒来: current(null) !== B → 也判失败
```

导航后宿主**按设计**会连发两条 HIGHLIGHT（用户确认的那一步 + 同一步在新页面上的重放），两条被这个竞态互相吃掉，引导恰好死在它存在的意义所在的那个转换点上。

修法一行：`if (!painted && current === mine) current = previous;`——旧的渲染不得覆盖新的命令。

### F-20 点击导航会被重复计一次进度

点链接同时触发「激活」和「导航」，两者都被当成进展，两步引导在第 2 步显示之前就结束了。导航是那次点击的**后果**，不是新证据：thread 加 `justConfirmed`，紧随其后的导航降级为「在新页面上重放当前步」。

### 一条 fixture 缺陷（连带发现）

`far-below` 按钮是 `.tall` 的**第一个**子元素，实际落在 ~1200px，一直在 ±1 屏带内——**「视口带剪枝」那条 e2e 从来没测到过视口外**（断言本身还写成了 `=== false || true`，恒真）。已改为 3000px 空 div + 其后的按钮，并把断言改成有意义的反向命题。

---

## 7.6 进 Agent 之前补的两件事（2026-08-07）

### S-06 域名黑名单 —— 实现后按用户决定移除

先按方案实现了三层（manifest `exclude_matches` + 宿主判断 + 侧栏提示 + 逐 origin 显式开启），随后**用户明确要求不预设禁用任何站点，已完整移除**。

这是产品判断，不是遗漏，理由是站得住的：一份由我们curate 的域名清单**天然不完整、且有地域偏见**，不存在「银行」的枚举；而它给用户的印象却是「已经防住了」。**一个夸大自己的安全功能比没有更糟。**

**移除的只是域名层，字段层原封不动**：S-03 仍然在渲染入口拒绝一切凭据 / 支付 / 2FA 字段（含 `alsoRefs`），S-05 仍然禁止读取输入框 `value`，两者都由架构测试守着，并且在**所有**站点生效——包括任何清单都不会想到列出的那些。

> 实现过程中撞出的一个矛盾值得留档：第一版在 content script 里也加了闸，但那个闸只能读编译期常量，**看不到用户的开启决定**（决定在 storage 里，而 content script 被密钥隔离禁止读 storage），结果开启功能直接失效。**看不见决定的闸不是纵深防御，是一个有时会答错的第二答案。**

### BYOK 密钥配置（P-01 / P-02 / P-03 / P-05 / P-10）

9 个厂商预设（含 Ollama / LM Studio 本地端点），全部走同一条 OpenAI 兼容路径。

**P-10「本地加密存储，永不出扩展」的诚实版本**：

- **用 `storage.local`，绝不用 `storage.sync`** —— sync 会把密钥复制到 Google 的服务器上。这是整个文件里最重要的一行，架构测试直接断言 `settings.ts` 不出现 `storage.sync`。
- **不做本地加密。** 扩展能自行解密的密钥，等于任何拿到该 profile 的人都能解密。写「已加密」只会骗走读者的信任，买不到任何东西。
- **真正起作用的**：扩展存储网页够不到；**content script 完全不碰 storage**（架构测试断言）；密钥只发往用户自己填的端点（架构测试断言只有 `agent/provider.ts` 能发网络请求）。

**P-03 连接测试先于 agent 落地**，因为 §1.5 把阶段一押在「安装 → 完成 Key 配置 ≥ 35%」上。一个只存不验的表单，会把「Key 填错了」变成十分钟后引导中途的一次失败，看起来像产品坏了。本地端点的 CORS 问题被单独识别并给出具体指引——否则那两个预设的成功率接近零，而浏览器把 CORS 报成普通网络错误，用户会往错误的方向找。

### F-21 `crypto.randomUUID()` 让所有 http:// 站点上的抽取直接崩溃（P0）

补黑名单时顺带撞出来的。

```
TypeError: crypto.randomUUID is not a function
```

它**只在安全上下文可用**。`localhost` 与 `127.0.0.1` **算**安全上下文——所以 20 个 fixture、5 个真实站点、88 项 e2e 全部免疫，而**任何普通域名上的 http:// 页面都会在抽取的最后一行抛异常**。

方案 §1.4 把阶段二押在「企业内部运营团队」，§1.5 要求「引导目标 URL 中 SaaS / 内部系统占比 > 50%」——**内网控制台大量跑在 http:// 上，正是唯一会踩到这个坑的那类页面，也正是目标用户**。

改用「时间戳 + 随机盐 + 自增序号」：snapshotId 只需在本文档生命周期内唯一，它是代际守卫，不是秘密。并加架构护栏：抽取/浮层/content script 一律不得使用 `crypto.randomUUID` / `crypto.subtle` / `navigator.clipboard` / `navigator.locks`。

e2e 增加 `plain.test` 映射（普通域名 + http），先断言 `isSecureContext === false`，再断言抽取正常——**否则这条测试会像之前 88 项一样，在一个碰不到问题的环境里空过**。

---

## 8. 放行第二步的判据

全部满足才开工。**逐条核对结果（2026-08-07）：**

| # | 判据 | 结果 |
|---|---|---|
| 1 | 任务 1–9、11、13、14 完成（⛔ 项全绿） | ✅ 全部完成。任务 6 按用户决定跳过（风险已记录），任务 12 调查后判定不做（原诊断错误，见 §4.6） |
| 2 | `npm run verify` 全绿，且新增 F-1/F-2/F-3 断言 | ✅ **70/70**（原 19 项）。**判据文字本身要更正**：它写的是「零主机权限」，而权限模型在任务 3 定为「安装时收 `<all_urls>` + 静态注入」——依据是对 27 个已装扩展的审计，见 §2.3 |
| 3 | 一个跨页两步以上的 demo 包，从第 1 步走到完成，中途无失效屏 | ✅ 关掉侧栏 → 点链接 → 整页导航 → 自动恢复并前进到第 2 步，**高亮 rect 与新页面目标逐像素一致**；同 URL 刷新不算前进 |
| 4 | `npm run eval` 四项指标达标（F-9/F-10 修完之后的数字） | ✅ `recall@budget 100%`、`ambiguity@budget 0%`、`target_ambiguity 0%`、`top1_ceiling 100%`，且 **`L-4 = 0%`** |
| 5 | 检视器强制 L-0 = 100% | ✅ 且**加严了**：唯一 *且* 绑回被点的那个元素，缺一即报 `correct: false`。只数命中个数正是 L-4 被认证为安全的方式 |
| 6 | `agent/api.ts` 是 `AgentHost` 形状，`App.tsx` 用 `for await` 消费 | ⚠️ 前半 ✅；后半**有意偏离**：消费者是宿主不是侧栏。侧栏随时可能被关，而生成器中断没有恢复点。宿主消费后广播，侧栏保持纯视图 |

### 裁决：**放行**

六条中五条完全满足；#6 后半是有充分理由的有意偏离；#2 的判据文字被后续实测推翻并已更正。

### 交付状态

```
单测 55  ·  e2e 70（连跑 3 次稳定）  ·  eval 20 fixture 全部门槛通过
源码 3608 行  ·  构建产物 264 KB
manifest：permissions=[scripting, sidePanel, storage]，host_permissions=[<all_urls>]
```

真实站点（`npm run measure`，对比修复前基线）：

| 站点 | 歧义率 | 有 path | 耗时 |
|---|---|---|---|
| github-repo | 0%（= 0%） | 89.3% | 22.8ms |
| github-issues | **1.4%（原 11%）** | 93% | 25.3ms |
| mdn-element | 2.1%（原 3.1%） | 38.1% | 339ms（已知上限，§4.6） |
| stripe-api | **0%（原 18.5%）** | 46.8% | 25.7ms |
| grafana-play | 7.1%（原 6.3%） | 0% | 5.5ms（该页 0 个标题，是页面下限） |

### 进入第二步前应当知道的三件事

按 §6 的纪律，这些是**数据触发**的，现在数据有了：

1. **T8 启发式的入口条件已满足。** grafana 的 7.1% 与 `path` 覆盖率 0% 是页面本身不提供结构信号，不是抽取器缺陷——继续雕 `pathOf` 对它没有任何用。`cursor:pointer` 二遍扫描与 `<svg><title>` 兜底现在有了判断依据。
2. **MDN 量级页面（2000+ 链接）耗时 339ms，目标类页面全部在 26ms 内。** 若第二步的语料里出现目标类页面撞上这个量级，再做惰性命名——那需要把 `bindStep` 改成先按 role 过滤再按需算名字，是对测试覆盖最好的那部分做大改。
3. **「content script 只有一个指挥者」只完成了一半。** 侧栏的「抽取本页元素」仍直连 content script。任务 8 之后已无危害（步骤按 descriptor 重绑，不依赖调用方的 snapshotId），但直连本身还在。

### 人日对账

| 任务 | 原估 | 实际 |
|---|---|---|
| 1 修 F-1/F-2/F-3 | 0.5–1 | 0.4 |
| 2 权限 spike | 0.5 | 0.5 |
| 3 权限子系统 | 2–2.5 | 0.5（形态变了） |
| 4 协议冻结 | 1.5 | 0.6 |
| 5 nth 稳定化 | 0.5 | 0.3 |
| 6 DOM 层单测 | 1.5–2 | —（跳过） |
| 7 消歧修复 | 1.5 | 0.7 |
| 8 惰性重绑 | 1.5 | 0.8 |
| 9 AgentHost | 1.5 | 0.6 |
| 10 多候选 UI | 0.5 | 0.3 |
| 11 跨页恢复 | 2 | 0.7 |
| 12 性能修复 | 1 | 0.4（调查后不做） |
| 13 评测闭环 | 2–2.5 | 0.9 |
| 14 检视器 | 1.5 | 0.5 |
| 15 放行判断 | 0.5 | 0.2 |
| **合计** | **18–22** | **7.4** |

差额主要来自三处：权限模型换了形态后成本降一个数量级；任务 8 让任务 11 几乎免费；任务 12 调查后判定不做。

**估算偏高不值得庆祝**——它说明清单写作时没看出「哪些条目其实是同一个问题的不同侧面」。所有权、`AgentHost` 签名、跨页恢复被列成三项 5 人日，实际是一件事 2.1 人日；而它们能合并，正是因为任务 4 先把协议收口了。
