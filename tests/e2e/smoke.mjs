/**
 * End-to-end smoke test against a real MV3 install.
 *
 * Chrome for Testing still honours --load-extension; branded Chrome 137+ does
 * not. Verified empirically.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const fixture = fs.readFileSync(path.join(repo, 'tests/fixtures/pages/console.html'), 'utf8');
const docs = fs.readFileSync(path.join(repo, 'tests/fixtures/pages/docs.html'), 'utf8');
const billing = fs.readFileSync(path.join(repo, 'tests/fixtures/pages/billing-widget.html'), 'utf8');
/** Released by the streaming check when it wants the answer finished. */
let finishSlowAnswer = () => {};
let slowModelHits = 0;
const server = http
  .createServer(async (req, res) => {
    // One endpoint answers the way a real one does: in pieces, over time. A
    // body fulfilled in one go can never show what the panel does while the
    // model is still writing.
    if (req.url?.startsWith('/slow-model')) {
      slowModelHits++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      // Sent now, not when the body is done: the panel can only show what it
      // has received, and a buffered first chunk shows nothing.
      res.flushHeaders();
      const frame = (args) =>
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'slow-1', function: { name: 'explain', arguments: args } }] } }] })}\n\n`;
      res.write(frame('{"answer":"先写出来的这半句'));
      await new Promise((r) => (finishSlowAnswer = r));
      res.write(frame('，和后写的那半句。","refs":[]}'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // 嵌入的那一块是一个真的小页面，不是把 console 再套一层——层二要进去读它。
    // 跟踪像素给一个空文档：它必须因为「太小」被挡住，而不是因为「没内容」。
    if (req.url?.startsWith('/billing-widget')) return void res.end(billing);
    if (req.url?.startsWith('/pixel')) return void res.end('<!doctype html><title>px</title>');
    res.end(req.url?.startsWith('/docs') ? docs : fixture);
  })
  .listen(0);
const PORT = server.address().port;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Assert the *built* manifest, not the config.
 *
 * For the whole of step 1 the config said `host_permissions: []` while the
 * shipped manifest said `["<all_urls>"]` — WXT appends every runtime-registered
 * content script's match patterns (WXT's own manifest builder does this). That escalation was
 * invisible in the config, in code review, and in a green e2e run. The only
 * place it was ever visible is the build output, so that is where the guard
 * goes. Any drift, in either direction, fails here.
 */
{
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const actual = {
    permissions: [...(m.permissions ?? [])].sort(),
    host_permissions: [...(m.host_permissions ?? [])].sort(),
    optional_host_permissions: [...(m.optional_host_permissions ?? [])].sort(),
    content_script_matches: (m.content_scripts ?? []).flatMap((c) => c.matches ?? []),
  };
  const expected = {
    permissions: ['scripting', 'sidePanel', 'storage'],
    host_permissions: ['<all_urls>'],
    optional_host_permissions: [],
    content_script_matches: ['<all_urls>'],
  };
  check(
    '产出的 manifest 权限与声明逐字一致',
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );
}

const udd = fs.mkdtempSync('/tmp/pg-e2e-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    // Point a genuinely blocked hostname at our own server, so S-06 can be
    // tested against the real match patterns rather than against a mock.
    // `plain.test` is an ordinary http:// host with a normal hostname — i.e.
    // *not* a secure context, unlike 127.0.0.1. That distinction hid a crash
    // that broke extraction on every internal console (F-21).
    `--host-resolver-rules=MAP plain.test 127.0.0.1:${PORT}`,
  ],
  viewport: { width: 1280, height: 860 },
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
check('扩展加载 + MV3 service worker 启动', Boolean(extId), extId);

const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

// Drive the RPC from the service worker: it owns chrome.scripting/chrome.tabs,
// exactly like the side panel does at runtime.
const rpc = async (expr) =>
  await sw.evaluate(async (src) => {
    // eslint-disable-next-line no-eval
    return await eval(src);
  }, expr);

const tabId = await sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return t?.id ?? null;
});
check('找到目标标签页', tabId !== null, `tabId=${tabId}`);

// ---- reach the content script exactly the way `ensureInjected` does ----
// It is statically registered now, so an unconditional executeScript would land
// a *second* instance in the page. PING first; inject only if nobody answers.
const injected = await sw.evaluate(async (id) => {
  const ping = async () => {
    try {
      return await chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 });
    } catch {
      return null;
    }
  };
  let pong = await ping();
  if (!pong?.ok) {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
    pong = await ping();
  }
  return pong;
}, tabId);
check('content script 就位 + PING 往返', injected?.ok === true, injected?.data?.title);

// Double injection must be survivable regardless: the newest instance takes
// over and the superseded one goes silent.
await sw.evaluate(async (id) => {
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
}, tabId);
await page.waitForTimeout(200);
const afterDouble = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }),
  tabId,
);
const hosts = await page.evaluate(() => document.querySelectorAll('[data-page-guide]').length);
check(
  '重复注入后只剩一个实例在应答',
  afterDouble?.ok === true && hosts <= 1,
  `浮层宿主数=${hosts}`,
);

// ---- EXTRACT ----
const ex = await sw.evaluate(
  async ([id, budget]) =>
    await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget }, { frameId: 0 }),
  [tabId, { maxNodes: 400 }],
);
let table = ex?.data;
check('EXTRACT 返回投影表', ex?.ok === true && Array.isArray(table?.items), `${table?.items?.length} 个控件`);

// 嵌进来的那一块进不去，但不能当它不存在：它是这张表上的一个洞，说出来，
// 免得「表里没有」被读成「页面上没有」。1×1 的跟踪像素不算洞。
check(
  '嵌入框架如实报给模型：标题与来源域名都在，跟踪像素不算',
  table?.frames?.length === 1 && table.frames[0].label === '账单组件' && table.frames[0].host === new URL(`http://127.0.0.1:${PORT}/`).host,
  JSON.stringify(table?.frames ?? null),
);


const names = (table?.items ?? []).map((i) => `${i.role}|${i.name}`);
check('抽到主操作按钮', names.includes('button|Create instance'));
check(
  '穿透 open shadow DOM',
  names.includes('button|Inside shadow DOM'),
  `shadowRoots=${table?.stats?.shadowRoots}`,
);
check(
  '过滤全部不可见元素',
  !names.some((n) => n.includes('Never visible')) &&
    !names.some((n) => n.includes('aria-hidden')) &&
    !names.some((n) => n.includes('inert')),
);
// Was a tautology (`=== false || true`). The real invariant is the opposite of
// what the band used to do: with budget to spare, nothing is dropped for being
// off screen.
check(
  '预算够用时，视口之外的控件也在表里',
  names.includes('button|Far below the fold'),
  `表内 ${table?.items?.length} 项`,
);

const pw = (table?.items ?? []).find((i) => i.name === 'Password');
check('密码框被标记为 sensitive', pw?.sensitive === true);
const policy = (table?.items ?? []).find((i) => i.name === 'Password policy');
check('「Password policy」链接未被误判为 sensitive', policy && !policy.sensitive);

// row identity should separate the otherwise identical per-row buttons
const stops = (table?.items ?? []).filter((i) => i.name === 'Stop');
const stopPaths = new Set(stops.map((s) => s.path.join('›')));
check(
  '表格行标识区分了同名按钮',
  stops.length >= 2 && stopPaths.size === stops.length,
  `${stops.length} 个 Stop，${stopPaths.size} 个不同 path`,
);
const byName = (n) => (table?.items ?? []).filter((i) => i.name === n);
const pathsOf = (n) => byName(n).map((i) => i.path.join('›'));

// F-10a — heading by role. `<div role="heading">` used to be dropped whole,
// taking its section label with it.
check(
  'div[role=heading] 成为 path 的一层',
  pathsOf('Reveal').length === 2 &&
    pathsOf('Reveal').every((p) => p.includes('Access tokens') || p.includes('Deploy keys')),
  pathsOf('Reveal').join(' | '),
);

// F-10b — ancestors and row identity must cross the shadow boundary.
const rotate = byName('Rotate');
check(
  'shadow DOM 内的元素也拿得到 path',
  rotate.length === 2 && rotate.every((i) => i.path.length > 0),
  rotate.map((i) => i.path.join('›')).join(' | '),
);
check(
  'shadow DOM 内的行标识区分了同名按钮',
  new Set(rotate.map((i) => i.path.join('›'))).size === rotate.length,
  `${rotate.length} 个 Rotate，${new Set(rotate.map((i) => i.path.join('›'))).size} 个不同 path`,
);

// F-12a — textContent used to run adjacent cells together with no separator.
const revert = byName('Revert')[0];
check(
  '行标识各段之间有分隔符',
  revert?.path.some((p) => p.includes('Latest commit 3 people')),
  JSON.stringify(revert?.path),
);

// F-12b — a degradation nobody downstream can see is not observable.
//  must mean *incomplete*, not *slow*. It used to be
// `total > 250ms`, which flagged MDN (340 ms, walk finished in 16 ms, table
// perfectly complete) while a genuinely truncated fast page looked identical.
check('degraded 表示【不完整】，不是【慢】', table?.degraded === false, `degraded=${table?.degraded}`);
check(
  '命名耗时是常驻指标（棘轮基线要用）',
  typeof table?.stats?.ms?.name === 'number' && table.stats.ms.name <= table.stats.ms.semantics,
  `name=${table?.stats?.ms?.name}ms / semantics=${table?.stats?.ms?.semantics}ms`,
);

check('歧义率为 0', table?.ambiguity === 0, `ambiguity=${table?.ambiguity}%`);
check('抽取耗时在量级护栏内 (<50ms)', table?.stats?.ms?.total < 50, `${table?.stats?.ms?.total}ms`);

// ---- HIGHLIGHT ----
const create = (table?.items ?? []).find((i) => i.name === 'Create instance');
// A step is drawn from the table last read, so it carries that table's page
// (CONTEXT.md `View`) — and is painted only while the tab is still there.
const command = (step, extra = {}) => ({
  sessionId: 'e2e',
  snapshotId: table?.snapshotId,
  view: table?.url,
  mode: 'guide',
  progress: { index: 0, total: 1 },
  autoScroll: false,
  step,
  ...extra,
});

const hl = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId: 0 }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        expectedUserAction: 'click',
        title: '创建实例',
        detail: '点击这里创建一个新实例。',
      },
      { autoScroll: true },
    ),
  ],
);
check(
  'HIGHLIGHT 渲染成功',
  hl?.ok === true && !hl?.data?.failure && hl?.data?.resolved === create?.ref,
  JSON.stringify(hl?.data?.rect),
);

await page.waitForTimeout(700);
const overlay = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
  tabId,
);
check(
  '浮层状态可读回',
  overlay?.data?.mounted === true && overlay?.data?.visible === true,
  `status=${overlay?.data?.status}`,
);

// closed shadow root must be unreachable from the page
const closed = await page.evaluate(() => {
  const host = document.querySelector('[data-page-guide]');
  return { exists: Boolean(host), shadow: host ? host.shadowRoot : 'no-host' };
});
check('closed shadow root 对页面不可见', closed.exists && closed.shadow === null);

// Top Layer must beat the page's z-index: 2147483647 element
const inTop = await page.evaluate(() =>
  document.querySelector('[data-page-guide]')?.matches(':popover-open'),
);
check('浮层进入 Top Layer', inTop === true);

await page.screenshot({ path: path.join(repo, 'tests/e2e/shot-smoke.png') });

// ---- sensitive field must be refused ----
const blocked = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId: 0 }),
  [
    tabId,
    command({
      ref: pw?.ref,
      descriptor: { role: 'textbox', name: 'Password' },
      expectedUserAction: 'input',
      title: '输入密码',
    }),
  ],
);
check(
  '敏感字段高亮被拒绝',
  blocked?.ok === true && blocked?.data?.failure === 'sensitive_blocked',
  blocked?.data?.failure,
);

// ---- stale snapshot must be refused ----
const stale = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId: 0 }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        expectedUserAction: 'click',
        title: 'x',
      },
      { snapshotId: 'not-a-real-snapshot' },
    ),
  ],
);
// Task 8 flipped this: a stale handle is no longer a refusal, it is the trigger
// for rebinding from the descriptor. Refusing was the old behaviour and it is
// what made every multi-step flow written in advance die the moment the page changed.
check(
  '过期快照触发按 descriptor 重绑（F-8）',
  stale?.ok === true && !stale?.data?.failure && stale?.data?.resolved,
  `resolved=${stale?.data?.resolved} failure=${stale?.data?.failure}`,
);

// `alsoRefs` carry no descriptor, so they genuinely cannot be recovered.
const staleAlso = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId: 0 }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        alsoRefs: [create?.ref],
        expectedUserAction: 'click',
        title: 'x',
      },
      { snapshotId: 'not-a-real-snapshot' },
    ),
  ],
);
check(
  '无法重绑的 alsoRefs 仍然如实报 snapshot_stale',
  staleAlso?.ok === true && staleAlso?.data?.failure === 'snapshot_stale',
  staleAlso?.data?.failure,
);

// ═══════════════════════════════════════════════════════════════════════════
// Regressions for the three defects the first 19 checks all walked past.
// ═══════════════════════════════════════════════════════════════════════════

/** Late binding commits a new snapshot, so refs from an older EXTRACT die. That
 *  is correct — `alsoRefs` are snapshot-scoped by design — but it means the
 *  harness has to re-extract before any test that hands refs back in. */
// 经宿主要表，而不是直接问顶层文档：宿主读到的是「这一页」——顶层加上读进来的
// 框架。直接问顶层会拿到一张少了框架控件的表，拿它去种线程，随后宿主自己读的
// 那一张就会被判成「这一页的控件变了」。
//
// 中继页是必需的：service worker 给自己发 runtime 消息收不到，宿主的处理器只
// 听来自页面与内容脚本的消息。开一个侧栏页常驻，整轮共用。
// 惰性开、用完可关：它是一个侧栏页，而后面有一段要求「此刻一个侧栏都没开」。
let relay = null;
const viaHost = async (msg) => {
  if (!relay || relay.isClosed()) {
    relay = await ctx.newPage();
    await relay.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
  }
  return await relay.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);
};
const closeRelay = async () => {
  if (relay && !relay.isClosed()) await relay.close();
  relay = null;
};

const refresh = async () => {
  const r = await viaHost({ type: 'PANEL_EXTRACT', tabId });
  table = r?.data;
  return table;
};

const highlight = async (cmd) =>
  await sw.evaluate(
    async ([id, c]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: c }, { frameId: 0 }),
    [tabId, cmd],
  );

const planFor = (step) => command(step);

const createStep = {
  ref: create?.ref,
  descriptor: { role: 'button', name: 'Create instance' },
  expectedUserAction: 'click',
  title: '创建实例',
};

/** Host visibility as the *page* sees it — the closed root gives no other view. */
const hostState = async () =>
  await page.evaluate(() => {
    const h = document.querySelector('[data-page-guide]');
    if (!h) return { present: false };
    return {
      present: true,
      display: getComputedStyle(h).display,
      popoverOpen: h.matches(':popover-open'),
    };
  });

// ---- F-1: alsoRefs must not bypass S-03 ----
await refresh();
const freshCreate = table.items.find((i) => i.name === 'Create instance');
const freshPw = table.items.find((i) => i.name === 'Password');
const alsoBlocked = await highlight(
  planFor({ ...createStep, ref: freshCreate?.ref, alsoRefs: [freshPw?.ref] }),
);
check(
  'alsoRefs 指向敏感字段同样被拒绝（F-1）',
  alsoBlocked?.ok === true && alsoBlocked?.data?.failure === 'sensitive_blocked',
  alsoBlocked?.data?.failure ?? JSON.stringify(alsoBlocked?.data),
);

// ---- F-2: CLEAR must actually clear, and must stay cleared ----
check('清除前浮层是可见的', !(await highlight(planFor(createStep)))?.data?.failure);
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
await page.waitForTimeout(500); // long enough for the hardening observer to fight back
const cleared = await hostState();
check(
  'CLEAR 之后浮层真的消失，且不会被加固逻辑写回（F-2）',
  cleared.display === 'none' && cleared.popoverOpen === false,
  JSON.stringify(cleared),
);

// ---- F-3: the page must not be able to kill the overlay ----
await page.evaluate(() => document.querySelector('[data-page-guide]')?.remove());
await page.waitForTimeout(300);
const healedHidden = await hostState();
check(
  '页面删除宿主后自愈，且保持已清除状态（F-3）',
  healedHidden.present === true && healedHidden.display === 'none',
  JSON.stringify(healedHidden),
);

// ---- clearing must not be a one-way door ----
check('CLEAR 之后仍能重新高亮', !(await highlight(planFor(createStep)))?.data?.failure);
await page.waitForTimeout(300);
const reshown = await hostState();
check(
  '重新高亮后浮层回到 Top Layer',
  reshown.display === 'block' && reshown.popoverOpen === true,
  JSON.stringify(reshown),
);

await page.evaluate(() => document.querySelector('[data-page-guide]')?.remove());
await page.waitForTimeout(300);
const healedShown = await hostState();
check(
  '引导进行中被删除宿主后自愈并重回 Top Layer（F-3）',
  healedShown.present === true && healedShown.display === 'block' && healedShown.popoverOpen === true,
  JSON.stringify(healedShown),
);

// ---- protocol: closed verb set, multi-candidate, unbound step ----
const unknownVerb = await sw.evaluate(async (id) => {
  try {
    return await chrome.tabs.sendMessage(id, { type: 'EXECUTE', ref: 'e1' }, { frameId: 0 });
  } catch (e) {
    return { threw: e.message };
  }
}, tabId);
// Behavioural half only: an unknown verb gets no well-formed answer. That the
// *listener* declines it before dispatch is structural, and is asserted in
// architecture.spec.ts against RPC_TYPES — the old fall-through-the-switch code
// produced the same observable `undefined`, so this check alone would not have
// caught it.
check('未列入白名单的指令得不到任何应答', unknownVerb?.ok === undefined, JSON.stringify(unknownVerb));
const stillAlive = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }),
  tabId,
);
check('未知指令之后通道仍然可用', stillAlive?.ok === true);

await refresh();
const stops2 = (table?.items ?? []).filter((i) => i.name === 'Stop');
const multi = await highlight(
  command({
    descriptor: { role: 'button', name: 'Stop' },
    alsoRefs: stops2.map((s) => s.ref),
    expectedUserAction: 'click',
    title: '多个候选',
    detail: '这一步的目标是下列几个之一。',
  }),
);
check(
  '无主 ref + 多候选：全部框出并回报 candidates（K-6）',
  multi?.ok === true &&
    !multi?.data?.failure &&
    multi?.data?.resolved === null &&
    multi?.data?.candidates?.length === stops2.length,
  JSON.stringify({ resolved: multi?.data?.resolved, candidates: multi?.data?.candidates?.length }),
);
// The first paint comes from the tracker's rAF, so it lands a frame *after*
// HIGHLIGHT has already returned. Reading the status straight away raced it and
// saw whatever the previous step left behind — a flake that happened to win
// until the fixture grew. Poll instead of sleeping on a guessed number.
/** The overlay's own readback — the only way into a closed shadow root. */
const guideState = async () =>
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }), tabId);

/**
 * The panel's one authoritative read, asked the way the panel asks it. Every
 * check below reads this rather than listening for a broadcast: that is the
 * property under test — what the panel shows survives a missed message.
 */
const viewOf = async (panel, id = tabId) =>
  // The panel to ask through defaults to the question block's own, which is
  // created further down — resolved at call time, never at definition time.
  await (panel ?? qaPanel).evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION', tabId: t }), id);
/** The entries of one kind, oldest first. */
const entriesOf = async (kind, panel, id = tabId) =>
  ((await viewOf(panel, id))?.conversation?.entries ?? []).filter((e) => e.kind === kind);
/** The newest entry of one kind, or null. */
const lastEntry = async (kind, panel, id = tabId) => (await entriesOf(kind, panel, id)).at(-1) ?? null;
/** Waits for an entry of `kind` whose text contains `text`. */
const waitForEntry = async (kind, text = '', ms = 8000, panel = qaPanel, id = tabId) =>
  await waitUntil(async () => {
    const e = await lastEntry(kind, panel, id);
    return Boolean(e && String(e.text).includes(text));
  }, ms);

const overlayStatus = async (want, ms = 2000) => {
  const until = Date.now() + ms;
  let last;
  do {
    const s = await sw.evaluate(
      async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
      tabId,
    );
    last = s?.data?.status;
    if (last === want) return last;
    await page.waitForTimeout(50);
  } while (Date.now() < until);
  return last;
};

check(
  '多候选时浮层处于 ambiguous 态',
  (await overlayStatus('ambiguous')) === 'ambiguous',
  await overlayStatus('ambiguous', 0),
);

const unbound = await highlight(
  command({
    descriptor: { role: 'button', name: 'Nowhere' },
    expectedUserAction: 'click',
    title: '未绑定的步骤',
  }),
);
check(
  '页面上确实没有的目标走单一失败通道',
  unbound?.ok === true && unbound?.data?.failure === 'ref_not_found',
  unbound?.data?.failure,
);

// ---- 症状 2：画之前先认页面（05c）----
// 同文档切换（pushState）不产生新快照，元素也还连着：只问「快照新不新鲜」的
// 守卫会把属于上一页的一步，自信地画在这一页上。
{
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  const drawnFrom = await refresh();
  const createNow = drawnFrom?.items?.find((i) => i.name === 'Create instance');
  const home = await page.evaluate(() => location.href);
  await page.evaluate(() => history.pushState(null, '', '/elsewhere'));
  const offView = await highlight(
    command({ ref: createNow?.ref, descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: 'x' }),
  );
  check(
    '同文档换了地址 → 上一页画出来的一步被拒绝（view_moved），不画、也不按描述符重绑',
    offView?.ok === true && offView?.data?.failure === 'view_moved' && !offView?.data?.resolved,
    JSON.stringify(offView?.data),
  );
  check('…浮层上什么都没有', (await guideState())?.data?.visible !== true, JSON.stringify((await guideState())?.data?.status));
  await page.evaluate((url) => history.replaceState(null, '', url), home);
}

// ---- F-8: a step that never carried a ref binds at render time ----
const descOnly = await highlight(
  command({
    descriptor: { role: 'button', name: 'Create instance' },
    expectedUserAction: 'click',
    title: '只有 descriptor 的步骤',
  }),
);
check(
  '只带 descriptor 的步骤在渲染时完成绑定（F-8）',
  descOnly?.ok === true && !descOnly?.data?.failure && descOnly?.data?.resolved,
  `resolved=${descOnly?.data?.resolved}`,
);

// ---- F-6: binding must search the whole page, not the projected slice ----
const offscreen = (table?.items ?? []).find((i) => i.name === 'Far below the fold');
const belowFold = await highlight(
  command({
    descriptor: { role: 'button', name: 'Far below the fold' },
    expectedUserAction: 'click',
    title: '视口外的目标',
  }),
);
check(
  '视口带之外的目标也能绑上（F-6）',
  belowFold?.ok === true && !belowFold?.data?.failure && belowFold?.data?.resolved,
  `投影表内是否存在=${Boolean(offscreen)} resolved=${belowFold?.data?.resolved}`,
);

// ---- F-7: SPA rebuilds the element; "重试定位" must recover it ----
await highlight(planFor(createStep));
await page.evaluate(() => {
  const b = document.getElementById('create');
  const fresh = b.cloneNode(true);
  b.replaceWith(fresh); // same id and text, different node — the old ref is dead
});
await page.waitForTimeout(200);
const afterRebuild = await highlight(planFor(createStep));
check(
  'SPA 重建元素后按 descriptor 找回（F-7）',
  afterRebuild?.ok === true && !afterRebuild?.data?.failure && afterRebuild?.data?.resolved,
  `resolved=${afterRebuild?.data?.resolved} failure=${afterRebuild?.data?.failure}`,
);
await highlight(planFor(createStep));

// ═══════════════════════════════════════════════════════════════════════════
// 真机测试暴露的两个缺陷（2026-08-07）
// ═══════════════════════════════════════════════════════════════════════════
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await obs.evaluate(() => {
    window.__ev = [];
    chrome.runtime.onMessage.addListener((m) => window.__ev.push(m));
  });
  await page.bringToFront();

  // 目标不存在 → 失效屏。那块卡片是那一刻用户唯一能碰的东西，所以它必须真的
  // 能接收点击（下面用命中测试扫出它的位置来证明）。
  //
  // 「跳过」那一半已经不存在了：它只对固定计划有意义，而固定计划已经删掉——
  // 模型驱动的引导跳过之后会重新规划、把同一步原样递回来。
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'POINT_AT',
        tabId: id,
        step: { descriptor: { role: 'button', name: 'Nonexistent target' }, expectedUserAction: 'click', title: '找不到的那一个' },
      }),
    tabId,
  );
  await page.waitForTimeout(900);
  check('目标不存在时进入失效屏', (await overlayStatus('lost')) === 'lost');

  // Click the real button, at real coordinates. A closed shadow root makes
  // `elementFromPoint` return the host, which is enough to locate the card.
  const box = await page.evaluate(() => {
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let x = 0; x < window.innerWidth; x += 8)
      for (let y = 0; y < window.innerHeight; y += 8) {
        const el = document.elementFromPoint(x, y);
        if (el?.hasAttribute?.('data-page-guide')) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  });
  check('失效屏的卡片可以接收点击', box !== null, JSON.stringify(box));

  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
}

// ---- 用户点了目标：内容脚本报得出来 ----
// 「点了之后流程往前走」这半句随固定计划一起删了——模型驱动的引导靠的是宿主把
// 这条读数交给模型再规划，那条链在 readings.spec.ts 里测（真浏览器里只剩「报得
// 出来」这一半，由下面「用过不是丢了」那一段覆盖）。

