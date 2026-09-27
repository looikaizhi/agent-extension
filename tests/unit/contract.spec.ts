import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { scanProvenance } from '@/agent/envelope/scanner';
import { TABLES, goldenGuideCalls } from './fixtures/golden-guide-envelopes';

/**
 * `parseOutput` is the seam. Every test drives it end to
 * end through the raw string a model would actually emit — no internal
 * helper is imported or asserted on directly.
 *
 * Expected values are hand-derived from the raw fixture string, never from
 * running the parser and pasting its output.
 */

/**
 * An answer the way an endpoint actually reports one: the function the model
 * called, and the arguments text it wrote.
 *
 * The corpus below is written as whole envelopes, `intent` and all — which is
 * what a real `arguments` payload plus the function name amounts to — so the
 * intent is read off the text and handed over as the tool name, exactly as the
 * endpoint hands it over. There is no second door any more: the free-text
 * reader was deleted with the fallback that was its only caller.
 */
const intentIn = (raw: string) => /"intent"\s*:\s*"([^"]*)"/.exec(raw)?.[1] ?? '';
const readAnswer = (raw: string) => guideAgent.parseOutput(intentIn(raw), raw);

describe('读一个回答 — 结构 slice', () => {
  it('1. 紧凑合法 JSON，intent explain，answer/refs 逐路径核对 → ok', () => {
    const raw = '{"intent":"explain","answer":"点击右上角的按钮即可保存。","refs":["e12","e7"]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: {
        intent: 'explain',
        answer: '点击右上角的按钮即可保存。',
        refs: ['e12', 'e7'],
      },
    });
  });

  it('2. intent ask，options 里每个 ref/label 都能核对 → ok', () => {
    const raw =
      '{"intent":"ask","question":"您想找哪一个？","wants":"choice","options":[{"ref":"e3","label":"实例列表"},{"ref":"e9","label":"实例详情"}]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: {
        intent: 'ask',
        question: '您想找哪一个？',
        wants: 'choice',
        options: [
          { ref: 'e3', label: '实例列表' },
          { ref: 'e9', label: '实例详情' },
        ],
      },
    });
  });

  it('3. intent ask 要一段文字，options 是空数组 → ok', () => {
    const raw = '{"intent":"ask","question":"要查哪一台实例的配额？","wants":"text","options":[]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'ask', question: '要查哪一台实例的配额？', wants: 'text', options: [] },
    });
  });

  it('4. 包 ```json fence → fence 被剥离，正常解析', () => {
    const raw = '```json\n{"intent":"explain","answer":"是的","refs":[]}\n```';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: [] },
    });
  });

  it('5. 裸 ``` fence（无语言标注）→ 同样被剥离', () => {
    const raw = '```\n{"intent":"explain","answer":"是的","refs":[]}\n```';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: [] },
    });
  });

  it('6. 前后带说明文字 → 说明文字被丢弃，只取中间的对象', () => {
    const raw = '这是结果：\n{"intent":"explain","answer":"是的","refs":[]}\n如有其它需要请告诉我。';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: [] },
    });
  });

  it('7. 说明文字本身包含花括号 → 不误伤，仍然定位到真正的 JSON 候选', () => {
    const raw =
      '请参考 {某个占位符} 这样的写法。\n{"intent":"explain","answer":"是的","refs":[]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: [] },
    });
  });

  it('8. 对象/数组内出现尾逗号 → 容忍，正常解析', () => {
    const raw = '{"intent":"explain","answer":"是的","refs":["e1","e2",],}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: ['e1', 'e2'] },
    });
  });

  it('9. 输出在合法字符串闭合之后被截断（缺右括号）→ 括号平衡修复成功', () => {
    const raw = '{"intent":"explain","answer":"操作已完成","refs":["e1"]';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '操作已完成', refs: ['e1'] },
    });
  });

  it('10. 输出在字符串内部被截断（最后一个引号未闭合）→ 判 error，不猜测收尾', () => {
    // `refs` is written out *before* the truncated field on purpose: every
    // other required field for a recognizable ExplainEnvelope is already
    // complete before the cut, so if a bad implementation invented a closing
    // quote here it would produce a structurally valid, recognizable
    // envelope — the only thing that can legitimately turn this red is the
    // "never invent a string's ending" rule itself, not an incidentally
    // missing field.
    const raw = '{"intent":"explain","refs":[],"answer":"操作已完成，但是还没有说完这句话呢';
    const result = readAnswer(raw);
    expect(result.kind).toBe('error');
  });

  it("11. 单引号包裹字符串 → 判 error（不属于四种容错之一）", () => {
    const raw = "{'intent':'explain','answer':'是的','refs':[]}";
    const result = readAnswer(raw);
    expect(result.kind).toBe('error');
  });

  it('12. \\r\\n 行尾混入原始输出 → 不影响解析与 provenance 核对', () => {
    const raw = '{\r\n  "intent": "explain",\r\n  "answer": "是的",\r\n  "refs": ["e1"]\r\n}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '是的', refs: ['e1'] },
    });
  });

  it('13. 非 ASCII 被转义（\\uXXXX）→ provenance 用 jsonUnescape 等价判断，不是逐字子串', () => {
    // "中文一个按钮" escaped char by char via \uXXXX — hand-derived from the
    // Unicode code points, not produced by running any code:
    // 中=4e2d 文=6587 一=4e00 个=4e2a 按=6309 钮=94ae
    const raw = '{"intent":"explain","answer":"\\u4e2d\\u6587\\u4e00\\u4e2a\\u6309\\u94ae","refs":[]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: '中文一个按钮', refs: [] },
    });
  });

  it('14. 路径混淆攻击：question 与 options[0].label 的取值互换 → provenance 判失败', () => {
    // the parser itself is honest by construction (it only ever builds
    // `parsed` via `JSON.parse` on text sliced out of `raw`, so there is no
    // code path inside it that could swap two fields' values) — so the only
    // way to exercise the scanner's *defense* against this class of L-4 is
    // to call it directly with a `parsed` value that a hypothetically buggy
    // parser produced: both strings genuinely occur in `raw`, each at its
    // own correct path, but `parsed` below has them swapped onto each
    // other's paths. A scanner that only asked "does this string occur
    // *somewhere* in raw" would wrongly accept this; a per-path scanner must
    // reject it, because at path `question` raw actually says "请选择目标实例",
    // not "找到哪一个".
    const raw =
      '{"intent":"ask","question":"请选择目标实例","wants":"choice","options":[{"ref":"e3","label":"找到哪一个"}]}';
    const parsed = {
      intent: 'ask',
      question: '找到哪一个',
      wants: 'choice',
      options: [{ ref: 'e3', label: '请选择目标实例' }],
    };
    expect(scanProvenance(raw, parsed)).not.toBeNull();
  });

  it('15. duplicate key → 取最后一个，且 provenance 核对的是最后一个字面量', () => {
    const raw = '{"intent":"explain","answer":"A","answer":"B","refs":[]}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'explain', answer: 'B', refs: [] },
    });
  });

  // Nothing names which field of the three QA envelopes is "optional" —
  // none of the three envelopes' documented fields are marked optional in
  // the shape table. `ExplainEnvelope.refs` is the most defensible reading:
  // §5.4 of the design doc treats an empty/absent ref list as ordinary ("两者
  // 皆空时界面标注「本次未使用页面内容」"), so a model declining to name any
  // evidence is a legitimate answer, not a malformed one. This is a judgment
  // call flagged in the task report, not something the plan pinned down.
  it('16a. refs 为 null 与 refs 整体缺失 → 两种输入产出等价的解析结果', () => {
    const withNull = readAnswer('{"intent":"explain","answer":"是的","refs":null}');
    const withoutField = readAnswer('{"intent":"explain","answer":"是的"}');
    const expected = { kind: 'ok', envelope: { intent: 'explain', answer: '是的', refs: [] } };
    expect(withNull).toEqual(expected);
    expect(withoutField).toEqual(expected);
  });

  // Slice 17 used to pin "S1 does not recognise `guide`" — that was S1's
  // actual scope boundary. The guide path widens the recognised shapes; the
  // shape it answers with is now `point`, one step at a time. Full coverage
  // lives in the "point/read_doc 识别" describe block below; this slice stays
  // here only so its number/history is legible.
  it('17. intent 是 point（结构合法，字段齐全）→ 经引导 agent 识别为 ok（point 归引导 agent，见下方 point/read_doc 识别 slice）', () => {
    const raw = '{"intent":"point","route":[{"at":"实例列表","goal":"找到目标实例"}],"ref":"e04","action":"click","why":"列表里的目标实例"}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'point', route: [{ at: '实例列表', goal: '找到目标实例' }], ref: 'e04', action: 'click', why: '列表里的目标实例' },
    });
  });



  // 「少了 intent」「intent 不是字符串」这两种从前的读法，在工具路径上不存在了：
  // intent 就是端点报回来的函数名。剩下的一种——名字本身不认得——还在，就是下面两条。
  it('18c. intent 是 S1 三种之外的任意值（如 locate）→ error', () => {
    const result = readAnswer('{"intent":"locate","answer":"是的","citations":[]}');
    expect(result.kind).toBe('error');
  });

  it('18d. intent 拼写错误 → error', () => {
    const result = readAnswer('{"intent":"explaim","answer":"是的","refs":[]}');
    expect(result.kind).toBe('error');
  });

  it('19a. explain 缺少 answer → error', () => {
    const result = readAnswer('{"intent":"explain","refs":[]}');
    expect(result.kind).toBe('error');
  });

  it('19b. ask 缺少 question → error', () => {
    const result = readAnswer('{"intent":"ask","wants":"text","options":[]}');
    expect(result.kind).toBe('error');
  });

  it('19c. ask 缺少 options → error', () => {
    const result = readAnswer('{"intent":"ask","question":"您想找哪一个？","wants":"choice"}');
    expect(result.kind).toBe('error');
  });

  it('19d. ask 的 wants 不在 choice / text 之内 → error', () => {
    const result = readAnswer('{"intent":"ask","question":"您想找哪一个？","wants":"either","options":[]}');
    expect(result.kind).toBe('error');
  });
});

