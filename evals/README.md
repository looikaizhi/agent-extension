# 评估

这个目录里是量这个产品的三把尺子。它们量的是三层不同的东西，谁也替代不了谁。

| 命令 | 量什么 | 花不花钱 | 多久 |
|---|---|---|---|
| `npm run eval` | **抽取器**：页面上的元素变成元素表时，有没有漏、有没有错、有没有把敏感控件放出去。不经过模型。 | 不花 | 几分钟 |
| `npm run eval:decision` | **Decision eval**：把录下的真实页面状态重新交给模型，看它每一跳的决定——意图对不对、第一步点的元素和动作对不对。不开浏览器。 | 花（每个状态每遍一次调用） | 十来分钟 |
| `npm run eval:task` | **Task eval**：真浏览器、真网站、真模型，从起点把一个目标走到底，看到没到。 | 花，最贵 | 几个小时 |

三者的关系：抽取器决定模型看到什么；Decision eval 在「看到的东西固定」的前提下量模型的决定；Task eval 量一整趟下来的结果，它最接近用户的体验，但噪声最大、最贵，所以不当闸门，只报告。

## 规矩

**改提示词、换模型、加或改一个 Plugin 之前，必须跑 `eval:decision`。** 它对照基线出门槛，任何一道不过就以非零退出：

- 解析失败率、校验失败率不高于基线；
- 指向表外或敏感控件的次数为 0；
- 意图准确率、第一步准确率没有显著变差（按状态配对，差的 95% 区间整个落在 0 以下才算）。

基线是 `evals/decision/baseline.json` 写的那一轮。换基线是手动的一步：语料扩充之后、换了默认模型之后才换。

## 三条命令

### `npm run eval:decision`

```bash
npm run eval:decision -- --corpus evals/decision/<语料文件> --run <这一轮的名字>
npm run eval:decision -- --from <Task eval 的轮次> --run <名字>      # 直接从一轮真机日志里取全部状态
```

常用参数：`--plugins none|skill`（不写就是产品默认开的那些）、`--passes 3`、`--filter <正则>`（按状态 id 挑）、`--limit <n>`、`--price 输入,缓存命中,输出`（每百万 token）。端点和模型默认读 `.env.local`，也可以用 `--base-url`、`--model` 指定。

- 标注默认读 `evals/decision/annotations.json`。没标注的状态照样算失败率和「指向表外或敏感」，只是不算准确率。
- 现在的标注不是手标的：`batch.mjs <轮次> --arrived` 取出你判了「到了」的趟上的状态，`keys.mjs` 把模型当时的回答（意图，以及指路时的第一步）当作标准答案。所以准确率量的是「重放还走不走得回一条已知能到的路」，不是「决定对不对」：另一种同样能到的走法也会被判错。看门槛时看的是相对基线的变化，不看准确率的绝对值。要换成手标，就走 `label.mjs` → 标注页 → `pull-annotations.mjs`。
- 结果写进 `evals/decision/runs/<名字>/results.json`，进版本管理，已存在的不覆盖。里面记着 Plugin 组合、模型、快照指纹、语料与标注的指纹，以及每个状态每一遍的回答原文，所以以后有了新标注，可以不再问模型就重新打分。
- 端点限流或断网会退避重试；最后仍失败的记为网络错，单独计，不算模型答错。

语料从真机日志里抽：`node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/extract.mjs <轮次> --out <文件>`。它会逐字节核对每个状态能不能按当前代码原样拼回来。

### `npm run eval:task`

```bash
npm run eval:task -- --run <名字> [--goals a,b | --site github.com] [--passes 3] [--plugins none] [--price …]
```

目标定义在 `evals/task/goals.ts`，每个目标写明起点和「到了」的判据（终点 URL，加停下时屏幕上的最后一步）。原始日志、截图在 `runs/<名字>/raw/`，不进版本管理；`runs/<名字>/results.json` 进。

跑完生成报告页：`node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/task/report.mjs <名字> [--previous <上一轮>]`，发布后你在页上逐趟判定，判定用 `read_db` 拉回 `runs/<名字>/verdicts/`，再生成一次。正式的到达率用你的判定，程序化判据只用来对账。

### `npm run eval`

抽取器评测：构建扩展，在 `evals/extract/` 的固定页面上抓元素表，再打分。改 `src/core/extractor/` 之后跑。

## 证明一个 Plugin 有效

Workflow、Memory、新站点的 Skill，以后每加一个都走同一套流程：

1. **Decision eval 上做带 / 不带的配对比较**：同一批有标注的状态，分别用带它和不带它的组合各跑一遍（`--plugins`），按状态配对，看意图准确率、第一步准确率的差和区间。这一层分辨率高，是闸门。
2. **Task eval 上确认不退步**：用不带它的组合把相关目标跑 3 遍，与带它的那一轮按目标配对，确认到达率没有显著变差。你判定两轮之后再下结论。
3. 两层都写进票的实现记录：配对了几个状态或目标、差多少、区间是多少。量不出提升的，不合进来，它的目录也不出现。
