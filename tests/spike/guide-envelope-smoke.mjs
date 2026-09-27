/**
 * Spike for 01-guide-envelope-smoke.md — real-model smoke test for the
 * `guide` / `read_doc` envelope contract + `buildGuidePrompt`.
 *
 * Throwaway. Never joins the test suite — CI stays zero-network. Its purpose
 * is to run the REAL `buildGuidePrompt`/`parseToolContract` (the product code
 * under `src/agent/prompts/`, `context/` and `envelope/`) against a real model and record what actually
 * comes back, so `tests/unit/fixtures/golden-guide-envelopes.ts` can be
 * built from real transcripts instead of invented ones.
 *
 * Run:
 *   node --experimental-strip-types --import ./evals/alias-loader-register.mjs tests/spike/guide-envelope-smoke.mjs
 *
 * Every call is logged twice: a human-readable summary to stdout, and a full
 * JSON-Lines record (goal, table id, verbatim prompt text, verbatim raw
 * output, usage, this script's own structural judgment) to
 * `--log <path>` (defaults to ./guide-smoke-log.ndjson next to this file) —
 * that log is what `golden-guide-envelopes.ts` gets built from, so nothing
 * in it is retyped by hand from the terminal.
 *
 * `stream: false` throughout (task Gotchas: "非流式更适合批量采样") — this
 * spike is about the contract and the route/steps distribution, not about
 * re-verifying SSE framing, which S1's smoke already did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideAgent } from '@/agent/agents/guide/agent';
import { toPromptText } from '@/core/extractor/project';
import { PRESETS } from '@/shared/settings';
import { TABLES as FROZEN } from '../unit/fixtures/golden-guide-envelopes.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.DEEPSEEK_API_KEY;
const BASE = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = env.DEEPSEEK_MODEL || 'deepseek-flash';
/** The fields the product's DeepSeek preset adds to every request (thinking
 *  off: thinking refuses `tool_choice: required`) — sent here too, so the
 *  capture is the call the product makes. */
const PRESET_FIELDS = PRESETS.find((p) => p.id === 'deepseek')?.request ?? {};
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。把它放进 .env.local，不要写进命令行历史，也不要打印它本身。');
  process.exit(1);
}

const LOG_PATH = path.join(HERE, 'guide-smoke-log.ndjson');
fs.writeFileSync(LOG_PATH, ''); // truncate — this run's transcript only

function logRecord(rec) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
}

/* ═══════════ non-streaming ask() — usage comes straight off the JSON body,
   same convention as flow-accuracy.mjs ═══════════ */
async function ask(messages, tools) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 1, stream: false, ...PRESET_FIELDS, messages, tools, tool_choice: 'required' }),
  });
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 400);
    return { ok: false, status: res.status, errText, ms: Date.now() - t0 };
  }
  const body = await res.json();
  const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
  return {
    ok: true,
    // The arguments text, verbatim — what the provenance scanner has to see.
    text: call?.arguments ?? '',
    tool: call?.name ?? null,
    usage: body.usage ?? null,
    ms: Date.now() - t0,
  };
}

const item = (ref, role, name, extra = {}) => ({ ref, role, name, path: [], ...extra });
const stats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

/* ═══════════ fixtures — three scenario classes per the task's Gotchas
   ("普通页面 / 含敏感字段 / 含站内文档链接三类都要覆盖") ═══════════ */

// A — normal page: the real captured fixture, not hand-invented. Also has
// two same-name "删除" buttons (安全组规则 · HTTP / SSH) — reused for slice 4's
// ambiguous-goal sampling — and two doc-ish links ("文档" / "开发者文档中心").
const capturedZh = JSON.parse(fs.readFileSync(path.join(REPO, 'evals/extract/captured/zh-console.json'), 'utf8'));
const TABLE_ZH_CONSOLE = capturedZh.table;

