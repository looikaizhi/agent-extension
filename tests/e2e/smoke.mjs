/**
 * End-to-end smoke test against a real MV3 install.
 *
 * Chrome for Testing still honours --load-extension; branded Chrome 137+ does
 * not. Verified empirically — see V-7 in step1-implementation-plan.md.
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
const server = http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
 * content script's match patterns (manifest.mjs:197-201). That escalation was
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
      return await chrome.tabs.sendMessage(id, { type: 'PING' });
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'PING' }),
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
    await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget }),
  [tabId, { maxNodes: 150, viewportBands: 1 }],
);
let table = ex?.data;
check('EXTRACT 返回投影表', ex?.ok === true && Array.isArray(table?.items), `${table?.items?.length} 个控件`);

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
const command = (step, extra = {}) => ({
  sessionId: 'e2e',
  snapshotId: table?.snapshotId,
  mode: 'guide',
  progress: { index: 0, total: 1 },
  autoScroll: false,
  step,
  ...extra,
});

const hl = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        expectedUserAction: 'click',
        title: '创建实例',
        detail: '点击这里创建一个新实例。',
        confidence: 1,
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
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
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }),
  [
    tabId,
    command({
      ref: pw?.ref,
      descriptor: { role: 'textbox', name: 'Password' },
      expectedUserAction: 'input',
      title: '输入密码',
      confidence: 1,
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
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        expectedUserAction: 'click',
        title: 'x',
        confidence: 1,
      },
      { snapshotId: 'not-a-real-snapshot' },
    ),
  ],
);
// Task 8 flipped this: a stale handle is no longer a refusal, it is the trigger
// for rebinding from the descriptor. Refusing was the old behaviour and it is
// what made every multi-step pack die the moment the page changed.
check(
  '过期快照触发按 descriptor 重绑（F-8）',
  stale?.ok === true && !stale?.data?.failure && stale?.data?.resolved,
  `resolved=${stale?.data?.resolved} failure=${stale?.data?.failure}`,
);

// `alsoRefs` carry no descriptor, so they genuinely cannot be recovered.
const staleAlso = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }),
  [
    tabId,
    command(
      {
        ref: create?.ref,
        descriptor: { role: 'button', name: 'Create instance' },
        alsoRefs: [create?.ref],
        expectedUserAction: 'click',
        title: 'x',
        confidence: 1,
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
const refresh = async () => {
  const r = await sw.evaluate(
    async ([id, budget]) =>
      await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget }),
    [tabId, { maxNodes: 150, viewportBands: 1 }],
  );
  table = r?.data;
  return table;
};

const highlight = async (cmd) =>
  await sw.evaluate(
    async ([id, c]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: c }),
    [tabId, cmd],
  );

const planFor = (step) => command(step);

const createStep = {
  ref: create?.ref,
  descriptor: { role: 'button', name: 'Create instance' },
  expectedUserAction: 'click',
  title: '创建实例',
  confidence: 1,
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
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
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
    return await chrome.tabs.sendMessage(id, { type: 'EXECUTE', ref: 'e1' });
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'PING' }),
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
    confidence: 0,
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
const overlayStatus = async (want, ms = 2000) => {
  const until = Date.now() + ms;
  let last;
  do {
    const s = await sw.evaluate(
      async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
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
    confidence: 0,
  }),
);
check(
  '页面上确实没有的目标走单一失败通道',
  unbound?.ok === true && unbound?.data?.failure === 'ref_not_found',
  unbound?.data?.failure,
);

// ---- F-8: a step that never carried a ref binds at render time ----
const descOnly = await highlight(
  command({
    descriptor: { role: 'button', name: 'Create instance' },
    expectedUserAction: 'click',
    title: '只有 descriptor 的步骤',
    confidence: 1,
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
    confidence: 1,
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

  // Step 1's target does not exist; step 2's does. The lost screen comes up —
  // and its buttons have to work, because that screen is the *only* thing the
  // user can act on at that moment.
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'START_GUIDE',
        tabId: id,
        steps: [
          { descriptor: { role: 'button', name: 'Nonexistent target' }, expectedUserAction: 'click', title: '第一步', confidence: 1 },
          { descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '第二步', confidence: 1 },
        ],
      }),
    tabId,
  );
  await page.waitForTimeout(900);
  check('目标不存在时进入失效屏', (await overlayStatus('lost')) === 'lost');

  const states = (await obs.evaluate(() => window.__ev)).filter((m) => m.type === 'GUIDE_STATE');
  check(
    '失效时上报的仍是真实进度，而不是 0/0',
    states.every((s) => s.total === 2),
    JSON.stringify(states.map((s) => `${s.index + 1}/${s.total}`)),
  );

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

  // The whole card accepts pointer events, so hit-testing cannot separate one
  // button from another. Sweep the button row instead: 重试定位 emits nothing,
  // so the first event that arrives can only have come from 跳过此步.
  let skipped = [];
  outer: for (let y = box.maxY - 4; y > box.maxY - 40; y -= 6) {
    for (let x = box.minX + 16; x < box.maxX - 8; x += 10) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(60);
      skipped = (await obs.evaluate(() => window.__ev)).filter((m) => m.type === 'STEP_SKIPPED');
      if (skipped.length) break outer;
    }
  }
  await page.waitForTimeout(600);
  check(
    '失效屏上的按钮真的能推进流程',
    skipped.length > 0,
    skipped.length ? `收到 STEP_SKIPPED` : '按钮是死的：浮层显示着一步，content script 却不记得它',
  );
  check('跳过之后走到了第 2 步并成功高亮', (await overlayStatus('shown')) === 'shown');

  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
}

// ---- 用户做了我们要求的事，引导必须自己往前走 ----
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await obs.evaluate(() => {
    window.__ev = [];
    chrome.runtime.onMessage.addListener((m) => window.__ev.push(m));
  });
  await page.bringToFront();
  await page.evaluate(() => window.scrollTo(0, 0));

  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'START_GUIDE',
        tabId: id,
        steps: [
          { descriptor: { role: 'button', name: 'Help' }, expectedUserAction: 'click', title: '点 Help', confidence: 1 },
          { descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '再点创建', confidence: 1 },
        ],
      }),
    tabId,
  );
  await page.waitForTimeout(700);
  check('第 1 步已高亮', (await overlayStatus('shown')) === 'shown');

  // The user does exactly what the card asked. Nothing about the guide's own
  // buttons is touched.
  await page.click('#nav-help');
  await page.waitForTimeout(900);
  const confirmed = (await obs.evaluate(() => window.__ev)).filter((m) => m.type === 'STEP_CONFIRMED');
  check(
    '点击目标本身即视为完成该步',
    confirmed.length > 0,
    confirmed.length ? '收到 STEP_CONFIRMED' : '用户照做了，引导却一动不动',
  );
  const after = await sw.evaluate(async (id) => {
    const k = `thread:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check('并且推进到了第 2 步', after?.cursor === 1, `cursor=${after?.cursor}`);

  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
}

// ---- 失效屏必须继续盯着页面：目标出现了就自己接上 ----
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'START_GUIDE',
        tabId: id,
        steps: [
          { descriptor: { role: 'button', name: 'Appears later' }, expectedUserAction: 'click', title: '稍后出现', confidence: 1 },
        ],
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
    '失效屏是静态的：页面变了也不会重新尝试',
  );

  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
  await page.evaluate(() => [...document.querySelectorAll('main > button')].filter((b) => b.textContent === 'Appears later').forEach((b) => b.remove()));
}

// ---- 视口之外的目标必须能被找到，而不是「请先滚动过去」 ----
{
  const obs = await ctx.newPage();
  await obs.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.evaluate(() => window.scrollTo(0, 0));
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: 'Far below the fold' }),
    tabId,
  );
  await page.waitForTimeout(900);
  check(
    '页面顶部时也能定位到 1400px 以下的目标',
    (await overlayStatus('shown')) === 'shown',
    '视口带剪枝不该让本地匹配看不见整页',
  );
  await obs.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await obs.close();
  await page.evaluate(() => window.scrollTo(0, 0));
}

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
      await chrome.tabs.sendMessage(id, {
        type: 'EXTRACT',
        profile: 'interactive',
        budget: { maxNodes: 150, viewportBands: 1 },
      }),
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
    const r = await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 5, viewportBands: 1 } });
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
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);

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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'INSPECT', on: true }),
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
  tabId,
);
check('检视模式下悬停即描边', hoverOutline?.data?.visible === true, `status=${hoverOutline?.data?.status}`);

await page.mouse.click(stopBox.x, stopBox.y);
await page.waitForTimeout(300);
check('选中后描边撤掉', (await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
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
check('产出可粘贴的引导包片段', typeof pick?.yaml === 'string' && pick.yaml.includes('role: button'));

// And the descriptor must actually point back at the element that was clicked.
const roundTrip = await highlight(
  command({
    descriptor: pick?.descriptor,
    expectedUserAction: 'click',
    title: '回绑检视产物',
    confidence: 1,
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'INSPECT', on: true }),
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
await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
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
const guideState = async () =>
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }), tabId);

await host({ type: 'END_GUIDE', tabId });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(600);

const crossPage = [
  {
    descriptor: { role: 'link', name: 'Docs' },
    expectedUserAction: 'click',
    title: '打开开发文档',
    detail: '点击导航栏里的 Docs。',
    confidence: 1,
  },
  {
    // This target is on the *next* page. No snapshot taken now contains it, so
    // no caller could have produced a ref for it — only a descriptor.
    descriptor: { role: 'button', name: 'API Reference' },
    expectedUserAction: 'click',
    title: '打开 API 参考',
    confidence: 1,
  },
];

const started = await host({ type: 'START_GUIDE', tabId, steps: crossPage });
await page.waitForTimeout(400);
check('宿主启动跨页引导并渲染第 1 步', started?.ok === true, JSON.stringify(started));

const panelClosed = await sw.evaluate(async (id) => {
  const k = `thread:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check(
  '线程落在 storage.session，键为 thread:{sessionId}',
  panelClosed?.steps?.length === 2 && panelClosed.cursor === 0,
  `cursor=${panelClosed?.cursor} steps=${panelClosed?.steps?.length}`,
);

// Close the side panel *before* navigating. Nothing is left holding the flow
// except the host — which is the entire claim being tested here.
await panel.close();
await page.bringToFront();

// The user clicks the thing we pointed at. The page navigates, the content
// script dies, and nothing in the page remembers there was a guide.
await page.click('nav a[href="/docs"]');
await page.waitForLoadState('load');
await page.waitForTimeout(1200);

const afterNav = await guideState();
check(
  '侧栏已关闭 + 整页导航，引导仍自动恢复并前进（任务 11）',
  afterNav?.data?.visible === true && afterNav?.data?.status === 'shown',
  `status=${afterNav?.data?.status} visible=${afterNav?.data?.visible}`,
);
const flowAfter = await sw.evaluate(async (id) => {
  const k = `thread:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('游标前进到第 2 步', flowAfter?.cursor === 1, `cursor=${flowAfter?.cursor}`);

const rectOnDocs = await page.evaluate(() => {
  const b = document.getElementById('api-ref');
  const r = b.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
});
check(
  '高亮的确实是新页面上的 API Reference',
  JSON.stringify(afterNav?.data?.rect) === JSON.stringify(rectOnDocs),
  `overlay=${JSON.stringify(afterNav?.data?.rect)} target=${JSON.stringify(rectOnDocs)}`,
);

// A plain reload is not progress: the same step must come back, not the next one.
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);
const afterReload = await sw.evaluate(async (id) => {
  const k = `thread:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('同一 URL 刷新不算前进，游标不动', afterReload?.cursor === 1, `cursor=${afterReload?.cursor}`);
check('刷新后浮层重新出现', (await guideState())?.data?.visible === true);

// Finishing the last step ends the session and clears the record.
// ---- 任务 10：词法基线的并列不许被静默解决 ----
// The cross-page block left the tab on /docs, which has no Stop buttons at all.
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(500);
const panelB = await ctx.newPage();
await panelB.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
await panelB.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: 'stop' }),
  tabId,
);
await page.waitForTimeout(600);
const tie = await overlayStatus('ambiguous');
check(
  '「stop」并列命中两个同名按钮：全部框出，不挑（K-6）',
  tie === 'ambiguous',
  `status=${tie}`,
);

await panelB.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: 'create instance' }),
  tabId,
);
await page.waitForTimeout(600);
check('明确胜出时仍然是单目标聚光', (await overlayStatus('shown')) === 'shown');
await panelB.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }),
  tabId,
);
await panelB.close();

// ---- the speculative advance must be able to step back ----
// "The user navigated" is not proof of "the user did what we asked". Go to a
// page where step 2's target does not exist and the host must return the user
// to step 1 rather than stranding them on a step it cannot point at.
const panelA = await ctx.newPage();
await panelA.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
await panelA.evaluate(
  async ([id, steps]) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, steps }),
  [tabId, crossPage],
);
await page.waitForTimeout(400);

await page.goto(`http://127.0.0.1:${PORT}/billing`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const backtracked = await sw.evaluate(async (id) => {
  const k = `thread:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check(
  '推测前进失败后退回上一步，而不是把用户丢在找不到的目标上',
  backtracked?.cursor === 0 && backtracked?.speculative === false,
  `cursor=${backtracked?.cursor} speculative=${backtracked?.speculative}`,
);
check('退回之后浮层指向的是第 1 步的目标', (await guideState())?.data?.visible === true);

// ---- the goal path runs through the host, not the panel ----
await panelA.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }),
  tabId,
);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(600);
const asked = await panelA.evaluate(
  async (id) =>
    await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: 'create instance' }),
  tabId,
);
await page.waitForTimeout(600);
check(
  '侧栏只说目标，宿主跑完解析并渲染（任务 9）',
  asked?.ok === true && (await guideState())?.data?.visible === true,
  JSON.stringify(asked),
);
await panelA.close();

const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await panel2.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
await page.waitForTimeout(300);
const flowCleared = await sw.evaluate(async (id) => {
  const k = `thread:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('结束引导后记录被清除', flowCleared === null);
check('结束引导后浮层消失', (await guideState())?.data?.visible === false);

await ctx.close();
server.close();
fs.rmSync(udd, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
