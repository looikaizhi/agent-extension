import { describe, expect, it, vi } from 'vitest';
import { buildGuideUserMessage } from '@/agent/context/user-message';
import { guideAgent } from '@/agent/agents/guide/agent';

/** The guide's two messages, assembled the way the runner assembles them. */
/** The guide agent's system message, exactly as it is sent. */
const GUIDE_TOOL_SYSTEM = guideAgent.instructions;
/** The two messages as the model reads them: text, not parts. What a part
 *  turns into on the wire is the adapter's business and is tested there. */
const buildGuidePrompt = (goal: string, table: Parameters<typeof buildGuideUserMessage>[1], history?: Parameters<typeof buildGuideUserMessage>[2]) =>
  guideAgent.buildMessages({ goal, table, history: history ?? { done: [], route: [] } }).map(textOf);
import { toPromptText } from '@/core/extractor/project';
import { textOf } from './fixtures/neutral';
import type { ExtractStats, PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { BENIGN_INJECTION_TOPIC_PARAGRAPH } from './fixtures/benign-injection-topic';
import { ENVELOPE_OPENING, FORGED_CLOSING_TAG, FORGED_INSTRUCTION, NESTED_WRAPPER } from './fixtures/hostile-names';
import { TABLES, goldenGuideCalls, malformedToolCalls } from './fixtures/golden-guide-envelopes';
import { openaiChat } from '@/agent/provider/protocols/openai-chat';

/**
 * The prompt builder is the seam under test. Every test drives the agent's
 * messages end to end through the real `PromptTable` / `ChatMessage` shapes —
 * no internal helper of `context/user-message.ts` is imported.
 *
 * `table()` / `item()` below build a `PromptTable` by hand rather than by
 * running the real `project()` pipeline: the seam under test only promises
 * something about what `buildGuidePrompt` does with a `PromptTable` it is given,
 * so the fixture has no business depending on extraction/pruning behaviour
 * covered by `project.spec.ts`.
 */

const stats: ExtractStats = {
  elementsScanned: 0,
  candidates: 0,
  visible: 0,
  emitted: 0,
  shadowRoots: 0,
  emptyName: 0,
  modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

// `Omit<..., 'ref'>` before intersecting, same trick as `project.spec.ts`'s
// `node()` helper: `Partial<PromptItem>` alone still carries `ref?: Ref`, and
// intersecting that un-omitted with `{ ref: string }` forces every call site
// to satisfy the branded type itself instead of the plain string this helper
// exists to accept.
type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

function item(p: ItemSpec): PromptItem {
  return { path: [], ...p, ref: p.ref as unknown as Ref };
}

function table(items: PromptItem[]): PromptTable {
  return {
    snapshotId: 's1',
    url: 'https://example.test/x',
    title: 't',
    structureHash: 'h',
    items,
    omitted: 0,
    degraded: false,
    ambiguity: 0,
    stats,
  };
}

/** Pulls the text between the real wrapper tags out of a `user` message's
 *  content, using the actual (random, per-call) nonce rather than a
 *  hardcoded one — this is what every hostile-fixture test below needs to
 *  check *what actually ended up inside the wrapper*, independent of which
 *  nonce this particular call happened to generate. */
function innerOf(content: string): string {
  const m = content.match(
    /<untrusted_page_content nonce="([^"]+)">([\s\S]*)<\/untrusted_page_content nonce="([^"]+)">/,
  );
  if (!m) throw new Error('wrapper not found in: ' + content);
  return m[2]!;
}

describe('buildGuidePrompt — nonce 兜底', () => {





  it('7. nonce 碰撞兜底：候选 nonce 恰好出现在序列化结果里 → 重新生成一个再用', () => {
    const collide = '11111111-1111-1111-1111-111111111111';
    const safe = '22222222-2222-2222-2222-222222222222';
    // The control name itself embeds the exact string the mocked random
    // source will offer as the *first* candidate, so `toPromptText(t)`
    // is guaranteed to contain it.
    const t = table([item({ ref: 'e1', role: 'button', name: `候选值 ${collide} 在这里` })]);
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(collide).mockReturnValueOnce(safe);
    try {
      const user = buildGuidePrompt('问题', t)[1]!;
      expect(user).not.toContain(`nonce="${collide}"`);
      expect(user).toContain(`nonce="${safe}"`);
    } finally {
      spy.mockRestore();
    }
  });



});

describe('buildGuidePrompt — 敌意 fixture：结构不被攻破', () => {


  it('11. 以信封开场：控件名以 {"intent":"explain",...} 开头 → 原样出现在页面内容段落里，不影响消息结构', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: ENVELOPE_OPENING })]);
    const messages = buildGuidePrompt('问题', t);
    expect(messages).toHaveLength(2);
    expect(innerOf(messages[1]!)).toBe(toPromptText(t));
    // `toPromptText` JSON.stringify's every name — including a hostile one —
    // so the fixture's own `"` characters come out `\"`-escaped in the
    // table line. That escaping is `toPromptText`'s pre-existing, universal
    // behaviour (see project.spec.ts), not something `buildGuidePrompt` may add
    // or must avoid; checking for the raw un-escaped fixture text here would
    // be testing the wrong layer. `JSON.stringify(name)` is what an
    // unmodified pass-through actually looks like once serialized.
    expect(innerOf(messages[1]!)).toContain(JSON.stringify(ENVELOPE_OPENING));
  });

  it('12. 嵌套包裹标签：控件名里出现一整段看起来像 <untrusted_page_content>…</untrusted_page_content> 的嵌套文本（不带真实 nonce）→ 结构不变', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: NESTED_WRAPPER })]);
    const messages = buildGuidePrompt('问题', t);
    expect(messages).toHaveLength(2);
    expect(innerOf(messages[1]!)).toBe(toPromptText(t));
    // Same JSON.stringify-escaping note as slice 11 above — `NESTED_WRAPPER`
    // carries no `"` itself, but does carry the nested wrapper text, so this
    // also doubles as proof that `innerOf`'s regex (leftmost-open,
    // rightmost-close) still lands on the *real* wrapper boundary rather
    // than a fake nested one embedded in the hostile name.
    expect(innerOf(messages[1]!)).toContain(JSON.stringify(NESTED_WRAPPER));
  });
});

