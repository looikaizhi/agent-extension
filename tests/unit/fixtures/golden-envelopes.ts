import type { Envelope } from '@/agent/intents';

/**
 * 48 hand-written golden envelopes for `contract-mutation.spec.ts` (slice 20,
 * design doc §5.1). Each `raw` is typed out by hand as the literal JSON text a
 * model would have emitted; each `envelope` is the value a correct
 * `parseOutput(intent, rawArgs)` must produce — read straight off the `raw` string
 * next to it, not obtained by running the parser and pasting its output.
 *
 * Deliberately varied along several axes so the 20 mutation operators in
 * `contract-mutation.spec.ts` get a mix of genuine hits and genuine no-ops
 * rather than 40 near-identical shapes:
 *  - `explain` and `ask` — the 26 `ask` entries were the question agent's
 *    `clarify` and `need_text` until there was one agent (08b), rewritten
 *    with their raw text's escapes left exactly as typed — plus `point` /
 *    `read_doc` (the last eight). `point` is the only shape that carries an *instruction*:
 *    mis-accepting a mutated one makes the user click a control the model never named, which
 *    is L-4 on the contract plane. `explain` mis-accepted is only a wrong
 *    answer. That asymmetry is why these were added rather than left at the
 *    three S1 shapes — and why eight, chosen for operator coverage, rather
 *    than another forty for symmetry's sake.
 *  - Chinese-only text, English-only text, and mixed — the swap-ASCII-case
 *    operator is a no-op on the Chinese-only entries by construction
 *  - `refs` empty vs. non-empty, `options` empty vs. non-empty —
 *    the trailing-comma-array operator is a no-op on the empty ones
 *  - some values contain a literal `/` (escape-forward-slash operator has
 *    something to do), some don't (operator is a no-op there)
 *  - a few values contain `"` / `\` / `\n` requiring real JSON escapes, so
 *    the mutation operators are exercised against escaped content too
 */
export interface GoldenEnvelope {
  raw: string;
  envelope: Envelope;
}

