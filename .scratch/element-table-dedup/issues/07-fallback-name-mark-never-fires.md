# 07 — `~` 兜底名标记从不出现，模型被告知一个屏幕上没有的名字

**What to build:** 模型能分辨「这个名字用户在屏幕上看得见」和「这个名字是我们从 `title`/`href`/`testid` 猜的」。今天它分辨不了，而提示词让它以为自己分辨得了。

`MARK_GUIDE` 明确告诉模型这个标记的含义：

> 名字前的 `~`（例如 `~"delete-file"`）：这个名字不是用户在屏幕上能看到的文字，而是从 title/href/testid 等属性猜出来的兜底名字，说「点击写着 xxx 的按钮」是不成立的，因为屏幕上根本没画出这几个字。

**实测：整份 eval 语料 189 条 item，`nameSource` 一条都没有。** 标记的覆盖率是零。

## 机制

`resolveName` 先调 `computeAccessibleName`，只有它返回空、过短或是垃圾时，才走那条显式兜底分支去读 `title` / svg `<title>` / `data-testid` / `href`，并把 `source` 相应地记成 `title` / `testid` / `href`。

问题在于 **`computeAccessibleName` 自己就把 `title` 当兜底**（accname 规范的最后一步就是 title）。于是一个只有 `title`、没有可读文字的元素，名字被它直接算了出来，那条显式分支根本不执行；`source` 落到 `classifySource`，而后者是**按属性猜**的——没有 `aria-labelledby` / `aria-label` / `alt` / `placeholder` / `label` 就返回 `content`。

结果：**一个名字明明来自 `title`，被标成了「用户在屏幕上读得到的内容」。**

01 号票造语料时撞上了这个：一行提交链接照真机的形状写成只有 `title`、可见内容被 `aria-hidden` 挡掉，预期它带 `~`，实测拿到的是 `content`。

## 为什么这不只是标记好看不好看的问题

扩展只指路，用户自己动手。指路的话术是「点写着 XXX 的那个按钮」——**这句话成不成立，完全取决于屏幕上有没有画出那几个字**。标记失效时，模型会照着一个只存在于 `title` 属性里的字符串去描述控件，而用户在屏幕上找不到它。这正是 `MARK_GUIDE` 那段话要防的情况。

范围是窄的：`alt` 仍然认得出（`classifySource` 查这个属性），accname 真的算不出来时那条显式分支也仍然正确。**漏掉的是「accname 自己用了 title」这一种**，而它恰好是真实页面上图标按钮与行链接最常见的形态。

## 这张票不做什么

不改裁剪、不改去重。02 号票的去重判据已经改成不依赖这个标记（改用「名字完整包含同一行另一条的名字，且 `path`、`role` 相同」），所以两张票互不阻塞。

**Blocked by:** None — can start immediately

**Status:** done（由 guide-stability 落地；票头 2026-09-26 补正）

- [x] 名字实际来自 `title` 时，`nameSource` 记成 `title`，不再记成 `content`
- [x] 判定依据是「名字实际从哪来」，不是「元素上有哪些属性」——`classifySource` 靠属性猜的做法要么改掉，要么明确只用于它猜得准的那几种
- [x] `alt` / `placeholder` / `aria-label` / `aria-labelledby` / `label` 的既有判定不变
- [x] `accname` 真的算不出来时走显式兜底分支、记成 `title` / `testid` / `href` 的既有行为不变
- [x] eval 语料里至少有一条 item 带上 `nameSource`，且序列化后带 `~`——这个标记第一次有覆盖
- [x] `MARK_GUIDE` 里那段对 `~` 的说明与序列化器的真实行为一致
- [x] 敏感元素的 `!secret` 标记不受影响
- [x] `npm run verify` 全绿；`npm run eval` 的既有门槛不因本票下降

---

## 做完之后

`classifySource` 多了一条判据：**计算出来的名字如果逐字等于元素的 `title`，来源就是 `title`**，而不是猜成 `content`。放在 aria-label / alt / placeholder / label 之后、`content` 之前——那些属性在 accname 里优先级都高于 title，顺序错了会盖掉真来源。

效果：`~` 标记的覆盖率从**全语料 0 条**变成 **39 条**，全部来源 `title`，样例 `~"ci: Improve pnpm install performance (no-changelog) (#30000)"`。

**说清楚这 39 条落在哪：全部在 01 号票新加的 `repo-home` 里，原有那 21 个 fixture 仍然是 0。** 「0 → 39」是真的，但不等于既有语料拿到了覆盖——那 21 个页面本来就没有只靠 `title` 命名的元素。要让既有语料也守住这条，得专门加一个这种形状的 fixture，那不属于这张票。

**残留的误判说清楚**：一个元素的可见文字恰好等于它自己的 `title` 时，会被判成 `title`、多带一个 `~`。真实但少见，而且错的方向是安全的——模型会对一个其实读得到的名字保守一点，而不是对一个读不到的名字自信起来。后者才是这张票要修的那个错。

**评审抓到一处实现缺陷，已修**：第一版直接比 `title.trim()` 和名字，但 `computeAccessibleName` 按规范折叠空白、而属性不折叠——`title` 里有换行或连续空格的元素两边不相等，继续被判 `content`，**正好是这张票要消灭的那个失效方向**。现在两边都过 `fold()`（`\s+` → 单空格）再比。

> 票头补记（2026-09-26）：`semantics.ts` 改成拿算出来的名字跟 `title` 比对，理由写在那个函数上面。