describe('buildGuidePrompt — 对照组：防的是相反方向的问题', () => {
  it('13. 正常讨论「什么是提示注入攻击」的技术文章片段作为控件 name → 原样、完整地出现在 user 消息里，一个字都没有被删除或替换', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: BENIGN_INJECTION_TOPIC_PARAGRAPH })]);
    const messages = buildGuidePrompt('这段说明是什么意思', t);
    expect(messages).toHaveLength(2);
    // 整份被包裹段落必须与独立来源 toPromptText(t) 逐字一致——不是「大体没变」。
    expect(innerOf(messages[1]!)).toBe(toPromptText(t));
    // 且这段技术文章本身（经过 toPromptText 既有的 JSON.stringify 转写后）
    // 完整出现，不是被截断或抽掉了几个关键词之后的残余。产品里没有任何内容
    // 层过滤逻辑，所以这条理应自动通过——它的价值在于将来有人为了「更安全」
    // 加一条关键词过滤时，第一时间变红。
    expect(innerOf(messages[1]!)).toContain(JSON.stringify(BENIGN_INJECTION_TOPIC_PARAGRAPH));
  });
});

describe('buildGuidePrompt', () => {
  it('17. 基本调用：返回恰好两条消息，system 在前、user 在后', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const messages = guideAgent.buildMessages({ goal: '把这个仓库改成 private', table: t, history: { done: [], route: [] } });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    // 每条消息都是内容分片的数组，不是一个裸字符串——扁平那种写法说不出「这一轮
    // 只是一次工具调用」，也放不下推理块。
    expect(messages.map((m) => m.content.map((p) => p.type))).toEqual([['text'], ['text']]);
  });

  it('18. 每种信封各是一个工具，字段要求写在 schema 里而不是提示词里', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    // 形状归 schema，判断归提示词。这两条从前都挤在 system 消息里，于是同一件事
    // 要说两遍——实测每次调用多付 30%。
    const tools = guideAgent.outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } });
    expect(tools.map((t) => t.name).sort()).toEqual(['ask', 'done', 'explain', 'observe', 'point', 'read_doc', 'wait_for']);

    const point = JSON.stringify(tools.find((t) => t.name === 'point'));
    for (const field of ['previous_step', 'route', 'ref', 'action', 'why', 'value', 'expect_after', 'via_ref', 'must_contain'])
      expect(point, `point 的 schema 里应有 ${field}`).toContain(field);

    const ask = JSON.stringify(tools.find((t) => t.name === 'ask'));
    for (const field of ['question', 'wants', 'options', 'label']) expect(ask).toContain(field);

    const readDoc = JSON.stringify(tools.find((t) => t.name === 'read_doc'));
    for (const field of ['via_ref', 'query']) expect(readDoc).toContain(field);
  });

  it('18b. 没有任何一个工具向模型索取 intent——工具名就是 intent', () => {
    // 试过：钉成单值 enum 的 `intent` 属性，8 抽里有 6 次被填成了目标的自然语言
    // 复述。叫 intent 的字段读起来就是"用户的意图"，schema 说什么都拦不住。
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const schema = guideAgent.outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } });
    expect(JSON.stringify(schema)).not.toContain('"intent"');
  });

  it('18c. 四个 schema 都满足 OpenAI strict-mode 的要求（这就是这次改用工具调用的理由）', () => {
    // 严格模式有两条硬性要求，违反哪一条都是整次调用被 400 拒掉，不是只丢一个
    // 约束：(1) properties 里的每个键都必须列进 required——"可选"只能用与 null
    // 的联合类型表达；(2) minItems 这类关键字不在支持的子集里。DeepSeek 宽容地
    // 接受了违反这两条的 schema，所以只靠真机跑不出来，得在这里断言。
    const UNSUPPORTED = ['minItems', 'maxItems', 'minimum', 'maximum', 'pattern', 'format', 'minLength', 'maxLength'];
    const problems: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      for (const k of UNSUPPORTED) if (k in n) problems.push(`${path} 含不支持的关键字 ${k}`);
      const isObject = n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'));
      if (isObject && n.properties) {
        if (n.additionalProperties !== false) problems.push(`${path} 缺 additionalProperties:false`);
        const required = new Set((n.required as string[]) ?? []);
        for (const k of Object.keys(n.properties as object))
          if (!required.has(k)) problems.push(`${path}.${k} 在 properties 里却不在 required 里`);
        for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) walk(v, `${path}.${k}`);
      }
      if (n.items) walk(n.items, `${path}[]`);
    };
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    for (const f of guideAgent.outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } }))
      walk(f.inputSchema, f.name);
    expect(problems).toEqual([]);
  });

  it('18d. 可选字段用与 null 的联合表达，且解析器把 null 与"没给"当成同一件事', () => {
    // 两边必须对齐，否则就是：schema 合规了，自己的解析器反而拒收合规的输出。
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const point = guideAgent
      .outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } })
      .find((x) => x.name === 'point')!;
    const step = (point.inputSchema as { properties: Record<string, { type: unknown }> }).properties;
    expect(step.value!.type).toEqual(['string', 'null']);
    expect(step.expect_after!.type).toEqual(['object', 'null']);

    const withNulls = JSON.stringify({ route: [{ at: 'x', goal: 'y' }], ref: 'e1', action: 'click', why: '点它', value: null, expect_after: null });
    const parsed = guideAgent.parseOutput('point', withNulls);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.envelope.intent === 'point') {
      expect(parsed.envelope).not.toHaveProperty('value');
      expect(parsed.envelope).not.toHaveProperty('expect_after');
    }
  });

  it('18e. done 必须先说清凭什么，才写理由', () => {
    // 真机上出现过对着从没开始的目标喊 done。一句自由文本分不出"我看见了"和
    // "我以为"；先分类再作答，是 previous_step 已经验证过有效的那套机制。
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const done = guideAgent
      .outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } })
      .find((x) => x.name === 'done')!;
    const params = done.inputSchema as {
      required: string[];
      properties: { evidence: { enum: string[] } };
    };
    expect(params.required).toEqual(['evidence', 'why']);
    expect(params.properties.evidence.enum).toEqual(['content_on_page', 'page_address', 'step_completed']);

    const ok = guideAgent.parseOutput('done', JSON.stringify({ evidence: 'page_address', why: '地址就是目标页' }));
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok' && ok.envelope.intent === 'done') expect(ok.envelope.evidence).toBe('page_address');

    // 认不得的值不推翻整封信——它不驱动任何判断，只是记录与逼问。
    const odd = guideAgent.parseOutput('done', JSON.stringify({ evidence: '我觉得', why: '做完了' }));
    expect(odd.kind).toBe('ok');
    if (odd.kind === 'ok' && odd.envelope.intent === 'done') expect(odd.envelope.evidence).toBeUndefined();
  });

  it('19. action 的五个合法取值由 schema 的 enum 给出，不靠提示词复述', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const point = guideAgent
      .outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } })
      .find((x) => x.name === 'point')!;
    const params = point.inputSchema as { properties: { action: { enum: string[] } } };
    // 五个，不是六个：`observe` 已经从模型能提的动作里删掉。它是唯一一个
    // 没有完成信号的动作（`presenter.ts` 的 ADVANCING_ACTIONS 不含它），
    // 单步 observe 计划会把线程冻死。QA 那条路自己构造步骤，不走这个 schema。
    expect(params.properties.action.enum).toEqual(['click', 'input', 'select', 'toggle', 'scroll']);
    expect(params.properties.action.enum).not.toContain('observe');
  });

  it('19b. ref 是这张表的 ref 枚举——它锚的不只是 ref，是整个输出的形状', () => {
    // 去掉它试过并量过：同一批 16 次采集，`guide` 完全没有 steps 的从 1 次涨到
    // 4 次。它每个元素每次调用多花 4~6 token，换的是必填字段丢失率降到四分之一。
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' }), item({ ref: 'e2', role: 'link', name: '文档' })]);
    const point = guideAgent
      .outputSchema({ goal: 'g', table: t, history: { done: [], route: [] } })
      .find((x) => x.name === 'point')!;
    const params = point.inputSchema as { properties: { ref: { enum: string[] } } };
    expect(params.properties.ref.enum).toEqual(['e1', 'e2']);
  });

  it('20. user 消息里包含 goal 原文', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const goal = '把这个仓库从 public 改成 private';
    const user = buildGuidePrompt(goal, t)[1]!;
    expect(user).toContain(goal);
  });

  it('21. user 消息里的元素表片段被包裹在一对携带同一个 nonce 的标签之间，与 toPromptText(table) 逐字一致', () => {
    const t = table([
      item({ ref: 'e1', role: 'link', name: '实例列表' }),
      item({ ref: 'e2', role: 'button', name: 'delete-file', nameSource: 'title' }),
      item({ ref: 'e3', role: 'textbox', name: '登录密码', sensitive: true }),
    ]);
    const user = buildGuidePrompt('目标', t)[1]!;
    const match = user.match(
      /<untrusted_page_content nonce="([^"]+)">([\s\S]*)<\/untrusted_page_content nonce="([^"]+)">/,
    );
    expect(match).not.toBeNull();
    const [, openNonce, inner, closeNonce] = match!;
    expect(openNonce).toBe(closeNonce);
    expect(inner).toBe(toPromptText(t));
  });

  it('22. 连续两次调用 buildGuidePrompt（同一个 table）→ 两次生成的 nonce 不同', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const nonceOf = (content: string) => content.match(/nonce="([^"]+)"/)?.[1];
    const first = nonceOf(buildGuidePrompt('目标', t)[1]!);
    const second = nonceOf(buildGuidePrompt('目标', t)[1]!);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('23. system prompt 提到 ~ 标记（名字非屏幕可见文字）与 !secret 标记（敏感字段）的含义（复用 MARK_GUIDE）', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const system = buildGuidePrompt('目标', t)[0]!;
    expect(system).toContain('~');
    expect(system).toMatch(/~[^\n]*(屏幕|看不到)/);
    expect(system).toContain('!secret');
    expect(system).toMatch(/!secret[^\n]*(敏感|凭据|不得|禁止)/);
  });

  it('24. system prompt 要求用提问所使用的语言作答；buildGuidePrompt 的形参里没有任何语言参数', () => {
    // Originally asserted an arity of exactly 2. That number was a proxy for
    // the real guarantee — no caller can tell this function what language to
    // answer in — and 07 added a legitimate third parameter (`history`), so
    // the proxy went red while the guarantee held. Assert the guarantee.
    const params = buildGuideUserMessage.toString().slice(0, buildGuideUserMessage.toString().indexOf(')'));
    expect(params).not.toMatch(/locale|lang|language/i);
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    const system = buildGuidePrompt('这是一个中文目标', t)[0]!;
    expect(system).toMatch(/(提问|问题)(所用|所使用|使用)的语言.*(作答|回答)/);
  });

  it('25. 同一张中文 table 配四种语言的 goal → system（含更长的 route/steps/expect_after 形状说明）逐字相同，元素表片段逐字相同，只有 goal 那一段不同 —— §0.3 的实测结论在 guide 维度同样成立', () => {
    const t = table([
      item({ ref: 'e1', role: 'link', name: '实例列表' }),
      item({ ref: 'e2', role: 'button', name: '删除' }),
    ]);
    const zh = buildGuidePrompt('把这台实例删掉', t);
    const en = buildGuidePrompt('Delete this instance', t);
    const ms = buildGuidePrompt('Padamkan instans ini', t);
    const ja = buildGuidePrompt('このインスタンスを削除したい', t);

    // system 从不按 goal 改变，四次逐字相同 —— 即使形状说明比 S1 长得多。
    expect(en[0]!).toBe(zh[0]!);
    expect(ms[0]!).toBe(zh[0]!);
    expect(ja[0]!).toBe(zh[0]!);

    expect(innerOf(zh[1]!)).toBe(toPromptText(t));
    expect(innerOf(en[1]!)).toBe(toPromptText(t));
    expect(innerOf(ms[1]!)).toBe(toPromptText(t));
    expect(innerOf(ja[1]!)).toBe(toPromptText(t));

    // goal 依然是被包裹段落之后的最后一段——不能因为形状说明变长了就把 goal 挪回前面。
    const goalPartOf = (content: string) => content.slice(content.lastIndexOf('</untrusted_page_content'));
    expect(goalPartOf(zh[1]!)).toContain('把这台实例删掉');
    expect(goalPartOf(en[1]!)).toContain('Delete this instance');
    expect(goalPartOf(ms[1]!)).toContain('Padamkan instans ini');
    expect(goalPartOf(ja[1]!)).toContain('このインスタンスを削除したい');
  });

  it('26. 敌意 fixture：伪造闭合标签在 buildGuidePrompt 下同样不被攻破', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: FORGED_CLOSING_TAG })]);
    const messages = buildGuidePrompt('目标', t);
    expect(messages).toHaveLength(2);
    expect(innerOf(messages[1]!)).toBe(toPromptText(t));
    expect(innerOf(messages[1]!)).toContain(FORGED_CLOSING_TAG);
  });

  it('27. 敌意 fixture：伪造新指令在 buildGuidePrompt 下同样只是被包裹段落里的一段文字', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: FORGED_INSTRUCTION })]);
    const messages = buildGuidePrompt('目标', t);
    expect(messages).toHaveLength(2);
    expect(innerOf(messages[1]!)).toBe(toPromptText(t));
    expect(innerOf(messages[1]!)).toContain(FORGED_INSTRUCTION);
  });

  it('27b. done 的两道防线都还在：既不许"没开始就 done"，也不许把"看见"当"做完"压在看到型目标上', () => {
    // 历史上出过 7/14 轮「目标从没开始就 done」——当时 done 的触发条件写成了
    // 「这一页再没有能推进目标的控件」，和 clarify 撞了。那条分界必须留着。
    expect(GUIDE_TOOL_SYSTEM).toContain('"走不下去"和"已经做完"是相反的两件事');

    // 但纠偏一度过头，压到了看到型目标上：真机 4 次 observe 的 why 都写着
    // 「目标内容已经在眼前呈现」——模型判断对了，却没有工具说得出口。
    // 所以「看见不算做完」现在只对动作型目标成立，并且必须两种都写明。
    expect(GUIDE_TOOL_SYSTEM).toContain('他要看到某个东西');
    expect(GUIDE_TOOL_SYSTEM).toContain('东西显示在这一页上，就是做完了');
    expect(GUIDE_TOOL_SYSTEM).toContain('他要你带他完成某个动作');
    expect(GUIDE_TOOL_SYSTEM).toContain('看见不算做完，必须有一步已经生效');

    // 而那条"看见不算做完"绝不能再变回通则——它只许出现在动作型那一条里。
    const acting = GUIDE_TOOL_SYSTEM.slice(GUIDE_TOOL_SYSTEM.indexOf('他要你带他完成某个动作'));
    expect(acting).toContain('复制按钮');
    const sighting = GUIDE_TOOL_SYSTEM.slice(
      GUIDE_TOOL_SYSTEM.indexOf('他要看到某个东西'),
      GUIDE_TOOL_SYSTEM.indexOf('他要你带他完成某个动作'),
    );
    expect(sighting).not.toContain('看见不算做完');
  });

  it('27c. 「问怎么做」是第三种：讲清楚方法的那一页就是终点，不替用户去执行', () => {
    // 缺了这一种时，「怎么改成按量付费？」被归进动作型，模型在正好回答它的文档
    // 页上还要把人带去控制台真做一遍——2026-09-15 查「到了又兜出去」时，在
    // 判据认定的终点页上它 36 次没说 done，阿里云的文档页占了 9 次。
    expect(GUIDE_TOOL_SYSTEM).toContain('他问的是怎么做、有什么规定');
    const howTo = GUIDE_TOOL_SYSTEM.slice(
      GUIDE_TOOL_SYSTEM.indexOf('他问的是怎么做、有什么规定'),
      GUIDE_TOOL_SYSTEM.indexOf('他要你带他完成某个动作'),
    );
    expect(howTo).toContain('不要替他去执行');
    expect(howTo).not.toContain('看见不算做完');
    // 摘要那条的反面也写明了：主体就是清单的一页，不必再点进其中一项。
    expect(GUIDE_TOOL_SYSTEM).toContain('这一页的主体本身就是那份清单或那组条目时');
  });

  it('28. system 消息用的是引导 agent 的说明本身，不是各写一份、容易漂移的重复文本', () => {
    const t = table([item({ ref: 'e1', role: 'button', name: '保存' })]);
    expect(buildGuidePrompt('目标', t)[0]!).toContain(GUIDE_TOOL_SYSTEM);
  });
});