/**
 * The guide path's scope: `point`/`read_doc` recognition is
 * *structural only* here (see the file-level doc comment in `contract.ts`).
 * None of these slices check that a `ref` exists on any table or that
 * `action` is a member of `UserAction` — those are R-a…R-e, `validate.ts`'s
 * job, not the parser's.
 */
describe('引导 agent — point/read_doc 识别（引导路径）', () => {
  it('20. point 合法：route 多项，expect_after 齐全（via_ref + must_contain）→ ok，逐字段核对', () => {
    const raw =
      '{"intent":"point","route":[{"at":"实例列表","goal":"找到目标实例"},{"at":"实例详情","goal":"绑定公网地址"}],' +
      '"ref":"e04","action":"click","why":"列表里的目标实例","expect_after":{"via_ref":"e04","must_contain":{"role":"button","name":"绑定弹性公网IP"}}}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: {
        intent: 'point',
        route: [
          { at: '实例列表', goal: '找到目标实例' },
          { at: '实例详情', goal: '绑定公网地址' },
        ],
        ref: 'e04',
        action: 'click',
        why: '列表里的目标实例',
        expect_after: { via_ref: 'e04', must_contain: { role: 'button', name: '绑定弹性公网IP' } },
      },
    });
  });

  it('21. point 合法：route 为空数组（一页就能完成的目标）、expect_after 整体缺失 → ok', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":"click","why":"就是这个按钮"}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'point', route: [], ref: 'e1', action: 'click', why: '就是这个按钮' },
    });
  });

  it('22. point expect_after 有 via_ref 但没有 must_contain（must_contain 可选）→ ok', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":"click","why":"就是这个按钮","expect_after":{"via_ref":"e1"}}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'point', route: [], ref: 'e1', action: 'click', why: '就是这个按钮', expect_after: { via_ref: 'e1' } },
    });
  });

  it('24. point route 不是数组（写成对象）→ error', () => {
    const raw = '{"intent":"point","route":{"at":"设置","goal":"找入口"},"ref":"e1","action":"click","why":"理由"}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('25. point 的 value 不是字符串（写成数字）→ error，不强行转成字符串', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":"input","why":"理由","value":7}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('26. point 缺少 ref → error', () => {
    const raw = '{"intent":"point","route":[],"action":"click","why":"理由"}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('27. point 的 action 不是字符串（写成数字）→ error', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":1,"why":"理由"}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('28. point 缺少 why → error', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":"click"}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('29. point route[i] 缺少 goal → error', () => {
    const raw = '{"intent":"point","route":[{"at":"设置"}],"ref":"e1","action":"click","why":"理由"}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('30. point expect_after.via_ref 不是字符串 → error', () => {
    const raw = '{"intent":"point","route":[],"ref":"e1","action":"click","why":"理由","expect_after":{"via_ref":7}}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  it('30b. 字段顺序不影响解析——schema 里 why 排在 ref 之前，解析器不能因此变脸', () => {
    // 09 号票把 `why` 提到 `ref` 前面，因为模型是按 schema 顺序逐字段写的，
    // 先写 ref 就等于先承诺再找理由。解析器**从来**不该依赖顺序，这条把它钉住：
    // 同一份内容换两种字段顺序，解析结果必须逐字段相等。
    const reasonFirst = '{"intent":"point","route":[],"why":"理由","ref":"e1","action":"click","value":null,"expect_after":null}';
    const refFirst = '{"intent":"point","route":[],"ref":"e1","action":"click","value":null,"why":"理由","expect_after":null}';
    const a = readAnswer(reasonFirst);
    const b = readAnswer(refFirst);
    expect(a.kind).toBe('ok');
    expect(a).toEqual(b);
  });

  it('31. point expect_after.must_contain 只给 role、name 为空 → 接受，但那条期望不作数', () => {
    // 曾经判 error。改掉的理由是一条真机输出：模型写了
    // `{"role":"link","name":null}` ——strict 模式逼它每个属性都得出现，而它
    // 确实不知道落地控件叫什么。为这一个字段丢掉整封信是错的方向；
    // 更清楚地说：编造的期望比没有期望更糟，逼它填名字就是在请它编。
    // 所以解析接受，`judgeArrival` 那边记 `skipped`（validate.spec 有断言），
    // 而不是拿「这页上有没有任何一个 link」冒充一次通过。
    for (const mc of ['{"role":"button"}', '{"role":"button","name":null}']) {
      const raw = `{"intent":"point","route":[],"ref":"e1","action":"click","why":"理由","expect_after":{"via_ref":"e1","must_contain":${mc}}}`;
      const r = readAnswer(raw);
      expect(r.kind, mc).toBe('ok');
      if (r.kind === 'ok' && r.envelope.intent === 'point') expect(r.envelope.expect_after!.must_contain).toEqual({ role: 'button' });
    }
  });

  it('31b. must_contain.role 也可以是 null —— 那整条期望就不作数，而不是整封信作废', () => {
    // 两轮真机里最大的单一浪费源：第三轮 12 次解析失败里 9 次、第四轮 20 次里
    // 13 次，都是模型写了 `{"role":null,"name":null}`。strict 模式逼它把每个
    // 属性都写出来，而它对落地页的角色确实没有把握——于是整封本来完全合法的
    // 信被丢掉，那一轮的引导原地停住，用户只看到一句「模型输出无法解析」。
    //
    // 这和上一条 `name` 是同一个论证：编造的期望比没有期望更糟。
    for (const mc of ['{"role":null,"name":null}', '{"role":null,"name":"确定"}']) {
      const raw = `{"intent":"point","route":[],"ref":"e1","action":"click","why":"理由","expect_after":{"via_ref":"e1","must_contain":${mc}}}`;
      const r = readAnswer(raw);
      expect(r.kind, mc).toBe('ok');
      // 整条 must_contain 消失：没有 role 就没有可核对的形状，留半条比没有更糟。
      if (r.kind === 'ok' && r.envelope.intent === 'point') {
        expect(r.envelope.expect_after!.via_ref).toBe('e1');
        expect(r.envelope.expect_after!.must_contain).toBeUndefined();
      }
    }
  });

  it('31c. role 是数字这类真正的类型错误照旧判 error —— 放宽的只有 null', () => {
    const raw =
      '{"intent":"point","route":[],"ref":"e1","action":"click","why":"理由","expect_after":{"via_ref":"e1","must_contain":{"role":7,"name":null}}}';
    expect(readAnswer(raw).kind).toBe('error');
  });

  // read_doc belongs to the guide agent's own module, so it is read and checked
  // through the guide agent — the shared contract no longer knows it.
  it('32. read_doc 合法：via_ref + query 都是字符串 → ok，逐字段核对', () => {
    const raw = '{"intent":"read_doc","via_ref":"e88","query":"两步验证的验证码多久过期"}';
    const result = readAnswer(raw);
    expect(result).toEqual({
      kind: 'ok',
      envelope: { intent: 'read_doc', via_ref: 'e88', query: '两步验证的验证码多久过期' },
    });
  });

  it('33. read_doc 缺少 via_ref → error', () => {
    const result = readAnswer('{"intent":"read_doc","query":"两步验证的验证码多久过期"}');
    expect(result.kind).toBe('error');
  });

  it('34. read_doc 缺少 query → error', () => {
    const result = readAnswer('{"intent":"read_doc","via_ref":"e88"}');
    expect(result.kind).toBe('error');
  });

  it('35. read_doc via_ref 不是字符串（写成数字）→ error', () => {
    const result = readAnswer('{"intent":"read_doc","via_ref":88,"query":"配额是多少"}');
    expect(result.kind).toBe('error');
  });

  it('36. point 路径混淆攻击：why 与 route[0].goal 的取值互换 → provenance 判失败（同 14 号 slice 的手法，验证 point 形状同样受保护）', () => {
    const raw = '{"intent":"point","route":[{"at":"实例列表","goal":"找到目标实例"}],"ref":"e04","action":"click","why":"绑定公网地址"}';
    // Both strings genuinely occur in `raw`, each at its own correct path —
    // `parsed` below has them swapped onto each other's paths, exactly as
    // slice 14 does for the ask shape.
    const parsed = { intent: 'point', route: [{ at: '实例列表', goal: '绑定公网地址' }], ref: 'e04', action: 'click', why: '找到目标实例' };
    expect(scanProvenance(raw, parsed)).not.toBeNull();
  });
});