// ---- 失效屏必须继续盯着页面：目标出现了就自己接上 ----
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'POINT_AT',
        tabId: id,
        step: { descriptor: { role: 'button', name: 'Appears later' }, expectedUserAction: 'click', title: '稍后出现' },
      }),
    tabId,
  );
  await page.waitForTimeout(700);
  check('目标尚不存在时先进失效屏', (await overlayStatus('lost')) === 'lost');

  // Exactly the GitHub shape: the user opens a menu and the target appears.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'Appears later';
    document.querySelector('main').appendChild(b);
  });
  check(
    '目标出现后自动接上，无需任何用户操作',
    (await overlayStatus('shown', 6000)) === 'shown',
    `失效屏是静态的：页面变了也不会重新尝试 — ${JSON.stringify({ overlay: (await guideState())?.data, page: await page.evaluate(() => document.visibilityState) })}`,
  );

  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
  await page.evaluate(() => [...document.querySelectorAll('main > button')].filter((b) => b.textContent === 'Appears later').forEach((b) => b.remove()));
}

// ---- 页面每一帧都忙满、从来没有空闲：接着找、「页面自己变了」照样有人看 ----
//
// 两者都在页面变了之后、主线程下一次有空时看一眼。曾经等的是空闲期
// （requestIdleCallback）：页面把每一帧都占满时，空闲期一次也不来——目标出现了
// 没人看，页面变了没人报。静止的页面上也见过它六秒不来（整套件约二十轮一次）。
// 这里把页面忙满，让它确定地出现。
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await obs.evaluate(() => {
    window.__changed = 0;
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'PAGE_STRUCTURE_CHANGED') window.__changed += 1;
    });
  });
  await page.bringToFront();
  const heading = await page.evaluate(() => document.querySelector('h1').textContent);
  // Every frame's budget spent by the page itself: no idle period, ever.
  await page.evaluate(() => {
    window.__busy = true;
    const frame = () => {
      if (!window.__busy) return;
      const t = performance.now();
      while (performance.now() - t < 25);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'POINT_AT',
        tabId: id,
        step: { descriptor: { role: 'button', name: 'Appears while busy' }, expectedUserAction: 'click', title: '忙的时候出现' },
      }),
    tabId,
  );
  check('（前提）页面忙满时，目标尚不存在先进失效屏', (await overlayStatus('lost', 5000)) === 'lost');

  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'Appears while busy';
    document.querySelector('main').appendChild(b);
  });
  check(
    '页面每一帧都忙满、没有空闲时，目标出现了照样接上',
    (await overlayStatus('shown', 5000)) === 'shown',
    JSON.stringify((await guideState())?.data?.watch),
  );

  await page.evaluate(() => void (document.querySelector('h1').textContent = 'Instances · 忙的时候变了'));
  const reported = await waitUntil(async () => (await obs.evaluate(() => window.__changed)) > 0, 5000);
  check('页面每一帧都忙满时，页面自己变了照样报给宿主', reported, `PAGE_STRUCTURE_CHANGED ×${await obs.evaluate(() => window.__changed)}`);

  await page.evaluate((h) => {
    window.__busy = false;
    document.querySelector('h1').textContent = h;
    [...document.querySelectorAll('main > button')].filter((b) => b.textContent === 'Appears while busy').forEach((b) => b.remove());
  }, heading);
  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
}

// The blocks above leave the page scrolled to wherever their last target was;
// the inspector section below reads coordinates from the top of the page.
await page.evaluate(() => window.scrollTo(0, 0));

// ---- 非安全上下文（普通 http:// 域名）----
{
  const plain = await ctx.newPage();
  await plain.goto('http://plain.test/', { waitUntil: 'load' });
  await plain.waitForTimeout(700);
  const plainTab = await sw.evaluate(
    async () => (await chrome.tabs.query({ url: 'http://plain.test/*' }))[0]?.id ?? null,
  );
  const secure = await plain.evaluate(() => window.isSecureContext);
  check('这确实是一个非安全上下文', secure === false, `isSecureContext=${secure}`);

  const ex2 = await sw.evaluate(
    async (id) =>
      await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 400 } }, { frameId: 0 }),
    plainTab,
  );
  check(
    '普通 http:// 站点上抽取正常（内网控制台的形状）',
    ex2?.ok === true && ex2.data.items.length > 0,
    ex2?.ok ? `${ex2.data.items.length} 个控件` : ex2?.message?.slice(0, 60),
  );
  await plain.close();
  await page.bringToFront();
}

// ═══════════════════════════════════════════════════════════════════════════
// BYOK 密钥隔离
// ═══════════════════════════════════════════════════════════════════════════
{
  // The panel must never be able to read a key out of the page process, and the
  // content script must not be able to reach extension storage at all.
  await sw.evaluate(async () => await chrome.storage.local.set({ provider: { apiKey: 'sk-e2e-secret-canary' } }));
  const leaked = await page.evaluate(() => document.documentElement.outerHTML.includes('sk-e2e-secret-canary'));
  check('页面 DOM 里没有密钥痕迹', leaked === false);
  const csStorage = await sw.evaluate(async (id) => {
    const r = await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 5 } }, { frameId: 0 });
    return JSON.stringify(r).includes('sk-e2e-secret-canary');
  }, tabId);
  check('抽取结果里没有密钥痕迹', csStorage === false);

  // NOT asserted here, deliberately: "a content script cannot read the key".
  //
  // `chrome.storage.local` is exposed to content scripts by default, so that
  // property comes from the `setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`
  // call in `background.ts`. Playwright can only evaluate in the page's main
  // world, where `chrome.storage` was never defined — an assertion written
  // there passes for the wrong reason and would read as proof while proving
  // nothing. The isolated world is not reachable without adding a debug verb to
  // the closed RPC set, which costs more than the assertion is worth.
  //
  // What does hold the line: the platform call above, and the
  // `architecture.spec.ts` guard that the content script never imports storage.
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
}

// ---- 任务 14：检视器 ----
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);

// Events are broadcast, so listen from a real extension page — the side panel
// is the actual consumer at runtime.
const insp = await ctx.newPage();
await insp.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await insp.evaluate(() => {
  window.__picked = [];
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'ELEMENT_PICKED') window.__picked.push(m);
  });
});
await page.bringToFront();

await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'INSPECT', on: true }, { frameId: 0 }),
  tabId,
);

// Click one of the two same-named row buttons: the interesting case, because
// `{role,name}` alone matches both and the ladder has to climb.
const stopBox = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('td button')].find(
    (b) => b.textContent.trim() === 'Stop',
  );
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
await page.mouse.move(stopBox.x, stopBox.y);
await page.waitForTimeout(150);
const hoverOutline = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
  tabId,
);
check('检视模式下悬停即描边', hoverOutline?.data?.visible === true, `status=${hoverOutline?.data?.status}`);

await page.mouse.click(stopBox.x, stopBox.y);
await page.waitForTimeout(300);
check('选中后描边撤掉', (await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
  tabId,
))?.data?.visible === false);

const pickedList = await insp.evaluate(() => window.__picked ?? []);
const pick = pickedList[0];
check(
  '选中元素后产出 descriptor',
  Boolean(pick),
  pick ? `${pick.label} → ${JSON.stringify(pick.descriptor)}` : '没有收到 ELEMENT_PICKED',
);
check(
  'L-0：产出的 descriptor 在生成当刻唯一且正确',
  pick?.matches === 1 && pick?.correct === true,
  `matches=${pick?.matches} correct=${pick?.correct} rung=${pick?.rung}`,
);
check('重名按钮迫使阶梯往上爬到 scope', pick?.rung === 'scope', pick?.rung);

// And the descriptor must actually point back at the element that was clicked.
const roundTrip = await highlight(
  command({
    descriptor: pick?.descriptor,
    expectedUserAction: 'click',
    title: '回绑检视产物',
  }),
);
const clickedRect = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('td button')].find(
    (b) => b.textContent.trim() === 'Stop',
  );
  const r = btn.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
});
check(
  '检视产物回绑到的正是被点的那个元素',
  JSON.stringify(roundTrip?.data?.rect) === JSON.stringify(clickedRect),
  `绑到 ${JSON.stringify(roundTrip?.data?.rect)}，被点的是 ${JSON.stringify(clickedRect)}`,
);
// The click must be swallowed, not merely ignored. A plain button proves
// nothing — pick a link, which would navigate away from the very page the
// author is annotating.
await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'INSPECT', on: true }, { frameId: 0 }),
  tabId,
);
const urlBefore = page.url();
await page.click('nav a[href="/docs"]');
await page.waitForTimeout(600);
check('检视时点链接不会导航走', page.url() === urlBefore, page.url().slice(-24));
const pickedLink = (await insp.evaluate(() => window.__picked ?? []))[1];
check(
  '被吞掉的那次点击仍然产出了 descriptor',
  pickedLink?.descriptor?.role === 'link' && pickedLink?.descriptor?.name === 'Docs',
  JSON.stringify(pickedLink?.descriptor),
);

await insp.close();
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
await highlight(planFor(createStep));

// ---- the page actively fighting back ----
await page.evaluate(() => {
  const h = document.querySelector('[data-page-guide]');
  h.style.display = 'none';
  h.style.transform = 'scale(0)';
  h.style.opacity = '0';
});
await page.waitForTimeout(300);
const tampered = await hostState();
check(
  '页面篡改宿主内联样式后被复原',
  tampered.display === 'block' && tampered.popoverOpen === true,
  JSON.stringify(tampered),
);

await page.evaluate(() => {
  const s = document.createElement('style');
  s.textContent = '[data-page-guide]{display:none!important;visibility:hidden!important}';
  document.head.appendChild(s);
});
await page.waitForTimeout(300);
const vsSheet = await hostState();
check('页面 !important 样式表压不住宿主', vsSheet.display === 'block', JSON.stringify(vsSheet));

// `reassert` writes styles from inside a MutationObserver callback. If a write
// ever produced a new record, that is an unbounded microtask loop — a frozen
// tab, on every page we run on. Prove it converges under sustained attack.
const t0 = Date.now();
await page.evaluate(async () => {
  for (let i = 0; i < 50; i++) {
    document.querySelector('[data-page-guide]')?.remove();
    await new Promise((r) => setTimeout(r, 0));
  }
});
const survived = await page.evaluate(() => 1 + 1);
check(
  '连续 50 次删除宿主：自愈收敛，页面未卡死',
  survived === 2 && Date.now() - t0 < 5000,
  `${Date.now() - t0}ms`,
);
await page.waitForTimeout(300);
const afterSiege = await hostState();
check('围攻结束后浮层仍在', afterSiege.present === true && afterSiege.display === 'block');

// ═══════════════════════════════════════════════════════════════════════════
// Task 11 — the host owns the flow, so it survives both a navigation and the
// side panel being closed. Driven entirely through the host: nothing here talks
// to the content script, exactly like the side panel at runtime.
// ═══════════════════════════════════════════════════════════════════════════

// `chrome.runtime.sendMessage` is never delivered to the sender's own context,
// so the host cannot be driven from `sw.evaluate`. Drive it from the real side
// panel page instead — the same channel the panel uses at runtime.
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
const host = async (msg) => await panel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);

await host({ type: 'END_GUIDE', tabId });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(600);

// ═══════════════════════════════════════════════════════════════════════════
// Task 6 — the panel no longer talks to the content script directly for
// "抽取本页元素" or the inspect toggle; both now go through the host as
// `PANEL_EXTRACT` / `PANEL_INSPECT`. The content script's own EXTRACT and
// INSPECT behaviour is already covered by the direct-RPC checks above and by
// 任务 14 — what is unproven until now is the relay itself: that the host
// injects, forwards, and returns the content script's answer unchanged, over
// the exact channel (`chrome.runtime.sendMessage`) the real panel uses.
// ═══════════════════════════════════════════════════════════════════════════

const panelExtract = await host({ type: 'PANEL_EXTRACT', tabId });
check(
  '侧栏「抽取本页元素」经宿主转发，拿回投影表（PANEL_EXTRACT）',
  panelExtract?.ok === true &&
    Array.isArray(panelExtract?.data?.items) &&
    panelExtract.data.items.length > 0,
  `ok=${panelExtract?.ok} items=${panelExtract?.data?.items?.length}`,
);

// ---- 嵌入框架第二层：真的进去读，并且能指到里面 ----
// 第一层（已完成）只是如实说「这里有个框架，我看不到」。第二层要把里面的控件
// 也放进同一张表，并且把高亮送进那个文档——送错文档的后果是静默的：渲染器拿
// 顶层的地址跟框架自己的地址一比，直接判 view_moved，什么都不画。
{
  const framed = panelExtract?.data;
  const inFrame = (framed?.items ?? []).filter((i) => /^f\d+e/.test(i.ref));
  check(
    '框架里的控件进了同一张表，ref 带着框架身份（f<id>e<n>）',
    inFrame.length >= 2 && inFrame.some((i) => i.name === '去付款'),
    JSON.stringify(inFrame.map((i) => `${i.ref}:${i.name}`).slice(0, 5)),
  );
  check(
    '读进来的框架不再算「洞」：frames 里只剩进不去的那些',
    (framed?.frames ?? []).every((f) => f.label !== '账单组件'),
    JSON.stringify(framed?.frames ?? null),
  );
  check(
    '每一份文档当时的快照与地址都记下了（命令靠它送回对的地方）',
    (framed?.sources ?? []).length === 2 &&
      framed.sources[0].frameId === 0 &&
      framed.sources[1].frameId !== 0 &&
      framed.sources[1].url.includes('/billing-widget'),
    JSON.stringify(framed?.sources ?? null),
  );
  check(
    '1×1 的跟踪像素没有被当成值得进去的框架',
    (framed?.sources ?? []).length === 2,
    JSON.stringify((framed?.sources ?? []).map((x) => x.url)),
  );

  // 指里面那个「去付款」：命令必须带着那个框架自己的快照与地址，发到那个框架。
  const payRef = inFrame.find((i) => i.name === '去付款')?.ref;
  const src = (framed?.sources ?? []).find((x) => x.frameId !== 0);
  const ack = await sw.evaluate(
    async ([id, cmd, frameId]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId }),
    [
      tabId,
      {
        sessionId: 'e2e-frame',
        presentationId: 'e2e-frame#1',
        snapshotId: src?.snapshotId,
        view: src?.url,
        mode: 'guide',
        step: { ref: payRef, descriptor: { role: 'button', name: '去付款' }, expectedUserAction: 'click', title: '去付款' },
        autoScroll: false,
      },
      src?.frameId,
    ],
  );
  check('把高亮送进那个框架：框真的画出来了', ack?.ok === true && ack.data?.resolved === payRef, JSON.stringify(ack));

  // 框画在框架自己的坐标系里（Rect 的注释一直这么写），所以拿框架里的真实坐标比。
  const trueRect = await page.frameLocator('#billing-frame').locator('#pay-now').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  });
  check(
    '框的位置用的是框架自己的坐标系',
    JSON.stringify(ack?.data?.rect) === JSON.stringify(trueRect),
    `overlay=${JSON.stringify(ack?.data?.rect)} target=${JSON.stringify(trueRect)}`,
  );

  // 顶层的地址发进框架 → 必须被判 view_moved。这一条是反向证明：路由要是写错了，
  // 上面那几条会因为「反正画上了」而蒙混过关。
  const wrongView = await sw.evaluate(
    async ([id, cmd, frameId]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId }),
    [
      tabId,
      {
        sessionId: 'e2e-frame',
        presentationId: 'e2e-frame#2',
        snapshotId: src?.snapshotId,
        view: `http://127.0.0.1:${PORT}/`,
        mode: 'guide',
        step: { ref: payRef, descriptor: { role: 'button', name: '去付款' }, expectedUserAction: 'click', title: '去付款' },
        autoScroll: false,
      },
      src?.frameId,
    ],
  );
  check(
    '拿顶层地址往框架里发 → view_moved，什么都不画（路由写错时这条会变绿，所以它是反证）',
    wrongView?.ok === true && wrongView.data?.failure === 'view_moved',
    JSON.stringify(wrongView),
  );
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 05 — `PANEL_EXTRACT` now sizes its budget from `(await loadConfig()).contextWindow`
// instead of a hardcoded 32_000. The fixture page alone has too few interactive
// elements (~22) for either budget tier (120 or 400) to actually truncate
// anything, so a bulk batch of buttons is appended to observe the cut.
// ═══════════════════════════════════════════════════════════════════════════
await page.evaluate(() => {
  const box = document.createElement('div');
  box.id = 'e2e-bulk-05';
  // 500, not 200: the tiers moved to 120 / 400, and at 200 the
  // default tier no longer cuts anything — the anchor below would then be
  // comparing two untruncated tables and proving nothing.
  //
  // This batch now carries more than its own weight. Since the budget moved,
  // the `repo-home` eval fixture (326 candidates) no longer truncates either,
  // so these two checks are the only place the tail cut runs against a real
  // extraction at all. Shrinking this number silently removes that coverage.
  for (let i = 0; i < 500; i++) {
    const b = document.createElement('button');
    b.textContent = `Bulk action ${i}`;
    box.appendChild(b);
  }
  document.body.appendChild(box);
});

await sw.evaluate(async () => await chrome.storage.local.set({ provider: { contextWindow: 8_000 } }));
const smallWindowExtract = await host({ type: 'PANEL_EXTRACT', tabId });
check(
  'contextWindow 调到 8000 时，PANEL_EXTRACT 的元素表裁到 120 条以内（对照默认 32000 时上限是 400）',
  smallWindowExtract?.ok === true &&
    smallWindowExtract.data.items.length <= 120 &&
    smallWindowExtract.data.omitted > 0,
  `items=${smallWindowExtract?.data?.items?.length} omitted=${smallWindowExtract?.data?.omitted}`,
);

// Anchor: 缺省（或没设）contextWindow 时，这一页的表不超过 budgetFor(32000)
// 给的 400 条，而且顶层文档那一部分仍然是一次正常的抽取。
//
// 这条原先是「逐项等于一次 maxNodes:400 的直接抽取」。层二之后那个等号不再成立，
// 而且**不成立才是对的**：这一页里嵌着一个账单组件，读进来的那几条控件也要算进
// 同一份预算，所以顶层拿到的是 400 减去分给框架的那一份。等号换成两条不变量——
// 总数不超预算（预算的承诺），顶层那部分是直接抽取结果的子集（没有凭空多出东西）。
// `ref`、`snapshotId`、`stats.ms` 照旧排除：它们是每次调用各不相同的产物。
await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
const defaultWindowExtract = await host({ type: 'PANEL_EXTRACT', tabId });
const oldHardcodedBudgetExtract = await sw.evaluate(
  async (id) =>
    await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 400 } }, { frameId: 0 }),
  tabId,
);
const stableShape = (t) => ({
  items: t.items.map(({ ref, ...rest }) => rest),
  omitted: t.omitted,
  ambiguity: t.ambiguity,
  degraded: t.degraded,
});
const topSlice = (t) => t.items.filter((i) => !/^f\d+e/.test(i.ref)).map(({ ref, ...rest }) => JSON.stringify(rest));
const wholeOld = new Set(stableShape(oldHardcodedBudgetExtract.data).items.map((i) => JSON.stringify(i)));
check(
  'contextWindow 缺省（32000）时，整页的表不超预算，且顶层那部分仍是一次正常抽取的子集',
  defaultWindowExtract?.ok === true &&
    defaultWindowExtract.data.items.length <= 400 &&
    defaultWindowExtract.data.items.length > 300 &&
    topSlice(defaultWindowExtract.data).every((i) => wholeOld.has(i)),
  `items=${defaultWindowExtract?.data?.items?.length}（其中框架 ${defaultWindowExtract?.data?.items?.filter((i) => /^f\d+e/.test(i.ref)).length}）vs 直接抽取 ${oldHardcodedBudgetExtract?.data?.items?.length}`,
);

await page.evaluate(() => document.getElementById('e2e-bulk-05')?.remove());

const stopBoxPanel = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('td button')].find((b) => b.textContent.trim() === 'Stop');
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});

await host({ type: 'PANEL_INSPECT', tabId, on: true });
await page.mouse.move(stopBoxPanel.x, stopBoxPanel.y);
await page.waitForTimeout(150);
const inspectOnViaPanel = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
  tabId,
);
check(
  '侧栏「检视元素」经宿主转发，检视模式真的开了（PANEL_INSPECT on:true）',
  inspectOnViaPanel?.data?.visible === true,
  `status=${inspectOnViaPanel?.data?.status}`,
);

await host({ type: 'PANEL_INSPECT', tabId, on: false });
// Move off and back onto the same control: if the relay had not really turned
// inspect mode off in the content script, this would re-arm the outline.
await page.mouse.move(stopBoxPanel.x + 40, stopBoxPanel.y);
await page.mouse.move(stopBoxPanel.x, stopBoxPanel.y);
await page.waitForTimeout(150);
const inspectOffViaPanel = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
  tabId,
);
check(
  '侧栏「取消检视」经宿主转发后，悬停不再描边（PANEL_INSPECT on:false）',
  inspectOffViaPanel?.data?.visible === false,
  // `status` is sticky in `Overlay.outline()` — it is only written on a
  // truthy rect, so printing it here would echo the stale 'shown' from the
  // check above rather than anything this assertion is about. `visible` is
  // the field the assertion actually reads.
  `visible=${inspectOffViaPanel?.data?.visible}`,
);

// 文件级的 `host()` 到这里为止：它绑在 `panel` 上，而下面的段落各自开自己的侧栏。
// （这一句原先在下面那段跨页测试里，那段随固定计划一起删了。）
await panel.close();

// 下面的段落都假定标签页停在首页——跨页那段原先会把它带回来，现在明写一次。
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

// ---- 跨页的固定计划：随 planSource 一起删了 ----
// 这一段原先测的是「点了就前进 / 刷新不算前进 / 用户自己去了别处不算前进」，
// 三条都是固定计划独有的语义。模型驱动的引导在这些情形下的设计**恰好相反**：
// 页面一变就重新规划，而且调用在途时刻意不重画手上那一步（L-4，见
// `stepOnScreen`）。所以这里不是少了覆盖，是那三条性质本身不存在了。

// ---- a goal with no model configured is answered, not silently re-routed ----
// There is nothing to plan with. The old local matcher used to take over here,
// and on real pages it almost never produced a usable answer; the host now says
// so, starts nothing, and leaves the guide that is already running alone.
const panelA = await ctx.newPage();
await panelA.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
const asked = await panelA.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: id, text: 'create instance' }),
  tabId,
);
await page.waitForTimeout(400);
const noModelAnswers = ((await panelA.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION', tabId: t }), tabId))?.conversation?.entries ?? [])
  .filter((e) => e.kind === 'note')
  .map((e) => e.text);
check(
  '未配置模型时带目标起引导：不启动，并如实说明',
  asked?.ok === false && noModelAnswers.some((t) => String(t).includes('还没有配置模型')),
  JSON.stringify({ asked, noModelAnswers }),
);
const startedAnyway = await sw.evaluate(
  async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null,
  tabId,
);
// 被拒之后一条线程都不该留下。原先这里断言的是「原来那条固定计划原样留着」——
// 那趟引导随 planSource 一起没了；而「有引导在跑时这句话交给它、不看模型配置」
// 是另一条性质，走的是 applySaid，在 readings.spec.ts 里测。
check('未配置模型被拒之后，没有起任何线程', startedAnyway === null, JSON.stringify(startedAnyway));
await panelA.close();

const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await panel2.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
// 就地读，不用 `threadOf`：那个助手在这一行之后才声明。
await waitUntil(
  async () => (await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, tabId)) === null,
  6000,
);
const flowCleared = await sw.evaluate(async (id) => {
  const k = `guide:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('结束引导后记录被清除', flowCleared === null);
// 等浮层自己落下来：CLEAR 是异步发出去的，而上面那次「等线程清空」现在会立刻
// 返回（本来就没有线程），不再顺手给它时间。
await overlayStatus('idle', 4000);
// 这一段前面刚跳回首页，导航会把内容脚本连浮层一起带走——所以「没有浮层」和
// 「浮层在但什么都不显示」都算过：要断言的是屏上不再留着任何一步。
const overlayAfterEnd = (await guideState())?.data ?? null;
check('结束引导后屏上不再留着任何一步', overlayAfterEnd === null || overlayAfterEnd.visible === false, JSON.stringify(overlayAfterEnd));
await panel2.close();

// ═══════════════════════════════════════════════════════════════════════════
// 一个入口（08b）——侧栏只有一个输入框：想做什么、想问这一页什么，都说在这里，
// 都走宿主的同一个循环。对着打桩的模型端点跑，零真实网络：`ctx.route()` 拦下
// 这个上下文里所有页面、现在和以后的 `chat/completions`——在真正发请求的侧栏
// 存在之前就登记好，所以不会有请求先于它出去。
//
// 这一段原先证明的是独立问答路径的保证。仍然有意义的，逐条改走新入口：
//   Q-1/Q-2 回答出现、依据框对了；Q-3 要选一个时候选全部框出、不替用户选；
//   Q-5 坏形状只修一次、修复轮是原请求加一对说明；Q-6 页面换了之后回答作废；
//   Q-7 新的一句取代在途的那句，并且真的叫停了网络请求；Q-8 引导途中问一句，
//   引导照走；Q-9 回答引用了密码框 → 整个回答被拒，浮层一次都没画；Q-10 依据
//   在页面重渲染之后不重绑。
// 测已删机制的删掉：need_text（已并进 ask 的 wants: text，单测覆盖）、面板转发
// 高亮的 RPC（面板不再转发，宿主自己画）、绕过面板直接请求高亮敏感元素（前面
// 两处 `sensitive_blocked` 已经直接对内容脚本证过）。切标签页不再需要专门的
// 保证：回答落在它所属标签页的那一趟里，侧栏只显示当前标签页的回答。
// ═══════════════════════════════════════════════════════════════════════════

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(400);

const QA_BASE = 'https://qa-stub.test/v1';
await sw.evaluate(
  async (base) =>
    await chrome.storage.local.set({
      provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
    }),
  QA_BASE,
);

/** Every request the stub endpoint received, in arrival order — one counter
 *  shared by every section from here on. Each records `requestLog.length`
 *  before acting and diffs afterwards, so a request still in flight from an
 *  earlier section never races a reset. */
const requestLog = [];
/** Swapped per section. Receives the Playwright `Route` and the parsed request
 *  body; must eventually settle it (`route.fulfill`, or let it hang). */
let modelHandler = async (route) => {
  await route.fulfill({ status: 500, body: 'unstubbed request reached the model stub' });
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every ref a *live* request carries for a given role/name, straight out of
 *  the serialized element table `buildGuideUserMessage` wraps into the user
 *  message (`project.ts`'s `toPromptText`: `${ref} ${role} ${JSON-quoted name}`).
 *  Never a value computed ahead of time — every extraction commits a fresh
 *  snapshot generation, invalidating whatever ref an earlier one produced, so
 *  the only trustworthy source is the very request being answered right now. */
function liveRefs(body, role, name) {
  const userMsg = body.messages?.find((m) => m.role === 'user')?.content ?? '';
  const re = new RegExp(`(e\\d+) ${escapeRe(role)} ~?${escapeRe(JSON.stringify(name))}`, 'g');
  return [...userMsg.matchAll(re)].map((m) => m[1]);
}
const liveRef = (body, role, name) => liveRefs(body, role, name)[0] ?? null;

/** Any ref on this call's table other than `exclude`. Lets a stub produce a
 *  genuinely *different* second step without hard-coding a control name that
 *  may not be on the page at that moment. */
function otherRef(body, exclude) {
  const userMsg = body.messages?.find((m) => m.role === 'user')?.content ?? '';
  const all = [...userMsg.matchAll(/(e\d+) \w+ ~?"/g)].map((m) => m[1]);
  return all.find((r) => r !== exclude) ?? exclude;
}

/** Everything the user side of a request says, joined — the goal, the
 *  wake-up message, what the user said since. */
const userText = (body) => (body.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');

/** Streams a tool call the way the real endpoint does: the function name on
 *  the first fragment, `arguments` split across the next ones. `id` only when a
 *  section needs the call answered by id (the repair round's pair). */
function sseToolBody(name, args, id) {
  const half = Math.ceil(args.length / 2);
  const frag = (o) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [o] } }] })}\n\n`;
  return [
    frag({ index: 0, ...(id ? { id } : {}), function: { name, arguments: args.slice(0, half) } }),
    frag({ index: 0, function: { arguments: args.slice(half) } }),
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/** The envelope's `intent` becomes the function name and everything else the
 *  arguments — the model is never asked to write `intent`. */
const fulfillEnvelope = (route, envelope) => {
  const { intent, ...args } = envelope;
  return route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: sseToolBody(intent, JSON.stringify(args)),
  });
};

await ctx.route(`${QA_BASE}/chat/completions`, async (route) => {
  const body = route.request().postDataJSON();
  requestLog.push({ body, at: Date.now() });
  await modelHandler(route, body);
});

const qaPanel = await ctx.newPage();
await qaPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();

const entry = qaPanel.locator('.composer input');


/** Enter, like a user typing fast: the send button is disabled only while the
 *  box is empty, and Enter has no guard of its own. */
const say = async (text) => {
  await entry.fill(text);
  await entry.press('Enter');
};
const clearOverlay = async () =>
  void (await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId));

const threadOf = async () =>
  await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, tabId);
