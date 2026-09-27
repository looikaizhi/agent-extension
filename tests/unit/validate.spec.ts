import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { ReadDocEnvelope } from '@/agent/tools/read-doc';
import { judgeArrival } from '@/agent/thread/judge';
import type { ExplainEnvelope } from '@/agent/agents/guide/output/explain';
import type { AskEnvelope } from '@/agent/agents/guide/output/ask';
import { toGuideStep, type PointEnvelope } from '@/agent/agents/guide/output/point';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { UserAction } from '@/shared/protocol';
import type { Ref } from '@/shared/types';
import { bindStep, descriptorOf } from '@/core/descriptor/bind';
import { goldenGuideCalls, TABLES } from './fixtures/golden-guide-envelopes';

/**
 * Each agent's `validate` is the seam: the last gate between a
 * model's envelope and the renderer. Fixtures here are hand-written — no
 * fixture is ever produced by calling the parser.
 */

type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

function table(items: ItemSpec[]): PromptTable {
  return {
    snapshotId: 's1',
    url: 'https://example.test/',
    title: 't',
    structureHash: 'h',
    omitted: 0,
    degraded: false,
    ambiguity: 0,
    stats: {
      elementsScanned: 0,
      candidates: 0,
      visible: 0,
      emitted: 0,
      shadowRoots: 0,
      emptyName: 0,
      modalScoped: false,
      ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
    },
    items: items.map((i) => ({
      ref: i.ref as unknown as Ref,
      role: i.role,
      name: i.name,
      path: i.path ?? [],
      ...(i.sensitive ? { sensitive: true as const } : {}),
    })),
  };
}

describe('agent 的校验 — explain / R-a', () => {
  it('1. refs: [] → ok', () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Save' }]);
    const envelope: ExplainEnvelope = { intent: 'explain', answer: '页面上没有直接依据。', refs: [] };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('2. refs 里的 ref 都在快照里 → ok，且返回的 envelope 与输入逐字段相同（同一个引用，不是拷贝）', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Save' },
      { ref: 'e2', role: 'textbox', name: 'Name' },
    ]);
    const envelope: ExplainEnvelope = { intent: 'explain', answer: '点击保存按钮。', refs: ['e1', 'e2'] as Ref[] };
    const result = guideAgent.validate(envelope, t);
    expect(result).toEqual({ kind: 'ok', envelope });
    // Identity, not equality: this layer must not clip/rebuild the envelope.
    expect(result.kind === 'ok' && result.envelope).toBe(envelope);
  });

  it('3. refs 里有一个 ref 不在快照里 → violation', () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Save' }]);
    const envelope: ExplainEnvelope = {
      intent: 'explain',
      answer: '点击保存按钮。',
      refs: ['e1', 'e99'] as Ref[],
    };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });
});

