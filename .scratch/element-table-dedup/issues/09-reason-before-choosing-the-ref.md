# 09 — 让模型先写理由，再挑 ref

**What to build:** 模型在仓库页上要找 CI 配置时，点的是 `Actions`，而不是先点错「Security and quality」再花三跳绕回来。

## 证据

真机 21 轮里反复出现同一个形状。P3-7 第 3 跳的 `why` 原文：

> 选「Security and quality (180)」会进入该仓库的安全与质量相关页面；**不过更贴合 CI 配置的是进入 Actions 或 .github 目录**

**它在同一句话里说出了正确答案，而 `ref` 指向错的那个。** P2-7 同型（也是先点 Security）；P2-4 第 3 跳点了 Issues；P3-4 的理由写到一半自我否定「但这里我用的是 Tags 链接——不对，要看发布版本应点 Tags 旁边的发布入口」，然后还是点了 Tags。

## 为什么

字段顺序。实测模型**每一次**都严格按 schema 声明的顺序输出：

```
schema:  required: ['ref', 'action', 'value', 'why', 'expect_after']
实际输出: ref → action → value → why → expect_after   （4/4 抽样一致）
```

自回归是逐字段往下写的，所以**我们让它先承诺一个 ref，再为这个 ref 编理由**。理由写到一半发现选错了，token 已经出去了。

browser-use 是反过来的，而且是**手工覆写**的（`docs/research-dom-serialization-and-arrival.md` §3.1）：

```
schema['required'] = ['evaluation_previous_goal', 'memory', 'next_goal', 'action']
                      ←──────── 三个反思字段 ────────→        ↑动作
```

## 这张票不做什么

不加新字段、不加思维链、不动 `done` 的 `evidence` 在 `why` 之前那个顺序——那一处当初是刻意的（「先分类再叙述」，防止含糊的 `done`），它的取舍和这里不同，要动得另有证据。

**Blocked by:** None — can start immediately

**Status:** done（由 guide-stability 落地；票头 2026-09-26 补正）

- [x] `guide` 的 `steps[]` 里 `why` 排在 `ref` / `action` 之前，`required` 数组与 `properties` 声明顺序一致
- [x] `why` 的 description 说清它要先写：这一步为什么是这一步，写完再挑 ref
- [x] 解析器不依赖字段顺序（本来就不该依赖，要有测试钉住）
- [x] golden 语料重录，确认模型确实按新顺序输出
- [x] `npm run verify` 全绿

---

## 做完之后

**改动只有字段顺序**：`required` 从 `['ref','action','value','why','expect_after']` 改成 `['why','ref','action','value','expect_after']`，`properties` 的声明顺序跟着调，`why` 的 description 改成「先写这一步为什么是这一步……写完再挑 ref」。没加字段、没加思维链。

**重录 golden 就是验收**：9 次 guide 调用里 **8 次按新顺序输出** `why → ref → action → value → expect_after`。

**唯一那次没遵守的，恰好是最能说明问题的一条。** slice 4（故意含糊的目标）保持旧顺序，先写了 `"ref": "e12"`，然后 `why` 是：

> 用户说"这条安全组规则"，页面上安全组规则区域下有两条规则……但"这条"指向不明——两条都是"允许……入站"规则，**我无法判断用户指的是哪一条。需要先请用户指明。**

**它先承诺了一个 ref，再用理由解释这个 ref 为什么不该选**——而正确答案是 `clarify`。这正是这张票要治的病。

**顺带一个必须记下的事实：strict 模式并不强制字段顺序。** 9 次里 1 次偏离。8/9 是显著改善，不是保证——所以解析器绝不能依赖顺序，`contract.spec` 里加了一条把这一点钉住（同一份内容换两种字段顺序，解析结果必须逐字段相等）。

> 票头补记（2026-09-26）：`point` 的字段顺序里 `why` 在 `ref` 之前，且 required。
