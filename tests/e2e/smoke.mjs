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
  [tabId, { maxNodes: 400 }],
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
    [tabId, { maxNodes: 400 }],
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
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }), tabId);

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

  // Step 1's target does not exist; step 2's does. The lost screen comes up —
  // and its buttons have to work, because that screen is the *only* thing the
  // user can act on at that moment.
  await obs.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'START_GUIDE',
        tabId: id,
        goal: '跟着这几步走',
        steps: [
          { descriptor: { role: 'button', name: 'Nonexistent target' }, expectedUserAction: 'click', title: '第一步' },
          { descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '第二步' },
        ],
      }),
    tabId,
  );
  await page.waitForTimeout(900);
  check('目标不存在时进入失效屏', (await overlayStatus('lost')) === 'lost');
  check('固定计划的浮层提供「跳过」——点了真的会去下一步', (await guideState())?.data?.canSkip === true);

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
        goal: '跟着这几步走',
        steps: [
          { descriptor: { role: 'button', name: 'Help' }, expectedUserAction: 'click', title: '点 Help' },
          { descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '再点创建' },
        ],
      }),
    tabId,
  );
  await page.waitForTimeout(700);
  check('第 1 步已高亮', (await overlayStatus('shown')) === 'shown');

  // The user does exactly what the card asked. Nothing about the guide's own
  // buttons is touched.
  await page.click('#nav-help');
  // A click that does not move the page advances a fixed plan when the settle
  // window closes (~1.4s): only then is "it did not navigate" known.
  await page.waitForTimeout(2500);
  const confirmed = (await obs.evaluate(() => window.__ev)).filter((m) => m.type === 'STEP_CONFIRMED');
  check(
    '点击目标本身即视为完成该步',
    confirmed.length > 0,
    confirmed.length ? '收到 STEP_CONFIRMED' : '用户照做了，引导却一动不动',
  );
  const after = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
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
        goal: '跟着这几步走',
        steps: [
          { descriptor: { role: 'button', name: 'Appears later' }, expectedUserAction: 'click', title: '稍后出现' },
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
      await chrome.tabs.sendMessage(id, {
        type: 'EXTRACT',
        profile: 'interactive',
        budget: { maxNodes: 400 },
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
    const r = await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 5 } });
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