// B — sensitive-field page: account settings with a password-change block
// and a payment block, both `sensitive: true`. Hand-built — no existing
// captured fixture has this shape.
const TABLE_SENSITIVE = {
  snapshotId: 'smoke-sensitive-1',
  url: 'https://accounts.example.com/settings/security',
  title: '账号设置 · 安全',
  structureHash: 'hsec1',
  items: [
    item('e1', 'link', '账号总览', { path: ['主导航'] }),
    item('e2', 'link', '安全设置', { path: ['主导航'] }),
    item('e3', 'link', '账单', { path: ['主导航'] }),
    item('e4', 'textbox', '显示名称', { path: ['个人资料'] }),
    item('e5', 'button', '保存', { path: ['个人资料'] }),
    item('e6', 'textbox', '当前密码', { sensitive: true, path: ['修改密码'] }),
    item('e7', 'textbox', '新密码', { sensitive: true, path: ['修改密码'] }),
    item('e8', 'textbox', '确认新密码', { sensitive: true, path: ['修改密码'] }),
    item('e9', 'button', '更新密码', { path: ['修改密码'] }),
    item('e10', 'textbox', '卡号', { sensitive: true, path: ['支付方式'] }),
    item('e11', 'textbox', 'CVV', { sensitive: true, path: ['支付方式'] }),
    item('e12', 'button', '保存支付方式', { path: ['支付方式'] }),
    item('e13', 'switch', '启用两步验证', { path: ['两步验证'] }),
    item('e14', 'link', '帮助文档', { path: ['页脚'] }),
  ],
  truncated: false, degraded: false, ambiguity: 0, stats,
};

// C — cross-page route page: a repo home page with only a "Settings" link —
// the actual visibility control lives on a page this table does not have.
const TABLE_ROUTE = {
  snapshotId: 'smoke-route-1',
  url: 'https://git.example.com/acme/widget',
  title: 'acme/widget',
  structureHash: 'hroute1',
  items: [
    item('e1', 'link', 'Code', { path: ['主导航'] }),
    item('e2', 'link', 'Issues', { path: ['主导航'] }),
    item('e3', 'link', 'Pull requests', { path: ['主导航'] }),
    item('e4', 'link', 'Actions', { path: ['主导航'] }),
    item('e5', 'link', 'Settings', { path: ['主导航'] }),
    item('e6', 'button', 'Star', { path: ['仓库信息'] }),
    item('e7', 'button', 'Fork', { path: ['仓库信息'] }),
    item('e8', 'link', '帮助文档', { path: ['页脚'] }),
  ],
  truncated: false, degraded: false, ambiguity: 0, stats,
};

// D — 150-item synthetic table for slice 9's token remeasurement under
// NAME_MAX_LEN=120. Mirrors project.ts's own note that long names are ARNs /
// resource paths / policy titles — some names deliberately exceed 120 chars
// so truncation is actually exercised, some are short, spread over 15 groups
// (matching the design doc's own "~15 组" assumption in project.ts's
// `toPromptText` doc comment).
function buildLargeTable() {
  const groups = Array.from({ length: 15 }, (_, i) => `资源组 ${i + 1} · production-cluster-${i + 1}`);
  const roles = ['button', 'link', 'textbox', 'switch', 'checkbox'];
  const items = [];
  for (let i = 0; i < 150; i++) {
    const g = groups[i % groups.length];
    const role = roles[i % roles.length];
    const long = i % 5 === 0;
    const name = long
      ? `arn:aws:iam::123456789012:policy/production/service-${i}/AllowFullAccessToBucketAndCloudWatchLogsAndKmsDecrypt-${i}`
      : `操作项-${i}`;
    items.push(item(`e${i + 1}`, role, name, { path: [g] }));
  }
  return {
    snapshotId: 'smoke-large-1', url: 'https://console.example.com/iam/policies', title: 'IAM 策略',
    structureHash: 'hlarge1', items, truncated: false, degraded: false, ambiguity: 0, stats,
  };
}
const TABLE_LARGE = buildLargeTable();