/**
 * Drift detection against `golden-guide-envelopes.ts` (README's "replay 语料
 * 怎么建" §1, applied here at 01's own layer rather than deferred whole to
 * 02-08): re-running `buildGuidePrompt(goal, table)` against the exact same
 * `goal`/table the real call recorded must reproduce the exact same system
 * message and the exact same user message *modulo the nonce* — the one part
 * of the output that is deliberately random per call (see `nonceFor` in
 * `context/user-message.ts`) and therefore the one part this comparison must strip before
 * comparing. If `buildGuidePrompt` changes in a way that changes its output
 * for these exact inputs, this is where it goes red — not silently.
 */
const stripNonce = (s: string) => s.replace(/nonce="[^"]+"/g, 'nonce="STRIPPED"');

describe('buildGuidePrompt — golden-guide-envelopes.ts 漂移检测（真实模型语料，零网络）', () => {
  it('29. 每条固化语料重新生成的 system 消息与当时逐字保存的 system 消息完全一致（system 不含 nonce，本就该逐字相同）', () => {
    for (const call of goldenGuideCalls) {
      const regenerated = buildGuidePrompt(call.goal, TABLES[call.tableId]);
      expect(regenerated[0]!, `slice ${call.slice}（${call.note}）`).toBe(call.promptText.system);
    }
  });

  it('30. 每条固化语料重新生成的 user 消息，剥离 nonce 之后与当时逐字保存的 user 消息一致', () => {
    for (const call of goldenGuideCalls) {
      const regenerated = buildGuidePrompt(call.goal, TABLES[call.tableId]);
      expect(stripNonce(regenerated[1]!), `slice ${call.slice}（${call.note}）`).toBe(
        stripNonce(call.promptText.user),
      );
    }
  });

  it('30b. 每条固化语料重新生成的工具 schema 与当时逐字保存的一致（形状也会漂）', () => {
    // 第三段。schema 是跟着请求一起发出去的，和提示词一样决定了 rawOutput 长
    // 什么样——改了它而语料不动，回放就在拿旧答案验新问题。`ref` 的 enum 按表
    // 生成，所以这一条同时钉住了"哪张表配哪份 schema"。
    //
    // 录下来的是当年真发出去的那一段字节，也就是 `openai-chat` 的写法；今天的
    // schema 是中立的 `ToolSpec`。所以比之前先过一道适配器——比的是 schema 的
    // 内容有没有漂，而不是它被谁包成了什么形状。语料一个字不改：它是一次真实
    // 请求的记录，重写它就等于把证据改成结论。
    for (const call of goldenGuideCalls) {
      const regenerated = guideAgent.outputSchema({
        goal: call.goal,
        table: TABLES[call.tableId],
        history: { done: [], route: [] },
      });
      const body = JSON.parse(openaiChat.prepare({ model: 'm', messages: [], tools: regenerated }).http.body!) as { tools: unknown };
      expect(JSON.stringify(body.tools), `slice ${call.slice}（${call.note}）`).toBe(call.promptText.tools);
    }
  });
});