// Anchor: default (or unset) `contextWindow` must reproduce exactly what the
// hardcoded `PANEL_EXTRACT_CONTEXT_WINDOW = 32_000` produced before this
// change — `budgetFor(32000).maxNodes === 400` is independently locked by
// `tests/unit/project.spec.ts`, so an item count of exactly 400 here is proof
// this path was rewired without changing its default-case output. A second,
// structural check compares the actual item selection against a direct
// EXTRACT call using that same literal old budget — `ref`, `snapshotId` and
// `stats.ms` are excluded because those are per-call/timing artifacts, never
// part of the old constant's behavior.
await sw.evaluate(async () => await chrome.storage.local.remove('provider'));
const defaultWindowExtract = await host({ type: 'PANEL_EXTRACT', tabId });
const oldHardcodedBudgetExtract = await sw.evaluate(
  async (id) =>
    await chrome.tabs.sendMessage(id, {
      type: 'EXTRACT',
      profile: 'interactive',
      budget: { maxNodes: 400 },
    }),
  tabId,
);
const stableShape = (t) => ({
  items: t.items.map(({ ref, ...rest }) => rest),
  omitted: t.omitted,
  ambiguity: t.ambiguity,
  degraded: t.degraded,
});
check(
  'contextWindow 缺省（32000）时，PANEL_EXTRACT 的选取结果与改动前硬编码 32000 逐项一致（不回归锚点）',
  defaultWindowExtract?.ok === true &&
    defaultWindowExtract.data.items.length === 400 &&
    JSON.stringify(stableShape(defaultWindowExtract.data)) ===
      JSON.stringify(stableShape(oldHardcodedBudgetExtract.data)),
  `items=${defaultWindowExtract?.data?.items?.length} vs ${oldHardcodedBudgetExtract?.data?.items?.length}`,
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
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
  async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
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

const crossPage = [
  {
    descriptor: { role: 'link', name: 'Docs' },
    expectedUserAction: 'click',
    title: '打开开发文档',
    detail: '点击导航栏里的 Docs。',
  },
  {
    // This target is on the *next* page. No snapshot taken now contains it, so
    // no caller could have produced a ref for it — only a descriptor.
    descriptor: { role: 'button', name: 'API Reference' },
    expectedUserAction: 'click',
    title: '打开 API 参考',
  },
];

const started = await host({ type: 'START_GUIDE', tabId, goal: '打开 API 参考', steps: crossPage });
await page.waitForTimeout(400);
check('宿主启动跨页引导并渲染第 1 步', started?.ok === true, JSON.stringify(started));

const panelClosed = await sw.evaluate(async (id) => {
  const k = `guide:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check(
  '线程落在 storage.session，键为 guide:{sessionId}',
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
  const k = `guide:tab-${id}`;
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
  const k = `guide:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('同一 URL 刷新不算前进，游标不动', afterReload?.cursor === 1, `cursor=${afterReload?.cursor}`);
const visibleAfterReload = (await guideState())?.data?.visible === true;
// Evidence on failure: what each re-plan trigger decided for this tab, and
// whether the step comes back late rather than never.
const reloadTraces = visibleAfterReload
  ? null
  : await sw.evaluate(async (id) => (await chrome.storage.session.get(`replan:tab-${id}`))[`replan:tab-${id}`] ?? null, tabId);
if (!visibleAfterReload) await page.waitForTimeout(4000);
check(
  '刷新后浮层重新出现',
  visibleAfterReload,
  visibleAfterReload
    ? ''
    : `4s 后=${(await guideState())?.data?.visible} traces=${JSON.stringify(reloadTraces?.slice?.(-3))}`,
);

// Finishing the last step ends the session and clears the record.
// The cross-page block left the tab on /docs; the next one starts from /.
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(500);

// ---- a page the user went to on their own does not move the plan ----
// "The user navigated" is not proof of "the user did what we asked". Only using
// the step's own target moves a fixed plan; anything else paints the same step
// again against wherever the user is now.
const panelA = await ctx.newPage();
await panelA.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
await panelA.evaluate(
  async ([id, steps]) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: '打开 API 参考', steps }),
  [tabId, crossPage],
);
await page.waitForTimeout(400);

await page.goto(`http://127.0.0.1:${PORT}/billing`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const backtracked = await sw.evaluate(async (id) => {
  const k = `guide:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check(
  '用户自己去了别处 → 不前进，也不把第 1 步记成完成',
  backtracked?.cursor === 0 && backtracked?.history?.[0]?.outcome === 'unknown',
  `cursor=${backtracked?.cursor} outcome=${backtracked?.history?.[0]?.outcome}`,
);
check('浮层在新页面上仍指着第 1 步的目标', (await guideState())?.data?.visible === true);

// ---- a goal with no model configured is answered, not silently re-routed ----
// There is nothing to plan with. The old local matcher used to take over here,
// and on real pages it almost never produced a usable answer; the host now says
// so, starts nothing, and leaves the guide that is already running alone.
await panelA.evaluate(() => {
  window.__answers = [];
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'AGENT_ANSWER') window.__answers.push(m.text);
  });
});
const asked = await panelA.evaluate(
  async (id) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: 'create instance' }),
  tabId,
);
await page.waitForTimeout(400);
const noModelAnswers = await panelA.evaluate(() => window.__answers);
check(
  '未配置模型时带目标起引导：不启动，并如实说明',
  asked?.ok === false && noModelAnswers.some((t) => String(t).includes('还没有配置模型')),
  JSON.stringify({ asked, noModelAnswers }),
);
const stillThere = await sw.evaluate(
  async (id) => (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null,
  tabId,
);
check('原来那条引导原样留着', stillThere?.cursor === 0, `cursor=${stillThere?.cursor}`);
await panelA.close();

const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await panel2.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
await page.waitForTimeout(300);
const flowCleared = await sw.evaluate(async (id) => {
  const k = `guide:tab-${id}`;
  return (await chrome.storage.session.get(k))[k] ?? null;
}, tabId);
check('结束引导后记录被清除', flowCleared === null);
check('结束引导后浮层消失', (await guideState())?.data?.visible === false);

// ═══════════════════════════════════════════════════════════════════════════
// 08 — end-to-end proof of the QA loop (07's `runQuestion`) against a stubbed
// model endpoint. Zero real network: `ctx.route()` intercepts `chat/completions`
// for every page this context opens, present and future — registered here,
// before the side panel that will actually issue the fetch even exists, so the
// route is guaranteed to be in place before any request can go out.
//
// F-11 (第十一条) needs no new code here: it is a regression claim about the
// existing F-7/F-8 checks earlier in this same file (around the `stale` /
// `descOnly` / `afterRebuild` assertions), which this whole run either keeps
// green or does not — see the final report for confirmation, not new checks.
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

/** Every request the stub endpoint received, in arrival order — a single
 *  counter shared across all 08 tests. Each test records `requestLog.length`
 *  before acting and diffs afterwards, so overlapping in-flight requests
 *  across tests (task 6, 7) never race a reset. */
const requestLog = [];
/** Swapped per test. Receives the parsed request body and the Playwright
 *  `Route`; must eventually settle it (`route.fulfill` or let it hang). */
let modelHandler = async (route) => {
  await route.fulfill({ status: 500, body: 'unstubbed request reached the 08 QA model stub' });
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every ref a *live* request carries for a given role/name, straight out of
 *  the serialized element table `buildQuestionUserMessage` wraps into the user message
 *  (`project.ts`'s `toPromptText`: `${ref} ${role} ${JSON-quoted name}`).
 *  Never a value computed ahead of time — every `PANEL_EXTRACT` commits a
 *  fresh snapshot generation (06), invalidating whatever ref an earlier
 *  extraction produced, so the only trustworthy source is the very request
 *  being answered right now. */
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

const isRepairRequest = (body) => (body.messages?.[0]?.content ?? '').includes('这是一次独立的修复请求');

/** Real SSE, not one JSON blob — `complete()` (01) parses `data:` frames. */
function sseBody(text, usage = { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 }) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}
/** Streams a tool call the way the real endpoint does: the function name on
 *  the first fragment, `arguments` split across the next ones. */
function sseToolBody(name, args, usage = { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 }) {
  const half = Math.ceil(args.length / 2);
  const frag = (o) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [o] } }] })}\n\n`;
  return [
    frag({ index: 0, function: { name, arguments: args.slice(0, half) } }),
    frag({ index: 0, function: { arguments: args.slice(half) } }),
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/**
 * Answers in whichever shape the request asked for.
 *
 * The guide sends `tools` and gets a tool call back, with the envelope's
 * `intent` becoming the function name and everything else the arguments —
 * the model is never asked to write `intent`. The QA path (S1) still asks
 * for free text and still gets it. Branching on the request rather than on a
 * flag here is also a small proof that the two paths really are separate.
 */
const fulfillEnvelope = (route, envelope) => {
  const asked = route.request().postDataJSON();
  if (!asked?.tools?.length) {
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody(JSON.stringify(envelope)),
    });
  }
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

/** Observes every `PANEL_SHOW_QA_RESULT` the panel actually sends *and* what
 *  it got back, without altering behaviour — the real call still goes
 *  through `orig`. This is the only way to recover the exact `snapshotId` /
 *  `ref` the panel used for a given highlight, and the raw `HighlightAck`
 *  the host forwarded back: neither is echoed in the model request body, and
 *  the React UI does not surface `highlight.failure` distinctly from success
 *  (see content.ts's explain branch). */
await qaPanel.evaluate(() => {
  window.__qaCalls = [];
  const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, ...rest) => {
    const p = orig(msg, ...rest);
    if (msg && msg.type === 'PANEL_SHOW_QA_RESULT') {
      const rec = { msg, response: null };
      window.__qaCalls.push(rec);
      p.then((res) => { rec.response = res; }).catch((e) => { rec.response = { ok: false, error: String(e) }; });
    }
    return p;
  };
});

const qaInput = qaPanel.getByPlaceholder('例如：这个报错是什么意思？');
const qaCloseBtn = qaPanel.getByRole('button', { name: '关闭', exact: true });

/** Enter submits regardless of the "问" button's `disabled` state (task 7
 *  relies on this: the button is disabled while busy, but `onKeyDown` has no
 *  such guard, which is the real, reachable path a fast typist hits). */
const askQuestion = async (text) => {
  await qaInput.fill(text);
  await qaInput.press('Enter');
};
const clearOverlay = async () =>
  void (await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId));
const closeQaAnswerIfOpen = async () => {
  if (await qaCloseBtn.isVisible().catch(() => false)) await qaCloseBtn.click();
};

/** Never throws — a wrong assumption in one 08 test must not crash the other
 *  ~100 checks after it. Mirrors this file's own `overlayStatus` idiom. */
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
async function waitForQaCallResponse(indexFromEnd = 0, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const calls = await qaPanel.evaluate(() => window.__qaCalls.map((c) => ({ msg: c.msg, response: c.response })));
    const rec = calls[calls.length - 1 - indexFromEnd];
    if (rec?.response) return rec;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
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

// ─────────────────────────────────────────────────────────────────────────
// QA-1 — 答案文字正确出现
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER = '这段是控制台的实例列表，点 Create instance 按钮可以创建一个新实例。';
  modelHandler = async (route) => {
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: [] });
  };
  await askQuestion('这个页面是做什么用的？');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-1：面板上的答案文字包含桩返回的 answer 原文', typeof text === 'string' && text.includes(ANSWER), text ?? '(超时未出现)');
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-2 — explain 高亮的实际矩形等于模型引用的那个元素（逐值比对）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER = '点这个按钮即可创建新实例。';
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'button', 'Create instance');
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER, refs: ref ? [ref] : [] });
  };
  await askQuestion('创建实例的按钮在哪里？');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-2a：答案文字先正常出现（前置条件）', typeof text === 'string' && text.includes(ANSWER), text ?? '(超时)');
  const shown = await waitUntil(async () => (await guideState())?.data?.status === 'shown', 5000);
  const createRect = await rectOf2('create');
  const ov = await guideState();
  check(
    'QA-2b：DEBUG_GET_OVERLAY_STATE 的 rect 与 Create instance 的 getBoundingClientRect 逐值一致',
    shown && JSON.stringify(ov?.data?.rect) === JSON.stringify(createRect),
    `overlay=${JSON.stringify(ov?.data?.rect)} target=${JSON.stringify(createRect)}`,
  );
  const rec = await waitForQaCallResponse();
  check(
    'QA-2c：PANEL_SHOW_QA_RESULT 的 RPC 响应本身也带回同一个矩形（结构层面的交叉验证）',
    JSON.stringify(rec?.response?.data?.highlight?.rect) === JSON.stringify(createRect),
    JSON.stringify(rec?.response?.data?.highlight),
  );
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-3 — clarify 的候选全部高亮，系统不替用户选（resolved 保持 null）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  modelHandler = async (route, body) => {
    const refs = liveRefs(body, 'button', 'Stop');
    await fulfillEnvelope(route, {
      intent: 'clarify',
      question: '你说的是哪一个实例的 Stop 按钮？',
      options: refs.map((r, i) => ({ ref: r, label: `第 ${i + 1} 个 Stop 按钮` })),
    });
  };
  await askQuestion('帮我停止这个实例');
  const optLabels = await pollTexts(() => qaPanel.locator('.qa-options li'));
  const rec = await waitForQaCallResponse();
  const sentRefs = rec?.msg?.items?.map((i) => i.ref) ?? [];
  check(
    'QA-3a：两个真实 Stop 按钮的 ref 都被送进了高亮请求（不是只发一个）',
    sentRefs.length === 2 && new Set(sentRefs).size === 2,
    JSON.stringify(sentRefs),
  );
  check('QA-3b：面板列出的候选数与桩返回的 options 数一致', optLabels.length === 2, JSON.stringify(optLabels));
  check(
    'QA-3c：HIGHLIGHT 响应 resolved 保持 null、candidates 数等于候选数（不替用户选，K-6）',
    rec?.response?.data?.highlight?.resolved === null && rec?.response?.data?.highlight?.candidates?.length === 2,
    JSON.stringify(rec?.response?.data?.highlight),
  );
  const ambiguous = await waitUntil(async () => (await guideState())?.data?.status === 'ambiguous', 5000);
  check('QA-3d：浮层进入 ambiguous 态（两个候选一起框出）', ambiguous, JSON.stringify(await guideState()));
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-4 — need_text 不制造正文答案
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  // Verbatim from `src/entrypoints/sidepanel/qa.ts`'s `NEED_TEXT_MESSAGE` — a
  // fixed constant, deliberately never built from the model's own query/blocks.
  const NEED_TEXT_MESSAGE = '我还读不到这个页面的正文——正文管线要到后面的阶段才有。';
  const before = await qaPanel.evaluate(() => window.__qaCalls.length);
  modelHandler = async (route) => {
    await fulfillEnvelope(route, {
      intent: 'need_text',
      query: '需要读到退款政策的正文段落',
      blocks: ['这是绝不应该出现在面板上的正文片段-b17'],
    });
  };
  await askQuestion('这个页面的退款政策是什么？');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-4a：need_text 展示固定的"读不到正文"文案，逐字一致', text === NEED_TEXT_MESSAGE, text ?? '(超时未出现)');
  check(
    'QA-4b：反向断言——不出现模型 query/blocks 里的任何内容（不编造）',
    typeof text === 'string' && !text.includes('退款政策的正文段落') && !text.includes('这是绝不应该出现在面板上的正文片段-b17'),
    text ?? '(超时)',
  );
  await new Promise((r) => setTimeout(r, 400));
  const after = await qaPanel.evaluate(() => window.__qaCalls.length);
  check('QA-4c：need_text 没有发出任何 PANEL_SHOW_QA_RESULT（没有可高亮的东西）', after === before, `before=${before} after=${after}`);
  check('QA-4d：浮层保持不可见', (await guideState())?.data?.visible === false, JSON.stringify(await guideState()));
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-5 — 坏 JSON 时总请求数恰好为 2（1 主调用 + 1 修复调用）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const before = requestLog.length;
  const seenBodies = [];
  modelHandler = async (route, body) => {
    seenBodies.push(body);
    if (!isRepairRequest(body)) {
      // Deliberately malformed the way 02 says a repair must not paper over:
      // the string never closes, so `repairTruncation` refuses to guess a
      // closing quote (`inStr` still true at end-of-text) and the candidate is
      // discarded outright — a real, unrecoverable parse failure, not a
      // truncation the tolerant parser could fix on its own.
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody('{"intent":"explain","answer":"这是一段没有闭合的字符串'),
      });
    } else {
      await fulfillEnvelope(route, { intent: 'explain', answer: '这是修复调用给出的答案', refs: [] });
    }
  };
  await askQuestion('随便问一个问题，触发首次解析失败');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-5a：坏 JSON 经过恰好一次修复后，展示的是修复调用的答案', typeof text === 'string' && text.includes('这是修复调用给出的答案'), text ?? '(超时)');
  const after = requestLog.length;
  check('QA-5b：总请求数恰好为 2（路由里的计数器）', after - before === 2, `${after - before}`);
  const repairBody = seenBodies[1];
  const repairShapeOk =
    Boolean(repairBody) &&
    repairBody.messages?.length === 2 &&
    repairBody.messages[0]?.role === 'system' &&
    repairBody.messages[0]?.content.includes('这是一次独立的修复请求') &&
    !JSON.stringify(repairBody).includes('Create instance');
  check(
    'QA-5c：第二次请求体确实是 buildRepairPrompt 的形状（独立会话、不含页面内容，见 04）',
    repairShapeOk,
    JSON.stringify(repairBody?.messages?.map((m) => m.content.slice(0, 50))),
  );
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-6 — 页面变化后旧结果不被采纳
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const gate = deferred();
  let arrived = false;
  modelHandler = async (route) => {
    arrived = true;
    await gate.promise;
    try {
      await fulfillEnvelope(route, { intent: 'explain', answer: '不该被采纳的旧答案-QA6', refs: [] });
    } catch {
      /* the tab navigated away — the panel's own `sync()` may already have
       * aborted this request client-side by the time we get here, which is
       * itself part of what this test is proving. */
    }
  };
  await askQuestion('这个页面是做什么的（回答将在导航之后才放行）？');
  await waitUntil(() => arrived, 5000);
  await page.goto(`http://127.0.0.1:${PORT}/docs`, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  gate.resolve();
  await page.waitForTimeout(700);
  const text = await qaPanel.locator('.qa-answer p').first().innerText().catch(() => null);
  check(
    'QA-6a：导航之后，悬而不决的旧回答不会被展示到面板上',
    !(typeof text === 'string' && text.includes('不该被采纳的旧答案-QA6')),
    text ?? '(未展示任何答案)',
  );
  // The navigation replaced the content script with a fresh instance that has
  // never created an overlay at all — `DEBUG_GET_OVERLAY_STATE` reports
  // `data: null` in that case (content.ts: `overlay ? overlay.getState() :
  // null`), not `{visible:false}`. `data === null` is actually the *stronger*
  // signal here (nothing was ever painted on this page), so it must count
  // alongside `visible === false` rather than fail the check.
  const ov = await guideState();
  check(
    'QA-6b：也没有发生指向旧问题引用的 HIGHLIGHT（新页面上从未有任何浮层被画出）',
    ov?.data === null || ov?.data?.visible === false,
    JSON.stringify(ov?.data),
  );
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
}