describe('agent 的校验 — ask / R-a', () => {
  it('4. options 全部 ref 都在快照里 → ok', () => {
    const t = table([
      { ref: 'e1', role: 'link', name: '实例列表' },
      { ref: 'e2', role: 'link', name: '实例详情' },
    ]);
    const envelope: AskEnvelope = {
      intent: 'ask',
      question: '您想找哪一个？',
      wants: 'choice',
      options: [
        { ref: 'e1' as Ref, label: '实例列表' },
        { ref: 'e2' as Ref, label: '实例详情' },
      ],
    };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('5. options 里有一个 ref 不在快照里 → violation（整体拒绝，不是把那一项过滤掉）', () => {
    const t = table([{ ref: 'e1', role: 'link', name: '实例列表' }]);
    const envelope: AskEnvelope = {
      intent: 'ask',
      question: '您想找哪一个？',
      wants: 'choice',
      options: [
        { ref: 'e1' as Ref, label: '实例列表' },
        { ref: 'e99' as Ref, label: '不存在的选项' },
      ],
    };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });

  it('6. options: [] → ok（空集合上「每一个元素都满足条件」是真命题，不是需要特殊拒绝的边界）', () => {
    const t = table([{ ref: 'e1', role: 'link', name: '实例列表' }]);
    const envelope: AskEnvelope = { intent: 'ask', question: '现在有多个入口，您说的是哪一个？', wants: 'text', options: [] };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  // 「你要点下面这个按钮吗？」+ 只列出那一个按钮。那不是让用户选，是替他确认——
  // 而这个产品从不代点，指出来本来就是安全的动作。白花一次往返。
  it('6b. wants=choice 却只列出一个候选 → violation，并且话里指出该改用 point', () => {
    const t = table([{ ref: 'e1', role: 'button', name: '删除实例' }]);
    const envelope: AskEnvelope = {
      intent: 'ask',
      question: '你要点下面这个按钮吗？',
      wants: 'choice',
      options: [{ ref: 'e1' as Ref, label: '删除实例' }],
    };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
    expect(result.kind === 'violation' && result.reason).toContain('point');
  });

  it('6c. 两个候选照旧放行——有歧义时问是它该做的事', () => {
    const t = table([
      { ref: 'e1', role: 'link', name: '实例 A' },
      { ref: 'e2', role: 'link', name: '实例 B' },
    ]);
    const envelope: AskEnvelope = {
      intent: 'ask',
      question: '你说的是哪一台？',
      wants: 'choice',
      options: [
        { ref: 'e1' as Ref, label: '实例 A' },
        { ref: 'e2' as Ref, label: '实例 B' },
      ],
    };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('6d. wants=text 时一个候选都不列，照旧放行——那一条只管 choice', () => {
    const t = table([{ ref: 'e1', role: 'button', name: '删除实例' }]);
    const envelope: AskEnvelope = { intent: 'ask', question: '要删哪一台？', wants: 'text', options: [] };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });
});

describe('agent 的校验 — R-e（sensitive）', () => {
  it('8. explain 的 refs 里有一个 ref 指向 sensitive 元素 → violation，即使 refs 里还有其它合法 ref', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Save' },
      { ref: 'e2', role: 'textbox', name: '密码', sensitive: true },
    ]);
    const envelope: ExplainEnvelope = {
      intent: 'explain',
      answer: '先点保存，密码框里填入你的密码。',
      refs: ['e1', 'e2'] as Ref[],
    };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });

  it('9. ask 的 options 里有一项指向 sensitive 元素 → violation，即使其它选项合法', () => {
    const t = table([
      { ref: 'e1', role: 'link', name: '实例列表' },
      { ref: 'e2', role: 'textbox', name: '验证码', sensitive: true },
    ]);
    const envelope: AskEnvelope = {
      intent: 'ask',
      question: '您想找哪一个？',
      wants: 'choice',
      options: [
        { ref: 'e1' as Ref, label: '实例列表' },
        { ref: 'e2' as Ref, label: '验证码输入框' },
      ],
    };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });
});

describe('引导 agent 的校验 — 形状不全、或不是它的 intent', () => {
  it("10. 形状不全的 point（没有 ref、没有 action）直接交给引导 agent 的校验 → violation，不会崩", () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Save' }]);
    // Constructed directly, to prove the gate does not depend on recognition
    // ever having accepted this shape.
    const envelope = { intent: 'point', route: [], why: '保存' };
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });

  it("11. intent: 'locate'（S6 形状，仍不在 S1/S2 范围内）→ violation", () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Save' }]);
    const locate = { intent: 'locate', query: '保存按钮在哪' };
    expect(guideAgent.validate(locate, t).kind).toBe('violation');
  });
});

/**
 * The guide path's self-consistency rules (design doc §5.6). `PointEnvelope`/`ReadDocEnvelope` fixtures below are
 * hand-written per this file's Seam comment (no the parser in the loop)
 * — except the "golden corpus replay" describe block at the bottom, which is
 * the one deliberate exception the task calls for: the real-model corpus
 * replayed through this file's actual rules.
 */
describe('引导 agent 的校验 — point / R-a…R-e', () => {
  it('12. ref 在快照内、action 合法 → ok', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }]);
    const envelope: PointEnvelope = {
      intent: 'point',
      route: [{ at: '实例操作区域', goal: '删除这台实例' }],
      ref: 'e8' as Ref,
      action: 'click',
      why: '点击删除实例按钮以发起删除操作',
    };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('14. ref 不在快照的 ref 集合内 → violation（R-a）', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e99' as Ref, action: 'click', why: '不存在的 ref' };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });

  it('15. action 是枚举外的字符串 → violation（R-d），不静默映射到最接近的枚举值', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e8' as Ref, action: 'tap', why: '英文接口下常见的越界动作词' };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });

  it('16. ref 指向 sensitive 元素 → violation（R-e）', () => {
    const t = table([
      { ref: 'e4', role: 'textbox', name: '显示名称' },
      { ref: 'e6', role: 'textbox', name: '当前密码', sensitive: true },
    ]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e6' as Ref, action: 'input', why: '诱导填写敏感字段' };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });

  it('16c. 同时违反 R-a 与 R-d → 报 R-a：两个 agent 共用的规矩先跑（decisions.md 记着这处有意的先后）', () => {
    const t = table([{ ref: 'e1', role: 'button', name: '保存' }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e99' as Ref, action: 'tap', why: '表里没有的控件，还用了清单外的动作' };
    const r = guideAgent.validate(envelope, t);
    expect(r.kind).toBe('violation');
    if (r.kind === 'violation') {
      expect(r.reason).toContain('e99');
      expect(r.reason).not.toContain('tap');
    }
  });

  it('17. route 里任意字符串，不受 ref 校验 → ok（确认 route 确实不参与 R-a，§1.3）', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = {
      intent: 'point',
      route: [{ at: '一个不存在于表里的页面 e999', goal: '编造的目标 e888，随便写' }],
      ref: 'e8' as Ref,
      action: 'click',
      why: '合法步骤',
    };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('18. expect_after 缺失 → ok（可选字段，缺失不是错误）', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e8' as Ref, action: 'click', why: '合法步骤' };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('19. expect_after.via_ref 不在快照内 → violation（同 R-a 的判断范围，与 ref 是同一类需要核对的字段）', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = {
      intent: 'point',
      route: [],
      ref: 'e8' as Ref,
      action: 'click',
      why: '合法步骤',
      expect_after: { via_ref: 'e999' as Ref },
    };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });
});

describe('引导 agent 的校验 — 点一下输入框不是一步', () => {
  /**
   * 真机 21 轮里两轮死在这个形状上（P1-1、P2-3），第三轮还有一次（P3-6）。三
   * 次的 `why` 都写着「在搜索框输入 …」，emit 出来的却是一个孤零零的 click。
   * 点文本框不会让页面动，也就没有任何东西会唤起下一次调用——所以这一步在发
   * 给用户之前就该被拦下来，让修复轮把它改成 input。
   *
   * 判据只看表里的 role，不猜意图。`<select>` 在 HTML-AAM 里也映射成
   * `combobox`（`resolveRole` 用的就是 dom-accessibility-api 的实现），所以
   * 补救动作接受 `input` 和 `select` 两种。
   */
  const SEARCH = table([
    { ref: 'e1', role: 'combobox', name: 'Search or jump to' },
    { ref: 'e2', role: 'listbox', name: 'Search suggestions' },
    { ref: 'e3', role: 'button', name: 'Give feedback' },
  ]);

  it('R-f-1. combobox 上一个孤零零的 click → violation，理由说清楚缺的是什么', () => {
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e1' as Ref, action: 'click', why: '打开搜索框后填入仓库名' };
    const result = guideAgent.validate(envelope, SEARCH);
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.reason).toContain('e1');
      expect(result.reason).toContain('input');
    }
  });

  it('R-f-6. 只点一个敏感输入框 → 报敏感（R-e），绝不说成「改成 input」', () => {
    // 这条规矩排在 R-e 之后才对：对一个密码框说「改成 input」，等于把修复轮
    // 往填密码那边推。
    const t = table([{ ref: 'e6', role: 'textbox', name: '当前密码', sensitive: true }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e6' as Ref, action: 'click', why: '点开密码框' };
    const r = guideAgent.validate(envelope, t);
    expect(r.kind).toBe('violation');
    if (r.kind === 'violation') {
      expect(r.reason).toContain('敏感');
      expect(r.reason).not.toContain('input');
    }
  });

  it('R-f-2. 对同一个控件给 input 或 select → 放行', () => {
    const typed: PointEnvelope = { intent: 'point', route: [], ref: 'e1' as Ref, action: 'input', value: 'n8n-io/n8n', why: '输入仓库名' };
    const picked: PointEnvelope = { intent: 'point', route: [], ref: 'e1' as Ref, action: 'select', value: '最近一周', why: '选中区间' };
    expect(guideAgent.validate(typed, SEARCH).kind).toBe('ok');
    expect(guideAgent.validate(picked, SEARCH).kind).toBe('ok');
  });

  it('R-f-4. 点的是别的控件 → 与这条规则无关', () => {
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e2' as Ref, action: 'click', why: '点搜索建议列表' };
    expect(guideAgent.validate(envelope, SEARCH).kind).toBe('ok');
  });
});

describe('引导 agent 的校验 — read_doc / R-a…R-e', () => {
  // read_doc belongs to the guide agent's own module, so it is read and checked
  // through the guide agent — the shared contract no longer knows it.

  it("20. via_ref 在快照内且非 sensitive → ok", () => {
    const t = table([{ ref: 'e14', role: 'link', name: '帮助文档' }]);
    const envelope: ReadDocEnvelope = { intent: 'read_doc', via_ref: 'e14' as Ref, query: '两步验证的验证码多久过期' };
    expect(guideAgent.validate(envelope, t)).toEqual({ kind: 'ok', envelope });
  });

  it('21. via_ref 不在快照内 → violation（R-a）', () => {
    const t = table([{ ref: 'e14', role: 'link', name: '帮助文档' }]);
    const envelope: ReadDocEnvelope = { intent: 'read_doc', via_ref: 'e999' as Ref, query: '任意问题' };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });

  it('15b. must_contain 只给 role → judgeArrival 记 skipped，不拿一次必然通过的检查冒充 pass', () => {
    // 「这页上有没有任何一个 link」在几乎每一页都成立。让它算 pass，`Check`
    // 这条轴上的 pass 就不再是证据。模型诚实地说不出名字，我们就诚实地不打分。
    const t = table([{ ref: 'e1', role: 'link', name: '设置' }]);
    expect(judgeArrival({ via_ref: 'e1' as Ref, must_contain: { role: 'link' } }, t)).toBe('skipped');
    expect(judgeArrival({ via_ref: 'e1' as Ref, must_contain: { role: 'link', name: '设置' } }, t)).toBe('pass');
    expect(judgeArrival({ via_ref: 'e1' as Ref, must_contain: { role: 'link', name: '别的' } }, t)).toBe('unknown');
  });

  it('16b. action 是 observe → violation：模型不许提一个没有完成信号的动作', () => {
    // `observe` 仍是合法的 `UserAction`（问答路径自己构造的步骤用它），但它
    // 不在模型可提的集合里。它是唯一一个 `presenter.ts` 的 ADVANCING_ACTIONS
    // 不认的动作，observe 这一步会把线程冻死——真机 7 次里 4 次它其实想说
    // 的是 done。schema 的 enum 是第一道，这里是第二道。
    const t = table([{ ref: 'e1', role: 'button', name: '保存' }]);
    const envelope: PointEnvelope = {
      intent: 'point',
      route: [{ at: '实例操作', goal: '看看这一页' }],
      ref: 'e1' as Ref,
      action: 'observe' as UserAction,
      why: '先看一眼',
    };
    const r = guideAgent.validate(envelope, t);
    expect(r.kind).toBe('violation');
    if (r.kind === 'violation') expect(r.reason).toContain('observe');
  });

  it('22. via_ref 指向 sensitive 元素 → violation（R-e）', () => {
    const t = table([{ ref: 'e6', role: 'textbox', name: '当前密码', sensitive: true }]);
    const envelope: ReadDocEnvelope = { intent: 'read_doc', via_ref: 'e6' as Ref, query: '密码规则是什么' };
    expect(guideAgent.validate(envelope, t).kind).toBe('violation');
  });
});

describe('toGuideStep — §5.5 的映射（S2 slice 9/10）', () => {
  it('23. 映射出的 descriptor 与直接调用 descriptorOf(item) 对同一个 PromptItem 的结果一致', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例', path: ['实例操作'] }]);
    const result = toGuideStep({ ref: 'e8' as Ref, action: 'click', why: '点击删除实例按钮以发起删除操作' }, t);
    // 模型的信封与运行时 GuideStep 不是同一个形状——逐字段核对来源，而不是
    // 整体 toEqual 一个手写对象（那样会掩盖"descriptor 到底是不是反查出来的"
    // 这件事）。
    expect(result.descriptor).toEqual(descriptorOf(t.items[0]!));
    expect(result.ref).toBe('e8');
    expect(result.expectedUserAction).toBe('click');
    expect(result.title).toBe('删除实例'); // item.name || item.role
    expect(result.detail).toBe('点击删除实例按钮以发起删除操作'); // 模型的 why
  });

  it('24. action 越出 UserAction 的情形不会走到 toGuideStep——R-d 已经在它之前拒绝了整条信封', () => {
    const t = table([{ ref: 'e8', role: 'button', name: '删除实例' }]);
    const envelope: PointEnvelope = { intent: 'point', route: [], ref: 'e8' as Ref, action: 'tap', why: '越界动作' };
    // 引导 agent 的 validate 是 toGuideStep 唯一合法的上游守门人（Seam）：R-d 已经
    // 把这条信封整体判 violation，因此调用方从不会走到 toGuideStep——它不需要、
    // 也没有自己的 actionForRole 兜底分支去处理一个理论上不该出现在它面前的越界 action。
    const result = guideAgent.validate(envelope, t);
    expect(result.kind).toBe('violation');
  });
});

/**
 * The one deliberate exception to "fixtures here are hand-written": the frozen
 * real-model corpus (`tests/unit/fixtures/golden-guide-envelopes.ts`), replayed
 * through this guide agent's actual `validate`/`toGuideStep`/`bindStep`
 * machinery (not through raw ref/sensitive lookups — `contract.spec.ts`
 * already did that sanity check at the parsing layer).
 */
describe('golden corpus replay（固化的真实语料）', () => {
  it('30. 每条真实调用：引导 agent 校验的 ok/violation 判定与人工标注（sensitive_proposed）一致', () => {
    for (const call of goldenGuideCalls) {
      const t = TABLES[call.tableId];
      const parsed = guideAgent.parseOutput(call.tool, call.rawOutput);
      if (parsed.kind !== 'ok') throw new Error(`slice ${call.slice}（${call.note}）：解析应为 ok`);

      const validated = guideAgent.validate(parsed.envelope, t);
      // R-e 是安全红线：标注为「主动提议了 sensitive ref」的语料必须被判
      // violation，其余判 ok。一次抽样说明不了发生率——2026-09-16 那次的
      // slice 7 提了卡号框，2026-09-17 那次没有——R-e 本身的正例由上面手写
      // 的用例覆盖，不靠这份真机语料碰巧抽到。
      const expectedKind = call.annotation.shouldCountAsSensitiveProposed ? 'violation' : 'ok';
      expect(validated.kind, `slice ${call.slice}（${call.note}）：${call.rawOutput}`).toBe(expectedKind);
    }
  });

  it('31. 每条 point 语料：反查 descriptor 重新绑定的 Binding 与标注的 expectedFirstStepBinding 一致（跨快照重绑的真实回放）', () => {
    for (const call of goldenGuideCalls) {
      const t = TABLES[call.tableId];
      const parsed = guideAgent.parseOutput(call.tool, call.rawOutput);
      if (parsed.kind !== 'ok') throw new Error(`slice ${call.slice}（${call.note}）：解析应为 ok`);

      const validated = guideAgent.validate(parsed.envelope, t);
      if (validated.kind !== 'ok' || validated.envelope.intent !== 'point') {
        // 不是 point、或被 R-e 等规则整体拒绝：没有可绑定的那一步。
        expect(call.annotation.expectedFirstStepBinding, `slice ${call.slice}（${call.note}）`).toBeNull();
        continue;
      }

      const pointed = validated.envelope.ref;
      const item = t.items.find((i) => i.ref === pointed);
      expect(item, `slice ${call.slice}（${call.note}）：ref 应在表内（R-a 已保证）`).toBeDefined();

      const rebind = bindStep(descriptorOf(item!), t);
      const label = rebind.kind === 'unique' ? 'bound' : rebind.kind === 'ambiguous' ? 'ambiguous' : 'unbound';
      expect(label, `slice ${call.slice}（${call.note}）`).toBe(call.annotation.expectedFirstStepBinding);
    }
  });
});

/* ═══════════ judgeArrival ═══════════ */

describe('agent/thread/judge.ts · judgeArrival — expect_after 终于被读一次', () => {
  const arrived = table([
    { ref: 'e1', role: 'heading', name: 'Issues' },
    { ref: 'e2', role: 'button', name: 'New issue' },
  ]);

  it('14. 新表里含 must_contain 说的 {role, name} → pass', () => {
    expect(judgeArrival({ via_ref: 'e9' as Ref, must_contain: { role: 'button', name: 'New issue' } }, arrived)).toBe('pass');
  });

  it('15. 新表里没有 → unknown，不是 skipped', () => {
    // `skipped` means "we did not check". We did check, and did not find it —
    // reporting that as `skipped` would hide a real negative behind a word
    // that means the opposite.
    expect(judgeArrival({ via_ref: 'e9' as Ref, must_contain: { role: 'button', name: 'Merge' } }, arrived)).toBe('unknown');
  });

  it('15b. 模型没给 must_contain（§5.4 的"宁可不给，也不要瞎编"）→ skipped，因为确实没验', () => {
    expect(judgeArrival({ via_ref: 'e9' as Ref }, arrived)).toBe('skipped');
  });
});