/**
 * Replays every real-model transcript `golden-guide-envelopes.ts` recorded
 * for the guide-envelope spike (`tests/spike/guide-envelope-smoke.mjs`) through the real the parser — zero
 * network, the fixture's `rawOutput` is a frozen copy of what DeepSeek
 * actually said. This is what "每条固化语料都能独立核对来源" cashes out to at
 * the the parser layer: every entry this task judged "合法且值得固化"
 * must still parse to the intent its `annotation.expectedIntent` records,
 * and every `point` entry's `ref` must still resolve against the table it was
 * actually run on exactly the way `annotation` says it does.
 */
describe('读一个回答 — golden-guide-envelopes.ts 回放（真实模型语料，零网络）', () => {
  it('37. 每条固化语料的 rawOutput 都解析得出 ok，且 intent 与人工标注一致', () => {
    for (const call of goldenGuideCalls) {
      const result = guideAgent.parseOutput(call.tool, call.rawOutput);
      expect(result.kind, `slice ${call.slice}（${call.note}）：${call.rawOutput}`).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.envelope.intent, `slice ${call.slice}（${call.note}）`).toBe(call.annotation.expectedIntent);
      }
    }
  });

  it('38. 每条 point 语料的 ref 都能在其当时使用的表里核对：存在、非 sensitive，与标注的 expectedFirstStepBinding 一致', () => {
    for (const call of goldenGuideCalls) {
      if (call.annotation.expectedFirstStepBinding === null) continue; // 非 point，没有那一步
      const result = guideAgent.parseOutput(call.tool, call.rawOutput);
      if (result.kind !== 'ok' || result.envelope.intent !== 'point') throw new Error(`slice ${call.slice}：预期 point，实际 ${result.kind}`);
      const table = TABLES[call.tableId];
      const firstRef = result.envelope.ref;
      const item = table.items.find((i) => i.ref === firstRef);
      if (call.annotation.expectedFirstStepBinding === 'bound') {
        expect(item, `slice ${call.slice}（${call.note}）：ref「${firstRef}」应在表内`).toBeDefined();
        expect(item?.sensitive, `slice ${call.slice}（${call.note}）：ref「${firstRef}」不应是 sensitive`).not.toBe(true);
      }
    }
  });

  it('39. 每条标注为 shouldCountAsSensitiveProposed 的语料，其声明的 ref 集合里确实至少有一个指向当前表的 sensitive 元素（正例语料本身是诚实的）', () => {
    // Guards the annotation against fabrication: anything marked `true` must
    // really claim a sensitive ref. It used to also require the corpus to
    // contain at least one such case — but whether the model takes slice 7's
    // bait is the model's behaviour on capture day, not a property of this
    // codebase, and the 2026-08-19 re-capture produced none at all. Requiring
    // it would mean re-rolling the dice until the model misbehaves. R-e itself
    // is covered by hand-written cases in validate.spec.ts; this corpus is a
    // witness when one happens to exist, never the only one.
    const positives = goldenGuideCalls.filter((c) => c.annotation.shouldCountAsSensitiveProposed);
    for (const call of positives) {
      const result = guideAgent.parseOutput(call.tool, call.rawOutput);
      if (result.kind !== 'ok') throw new Error(`slice ${call.slice}：预期 ok`);
      const table = TABLES[call.tableId];
      const claimedRefs =
        result.envelope.intent === 'point'
          ? [result.envelope.ref]
          : result.envelope.intent === 'ask'
            ? result.envelope.options.map((o) => o.ref)
            : result.envelope.intent === 'read_doc'
              ? [result.envelope.via_ref]
              : [];
      const hitsSensitive = claimedRefs.some((ref) => table.items.find((i) => i.ref === ref)?.sensitive === true);
      expect(hitsSensitive, `slice ${call.slice}（${call.note}）：标注为正例但未命中任何 sensitive ref`).toBe(true);
    }
  });
});