// ─────────────────────────────────────────────────────────────────────────
// QA-7 — 新问题能取消旧问题（真实网络层 abort，net::ERR_ABORTED）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const failedRequests = [];
  const onReqFailed = (req) => {
    if (req.url().startsWith(QA_BASE)) failedRequests.push({ url: req.url(), failure: req.failure() });
  };
  qaPanel.on('requestfailed', onReqFailed);

  const gateA = deferred();
  let arrivedA = false;
  const ANSWER_B = '问题B的真实答案-QA7';
  modelHandler = async (route, body) => {
    const userMsg = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    // `includes`, not `startsWith`: the goal sits at the *end* of the user
    // message, after the wrapped element table (see `buildQuestionUserMessage`). An
    // earlier `startsWith` silently stopped matching when the goal moved,
    // which let question A fall through to B's branch — QA-7a still went
    // green off B's answer text while QA-7b correctly went red.
    if (userMsg.includes('问题A')) {
      arrivedA = true;
      await gateA.promise; // deliberately never resolved — question A hangs forever
      try {
        await fulfillEnvelope(route, { intent: 'explain', answer: '问题A不该被展示的答案-QA7', refs: [] });
      } catch {
        /* expected once the browser aborts the underlying fetch */
      }
      return;
    }
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER_B, refs: [] });
  };

  await askQuestion('问题A：这是会被取消的问题');
  await waitUntil(() => arrivedA, 5000);
  await askQuestion('问题B：这是会取代前者的新问题'); // Enter bypasses the disabled "问" button — see `askQuestion`'s comment
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check(
    'QA-7a：最终展示的是问题 B 的答案，不是问题 A 的',
    typeof text === 'string' && text.includes(ANSWER_B) && !text.includes('问题A不该被展示的答案-QA7'),
    text ?? '(超时)',
  );

  const aborted = await waitUntil(
    () => failedRequests.some((r) => r.failure?.errorText === 'net::ERR_ABORTED'),
    3000,
  );
  check(
    'QA-7b：问题 A 的底层网络请求真的被客户端 abort（net::ERR_ABORTED），不只是界面被后来者覆盖——' +
      '比其余各条更脆弱：这只证明了"旧结果不会污染新答案"里更强的那一半（真实取消），已用最小复现脚本验证过该信号在本 Playwright/Chromium 组合下可靠',
    aborted,
    JSON.stringify(failedRequests),
  );

  qaPanel.off('requestfailed', onReqFailed);
  gateA.resolve();
  await closeQaAnswerIfOpen();
}

