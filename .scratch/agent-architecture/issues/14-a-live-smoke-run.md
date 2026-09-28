# 14 — 真机冒烟

**What to build:**

目标结构落地后，用现有的真机 harness 在 github.com 上跑一轮：7 个目标各 1 遍。只证明产品正门在真实网站上照常启动、引导照常走、问答照常答，不和任何一轮比到达率。

**Blocked by:** 13 — 纯搬家到目标目录

**Status:** done（票头 2026-09-26 补正）

- [x] 每一轮都发出了模型调用、浮层出现过、线程在终态被删并且记录落盘
- [x] 解析失败率、校验失败率不高于第七轮
- [x] 没有新增的崩溃或超时
- [x] 生成一份报告页，页上写明这是冒烟、不是版本比较

**实现记录**
- **怎么跑的**：先 `npx wxt build`，再用现有 harness：`PG_REPEATS=1 PG_SHOTS=tests/spike/live-github-shots.smoke-a node --experimental-strip-types --import ./tests/alias-loader-register.mjs tests/spike/live-github-run.mjs`。7 个目标各 1 遍，真实 DeepSeek，github.com 已登录，Skill 开（默认）。
  - 截图和录像写到新目录 `live-github-shots.smoke-a/`，因为 harness 启动时会清空默认的截图目录，第七轮的截图还在里面。
  - 日志另存为 `tests/spike/live-github-run-log.smoke-a.ndjson`。默认日志文件被这一轮覆盖了，开跑前已核对它与 `.run7.ndjson` 逐字节相同，第七轮的数据没有丢。
  - 没有改任何产品代码或 harness。
- **每一趟都发出了模型调用、浮层出现过、线程在终态被删并且记录落盘**：7/7 发出了调用，7/7 浮层出现过。
  - 跑完后重新打开这一轮的浏览器配置，从扩展存储里读出 7 条 Run record，每条都记下 `plugins: ["skill"]`；残留的线程、在途效果、Plugin 组合的键为 0。
  - 6 趟由产品自己结束（`model_done`，确认程度全部）。第 6 趟由 harness 结束（`user_ended`，确认程度部分），原因见下。
- **解析失败率、校验失败率不高于第七轮**：两项都是 0/47；第七轮 0/121。两边都用同一份 `score-run.mjs` 打分。
- **没有新增的崩溃或超时**：调用失败 0，结束时仍有在途效果 0，空元素表 0，开局没有第一步 0。第七轮同样都是 0。
  - 第 6 趟停下的原因：模型第一次从 n8n-docs 仓库页指向站外的 `docs.n8n.io`，产品按设计先弹出跨站确认，线程停在 `pendingCrossSite`。harness 只会点高亮，等了 15 秒没看到高亮框就停下并替用户结束。第七轮的同一个目标 3 遍都停在仓库页，从没走到这一步。这是 harness 的空白（不会点跨站确认），产品的行为符合设计，不算崩溃或超时。
- **报告页**：https://claude.ai/code/artifact/bd4531a2-d818-4ed8-9270-43b080269887 ——页首写明「这是冒烟，不是版本比较」，不列到达率。
- **顺带看到的**：
  - 第 1 趟的第一稿被 R-f 拒掉（只点了一个用来填内容的控件），修复轮救回，所以不算解析或校验失败（首抽失败 1/44，第七轮 0/110）。修复请求里原样带着 Skill 那一段，Plugin 的贡献在真机请求里确实在。
  - 回答分布：guide 35、done 11、need_docs 1。总 token 314,734，其中缓存命中 163,968。
- **留给以后的**：harness 碰到跨站确认卡时应当替用户点「继续」，否则凡是需要离开本站的目标都会在这里停下。这属于评估的 harness，归规格 B。

> 票头补记（2026-09-26）：这张票的实现早就落地了，票头一直没改。上面的实现记录就是当时写的。