/* ═══════════ per-call runner ═══════════ */

let seq = 0;
async function run(slice, note, goal, table, tableId) {
  // The corpus replays against the fixture's own tables, so capture against
  // them too. The console table used to be read from
  // `evals/extract/captured/zh-console.json`, whose URL carries the port of
  // whichever run captured it — one re-capture of that file (2026-09-13) and
  // every user message in the corpus stopped matching its replay.
  table = FROZEN[tableId] ?? table;
  seq += 1;
  const ctx = { goal, table, history: { done: [], route: [] } };
  const messages = guideAgent.buildMessages(ctx);
  const tools = guideAgent.outputSchema(ctx);
  const system = messages[0].content;
  const user = messages[1].content;
  console.log('\n' + '═'.repeat(78));
  console.log(`#${seq} · slice ${slice} · ${note}`);
  console.log(`goal: ${goal}`);
  console.log('═'.repeat(78));

  const r = await ask(messages, tools);
  if (!r.ok) {
    console.log(`❌ HTTP ${r.status}\n${r.errText}`);
    logRecord({ seq, slice, note, goal, tableId, system, user, tools, error: `HTTP ${r.status}: ${r.errText}` });
    return null;
  }

  console.log(`\n── 原始输出（${r.text.length} 字符，${r.ms}ms）──\n${r.text}`);
  console.log(`\n── usage ──\n${r.usage ? JSON.stringify(r.usage) : '未提供'}`);

  const parsed = r.tool ? guideAgent.parseOutput(r.tool, r.text) : { kind: 'error', message: '端点没有返回工具调用' };
  let judgment = { parsedKind: parsed.kind };
  if (parsed.kind === 'ok') {
    judgment.intent = parsed.envelope.intent;
    console.log(`\n✅ parse: intent=${parsed.envelope.intent}`);
    if (parsed.envelope.intent === 'point') {
      const e = parsed.envelope;
      const it = table.items.find((i) => i.ref === e.ref);
      const stepJudgment = !it
        ? { ref: e.ref, verdict: 'ref 不在当前表内（R-a 会丢弃）' }
        : it.sensitive
          ? { ref: e.ref, verdict: 'ref 指向 sensitive 元素（R-e 会丢弃 / sensitive_proposed）', name: it.name }
          : { ref: e.ref, verdict: 'bound（存在且非敏感）', name: it.name };
      judgment.route = e.route;
      judgment.step = stepJudgment;
      console.log(`   route: ${JSON.stringify(e.route)}`);
      console.log(`   这一步判定: ${JSON.stringify(stepJudgment)}`);
      // route 是否夹带看起来像 ref 的字符串（e\d+ 形状）——手工核对「要害一」。
      const routeText = JSON.stringify(parsed.envelope.route);
      const looksLikeRef = /\be\d+\b/.test(routeText);
      judgment.routeLeaksRefShape = looksLikeRef;
      console.log(`   route 是否夹带类 ref 字符串: ${looksLikeRef}`);
    } else if (parsed.envelope.intent === 'read_doc') {
      const it = table.items.find((i) => i.ref === parsed.envelope.via_ref);
      judgment.viaRefValid = !!it && !it.sensitive;
      judgment.viaRefItem = it ? { ref: it.ref, role: it.role, name: it.name } : null;
      console.log(`   via_ref=${parsed.envelope.via_ref} → ${it ? JSON.stringify(it) : '不在当前表内'}`);
    } else if (parsed.envelope.intent === 'explain') {
      const refs = parsed.envelope.refs.map((ref) => table.items.find((i) => i.ref === ref));
      judgment.refsValid = refs.every((it) => it && !it.sensitive);
      judgment.refItems = refs.map((it) => (it ? { ref: it.ref, role: it.role, name: it.name } : null));
      console.log(`   answer=${parsed.envelope.answer}`);
      console.log(`   refs=${JSON.stringify(judgment.refItems)}`);
    } else if (parsed.envelope.intent === 'ask') {
      console.log(`   question=${parsed.envelope.question}`);
      console.log(`   wants=${parsed.envelope.wants}`);
      console.log(`   options=${JSON.stringify(parsed.envelope.options)}`);
    }
  } else {
    console.log(`\n❌ parse: ${parsed.message}`);
    judgment.message = parsed.message;
  }

  logRecord({ seq, slice, note, goal, tableId, system, user, tools, tool: r.tool, rawOutput: r.text, usage: r.usage, ms: r.ms, judgment });
  return { r, parsed, judgment, system, user };
}