const endGuideHere = async () => {
  await qaPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await page.waitForTimeout(200);
};

/** Never throws — a wrong assumption in one section must not crash the
 *  checks after it. Mirrors this file's own `overlayStatus` idiom. */
async function waitUntil(fn, timeoutMs = 5000, stepMs = 60) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
async function pollText(locatorFn, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const t = await locatorFn().innerText().catch(() => null);
    if (t !== null) return t.trim();
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}
async function pollTexts(locatorFn, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const t = await locatorFn().allInnerTexts().catch(() => []);
    if (t.length > 0) return t;
    await new Promise((r) => setTimeout(r, 80));
  }
  return [];
}
function deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}
const rectOf2 = async (id) =>
  await page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }, id);
/**
 * The newest answer, once it is the one this block is waiting for. The
 * conversation keeps every earlier answer, so reading "the last one" without
 * waiting would read the previous block's.
 */
const answerText = async (fragment = '', ms = 8000) => {
  await waitUntil(async () => {
    const e = await lastEntry('answer');
    return Boolean(e && String(e.text).includes(fragment));
  }, ms);
  return (await lastEntry('answer'))?.text ?? null;
};
const closeAnswerIfOpen = async () => await clearOverlay();
/** The panel's tools live one page behind the conversation (「工具与设置」),
 *  each one a row further in; the way back is two named buttons. */
const openSettings = async (panel, row) => {
  await panel.getByRole('button', { name: '工具与设置', exact: true }).click({ timeout: 2000 });
  await panel.getByRole('button', { name: row }).click({ timeout: 2000 });
};
const backToChat = async (panel) => {
  await panel.getByRole('button', { name: '返回工具与设置', exact: true }).click({ timeout: 2000 });
  await panel.getByRole('button', { name: '返回对话', exact: true }).click({ timeout: 2000 });
};
/** The cost lines of every open panel, as numbers (「N 次调用 · 主调用 P / 修复 R」),
 *  summed. A call is counted on the panel that carried it out, and which one
 *  that is the host arbitrates — so no single panel is the one to read. */
const costShown = async () => {
  const panels = ctx.pages().filter((p) => p.url().endsWith('/sidepanel.html'));
  // The cost line is on 本次用量; each panel goes there, is read, and comes
  // back to its conversation. A panel with no calls yet has no line.
  const lines = await Promise.all(
    panels.map(async (p) => {
      try {
        await openSettings(p, '本次用量');
        const line = await p.evaluate(() => document.querySelector('.usage-calls')?.textContent ?? '');
        await backToChat(p);
        return line;
      } catch {
        return '';
      }
    }),
  );
  const sum = (re) => lines.reduce((n, t) => n + Number(t.match(re)?.[1] ?? 0), 0);
  return { calls: sum(/(\d+)\s*次调用/), repairs: sum(/修复\s*(\d+)/) };
};

// ─────────────────────────────────────────────────────────────────────────
// Q-1 — 问这一页的事：回答出现在侧栏
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER = '这段是控制台的实例列表，点 Create instance 按钮可以创建一个新实例。';
  modelHandler = async (route) => await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: [] });
  await say('这个页面是做什么用的？');
  const text = await answerText(ANSWER);
  check('Q-1：在唯一的输入框里问 → 侧栏的「回答」里是模型的原话', typeof text === 'string' && text.includes(ANSWER), text ?? '(超时未出现)');
  await closeAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-1b — 回答里的 Markdown：加粗、列表、行内代码按意思显示；引到的 HTML 只是文字
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER =
    '用的是 **fair-code** 许可：\n\n- **Sustainable Use License**——核心代码\n- 企业版见 `LICENSE_EE.md`\n\n' +
    '页面上写着 <img src=x onerror="window.__pwned=1"> 这段字。';
  modelHandler = async (route) => await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: [] });
  await say('这个仓库用的是什么许可？');
  await answerText('fair-code');
  const panelShows = await qaPanel.evaluate(() => {
    const prose = [...document.querySelectorAll('.entry.answer .prose')].at(-1);
    const all = (sel) => [...(prose?.querySelectorAll(sel) ?? [])].map((e) => e.textContent);
    return prose && { strong: all('strong'), items: all('li'), code: all('code'), img: all('img').length, text: prose.textContent };
  });
  check(
    'Q-1b：侧栏按意思显示回答里的加粗、列表、行内代码，星号和反引号不再露出来',
    JSON.stringify(panelShows?.strong) === JSON.stringify(['fair-code', 'Sustainable Use License']) &&
      panelShows.items.length === 2 &&
      JSON.stringify(panelShows.code) === JSON.stringify(['LICENSE_EE.md']) &&
      !/[*`]/.test(panelShows.text),
    JSON.stringify(panelShows),
  );
  check(
    'Q-1b：回答里引到的 HTML 在侧栏只是文字，不产生任何元素',
    panelShows?.img === 0 && panelShows.text.includes('<img src=x'),
    JSON.stringify(panelShows?.text),
  );
  await waitUntil(async () => (await guideState())?.data?.message?.kind === 'answer', 5000);
  const rendered = (await guideState())?.data?.message?.rendered ?? '';
  check(
    'Q-1b：浮层卡片上同样按意思显示，引到的 HTML 只是文字',
    rendered.includes('<strong>fair-code</strong>') &&
      (rendered.match(/<li>/g) ?? []).length === 2 &&
      rendered.includes('<code>LICENSE_EE.md</code>') &&
      rendered.includes('&lt;img src=x') &&
      !rendered.includes('<img'),
    rendered,
  );
  check('Q-1b：页面上什么都没有被执行', (await page.evaluate(() => window.__pwned ?? null)) === null);
  await closeAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-2 — 依据框在模型引用的那个元素上（逐值比对）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER = '点这个按钮即可创建新实例。';
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'button', 'Create instance');
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: ref ? [ref] : [] });
  };
  await say('创建实例的按钮在哪里？');
  const text = await answerText(ANSWER);
  check('Q-2a：回答先正常出现（前置条件）', typeof text === 'string' && text.includes(ANSWER), text ?? '(超时)');
  const createRect = await rectOf2('create');
  const shown = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRect), 5000);
  check(
    'Q-2b：浮层的矩形与 Create instance 的 getBoundingClientRect 逐值一致',
    shown,
    `overlay=${JSON.stringify((await guideState())?.data?.rect)} target=${JSON.stringify(createRect)}`,
  );
  await closeAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-3 — 要用户选一个：候选全部框出，系统不替用户选（K-6）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  modelHandler = async (route, body) => {
    const refs = liveRefs(body, 'button', 'Stop');
    await fulfillEnvelope(route, {
      intent: 'ask',
      question: '你说的是哪一个实例的 Stop 按钮？',
      wants: 'choice',
      options: refs.map((r, i) => ({ ref: r, label: `第 ${i + 1} 个 Stop 按钮` })),
    });
  };
  await say('帮我停止这个实例');
  const optLabels = await pollTexts(() => qaPanel.locator('.entry.ask').last().locator('.options li'));
  const asked = await lastEntry('ask');
  const askedRefs = asked?.options?.map((o) => o.ref) ?? [];
  check('Q-3a：两个真实的 Stop 按钮都作为候选交给了侧栏（不是只给一个）', askedRefs.length === 2 && new Set(askedRefs).size === 2, JSON.stringify(askedRefs));
  check('Q-3b：侧栏列出的候选数与模型给的一致', optLabels.length === 2, JSON.stringify(optLabels));
  const ambiguous = await waitUntil(async () => (await guideState())?.data?.status === 'ambiguous', 5000);
  check('Q-3c：浮层进入 ambiguous 态（两个候选一起框出，一个都没挑）', ambiguous, JSON.stringify(await guideState()));
}

// ─────────────────────────────────────────────────────────────────────────
// Q-5 — 坏形状只修一次；修复轮是原请求整个重发，加一对说明
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const before = requestLog.length;
  const costBefore = await costShown();
  const seen = [];
  modelHandler = async (route, body) => {
    seen.push(body);
    if (seen.length === 1) {
      // 能解析，但少了 answer：模型没照给它的形状回答。
      return await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseToolBody('explain', JSON.stringify({ refs: [] }), 'call-q5'),
      });
    }
    await fulfillEnvelope(route, { intent: 'explain', answer: '这是修复调用给出的答案', refs: [] });
  };
  await say('随便问一个问题，让第一次回答缺个字段');
  const text = await answerText('修复调用给出的答案');
  check('Q-5a：修过一次之后，侧栏里是修复轮的回答', typeof text === 'string' && text.includes('这是修复调用给出的答案'), text ?? '(超时)');
  check('Q-5b：总请求数恰好为 2', requestLog.length - before === 2, `${requestLog.length - before}`);
  const [first, second] = seen;
  const head = second?.messages?.slice(0, first?.messages?.length ?? 0);
  const pair = second?.messages?.slice(first?.messages?.length ?? 0) ?? [];
  check(
    'Q-5c：修复轮 = 原请求逐字重发（页面也在里面），末尾加上被拒的那次调用和按 id 配对的说明',
    JSON.stringify(head) === JSON.stringify(first?.messages) &&
      pair.length === 2 &&
      pair[0]?.role === 'assistant' &&
      pair[0]?.tool_calls?.[0]?.id === 'call-q5' &&
      pair[1]?.role === 'tool' &&
      pair[1]?.tool_call_id === 'call-q5' &&
      JSON.stringify(first?.messages).includes('Create instance'),
    JSON.stringify(pair.map((m) => ({ role: m.role, id: m.tool_call_id ?? m.tool_calls?.[0]?.id, content: String(m.content ?? '').slice(0, 40) }))),
  );
  const costed = await waitUntil(async () => {
    const now = await costShown();
    return now.calls === costBefore.calls + 2 && now.repairs === costBefore.repairs + 1;
  }, 3000);
  check('Q-5d：执行这次调用的侧栏把修复轮也记进花费：调用 +2，其中修复 +1', costed, JSON.stringify({ before: costBefore, after: await costShown() }));
  await closeAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-6 — 问的时候页面换了：那次回答作废，在新页上重问
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const gate = deferred();
  const bodies = [];
  const OLD = '不该被采纳的旧答案-Q6';
  const NEW = '这是文档页上的回答-Q6';
  modelHandler = async (route, body) => {
    bodies.push(body);
    if (bodies.length === 1) {
      await gate.promise;
      await fulfillEnvelope(route, { intent: 'explain', answer: OLD, refs: [] }).catch(() => {});
      return;
    }
    await fulfillEnvelope(route, { intent: 'explain', answer: NEW, refs: [] });
  };
  await say('这个页面是做什么的（回答要等换页之后才放行）？');
  await waitUntil(() => bodies.length === 1, 5000);
  await page.goto(`http://127.0.0.1:${PORT}/docs`, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  gate.resolve();
  const text = await answerText(NEW);
  check(
    'Q-6a：换页之后，悬着的旧回答不会出现在侧栏；出现的是新页上的回答',
    typeof text === 'string' && text.includes(NEW) && !text.includes(OLD),
    text ?? '(未展示任何答案)',
  );
  check(
    'Q-6b：重问的那次带的是新的一页',
    bodies.length === 2 && JSON.stringify(bodies[1]).includes('API Reference') && !JSON.stringify(bodies[0]).includes('API Reference'),
    `requests=${bodies.length}`,
  );
  await closeAnswerIfOpen();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
}

// ─────────────────────────────────────────────────────────────────────────
// Q-7 — 新说的一句取代在途的那句：在途请求真的被叫停（net::ERR_ABORTED）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const failedRequests = [];
  const onReqFailed = (req) => {
    if (req.url().startsWith(QA_BASE)) failedRequests.push({ url: req.url(), failure: req.failure() });
  };
  // 在上下文上听，不在某一个侧栏上：接下这次调用的是哪一个侧栏，由宿主仲裁。
  ctx.on('requestfailed', onReqFailed);

  const gateA = deferred();
  const bodies = [];
  const ANSWER_B = '问题B的真实答案-Q7';
  modelHandler = async (route, body) => {
    bodies.push(body);
    // B 先判：重问的那次同时带着 A（目标）和 B（用户又说的）。
    if (userText(body).includes('问题B')) return await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER_B, refs: [] });
    await gateA.promise; // A 永远不放行
    await fulfillEnvelope(route, { intent: 'explain', answer: '问题A不该被展示的答案-Q7', refs: [] }).catch(() => {});
  };

  await say('问题A：这是会被取代的问题');
  await waitUntil(() => bodies.length === 1, 5000);
  await say('问题B：这是取代前者的新问题');
  const text = await answerText(ANSWER_B);
  check(
    'Q-7a：最终展示的是问题 B 的回答，不是问题 A 的',
    typeof text === 'string' && text.includes(ANSWER_B) && !text.includes('问题A不该被展示的答案-Q7'),
    text ?? '(超时)',
  );
  const aborted = await waitUntil(() => failedRequests.some((r) => r.failure?.errorText === 'net::ERR_ABORTED'), 3000);
  check('Q-7b：问题 A 的请求真的被叫停（net::ERR_ABORTED），不是等它回来再丢', aborted, JSON.stringify(failedRequests));
  check(
    'Q-7c：B 交给了同一趟：重问的那次带着原来的目标，和「用户又说」的那一句',
    bodies.length === 2 && userText(bodies[1]).includes('问题A') && userText(bodies[1]).includes('用户又说：「问题B'),
    JSON.stringify(bodies.map((b) => userText(b).slice(-80))),
  );

  ctx.off('requestfailed', onReqFailed);
  gateA.resolve();
  await closeAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-8 — 引导途中问一句：同一个输入框，引导听到、回答，然后照走
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER_8 = '这里可以设置项目名称-Q8。';
  modelHandler = async (route, body) => {
    if (userText(body).includes('Project name 输入框是做什么用的')) {
      const ref = liveRef(body, 'textbox', 'Project name');
      return await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER_8, refs: ref ? [ref] : [] });
    }
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: 'Instances 页', goal: '新建一个实例' }],
      ref: liveRef(body, 'button', 'Create instance'),
      action: 'click',
      why: '从创建按钮开始',
    });
  };
  await say('帮我新建一个实例');
  const createRect = await rectOf2('create');
  const onCreate = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRect), 5000);
  check('Q-8a：引导起来了，第 1 步框在 Create instance 上', onCreate, JSON.stringify((await guideState())?.data?.rect));
  const before = await threadOf();

  const requestsBefore = requestLog.length;
  await say('Project name 输入框是做什么用的？');
  const text = await answerText(ANSWER_8);
  check('Q-8b：回答正常展示', typeof text === 'string' && text.includes(ANSWER_8), text ?? '(超时)');
  check(
    'Q-8c：这一句交给了正在走的引导：只多一次调用，带着「用户又说」',
    requestLog.length === requestsBefore + 1 && userText(requestLog.at(-1).body).includes('用户又说：「Project name'),
    `requests=${requestLog.length - requestsBefore}`,
  );
  const projRect = await rectOf2('proj');
  const onProj = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(projRect), 5000);
  check('Q-8d：依据框到了 Project name 上', onProj, JSON.stringify((await guideState())?.data?.rect));
  const during = await threadOf();
  check(
    'Q-8e：引导还在，走过的一步一个字没动',
    during !== null && during.ending === undefined && JSON.stringify(during.history) === JSON.stringify(before?.history),
    JSON.stringify({ before: before?.history, during: during?.history, ending: during?.ending }),
  );

  // The card on the page is where an answer is closed now; the panel keeps it.
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'SAY', message: null }, { frameId: 0 }), tabId);
  await qaPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'PANEL_RESUME_GUIDE', tabId: id }), tabId);
  const backOnGuide = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRect), 5000);
  check('Q-8f：关掉回答 → 浮层回到引导的第 1 步', backOnGuide, JSON.stringify((await guideState())?.data?.rect));
  const after = await threadOf();
  check('Q-8g：引导仍在走', after !== null && after.ending === undefined, JSON.stringify({ ending: after?.ending }));

  await endGuideHere();
}

// ─────────────────────────────────────────────────────────────────────────
// 要填字的一步：网页上的卡片只给看；侧栏钉住的这一步带着那段字，能复制
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: 'Instances 页', goal: '填项目名' }],
      ref: liveRef(body, 'textbox', 'Project name'),
      action: 'input',
      value: 'ci-deploy',
      why: '项目名填在这里',
    });
  await say('帮我把项目名填成 ci-deploy');
  const shown = await waitUntil(async () => (await viewOf(qaPanel, tabId))?.step?.value === 'ci-deploy', 5000);
  const onPanel = shown ? await pollText(() => qaPanel.locator('.pinned .value-to-type code'), 3000) : null;
  check('输入的一步：侧栏钉住的这一步写着要填的字', onPanel === 'ci-deploy', onPanel ?? JSON.stringify((await viewOf(qaPanel, tabId))?.step));
  // 「复制」 itself is not driven here. The clipboard wants a focused document,
  // and this panel is a tab: bringing it to the front makes it the active tab,
  // and a panel follows the active tab — off to a conversation with no step.
  // The real side panel is not a tab and has the focus the moment it is clicked.
  check('输入的一步：侧栏上有「复制」按钮', (await qaPanel.locator('.pinned .value-to-type button[aria-label="复制"]').count()) === 1);
  await endGuideHere();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-9 — 回答引用了密码框：整个回答被拒，浮层一次都没画
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const before = requestLog.length;
  let painted = false;
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'textbox', 'Password');
    await fulfillEnvelope(route, { intent: 'explain', answer: '登录密码是 admin123', refs: ref ? [ref] : [] });
  };
  const watching = (async () => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      if ((await guideState())?.data?.visible) painted = true;
      await new Promise((r) => setTimeout(r, 60));
    }
  })();
  await say('登录密码是什么？');
  await waitForEntry('note', '敏感');
  const told = (await lastEntry('note'))?.text ?? '';
  await watching;
  check(
    'Q-9a：侧栏说回答不合规矩、指向了敏感元素；回答本身没有显示',
    typeof told === 'string' && told.includes('敏感') && !(await qaPanel.locator('.answer-card').isVisible().catch(() => false)),
    told ?? '(超时未报错)',
  );
  check('Q-9b：修过一次仍然引用密码框 → 不再问；浮层全程没有画出来', requestLog.length - before === 2 && !painted, `requests=${requestLog.length - before} painted=${painted}`);
  const problem = (await guideState())?.data?.message;
  check(
    '10c：出了问题、这一趟没有结束 → 浮层的卡片上同样说出来',
    problem?.kind === 'note' && problem.title === '提示' && problem.text.includes('敏感'),
    JSON.stringify(problem),
  );
  await endGuideHere();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-10 — 依据在页面重渲染之后不重绑（explain 模式）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  await refresh();
  const create = table.items.find((i) => i.role === 'button' && i.name === 'Create instance');
  const explainCmd = {
    sessionId: 'e2e',
    snapshotId: table.snapshotId,
    view: table.url,
    mode: 'explain',
    step: { ref: create?.ref, descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'observe', title: '依据' },
    progress: { index: 0, total: 1 },
    autoScroll: false,
  };
  const first = await highlight(explainCmd);
  const createRectBefore = await rectOf2('create');
  check(
    'Q-10 前置：依据先正常框在 Create instance 上（成功框过，才谈得上「重渲染之后」）',
    JSON.stringify(first?.data?.rect) === JSON.stringify(createRectBefore),
    JSON.stringify(first?.data),
  );

  // URL 不变，只是 DOM 被重渲染：原地移除 #create，换一个角色/名字相同但位置
  // 完全不同的新节点——如果发生重绑，框会指向这个新位置。
  await page.evaluate(() => {
    const b = document.getElementById('create');
    const fresh = document.createElement('button');
    fresh.id = 'create-moved-q10';
    fresh.textContent = b.textContent;
    fresh.style.position = 'fixed';
    fresh.style.top = '4px';
    fresh.style.left = '4px';
    document.body.appendChild(fresh);
    b.remove();
  });
  await page.waitForTimeout(200);

  // 同一份快照、同一个 ref 再画一次——快照没过期（没有新的抽取），但底下的元素已经不在了。
  const staleAsk = await highlight(explainCmd);
  check(
    'Q-10a：DOM 重渲染后 explain 模式如实报告 snapshot_stale，不重绑',
    staleAsk?.ok === true && staleAsk?.data?.failure === 'snapshot_stale' && staleAsk?.data?.resolved === null,
    JSON.stringify(staleAsk?.data),
  );
  const movedRect = await rectOf2('create-moved-q10');
  check(
    'Q-10b：拿到的绝不是被搬到别处的新节点的坐标——若重绑发生，rect 会恰好等于这个值',
    JSON.stringify(staleAsk?.data?.rect) !== JSON.stringify(movedRect),
    `stale.rect=${JSON.stringify(staleAsk?.data?.rect)} movedRect=${JSON.stringify(movedRect)}`,
  );
  check('Q-10c：失败响应的 rect 为 null（不是「找到了但坐标为空」的另一种含糊状态）', staleAsk?.data?.rect === null, JSON.stringify(staleAsk?.data?.rect));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
}

// ─────────────────────────────────────────────────────────────────────────
// 10d — 检视时选中一个元素，直接「指给我」
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  await openSettings(qaPanel, '检视页面');
  await qaPanel.getByRole('button', { name: '检视元素', exact: true }).click();
  await page.bringToFront();
  const create = await page.evaluate(() => {
    const r = document.getElementById('create').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.move(create.x, create.y);
  await page.mouse.click(create.x, create.y);
  const pointBtn = qaPanel.getByRole('button', { name: '指给我', exact: true });
  const offered = await waitUntil(async () => await pointBtn.isVisible().catch(() => false), 5000);
  check('10d：检视时选中一个元素 → 侧栏给出「指给我」', offered);
  // Pointing takes the panel back to the conversation; not getting that far
  // has to, too, or every check after this one types into a page that is gone.
  if (offered) await pointBtn.click();
  else await backToChat(qaPanel).catch(() => {});
  const createRect = await rectOf2('create');
  const pointed = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRect), 5000);
  check('10d：点「指给我」→ 浮层框在选中的那个元素上', pointed, JSON.stringify({ overlay: (await guideState())?.data?.rect, target: createRect }));
  await endGuideHere();
}

