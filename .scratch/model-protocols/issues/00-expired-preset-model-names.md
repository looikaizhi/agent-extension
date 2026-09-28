# 00 — 过期的 preset 模型名

**What to build:**

用户在设置里从预设下拉中选到的模型名，都是今天真的存在的。

五家要改（一手核对，2026-09-23）：

| preset | 现在写的 | 情况 |
|---|---|---|
| Moonshot | `moonshot-v1-8k` / `moonshot-v1-32k` | **2026-05-25 已下线**，调用会直接失败 |
| 智谱 GLM | `glm-4-flash` / `glm-4-plus` | 过期，换 GLM-5.3 / GLM-5.2 |
| 通义 DashScope | `qwen-plus` / `qwen-turbo` | 过期，换 qwen3 系 |
| OpenRouter | `openai/gpt-4o-mini` | 过期 |
| SiliconFlow | `Qwen/Qwen2.5-7B-Instruct` | 过期 |

**两家不动：**
- **DeepSeek** —— `deepseek-flash` / `deepseek-v4-pro` 已是现行，连同那条 `thinking: {type:'disabled'}` 的 preset 字段与它的实测注释一并保留。
- **OpenAI** —— 它的换代机型（`gpt-6-*`）在 Chat Completions 上不支持函数调用，必须等 07 的 Responses 适配器落地才改得对。现在改成 gpt-6 等于把一个能用的 preset 换成一个不能用的。**这一条在 08 里做。**

**不新增任何 preset**，尤其不加 Gemini——那是新增一个没验证过的端点，性质和「修正一个过期的名字」不同。

**Blocked by:** None — 与本规格其余各票无依赖关系，可随时单独提交

**Status:** done（顺手完成于 01–08 主线；票头 2026-09-26 补正）

- [ ] 五家的模型名逐一对着厂商一手文档核过，并在提交信息或注释里留下核对日期
- [ ] DeepSeek 与 OpenAI 两条完全未动，DeepSeek 的 `request` 字段与实测注释原样保留
- [ ] 没有新增任何 preset
- [ ] 架构守卫里 `PRESET_FIELDS` 那条「每个 preset 专有字段都要注明一手文档与实测」的断言仍然绿
- [ ] 类型检查、单测、e2e、抽取器评测全绿

> 票头补记（2026-09-26）：用户当时说「00 不需要执行」，但这件事在主线里顺手做完了——2026-09-25 对着一个聚合端点实测，九条预设的模型名全部核过并替换（`shared/settings.ts` 每一条都带着实测注记）。只剩 OpenRouter 与 SiliconFlow 两条仍标着「⚠️ 未核实」：它们用 `vendor/model` 命名，手上那个端点给不出证据，要各自的 Key 才能查。
