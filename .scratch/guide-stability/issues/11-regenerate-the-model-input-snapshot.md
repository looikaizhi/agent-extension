# 11 — 重新生成模型输入的冻结快照

**What to build:**

「以后再动模型输入时会变红」这个守卫继续有效,而这一次的变动是**有意的**,所以重录。

上一次架构 pass 第 01 张票定下的方法论保留——动模型输入之前先冻结、之后逐字节比对;这一次的产物作废,因为模型输入整个换掉了(工具集、一次一步、`ask` 合并)。

重录之后,守卫恢复它原本的作用。

**Blocked by:** 05b、05c、05d — 读数取代重规划机制(读数会进模型输入);08 — 删掉独立的问答 `Agent`;09 — 两个预算取代调用配额

**Status:** done — 2026-09-19(提交留给用户,见下)

- [x] 快照按新的模型输入重新生成(07a–07d 每张都随改动更新过一次;真实模型语料在 07d 末尾重录过,本票在 05、08、09 之后再做最终重录)
- [ ] 提交信息写明**为什么**变了——按 CLAUDE.md 不自行做 Git 操作,说明已写在下面,提交时直接用(工具集换掉、一次一步、`ask` 合并两个旧 Output)
- [x] 守卫恢复绿色,并且探针验证:人为改一个字会让它变红
- [x] 快照补上本轮新进模型输入的形状:读数唤醒时那一段(05b)、「没画出来」(05c)、「没找到」与「此刻点不了」(06b,取代 05d 的「找了 N 次」)、一步最后一次调用的工具表与末尾那句话(09)、「用户又说:「…」」那条读数(08b)
- [x] 旧的两批冻结 Decision eval 语料原样保留,不重录、不再当闸门
  - 07a 已把标注文件里的意图名改成 `point` / `ask`(84 条 `guide`、1 条 `clarify`),含义不变;录下的两批语料一字未动。07a 也已随改动更新过一次快照,本票做的是全部改完之后的最终重录

**进度记录**(2026-09-19):

- **新增 6 个用例**:读数唤醒的五种页面比较各一次(换了地址 / 地址变了控件没变 / 原地变了 / 没变 / 读不到),其中带齐所有读数——用户点了、填完了、目标消失、页面自己变了、整页加载完、没画出来(换了页、敏感框)、没找到、此刻点不了(禁用、挡住、在动)、用户又说;外加一步的最后一次调用(只给回答、末尾那句话)。重录后与重录前逐行比对:原有内容**一行未改**,只有这 6 个用例的新增。
- **审阅时发现并修掉两处模型读到的错话**(都有红测在先):
  - **路标那一段在唤醒时说假话**(05b 引入的回归):它靠「上一步做成了什么」判断页面动没动,而 05b 之后那个值要等这次回答落地才结算,唤醒时一律为空,于是每次都说「用户已经照做并到了新的页面」——页面没变、原地变了、读不到时都是假话,还和紧跟着的「此刻这一页和你上次回答时相比」自相矛盾。改成有页面比较时按它说:换了地址 →「到了新的一页」;原地变了、没变 →「现在还在这一页」;地址变了控件没变、读不到 →「这一页此刻怎样,见下面」,不替它下结论。没有页面比较的调用维持原样。单测 5 条。
  - **最后一次调用那句话漏了 explain**(09 早于 08a 加入 explain):工具表里有 explain,那句话只点名 point / ask / done。补上「用户问的是这一页上的事,就直接回答(explain)」。单测 1 条:那句话点名的正是这一次给的每一个回答。
  - 两处修完各重录一次,每次都只动了对应的行(路标 5 行、那句话 1 行)。
- **探针**:系统提示词里改一个字 → 两个快照测试都红;已还原(shasum 一致)。
- **真实模型语料没有重录**,也就没花这笔钱:它在 08a 录于 00:23:01,快照随后在 00:23:30 写入(那次只新增了一个用例),此后一直是绿的——录语料时用的系统提示词和工具表与现在逐字节一致。本票改动的两处只出现在唤醒调用和一步的最后一次调用里,语料录的都是第一次规划,不受影响。
- 旧的两批冻结 Decision eval 语料一字未动。
- `CONTEXT.md` 的 `Budget` 词条:第 4 次给的回答补上 `explain`。
- 验证:类型检查 0;单测 1926 全绿。

**提交说明(供提交时直接用)**:

```
test: re-record the model-input snapshot after the guide-stability rewrite

The model's input changed on purpose across this pass, so the frozen
snapshot is re-recorded rather than patched:

- the tool set is point / ask / explain / observe / wait_for / read_doc /
  done, one step at a time, with the old clarify and need_text merged into
  ask and the separate question agent gone;
- a model woken by readings is told what the extension saw and how the page
  compares with the one it last answered on (moved, moved with the same
  controls, changed in place, unchanged, unreadable);
- a step's last call offers only answers and says so.

New cases cover every reading and page comparison and the last call. Two
wrong sentences found while reviewing are fixed: the route paragraph no
longer claims the user reached a new page when the page comparison says
otherwise, and the last call's sentence now names explain.
```