// ─────────────────────────────────────────────────────────────────────────
// 10c — 浮层自己把话说清楚：问题、回答、跨站确认、收场原因都在浮层的卡片上
//
// 侧栏照旧也说；这里只看浮层——用户看着的是页面，侧栏可能关着。
// ─────────────────────────────────────────────────────────────────────────
{
  const said = async () => (await guideState())?.data?.message ?? null;
  /** Presses a button on the overlay's message card, by where the card says it is. */
  const pressOnCard = async (label) => {
    const b = (await said())?.buttons?.find((x) => x.label === label);
    if (!b) return false;
    await page.mouse.click(b.rect[0] + b.rect[2] / 2, b.rect[1] + b.rect[3] / 2);
    return true;
  };
  const pointAtCreate = (body, why) => ({
    intent: 'point', route: [{ at: '列表页', goal: why }], ref: liveRef(body, 'button', 'Create instance'), action: 'click', why,
  });

  // 回答：写在卡片上；依据只框出来。
  await clearOverlay();
  const ANSWER = '这个按钮用来新建实例。（10c）';
  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: [liveRef(body, 'button', 'Create instance')] });
  await say('Create instance 是干什么的？');
  await waitUntil(async () => (await said())?.kind === 'answer', 5000);
  check('10c：回答写在浮层的卡片上', (await said())?.text === ANSWER, JSON.stringify(await said()));
  check('10c：依据照样框出来', (await overlayStatus('shown', 3000)) === 'shown', JSON.stringify((await guideState())?.data?.rect));
  await pressOnCard('关闭');
  const closed = await waitUntil(async () => (await said()) === null && (await guideState())?.data?.visible === false, 3000);
  check('10c：在卡片上关掉回答 → 卡片撤下，没有引导在走，框线也撤下', closed, JSON.stringify((await guideState())?.data));
  await closeAnswerIfOpen();

  // 问回来一句、要的是一段文字：没有东西可框，卡片照样说出问题。
  await clearOverlay();
  modelHandler = async (route) =>
    await fulfillEnvelope(route, { intent: 'ask', question: '你要改的是哪一台实例的名字？（10c）', wants: 'text', options: [] });
  await say('帮我改个名字');
  await waitUntil(async () => (await said())?.kind === 'ask', 5000);
  const asked = await said();
  check(
    '10c：问回来的一句写在卡片上，并说在哪里回答；没有东西可框也照样说',
    typeof asked?.text === 'string' && asked.text.includes('你要改的是哪一台实例的名字？') && asked.text.includes('侧栏的输入框'),
    JSON.stringify(asked),
  );
  await clearOverlay();

  // 跨站：卡片上问，「继续」之后那一步才画出来。
  await page.evaluate(() => {
    document.getElementById('offsite-10c')?.remove();
    const a = document.createElement('a');
    a.id = 'offsite-10c';
    a.href = 'https://docs.elsewhere-example.test/help';
    a.textContent = 'Read the docs elsewhere (10c)';
    document.querySelector('main')?.prepend(a);
  });
  let turns = 0;
  modelHandler = async (route, body) => {
    turns++;
    if (turns === 1) {
      return await fulfillEnvelope(route, {
        intent: 'point', route: [{ at: '列表页', goal: '去文档站' }], ref: liveRef(body, 'link', 'Read the docs elsewhere (10c)'), action: 'click', why: '文档在别的站',
      });
    }
    await fulfillEnvelope(route, pointAtCreate(body, '回来接着走'));
  };
  await say('去看看文档（10c）');
  await waitUntil(async () => (await said())?.kind === 'cross_site', 5000);
  const crossing = await said();
  check(
    '10c：这一步要离开当前站点 → 卡片上说从哪到哪，给「继续」「先不去」',
    crossing?.kind === 'cross_site' && crossing.text.includes('docs.elsewhere-example.test') && crossing.buttons.map((b) => b.label).join('|') === '继续，带我去|先不去',
    JSON.stringify(crossing),
  );
  check('10c：还没回答之前，那一步不画出来', (await overlayStatus('shown', 400)) !== 'shown');
  await pressOnCard('继续，带我去');
  const offRect = await rectOf2('offsite-10c');
  const went = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(offRect), 5000);
  check('10c：在卡片上点「继续」→ 和侧栏的按钮一样，那一步画出来，卡片撤下', went && (await said()) === null, JSON.stringify((await guideState())?.data));
  await endGuideHere();
  await page.evaluate(() => document.getElementById('offsite-10c')?.remove());

  // 收场：浮层上的高亮撤下，原因留在卡片上，关了才撤。
  await clearOverlay();
  turns = 0;
  modelHandler = async (route, body) => {
    turns++;
    if (turns === 1) return await fulfillEnvelope(route, pointAtCreate(body, '先点创建'));
    await fulfillEnvelope(route, { intent: 'done', evidence: 'content_on_page', why: '实例已经建好了（10c）' });
  };
  await say('新建一个实例（10c）');
  await overlayStatus('shown', 5000);
  await page.click('#create');
  await waitUntil(async () => (await said())?.kind === 'note', 6000);
  const ended = await said();
  check(
    '10c：这一趟结束 → 高亮撤下，结束的原因留在浮层的卡片上',
    ended?.title === '引导结束了' && ended.text.includes('实例已经建好了（10c）') && (await guideState())?.data?.status === 'idle',
    JSON.stringify({ ended, status: (await guideState())?.data?.status }),
  );
  await pressOnCard('关闭');
  check('10c：卡片点「关闭」才撤下', (await said()) === null, JSON.stringify(await said()));
  await clearOverlay();
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型驱动的多步引导第一次真正跑起来。
//
// 带目标起引导时，`startGuide` 发起一次真实的（这里打桩的）模型调用，产出
// `route` + `steps`，框出第一步的目标，并把路标与三轴写进对话的那一条里，带上
// `route`/`evidence`/`check`/`binding`（05 的 Seam）。随后验证 §5.3 的逐页
// 重规划：非 landmark/heading 的 DOM 变化不触发重规划（slice 6），
// landmark/heading 结构确实变化时触发（slice 7），且重规划后展示的 route
// 整体替换第一次的，不拼接（slice 2 的 e2e 佐证）。复用上一段建好的
// 打桩基础设施（`QA_BASE`/`modelHandler`/`requestLog`/`fulfillEnvelope`/
// `liveRef`）——`provider` 配置此刻仍然指向 `QA_BASE`，Q-11 还没有把它清掉。
// ═══════════════════════════════════════════════════════════════════════════
{
  const guidePanel = await ctx.newPage();
  await guidePanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await guidePanel.evaluate(() => {
    chrome.runtime.onMessage.addListener((m) => {
    });
  });
  await page.bringToFront();
  // Not the file-level `host()` — that closure is bound to `panel`, which was
  // already closed at line ~1141. This block's own `guidePanel` is the live
  // page to send `chrome.runtime.sendMessage` from.
  const host = async (msg) => await guidePanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);

  let guideCallCount = 0;
  modelHandler = async (route, body) => {
    guideCallCount++;
    const ref = liveRef(body, 'button', 'Create instance');
    const envelope =
      guideCallCount === 1
        ? {
            intent: 'point',
            route: [{ at: 'Instances 页', goal: '找到目标实例并设为私有' }],
            ref,
            action: 'click',
            why: '第一步先选中目标实例',
          }
        : {
            intent: 'point',
            route: [{ at: '实例详情页', goal: '把这台实例设为私有' }],
            // A *different* control, because that is what a real second step
            // points at. Reusing the first step's ref made 07's repeat
            // backstop refuse the envelope — correctly: re-proposing the very
            // control the user was just confirmed to have finished is the loop
            // that backstop exists to break. This assertion is about `route`
            // being replaced wholesale, so the fixture was the half to fix.
            ref: otherRef(body, ref),
            action: 'click',
            why: '重规划之后的第二次结果',
          };
    await fulfillEnvelope(route, envelope);
  };

  const requestsBefore = requestLog.length;
  const goal = '把这个仓库设为私有';
  const guideStarted = await host({ type: 'SAID', tabId, text: goal });
  await waitUntil(() => requestLog.length >= requestsBefore + 1, 4000);
  check(
    '带目标起引导 → 宿主发起一次真实模型调用（多步引导第一次跑起来）',
    guideStarted?.ok === true && requestLog.length === requestsBefore + 1,
    `ok=${guideStarted?.ok} requests=${requestLog.length - requestsBefore}`,
  );

  await page.waitForTimeout(500);
  check('模型给出的 guide 信封，第一步被成功框出', (await overlayStatus('shown')) === 'shown');

  const stateAfterFirst = await lastEntry('step', guidePanel);
  check(
    '这一步的条目上带着 route 与三轴：route 与这次模型输出逐字段一致，evidence=model / check=unknown / binding=bound',
    JSON.stringify(stateAfterFirst?.route) === JSON.stringify([{ at: 'Instances 页', goal: '找到目标实例并设为私有' }]) &&
      stateAfterFirst?.axes?.evidence === 'model' &&
      stateAfterFirst?.axes?.check === 'unknown' &&
      stateAfterFirst?.axes?.binding === 'bound',
    JSON.stringify(stateAfterFirst),
  );

  // ---- slice 6：仅普通交互元素变化（landmark/heading 不变）→ 不触发重规划 ----
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'A brand new button';
    document.querySelector('main').appendChild(b);
  });
  await page.waitForTimeout(900); // 内容脚本的防抖窗口（400ms）+ 余量
  check(
    '仅新增一个普通按钮（不是 landmark/heading）→ 不上报页面结构变化，模型调用次数不变（slice 6）',
    requestLog.length === requestsBefore + 1,
    `requests=${requestLog.length - requestsBefore}`,
  );

  // ---- slice 7：landmark/heading 结构确实变化 → 触发重规划 ----
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Instance detail';
  });
  await waitUntil(() => requestLog.length >= requestsBefore + 2, 5000);
  check(
    '页面标题从 "Instances" 变为 "Instance detail"（heading 变化，模拟同 URL 下的 SPA 跳转）→ 触发第二次真实模型调用（slice 7）',
    requestLog.length === requestsBefore + 2,
    `requests=${requestLog.length - requestsBefore}`,
  );

  // The stub having *received* the second request (checked above) is not the
  // same moment as the panel having finished streaming it, sent `EFFECT_
  // RESULT`, and the host having rendered and broadcast the new state — poll
  // for the actual route content rather than guess a fixed sleep long enough
  // to cover that whole round trip.
  let stateAfterReplan = null;
  await waitUntil(async () => {
    stateAfterReplan = await lastEntry('step', guidePanel);
    return stateAfterReplan?.route?.[0]?.at === '实例详情页';
  }, 5000);
  check(
    '重规划后展示的 route 整体替换为最新一次的，不与第一次拼接或去重（slice 1/2 的 e2e 佐证）',
    JSON.stringify(stateAfterReplan?.route) === JSON.stringify([{ at: '实例详情页', goal: '把这台实例设为私有' }]),
    JSON.stringify(stateAfterReplan?.route),
  );

  // ---- 调试 trace：默认关，开了才写，写的是真发出去的东西 ----
  //
  // 这一段验的是「开关能在生产构建上运行时打开」这件事本身——`agent/agents/
  // guide/trace.ts` 的开关刻意做成存储里的值而不是编译期标志，正因为出问题的构建
  // 恰恰是编译期标志够不着的那些。所以这里不打桩、不注入，就按一个真实使用者
  // （或一次 Playwright 取证）会走的路子：往 storage.local 写一个键。
  //
  // 前面两次模型调用是在开关关着的时候跑的，所以这一条同时也是「默认关」的
  // 反证：写这一句之前，storage.session 里不该有任何东西。
  const traceK = `trace:tab-${tabId}`;
  const traceBeforeSwitch = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
  check(
    '调试 trace 默认关：前两次模型调用跑完，storage.session 里没有 trace（页面内容不会无声落盘）',
    traceBeforeSwitch === null,
    JSON.stringify(traceBeforeSwitch)?.slice(0, 120),
  );

  await sw.evaluate(async () => await chrome.storage.local.set({ 'trace:enabled': true }));
  const beforeTrace = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Trace heading';
  });
  await waitUntil(() => requestLog.length > beforeTrace, 6000);
  let traceAfter = null;
  await waitUntil(async () => {
    traceAfter = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
    return Boolean(traceAfter);
  }, 5000);

  const traceKinds = (traceAfter?.entries ?? []).map((e) => e.kind);
  check(
    '把 trace:enabled 写进 storage.local → 下一次模型调用被记进 storage.session 的 trace:{sessionId}',
    Array.isArray(traceAfter?.entries) && traceAfter.entries.length > 0,
    JSON.stringify(traceKinds),
  );
  check(
    'trace 记下的 system 就是真发出去的系统提示词（不是另建的一份），且只存一份不随每条记录重复',
    typeof traceAfter?.system === 'string' &&
      traceAfter.system.includes('默认是 point') &&
      !JSON.stringify(traceAfter.entries).includes(traceAfter.system),
    `system=${String(traceAfter?.system).slice(0, 40)}… entries=${traceKinds.length}`,
  );
  // 最强的那条：不猜夹具长什么样，直接把 trace 记下的两条消息，与打桩服务
  // 这一次真正收到的请求体逐字对比。记录若与实际发出的哪怕差一个字符，
  // 这个通道就没有存在的意义。
  const sentBody = requestLog.at(-1)?.body;
  const sentMessages = sentBody?.messages ?? [];
  const tracedRequest = (traceAfter?.entries ?? []).find((e) => e.kind === 'request');
  check(
    'trace 记的就是这一次真正发出去的两条消息，与打桩服务收到的请求体逐字一致（不是模板，也不是重建）',
    sentMessages.length === 2 &&
      traceAfter?.system === sentMessages[0]?.content &&
      tracedRequest?.user === sentMessages[1]?.content,
    `system一致=${traceAfter?.system === sentMessages[0]?.content} user一致=${tracedRequest?.user === sentMessages[1]?.content}`,
  );

  // 关掉，别把后面的段落也录进去——也顺便证明它关得掉。
  await sw.evaluate(async () => await chrome.storage.local.remove('trace:enabled'));
  const entriesAtSwitchOff = (traceAfter?.entries ?? []).length;
  const beforeOff = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'After trace off';
  });
  await waitUntil(() => requestLog.length > beforeOff, 6000);
  // 等这次调用落地：请求发出去只是开头，trace 是在结果回来时才可能被追加的。
  await waitUntil(async () => (await threadOf())?.inflight == null, 6000);
  const traceAfterOff = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
  check(
    '把开关移除 → 之后的模型调用不再追加，已存下的那份原样留着（关得掉，且不倒着删）',
    (traceAfterOff?.entries ?? []).length === entriesAtSwitchOff,
    `before=${entriesAtSwitchOff} after=${(traceAfterOff?.entries ?? []).length}`,
  );

  // ---- 页面结构自己变了 → 一条读数，唤醒模型时念给它听（05b） ----
  //
  // 宿主不再判页面是不是「还在路上」：它读一次此刻的页面，把看到的事实交给
  // 模型，页面有没有落定由模型用 wait_for / observe 自己判断（CONTEXT.md
  // `Reading`）。这里断言的是那条事实真的到了模型面前。
  //
  // 先开一条新线程：终态就是终态，要看读数唤醒模型，就得有一条活着的线程。
  //
  // The opening call gets a real plan, so the guide is alive when the heading
  // changes; only the re-plan answers `done`. Installing a `done`-only handler
  // after a fixed wait made the result depend on whether the opening call
  // landed before or after it: a guide that answered `done` at once is over,
  // its thread is dropped, and the heading change then has nothing to re-plan
  // — `[]`, in 1 of 3 runs.
  let transitCalls = 0;
  modelHandler = async (route, body) => {
    transitCalls++;
    if (transitCalls === 1) {
      const ref = liveRef(body, 'button', 'Create instance');
      return await fulfillEnvelope(route, {
        intent: 'point',
        route: [{ at: '夹具页', goal: '先让一条计划活着' }],
        ref,
        action: 'click',
        why: '一个活着的计划，等着被重规划',
      });
    }
    await fulfillEnvelope(route, { intent: 'done', why: '够了' });
  };
  const beforeStart = requestLog.length;
  await host({ type: 'SAID', tabId, text: '重规划在路上判据 · 新线程' });
  await waitUntil(() => requestLog.length > beforeStart, 6000);
  await page.waitForTimeout(400);
  const beforeTransit = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Transit heading';
  });
  await waitUntil(() => requestLog.length > beforeTransit, 6000);
  await page.waitForTimeout(400);

  const woken = requestLog.slice(beforeTransit).map((r) => String(r.body?.messages?.[1]?.content ?? ''));
  check(
    '页面结构自己变了 → 唤醒模型，那条读数念给了它',
    woken.some((t) => t.includes('页面自己变了') && t.includes('此刻这一页和你上次回答时相比')),
    JSON.stringify(woken.map((t) => t.slice(t.indexOf('你上次回答之后'), t.indexOf('你上次回答之后') + 80)))?.slice(0, 200),
  );

  // ---- done 是终态：说了到了，就不该再指着一个按钮 ----
  //
  // 这里曾经断言相反的事，理由是「`done` 是提案而非判决，`status` 保持 active，
  // 由用户确认」——而渲染端撤掉浮层，等于把用户唯一能用来否掉它的东西毁了。
  // 那个顾虑是对的，但它把反对权放错了位置：`status` 留在 active 的后果是屏幕
  // 上同时说「看起来已经到了」和「点这里」。真机 21 轮里 11 轮提了不止一次
  // done，一轮提了五次，106 跳里有 21 跳发生在模型已经说到了之后——用户照着
  // 还亮着的高亮点下去，就再触发一次重规划，模型就再说一次到了。
  //
  // 现在线程结束、浮层撤掉，反对的方式是重新说一次目标（`start` 是终态线程
  // 唯一还接受的输入）。
  //
  // 这一趟先指一步，再说到了：一步都没指过就说到了的一趟是一次问答（08a），
  // 它不留记录，下面要断言的「删线程之前落盘」就无从谈起。
  let doneCalls = 0;
  modelHandler = async (route, body) => {
    doneCalls += 1;
    if (doneCalls === 1)
      return await fulfillEnvelope(route, {
        intent: 'point', route: [{ at: '夹具页', goal: '先指一步' }], ref: liveRef(body, 'button', 'Create instance'), action: 'click', why: '先指一步',
      });
    await fulfillEnvelope(route, { intent: 'done', why: '你要的东西已经在这一页上了' });
  };
  const beforeDoneGuide = requestLog.length;
  await host({ type: 'SAID', tabId, text: 'done 终态渲染 · 新线程' });
  await waitUntil(() => requestLog.length > beforeDoneGuide, 6000);
  await page.waitForTimeout(600);
  const beforeDone = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Yet another heading';
  });
  await waitUntil(() => requestLog.length > beforeDone, 6000);
  await page.waitForTimeout(1200);

  const overlayAfterDone = await sw.evaluate(
    async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
    tabId,
  );
  const doneAnswer = (await entriesOf('note', guidePanel)).filter((e) => String(e.text).startsWith('看起来已经到了')).length;
  check('收尾说明确实送到了面板（下面那条断言的前提）', doneAnswer > 0, `answers=${doneAnswer}`);
  // `CLEAR` 调的是 `hide()`：Overlay 对象还在，只是 `visible:false,
  // status:'idle'`。用户需要的是屏幕上不再有一张卡片指着某个按钮，所以看的
  // 是 `visible` 为假，而不是 `data` 为 null。
  check(
    '收尾之后浮层撤掉了——不再一边说"已经到了"一边指着一个按钮',
    overlayAfterDone?.data?.visible === false,
    JSON.stringify(overlayAfterDone?.data),
  );

  // `done` 是终态，而终态意味着这条线程不该还留在存储里。留着的后果不是脏数据
  // 而是错误的所有权：`guideThreadExists` 会永远答「有」，这个标签页之后每一趟
  // 引导的点击都被路由给一条已经结束的运行。摘要必须在删除之前写下——那是这趟
  // 运行最后一次还存在、可被记录的时刻。
  const afterDoneThread = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check('模型说完成之后线程真的被删掉了——不再劫持这个标签页之后的引导', afterDoneThread === null, JSON.stringify(afterDoneThread)?.slice(0, 120));

  const afterDoneRecords = await sw.evaluate(
    async () => (await chrome.storage.local.get('run:records'))['run:records'] ?? [],
  );
  check(
    '而且摘要在删除之前落了盘——不必再点一次「结束引导」才留下记录',
    afterDoneRecords.some((r) => r.goal === 'done 终态渲染 · 新线程'),
    `records=${afterDoneRecords.length} goals=${JSON.stringify(afterDoneRecords.map((r) => r.goal).slice(-3))}`,
  );

  // ---- 一次引导结束时，终态摘要要落进 storage.local（07 · Seam 10） ----
  //
  // `ThreadState` 在 END_GUIDE 时必须被删掉，否则所有权路由会把这个标签页
  // 永远交给一条已经结束的线程。RunRecord 是删除**之前**写下的摘要，也是 S3
  // 蒸馏 Memory 与三种导出格式唯一的数据来源——现在不写对，S3 就得回头补一次
  // 数据迁移。
  // 这一段自带线程。它断言的是摘要里逐字的 goal，而前面那两段各自开了新线程，
  // 所以不能再依赖「当前线程恰好是 2003 行起的那条」。自带线程也让这一段与
  // 前面跑过多少次调用无关。
  //
  // 摘要现在写在「这趟运行结束」的那一刻，而不是「用户点了结束引导」的那一刻
  // ——归约器有五种终态，而在此之前只有显式结束会落盘。所以记录要在**开始之
  // 前**清空：这一段的桩仍然直接返回 `done`，引导一起来就已经结束并落盘了，
  // 在那之后再清就把要断言的那条抹掉了。END_GUIDE 保留在这里，用来证明对一条
  // 已经结束的引导再结束一次是无操作。
  //
  // 这一趟也先指一步：一步都没指过的一趟是一次问答，不写记录（08a）。
  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  let privateCalls = 0;
  modelHandler = async (route, body) => {
    privateCalls += 1;
    if (privateCalls === 1)
      return await fulfillEnvelope(route, {
        intent: 'point', route: [{ at: '夹具页', goal: '先指一步' }], ref: liveRef(body, 'button', 'Create instance'), action: 'click', why: '先指一步',
      });
    await fulfillEnvelope(route, { intent: 'done', why: '够了' });
  };
  const beforePrivate = requestLog.length;
  await host({ type: 'SAID', tabId, text: '把这个仓库设为私有' });
  await waitUntil(() => requestLog.length > beforePrivate, 6000);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'A heading that wakes the model';
  });
  await waitUntil(() => requestLog.length > beforePrivate + 1, 6000);
  // 等「这一趟自己结束了」这件事本身——记录是在那一刻写的。等一个固定的毫秒数，
  // 就是在赌那之前它已经写完了。**这里刻意不点「结束引导」**：这一条要证的正是
  // 不用点它记录也在。
  await waitUntil(async () => (await threadOf()) === null, 6000);
  const recordsBeforeExplicitEnd = await sw.evaluate(
    async () => (await chrome.storage.local.get('run:records'))['run:records'] ?? [],
  );
  check(
    '运行结束的那一刻就落盘了，不必等用户点「结束引导」',
    recordsBeforeExplicitEnd.length === 1 && recordsBeforeExplicitEnd[0]?.goal === '把这个仓库设为私有',
    `records=${recordsBeforeExplicitEnd.length}`,
  );
  await host({ type: 'END_GUIDE', tabId });
  await waitUntil(async () => (await threadOf()) === null, 6000);
  const records = await sw.evaluate(async () => (await chrome.storage.local.get('run:records'))['run:records'] ?? []);
  const rec = records.at?.(-1);
  check(
    '引导结束后写下了这次运行的摘要（goal / route / 每步 action 与 effect / 结束方式 / 确认程度）',
    Boolean(rec) && rec.goal === '把这个仓库设为私有' && Array.isArray(rec.route) && Array.isArray(rec.steps),
    JSON.stringify(rec)?.slice(0, 200),
  );
  check(
    '结束方式与确认程度分开记：这趟是模型说到了，指过的那一步没人点过，就是「一步都没有」',
    Boolean(rec) && rec.ending === 'model_done' && rec.confirmation === 'none' && !('status' in rec),
    `ending=${rec?.ending} confirmation=${rec?.confirmation} 步数=${rec?.steps?.length}`,
  );
  check(
    '对一条已经结束的引导再点一次结束——无操作，不写第二条摘要',
    records.length === 1,
    `records=${records.length}`,
  );
  const threadAfterEnd = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check('线程本身照旧被删掉——摘要独立于线程的存续', threadAfterEnd === null);

  // ---- trace 的生命周期：结束不删，重开则重来 ----
  //
  // 放在这里而不是上面那段 trace 里：这两条都要真的结束 / 开始一条引导，而
  // 上面那段正处在一条引导中途，END_GUIDE 会把它连同运行摘要一起结掉。
  await sw.evaluate(async () => await chrome.storage.local.set({ 'trace:enabled': true }));
  modelHandler = async (route) => {
    await fulfillEnvelope(route, { intent: 'done', why: '够了' });
  };
  const beforeFirstGuide = requestLog.length;
  await host({ type: 'SAID', tabId, text: 'trace 生命周期 · 第一条' });
  await waitUntil(() => requestLog.length > beforeFirstGuide, 6000);
  let firstTrace = null;
  await waitUntil(async () => {
    firstTrace = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
    return (firstTrace?.entries ?? []).length > 0;
  }, 5000);
  const firstCount = (firstTrace?.entries ?? []).length;

  await host({ type: 'END_GUIDE', tabId });
  await waitUntil(async () => (await threadOf()) === null, 6000);
  const traceAfterEndGuide = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
  check(
    '结束引导不删 trace——引导刚出问题时，正是要看它的时候',
    (traceAfterEndGuide?.entries ?? []).length === firstCount && firstCount > 0,
    `before=${firstCount} after=${(traceAfterEndGuide?.entries ?? []).length}`,
  );

  // 线程与 trace 都按标签页作键，所以不清就会追加；而 trace 只保最后 24 条，
  // 于是新引导的头几次调用会被上一条引导的记录挤掉——最该看的那几条最先没。
  const beforeSecondGuide = requestLog.length;
  await host({ type: 'SAID', tabId, text: 'trace 生命周期 · 第二条' });
  await waitUntil(() => requestLog.length > beforeSecondGuide, 6000);
  let secondTrace = null;
  await waitUntil(async () => {
    secondTrace = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
    return (secondTrace?.entries ?? []).length > 0;
  }, 5000);
  check(
    '同一标签页开始新引导 → trace 从头开始，不续写上一条（否则 24 条上限会先挤掉新引导的开头）',
    // 「第一条那句话出现在第二条的 trace 里」不再能说明问题：票 04 之后，上一轮
    // 说过的话会作为上文被**引用**进新一趟的提示词。分得清两者的是位置——用户
    // 消息**以这一趟的目标结尾**（`GOAL_LEAD_IN`），引用只会出现在中间。
    (secondTrace?.entries ?? []).length === firstCount &&
      !(secondTrace?.entries ?? []).some((e) => typeof e.user === 'string' && e.user.endsWith('trace 生命周期 · 第一条')),
    `第一条=${firstCount} 第二条=${(secondTrace?.entries ?? []).length}`,
  );
  await sw.evaluate(async () => await chrome.storage.local.remove('trace:enabled'));

  await host({ type: 'END_GUIDE', tabId });
  await guidePanel.close();
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Instances';
    for (const b of document.querySelectorAll('main > button'))
      if (b.textContent === 'A brand new button') b.remove();
  });
  await page.waitForTimeout(200);
}