/* ═══════════ 真实畸形输出：产品必须扛住的那两种 ═══════════ */

/**
 * A witness when one exists, never a requirement that one must.
 *
 * This suite used to open with `expect(malformedToolCalls.length).toBeGreaterThan(0)`,
 * and the capture that finally came back clean — 16 of 16 — turned it red.
 * Whether this endpoint drops a required field on capture day is the model's
 * behaviour, not a property of this codebase, and asserting it would mean
 * re-rolling until the model misbehaves. `contract.spec.ts`'s test 39 records
 * the same lesson about `shouldCountAsSensitiveProposed`; this is that lesson
 * applied a second time.
 */
describe('真实畸形工具调用（有就作证，没有不强求）', () => {
  it('30c. 每一条都被引导 agent 的解析如实拒掉，而不是崩掉或蒙混过关', () => {
    for (const bad of malformedToolCalls) {
      const r = guideAgent.parseOutput(bad.tool, bad.rawOutput);
      expect(r.kind, `slice ${bad.slice}（${bad.why}）`).toBe('error');
      if (r.kind === 'error') expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('30d. 拒绝的理由指得出具体是哪里不对，不是一句笼统的"解析失败"', () => {
    // 真机上排查全靠这句话。旧版这条测试假设固化时写下的 `why` 和解析器的措辞
    // 会对上——不会：有一条 arguments 是被截断的，裸 JSON.parse 判它"不是合法
    // JSON"（对），而 contract.ts 的截断修复路径捞回了一个残缺对象、报的是
    // "缺少 route"（也对）。要断言的从来不是措辞一致，而是**说得具体**。
    const GENERIC = '无法从模型输出中解析出合法 JSON（容错解析全部尝试失败）';
    const messages = malformedToolCalls.map((b) => {
      const r = guideAgent.parseOutput(b.tool, b.rawOutput);
      return r.kind === 'error' ? r.message : '';
    });
    for (const [i, msg] of messages.entries()) {
      const b = malformedToolCalls[i]!;
      expect(msg, `slice ${b.slice}（${b.why}）`).not.toBe('');
      // 具体 = 点得出是哪个字段、哪一层，或者干脆说清是 JSON 本身不合法。
      // `ref` 与「路径」也算：截断的那一条是被溯源扫描器（CONTEXT.md `Provenance`）拒的，
      // 它报的是「解析结果在路径『ref』处无法在原始输出中找到对应字面量」——
      // 点名到了字段，只是白名单当初没收这个词。
      expect(
        msg === GENERIC || /intent|route|question|options|via_ref|\bref\b|路径|why|JSON/.test(msg),
        `slice ${b.slice}：${msg}`,
      ).toBe(true);
    }
    // 不同的毛病不该报出同一句话。
    if (new Set(malformedToolCalls.map((b) => b.why)).size > 1)
      expect(new Set(messages).size).toBeGreaterThan(1);
  });
});

/* ═══════════ 重规划带上走过的路 ═══════════ */

describe('buildGuidePrompt — 历史摘要', () => {
  const t = TABLES['zh-console'];

  it('6. 两参调用（首次规划，无历史）→ 输出与不传第三个参数时逐字一致', () => {
    const withNothing = buildGuidePrompt('把这台实例删掉', t);
    const withUndefined = buildGuidePrompt('把这台实例删掉', t, undefined);
    const strip = (s: string) => s.replace(/nonce="[^"]+"/g, 'nonce="X"');
    expect(strip(withUndefined[1]!)).toBe(strip(withNothing[1]!));
    expect(withUndefined[0]!).toBe(withNothing[0]!);
  });

  it('7. 带历史 → user 消息里出现每一条的 title，且 goal 仍在最后', () => {
    const user = buildGuidePrompt('把这台实例删掉', t, {
      done: [
        { title: '实例列表', url: 'https://x.test/a', action: 'taken', effect: { kind: 'changed_in_place' } },
        { title: '删除实例', url: 'https://x.test/b' },
      ],
      route: [],
    })[1]!;

    expect(user).toContain('实例列表');
    expect(user).toContain('删除实例');
    // The ordering discipline `GOAL_LEAD_IN` exists for (context/user-message.ts's own doc
    // comment): the model answers in the language of whatever it read last,
    // so the goal stays the final thing in context — history must not push it
    // out of that position.
    expect(user.lastIndexOf('把这台实例删掉')).toBeGreaterThan(user.lastIndexOf('实例列表'));
  });

  it('8. 历史为空数组 → 不产出空的历史段落，与两参调用一致', () => {
    const strip = (s: string) => s.replace(/nonce="[^"]+"/g, 'nonce="X"');
    expect(strip(buildGuidePrompt('目标', t, { done: [], route: [] })[1]!)).toBe(
      strip(buildGuidePrompt('目标', t)[1]!),
    );
  });

  it('18. 照做了而这一页没变的那一步 → 用中文说清楚，但不说它是死控件', () => {
    // 旧的 `OUTCOME_TEXT` 曾经只有三个键，`failed` 不在其中，于是被原样
    // 渲染成英文单词 `failed`。模型读到的必须是一句能据以行动的话，否则它只会
    // 把同一步再给一遍——但也不能说成「推不动」：复制按钮、在新标签页打开的
    // 链接，做成了这一页也不变（t11 里这样记下的 9 步没有一个是死控件）。
    const user = buildGuidePrompt('目标', t, {
      done: [{ title: '搜索框', url: 'https://x.test/a', action: 'taken', effect: { kind: 'none' } }],
      route: [],
    })[1]!;

    expect(user).not.toContain('failed');
    expect(user).toContain('这一页没有变化');
    expect(user).not.toContain('推不动');
  });

  it('19. 上一步没走成时，不能说「用户已经照做并到了新的页面」', () => {
    // 那句开场白是写给「点了、页面真的换了」那一跳的。走不动的重规划读的是
    // 同一张表、同一页，照搬这句话等于告诉模型它已经前进了。
    const stuck = buildGuidePrompt('目标', t, {
      done: [{ title: '搜索框', url: 'https://x.test/a', action: 'taken', effect: { kind: 'none' } }],
      route: [{ at: '首页', goal: '打开搜索' }],
    })[1]!;
    expect(stuck).not.toContain('到了新的页面');
    // 路标本身还是要给的，否则模型每次都从零重新规划整条路。
    expect(stuck).toContain('打开搜索');

    const moved = buildGuidePrompt('目标', t, {
      done: [{ title: '搜索框', url: 'https://x.test/a', action: 'taken', effect: { kind: 'changed_in_place' } }],
      route: [{ at: '首页', goal: '打开搜索' }],
    })[1]!;
    expect(moved).toContain('到了新的页面');
  });

  it('17. 带上一次的 route → user 消息里出现上一次的路标文本', () => {
    const user = buildGuidePrompt('目标', t, {
      done: [{ title: '实例列表', url: 'https://x.test/a', action: 'taken', effect: { kind: 'changed_in_place' } }],
      route: [{ at: '实例列表页', goal: '找到目标实例' }],
    })[1]!;

    expect(user).toContain('实例列表页');
    expect(user).toContain('找到目标实例');
  });
});