export const goldenEnvelopes: GoldenEnvelope[] = [
  // ── explain (14) ──────────────────────────────────────────────────────
  {
    raw: '{"intent":"explain","answer":"点击右上角的按钮即可保存。","refs":["e12","e7"]}',
    envelope: { intent: 'explain', answer: '点击右上角的按钮即可保存。', refs: ['e12', 'e7'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"This error means the request quota was exceeded.","refs":["e3"]}',
    envelope: { intent: 'explain', answer: 'This error means the request quota was exceeded.', refs: ['e3'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"这个字段目前留空，没有依据元素。","refs":[]}',
    envelope: { intent: 'explain', answer: '这个字段目前留空，没有依据元素。', refs: [] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"Path is /api/v1/instances, see the docs.","refs":["e9"]}',
    envelope: { intent: 'explain', answer: 'Path is /api/v1/instances, see the docs.', refs: ['e9'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"配额上限写在“实例详情”页的右侧栏。","refs":["e5","e6","e8"]}',
    envelope: { intent: 'explain', answer: '配额上限写在“实例详情”页的右侧栏。', refs: ['e5', 'e6', 'e8'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"He said \\"retry later\\" in the tooltip.","refs":["e1"]}',
    envelope: { intent: 'explain', answer: 'He said "retry later" in the tooltip.', refs: ['e1'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"这个开关默认关闭，需要手动打开。","refs":["e21"]}',
    envelope: { intent: 'explain', answer: '这个开关默认关闭，需要手动打开。', refs: ['e21'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"Line one\\nLine two of the explanation.","refs":[]}',
    envelope: { intent: 'explain', answer: 'Line one\nLine two of the explanation.', refs: [] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"实例状态“运行中”表示可以正常访问。","refs":["e14"]}',
    envelope: { intent: 'explain', answer: '实例状态“运行中”表示可以正常访问。', refs: ['e14'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"The endpoint accepts GET and POST only.","refs":["e2","e4"]}',
    envelope: { intent: 'explain', answer: 'The endpoint accepts GET and POST only.', refs: ['e2', 'e4'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"这个按钮会打开一个新的对话框。","refs":["e30"]}',
    envelope: { intent: 'explain', answer: '这个按钮会打开一个新的对话框。', refs: ['e30'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"Backup runs daily at 02:00 UTC.","refs":[]}',
    envelope: { intent: 'explain', answer: 'Backup runs daily at 02:00 UTC.', refs: [] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"提示信息里写的是“配额已用尽”。","refs":["e17","e18"]}',
    envelope: { intent: 'explain', answer: '提示信息里写的是“配额已用尽”。', refs: ['e17', 'e18'] } as Envelope,
  },
  {
    raw: '{"intent":"explain","answer":"See docs/setup/quickstart for details.","refs":["e40"]}',
    envelope: { intent: 'explain', answer: 'See docs/setup/quickstart for details.', refs: ['e40'] } as Envelope,
  },

  // ── ask · choice or text (13, once the question agent's clarify) ────────
  {
    raw: '{"intent":"ask","question":"您想找哪一个实例？","wants":"choice","options":[{"ref":"e3","label":"实例列表"},{"ref":"e9","label":"实例详情"}]}',
    envelope: {
      intent: 'ask',
      question: '您想找哪一个实例？',
      wants: 'choice',
      options: [
        { ref: 'e3', label: '实例列表' },
        { ref: 'e9', label: '实例详情' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Which button did you mean?","wants":"choice","options":[{"ref":"e1","label":"Save draft"},{"ref":"e2","label":"Save and publish"}]}',
    envelope: {
      intent: 'ask',
      question: 'Which button did you mean?',
      wants: 'choice',
      options: [
        { ref: 'e1', label: 'Save draft' },
        { ref: 'e2', label: 'Save and publish' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"页面上没有能明确对应的控件，能再具体一点吗？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '页面上没有能明确对应的控件，能再具体一点吗？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Do you mean the /settings page or the /billing page?","wants":"choice","options":[{"ref":"e5","label":"Settings"}]}',
    envelope: {
      intent: 'ask',
      question: 'Do you mean the /settings page or the /billing page?',
      wants: 'choice',
      options: [{ ref: 'e5', label: 'Settings' }],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"这里有两个“删除”按钮，指哪一个？","wants":"choice","options":[{"ref":"e11","label":"删除草稿"},{"ref":"e12","label":"删除全部"}]}',
    envelope: {
      intent: 'ask',
      question: '这里有两个“删除”按钮，指哪一个？',
      wants: 'choice',
      options: [
        { ref: 'e11', label: '删除草稿' },
        { ref: 'e12', label: '删除全部' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"He said \\"which one\\" — can you clarify?","wants":"choice","options":[{"ref":"e6","label":"Option A"}]}',
    envelope: {
      intent: 'ask',
      question: 'He said "which one" — can you clarify?',
      wants: 'choice',
      options: [{ ref: 'e6', label: 'Option A' }],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"要新建的是“项目”还是“分组”？","wants":"choice","options":[{"ref":"e20","label":"新建项目"},{"ref":"e21","label":"新建分组"},{"ref":"e22","label":"新建团队"}]}',
    envelope: {
      intent: 'ask',
      question: '要新建的是“项目”还是“分组”？',
      wants: 'choice',
      options: [
        { ref: 'e20', label: '新建项目' },
        { ref: 'e21', label: '新建分组' },
        { ref: 'e22', label: '新建团队' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"No matching control found on this page — could you rephrase?","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'No matching control found on this page — could you rephrase?', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"是要导出为 CSV 还是 JSON？","wants":"choice","options":[{"ref":"e33","label":"导出 CSV"},{"ref":"e34","label":"导出 JSON"}]}',
    envelope: {
      intent: 'ask',
      question: '是要导出为 CSV 还是 JSON？',
      wants: 'choice',
      options: [
        { ref: 'e33', label: '导出 CSV' },
        { ref: 'e34', label: '导出 JSON' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Line one\\nLine two of the clarifying question?","wants":"choice","options":[{"ref":"e8","label":"Yes"}]}',
    envelope: {
      intent: 'ask',
      question: 'Line one\nLine two of the clarifying question?',
      wants: 'choice',
      options: [{ ref: 'e8', label: 'Yes' }],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"目标是“暂停”还是“终止”实例？","wants":"choice","options":[{"ref":"e15","label":"暂停实例"}]}',
    envelope: { intent: 'ask', question: '目标是“暂停”还是“终止”实例？', wants: 'choice', options: [{ ref: 'e15', label: '暂停实例' }] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Which environment — staging or production?","wants":"choice","options":[{"ref":"e16","label":"Staging"},{"ref":"e17","label":"Production"}]}',
    envelope: {
      intent: 'ask',
      question: 'Which environment — staging or production?',
      wants: 'choice',
      options: [
        { ref: 'e16', label: 'Staging' },
        { ref: 'e17', label: 'Production' },
      ],
    } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"图标按钮太多，能说下具体位置吗？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '图标按钮太多，能说下具体位置吗？', wants: 'text', options: [] } as Envelope,
  },

  // ── ask · text (13, once the question agent's need_text) ───────────────
  {
    raw: '{"intent":"ask","question":"配额上限是多少","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '配额上限是多少', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"What does the pricing table say about overage fees?","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'What does the pricing table say about overage fees?', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"这段正文里有没有提到退款政策？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '这段正文里有没有提到退款政策？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Check /legal/terms for the cancellation clause.","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'Check /legal/terms for the cancellation clause.', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"正文里“免责声明”那一段写了什么？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '正文里“免责声明”那一段写了什么？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"He wrote \\"see appendix\\" — which block is that?","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'He wrote "see appendix" — which block is that?', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"续费周期在正文哪一段说明？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '续费周期在正文哪一段说明？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Does the changelog mention breaking changes?","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'Does the changelog mention breaking changes?', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"正文第一段的完整内容是什么？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '正文第一段的完整内容是什么？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Line one\\nLine two of the follow-up query.","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'Line one\nLine two of the follow-up query.', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"服务条款第 3 条讲的是什么？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '服务条款第 3 条讲的是什么？', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"Is there a section under /docs/faq about billing?","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: 'Is there a section under /docs/faq about billing?', wants: 'text', options: [] } as Envelope,
  },
  {
    raw: '{"intent":"ask","question":"正文里有没有给出具体的联系方式？","wants":"text","options":[]}',
    envelope: { intent: 'ask', question: '正文里有没有给出具体的联系方式？', wants: 'text', options: [] } as Envelope,
  },

  // ── point / read_doc (8) ─────────────────────────────────────────────
  // Added 2026-08-22 as `guide`; rewritten 2026-09-17 when the model began
  // pointing at one step at a time. Each one gives a different operator
  // something real to bite on: nested objects for the trailing-comma operator,
  // `/` in values for escape-forward-slash, `\n` in `why` for the escape
  // handling, empty vs. populated arrays for the array operators, and a long
  // tail so simulate-safe-truncation cuts inside a value rather than past the end.
  {
    raw: '{"intent":"point","route":[{"at":"实例列表","goal":"找到目标实例"}],"ref":"e4","action":"click","why":"先选中要操作的那台实例"}',
    envelope: {
      intent: 'point',
      route: [{ at: '实例列表', goal: '找到目标实例' }],
      ref: 'e4',
      action: 'click',
      why: '先选中要操作的那台实例',
    } as Envelope,
  },
  {
    raw: '{"intent":"point","route":[{"at":"Instances","goal":"Open the instance"},{"at":"Instance detail","goal":"Stop it"}],"ref":"e9","action":"click","why":"Open the detail page first, then stop the instance there"}',
    envelope: {
      intent: 'point',
      route: [
        { at: 'Instances', goal: 'Open the instance' },
        { at: 'Instance detail', goal: 'Stop it' },
      ],
      ref: 'e9',
      action: 'click',
      why: 'Open the detail page first, then stop the instance there',
    } as Envelope,
  },
  {
    raw: '{"intent":"point","route":[],"ref":"e2","action":"input","why":"输入仓库名","value":"n8n-io/n8n"}',
    envelope: {
      intent: 'point',
      // 刻意留空：数组类算子在空数组上是如实的 no-op，与 refs/blocks/options
      // 的空非空搭配同一个用意。显式标注类型，否则会被推断成 never[]。
      route: [] as { at: string; goal: string }[],
      ref: 'e2',
      action: 'input',
      why: '输入仓库名',
      value: 'n8n-io/n8n',
    } as Envelope,
  },
  {
    raw: '{"intent":"point","route":[{"at":"仓库页","goal":"打开 Issues"}],"ref":"e5","action":"click","why":"这里是 issue 列表的入口","expect_after":{"via_ref":"e5","must_contain":{"role":"link","name":"New issue"}}}',
    envelope: {
      intent: 'point',
      route: [{ at: '仓库页', goal: '打开 Issues' }],
      ref: 'e5',
      action: 'click',
      why: '这里是 issue 列表的入口',
      expect_after: { via_ref: 'e5', must_contain: { role: 'link', name: 'New issue' } },
    } as Envelope,
  },
  {
    raw: '{"intent":"point","route":[{"at":"Settings / General","goal":"Find the danger zone"}],"ref":"e18","action":"click","why":"Scroll down to the section titled \\"Danger Zone\\""}',
    envelope: {
      intent: 'point',
      route: [{ at: 'Settings / General', goal: 'Find the danger zone' }],
      ref: 'e18',
      action: 'click',
      why: 'Scroll down to the section titled "Danger Zone"',
    } as Envelope,
  },
  {
    raw: '{"intent":"point","route":[{"at":"控制台","goal":"确认这台实例已经停止"}],"ref":"e21","action":"observe","why":"状态列会从 running 变成 stopped，\\n这一步不需要你点任何东西"}',
    envelope: {
      intent: 'point',
      route: [{ at: '控制台', goal: '确认这台实例已经停止' }],
      ref: 'e21',
      action: 'observe',
      why: '状态列会从 running 变成 stopped，\n这一步不需要你点任何东西',
    } as Envelope,
  },
  {
    raw: '{"intent":"read_doc","via_ref":"e30","query":"如何停止一台正在运行的实例"}',
    envelope: { intent: 'read_doc', via_ref: 'e30', query: '如何停止一台正在运行的实例' } as Envelope,
  },
  {
    raw: '{"intent":"read_doc","via_ref":"e6","query":"What does the /billing/usage page report?"}',
    envelope: { intent: 'read_doc', via_ref: 'e6', query: 'What does the /billing/usage page report?' } as Envelope,
  },
];