// ═══════════════════════════════════════════════════════════════════════════
// 引导卡住了，要么接着走，要么告诉用户卡住了——不能一直没有下文。
//
// 第一段是调用过期（执行它的侧栏迟迟不回）：宿主清扫时得出「调用超时」，以前算
// 出来就丢掉了。过期靠直接改存储构造，不经广播——真等 150 秒不现实。放在任何
// 标签页切换之前：每切一次，开着的侧栏都会去问一次「有没有在途调用」，那一问本身
// 也会清扫。（派出时一个侧栏都没开、侧栏在调用途中被关掉，是文件末尾 06c 那段。）
//
// 最后一段：侧栏跟着活动标签页换绑，而宿主派出的调用只广播一次。用户点了一个在
// 新标签页打开的链接，侧栏换绑过去；原标签页的引导这时派出一次调用，侧栏认出
// 不是自己这一页的，丢掉——再没有人执行它，线程带着在途调用一直焊死到用户放弃。
// ═══════════════════════════════════════════════════════════════════════════
{
  const effPanel = await ctx.newPage();
  await effPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const host = async (msg) => await effPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);
  const threadNow = async () =>
    await sw.evaluate(async (id) => {
      const k = `guide:tab-${id}`;
      return (await chrome.storage.session.get(k))[k] ?? null;
    }, tabId);
  /** The notes the host has written to this tab since the count `n`. */
  const answersSince = async (n) => (await entriesOf('note', effPanel)).slice(n).map((e) => e.text);

  let calls = 0;
  modelHandler = async (route, body) => {
    calls++;
    const first = liveRef(body, 'button', 'Create instance');
    await fulfillEnvelope(
      route,
      calls === 1
        ? { intent: 'point', route: [{ at: '列表页', goal: '先打开实例' }], ref: first, action: 'click', why: '第一步' }
        : {
            intent: 'point',
            route: [{ at: '后台变过的列表页', goal: '接着往下走' }],
            ref: otherRef(body, first),
            action: 'click',
            why: '第二步',
          },
    );
  };

  const beforeStart = requestLog.length;
  await host({ type: 'SAID', tabId, text: '引导卡住了要有下文' });
  await waitUntil(() => requestLog.length > beforeStart, 4000);
  check(
    '（前提）引导起来了，第一步在屏上',
    requestLog.length === beforeStart + 1 && (await overlayStatus('shown')) === 'shown',
    `requests=${requestLog.length - beforeStart} status=${await overlayStatus('shown', 0)}`,
  );

  /** 线程记着一次在途调用，一个开着的侧栏认领了它，截止时间已经过了。返回它的 `at`。
   *  只有有人在跑的调用才会迟到（06c）：没人认领的，侧栏一开就重新派出。 */
  const expireAnInflightCall = async (effectId, transportFails = 0) =>
    await sw.evaluate(
      async ([id, eid, fails]) => {
        const k = `guide:tab-${id}`;
        const t = (await chrome.storage.session.get(k))[k];
        const at = { threadRev: t.rev, snapshotId: t.table.snapshotId, structureHash: t.table.structureHash, url: t.table.url };
        const [holder] = await chrome.runtime.getContexts({ documentUrls: [chrome.runtime.getURL('sidepanel.html')] });
        await chrome.storage.session.set({
          [k]: { ...t, transportFails: fails, inflight: { effectId: eid, kind: 'callModel', at } },
          [`effect:tab-${id}`]: {
            effectId: eid, threadId: `tab-${id}`, kind: 'callModel', params: {}, at, deadline: Date.now() - 1,
            claimedBy: holder.documentId,
          },
        });
        return at;
      },
      [tabId, effectId, transportFails],
    );

  // 执行它的侧栏过了截止时间才回来。一次没走通不是模型没答好，是这一趟没通：
  // 宿主不声不响地原样再问一遍，用户不必知道，也不必把目标重打一遍。
  const lateAt = await expireAnInflightCall('e-came-back-late');
  const beforeLate = requestLog.length;
  await host({
    type: 'EFFECT_RESULT',
    threadId: `tab-${tabId}`,
    effectId: 'e-came-back-late',
    at: lateAt,
    outcome: { ok: false, error: '连接被重置', retryable: true, failureKind: 'transport', providerCalls: 1 },
  });
  const askedAgain = await waitUntil(async () => requestLog.length > beforeLate, 5000);
  check(
    '调用过期之后结果才回来 → 宿主原样再问一遍，引导不停在那里',
    askedAgain && !(await entriesOf('note', effPanel)).some((e) => e.text.includes('调用超时')),
    JSON.stringify({ 又问了几次: requestLog.length - beforeLate }),
  );

  // 连着第二次就不是抖一下了：照实告诉用户，并且那条记录上就能再试一次。
  const lateAgainAt = await expireAnInflightCall('e-late-again', 1);
  await host({
    type: 'EFFECT_RESULT',
    threadId: `tab-${tabId}`,
    effectId: 'e-late-again',
    at: lateAgainAt,
    outcome: { ok: false, error: '连接被重置', retryable: true, failureKind: 'transport', providerCalls: 1 },
  });
  let lateAnswers = [];
  await waitUntil(async () => (lateAnswers = await entriesOf('note', effPanel)).some((e) => e.text.includes('调用超时')), 4000);
  const told = lateAnswers.find((e) => e.text.includes('调用超时'));
  check('连着两次没走通 → 告诉用户「调用超时」，并且这一条标着可以再试', Boolean(told?.canRetry), JSON.stringify(told ?? null));

  check('过期的调用从线程上撤掉了', (await threadNow())?.inflight === null, JSON.stringify((await threadNow())?.inflight));
  // 而「可以再试」不是一句话：屏上就有那个按钮，点下去同一趟原样再问。
  const beforeRetry = requestLog.length;
  const button = effPanel.locator('.entry .retry').last();
  const clicked = await button.click({ timeout: 4000 }).then(() => true, () => false);
  const retried = clicked && (await waitUntil(async () => requestLog.length > beforeRetry, 5000));
  check(
    '点「再试一次」→ 同一趟原样再问，用户不用把目标重打一遍',
    retried,
    JSON.stringify({ 按钮点到了: clicked, 又问了几次: requestLog.length - beforeRetry }),
  );
  // 让它落定再往下走：这一段留下的在途调用会打扰后面的判断。
  await waitUntil(async () => (await threadNow())?.inflight == null, 6000);

  // 用户点了一个在新标签页打开的链接。
  const elsewhere = await ctx.newPage();
  await elsewhere.bringToFront();
  const switched = await waitUntil(
    async () =>
      (await effPanel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id)) !== tabId,
    3000,
  );
  await effPanel.waitForTimeout(300); // 侧栏收到 onActivated 之后才换绑
  check('（前提）活动标签页已经不是引导所在的那一页', switched);

  // 原标签页在后台变了，宿主为它派出一次调用。
  const beforeReplan = requestLog.length;
  const statesBefore = (await entriesOf('step', effPanel)).length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Instances · 在后台变了';
  });
  await waitUntil(() => requestLog.length > beforeReplan, 6000);
  check(
    '引导所在的标签页不在前台时，宿主派出的调用照样有侧栏执行',
    requestLog.length === beforeReplan + 1,
    `requests=${requestLog.length - beforeReplan}`,
  );
  let painted = null;
  await waitUntil(async () => {
    painted = (await entriesOf('step', effPanel)).slice(statesBefore).find((e) => e.route?.[0]?.at === '后台变过的列表页') ?? null;
    return painted !== null;
  }, 6000);
  check(
    '调用的结果回到了原标签页：下一步画上了屏，线程不再带着在途调用',
    painted?.axes?.binding === 'bound' && painted?.step?.outcome === undefined && (await threadNow())?.inflight === null,
    JSON.stringify({ axes: painted?.axes, outcome: painted?.step?.outcome, inflight: (await threadNow())?.inflight }),
  );
  await page.bringToFront();
  await elsewhere.close();

  await host({ type: 'END_GUIDE', tabId });
  await effPanel.close();
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Instances';
  });
  await page.waitForTimeout(200);
}

// ═══════════════════════════════════════════════════════════════════════════
// ask：模型问回来一句。要的是一段文字时，用户的回答会写进「引导我」那句话、
// 发给模型端点，所以侧栏要提醒凭据不要写进来。
// ═══════════════════════════════════════════════════════════════════════════
{
  const askPanel = await ctx.newPage();
  await askPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const host = async (msg) => await askPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);
  modelHandler = async (route) =>
    await fulfillEnvelope(route, { intent: 'ask', question: '你要设为私有的是哪一个仓库？', wants: 'text', options: [] });

  await host({ type: 'SAID', tabId, text: '把仓库设为私有' });
  let askText = '';
  const asked = await waitUntil(
    async () => (askText = await askPanel.evaluate(() => document.body.innerText)).includes('你要设为私有的是哪一个仓库？'),
    5000,
  );
  check(
    '模型用 ask 要一段文字 → 侧栏显示问题，并提醒密码、验证码、卡号不要写进来',
    asked && askText.includes('密码、验证码、卡号不要写进来'),
    askText.slice(0, 200),
  );

  await host({ type: 'END_GUIDE', tabId });
  await askPanel.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// observe：模型先要再看一眼，宿主读了这一页交回去，模型看完再指一步。
// 桩发回的工具调用不带 id——真端点里也有不给的——所以这一轮是靠宿主自己造的
// id 配上对的。
// ═══════════════════════════════════════════════════════════════════════════
{
  const obsPanel = await ctx.newPage();
  await obsPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const host = async (msg) => await obsPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);
  const refsIn = (text, role, name) =>
    [...String(text ?? '').matchAll(new RegExp(`(e\\d+) ${escapeRe(role)} ~?${escapeRe(JSON.stringify(name))}`, 'g'))].map((m) => m[1]);

  const bodies = [];
  modelHandler = async (route, body) => {
    bodies.push(body);
    if (bodies.length === 1) return await fulfillEnvelope(route, { intent: 'observe', why: '看看页面是不是已经加载完' });
    const read = body.messages?.find((m) => m.role === 'tool')?.content;
    await fulfillEnvelope(route, {
      intent: 'point',
      previous_step: 'first_plan',
      route: [{ at: '实例列表', goal: '新建一台实例' }],
      why: '新读到的这一页上就有新建实例的入口',
      ref: refsIn(read, 'button', 'Create instance')[0] ?? 'e0',
      action: 'click',
      value: null,
      expect_after: null,
    });
  };

  await host({ type: 'SAID', tabId, text: '先看清这一页再指' });
  await waitUntil(() => bodies.length >= 2, 6000);
  const second = bodies[1]?.messages ?? [];
  check(
    '模型要再看一眼 → 宿主读了这一页，第二次调用带着这一轮：先是模型的调用，再是读到的结果，按 id 配对',
    JSON.stringify(second.map((m) => m.role)) === JSON.stringify(['system', 'user', 'assistant', 'tool']) &&
      second[2]?.tool_calls?.[0]?.function?.name === 'observe' &&
      typeof second[3]?.tool_call_id === 'string' &&
      second[3].tool_call_id === second[2].tool_calls[0].id,
    JSON.stringify(second.map((m) => [m.role, m.tool_call_id ?? m.tool_calls?.[0]?.id ?? ''])),
  );
  check(
    '读回来的是这一页此刻的元素表，和首条消息一样包在不可信内容标签里',
    /<untrusted_page_content nonce="[^"]+">/.test(String(second[3]?.content)) && refsIn(second[3]?.content, 'button', 'Create instance').length > 0,
    String(second[3]?.content).slice(0, 120),
  );
  check('模型用新读到那张表里的 ref 指了一步 → 画上了屏', (await overlayStatus('shown', 4000)) === 'shown', await overlayStatus('shown', 0));

  await host({ type: 'END_GUIDE', tabId });

  // ---- wait_for：内容脚本盯着页面文字，等到了就回；等不到，如实说等了几秒 ----
  const waitBodies = [];
  modelHandler = async (route, body) => {
    waitBodies.push(body);
    const n = waitBodies.length;
    if (n === 1) return await fulfillEnvelope(route, { intent: 'wait_for', until: 'appears', text: '稍后出现的按钮', seconds: 5 });
    if (n === 2) {
      const read = body.messages?.find((m) => m.role === 'tool')?.content;
      return await fulfillEnvelope(route, {
        intent: 'point',
        previous_step: 'first_plan',
        route: [{ at: '实例列表', goal: '用刚出现的按钮' }],
        why: '等到的就是它',
        ref: refsIn(read, 'button', '稍后出现的按钮')[0] ?? 'e0',
        action: 'click',
        value: null,
        expect_after: null,
      });
    }
    if (n === 3) return await fulfillEnvelope(route, { intent: 'wait_for', until: 'appears', text: '永远不会出现的字', seconds: 1 });
    return await fulfillEnvelope(route, { intent: 'done', evidence: 'content_on_page', why: '够了' });
  };

  await page.evaluate(() => {
    setTimeout(() => {
      const b = document.createElement('button');
      b.id = 'late-arrival';
      b.textContent = '稍后出现的按钮';
      document.querySelector('main').appendChild(b);
    }, 1000);
  });
  await host({ type: 'SAID', tabId, text: '等那个按钮出来再指' });
  await waitUntil(() => waitBodies.length >= 2, 8000);
  const afterWait = String(waitBodies[1]?.messages?.find((m) => m.role === 'tool')?.content ?? '');
  check(
    '模型等一段文字 → 内容脚本等到它出现就回，这一轮带着「等到了」和此刻的页面交回模型',
    /等到了：[\d.]+ 秒后页面上出现了「稍后出现的按钮」/.test(afterWait) && refsIn(afterWait, 'button', '稍后出现的按钮').length === 1,
    afterWait.slice(0, 80),
  );
  check('模型指向等来的那个按钮 → 画上了屏', (await overlayStatus('shown', 4000)) === 'shown', await overlayStatus('shown', 0));
  await host({ type: 'END_GUIDE', tabId });

  await host({ type: 'SAID', tabId, text: '等一段不会出现的字' });
  await waitUntil(() => waitBodies.length >= 4, 8000);
  const missed = String(waitBodies[3]?.messages?.find((m) => m.role === 'tool')?.content ?? '');
  check(
    '等不到 → 到时如实交回「等了 1 秒，没等到」，连同此刻的页面，而不是一直挂着',
    missed.includes('等了 1 秒，没等到「永远不会出现的字」出现') && /<untrusted_page_content nonce="[^"]+">/.test(missed),
    missed.slice(0, 80),
  );

  await host({ type: 'END_GUIDE', tabId });
  // Pointing at the late button scrolled the page down to it. Later sections
  // measure positions from the top, so leave the page the way they expect it.
  await page.evaluate(() => {
    document.getElementById('late-arrival')?.remove();
    window.scrollTo(0, 0);
  });
  await obsPanel.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// read_doc：模型要先读这一页链接到的一份文档。宿主判定能抓，侧栏真的去抓，
// 正文回到模型——只有正文，脚本与原始 HTML 不进模型的输入。
// ═══════════════════════════════════════════════════════════════════════════
{
  const docPanel = await ctx.newPage();
  await docPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const host = async (msg) => await docPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);

  const DOC_URL = 'https://docs-stub.test/help/stop-instance';
  let docHits = 0;
  await ctx.route(DOC_URL, async (route) => {
    docHits++;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<html><body><script>stealEverything()</script><nav>站点导航</nav><main><h1>停止实例</h1><p>停止实例后，按量付费的计算费用会暂停。</p></main></body></html>',
    });
  });
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'doc-link';
    a.href = href;
    a.textContent = '查看停止实例的说明';
    document.querySelector('main').appendChild(a);
  }, DOC_URL);

  const docBodies = [];
  modelHandler = async (route, body) => {
    docBodies.push(body);
    if (docBodies.length === 1)
      return await fulfillEnvelope(route, { intent: 'read_doc', via_ref: liveRef(body, 'link', '查看停止实例的说明') ?? 'e0', query: '停止之后还收不收费' });
    return await fulfillEnvelope(route, { intent: 'done', evidence: 'content_on_page', why: '文档里写清楚了' });
  };

  await host({ type: 'SAID', tabId, text: '停止实例之后还收费吗' });
  await waitUntil(() => docBodies.length >= 2, 8000);
  const docText = String(docBodies[1]?.messages?.find((m) => m.role === 'tool')?.content ?? '');
  check('模型要读页面链接到的文档 → 侧栏真的去抓了那条链接', docHits === 1, `hits=${docHits}`);
  check(
    '正文回到模型，包在不可信内容标签里；脚本、原始 HTML 与页面导航都不在里面',
    docText.includes('停止实例后，按量付费的计算费用会暂停。') &&
      /<untrusted_page_content nonce="[^"]+">/.test(docText) &&
      !docText.includes('stealEverything') &&
      !docText.includes('<p>') &&
      !docText.includes('站点导航'),
    docText.slice(0, 120),
  );

  await host({ type: 'END_GUIDE', tabId });
  await ctx.unroute(DOC_URL);
  await page.evaluate(() => document.getElementById('doc-link')?.remove());
  await docPanel.close();
}

// ─────────────────────────────────────────────────────────────────────────
// Q-11 — 未配置模型时在输入框里说一句（README 完成时能演示什么·第五句）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();

  // "未配置模型"的状态：storage.local 里从未写过 `provider`。settings.ts
  // 的 `loadConfig()`（`{ ...DEFAULT_CONFIG, ...v, ... }`）在这种情况下原
  // 样退回 `DEFAULT_CONFIG`——`apiKey` 是空字符串，但 `baseURL` 早已预填
  // 了真实的 `https://api.openai.com/v1`（`PRESETS[0]`）。
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));

  // 宿主在起一趟之前就问 `modelIsConfigured`（与 `callModel()` 的前置检查、
  // 设置页两步连接的地址检查同一条判据）：空 apiKey + 非本地端点，一趟都不起、页面都
  // 不读。所以这里不应该发出任何请求——仍然给这个地址打桩，只是作为安全网：
  // 如果这道闸将来被意外削弱、又开始发请求了，桩会把它挡在 CI 的真实网络之外，
  // 同时下面 Q-11c 的计数会立刻从 0 变红，而不是让请求悄悄打到真实 OpenAI。
  //
  // 地址必须跟着 preset 的协议走：`PRESETS[0]` 已改成 openai-responses，真正会
  // 被打到的是 `/v1/responses`。桩还钉在 `/v1/chat/completions` 的话，它不再拦
  // 任何东西，而下面那条「0 次请求」的断言照样绿——一条安全网会静默变成一句空
  // 话，漏出去的请求直奔真实 OpenAI。所以这里用通配，preset 再换协议也拦得住。
  const noModelRequestLog = [];
  await ctx.route('https://api.openai.com/**', async (route) => {
    noModelRequestLog.push(route.request().url());
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }),
    });
  });

  const noModelPanel = await ctx.newPage();
  await noModelPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await noModelPanel.waitForTimeout(500); // 让 sync() 里的 chrome.tabs.query 先落定 tabId

  const cfgSeen = await noModelPanel.evaluate(
    async () => (await chrome.storage.local.get('provider')).provider ?? null,
  );
  check('Q-11 前置：storage 里确实没有 provider 配置（DEFAULT_CONFIG 生效）', cfgSeen === null, JSON.stringify(cfgSeen));

  await noModelPanel.locator('.composer input').fill('这个页面是做什么用的？');
  await noModelPanel.getByRole('button', { name: '发送', exact: true }).click();

  // 逐字比对——call.ts 里这条是硬编码常量（`MODEL_NOT_CONFIGURED`），不是拼出来的文案。
  const EXPECTED_NO_MODEL_MESSAGE =
    '还没有配置模型：请先在「工具与设置 › 模型配置」里填好端点和 API Key，点「连接」拿到模型列表，选一个之后点「验收并保存」。';
  await waitUntil(async () => ((await viewOf(noModelPanel, tabId))?.conversation?.entries ?? []).some((e) => e.kind === 'note'), 6000);
  const errText = ((await viewOf(noModelPanel, tabId))?.conversation?.entries ?? []).filter((e) => e.kind === 'note').at(-1)?.text ?? null;
  check(
    'Q-11a：未配置模型时点「发送」，面板给出可读的中文提示，逐字等于那条"请先配置"文案（不是"Key 被拒绝"——没有 Key 不等于 Key 填错了）',
    errText === EXPECTED_NO_MODEL_MESSAGE,
    errText ?? '(超时未出现任何提示)',
  );

  // 「在想」 is computed from the thread on every pull, so a refusal that
  // started nothing leaves nothing pending — there is no flag to hang.
  const busyCount = (await viewOf(noModelPanel, tabId))?.pending?.kind === 'idle' ? 0 : 1;
  check(
    'Q-11b：不挂起——到达确定的错误终态，不是永远停在「正在…」',
    errText !== null && busyCount === 0,
    busyCount > 0 ? `仍有 ${busyCount} 个"忙碌"状态元素显示中` : (errText ?? '(既未报错也未忙碌)'),
  );

  check(
    'Q-11c：如实计数——0 次模型请求。未配置时宿主一趟都不起，' +
      '页面内容（元素表）不会被发往用户从未选过的默认端点——这正是这次要补的缺陷本身',
    noModelRequestLog.length === 0,
    `实际发出 ${noModelRequestLog.length} 次：${JSON.stringify(noModelRequestLog)}`,
  );

  // 那条提示自己带着去处：宿主记下 `fix: 'model'`，侧栏把它画成一个直达模型配置的按钮。
  // 取最后一个：这条对话里更早的 401 之类也带着同一个去处。
  const fixBtn = noModelPanel.getByRole('button', { name: '打开模型配置 →', exact: true }).last();
  const fixOffered = await waitUntil(async () => await fixBtn.isVisible().catch(() => false), 3000);
  if (fixOffered) await fixBtn.click();
  const fixPage = fixOffered ? await noModelPanel.locator('.page-bar h1').innerText().catch(() => '') : '';
  check('Q-11f：提示下面就是「打开模型配置 →」，一点直接进模型配置页', fixPage === '模型配置', fixOffered ? `到了「${fixPage}」` : '(没有这个按钮)');
  if (fixOffered) await backToChat(noModelPanel).catch(() => {});

  // 既有能力：抽取本页元素——PANEL_EXTRACT 从不经过 agent/provider/provider.ts，不
  // 应受"未配置模型"影响。
  await openSettings(noModelPanel, '检视页面');
  await noModelPanel.getByRole('button', { name: '抽取本页元素', exact: true }).click();
  const extractText = await pollText(() => noModelPanel.locator('.settings-page .note.ok').first(), 4000);
  check(
    'Q-11d：既有能力不变——「抽取本页元素」照常返回控件表',
    typeof extractText === 'string' && extractText.includes('抽取到'),
    extractText ?? '(超时)',
  );

  // 既有能力：检视模式——同样不经过 provider.ts。
  await noModelPanel.getByRole('button', { name: '检视元素', exact: true }).click();
  const stopBoxNoModel = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('td button')].find((b) => b.textContent.trim() === 'Stop');
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.move(stopBoxNoModel.x, stopBoxNoModel.y);
  await page.waitForTimeout(150);
  const inspectNoModel = await sw.evaluate(
    async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }, { frameId: 0 }),
    tabId,
  );
  check(
    'Q-11e：既有能力不变——检视模式照常可用，悬停即描边',
    inspectNoModel?.data?.visible === true,
    `status=${inspectNoModel?.data?.status}`,
  );
  await noModelPanel.getByRole('button', { name: '取消检视', exact: true }).click();

  await ctx.unroute('https://api.openai.com/**');
  await noModelPanel.close();
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 看不见的模态框不是模态框（2026-08-20 真机取证）
//
// `findModalScope` 的前提是「模态框打开时用户几乎总是被困在里面」，所以锁定
// 作用域是对的。但它最后一条选择器 `[role=dialog][aria-modal=true]` 完全不做
// 可见性检查，而「DOM 里常驻一个 display:none 的模态框模板」是通行做法。
//
// 真机取证（github.com/search?q=n8n）：GitHub 的 hovercard 容器
// `<div role="dialog" aria-modal="true" class="Popover js-hovercard-content">`
// 常驻页面且 display:none，整页 197 个控件被锁进这个空壳，
// stats 是 scanned=1 cand=0 visible=0 emitted=0 —— 遍历只看见空壳自己。
// 首页和仓库页没有这个容器，所以同一个站逐页表现不同。
//
// 对照组不可省：把可见模态框的锁定一并删掉，前半句同样会变绿。
// ═══════════════════════════════════════════════════════════════════════════
{
  const baseline = (await refresh()).items.length;

  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'ghost-modal';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.style.display = 'none';
    document.body.appendChild(d);
  });
  const withGhost = await refresh();
  check(
    '看不见的 aria-modal 空壳不会把整页抽取锁进去',
    withGhost.items.length === baseline && withGhost.stats.modalScoped === false,
    `items=${withGhost.items.length}（对照 ${baseline}） modalScoped=${withGhost.stats.modalScoped} scanned=${withGhost.stats.elementsScanned}`,
  );
  await page.evaluate(() => document.getElementById('ghost-modal')?.remove());

  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'real-modal';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.style.cssText = 'position:fixed;left:20%;top:20%;width:300px;height:200px;background:#fff;z-index:99';
    d.innerHTML = '<button id="modal-ok">Modal OK</button>';
    document.body.appendChild(d);
  });
  const withReal = await refresh();
  check(
    '真正看得见的模态框照旧锁定作用域，用户被困在哪里就抽哪里',
    withReal.stats.modalScoped === true && withReal.items.some((i) => i.name === 'Modal OK'),
    `modalScoped=${withReal.stats.modalScoped} items=${withReal.items.length}`,
  );
  await page.evaluate(() => document.getElementById('real-modal')?.remove());
  await refresh();
}

