/**
 * Spike S-A —— 模型给出的「流程形状」有多准。
 *
 * 这是设计文档里唯一一个会改变工作量级的未知数：如果模型对目标站点的路线形状
 * 本来就很准，文档接地（§6）是可选增强；如果经常错，它是优先级 1 的必需品，
 * 而且要按模型档次条件启用。
 *
 * 量的是 `route`（粗路标），**不是** `steps`。步骤要绑定到具体控件，那取决于
 * 抽取器和当前页面；路线形状只取决于模型知不知道这个产品长什么样，而后者正是
 * 「走到一半才发现错」里「路线的形状错了」那一类的直接来源（§1.2）。
 *
 * 真值的来源与它的局限，如实写在这里：每条任务的 `expect` 是从该产品的**官方
 * 文档**读出来的路标词，`doc` 字段记着出处，可以逐条复核。但把文档翻译成关键词
 * 这一步是人做的，所以这份语料的上限是「编语料的人对这些产品的了解」。它足以
 * 分辨「大致对」和「明显错」，不足以分辨两条都合理的路径谁更好。
 *
 * 用法：
 *   env $(grep -v '^#' .env.local | xargs) node tests/spike/flow-accuracy.mjs
 */

const KEY = process.env.DEEPSEEK_API_KEY;
const BASE = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。把它放进 .env.local，不要写进命令行历史。');
  process.exit(1);
}

/**
 * 20 条任务。偏向公开文档覆盖得到的流程，因为那样真值可复核；登录态专属的流程
 * 无论如何都只能靠人看，不适合放进一个要能重复跑的语料里。
 *
 * `expect` 是**有序**的路标词：模型的路线里必须按这个顺序出现（大小写不敏感，
 * 允许中间夹别的步骤）。同义词写成数组，命中其一即可。
 */
const TASKS = [
  // ── GitHub ────────────────────────────────────────────────────────────────
  { site: 'github.com', goal: '把这个仓库从 public 改成 private',
    expect: [['settings', '设置'], ['danger zone', '危险区域'], ['visibility', '可见性']],
    doc: 'docs.github.com/repositories/.../setting-repository-visibility' },
  { site: 'github.com', goal: '给这个仓库加一个协作者',
    expect: [['settings', '设置'], ['collaborator', '协作者', 'access', '成员']],
    doc: 'docs.github.com/.../inviting-collaborators-to-a-personal-repository' },
  { site: 'github.com', goal: '创建一个 personal access token',
    expect: [['settings', '设置'], ['developer settings', '开发者设置'], ['personal access token', '个人访问令牌']],
    doc: 'docs.github.com/.../managing-your-personal-access-tokens' },
  { site: 'github.com', goal: '给主分支加上保护规则',
    expect: [['settings', '设置'], ['branch', '分支'], ['rule', '规则', 'protection', '保护']],
    doc: 'docs.github.com/.../managing-a-branch-protection-rule' },
  { site: 'github.com', goal: '归档这个仓库',
    expect: [['settings', '设置'], ['danger zone', '危险区域'], ['archive', '归档']],
    doc: 'docs.github.com/.../archiving-a-github-repository' },
  { site: 'github.com', goal: '把默认分支从 master 改成 main',
    expect: [['settings', '设置'], ['branch', '分支'], ['default', '默认']],
    doc: 'docs.github.com/.../changing-the-default-branch' },

  // ── AWS 控制台 ────────────────────────────────────────────────────────────
  { site: 'console.aws.amazon.com', goal: '创建一个 S3 存储桶',
    expect: [['s3'], ['bucket', '存储桶'], ['create', '创建']],
    doc: 'docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html' },
  { site: 'console.aws.amazon.com', goal: '给一个 S3 桶开启版本控制',
    expect: [['s3'], ['bucket', '存储桶'], ['properties', '属性'], ['versioning', '版本']],
    doc: 'docs.aws.amazon.com/AmazonS3/latest/userguide/manage-versioning-examples.html' },
  { site: 'console.aws.amazon.com', goal: '创建一个 IAM 用户',
    expect: [['iam'], ['user', '用户'], ['create', '创建', 'add', '添加']],
    doc: 'docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html' },
  { site: 'console.aws.amazon.com', goal: '给一个 IAM 用户附加权限策略',
    expect: [['iam'], ['user', '用户'], ['permission', '权限', 'policy', '策略']],
    doc: 'docs.aws.amazon.com/IAM/latest/UserGuide/id_users_change-permissions.html' },
  { site: 'console.aws.amazon.com', goal: '启动一台 EC2 实例',
    expect: [['ec2'], ['instance', '实例'], ['launch', '启动']],
    doc: 'docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-launch-instance-wizard.html' },
  { site: 'console.aws.amazon.com', goal: '创建一个 Lambda 函数',
    expect: [['lambda'], ['function', '函数'], ['create', '创建']],
    doc: 'docs.aws.amazon.com/lambda/latest/dg/getting-started.html' },
  { site: 'console.aws.amazon.com', goal: '查看某个服务的 CloudWatch 日志',
    expect: [['cloudwatch'], ['log', '日志'], ['log group', '日志组', 'groups']],
    doc: 'docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html' },
  { site: 'console.aws.amazon.com', goal: '给一个 EC2 安全组加一条入站规则',
    expect: [['ec2'], ['security group', '安全组'], ['inbound', '入站'], ['rule', '规则']],
    doc: 'docs.aws.amazon.com/AWSEC2/latest/UserGuide/working-with-security-groups.html' },

  // ── Stripe ────────────────────────────────────────────────────────────────
  { site: 'dashboard.stripe.com', goal: '创建一个 payment link',
    expect: [['payment link', '支付链接'], ['create', '创建', 'new', '新建']],
    doc: 'docs.stripe.com/payment-links/create' },
  { site: 'dashboard.stripe.com', goal: '添加一个 webhook endpoint',
    expect: [['developer', '开发者'], ['webhook'], ['add', '添加', 'create', '创建']],
    doc: 'docs.stripe.com/webhooks' },
  { site: 'dashboard.stripe.com', goal: '切换到测试模式',
    expect: [['test mode', '测试模式', 'test', '测试']],
    doc: 'docs.stripe.com/test-mode' },
  { site: 'dashboard.stripe.com', goal: '给一笔已完成的支付发起退款',
    expect: [['payment', '支付'], ['refund', '退款']],
    doc: 'docs.stripe.com/refunds' },

  // ── Grafana ───────────────────────────────────────────────────────────────
  { site: 'grafana 自托管实例', goal: '添加一个 Prometheus 数据源',
    expect: [['connection', '连接', 'configuration', '配置'], ['data source', '数据源'], ['prometheus']],
    doc: 'grafana.com/docs/grafana/latest/datasources/prometheus/' },
  { site: 'grafana 自托管实例', goal: '新建一个 dashboard 并加一个面板',
    expect: [['dashboard', '仪表板'], ['new', '新建', 'add', '添加'], ['panel', '面板', 'visualization']],
    doc: 'grafana.com/docs/grafana/latest/dashboards/build-dashboards/' },
];