describe('读一个回答 · 形状不合时要说得出是哪儿不合', () => {
  // 一句「无法识别为 S1 已知的信封形状（…explain/clarify/need_text 之内）」曾经
  // 同时对应「少了 why」「字段名写错」「route 缺 goal」三种完全不同的原因，而且
  // 那串 intent 早就过时了——`guide`/`read_doc`/`done` 也认得。真机上有引导因此
  // 死在第 0 跳，而这句话把排查引向了一个并不存在的路由问题。
  const parseErr = (v: unknown) => {
    const r = readAnswer(JSON.stringify(v));
    return r.kind === 'error' ? r.message : '(意外解析成功)';
  };
  const guideErr = parseErr;
  const GOOD_POINT = { intent: 'point', route: [{ at: '首页', goal: '找仓库' }], ref: 'e1', action: 'click', why: '点搜索' };

  it('A. 这一步少了字段 → 指名少了哪个字段', () => {
    const { why: _drop, ...noWhy } = GOOD_POINT;
    expect(guideErr(noWhy)).toContain('why');
  });

  it('B. route 里某一跳少了字段 → 指名是第几跳、少了哪个字段', () => {
    const msg = guideErr({ ...GOOD_POINT, route: [{ at: '首页' }] });
    expect(msg).toContain('route[0]');
    expect(msg).toContain('goal');
  });

  it('C. intent 不认识 → 列出真实认得的那几种,而不是过时的三种', () => {
    const msg = parseErr({ ...GOOD_POINT, intent: 'navigate' });
    expect(msg).toContain('navigate');
    for (const known of ['point', 'ask', 'explain', 'observe', 'wait_for', 'read_doc', 'done']) expect(msg).toContain(known);
    for (const gone of ['clarify', 'need_text']) expect(msg).not.toContain(gone);
  });

  it('C2. 列出来的顺序固定：登记处的顺序——这句话会写进修复请求发给模型', () => {
    const LISTED = '认得的有：point / ask / explain / observe / wait_for / read_doc / done';
    expect(parseErr({ ...GOOD_POINT, intent: 'navigate' })).toContain(LISTED);
    const viaTool = guideAgent.parseOutput('navigate', '{}');
    expect(viaTool.kind === 'error' && viaTool.message).toContain(LISTED);
  });

});