// ═══════════════════════════════════════════════════════════════════════════
// 「用过」不是「丢了」（2026-08-20 真机审计）
//
// 用户点掉一个会跳转的控件后，目标当然从 DOM 上消失了 —— 那是这一步成功的
// 样子，不是失败的样子。tracker 只看得见「元素没了」，两种情况长得一模一样，
// 于是成功被画成了失效屏：点击后约 50ms 提示框就改口说「找不到这一步的目标」，
// 而真正的下一步要等一次模型往返（≥1s）才可能把它换掉。
//
// 断言的是**状态跃迁序列**，不是某一刻的快照：失效屏只存在几十毫秒，随后
// STEP_USED 会让宿主把会话拆掉、浮层归 idle，轮询快照只会看到 idle 而
// 看不到中间那一闪。浮层宿主的 `data-status` 在页面侧可读（影子根是闭合的，
// 但宿主元素本身不是），所以用 MutationObserver 把每一次跃迁都记下来。
//
// 两半一起断言：被用掉的不进失效屏，真正消失的仍要进。少了后半句，把 lost
// 路径整个删掉也能让前半句变绿。
// ═══════════════════════════════════════════════════════════════════════════
{
  await page.evaluate(() => {
    for (const id of ['vanish-used', 'vanish-gone']) {
      document.getElementById(id)?.remove();
      const b = document.createElement('button');
      b.id = id;
      b.textContent = id === 'vanish-used' ? 'Vanish on use' : 'Vanish on its own';
      document.querySelector('main')?.prepend(b);
    }
    // Bubble phase, so the extension's capture-phase activation listener has
    // already seen the click by the time the control removes itself — exactly
    // the order a real navigating control produces.
    document.getElementById('vanish-used').addEventListener('click', function () {
      this.remove();
    });
  });
  await refresh();

  /** Every `data-status` the overlay host passes through from now on. */
  const recordStatuses = async () =>
    await page.evaluate(() => {
      window.__statuses = [];
      window.__statusObs?.disconnect();
      const host = document.querySelector('[data-page-guide]');
      if (!host) return false;
      window.__statuses.push(host.dataset.status);
      window.__statusObs = new MutationObserver(() => window.__statuses.push(host.dataset.status));
      window.__statusObs.observe(host, { attributes: true, attributeFilter: ['data-status'] });
      return true;
    });
  const seenStatuses = async () => await page.evaluate(() => window.__statuses ?? []);

  // A guide has to own this tab, or the test measures the wrong thing: with no
  // `guide:` record, content events reach nothing.
  //
  // The in-flight call is what keeps the readings this section causes inert:
  // a reading that lands while a call is out is only written down, and spends
  // nothing (the answer that comes back is dropped, and the model asked again).
  // So no model is called and no `present` can repaint the overlay out from
  // under the assertion — and, unlike pinning the thread at the run's step
  // budget, the guide does not end, which is what this section needs: a
  // quota-exhausted thread is a *terminal* one, and a terminal one ends the
  // run and clears the overlay this test is watching.
  //
  // No `effect:{id}` record accompanies it, so E-4's sweep never judges it
  // expired and never synthesizes a failure back into the reducer.
  await sw.evaluate(
    async ([id, t]) =>
      await chrome.storage.session.set({
        [`guide:tab-${id}`]: {
          rev: 1,
          goal: '用掉一个目标',
          table: t,
          pointedOn: t,
          route: [],
          steps: [],
          cursor: 0,
          history: [],
          evidence: 'model',
          check: 'unknown',
          callCount: 1,
          stepCalls: 0, spentSteps: 0,
          inflight: {
            effectId: 'e-already-out',
            kind: 'callModel',
            at: { threadRev: 1, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
          },
        },
      }),
    [tabId, table],
  );

  const usedStep = {
    descriptor: { role: 'button', name: 'Vanish on use' },
    expectedUserAction: 'click',
    title: '会被用掉的目标',
  };
  await highlight(command(usedStep));
  check('用掉前先正常高亮', (await overlayStatus('shown')) === 'shown', await overlayStatus('shown', 0));

  check('浮层宿主的 data-status 可被页面侧观察到（下面两条断言的前提）', await recordStatuses());
  await page.click('#vanish-used');
  await page.waitForTimeout(1200);
  const usedSeen = await seenStatuses();
  check(
    '被用掉的目标不进失效屏',
    !usedSeen.includes('lost'),
    `跃迁序列=${JSON.stringify(usedSeen)}`,
  );
  check(
    '被用掉的目标进入「已完成，正在看新页面」',
    usedSeen.includes('settling'),
    `跃迁序列=${JSON.stringify(usedSeen)}`,
  );

  // `settling` stands until the host paints the next step or ends the run —
  // no timer turns it into anything else (06b). It used to fall to the
  // failure screen after five seconds, a guess at how long the next step
  // takes; a call that never comes back is the host's own deadline to tell
  // the user about, and 结束引导 is on this screen the whole time.
  await page.waitForTimeout(6000);
  const strandedSeen = await seenStatuses();
  check(
    '没人接手时 settling 就一直留着，不靠计时改画成失效屏',
    !strandedSeen.includes('lost') && (await overlayStatus('settling', 0)) === 'settling',
    `跃迁序列=${JSON.stringify(strandedSeen)}`,
  );


  const goneStep = {
    descriptor: { role: 'button', name: 'Vanish on its own' },
    expectedUserAction: 'click',
    title: '会自己消失的目标',
  };
  await highlight(command(goneStep));
  check('自己消失前先正常高亮', (await overlayStatus('shown')) === 'shown', await overlayStatus('shown', 0));

  await recordStatuses();
  await page.evaluate(() => document.getElementById('vanish-gone')?.remove());
  await page.waitForTimeout(1200);
  const goneSeen = await seenStatuses();
  check(
    '没被用过就消失的目标，照旧进失效屏',
    goneSeen.includes('lost'),
    `跃迁序列=${JSON.stringify(goneSeen)}`,
  );

  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型调用还占着时来的读数：只记下，不另起调用（05b）
//
// 一次只有一个调用。作答期间页面变了，那次回答回来时作废、带着读数重问一次；
// 在那之前，读数只写进线程，一分钱不花。
// ═══════════════════════════════════════════════════════════════════════════
{
  await page.evaluate(() => {
    document.getElementById('defer-btn')?.remove();
    const b = document.createElement('button');
    b.id = 'defer-btn';
    b.textContent = 'Change the page';
    // Adds a heading, so `structureFingerprint` really moves and `pageChange` is not `none`
    // — the structure watcher needs a landmark/heading, not just any control.
    b.addEventListener('click', () => {
      const h = document.createElement('h2');
      h.textContent = 'A brand new section';
      document.querySelector('main')?.appendChild(h);
    });
    document.querySelector('main')?.prepend(b);
  });
  const deferTable = await refresh();

  // A guide thread that already has a model call out against this very page.
  await sw.evaluate(
    async ([id, t]) =>
      await chrome.storage.session.set({
        [`guide:tab-${id}`]: {
          rev: 1,
          goal: '看看重规划怎么记账',
          table: t,
          pointedOn: t,
          route: [],
          steps: [],
          cursor: 0,
          history: [],
          evidence: 'model',
          check: 'unknown',
          callCount: 1,
          stepCalls: 0, spentSteps: 0,
          inflight: {
            effectId: 'E-inflight',
            kind: 'callModel',
            at: { threadRev: 1, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
          },
        },
      }),
    [tabId, deferTable],
  );
  const beforeDefer = requestLog.length;

  await highlight(
    command({
      descriptor: { role: 'button', name: 'Change the page' },
      expectedUserAction: 'click',
      title: '让页面结构变一下',
    }),
  );
  await overlayStatus('shown');
  await page.click('#defer-btn');
  await page.waitForTimeout(1500); // past the 400ms structure debounce

  const deferred = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check(
    '模型调用还占着时，页面变动只记成读数，不另起一次调用',
    deferred?.inflight?.effectId === 'E-inflight' &&
      (deferred?.readings ?? []).some((r) => r.kind === 'changed') &&
      requestLog.length === beforeDefer,
    JSON.stringify({ inflight: deferred?.inflight?.effectId, readings: deferred?.readings, calls: requestLog.length - beforeDefer }),
  );

  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  await page.evaluate(() => document.getElementById('defer-btn')?.remove());
}

// ═══════════════════════════════════════════════════════════════════════════
// 跨站跳转要先问过用户（07 · P-2 的渲染半边）
//
// 承诺是「跳**之前**你就看见目的地」。判定有 6 条单元测试；这里证的是另一半：
// 宿主真的把它广播出去了，用户答应之后步骤才被框出来。
//
// 不经过模型桩驱动——挤进模型打桩块要让重规划恰好落在带 href 的那张表上，试了
// 一轮没调通。改用协议里真实存在的 `EFFECT_RESULT` 消息直接喂一个信封：这正是
// 面板拿到模型回答后走的那条路，只是把「模型说了什么」变成确定的。
// ═══════════════════════════════════════════════════════════════════════════
{
  const listener = await ctx.newPage();
  await listener.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await listener.evaluate(() => {
    window.__cs = [];
  });
  await page.bringToFront();

  await page.evaluate(() => {
    document.getElementById('offsite')?.remove();
    const a = document.createElement('a');
    a.id = 'offsite';
    a.href = 'https://docs.elsewhere-example.test/help';
    a.textContent = 'Read the docs elsewhere';
    document.querySelector('main')?.prepend(a);
  });
  const csTable = await refresh();
  const offsiteRef = csTable.items.find((i) => i.href === 'https://docs.elsewhere-example.test/help')?.ref;
  check('抽取器把链接的落地地址带进了元素表（宿主判定跨站的唯一来源）', Boolean(offsiteRef), `ref=${offsiteRef}`);

  // 一条正等着模型作答的线程，作答对象就是这张表。
  await sw.evaluate(
    async ([id, t]) =>
      await chrome.storage.session.set({
        [`guide:tab-${id}`]: {
          rev: 7, goal: '去看文档', table: t, pointedOn: t, route: [], steps: [], cursor: 0, history: [],
          evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 0, spentSteps: 0,
          inflight: {
            effectId: 'cs-1', kind: 'callModel',
            at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
          },
        },
      }),
    [tabId, csTable],
  );
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);

  await listener.evaluate(
    async ([id, t, ref]) =>
      await chrome.runtime.sendMessage({
        type: 'EFFECT_RESULT',
        threadId: `tab-${id}`,
        effectId: 'cs-1',
        at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
        outcome: {
          ok: true,
          providerCalls: 1,
          // The function name is the intent; the arguments carry no `intent`.
          tool: 'point',
          value: JSON.stringify({ route: [{ at: '夹具页', goal: '去看文档' }], ref, action: 'click', why: '这条链接会带你离开本站' }),
        },
      }),
    [tabId, csTable, offsiteRef],
  );
  await page.waitForTimeout(1200);

  await waitForEntry('note', '离开当前站点', 5000, listener);
  const ask = await lastEntry('note', listener);
  check(
    '跨站的那一步先弹确认，卡片同时念出「从哪」和「去哪」的完整 hostname',
    String(ask?.detail).includes('127.0.0.1') && String(ask?.detail).includes('docs.elsewhere-example.test'),
    JSON.stringify(ask),
  );
  check('确认之前不把这一步画到屏上——用户还没同意离开', (await overlayStatus('shown', 400)) !== 'shown');

  await listener.evaluate(
    async (id) => await chrome.runtime.sendMessage({ type: 'CROSS_SITE_DECISION', tabId: id, confirmed: true }),
    tabId,
  );
  check('确认之后这一步才被框出来', (await overlayStatus('shown')) === 'shown', await overlayStatus('shown', 0));

  await listener.close();
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  await page.evaluate(() => document.getElementById('offsite')?.remove());
}

// ═══════════════════════════════════════════════════════════════════════════
// 找不到目标：当场说给模型听，页面变了接着找（05a · 症状 3；05d；06b）
//
// 目标不在页面上时，内容脚本画出「找不到」，当场报一条读数交给模型，然后页面
// 每变一次就再找一次，找到就画上。旧日宿主当场把它当成定论：盖上
// unavailable，对用户说「找不到这一步的目标」——目标随后出现，历史改不回来，
// 那句话也收不回来。后来改成找完一整轮（七档计时，约 15 秒）才报；06b 删掉了
// 那一轮：要不要等，由模型用 wait_for 说。宿主自己什么都不下结论。
// ═══════════════════════════════════════════════════════════════════════════
{
  const UNRESOLVED = '找不到这一步的目标';
  const listener = await ctx.newPage();
  await listener.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await listener.evaluate(() => {
    window.__said = [];
  });
  await page.bringToFront();
  /** The newest step entry in this tab's conversation, whatever it is about. */
  const lastState = async () => await lastEntry('step', listener);
  /** Whether the entry tells the whole of it: the route, the three axes, and a
   *  model step's number with no total. The steps already walked are the
   *  conversation itself now — every earlier step is still an entry above. */
  const whole = (e) => Array.isArray(e?.route) && e.route.length > 0 && Boolean(e?.axes) && e?.step?.total === null;

  /** A model-planned step whose target is in the table but gone from the page when the step is painted. */
  const planOnVanishedTarget = async (id, name, fx) => {
    await page.evaluate(([id, name]) => {
      document.getElementById(id)?.remove();
      const b = document.createElement('button');
      b.id = id;
      b.textContent = name;
      document.querySelector('main')?.prepend(b);
    }, [id, name]);
    const t = await refresh();
    const ref = t.items.find((i) => i.role === 'button' && i.name === name)?.ref;
    await sw.evaluate(
      async ([tab, t, fx]) =>
        await chrome.storage.session.set({
          [`guide:tab-${tab}`]: {
            rev: 7, goal: '点这个按钮', table: t, pointedOn: t, route: [], steps: [], cursor: 0, history: [],
            evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 0, spentSteps: 0,
            inflight: {
              effectId: fx, kind: 'callModel',
              at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
            },
          },
        }),
      [tabId, t, fx],
    );
    await sw.evaluate(async (tab) => await chrome.tabs.sendMessage(tab, { type: 'CLEAR' }, { frameId: 0 }), tabId);
    await page.evaluate((id) => document.getElementById(id)?.remove(), id);

    await listener.evaluate(
      async ([tab, t, ref, fx]) =>
        await chrome.runtime.sendMessage({
          type: 'EFFECT_RESULT',
          threadId: `tab-${tab}`,
          effectId: fx,
          at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
          outcome: {
            ok: true,
            providerCalls: 1,
            tool: 'point',
            value: JSON.stringify({ route: [{ at: '夹具页', goal: '点按钮' }], ref, action: 'click', why: '就是它' }),
          },
        }),
      [tabId, t, ref, fx],
    );
  };
  const lastStep = async () =>
    await sw.evaluate(async (tab) => ((await chrome.storage.session.get(`guide:tab-${tab}`))[`guide:tab-${tab}`]?.history ?? []).at(-1) ?? null, tabId);
  const said = async () => (await entriesOf('note', listener)).map((e) => e.text).filter((text) => text.includes(UNRESOLVED));

  // 这一段要一个模型桩，由 listener 这张侧栏去调。
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const NOT_FOUND_TEXT = '扩展要画的时候在页面上没找到它的目标';

  // 一、目标短暂消失又回来。模型被叫醒之后一直没回答：这一段只看渲染器自己
  // 接着找——模型怎么回答，是它的事。
  const hold = deferred();
  modelHandler = async (route) => {
    // Let go only once this section is done with it: by then the thread it
    // was asked for is gone, and the answer is dropped as stale (E-2).
    await hold.promise;
    await fulfillEnvelope(route, { intent: 'ask', question: '还要等吗？', wants: 'text', options: [] }).catch(() => {});
  };
  const beforeFlaky = requestLog.length;
  await planOnVanishedTarget('flaky', 'Back in a moment', 'fx-flaky');
  check('05a：目标暂时不在页面上时，先画出「找不到」', (await overlayStatus('lost')) === 'lost');
  await waitUntil(() => requestLog.length > beforeFlaky, 5000);
  const toldFlaky = String(requestLog[beforeFlaky]?.body?.messages?.[1]?.content ?? '');
  check(
    '06b：画出「找不到」的同时，这件事就作为一条读数交给了模型——不等任何计时',
    requestLog.length === beforeFlaky + 1 && toldFlaky.includes(NOT_FOUND_TEXT),
    toldFlaky.slice(toldFlaky.indexOf('你上次回答之后'), toldFlaky.indexOf('你上次回答之后') + 120),
  );
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'flaky';
    b.textContent = 'Back in a moment';
    document.querySelector('main')?.prepend(b);
  });
  check(
    '05a：目标回到页面上 → 渲染器接着找到了，自动接上',
    (await overlayStatus('shown', 3000)) === 'shown',
    JSON.stringify({ overlay: (await guideState())?.data, page: await page.evaluate(() => document.visibilityState) }),
  );
  const foundReport = await waitUntil(async () => (await lastState())?.step?.outcome === undefined, 3000);
  check(
    '10b：目标重新找到时，那一条仍然完整——路标、三轴都在，模型的一步只说第几步',
    foundReport && whole(await lastState()),
    JSON.stringify(await lastState()),
  );
  check('05a：目标回来了，就不对用户说「找不到这一步的目标」', (await said()).length === 0, JSON.stringify(await said()));
  const recovered = await lastStep();
  check('05a：这一步没有被盖成 unavailable', recovered !== null && recovered.action === undefined, JSON.stringify(recovered));

  // 二、目标一直不回来：模型拿到那条读数，自己决定——这里它问用户。
  modelHandler = async (route) =>
    await fulfillEnvelope(route, { intent: 'ask', question: '页面上没有那个按钮，你是想找哪一个？', wants: 'text', options: [] });
  const beforeGone = requestLog.length;
  await planOnVanishedTarget('gone', 'Never comes back', 'fx-gone');
  await waitUntil(() => requestLog.length > beforeGone, 5000);
  const told = String(requestLog[beforeGone]?.body?.messages?.[1]?.content ?? '');
  check(
    '05d：「没找到」作为一条读数交给模型',
    told.includes(NOT_FOUND_TEXT),
    told.slice(told.indexOf('你上次回答之后'), told.indexOf('你上次回答之后') + 120),
  );
  await page.waitForTimeout(800);
  // 「找不到」 is written onto the entry that showed the step, and it stays
  // whole: the route and the axes are on the entry, not on a passing message
  // that could arrive carrying only a step number.
  const notFound = await lastEntry('step', listener);
  check(
    '10b：找不到目标时，那一条同样完整，路标不被清空',
    notFound?.step?.outcome === 'not_found' && whole(notFound),
    JSON.stringify(notFound),
  );
  check('05d：宿主自己不对用户说「找不到这一步的目标」', (await said()).length === 0, JSON.stringify(await said()));
  const gaveUp = await lastStep();
  check('05d：这一步也不被盖成 unavailable——那是模型的判断', gaveUp !== null && gaveUp.action === undefined, JSON.stringify(gaveUp));

  await sw.evaluate(async (tab) => await chrome.storage.session.remove(`guide:tab-${tab}`), tabId);
  hold.resolve();
  await listener.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (tab) => await chrome.storage.session.remove(`guide:tab-${tab}`), tabId);
  await sw.evaluate(async (tab) => await chrome.tabs.sendMessage(tab, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  await page.evaluate(() => {
    document.getElementById('flaky')?.remove();
    document.getElementById('gone')?.remove();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 目标在页面上，但此刻点不了（06b · Actionability）
//
// 画上之后看两帧：禁用、被别的内容挡住、还在动，都作为一条读数当场交给模型，
// 带着原因；那一步照常画着。这里证真实页面上的读取接上了线——判定规则本身在
// presenter 的单测里钉死。
// ═══════════════════════════════════════════════════════════════════════════
{
  const listener = await ctx.newPage();
  await listener.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  // Woken, and never answering while the section looks: what the model is
  // told is the whole point here, not what it does about it.
  const hold = deferred();
  modelHandler = async (route) => {
    await hold.promise;
    await fulfillEnvelope(route, { intent: 'ask', question: '怎么办？', wants: 'text', options: [] }).catch(() => {});
  };

  /** A model-planned step at a button that is on the page but, per `how`, cannot be operated. */
  const pointAtStuck = async (how, fx) => {
    await page.evaluate((how) => {
      document.getElementById('stuck')?.remove();
      document.getElementById('stuck-cover')?.remove();
      const b = document.createElement('button');
      b.id = 'stuck';
      b.textContent = 'Stuck button';
      if (how === 'disabled') b.disabled = true;
      document.querySelector('main')?.prepend(b);
      if (how === 'covered') {
        // The whole viewport, so no scroll can move the button out from under it.
        const c = document.createElement('div');
        c.id = 'stuck-cover';
        Object.assign(c.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.3)', zIndex: '2147483000' });
        document.body.appendChild(c);
      }
    }, how);
    const t = await refresh();
    const ref = t.items.find((i) => i.role === 'button' && i.name === 'Stuck button')?.ref;
    await sw.evaluate(
      async ([tab, t, fx]) =>
        await chrome.storage.session.set({
          [`guide:tab-${tab}`]: {
            rev: 7, goal: '点这个按钮', table: t, pointedOn: t, route: [], steps: [], cursor: 0, history: [],
            evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 0, spentSteps: 0,
            inflight: {
              effectId: fx, kind: 'callModel',
              at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
            },
          },
        }),
      [tabId, t, fx],
    );
    await sw.evaluate(async (tab) => await chrome.tabs.sendMessage(tab, { type: 'CLEAR' }, { frameId: 0 }), tabId);
    const before = requestLog.length;
    await listener.evaluate(
      async ([tab, t, ref, fx]) =>
        await chrome.runtime.sendMessage({
          type: 'EFFECT_RESULT',
          threadId: `tab-${tab}`,
          effectId: fx,
          at: { threadRev: 7, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url },
          outcome: {
            ok: true,
            providerCalls: 1,
            tool: 'point',
            value: JSON.stringify({ route: [{ at: '夹具页', goal: '点按钮' }], ref, action: 'click', why: '就是它' }),
          },
        }),
      [tabId, t, ref, fx],
    );
    // 等**那条原因到达模型**，而不是「紧接着的第一条调用」：往页面里塞一个按钮
    // 本身就会让页面结构变化，那条读数可能先发出一次调用，于是第一条根本不是
    // 这一段要看的那条。要证的性质是「这个原因被告诉了模型」，那就照这句话等、
    // 也照这句话判。
    const said = async (reason) => {
      await waitUntil(() => requestLog.slice(before).some((r) => userText(r.body).includes(reason)), 6000);
      return requestLog.slice(before).map((r) => userText(r.body));
    };
    return said;
  };
  const woke = (texts) =>
    texts
      .map((t) => t.slice(t.indexOf('你上次回答之后'), t.indexOf('你上次回答之后') + 90))
      .filter(Boolean)
      .join(' ⁋ ');

  const disabledTold = await (await pointAtStuck('disabled', 'fx-stuck-disabled'))('此刻点不了：它是禁用的');
  check('06b：目标是禁用的 → 那一步照常画着', ['shown', 'occluded'].includes(await overlayStatus('shown', 2000)), await overlayStatus('shown', 0));
  check(
    '06b：目标是禁用的 → 当场作为一条读数交给模型，说明原因',
    disabledTold.some((t) => t.includes('此刻点不了：它是禁用的')),
    woke(disabledTold),
  );

  const coveredTold = await (await pointAtStuck('covered', 'fx-stuck-covered'))('此刻点不了：它被别的内容挡住了');
  check(
    '06b：目标被别的内容挡住 → 当场作为一条读数交给模型，说明原因',
    coveredTold.some((t) => t.includes('此刻点不了：它被别的内容挡住了')),
    woke(coveredTold),
  );

  await sw.evaluate(async (tab) => await chrome.storage.session.remove(`guide:tab-${tab}`), tabId);
  hold.resolve();
  await listener.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (tab) => await chrome.tabs.sendMessage(tab, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  await page.evaluate(() => {
    document.getElementById('stuck')?.remove();
    document.getElementById('stuck-cover')?.remove();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 点了一个没反应的按钮（05b · 读数唤醒模型）
//
// 用户点了屏上那一步、页面什么都没发生。宿主不再等一个窗口、也不再替模型下
// 「没有反应」的结论：点击是一条读数，宿主读一次此刻的页面，带着它唤醒模型；
// 这一步做成了什么，在模型回答时才记——此刻重新读过、什么都没变，就是 none。
// ═══════════════════════════════════════════════════════════════════════════
{
  // The call the click wakes is carried out by a side panel, against the stub
  // endpoint — Q-11 above left no model configured.
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const inertPanel = await ctx.newPage();
  await inertPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // 一个真的什么都不做的按钮。
  await page.evaluate(() => {
    document.getElementById('inert-btn')?.remove();
    const b = document.createElement('button');
    b.id = 'inert-btn';
    b.textContent = 'Does nothing at all';
    document.querySelector('main')?.prepend(b);
  });
  const inertTable = await refresh();
  const inertRef = inertTable.items.find((i) => i.name === 'Does nothing at all')?.ref;

  await sw.evaluate(
    async ([id, t, ref]) =>
      await chrome.storage.session.set({
        [`guide:tab-${id}`]: {
          rev: 3, goal: '点一个没反应的按钮', table: t, pointedOn: t,
          route: [{ at: '夹具页', goal: '试试这个按钮' }],
          steps: [{ ref, descriptor: { role: 'button', name: 'Does nothing at all' }, expectedUserAction: 'click', title: 'Does nothing at all' }],
          cursor: 0,
          history: [{ title: 'Does nothing at all', url: t.url }],
          evidence: 'model', check: 'unknown',
          callCount: 2, stepCalls: 0, spentSteps: 0, inflight: null,
        },
      }),
    [tabId, inertTable, inertRef],
  );

  // The model, woken by the click, points somewhere else.
  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: '夹具页', goal: '换一个控件' }],
      ref: liveRef(body, 'button', 'Create instance'),
      action: 'click',
      why: '那个按钮没有反应，换这个',
    });
  const beforeInert = requestLog.length;
  // Painted under the presentation the host would have given this step, so
  // the click is reported as *this* step used.
  await highlight(
    command(
      { ref: inertRef, descriptor: { role: 'button', name: 'Does nothing at all' }, expectedUserAction: 'click', title: 'Does nothing at all' },
      { sessionId: `tab-${tabId}`, presentationId: `tab-${tabId}#1`, snapshotId: inertTable.snapshotId },
    ),
  );
  await overlayStatus('shown');
  await page.click('#inert-btn');
  await waitUntil(() => requestLog.length > beforeInert, 6000);
  await page.waitForTimeout(600);

  const said = String(requestLog[beforeInert]?.body?.messages?.[1]?.content ?? '');
  check(
    '点了没反应 → 不等窗口，带着「用户点了」立刻唤醒模型，并告诉它这一页没变',
    said.includes('用户点了你指的那一步') && said.includes('地址和页面上的控件都和你上次回答时看到的一样'),
    said.slice(said.indexOf('你上次回答之后'), said.indexOf('你上次回答之后') + 120),
  );
  const inertThread = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check(
    '模型回答之后，这一步记为执行了、这一页没变，不再永远停在未定',
    inertThread?.history?.[0]?.action === 'taken' && inertThread?.history?.[0]?.effect?.kind === 'none',
    `entry=${JSON.stringify(inertThread?.history?.[0])}`,
  );

  // Let the step the model answered with finish painting before tearing down:
  // a render cut short by the CLEAR below would report back against whatever
  // thread holds this tab next (ticket 05d).
  await overlayStatus('shown', 4000);
  await inertPanel.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
  await page.evaluate(() => document.getElementById('inert-btn')?.remove());
}

// ═══════════════════════════════════════════════════════════════════════════
// 回答要画的时候，页面已经不是它所属的那一页（05c · 症状 2 的宿主一半）
//
// 线程里那张表属于另一个地址，标签页却在这一页——等同于读完表之后页面换走了。
// 快照还是当前的、元素也还连着，只问快照的守卫会把它画在这一页上。现在内容
// 脚本认出这一步属于别处、拒绝画；宿主不说「找不到」，把这件事当成一条读数：
// 重新读一次此刻的页面，带着它唤醒模型。
// ═══════════════════════════════════════════════════════════════════════════
{
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const viewPanel = await ctx.newPage();
  await viewPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await viewPanel.evaluate(() => {
    window.__ans = [];
  });
  await page.bringToFront();
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);

  const here = await refresh();
  const createRef = here?.items?.find((i) => i.name === 'Create instance')?.ref;
  // The same snapshot, but read — as far as the thread knows — on another page.
  const drawnElsewhere = { ...here, url: new URL('/drawn-elsewhere', here.url).href };
  const inflightAt = await sw.evaluate(
    async ([id, t]) => {
      const at = { threadRev: 3, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url };
      await chrome.storage.session.set({
        [`guide:tab-${id}`]: {
          rev: 3, goal: '去创建实例', table: t, pointedOn: t, route: [], steps: [], cursor: 0, history: [],
          evidence: 'model', check: 'unknown', callCount: 1, stepCalls: 0, spentSteps: 0,
          inflight: { effectId: 'E-view', kind: 'callModel', at },
        },
      });
      return at;
    },
    [tabId, drawnElsewhere],
  );

  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: '这一页', goal: '创建实例' }],
      ref: liveRef(body, 'button', 'Create instance'),
      action: 'click',
      why: '在这一页上再指一次',
    });
  const beforeView = requestLog.length;
  await viewPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), {
    type: 'EFFECT_RESULT',
    threadId: `tab-${tabId}`,
    effectId: 'E-view',
    at: inflightAt,
    outcome: {
      ok: true,
      providerCalls: 1,
      tool: 'point',
      value: JSON.stringify({ route: [{ at: '别处', goal: '创建实例' }], ref: createRef, action: 'click', why: '创建实例' }),
    },
  });
  await waitUntil(() => requestLog.length > beforeView, 6000);
  const woke = String(requestLog[beforeView]?.body?.messages?.[1]?.content ?? '');
  check(
    '要画的时候页面不是它所属的那一页 → 不画，记成「没画出来」的读数，重新读页面唤醒模型',
    woke.includes('你指的那一步没有画出来') && woke.includes(`地址变了，现在是 ${here.url}`),
    woke.slice(woke.indexOf('你上次回答之后'), woke.indexOf('你上次回答之后') + 160),
  );
  check(
    '…模型在这一页上再指一次，这一次画上了',
    (await overlayStatus('shown', 4000)) === 'shown',
    await overlayStatus('shown', 0),
  );
  const told = (await entriesOf('note', viewPanel)).map((e) => e.text);
  check('…也没有对用户说「找不到这一步的目标」', !told.some((t) => String(t).includes('找不到')), JSON.stringify(told));
  const viewThread = await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, tabId);
  check(
    '…没画出来的那一步不被记成「找不到」',
    viewThread?.history?.[0]?.action === undefined,
    JSON.stringify(viewThread?.history),
  );

  await viewPanel.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 每步调用预算（09）：一步最多问模型 4 次，第 4 次只给结论工具