const SYSTEM = `You plan navigation routes inside web consoles.

Given a site and a goal, output the coarse waypoints a user must pass through —
the pages and sections, not the exact controls. You are NOT looking at the page,
so do not invent control names you cannot know.

Reply with JSON only, no prose, no markdown fence:
{"route":[{"at":"<which page or section>","goal":"<what to do there>"}]}

Keep it to at most 6 waypoints. If you do not know this product, reply
{"route":[],"unknown":true} — saying so is correct behaviour, not failure.`;

/** 与产品一致的容错解析：剥 fence、找第一个平衡的 `{}`。 */
function parseLoose(text) {
  const noFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = noFence.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < noFence.length; i++) {
    const c = noFence[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(noFence.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

async function ask(task) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Site: ${task.site}\nGoal: ${task.goal}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    usage: body.usage ?? null,
    ms: Date.now() - t0,
  };
}

/**
 * 有序命中：路标必须按 `expect` 的顺序出现，中间可以夹别的步骤。
 * 顺序是有意义的——「先进 Settings 再进 Danger Zone」和反过来不是同一条路。
 */
function score(route, expect) {
  const hay = route.map((r) => `${r.at ?? ''} ${r.goal ?? ''}`.toLowerCase());
  let cursor = 0;
  const hits = [];
  for (const alts of expect) {
    let found = -1;
    for (let i = cursor; i < hay.length; i++) {
      if (alts.some((a) => hay[i].includes(a.toLowerCase()))) { found = i; break; }
    }
    hits.push(found >= 0);
    if (found >= 0) cursor = found + 1;
  }
  const n = hits.filter(Boolean).length;
  if (n === expect.length) return { verdict: 'ok', n };
  if (n === 0) return { verdict: 'wrong', n };
  return { verdict: 'partial', n };
}

const pad = (s, w) => String(s).padEnd(w, ' ');

const rows = [];
let promptTok = 0, completionTok = 0;

for (const [i, task] of TASKS.entries()) {
  process.stderr.write(`\r[${i + 1}/${TASKS.length}] ${task.goal.slice(0, 24)}…      `);
  let r;
  try {
    r = await ask(task);
  } catch (e) {
    rows.push({ task, verdict: 'error', n: 0, note: String(e.message).slice(0, 70), ms: 0 });
    continue;
  }
  promptTok += r.usage?.prompt_tokens ?? 0;
  completionTok += r.usage?.completion_tokens ?? 0;

  const parsed = parseLoose(r.text);
  if (!parsed) { rows.push({ task, verdict: 'unparsed', n: 0, note: r.text.slice(0, 70), ms: r.ms }); continue; }
  if (parsed.unknown || !Array.isArray(parsed.route) || parsed.route.length === 0) {
    rows.push({ task, verdict: 'unknown', n: 0, note: '模型自称不了解该产品', ms: r.ms });
    continue;
  }
  const s = score(parsed.route, task.expect);
  rows.push({
    task, ...s, ms: r.ms,
    note: parsed.route.map((x) => x.at ?? '?').join(' → ').slice(0, 70),
  });
}
process.stderr.write('\r' + ' '.repeat(60) + '\r');

const ICON = { ok: '✅', partial: '🟡', wrong: '❌', unknown: '⚪', unparsed: '💥', error: '💥' };

console.log(`\n模型：${MODEL}   语料：${TASKS.length} 条任务\n`);
console.log(`${pad('站点', 26)}${pad('目标', 30)}判定  命中  路线`);
console.log('─'.repeat(120));
for (const r of rows) {
  console.log(
    pad(r.task.site, 26) + pad(r.task.goal, 30) +
    `${ICON[r.verdict]}   ${r.n}/${r.task.expect.length}   ${r.note ?? ''}`,
  );
}

const tally = (v) => rows.filter((r) => r.verdict === v).length;
const total = rows.length;
const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;

console.log('\n' + '─'.repeat(120));
console.log(`形状正确  ${pad(tally('ok'), 4)}${pct(tally('ok'))}`);
console.log(`部分命中  ${pad(tally('partial'), 4)}${pct(tally('partial'))}`);
console.log(`形状错误  ${pad(tally('wrong'), 4)}${pct(tally('wrong'))}`);
console.log(`自称不知  ${pad(tally('unknown'), 4)}${pct(tally('unknown'))}   ← 这一档是诚实，不是失败`);
console.log(`契约失败  ${pad(tally('unparsed') + tally('error'), 4)}${pct(tally('unparsed') + tally('error'))}`);
console.log(`\ntoken：输入 ${promptTok} / 输出 ${completionTok}`);
console.log(`\n判读：「形状正确」高 → 文档接地是可选增强；「形状错误」高 → 它是优先级 1 的必需品。`);
console.log(`「自称不知」高 → 模型愿意认怂，两粒度输出（§1.3）就已经在起作用。`);

/* ── 附带探针：认怂出口到底有没有用 ────────────────────────────────────────
 *
 * 结论（DeepSeek，2026-08）：**没用。** 4 个不可能知道的目标——两个虚构内网
 * 控制台、一个虚构云产品、一个虚构的 GitHub 功能——全部得到自信编造的路线，
 * 一次都没有用过出口。
 *
 * 这否掉了「给模型一个诚实的出口，它就不会编」这个假设，并且失效方向是最坏的：
 * 对陌生平台，模型不是答不出，是自信地答错。检测无知只能靠 route[0] 与真实
 * 元素表对照，不能靠提问。
 */
const UNKNOWABLE = [
  { site: 'ops.acme-internal.corp（公司内部运维台）', goal: '把一个服务的灰度比例从 10% 调到 50%' },
  { site: 'kestrel-admin.internal（内部 admin）', goal: '给一个租户开通高级配额' },
  { site: 'console.zynthos-cloud.example', goal: '创建一个 Zynthos 数据管道' },
  { site: 'github.com', goal: '启用 Quantum Merge Shield 功能' },
];

console.log('\n附带探针 —— 面对不可能知道的目标，模型会认怂还是会编？');
console.log('─'.repeat(120));
let admittedCount = 0;
for (const t of UNKNOWABLE) {
  const r = await ask(t);
  const p = parseLoose(r.text);
  const admitted = p?.unknown === true || (Array.isArray(p?.route) && p.route.length === 0);
  if (admitted) admittedCount += 1;
  console.log(
    `${admitted ? '⚪ 认怂' : '❗ 编了'}  ${pad(t.site.slice(0, 32), 34)}` +
    (admitted ? '' : (p?.route ?? []).map((x) => x.at).join(' → ').slice(0, 60)),
  );
}
console.log(`\n认怂 ${admittedCount}/${UNKNOWABLE.length}。为 0 时，§1.3 的「诚实出口」只能限制编造范围，不能检测无知。`);
