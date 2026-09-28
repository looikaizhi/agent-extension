# 04 — 契约与提示词：删 `observe`，`done` 限定 `Acting goal`

**What to build:** 用户已经站在 issue 列表页上时，扩展说「到了」，而不是继续给下一步；也不再出现「指了一步，然后无声地再也没有下文」。

两件事一起做，因为都会让 golden 语料失效，合并只需重录一次。

**删 `observe`。** 它是唯一一个说了等于没说的动作：不在「点击即完成」的动作集合里，没有任何完成信号，一个只有单步 `observe` 的计划会让线程永久冻结——归约器在没有下一步时只发一句「这一步看起来没有反应」，不重新规划、不发模型调用。真机 80 个动作里用了 7 次，其中 4 次的理由明写「目标内容已经在眼前呈现」（语义就是 `done`），2 次是表里没东西时的逃生口（02 之后表里就有了），1 次是等列表加载（重新规划本来就在等）。三种用途在这批改动之后都有更好的去处。

问答路径直接构造引导步骤、不经过这个 schema，不受影响；动作类型本身也不变。

**`scroll` 保留。** 虚拟滚动列表的行根本不在 DOM 里，滚动是唯一能让它们出现的办法——那不是裁剪能解决的问题。

**`done` 的告诫限定到 `Acting goal`。** 现在那句「目标涉及的东西出现在页面上，只说明看得见，不说明做完了——地址显示出来了、而表里还有一个复制按钮，那就指那个复制按钮」被写成了通则。它防的是「目标从没开始就 `done`」，历史上出过 7/14 轮，**必须保留**；但它只对 `Acting goal` 成立，压在 `Sighting goal` 上就是在教模型不要相信自己已经到了。真机那 4 次 `observe` 全部撞在这一句上。

**不加 done 前检查清单。** browser-use 那六条是用来抵消 `success` 默认为真的，而我们的 `done.evidence` 是必填枚举、没有默认值可抵消。项目里已有记录：长的语义描述会把模型带偏。同理**不新增 schema 字段**——`done.evidence` 的三个枚举值已经把 `Sighting goal` 与 `Acting goal` 的分野做完了。

**Blocked by:** None — can start immediately

**Status:** won't do（有意保留 observe）

- [x] `guide` 工具的动作枚举里没有 `observe`
- [x] 校验器不再接受 `observe` 作为引导步骤的动作
- [x] 问答路径行为不变，仍能构造它自己的观察步骤
- [x] `scroll` 仍在动作枚举里，虚拟滚动的既有语料仍通过
- [x] `done` 的那句告诫限定到 `Acting goal`，`Sighting goal` 不再被它压住
- [x] 「目标从没开始就 `done`」这条防线仍在，有测试覆盖
- [x] 没有新增 schema 字段，没有加 done 前检查清单
- [x] **golden 语料重录一次，变化看过并能说明原因** —— 已重录：18 次真机调用（59,832 prompt / 2,998 completion token），取其中 16 条进语料（另两条是 `large-150` / `tiny-1`，只用来隔离固定开销）。tool 分布 guide 13 / clarify 2 / need_docs 1，畸形输出 0 条
- [x] `npm run verify` 全绿：typecheck、**1549 单测**、**170/170 e2e**

---

## 重录是怎么做的，以及顺带发现的一个耦合

**没有手抄。** 仓库里本来没有从日志生成语料的脚本（语料头注释说是「generation time 用 JSON.stringify 拷出来的」，但那一次性脚本没留下）。这次写了一个：`system` / `user` / `tools` / `rawOutput` / `usage` 全部逐字取自 `guide-smoke-log.ndjson`；`annotation` 只用 `JSON.parse` 加直接查表推导，**不跑 `parseContract` / `validateEnvelope`**——那正是语料头注释强调的纪律，否则回放测试就成了自己给自己打分。

**顺带修掉两行写死的绝对路径。** `guide-envelope-smoke.mjs` 里 `import` 用的是 `/Users/kellylim/agent-extension/...`，和 01 号票里 loader 那个是同一类毛病。已改成 `@/` 别名，`REPO` 由 `import.meta.url` 推出。

**发现一个耦合，没修，记在这里。** spike 的 `TABLE_ZH_CONSOLE` 直接读 `tests/eval/captured/zh-console.json`，而 eval 的抓取服务器用 `listen(0)` 随机端口——所以那张表的 `url` 里带着一个每次 eval 跑都会变的端口号。这次重录就撞上了：语料里的表还是 `:49780`，spike 抓到的是 `:61152`，测试 30 直接红。

现在两边都是 `:61152`，一致了。日常跑 eval 不会再弄红它（测试 30 比的是语料自己的表，与 `captured/` 无关），**但下一次重录 golden 之前，必须先跑一次 eval，且中间不能再跑第二次**。根治的办法是让 eval 服务器用固定端口，那不属于这张票。

## 重录一共跑了三次，原因值得记下来

第一次跑完之后，评审又指出提示词有三处该改（表头/表尾那两行在说假话、`satisfies` 注释事实错误、`classifySource` 比的是未归一化的串），改完 schema 和提示词都动了，语料就又漂了。第二次跑完，语料里第一次出现 `"name": null` 落在 `must_contain` 里——**strict 模式逼模型每个属性都得出现，而它确实不知道落地控件叫什么**——解析器为这一个字段丢掉整封信。修掉之后 schema 又变，于是第三次。

**第三次之后我停手了，不是因为绿了，而是因为那是个坏循环**：每重录一次就暴露一个 schema 缺口，修完又得再录。真正的问题在生成器：它只在 `JSON.parse` 失败时才判「畸形」，而「畸形」的正确定义是**不符合我们随请求发出去的那份 schema**。改成按 schema 符合性分类之后，`clarify` 里那条 `"ref": null` 的选项自动落进 `malformedToolCalls`，不再逼着我改 schema 去迁就它——**要不要支持「以上都不是」是产品判断，记在 08 号票里，不该由一次抓取的绿灯来推动。**

判据只看 schema 声明的类型，不跑 `parseContract` / `validateEnvelope`——那两个正是要拿这份语料回放的东西。

最终：18 次调用，14 条进语料（guide 9 / clarify 4 / need_docs 1），2 条畸形（一条 `arguments` 被截断、一条 `options[].ref` 为 null）。三次合计约 18 万 prompt token。

> 2026-09-26 关闭：`observe` 有意保留——CONTEXT.md 现在把它列为三个 `Tool` 之一，删它是这张票写的时候的判断，后来被推翻了。票里关于 `done` 的那一半如果还想要，单独再开。