//
// 模型一直要再看一眼。第 4 次请求里只有 point / ask / done，末尾有一句我们的话
// 要它直接给结论；它还是要工具，就告诉用户这一步想了 4 次，不结束这一趟。
// ═══════════════════════════════════════════════════════════════════════════
{
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const budgetPanel = await ctx.newPage();
  await budgetPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await budgetPanel.evaluate(() => {
    window.__said = [];
  });
  await page.bringToFront();
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);

  modelHandler = async (route) => await fulfillEnvelope(route, { intent: 'observe', why: '再看一眼' });
  const beforeBudget = requestLog.length;
  await budgetPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: id, text: '一直想再看一眼' }), tabId);
  await waitUntil(() => requestLog.length >= beforeBudget + 4, 15_000);
  await page.waitForTimeout(1500);
  const bodies = requestLog.slice(beforeBudget).map((r) => r.body);
  const toolNames = (b) => (b?.tools ?? []).map((t) => t.function?.name);
  const lastWords = (b) => String(b?.messages?.at(-1)?.content ?? '');
  check(
    '09：一步里前三次请求给全部工具，第四次只给回答：point / ask / explain / done',
    bodies.length === 4 &&
      bodies.slice(0, 3).every((b) => toolNames(b).includes('observe')) &&
      JSON.stringify(toolNames(bodies[3])) === JSON.stringify(['point', 'ask', 'explain', 'done']),
    JSON.stringify(bodies.map(toolNames)),
  );
  check('09：第四次请求的最后一条是我们的话：直接给结论', lastWords(bodies[3]).includes('这一次请直接给结论'), lastWords(bodies[3]).slice(0, 60));
  const saidBudget = (await entriesOf('note', budgetPanel)).map((e) => e.text);
  check(
    '09：第四次还要工具 → 告诉用户这一步想了 4 次，不再问模型，这一趟也没有结束',
    saidBudget.some((t) => String(t).includes('这一步我已经想了 4 次')) &&
      requestLog.length === beforeBudget + 4 &&
      (await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`]?.ending ?? null, tabId)) === null,
    JSON.stringify({ said: saidBudget, calls: requestLog.length - beforeBudget }),
  );

  await budgetPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await budgetPanel.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 问这一页的事：同一个 agent 直接回答（08a）
//
// 一句关于这一页本身的话，模型用 explain 回答：回答交给侧栏，依据在页面上框出来。
// 一步都没指过，所以这是一次问答——不留线程、不写 Run record，框出的依据留在屏上。
// ═══════════════════════════════════════════════════════════════════════════
{
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const explainPanel = await ctx.newPage();
  await explainPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);

  const recordsBefore = await sw.evaluate(async () => ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).length);
  const ANSWER = 'Create instance 用来新建一台实例。';
  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: [liveRef(body, 'button', 'Create instance')] });
  const beforeExplain = requestLog.length;
  await explainPanel.evaluate(
    async (id) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: id, text: 'Create instance 这个按钮是干什么的？' }),
    tabId,
  );
  await waitForEntry('answer', ANSWER, 8000, explainPanel);
  await page.waitForTimeout(600);

  check(
    '08a：问这一页的事 → 模型用 explain 回答，回答交给侧栏',
    (await lastEntry('answer', explainPanel))?.text === ANSWER && requestLog.length === beforeExplain + 1,
    JSON.stringify({ answer: (await lastEntry('answer', explainPanel))?.text, calls: requestLog.length - beforeExplain }),
  );
  check('08a：依据在页面上框出来，并且留在屏上', (await overlayStatus('shown', 3000)) === 'shown', await overlayStatus('shown', 0));
  const leftThread = await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, tabId);
  const recordsAfter = await sw.evaluate(async () => ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).length);
  check(
    '08a：一步都没指过 → 这是一次问答：不留线程、不写 Run record',
    leftThread === null && recordsAfter === recordsBefore,
    JSON.stringify({ thread: leftThread !== null, records: recordsAfter - recordsBefore }),
  );

  await explainPanel.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }, { frameId: 0 }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 关掉浮层、关掉标签页，引导也真的结束（票 04）
// ═══════════════════════════════════════════════════════════════════════════
//
// 这两条路原先只清理旧实现，模型驱动的那一趟会留下
// `guide:`/`effect:` 残骸、一次在途的模型调用（真金白银）和一条没落盘的摘要。
// 判据对两者相同：线程的键不在了、摘要在、在途的调用被广播中止。
{
  const watcher = await ctx.newPage();
  await watcher.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await watcher.evaluate(() => {
    window.__aborts = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'EFFECT_ABORT') window.__aborts.push(m.effectId);
    });
  });
  await page.bringToFront();

  const closeTable = await refresh();
  /** 一条带在途调用的活线程，以及它在线上那一半的镜像（`effect:` 键）。 */
  const seedGuide = async (id, goal, effectId) =>
    await sw.evaluate(
      async ([tab, t, g, fx]) => {
        const at = { threadRev: 3, snapshotId: t.snapshotId, structureHash: t.structureHash, url: t.url };
        await chrome.storage.session.set({
          [`guide:tab-${tab}`]: {
            rev: 3, goal: g, table: t, pointedOn: t, route: [], steps: [], cursor: 0,
            history: [{ title: '第一步', url: t.url }],
            evidence: 'model', check: 'unknown',
            callCount: 2, stepCalls: 0, spentSteps: 0,
            inflight: { effectId: fx, kind: 'callModel', at },
          },
          [`effect:tab-${tab}`]: {
            effectId: fx, threadId: `tab-${tab}`, kind: 'callModel', at,
            deadline: Date.now() + 60_000, goal: g, table: t, history: { done: [], route: [] },
          },
        });
      },
      [id, closeTable, goal, effectId],
    );
  const guideKeyOf = async (id) =>
    await sw.evaluate(async (t) => (await chrome.storage.session.get(`guide:tab-${t}`))[`guide:tab-${t}`] ?? null, id);
  const recordGoals = async () =>
    await sw.evaluate(async () =>
      ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).map((r) => r.goal),
    );
  // How the run with this goal ended, as its Run record says — each outside
  // path below passes its own ending, and swapping two of them must show.
  const recordEnding = async (goal) =>
    await sw.evaluate(
      async (g) => ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).find((r) => r.goal === g)?.ending ?? null,
      goal,
    );

  // ---- 用户关掉浮层 ----
  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  await seedGuide(tabId, '关浮层', 'fx-overlay-closed');
  // 浮层上的「结束」按钮做的就是这一件事：content script 发 `SESSION_ENDED`
  // 并自己 teardown。闭合的 shadow root 让页面侧点不到那颗按钮，所以这里从标签
  // 页自己的隔离世界里发同一条消息——`sender.tab` 因此和真实路径完全一致。
  await sw.evaluate(async (id) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (sid) => chrome.runtime.sendMessage({ type: 'SESSION_ENDED', sessionId: sid, reason: 'user_closed' }),
      args: [`tab-${id}`],
    });
  }, tabId);
  await page.waitForTimeout(800);

  check('关掉浮层之后 Thread 的键不在了', (await guideKeyOf(tabId)) === null, JSON.stringify(await guideKeyOf(tabId))?.slice(0, 120));
  check(
    '关掉浮层之后这趟运行的摘要落了盘',
    (await recordGoals()).includes('关浮层'),
    JSON.stringify(await recordGoals()),
  );
  check('关掉浮层的那一趟，摘要记为「关浮层」', (await recordEnding('关浮层')) === 'overlay_closed', String(await recordEnding('关浮层')));
  check(
    '关掉浮层也把在途的模型调用中止掉——不是等它自己回来',
    (await watcher.evaluate(() => window.__aborts)).includes('fx-overlay-closed'),
    JSON.stringify(await watcher.evaluate(() => window.__aborts)),
  );

  // ---- 用户关掉标签页 ----
  const doomed = await ctx.newPage();
  await doomed.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  const doomedId = await sw.evaluate(async (keep) => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    return tabs.map((t) => t.id).find((id) => id !== keep) ?? null;
  }, tabId);
  check('开出了第二个标签页来关', doomedId !== null, `tabId=${doomedId}`);

  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  await seedGuide(doomedId, '关标签页', 'fx-tab-removed');
  await doomed.close();
  await page.waitForTimeout(900);

  check('关掉标签页之后 Thread 的键不在了', (await guideKeyOf(doomedId)) === null, JSON.stringify(await guideKeyOf(doomedId))?.slice(0, 120));
  check(
    '关掉标签页之后这趟运行的摘要落了盘',
    (await recordGoals()).includes('关标签页'),
    JSON.stringify(await recordGoals()),
  );
  check('关掉标签页的那一趟，摘要记为「关标签页」', (await recordEnding('关标签页')) === 'tab_closed', String(await recordEnding('关标签页')));
  check(
    '关掉标签页也把在途的模型调用中止掉',
    (await watcher.evaluate(() => window.__aborts)).includes('fx-tab-removed'),
    JSON.stringify(await watcher.evaluate(() => window.__aborts)),
  );

  // ---- 在一趟进行中的引导上再起一趟 ----
  // 新的开始也是旧那趟的结束：摘要要写，在途的调用要中止——而不是被原地覆盖。
  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  await seedGuide(tabId, '被新引导替换', 'fx-replaced');
  await watcher.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'POINT_AT',
        tabId: id,
        step: { descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '手挑的这一个' },
      }),
    tabId,
  );
  await page.waitForTimeout(900);
  check('在进行中的引导上再起一趟：旧那趟的摘要落了盘', (await recordGoals()).includes('被新引导替换'), JSON.stringify(await recordGoals()));
  check('被接替的那一趟，摘要记为「被新的一趟接替」', (await recordEnding('被新引导替换')) === 'superseded', String(await recordEnding('被新引导替换')));
  check(
    '在进行中的引导上再起一趟：旧那趟在途的调用被中止',
    (await watcher.evaluate(() => window.__aborts)).includes('fx-replaced'),
    JSON.stringify(await watcher.evaluate(() => window.__aborts)),
  );
  // 「指给我」不开线程：它只画一个框。所以旧那趟结束之后，这个标签页上不该再有
  // 任何线程——一个浮层一个主人，而这一次的主人是手挑的那个框。
  check('手挑的那一个接管了浮层，而且没有新线程留下', (await guideKeyOf(tabId)) === null, JSON.stringify(await guideKeyOf(tabId)));
  // 「结束引导」写摘要这一条，要有一趟真的在跑。以前顺手用的是上面 POINT_AT 起的
  // 那趟，而「指给我」已经不开线程了，所以这里自己种一趟。
  await seedGuide(tabId, '被用户结束', 'fx-user-ended');
  await watcher.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await page.waitForTimeout(300);
  check('点「结束引导」结束的那一趟，摘要记为「用户结束」', (await recordEnding('被用户结束')) === 'user_ended', String(await recordEnding('被用户结束')));

  await watcher.close();
  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
}

// ═══════════════════════════════════════════════════════════════════════════
// Skill（第一个 Plugin）：github 上发出去的模型请求里照旧带着站点技能那一段；
// 设置里关掉它，下一趟就不带；每一趟的 Run record 记下它开始时开着哪些 Plugin。
// github.com 由 ctx.route 接到一页本地夹具，零真实网络。
// ═══════════════════════════════════════════════════════════════════════════
{
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const GH_HTML =
    '<!doctype html><html><head><meta charset="utf-8"><title>n8n-io/n8n</title></head><body>' +
    '<h1>n8n-io/n8n</h1><nav><a href="/n8n-io/n8n/issues">Issues</a> <a href="/n8n-io/n8n/pulls">Pull requests</a></nav>' +
    '<main><button>Code</button></main></body></html>';
  await ctx.route('https://github.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: GH_HTML }),
  );
  const skillPanel = await ctx.newPage();
  await skillPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const gh = await ctx.newPage();
  await gh.goto('https://github.com/n8n-io/n8n', { waitUntil: 'load' });
  await gh.bringToFront();
  await gh.waitForTimeout(600);
  const ghTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://github.com/*' }))[0]?.id ?? null);
  check('github 的夹具页开出来了', ghTabId !== null, `tabId=${ghTabId}`);

  // Each run points at a step and is then ended by the user: a run that
  // pointed at nothing is a question, and leaves no record to read (08a).
  const bodies = [];
  modelHandler = async (route, body) => {
    bodies.push(body);
    await fulfillEnvelope(route, {
      intent: 'point', route: [{ at: '仓库页', goal: '进 Issues' }], ref: liveRef(body, 'link', 'Issues'), action: 'click', why: '从这里进',
    });
  };
  const userMessageOf = (body) => body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const startGuide = async (goal) => {
    const before = bodies.length;
    await skillPanel.evaluate(
      async ([id, g]) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: id, text: g }),
      [ghTabId, goal],
    );
    await waitUntil(() => bodies.length > before, 6000);
    // 记录只有在这一步真的落到线程上之后才会留下（指过步的才算一趟，没指过的
    // 是一次提问）。等那件事本身，而不是等一个够不够全看机器脸色的 400ms。
    await waitUntil(
      async () =>
        ((await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, ghTabId))?.history ?? [])
          .length > 0,
      6000,
    );
    await skillPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), ghTabId);
    await gh.waitForTimeout(200);
    return bodies[before];
  };

  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  const withSkill = userMessageOf(await startGuide('看看这个仓库的 issue'));
  check(
    'github 上发出去的模型请求照旧带着站点技能那一段（Skill 默认开）',
    withSkill.includes('关于这个站点，你需要知道：') && withSkill.includes('组织名/仓库名'),
    withSkill.slice(0, 160),
  );

  await sw.evaluate(async () => await chrome.storage.local.set({ 'plugin:skill': false }));
  const withoutSkill = userMessageOf(await startGuide('再看看这个仓库的 release'));
  check(
    '设置里关掉 Skill，下一趟的调用就不带那一段',
    withoutSkill.length > 0 && !withoutSkill.includes('关于这个站点'),
    withoutSkill.slice(0, 160),
  );

  // 一趟没指过任何一步就是一次提问（CONTEXT.md `Question`），而提问不留记录。
  // 所以这一条红的时候，先要分清是「Plugin 记错了」还是「那一趟压根没留下记录」。
  const records = await sw.evaluate(async () =>
    ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).map((r) => ({
      goal: String(r.goal ?? '').slice(0, 20),
      plugins: r.plugins,
      steps: (r.steps ?? r.history ?? []).length,
      ending: r.ending,
    })),
  );
  const plugins = records.map((r) => r.plugins);
  check(
    '每一趟的 Run record 记下了它开始时开着哪些 Plugin',
    JSON.stringify(plugins) === JSON.stringify([['skill'], []]),
    JSON.stringify(records),
  );
  // 这一段动过全局开关，走之前放回去：后面的段落默认它们是开着的。
  await sw.evaluate(async () => await chrome.storage.local.remove(['plugin:skill']));

  await sw.evaluate(async () => await chrome.storage.local.remove(['plugin:skill', 'run:records']));
  await ctx.unroute('https://github.com/**');
  await gh.close();
  await skillPanel.close();
}

await qaPanel.close();

// ═══════════════════════════════════════════════════════════════════════════
// 派出调用时一个侧栏都没开，或侧栏在调用途中被关掉（06c）
//
// 模型调用只能在侧栏里跑。派出时一个都没开，这次调用就记成没人跑：浮层卡片上
// 说一句、工具栏图标上加角标，告诉用户打开侧栏；侧栏一开，宿主把它原样重新派出。
// 侧栏在调用途中被关掉，那次调用随之死掉；下一次页面上有动静时，宿主查到认领它
// 的侧栏已经不在，同样处理。放在文件末尾，因为这里才能真的一个侧栏都不开。
// ═══════════════════════════════════════════════════════════════════════════
{
  const panelsOpen = async () =>
    await sw.evaluate(async () => (await chrome.runtime.getContexts({ documentUrls: [chrome.runtime.getURL('sidepanel.html')] })).length);
  const badge = async () => await sw.evaluate(async (id) => await chrome.action.getBadgeText({ tabId: id }), tabId);
  const waitingLine = async () => (await guideState())?.data?.waiting === true;
  const openPanel = async () => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    return p;
  };
  const changeHeading = async (text) => await page.evaluate((t) => void (document.querySelector('h1').textContent = t), text);
  const threadNow06c = async () =>
    await sw.evaluate(async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null, tabId);

  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  let hold = null;
  let points = 0;
  modelHandler = async (route, body) => {
    if (hold) {
      const held = hold;
      hold = null;
      await held.promise;
      await route.fulfill({ status: 500, body: 'its panel is gone' }).catch(() => {});
      return;
    }
    points++;
    const first = liveRef(body, 'button', 'Create instance');
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: '列表页', goal: `第 ${points} 步` }],
      ref: points % 2 === 1 ? first : otherRef(body, first),
      action: 'click',
      why: `第 ${points} 步`,
    });
  };

  // 起一趟引导（起引导要从侧栏发），画上第一步，然后关掉侧栏。
  const starter = await openPanel();
  await starter.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: id, text: '没有侧栏也要有下文' }), tabId);
  check('（前提）引导起来了，第一步在屏上', (await overlayStatus('shown', 5000)) === 'shown', await overlayStatus('shown', 0));
  await starter.close();
  await closeRelay(); // 取表用的那个中继页也是侧栏，这一段要求一个都不开
  check('（前提）此刻一个侧栏都没开', (await panelsOpen()) === 0, String(await panelsOpen()));

  // 一、页面变了，模型该被叫醒——可是没有侧栏能跑这次调用。
  const beforeNoPanel = requestLog.length;
  await changeHeading('Instances · 没有侧栏的时候变了');
  const told = await waitUntil(async () => (await waitingLine()) && (await badge()) === '!', 5000);
  check(
    '06c：派出时一个侧栏都没开 → 浮层卡片上说「打开侧栏」，图标上加角标',
    told && requestLog.length === beforeNoPanel,
    JSON.stringify({ waiting: await waitingLine(), badge: await badge(), requests: requestLog.length - beforeNoPanel }),
  );
  const unrun = await sw.evaluate(async (id) => (await chrome.storage.session.get(`effect:tab-${id}`))[`effect:tab-${id}`] ?? null, tabId);
  check('06c：这次调用还在，没人认领，也不会被当成超时', unrun !== null && unrun.claimedBy === undefined, JSON.stringify(unrun && { claimedBy: unrun.claimedBy }));

  // 用户打开侧栏：同一次调用重新派出，照样执行。
  const second = await openPanel();
  await waitUntil(() => requestLog.length > beforeNoPanel, 5000);
  const ranOnOpen = await waitUntil(async () => points >= 2 && (await threadNow06c())?.inflight === null, 5000);
  check(
    '06c：侧栏一打开，那次调用原样重新派出、照样执行，下一步画上了屏',
    requestLog.length === beforeNoPanel + 1 && ranOnOpen && (await overlayStatus('shown', 3000)) === 'shown',
    JSON.stringify({ requests: requestLog.length - beforeNoPanel, points, status: await overlayStatus('shown', 0) }),
  );
  check('06c：侧栏打开之后，那句话和角标都撤掉了', !(await waitingLine()) && (await badge()) === '', JSON.stringify({ waiting: await waitingLine(), badge: await badge() }));

  // 二、侧栏在调用途中被关掉：那次调用随之死掉。
  hold = deferred();
  const heldRelease = hold;
  const beforeClose = requestLog.length;
  await changeHeading('Instances · 侧栏还开着的时候变了');
  await waitUntil(() => requestLog.length > beforeClose, 5000);
  const claimed = await sw.evaluate(async (id) => (await chrome.storage.session.get(`effect:tab-${id}`))[`effect:tab-${id}`]?.claimedBy ?? null, tabId);
  check('（前提）侧栏认领了这次调用，请求已经发出', claimed !== null && requestLog.length === beforeClose + 1, String(claimed));
  await second.close();
  heldRelease.resolve();

  // 页面上又有了动静：宿主查到认领者已经不在，而此刻一个侧栏都没开。
  await changeHeading('Instances · 侧栏关掉之后又变了');
  const toldAgain = await waitUntil(async () => (await waitingLine()) && (await badge()) === '!', 5000);
  check('06c：侧栏在调用途中被关掉 → 下一次页面有动静时发现，告诉用户打开侧栏', toldAgain, JSON.stringify({ waiting: await waitingLine(), badge: await badge() }));

  const beforeThird = requestLog.length;
  const pointsBefore = points;
  const third = await openPanel();
  const ranAgain = await waitUntil(async () => points > pointsBefore && (await threadNow06c())?.inflight === null, 6000);
  check(
    '06c：再打开侧栏，那次死掉的调用重新派出、照样执行',
    ranAgain && requestLog.length >= beforeThird + 1 && !(await waitingLine()) && (await badge()) === '',
    JSON.stringify({ requests: requestLog.length - beforeThird, points: points - pointsBefore, waiting: await waitingLine(), badge: await badge() }),
  );

  await third.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await third.close();
  await changeHeading('Instances');
}

// ═══════════════════════════════════════════════════════════════════════════
// 对话（01 · 侧栏变成一段对话）
//
// 侧栏不再靠广播喂：它只拉取宿主写下的那一条对话。下面这几条验的就是这个性质
// 本身——错过消息、切走标签页、页面根本用不了、回答还没写完，都不该让界面停在
// 一个过去的状态上。旧的「正在想…」正是这样一个状态：一条被过滤掉的广播就让它
// 永远留在屏上。
// ═══════════════════════════════════════════════════════════════════════════
{
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    QA_BASE,
  );
  const convPanel = await ctx.newPage();
  await convPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(300);
  const convHost = async (msg) => await convPanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);
  const pendingNow = async (id = tabId) => (await viewOf(convPanel, id))?.pending?.kind ?? null;

  // ---- 引导跑到一半切去别的标签页，回答落在那一页上 ----
  const held = deferred();
  modelHandler = async (route, body) => {
    await held.promise;
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: '控制台', goal: '创建实例' }],
      ref: liveRef(body, 'button', 'Create instance'),
      action: 'click',
      why: '就是这个按钮',
    });
  };
  await convHost({ type: 'SAID', tabId, text: '帮我创建一个实例' });
  const thinking = await waitUntil(async () => (await pendingNow()) === 'thinking', 5000);
  check('对话：调用在途时的「在想」是从线程算出来的，不是侧栏自己记的标志位', thinking, await pendingNow());

  // 一个**无关**的标签页——用户自己按 Cmd+T 开的那一种，没有 opener。必须让
  // Chrome 这么记：`ctx.newPage()` 开出来的标签页会被记成「由当前页打开的」，
  // 那是另一回事（票 04：那一种引导会跟过去），这一段要的不是那个。
  const elsewhereTab = await sw.evaluate(
    async (url) => (await chrome.tabs.create({ url, active: true })).id,
    `http://127.0.0.1:${PORT}/?elsewhere`,
  );
  await page.waitForTimeout(600);
  held.resolve();
  await waitUntil(async () => (await overlayStatus('shown', 400)) === 'shown', 6000);
  await page.bringToFront();
  await page.waitForTimeout(700);

  await sw.evaluate(async (t) => await chrome.tabs.remove(t), elsewhereTab);
  const backView = await viewOf(convPanel);
  check(
    '对话：中途切去别的标签页、回答在那一边落地，切回来看到的是这条对话的现状（旧界面会永远停在「正在想…」）',
    backView?.pending?.kind === 'idle' && Boolean(backView?.step?.title),
    JSON.stringify({ pending: backView?.pending, step: backView?.step?.title }),
  );
  check(
    '对话：用户说的话与指出的那一步都在，按发生的顺序排',
    (backView?.conversation?.entries ?? []).map((e) => e.kind).join(',').includes('said,step'),
    JSON.stringify((backView?.conversation?.entries ?? []).map((e) => e.kind)),
  );


  await convHost({ type: 'END_GUIDE', tabId });
  const idleAfterEnd = await waitUntil(async () => (await pendingNow()) === 'idle', 4000);
  check('对话：结束引导之后回到就绪——取消是有下文的', idleAfterEnd, await pendingNow());

  // ---- 思考过程：一轮 observe 之后，那一步带着它 ----
  let seen = 0;
  modelHandler = async (route, body) => {
    seen++;
    if (seen === 1) return await fulfillEnvelope(route, { intent: 'observe', why: '正文应该还没加载出来' });
    await fulfillEnvelope(route, {
      intent: 'point',
      route: [{ at: '控制台', goal: '创建实例' }],
      ref: liveRef(body, 'button', 'Create instance'),
      action: 'click',
      why: '看过之后就是它',
    });
  };
  await convHost({ type: 'SAID', tabId, text: '先看一眼再指' });
  await waitUntil(async () => (await lastEntry('step', convPanel))?.detail === '看过之后就是它', 8000);
  const thought = await lastEntry('step', convPanel);
  check(
    '对话：这一步下面能展开它的思考过程——调了哪个工具、模型的理由、拿回了什么',
    (thought?.rounds ?? []).some((r) => r.tool === 'observe' && r.why === '正文应该还没加载出来' && String(r.got).includes('控件')),
    JSON.stringify(thought?.rounds),
  );
  check(
    '对话：这一轮花了多少也照实记着',
    (thought?.rounds ?? []).some((r) => (r.usage?.prompt ?? 0) > 0) || (thought?.usage?.prompt ?? 0) > 0,
    JSON.stringify({ rounds: (thought?.rounds ?? []).map((r) => r.usage), entry: thought?.usage }),
  );
  const drawn = await convPanel.evaluate(() => {
    const last = [...document.querySelectorAll('.entry.step')].at(-1);
    return {
      summary: last?.querySelector('details.thinking > summary')?.textContent ?? null,
      items: last?.querySelectorAll('details.thinking li').length ?? 0,
    };
  });
  check('对话：侧栏把它画成一个可下拉的块', String(drawn.summary).includes('思考过程') && drawn.items > 0, JSON.stringify(drawn));
  await convHost({ type: 'END_GUIDE', tabId });

  // ---- 内容脚本用不了的页面：说一句话，不停在「正在想」 ----
  const blockedTab = await ctx.newPage();
  await blockedTab.goto(`chrome-extension://${extId}/sidepanel.html?blocked=1`, { waitUntil: 'domcontentloaded' });
  // An extension page's own tab, asked from inside it: without the `tabs`
  // permission the worker cannot read the URL of a chrome-extension:// tab.
  const blockedId = await blockedTab.evaluate(async () => (await chrome.tabs.getCurrent())?.id ?? null);
  check('（前提）找得到那个用不了的标签页', typeof blockedId === 'number', String(blockedId));
  await convHost({ type: 'SAID', tabId: blockedId, text: '带我做点什么' });
  await page.waitForTimeout(700);
  const blockedView = await viewOf(convPanel, blockedId);
  const blockedNote = (blockedView?.conversation?.entries ?? []).filter((e) => e.kind === 'note').at(-1);
  check(
    '对话：内容脚本用不了的页面上说一句「这个页面上用不了」，而不是静默失败',
    Boolean(blockedNote) && String(blockedNote?.text).includes('用不了') && blockedView?.pending?.kind === 'idle',
    JSON.stringify({ note: blockedNote?.text, pending: blockedView?.pending }),
  );
  await blockedTab.close();
  // The panel follows the active tab; closing one moves it. Back to the page
  // this section is about before asking what the panel shows.
  await page.bringToFront();
  await page.waitForTimeout(400);

  // ---- 流式：还在写的时候，已经写出来的那一截就看得见 ----
  //
  // 拦截先撤掉：这一条要的是真的一段一段到达，而 Playwright 的路由会把响应
  // 攒齐再给——流式在那种情况下根本不存在。这是本文件最后一段，撤了不影响谁。
  await ctx.unrouteAll();
  await sw.evaluate(
    async (base) =>
      await chrome.storage.local.set({
        provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
      }),
    `http://127.0.0.1:${PORT}/slow-model/v1`,
  );
  await convHost({ type: 'SAID', tabId, text: '这一页是做什么的（慢慢答）？' });
  // Whichever open panel claimed this call is the one streaming it; the draft
  // is that panel's own, by design (the host's entry is the record).
  // Read outright, never through a locator: a locator waits out its full
  // timeout when the element is not there, and polling that way is what held
  // this stream open long enough to hit the endpoint's stall timeout.
  const draftOnAnyPanel = async () => {
    const panels = ctx.pages().filter((p) => p.url().includes('/sidepanel.html'));
    const texts = await Promise.all(
      panels.map((p) => p.evaluate(() => document.querySelector('.entry.working')?.innerText ?? '').catch(() => '')),
    );
    return texts.join(' | ');
  };
  const draftSeen = await waitUntil(async () => (await draftOnAnyPanel()).includes('先写出来的这半句'), 8000);
  check(
    '对话：回答边生成边显示——还没写完的那一截已经在屏上',
    draftSeen,
    JSON.stringify({ 端点被访问: slowModelHits, 屏上: await draftOnAnyPanel(), 此刻: await pendingNow() }),
  );
  finishSlowAnswer();
  await waitForEntry('answer', '后写的那半句', 8000, convPanel);
  const landed = await lastEntry('answer', convPanel);
  check(
    '对话：落定以宿主写下的那一条为准，草稿被它替掉',
    landed?.text === '先写出来的这半句，和后写的那半句。' && (await pendingNow()) === 'idle',
    JSON.stringify({ text: landed?.text, pending: await pendingNow() }),
  );

  await convHost({ type: 'END_GUIDE', tabId });

  // ---- 认领这次调用的侧栏没了：屏上还没有任何一步，页面产生不了读数 ----
  //
  // 真机上卡住的就是这一种：认领者消失（关掉侧栏、换窗口时文档被销毁），结果
  // 永远回不来；而清扫只在「收到消息」时做，读数又要求屏上已经有一步——第一次
  // 调用还没回来时屏上空着，于是页面放着不动就再也不会有任何消息。侧栏只剩
  // 「正在想」，而且永远不会自己好。
  //
  // 认领是一场竞争，所以认领的那一刻必须只有一个侧栏开着——否则这一段什么都
  // 证明不了。
  // Every panel, not just this block's: any one still open from an earlier
  // section would claim the call and there would be no orphan to test.
  for (const p of ctx.pages().filter((p) => p.url().includes('/sidepanel.html'))) await p.close();
  {
    // Back to the stubbed endpoint this file logs: the streaming check above
    // pointed the model somewhere else and dropped every route with it.
    await ctx.route(`${QA_BASE}/chat/completions`, async (route) => {
      const body = route.request().postDataJSON();
      requestLog.push({ body, at: Date.now() });
      await modelHandler(route, body);
    });
    await sw.evaluate(
      async (base) =>
        await chrome.storage.local.set({
          provider: { preset: 'custom', baseURL: base, model: 'stub-model', apiKey: 'sk-e2e-stub', contextWindow: 32_000 },
        }),
      QA_BASE,
    );
    const held = deferred();
    modelHandler = async () => await held.promise; // 这次调用永远不回答
    const doomed = await ctx.newPage();
    await doomed.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForTimeout(400);
    const beforeAsk = requestLog.length;
    const saidOk = await doomed.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text: '这一趟的调用会变成孤儿' }), tabId);
    await waitUntil(() => requestLog.length > beforeAsk, 8000);
    const claimant = await sw.evaluate(async (id) => (await chrome.storage.session.get(`effect:tab-${id}`))[`effect:tab-${id}`]?.claimedBy ?? null, tabId);
    const onlyPanel = ctx.pages().filter((p) => p.url().includes('/sidepanel.html')).length;
    check(
      '（前提）认领的那一刻只有一个侧栏开着，认领者就是它',
      Boolean(claimant) && onlyPanel === 1,
      JSON.stringify({
        侧栏数: onlyPanel,
        认领者: Boolean(claimant),
        请求数: requestLog.length - beforeAsk,
        SAID的回答: saidOk,
        最后两条: (await viewOf(doomed))?.conversation?.entries?.slice(-2).map((e) => `${e.kind}:${String(e.text).slice(0, 30)}`),
        线程: await sw.evaluate(async (id) => {
          const t = (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null;
          return t && { inflight: t.inflight?.kind ?? null, calls: t.callCount };
        }, tabId),
      }),
    );

    const keeper = await ctx.newPage(); // 另一个窗口里的侧栏，开着但什么都没做
    await keeper.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForTimeout(400);
    await doomed.close(); // 认领者消失
    await page.waitForTimeout(500);

    // 用户就这么看着：这里**不替它拉取**，只看它的界面——证明侧栏自己会把这件
    // 事推动下去，而不是靠测试代劳。
    const rerun = await waitUntil(async () => requestLog.length > beforeAsk + 1, 12_000);
    check(
      '孤儿调用：认领它的侧栏没了、屏上又没有一步时，侧栏的一次拉取就把它重新派出去跑（不再永远停在「正在想」）',
      rerun,
      JSON.stringify({ 调用数: requestLog.length - beforeAsk, 屏上: await keeper.evaluate(() => document.querySelector('.entry.working, .entry.note')?.innerText?.slice(0, 30) ?? '(空)') }),
    );
    const claimedNow = async () =>
      await sw.evaluate(async (id) => (await chrome.storage.session.get(`effect:tab-${id}`))[`effect:tab-${id}`]?.claimedBy ?? null, tabId);
    const keptBy = await claimedNow();
    check('孤儿调用：重新认领它的是另一个侧栏', Boolean(keptBy) && keptBy !== claimant, JSON.stringify({ 换了认领者: keptBy !== claimant }));

    // 而「它还活着」是端口说了算的——真侧栏的消息不带任何 documentId，宿主没
    // 法从消息的来路认人（票 03）。所以这里验的是那条端口：把这个侧栏也关掉，
    // 宿主应当立刻不再把它当认领者，于是这次调用又一次被交还出去。
    const beforeHandBack = requestLog.length;
    await keeper.close();
    const third = await ctx.newPage();
    await third.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    const handedBack = await waitUntil(async () => requestLog.length > beforeHandBack && (await claimedNow()) !== keptBy, 12_000);
    check(
      '孤儿调用：认领者的端口断了，宿主就知道它没了——这次调用再一次交到还开着的那个侧栏手里',
      handedBack,
      JSON.stringify({ 新认领者: (await claimedNow()) !== keptBy, 又派出了几次: requestLog.length - beforeHandBack }),
    );

    held.resolve();
    await third.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: t }), tabId);
    await third.close();
  }
}