// ─────────────────────────────────────────────────────────────────────────
// QA-8 — 进行中的 guide 不被问答覆盖：thread 仍在、仍可继续
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const guideStarted = await qaPanel.evaluate(
    async (id) =>
      await chrome.runtime.sendMessage({
        type: 'START_GUIDE',
        tabId: id,
        goal: '跟着这几步走',
        steps: [
          {
            descriptor: { role: 'button', name: 'Create instance' },
            expectedUserAction: 'click',
            title: '创建实例（引导中，QA-8）',
          },
        ],
      }),
    tabId,
  );
  check('QA-8a：零成本引导（手写 steps，无需桩）成功启动', guideStarted?.ok === true, JSON.stringify(guideStarted));
  await waitUntil(async () => (await guideState())?.data?.status === 'shown', 5000);
  const createRect = await rectOf2('create');
  const guideRectBefore = (await guideState())?.data?.rect;
  check(
    'QA-8b：引导第 1 步已高亮在 Create instance 上',
    JSON.stringify(guideRectBefore) === JSON.stringify(createRect),
    JSON.stringify(guideRectBefore),
  );

  const threadKey8 = `guide:${'tab-' + tabId}`;
  const cursorBefore = (
    await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, threadKey8)
  )?.cursor;

  const ANSWER_8 = '这里可以设置项目名称-QA8。';
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'textbox', 'Project name');
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER_8, refs: ref ? [ref] : [] });
  };
  await askQuestion('Project name 输入框是做什么用的？');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-8c：问答的答案正常展示', typeof text === 'string' && text.includes(ANSWER_8), text ?? '(超时)');

  const projRect = await rectOf2('proj');
  const shownOnProj = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(projRect), 5000);
  check(
    'QA-8d：问答的高亮盖过了引导画面（矩形变成 Project name 的位置）',
    shownOnProj,
    JSON.stringify((await guideState())?.data?.rect),
  );

  const cursorDuringQa = (
    await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, threadKey8)
  )?.cursor;
  check('QA-8e：问答期间 thread 的 cursor 未被移动', cursorDuringQa === cursorBefore, `before=${cursorBefore} during=${cursorDuringQa}`);

  // 07: 关闭问答答案卡片是 `PANEL_RESUME_GUIDE` 的三个自动触发时机之一。
  await qaCloseBtn.click();
  const backOnGuide = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRect), 5000);
  check(
    'QA-8f：关闭问答后画面回到引导第 1 步（PANEL_RESUME_GUIDE），thread 仍可继续',
    backOnGuide,
    JSON.stringify((await guideState())?.data?.rect),
  );
  const cursorAfter = (
    await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, threadKey8)
  )?.cursor;
  check('QA-8g：全程 cursor 都没有变过（问答不建、不动 Thread）', cursorAfter === cursorBefore, `before=${cursorBefore} after=${cursorAfter}`);

  await qaPanel.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await page.waitForTimeout(300);
}

// ─────────────────────────────────────────────────────────────────────────
// QA-9 — sensitive 的 ref 不会被高亮（两道独立防线：校验层的 R-e，content.ts 的 S-03）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();

  // 9a/9b — through the real QA flow: the question agent's R-e must reject
  // the whole envelope *before* any highlight is ever attempted.
  await refresh();
  const pwLive = table.items.find((i) => i.name === 'Password');
  check('QA-9 前置：当前表里能找到 Password 输入框', Boolean(pwLive?.ref), JSON.stringify(pwLive));
  const before9 = await qaPanel.evaluate(() => window.__qaCalls.length);
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'textbox', 'Password');
    await fulfillEnvelope(route, { intent: 'explain', answer: '登录密码是 admin123', refs: ref ? [ref] : [] });
  };
  await askQuestion('登录密码是什么？');
  const text9a = await pollText(() => qaPanel.locator('.qa-answer.error p').first());
  check(
    'QA-9a：模型引用密码框时面板走 error 态，不出现"这是依据"式暗示密码框被引用的文案',
    typeof text9a === 'string' && text9a.includes('敏感') && !text9a.includes('依据'),
    text9a ?? '(超时未进入 error 态)',
  );
  const after9 = await qaPanel.evaluate(() => window.__qaCalls.length);
  check('QA-9b：违反规则的回答从未发出 PANEL_SHOW_QA_RESULT（不给高亮任何机会）', after9 === before9, `before=${before9} after=${after9}`);
  await closeQaAnswerIfOpen();

  // 9c/9d — direct host relay, bypassing the panel's own validation, to prove
  // content.ts's independent enforcement (06's Gotchas calls this "S-03,第二
  // 个独立执行点") also refuses on its own, in case anything upstream is ever
  // skipped.
  await refresh();
  const pwLive2 = table.items.find((i) => i.name === 'Password');
  const directRes = await qaPanel.evaluate(
    async ([id, snapshotId, url, item]) =>
      await chrome.runtime.sendMessage({
        type: 'PANEL_SHOW_QA_RESULT',
        tabId: id,
        snapshotId,
        url,
        items: [item],
        mode: 'explain',
        title: '依据',
      }),
    [tabId, table.snapshotId, page.url(), pwLive2],
  );
  check(
    'QA-9c：绕过面板校验、直接请求高亮敏感元素——宿主/content script 仍独立拒绝（sensitive_blocked）',
    directRes?.ok === true && directRes?.data?.highlight?.failure === 'sensitive_blocked',
    JSON.stringify(directRes),
  );
  check('QA-9d：拒绝后浮层没有真的画出来', (await guideState())?.data?.visible === false, JSON.stringify(await guideState()));
}