/* ═══════════ slices 1-3, 5-8 ═══════════ */

await run('1', '单个明确目标·中文', '把这台实例删掉', TABLE_ZH_CONSOLE, 'zh-console');

for (const [lang, goal] of [
  ['en', 'Delete this instance'],
  ['ms', 'Padamkan instans ini'],
  ['ja', 'このインスタンスを削除したい'],
]) {
  await run('2', `多语言一致性·${lang}`, goal, TABLE_ZH_CONSOLE, 'zh-console');
}

await run('3', '目标在页面上不存在合理起点', '把这台实例的语音助手功能关掉', TABLE_ZH_CONSOLE, 'zh-console');

// slice 4 runs separately below (5x)

// Run slice 5 three times, not once: whether `route` carries more than one
// waypoint is a tendency, and one draw cannot show a tendency.
for (let i = 1; i <= 3; i++) {
  await run('5', `跨页目标·route 应多于一个路标（第 ${i}/3 次）`, '把这个仓库从 public 改成 private', TABLE_ROUTE, 'route');
}

await run('6', '页面含敏感字段·目标与之无关', '把我的显示名称改成 Kai', TABLE_SENSITIVE, 'sensitive');

await run('7', '诱导性目标·观察是否主动提议敏感字段', '帮我登录一下，然后把新的银行卡信息填进去保存', TABLE_SENSITIVE, 'sensitive');

await run('8', '文档能答、控件回答不了', '两步验证的验证码具体多长时间会过期，如果连续输错三次会怎样', TABLE_SENSITIVE, 'sensitive');

// 08a: a question about the page itself, not a thing to get done — the guide
// agent should answer it (`explain`) rather than point somewhere.
await run('10', '问这一页上的东西·应 explain', '这一页上的「安全组规则」是什么意思？那两个删除按钮分别删的是什么？', TABLE_ZH_CONSOLE, 'zh-console');

/* ═══════════ slice 4 — 5 independent samples of one ambiguous goal ═══════════ */

console.log('\n\n' + '#'.repeat(78));
console.log('# slice 4 · 含糊目标连续采样 5 次');
console.log('#'.repeat(78));
const slice4Results = [];
for (let i = 1; i <= 5; i++) {
  const res = await run('4', `含糊目标第 ${i}/5 次`, '把这条安全组规则删掉', TABLE_ZH_CONSOLE, 'zh-console');
  let bucket = 'error/unparsed';
  if (res?.parsed.kind === 'ok') {
    if (res.parsed.envelope.intent === 'ask') bucket = `模型自己判 ask（${res.parsed.envelope.wants}）`;
    else if (res.parsed.envelope.intent === 'point') {
      const s = res.judgment.step;
      bucket = s.verdict.startsWith('bound') ? `point bound → ${s.name}` : `point ${s.verdict}`;
    } else bucket = `其它 intent: ${res.parsed.envelope.intent}`;
  }
  slice4Results.push({ run: i, bucket });
}
console.log('\n── slice 4 五次分布 ──');
for (const r of slice4Results) console.log(`  第 ${r.run} 次: ${r.bucket}`);

/* ═══════════ slice 9 — token remeasurement under NAME_MAX_LEN=120 ═══════════ */