// ---- 点出一个新标签页：引导跟着人走（票 04） ----
//
// 页面内跳转早就是好的（`tabs.onUpdated` 送一条读数进去）。新标签页不是：线程、
// 对话、浮层全按 tabId 存，新标签页是新的 id，于是这一趟被搁浅在用户已经离开的那
// 一页上，指着他刚刚用过的那个控件，而他正看着的那一页什么都没有。
//
// 这里用 `chrome.tabs.create({openerTabId})` 造这个局面：用户 cmd+click 一个
// target=_blank 的链接，Chrome 给出的就是这么一个标签页（后台的那一种），改成
// active 就是他切过去的那一刻。测试在驱动浏览器，不是在驱动扩展。
{
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(300);

  const threadAt = async (id) =>
    await sw.evaluate(async (t) => (await chrome.storage.session.get(`guide:tab-${t}`))[`guide:tab-${t}`] ?? null, id);

  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, {
      intent: 'point', route: [{ at: '这一页', goal: '去另一页' }], ref: otherRef(body, ''), action: 'click', why: '先到另一页（04）',
    });
  await panel.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text: '带我去另一页（04）' }), tabId);
  const onA = await waitForEntry('step', '', 8000, panel);
  check('（前提）引导在原来那个标签页上走起来了', onA && Boolean(await threadAt(tabId)), JSON.stringify({ 有一步: onA }));

  // 后台开出来的那一个：人没过去，引导就不该跑过去。
  const B = await sw.evaluate(
    async ([opener, url]) => (await chrome.tabs.create({ url, openerTabId: opener, active: false })).id,
    [tabId, `http://127.0.0.1:${PORT}/opened-in-a-new-tab`],
  );
  await page.waitForTimeout(900);
  check(
    '新标签页在后台开着、人还在原页 → 引导一动不动',
    Boolean(await threadAt(tabId)) && (await threadAt(B)) === null,
    JSON.stringify({ 原页还有引导: Boolean(await threadAt(tabId)), 新页有引导: Boolean(await threadAt(B)) }),
  );

  // 人切过去了。
  const held = deferred();
  modelHandler = async (route) => {
    await held.promise;
    await fulfillEnvelope(route, { intent: 'done', why: '你要的东西已经在这一页上了（04）' });
  };
  const beforeMove = requestLog.length;
  await sw.evaluate(async (b) => await chrome.tabs.update(b, { active: true }), B);
  const moved = await waitUntil(async () => Boolean(await threadAt(B)), 8000);
  check(
    '点出来的新标签页被切过去 → 这一趟整个搬了过来，原页上不再留着它',
    moved && (await threadAt(tabId)) === null,
    JSON.stringify({ 新页有引导: moved, 原页还有引导: Boolean(await threadAt(tabId)) }),
  );
  // 线程先搬，对话紧随其后，再往下才是读页面、问模型——都在同一个异步链里。
  // 等到线程就断言，等于在链条中间取样：这一条本来就该等对话到位。
  await waitUntil(async () => ((await viewOf(panel, B))?.conversation?.entries ?? []).length > 0, 8000);
  const carried = ((await viewOf(panel, B))?.conversation?.entries ?? []).map((e) => `${e.kind}:${String(e.text).slice(0, 12)}`);
  check(
    '对话跟着搬：用户说过的话和指过的那一步，在新标签页上原样都在',
    carried.some((e) => e.startsWith('said:带我去另一页')) && carried.some((e) => e.startsWith('step:')),
    JSON.stringify(carried),
  );
  const leftBehind = ((await viewOf(panel, tabId))?.conversation?.entries ?? []).at(-1);
  check(
    '原来那个标签页留下一句说明，而不是一片空白',
    leftBehind?.kind === 'note' && String(leftBehind.text).includes('新标签页'),
    JSON.stringify(leftBehind),
  );
  check('原来那一页上的高亮撤掉了', (await guideState())?.data?.visible === false, JSON.stringify((await guideState())?.data));
  const askedOnB = await waitUntil(async () => requestLog.length > beforeMove, 8000);
  check(
    '搬过去之后照常走下一步：新的这一页被读了、又去问了模型',
    askedOnB,
    JSON.stringify({ 搬家后又问了几次: requestLog.length - beforeMove }),
  );

  held.resolve();
  const ended = await waitUntil(async () => (await threadAt(B)) === null, 8000);
  check('新标签页上收尾：说到了，这一趟就在这里结束', ended, JSON.stringify({ 还有引导: Boolean(await threadAt(B)) }));

  // 真实世界里最常见的那一种：点一个 target=_blank 的链接，Chrome 当场就把新标
  // 签页推到你面前——而那一刻它还在加载，连地址都还没有。上面那条走的是「后来
  // 才切过去」，这条走的是「一开出来就在眼前」，两条是不同的代码路径。
  modelHandler = async (route, body) =>
    await fulfillEnvelope(route, {
      intent: 'point', route: [{ at: '这一页', goal: '再去一页' }], ref: otherRef(body, ''), action: 'click', why: '再到下一页（04）',
    });
  await panel.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text: '再带我去一页（04）' }), B);
  const onB = await waitForEntry('step', '', 8000, panel, B);
  const held2 = deferred();
  modelHandler = async (route) => {
    await held2.promise;
    await fulfillEnvelope(route, { intent: 'done', why: '到了（04）' });
  };
  const C = await sw.evaluate(
    async ([opener, url]) => (await chrome.tabs.create({ url, openerTabId: opener, active: true })).id,
    [B, `http://127.0.0.1:${PORT}/opened-and-focused`],
  );
  const followed = await waitUntil(async () => Boolean(await threadAt(C)), 8000);
  check(
    '点开就在眼前的新标签页（那一刻它还在加载、连地址都没有）→ 等它落地，这一趟照样跟过来',
    onB && followed && (await threadAt(B)) === null,
    JSON.stringify({
      前提_B上有一步: onB,
      C上有引导: followed,
      B上还有引导: Boolean(await threadAt(B)),
      // 两个都没有的时候，唯一有用的问题是：那它到底在哪？
      此刻哪些标签页上有引导: await sw.evaluate(async () =>
        Object.keys(await chrome.storage.session.get(null))
          .filter((k) => k.startsWith('guide:'))
          .join(','),
      ),
    }),
  );
  held2.resolve();
  await waitUntil(async () => (await threadAt(C)) === null, 8000);
  for (const t of [B, C]) await sw.evaluate(async (x) => await chrome.tabs.remove(x), t);
  await panel.close();
}

// 上文（票 04）：一次问答落地就结束这一趟，所以第二句话是另一趟运行。它能不能
// 看见第一轮说了什么，决定了「这些产品」这类指代解不解得开。
{
  const ctxPanel = await ctx.newPage();
  await ctxPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(300);
  const ask = async (text) => await ctxPanel.evaluate(async ([t, x]) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text: x }), [tabId, text]);

  modelHandler = async (route) => await fulfillEnvelope(route, { intent: 'explain', answer: '这一页上有实例列表和创建入口。', refs: [] });
  await ask('这一页上有什么？');
  await waitForEntry('answer', '实例列表和创建入口', 8000, ctxPanel);

  const beforeSecond = requestLog.length;
  await ask('那我要怎么打开看到这些东西呢');
  await waitUntil(() => requestLog.length > beforeSecond, 8000);
  const second = userText(requestLog.at(-1).body);
  check(
    '第二句话能看见第一轮说过什么——两边的原话都带上了',
    second.includes('这条对话在这之前说过的话') && second.includes('用户：这一页上有什么？') && second.includes('你：这一页上有实例列表和创建入口。'),
    JSON.stringify(second.match(/这条对话在这之前说过的话[^]*?(?=\n\n)/)?.[0] ?? null),
  );
  check(
    '这一趟自己那句话不在上文里——消息末尾已经写着它了',
    (second.match(/那我要怎么打开看到这些东西呢/g) ?? []).length === 1,
    JSON.stringify((second.match(/那我要怎么打开看到这些东西呢/g) ?? []).length),
  );
  await ctxPanel.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: t }), tabId);
  await ctxPanel.close();
}

// 记忆那一整段随 Memory 一起删了（CONTEXT.md 的词条写了为什么）：它的入库判据是
// 「模型说 done」而不是「用户说到了」，实测只有 71% 准；取的是这个站最近三条、
// 不看目标；默认开着；而它的效果一次都没被量过。

// 上限（票 04）：这一整套跑下来，这条对话已经很长了。侧栏在有事情进行时每两秒
// 拉一次整个视图，所以一次拉取带多少，是「对话长度 × 用户看了多久」。不删东西，
// 只带尾巴，并说清更早还有多少。
{
  const capPanel = await ctx.newPage();
  await capPanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const stored = await sw.evaluate(async (id) => {
    const k = `conv:tab-${id}`;
    return ((await chrome.storage.session.get(k))[k]?.entries ?? []).length;
  }, tabId);
  const v = await viewOf(capPanel);
  check(
    '一次拉取只带对话的尾巴，更早的说清有多少（存着，没删）',
    stored > 80 ? v.conversation.entries.length === 80 && v.earlier === stored - 80 : v.conversation.entries.length === stored && !v.earlier,
    JSON.stringify({ 存着: stored, 这次带了: v.conversation.entries.length, 更早还有: v.earlier ?? 0 }),
  );
  await capPanel.close();
}

// 而它真的到了模型眼前：这一趟里发出去的请求，用户消息上就写着那一行。
//
// 层二之后那一行换了内容：账单组件已经被读进来，它不再是「看不到」的洞，而是
// 一句「另有 N 个嵌入框架已经读进来了，ref 以 f 开头」。两句都算数——第一句在
// 进不去的框架上仍然会出现——但至少要有一句，否则框架这件事又对模型静默了。
check(
  '嵌入框架这件事写进了发给模型的那份元素表（看不到的说看不到，读进来的说 ref 长什么样）',
  requestLog.some((r) => /frames(-read)? /.test(userText(r.body))),
  JSON.stringify(requestLog.map((r) => userText(r.body)).find((t) => /frames(-read)? /.test(t))?.match(/frames[^\n]*/)?.[0] ?? null),
);

await sw.evaluate(async () => await chrome.storage.local.remove('provider'));

await ctx.close();
server.close();
fs.rmSync(udd, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