// ─────────────────────────────────────────────────────────────────────────
// QA-10 — mode:'explain' 在页面重渲染后不重绑（核心场景）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();
  const ANSWER_10 = '这个按钮用来创建新实例-QA10。';
  modelHandler = async (route, body) => {
    const ref = liveRef(body, 'button', 'Create instance');
    await fulfillEnvelope(route, { intent: 'explain', answer: ANSWER_10, refs: ref ? [ref] : [] });
  };
  await askQuestion('创建实例的按钮长什么样？');
  const text = await pollText(() => qaPanel.locator('.qa-answer p').first());
  check('QA-10 前置：初始问答成功展示', typeof text === 'string' && text.includes(ANSWER_10), text ?? '(超时)');
  const createRectBefore = await rectOf2('create');
  const shownBefore = await waitUntil(async () => JSON.stringify((await guideState())?.data?.rect) === JSON.stringify(createRectBefore), 5000);
  check('QA-10 前置：初始高亮矩形与真实 Create instance 一致（成功高亮后才有资格测"重渲染后"）', shownBefore, JSON.stringify(await guideState()));

  const rec = await waitForQaCallResponse();
  const originalSnapshotId = rec?.msg?.snapshotId;
  const originalRef = rec?.msg?.items?.[0]?.ref;
  check('QA-10 前置：捕获到问答实际使用的 snapshotId 与 ref', Boolean(originalSnapshotId) && Boolean(originalRef), `snapshotId=${originalSnapshotId} ref=${originalRef}`);

  // URL 不变，只是 DOM 被重渲染：原地移除 #create，换一个角色/名字相同但位置
  // 完全不同的新节点——如果发生重绑，highlight 会指向这个新位置。
  await page.evaluate(() => {
    const b = document.getElementById('create');
    const fresh = document.createElement('button');
    fresh.id = 'create-moved-qa10';
    fresh.textContent = b.textContent;
    fresh.style.position = 'fixed';
    fresh.style.top = '4px';
    fresh.style.left = '4px';
    document.body.appendChild(fresh);
    b.remove();
  });
  await page.waitForTimeout(200);

  // 直接再发一次 HIGHLIGHT（08 明确允许的写法），snapshotId/ref 用问答当时
  // 那一份——快照未过期（没有新 EXTRACT），但底层元素已经不在了。
  const staleAsk = await highlight({
    sessionId: 'e2e',
    snapshotId: originalSnapshotId,
    mode: 'explain',
    step: {
      ref: originalRef,
      descriptor: { role: 'button', name: 'Create instance' },
      expectedUserAction: 'observe',
      title: '依据',
    },
    progress: { index: 0, total: 1 },
    autoScroll: false,
  });
  check(
    'QA-10a：DOM 重渲染后 explain 模式如实报告 snapshot_stale，不重绑',
    staleAsk?.ok === true && staleAsk?.data?.failure === 'snapshot_stale' && staleAsk?.data?.resolved === null,
    JSON.stringify(staleAsk?.data),
  );
  const movedRect = await rectOf2('create-moved-qa10');
  check(
    'QA-10b：拿到的绝不是被搬到别处的新节点的坐标——若重绑发生，rect 会恰好等于这个值',
    JSON.stringify(staleAsk?.data?.rect) !== JSON.stringify(movedRect),
    `stale.rect=${JSON.stringify(staleAsk?.data?.rect)} movedRect=${JSON.stringify(movedRect)}`,
  );
  check('QA-10c：failure 响应的 rect 为 null（不是"找到了但坐标为空"的另一种含糊状态）', staleAsk?.data?.rect === null, JSON.stringify(staleAsk?.data?.rect));

  // 恢复页面到原始 DOM，供后续任何测试或重跑使用（本文件里 08 是最后一段，
  // 但保持这段自包含，不留下变了形的页面）。
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型驱动的多步引导第一次真正跑起来。
//
// 带目标起引导时，`startGuide` 发起一次真实的（这里打桩的）模型调用，产出
// `route` + `steps`，框出第一步的目标，并在 `GUIDE_STATE` 广播里带上
// `route`/`evidence`/`check`/`binding`（05 的 Seam）。随后验证 §5.3 的逐页
// 重规划：非 landmark/heading 的 DOM 变化不触发重规划（slice 6），
// landmark/heading 结构确实变化时触发（slice 7），且重规划后展示的 route
// 整体替换第一次的，不拼接（slice 2 的 e2e 佐证）。复用 QA 段已经建好的
// 打桩基础设施（`QA_BASE`/`modelHandler`/`requestLog`/`fulfillEnvelope`/
// `liveRef`）——`provider` 配置此刻仍然指向 `QA_BASE`，QA-11 还没有把它清掉。
// ═══════════════════════════════════════════════════════════════════════════
{
  const guidePanel = await ctx.newPage();
  await guidePanel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await guidePanel.evaluate(() => {
    window.__guideStates = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'GUIDE_STATE') window.__guideStates.push(m);
      if (m?.type === 'AGENT_ANSWER') (window.__answers ??= []).push(m.text);
      if (m?.type === 'GUIDE_CROSS_SITE') (window.__crossSite ??= []).push(m);
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
            intent: 'guide',
            route: [{ at: 'Instances 页', goal: '找到目标实例并设为私有' }],
            steps: [{ ref, action: 'click', why: '第一步先选中目标实例' }],
          }
        : {
            intent: 'guide',
            route: [{ at: '实例详情页', goal: '把这台实例设为私有' }],
            // A *different* control, because that is what a real second step
            // points at. Reusing the first step's ref made 07's repeat
            // backstop refuse the envelope — correctly: re-proposing the very
            // control the user was just confirmed to have finished is the loop
            // that backstop exists to break. This assertion is about `route`
            // being replaced wholesale, so the fixture was the half to fix.
            steps: [{ ref: otherRef(body, ref), action: 'click', why: '重规划之后的第二次结果' }],
          };
    await fulfillEnvelope(route, envelope);
  };

  const requestsBefore = requestLog.length;
  const goal = '把这个仓库设为私有';
  const guideStarted = await host({ type: 'START_GUIDE', tabId, goal });
  await waitUntil(() => requestLog.length >= requestsBefore + 1, 4000);
  check(
    '带目标起引导 → 宿主发起一次真实模型调用（多步引导第一次跑起来）',
    guideStarted?.ok === true && requestLog.length === requestsBefore + 1,
    `ok=${guideStarted?.ok} requests=${requestLog.length - requestsBefore}`,
  );

  await page.waitForTimeout(500);
  check('模型给出的 guide 信封，第一步被成功框出', (await overlayStatus('shown')) === 'shown');
  check(
    '模型规划的引导不提供「跳过」——点了什么都不会发生的按钮不出现',
    (await guideState())?.data?.canSkip === false,
    `canSkip=${(await guideState())?.data?.canSkip}`,
  );

  const stateAfterFirst = await guidePanel.evaluate(() => window.__guideStates.at(-1) ?? null);
  check(
    'GUIDE_STATE 广播带上了 route 与三轴：route 与这次模型输出逐字段一致，evidence=model / check=unknown / binding=bound',
    JSON.stringify(stateAfterFirst?.route) === JSON.stringify([{ at: 'Instances 页', goal: '找到目标实例并设为私有' }]) &&
      stateAfterFirst?.evidence === 'model' &&
      stateAfterFirst?.check === 'unknown' &&
      stateAfterFirst?.binding === 'bound',
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
    stateAfterReplan = await guidePanel.evaluate(() => window.__guideStates.at(-1) ?? null);
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
      traceAfter.system.includes('guide') &&
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
  await page.waitForTimeout(400);
  const traceAfterOff = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
  check(
    '把开关移除 → 之后的模型调用不再追加，已存下的那份原样留着（关得掉，且不倒着删）',
    (traceAfterOff?.entries ?? []).length === entriesAtSwitchOff,
    `before=${entriesAtSwitchOff} after=${(traceAfterOff?.entries ?? []).length}`,
  );

  // ---- 别拿「还在路上」的那一页去规划（09 重设计） ----
  //
  // 09 第一版用 DOM 静默判「跳转落定」，在会重渲染的页面上永不满足：56/70 次
  // 重规划跑满 4.4 秒窗口，跳数从 4.1 掉到 2.1，已回退。
  //
  // 这一版换成浏览器自己的答案。真机取证：整页导航期间 `tab.status` 进入
  // `loading` 并持续约 765ms，恰好覆盖 step-confirmed(+0ms) 与 target-lost
  // (+50ms) 触发的窗口；而同页浮层展开全程 `complete`，闸门不生效。
  //
  // 断言的是唯一重要的那条保证：**被拿去规划的那张表，不是在页面还在路上时
  // 抽的**。夹具里没有真导航，所以直接把标签页驶入 loading 再断言 trace。
  // 先开一条新线程。这一段和下面那段以前跑在 2003 行起的那条上，而那条早已
  // 用满配额进了终态——它们能过，靠的是「终态线程仍然接受输入」这个缺陷。
  // 守卫补上之后（`machine.ts` 的 dispatch），终态就真的是终态了，所以要测
  // 重规划就得有一条活着的线程。
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
        intent: 'guide',
        route: [{ at: '夹具页', goal: '先让一条计划活着' }],
        steps: [{ ref, action: 'click', why: '一个活着的计划，等着被重规划' }],
      });
    }
    await fulfillEnvelope(route, { intent: 'done', why: '够了' });
  };
  const beforeStart = requestLog.length;
  await host({ type: 'START_GUIDE', tabId, goal: '重规划在路上判据 · 新线程' });
  await waitUntil(() => requestLog.length > beforeStart, 6000);
  await page.waitForTimeout(400);
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`replan:tab-${id}`), tabId);
  const beforeTransit = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Transit heading';
  });
  await waitUntil(() => requestLog.length > beforeTransit, 6000);
  await page.waitForTimeout(400);

  const transitTraces = await sw.evaluate(async (id) => {
    const k = `replan:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? [];
  }, tabId);
  const committing = (Array.isArray(transitTraces) ? transitTraces : []).filter(
    (t) => t.outcome === 'replanned' || t.outcome === 'deferred',
  );
  check(
    '每次重规划都记下了这一页当时还在不在路上',
    committing.length > 0 && committing.every((t) => t.attempts.every((a) => !a.ok || 'inTransit' in a)),
    JSON.stringify(committing.map((t) => t.attempts.map((a) => a.inTransit)))?.slice(0, 160),
  );
  check(
    '拿去规划的那张表，不是在页面还在路上时抽的',
    committing.length > 0 && committing.every((t) => t.attempts.at(-1)?.inTransit !== true),
    JSON.stringify(committing.map((t) => ({ g: t.trigger, last: t.attempts.at(-1)?.inTransit })))?.slice(0, 160),
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
  await host({ type: 'START_GUIDE', tabId, goal: 'done 终态渲染 · 新线程' });
  await page.waitForTimeout(400);
  modelHandler = async (route) => {
    await fulfillEnvelope(route, { intent: 'done', why: '你要的东西已经在这一页上了' });
  };
  const beforeDone = requestLog.length;
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'Yet another heading';
  });
  await waitUntil(() => requestLog.length > beforeDone, 6000);
  await page.waitForTimeout(1200);

  const overlayAfterDone = await sw.evaluate(
    async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
    tabId,
  );
  const doneAnswer = await guidePanel.evaluate(
    () => (window.__answers ?? []).filter((t) => String(t).startsWith('看起来已经到了')).length,
  );
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
  await sw.evaluate(async () => await chrome.storage.local.remove('run:records'));
  await host({ type: 'START_GUIDE', tabId, goal: '把这个仓库设为私有' });
  await page.waitForTimeout(600);
  const recordsBeforeExplicitEnd = await sw.evaluate(
    async () => (await chrome.storage.local.get('run:records'))['run:records'] ?? [],
  );
  check(
    '运行结束的那一刻就落盘了，不必等用户点「结束引导」',
    recordsBeforeExplicitEnd.length === 1 && recordsBeforeExplicitEnd[0]?.goal === '把这个仓库设为私有',
    `records=${recordsBeforeExplicitEnd.length}`,
  );
  await host({ type: 'END_GUIDE', tabId });
  await page.waitForTimeout(600);
  const records = await sw.evaluate(async () => (await chrome.storage.local.get('run:records'))['run:records'] ?? []);
  const rec = records.at?.(-1);
  check(
    '引导结束后写下了这次运行的摘要（goal / route / 每步 outcome / 结束方式 / 确认程度）',
    Boolean(rec) && rec.goal === '把这个仓库设为私有' && Array.isArray(rec.route) && Array.isArray(rec.steps),
    JSON.stringify(rec)?.slice(0, 200),
  );
  check(
    '结束方式与确认程度分开记：这趟是模型说到了，一步都没点过就是「一步都没有」',
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
  await host({ type: 'START_GUIDE', tabId, goal: 'trace 生命周期 · 第一条' });
  await waitUntil(() => requestLog.length > beforeFirstGuide, 6000);
  let firstTrace = null;
  await waitUntil(async () => {
    firstTrace = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
    return (firstTrace?.entries ?? []).length > 0;
  }, 5000);
  const firstCount = (firstTrace?.entries ?? []).length;

  await host({ type: 'END_GUIDE', tabId });
  await page.waitForTimeout(300);
  const traceAfterEndGuide = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
  check(
    '结束引导不删 trace——引导刚出问题时，正是要看它的时候',
    (traceAfterEndGuide?.entries ?? []).length === firstCount && firstCount > 0,
    `before=${firstCount} after=${(traceAfterEndGuide?.entries ?? []).length}`,
  );

  // 线程与 trace 都按标签页作键，所以不清就会追加；而 trace 只保最后 24 条，
  // 于是新引导的头几次调用会被上一条引导的记录挤掉——最该看的那几条最先没。
  const beforeSecondGuide = requestLog.length;
  await host({ type: 'START_GUIDE', tabId, goal: 'trace 生命周期 · 第二条' });
  await waitUntil(() => requestLog.length > beforeSecondGuide, 6000);
  let secondTrace = null;
  await waitUntil(async () => {
    secondTrace = await sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, traceK);
    return (secondTrace?.entries ?? []).length > 0;
  }, 5000);
  check(
    '同一标签页开始新引导 → trace 从头开始，不续写上一条（否则 24 条上限会先挤掉新引导的开头）',
    (secondTrace?.entries ?? []).length === firstCount &&
      !JSON.stringify(secondTrace.entries).includes('trace 生命周期 · 第一条'),
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

// ─────────────────────────────────────────────────────────────────────────
// QA-11 — 未配置模型时点「问这个页面」（README 完成时能演示什么·第五句）
// ─────────────────────────────────────────────────────────────────────────
{
  await clearOverlay();

  // "未配置模型"的状态：storage.local 里从未写过 `provider`。settings.ts
  // 的 `loadConfig()`（`{ ...DEFAULT_CONFIG, ...v, ... }`）在这种情况下原
  // 样退回 `DEFAULT_CONFIG`——`apiKey` 是空字符串，但 `baseURL` 早已预填
  // 了真实的 `https://api.openai.com/v1`（`PRESETS[0]`）。
  await sw.evaluate(async () => await chrome.storage.local.remove('provider'));

  // provider.ts 的 `complete()` 现在有一道前置检查（与 `testConnection`
  // 同一条判据，复用同一个 `isLocalEndpoint`）：空 apiKey + 非本地端点，
  // 在任何 fetch 之前直接抛错。所以"未配置模型"点「问」不应该再发出任何
  // 请求——这里仍然给这个地址打桩，只是作为安全网：如果这道闸将来被意外
  // 削弱、又开始发请求了，桩会把它挡在 CI 的真实网络之外，同时下面
  // QA-11c 的计数会立刻从 0 变红，而不是让请求悄悄打到真实 OpenAI。
  const noModelRequestLog = [];
  await ctx.route('https://api.openai.com/v1/chat/completions', async (route) => {
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
  check('QA-11 前置：storage 里确实没有 provider 配置（DEFAULT_CONFIG 生效）', cfgSeen === null, JSON.stringify(cfgSeen));

  await noModelPanel.getByPlaceholder('例如：这个报错是什么意思？').fill('这个页面是做什么用的？');
  await noModelPanel.getByRole('button', { name: '问', exact: true }).click();

  // 逐字比对——provider.ts 里这条是硬编码常量，不是拼出来的文案。
  const EXPECTED_NO_MODEL_MESSAGE =
    '还没有配置模型：请先在下方「模型配置（BYOK）」里填写端点和 API Key，并点「测试连接并保存」。';
  const errText = await pollText(() => noModelPanel.locator('.qa-answer.error p').first(), 6000);
  check(
    'QA-11a：未配置模型时点「问」，面板给出可读的中文提示，逐字等于 complete() 里那条"请先配置"文案（不是"Key 被拒绝"——没有 Key 不等于 Key 填错了）',
    errText === EXPECTED_NO_MODEL_MESSAGE,
    errText ?? '(超时未出现任何提示)',
  );

  const busyCount = await noModelPanel.locator('.status.busy').count();
  check(
    'QA-11b：不挂起——到达确定的错误终态，不是永远停在「正在…」',
    errText !== null && busyCount === 0,
    busyCount > 0 ? `仍有 ${busyCount} 个"忙碌"状态元素显示中` : (errText ?? '(既未报错也未忙碌)'),
  );

  check(
    'QA-11c：如实计数——0 次模型请求。未配置时 complete() 在第一次 fetch 之前就短路抛错，' +
      '页面内容（元素表）不会被发往用户从未选过的默认端点——这正是这次要补的缺陷本身',
    noModelRequestLog.length === 0,
    `实际发出 ${noModelRequestLog.length} 次：${JSON.stringify(noModelRequestLog)}`,
  );

  // 既有能力：抽取本页元素——PANEL_EXTRACT 从不经过 agent/provider/provider.ts，不
  // 应受"未配置模型"影响。
  await noModelPanel.getByRole('button', { name: '抽取本页元素', exact: true }).click();
  const extractText = await pollText(() => noModelPanel.locator('p.status.ok').first(), 4000);
  check(
    'QA-11d：既有能力不变——「抽取本页元素」照常返回控件表',
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
    async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
    tabId,
  );
  check(
    'QA-11e：既有能力不变——检视模式照常可用，悬停即描边',
    inspectNoModel?.data?.visible === true,
    `status=${inspectNoModel?.data?.status}`,
  );
  await noModelPanel.getByRole('button', { name: '取消检视', exact: true }).click();

  await ctx.unroute('https://api.openai.com/v1/chat/completions');
  await noModelPanel.close();
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
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
// STEP_CONFIRMED 会让宿主把会话拆掉、浮层归 idle，轮询快照只会看到 idle 而
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
  // `guide:` record, content events reach nothing and the replan machinery this
  // section exists for never runs.
  //
  // The in-flight tombstone is what makes that replan inert: `handlePageChanged`
  // records the move and spends nothing while a call is already out against the
  // page being left (E-3 discards that result when it lands). So no model is
  // called and no `present` can repaint the overlay out from under the
  // assertion — and, unlike pinning the thread at §5.10's call ceiling, the
  // guide does not end, which is what this section needs: a quota-exhausted
  // thread is now a *terminal* one, and a terminal one ends the run and clears
  // the overlay this test is watching.
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
          route: [],
          steps: [],
          cursor: 0,
          outcomes: [],
          history: [],
          planSource: 'model',
          evidence: 'model',
          check: 'unknown',
          callCount: 1,
          docFetchCount: 0,
          inflight: {
            effectId: 'e-already-out',
            kind: 'callModel',
            at: { threadRev: 1, snapshotId: t.snapshotId, pageHash: t.pageHash, url: t.url },
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

  // `settling` is transient by contract. If nothing replaces the step, the
  // guide must not leave the user reading 「正在看新页面…」 with no way out —
  // that is a live path, not a hypothetical: a replan that cannot read the
  // page it landed on returns silently (the github.com/search case), and the
  // model-call ceiling this thread is pinned at does the same. The fallback is
  // the failure screen, because that screen carries the only buttons the user
  // can act on at that moment.
  await page.waitForTimeout(6000);
  const strandedSeen = await seenStatuses();
  check(
    '没人接手时 settling 不会永远停住，而是落到可操作的失效屏',
    strandedSeen.includes('lost'),
    `跃迁序列=${JSON.stringify(strandedSeen)}`,
  );

  // D3: one click wakes several re-plan triggers for the same tab, and every
  // one of them used to overwrite the single `replan:{threadId}` record the
  // others had just written — so only the last finisher's account survived,
  // and the trace could not answer "what did the *other* triggers decide".
  const traces = await sw.evaluate(async (id) => {
    const k = `replan:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check(
    '每一路重规划都留下自己的记录，而不是互相覆盖',
    Array.isArray(traces) && traces.length >= 1 && traces.every((t) => typeof t.trigger === 'string'),
    JSON.stringify(traces)?.slice(0, 200),
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
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 重规划的记录必须分得清「重规划了」和「什么都没做」（2026-08-21）
//
// `applyGuidePageChanged` 只要有线程且页面动了就返回一个 outcome，哪怕
// `handlePageChanged` 因为 `inflight` 已经占住而一个 effect 都没产出。
// `replanGuide` 把「返回了非空」当成「重规划了」，于是真机上出现「两路
// replanned、实际只花一次模型调用」——观测本身在说假话，后面所有测量都
// 建立在它上面。
// ═══════════════════════════════════════════════════════════════════════════
{
  await page.evaluate(() => {
    document.getElementById('defer-btn')?.remove();
    const b = document.createElement('button');
    b.id = 'defer-btn';
    b.textContent = 'Change the page';
    // Adds a heading, so `pageFingerprint` really moves and `pageMoved` is true
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
          route: [],
          steps: [],
          cursor: 0,
          outcomes: [],
          history: [],
          planSource: 'model',
          evidence: 'model',
          check: 'unknown',
          callCount: 1,
          docFetchCount: 0,
          inflight: {
            effectId: 'E-inflight',
            kind: 'callModel',
            at: { threadRev: 1, snapshotId: t.snapshotId, pageHash: t.pageHash, url: t.url },
          },
        },
      }),
    [tabId, deferTable],
  );
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`replan:tab-${id}`), tabId);

  await highlight(
    command({
      descriptor: { role: 'button', name: 'Change the page' },
      expectedUserAction: 'click',
      title: '让页面结构变一下',
    }),
  );
  await overlayStatus('shown');
  await page.click('#defer-btn');
  await page.waitForTimeout(2500); // past the 400ms structure debounce and the settle windows

  const deferTraces = await sw.evaluate(async (id) => {
    const k = `replan:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? [];
  }, tabId);
  const moved = (Array.isArray(deferTraces) ? deferTraces : []).filter((t) => t.outcome !== 'page-unchanged');
  check(
    '模型调用还占着时，页面变动记为「已记下、未动用」，不冒充重规划',
    moved.length > 0 && moved.every((t) => t.outcome === 'deferred' || t.outcome === 'superseded'),
    JSON.stringify(deferTraces)?.slice(0, 260),
  );

  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
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
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'GUIDE_CROSS_SITE') window.__cs.push(m);
    });
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
          rev: 7, goal: '去看文档', table: t, route: [], steps: [], cursor: 0, outcomes: [], history: [],
          planSource: 'model', evidence: 'model', check: 'unknown', callCount: 1, docFetchCount: 0,
          inflight: {
            effectId: 'cs-1', kind: 'callModel',
            at: { threadRev: 7, snapshotId: t.snapshotId, pageHash: t.pageHash, url: t.url },
          },
        },
      }),
    [tabId, csTable],
  );
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);

  await listener.evaluate(
    async ([id, t, ref]) =>
      await chrome.runtime.sendMessage({
        type: 'EFFECT_RESULT',
        threadId: `tab-${id}`,
        effectId: 'cs-1',
        at: { threadRev: 7, snapshotId: t.snapshotId, pageHash: t.pageHash, url: t.url },
        outcome: {
          ok: true,
          providerCalls: 1,
          // The function name is the intent; the arguments carry no `intent`.
          tool: 'guide',
          value: JSON.stringify({
            route: [{ at: '夹具页', goal: '去看文档' }],
            steps: [{ ref, action: 'click', why: '这条链接会带你离开本站' }],
          }),
        },
      }),
    [tabId, csTable, offsiteRef],
  );
  await page.waitForTimeout(1200);

  const ask = await listener.evaluate(() => window.__cs[0] ?? null);
  check(
    '跨站的那一步先弹确认，卡片同时念出「从哪」和「去哪」的完整 hostname',
    ask?.from === '127.0.0.1' && ask?.to === 'docs.elsewhere-example.test',
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
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
  await page.evaluate(() => document.getElementById('offsite')?.remove());
}