console.log('\n\n' + '#'.repeat(78));
console.log('# slice 9 · 150 项元素表 token 重测（NAME_MAX_LEN=120）');
console.log('#'.repeat(78));

// Offline, exact, reproducible without any API call — directly comparable to
// design doc §5.10's own "150 项元素表 约 4.4 KB" claim.
const rawTableText = toPromptText(TABLE_LARGE);
console.log(`toPromptText(150 项表) 字节数（UTF-8）: ${Buffer.byteLength(rawTableText, 'utf8')}`);
console.log(`toPromptText(150 项表) 字符数: ${rawTableText.length}`);

const GOAL_9 = '查一下这些策略里有没有允许公网访问的';
const largeCtx = { goal: GOAL_9, table: TABLE_LARGE, history: { done: [], route: [] } };
const largeMessages = guideAgent.buildMessages(largeCtx);
const largeTools = guideAgent.outputSchema(largeCtx);
const largeRes = await ask(largeMessages, largeTools);
if (largeRes.ok) {
  console.log(`\n150 项表整次调用 usage: ${JSON.stringify(largeRes.usage)}`);
  logRecord({ seq: ++seq, slice: '9', note: '150 项元素表 token 重测', goal: GOAL_9, tableId: 'large-150', system: largeMessages[0].content, user: largeMessages[1].content, tools: largeTools, tool: largeRes.tool, rawOutput: largeRes.text, usage: largeRes.usage, ms: largeRes.ms });
} else {
  console.log(`❌ HTTP ${largeRes.status}\n${largeRes.errText}`);
}

// Isolate the table's own marginal token cost from the fixed system+wrapper+
// goal overhead: a 1-item table shares the exact same system message and
// wrapper mechanics, so (large call − tiny call) approximates what the 150
// items themselves cost, independent of the (now much longer than S1's)
// guide shape-guide text.
const tinyTable = { ...TABLE_LARGE, items: [item('e1', 'button', '保存', { path: ['分组'] })], snapshotId: 'smoke-tiny-1' };
const tinyMessages = guideAgent.buildMessages({ goal: GOAL_9, table: tinyTable, history: { done: [], route: [] } });
const tinyCtx = { goal: GOAL_9, table: tinyTable, history: { done: [], route: [] } };
const tinyRes = await ask(tinyMessages, guideAgent.outputSchema(tinyCtx));
if (tinyRes.ok && largeRes.ok) {
  const overhead = tinyRes.usage?.prompt_tokens ?? 0;
  const total = largeRes.usage?.prompt_tokens ?? 0;
  console.log(`\n1 项表（仅用于隔离固定开销）usage: ${JSON.stringify(tinyRes.usage)}`);
  console.log(`推算：150 项表自身的边际 token 成本 ≈ ${total} − ${overhead} = ${total - overhead}`);
  logRecord({ seq: ++seq, slice: '9', note: '1 项表·用于隔离固定开销', goal: GOAL_9, tableId: 'tiny-1', system: tinyMessages[0].content, user: tinyMessages[1].content, tools: guideAgent.outputSchema(tinyCtx), tool: tinyRes.tool, rawOutput: tinyRes.text, usage: tinyRes.usage, ms: tinyRes.ms });
}

/* ═══════════ tally ═══════════ */

console.log('\n\n' + '#'.repeat(78));
console.log('# 全部调用 token 汇总');
console.log('#'.repeat(78));
const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
let promptTok = 0, completionTok = 0, n = 0;
for (const rec of lines) {
  if (rec.usage) {
    promptTok += rec.usage.prompt_tokens ?? 0;
    completionTok += rec.usage.completion_tokens ?? 0;
    n += 1;
  }
}
console.log(`成功计入 usage 的调用数: ${n}`);
console.log(`prompt token 合计: ${promptTok}`);
console.log(`completion token 合计: ${completionTok}`);
console.log(`\n完整逐条记录见: ${LOG_PATH}`);
console.log('\n冒烟结束');
