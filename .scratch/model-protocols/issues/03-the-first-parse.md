# 03 — 第一个 `parse`

**What to build:**

`openai-chat` 的另一半：把 `transport` 产出的**行**翻成中立的 `ModelDelta`。

`ModelDelta` 是判别联合：

```
stream-start      { warnings }
text-delta        { text }
tool-input-start  { id, name, index }
tool-input-delta  { index, delta, raw }
finish            { reason, usage }
```

**两件事要如实写进代码注释，否则下一个人会找一个不存在的东西：**

1. **「猜」没有消失，只是搬进了 `openai-chat`。** Chat Completions 的线上**确实没有** start 事件，所以这个适配器仍然要靠「第一片带 id/name」合成 `tool-input-start`。判别联合买到的是：Anthropic 与 Responses **不必再猜**，它们的 start 事件原样映射。
2. **`parse` 不是无状态的。** 它要记「这个 index 发过 start 没有」、`[DONE]` 见没见过、有没有拿到真的 usage。中立这一侧的承诺是**纯粹**（不 IO、不计时、可重放），不是无状态。

**估算 usage 换地方。** 端点不报 usage 时，今天凭消息的字符数造一个带「估算」标记的 usage，兑现「usage 落在最后一个 delta 上」这条硬承诺。`parse` 看不见消息，算不出提示词侧——所以这段归 `transport` 之上、适配器之外的那一层，由它在 `finish` 上补。`finish` 的 usage 要带得下「这是估算值」这个标记。

> 顺带记一条**既有缺陷**，本票不修：线程里的用量类型根本没有「估算」这个字段，运行循环把它丢了，界面又硬写成 false——所以成本面板那句「含估算值」对模型调用永远不会亮。搬的时候不要把这条链抄得更深。

运行循环这一票**仍然不切换**。

**Blocked by:** 02

**Status:** done — 2026-09-24（提交留给用户）

- [x] `parse` 吃行、不吃字节；字节边界那一类问题全部由 `transport` 负责，此处一行都不重写
- [x] 内容那批 fixture 迁过来并绿：`[DONE]` 之后还有数据、流里的 error 对象、usage 块在末尾 / 缺 `total_tokens` / 完全没有、两条完整行
- [x] 多个工具调用按 index 正确解复用
- [x] 「usage 落在最后一个 delta 上」这条承诺仍然成立，端点不报时给出带估算标记的值
- [x] 代码注释写明「猜没有消失，只是搬进了这个适配器」与「`parse` 是纯粹的，不是无状态的」
- [x] 老路径一行未动，模型输入快照逐字节不变
- [x] 类型检查、单测（1090）、e2e（284/284）全绿；抽取器评测的 L-1 / L-3 两条门槛仍未达——先于 01 就已如此，与本票无关