// ═══════════════════════════════════════════════════════════════════════════
// 点了但没到（10 · failed 终态）
//
// 用户点了一个控件、页面什么都没发生。在此之前这一步会永远停在 `unknown`，
// 既不算成功也不算失败，Run record 里也分不出它是没点，还是点了没到。
//
// 判定「没到」必须**等完整个窗口**：`runReplan` 原本在第一次读到「页面没动」
// 时就返回，而那一瞥发生在点击后 t≈0，页面本来就还没来得及变——真机里
// `step-confirmed → page-unchanged` 出现过 23 次，全是这个原因。
// ═══════════════════════════════════════════════════════════════════════════
{
  const obs2 = await ctx.newPage();
  await obs2.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await obs2.evaluate(() => {
    window.__ans = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'AGENT_ANSWER') window.__ans.push(m.text);
    });
  });
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
          rev: 3, goal: '点一个没反应的按钮', table: t,
          route: [{ at: '夹具页', goal: '试试这个按钮' }],
          steps: [{ ref, descriptor: { role: 'button', name: 'Does nothing at all' }, expectedUserAction: 'click', title: 'Does nothing at all' }],
          cursor: 0, outcomes: [null],
          history: [{ title: 'Does nothing at all', url: t.url, outcome: 'unknown' }],
          planSource: 'model', evidence: 'model', check: 'unknown',
          callCount: 2, docFetchCount: 0, inflight: null,
        },
      }),
    [tabId, inertTable, inertRef],
  );
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`replan:tab-${id}`), tabId);

  await highlight(
    command({
      ref: inertRef,
      descriptor: { role: 'button', name: 'Does nothing at all' },
      expectedUserAction: 'click',
      title: 'Does nothing at all',
    }),
  );
  await overlayStatus('shown');
  await page.click('#inert-btn');
  await page.waitForTimeout(3500); // 让整个 settle 窗口走完

  const inertThread = await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);
  check(
    '点了但页面没动 → 这一步落定为 failed，不再永远停在 unknown',
    inertThread?.history?.at?.(-1)?.outcome === 'failed',
    `outcome=${inertThread?.history?.at?.(-1)?.outcome}`,
  );

  const ans = await obs2.evaluate(() => window.__ans ?? []);
  check(
    '并且告诉了用户——屏幕上还是那一页，他无从判断是慢还是坏',
    ans.some((t) => String(t).includes('没有反应')),
    JSON.stringify(ans)?.slice(0, 160),
  );

  await obs2.close();
  await sw.evaluate(async (id) => await chrome.storage.session.remove(`guide:tab-${id}`), tabId);
  await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
  await page.evaluate(() => document.getElementById('inert-btn')?.remove());
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
        const at = { threadRev: 3, snapshotId: t.snapshotId, pageHash: t.pageHash, url: t.url };
        await chrome.storage.session.set({
          [`guide:tab-${tab}`]: {
            rev: 3, goal: g, table: t, route: [], steps: [], cursor: 0, outcomes: [],
            history: [{ title: '第一步', url: t.url, outcome: 'unknown' }],
            planSource: 'model', evidence: 'model', check: 'unknown',
            callCount: 2, docFetchCount: 0,
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
        type: 'START_GUIDE',
        tabId: id,
        goal: '新的一趟',
        steps: [{ descriptor: { role: 'button', name: 'Create instance' }, expectedUserAction: 'click', title: '新的一趟' }],
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
  check('新的那一趟接管了这个标签页', (await guideKeyOf(tabId))?.goal === '新的一趟', JSON.stringify((await guideKeyOf(tabId))?.goal));
  await watcher.evaluate(async (id) => await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId: id }), tabId);
  await page.waitForTimeout(300);
  check('点「结束引导」结束的那一趟，摘要记为「用户结束」', (await recordEnding('新的一趟')) === 'user_ended', String(await recordEnding('新的一趟')));

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

  const bodies = [];
  modelHandler = async (route, body) => {
    bodies.push(body);
    await fulfillEnvelope(route, { intent: 'done', why: '够了' });
  };
  const userMessageOf = (body) => body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  const startGuide = async (goal) => {
    const before = bodies.length;
    await skillPanel.evaluate(
      async ([id, g]) => await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId: id, goal: g }),
      [ghTabId, goal],
    );
    await waitUntil(() => bodies.length > before, 6000);
    await gh.waitForTimeout(400);
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

  const plugins = await sw.evaluate(async () =>
    ((await chrome.storage.local.get('run:records'))['run:records'] ?? []).map((r) => r.plugins),
  );
  check('每一趟的 Run record 记下了它开始时开着哪些 Plugin', JSON.stringify(plugins) === JSON.stringify([['skill'], []]), JSON.stringify(plugins));

  await sw.evaluate(async () => await chrome.storage.local.remove(['plugin:skill', 'run:records']));
  await ctx.unroute('https://github.com/**');
  await gh.close();
  await skillPanel.close();
}

await qaPanel.close();
await sw.evaluate(async () => await chrome.storage.local.remove('provider'));

await ctx.close();
server.close();
fs.rmSync(udd, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
