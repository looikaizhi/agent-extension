# 01 — transport：唯一发请求的地方

**What to build:**

把「怎么把一个请求送出去、怎么把响应收回来」从「说哪种线格式」里剥出来，成为一个独立的 `transport`。

它负责、而且只负责这些：

- 三个钟：连接 15 秒、停滞 30 秒、总计 120 秒
- 响应体 2MB 上限
- abort / 取消
- **字节 → 行**：UTF-8 跨块解码、CRLF、行跨块切断、末行无换行、丢掉 SSE 的 `:` 注释行
- 两种模式：**流式**（产出行）与**非流式**（一次读完，同样的钟与上限）

它**不认识任何协议的请求体与响应体**。路径由调用方给，鉴权头由它按调用方声明的方式贴。

`complete()` 这一票**签名不变、行为不变**，它仍然认识 OpenAI Chat Completions，只是不再自己 `fetch`。这是「make the change easy」那一步，本票不改变任何用户可见的行为。

**同时要当场解决 `testConnection` 的 fetch 归属**：它今天有一次自己的裸 `fetch`（取模型列表）。抽出 `transport` 之后如果放着不管，fetch 点会变成三个，而本票宣称的是「收紧」。让它走 `transport` 的非流式模式——这正是非流式模式存在的理由。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-24（提交留给用户）

- [x] 全仓只剩两个发起网络请求的地方：`transport` 与文档抓取执行器；架构守卫按这个改写并绿
- [x] `testConnection` 不再自己 `fetch`，走 `transport` 的非流式模式
- [x] 三个钟、2MB 上限、abort 的行为与改动前完全一致，原有用例不改结论即通过
- [x] 字节边界那批 fixture（CRLF、行跨块切断、UTF-8 切在字符中间、末行无换行、心跳注释行、超限）迁到 `transport` 这一侧，仍然逐条绿
- [x] `complete()` 的签名与它发出去的字节完全未变——模型输入快照逐字节不变
- [x] 流式测试文件一分为二：钟归 `transport`，解析仍归 `complete()`，两边各自只测一件事
- [x] 类型检查、单测、e2e 全绿（1036 单测 / 284 e2e）；抽取器评测两条门槛未达（L-1 0%、L-3 100%）——**先于本票就已如此**：该评测只加载 `core/extractor`、`core/descriptor/bind.ts`、`core/locator/lexical.ts`，本票一个字都没动
