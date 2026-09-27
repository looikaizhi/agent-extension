/**
 * Observability spike for the S2 guided-flow — NOT a test, produces no
 * pass/fail verdicts, never joins CI. Drives the real, built extension
 * (dist/chrome-mv3) against the real DeepSeek endpoint (no ctx.route() model
 * stub anywhere in this file) and records every ThreadState transition,
 * every EffectRequest/EffectResult, every GUIDE_STATE broadcast and every
 * model envelope it can recover, so a human can read back "what actually
 * happened" across five different guide runs.
 *
 * Reuses tests/e2e/smoke.mjs's launch scaffold (persistent context + real
 * Chrome for Testing + --load-extension) verbatim in spirit, with the model
 * stub removed and chrome.storage.local's `provider` key pointed at the real
 * DeepSeek config from .env.local instead.
 *
 * Run:
 *   npx wxt build && node tests/spike/live-guide-run.mjs
 *
 * Costs real money (DeepSeek API calls). Writes a full transcript to
 * tests/spike/live-guide-run-log.ndjson (git-ignored scratch, not committed
 * as fixture data) and prints a condensed narrative to stdout.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

/**
 * Independent re-verification, not a re-implementation: imports the product's
 * *own* `guideAgent.parseOutput`/`guideAgent.validate` (same functions `machine.ts`'s
 * `handleEffectResult` uses as the authoritative check, and the same ones
 * `sidepanel/effects.ts`'s `runCallModelEffect` already ran once as a gate
 * before ever sending `EFFECT_RESULT`). Run this file with
 * `--experimental-strip-types --import ./evals/alias-loader-register.mjs`
 * (same convention as `guide-envelope-smoke.mjs`) so the `@/` alias resolves.
 */
const { guideAgent } = await import(pathToFileURL(path.join(repo, 'src/agent/agents/guide/agent.ts')).href);

/* ═══════════ .env.local — never print KEY itself ═══════════ */
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(repo, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const DEEPSEEK_MODEL = env.DEEPSEEK_MODEL || 'deepseek-chat';
if (!DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY（.env.local）。不要打印它本身，也不要写进命令行历史。');
  process.exit(1);
}

const LOG_PATH = path.join(here, 'live-guide-run-log.ndjson');
fs.writeFileSync(LOG_PATH, '');
function logRecord(rec) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
}

/* ═══════════ fixture — a small two-view mini-SPA ═══════════
 *
 * List view: two hosts (web-a / web-b), each with an "打开详情" (open detail)
 * button and an "移除" (remove) button — the two "移除" buttons are
 * deliberately identical in name/role/section, for the ambiguous-goal run.
 * Detail view (reached only by clicking 打开详情, a real in-page JS view
 * swap, not a server navigation) exposes a "设为私有" (make private) control
 * that does not exist anywhere on the list view — the goal used for the
 * multi-step runs names an action that is unreachable without that
 * transition, which is what forces `route` to have more than one hop.
 *
 * `window.renderDetail`/`window.renderList` are exposed so the *test driver*
 * (not the extension) can trigger the same view swap a real click would,
 * for the mid-flight replanning run — mirroring the existing e2e suite's own
 * technique of mutating heading text directly from Playwright.
 */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8" /><title>云主机控制台</title></head>
<body>
<nav aria-label="主导航">
  <a href="#home">首页</a>
  <a href="#billing-page">账单</a>
</nav>
<main id="app"></main>
<script>
function renderList() {
  document.getElementById('app').innerHTML =
    '<h1>主机列表</h1>' +
    '<section aria-label="主机">' +
    '<table><thead><tr><th>名称</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    '<tr><td>web-a</td><td>运行中</td><td>' +
    '<button class="detail-btn" data-id="web-a">打开详情</button> ' +
    '<button class="remove-btn" data-id="web-a">移除</button></td></tr>' +
    '<tr><td>web-b</td><td>运行中</td><td>' +
    '<button class="detail-btn" data-id="web-b">打开详情</button> ' +
    '<button class="remove-btn" data-id="web-b">移除</button></td></tr>' +
    '</tbody></table>' +
    '</section>' +
    '<section aria-label="账单方式"><h2>付款方式</h2><button id="add-card">添加银行卡</button></section>';
  document.querySelectorAll('.detail-btn').forEach(function (b) {
    b.addEventListener('click', function () { renderDetail(b.dataset.id); });
  });
}
function renderDetail(id) {
  document.getElementById('app').innerHTML =
    '<h1>主机详情：' + id + '</h1>' +
    '<section aria-label="安全设置"><h2>安全设置</h2>' +
    '<button id="make-private">设为私有</button> ' +
    '<button id="restart">重启主机</button></section>';
}
window.renderList = renderList;
window.renderDetail = renderDetail;
renderList();
</script>
</body>
</html>`;

const server = http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  })
  .listen(0);
const PORT = server.address().port;
const ROOT_URL = `http://127.0.0.1:${PORT}/`;

/* ═══════════ launch — same scaffold as tests/e2e/smoke.mjs ═══════════ */
const udd = fs.mkdtempSync('/tmp/pg-live-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  viewport: { width: 1280, height: 860 },
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
console.log(`[setup] 扩展已加载，service worker ${extId}`);

const page = await ctx.newPage();
await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);

const tabId = await sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return t?.id ?? null;
});
if (tabId === null) throw new Error('找不到目标标签页');
console.log(`[setup] tabId=${tabId}`);

// ---- ensure content script injected (mirrors ensureInjected) ----
await sw.evaluate(async (id) => {
  const ping = async () => {
    try {
      return await chrome.tabs.sendMessage(id, { type: 'PING' });
    } catch {
      return null;
    }
  };
  let pong = await ping();
  if (!pong) {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content-scripts/content.js'] });
    for (let i = 0; i < 20 && !pong; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pong = await ping();
    }
  }
}, tabId);

// ---- real DeepSeek provider config into chrome.storage.local ----
await sw.evaluate(
  async ({ baseURL, model, apiKey }) =>
    await chrome.storage.local.set({
      provider: { preset: 'deepseek', baseURL, model, apiKey, contextWindow: 32_000 },
    }),
  { baseURL: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, apiKey: DEEPSEEK_API_KEY },
);
console.log(`[setup] provider 配置已写入 chrome.storage.local（baseURL=${DEEPSEEK_BASE_URL}, model=${DEEPSEEK_MODEL}）`);

/* ═══════════ two panel instances — see report for why two are needed:
 * chrome.runtime.sendMessage does NOT deliver back to the sending page's own
 * onMessage listeners (verified empirically before writing this file), so a
 * single "acting" panel would miss its own outgoing EFFECT_RESULT. `guidePanel`
 * issues START_GUIDE/END_GUIDE; `obs` only listens. Both mount the full React
 * app (sidepanel.html has no lighter-weight variant), so both independently
 * run `startEffectListener` and may race to claim a given EFFECT_REQUEST —
 * harmless (E-1's claim arbitration is exactly for this), and which one
 * actually executed a given call is recoverable after the fact: whichever
 * page's own log is *missing* an EFFECT_RESULT it should have seen is the one
 * that sent it (self-exclusion). ═══════════ */
async function openPanel(label) {
  await page.bringToFront();
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await p.evaluate((label) => {
    window.__wire = [];
    window.__label = label;
    chrome.runtime.onMessage.addListener((m) => window.__wire.push({ at: Date.now(), msg: m }));
  }, label);
  return p;
}
const guidePanel = await openPanel('guidePanel');
const obs = await openPanel('obs');
await page.bringToFront();
console.log('[setup] 两个侧栏实例已就绪（guidePanel 发起，obs 纯监听）');

const host = async (msg) => await guidePanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);

async function mergedWire() {
  const [a, b] = await Promise.all([guidePanel.evaluate(() => window.__wire), obs.evaluate(() => window.__wire)]);
  // De-dup by *content* (never by `at` — the two pages are separate renderer
  // isolates with independently-ticking Date.now(), so the same broadcast can
  // land a few ms apart in each). A broadcast sent by background.ts (GUIDE_
  // STATE/AGENT_ANSWER/SESSION_ENDED/EFFECT_REQUEST) legitimately reaches
  // *both* non-sending panels, so it would otherwise appear twice. An
  // EFFECT_RESULT, sent by whichever panel's `effects.ts` won the claim, is
  // never self-delivered (verified empirically before writing this file) —
  // it reaches only the *other* panel, so it naturally dedupes to one record
  // whose `sources` names the panel that did *not* send it (the complement is
  // the executor).
  const byKey = new Map();
  for (const [src, arr] of [['guidePanel', a], ['obs', b]]) {
    for (const rec of arr) {
      const key = JSON.stringify(rec.msg);
      const existing = byKey.get(key);
      if (existing) existing.sources.push(src);
      else byKey.set(key, { at: rec.at, msg: rec.msg, sources: [src] });
    }
  }
  const out = [...byKey.values()];
  out.sort((x, y) => x.at - y.at);
  return out;
}

async function threadSnapshot(threadId) {
  const gk = `guide:${threadId}`;
  const ek = `effect:${threadId}`;
  const [g, e] = await Promise.all([
    sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, gk),
    sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, ek),
  ]);
  return { state: g, inflightWire: e };
}

/** Polls ThreadState until `stop()` is called; records one entry per distinct `rev`. */
function startPoller(threadId, runLabel) {
  const history = [];
  let lastRev = -1;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const snap = await threadSnapshot(threadId);
      const rev = snap.state?.rev ?? -1;
      if (rev !== lastRev) {
        lastRev = rev;
        const entry = { at: Date.now(), run: runLabel, ...snap };
        history.push(entry);
        logRecord({ kind: 'thread_state', ...entry });
      }
    } catch {
      // SW may be transiently unreachable between eviction/wake; next tick retries.
    }
    if (!stopped) setTimeout(tick, 120);
  };
  tick();
  return { history, stop: () => { stopped = true; } };
}

async function waitUntil(fn, timeoutMs = 90_000, stepMs = 150) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

async function endGuide() {
  await host({ type: 'END_GUIDE', tabId });
  await page.waitForTimeout(150);
}

/**
 * What a real user would actually see in the side panel right now — the only
 * reliable source for "用户在侧栏里看到了什么" (wire messages say what was
 * *sent*, not what React actually painted). Whole-body innerText rather than
 * targeted selectors: robust to not knowing App.tsx's exact class names, and
 * "is there visibly nothing there" is itself part of what this needs to answer.
 */
async function panelVisibleText(p) {
  return await p.evaluate(() => document.body.innerText);
}

/**
 * Re-runs the product's own `guideAgent.parseOutput` → `guideAgent.validate` against a
 * captured `EFFECT_RESULT.outcome.value` (only meaningful when `outcome.ok`
 * — a `false` outcome already carries effects.ts's own gate rejection reason
 * verbatim in `outcome.error`, nothing to re-derive). `table` is the request's
 * own `params.table`, the exact table the model was shown — never a freshly
 * re-extracted one, or R-a/R-e could spuriously fail against a page that has
 * since moved on.
 */
function reVerify(rawValue, table) {
  const parsed = guideAgent.parseOutput(toolName, rawValue);
  if (parsed.kind === 'error') return { parse: 'error', parseMessage: parsed.message };
  const validated = guideAgent.validate(parsed.envelope, table);
  if (validated.kind === 'violation') {
    return { parse: 'ok', intent: parsed.envelope.intent, validate: 'violation', violationReason: validated.reason };
  }
  return { parse: 'ok', intent: parsed.envelope.intent, validate: 'ok', envelope: parsed.envelope };
}

async function resetFixture() {
  await page.evaluate(() => window.renderList());
  await page.waitForTimeout(150);
}

const threadId = `tab-${tabId}`;

/**
 * `END_GUIDE` (`cancelGuideEffect`) only clears the `inflight` tombstone, not
 * the `ThreadState` record itself — the S2 `guide:` key is left behind with
 * whatever `rev`/`route`/`steps` the run ended on (by design: nothing in
 * 04-effect-protocol.md asks `END_GUIDE` to drop the record). A fresh `start`
 * input always rebuilds `ThreadState` from scratch regardless (`rev` resets
 * to 1), so this is harmless to the *product* — but it is exactly the kind of
 * stale read this spike's own poller would otherwise mistake for a real
 * transition belonging to the next run, in the ~120ms window between
 * `startPoller` arming and the next run's real `start` input landing. This
 * is a test-harness hygiene step (equivalent to a fresh profile), not a
 * product-behavior change — `background.ts` never calls `storage.session.remove`
 * on this key either.
 */
async function resetThreadStorage() {
  await sw.evaluate(async (tid) => {
    await chrome.storage.session.remove([`guide:${tid}`, `effect:${tid}`]);
  }, threadId);
}

/* ═══════════ scenario runner ═══════════ */
const runs = [];

async function runScenario(label, goal, { onStarted, timeoutMs = 90_000 } = {}) {
  console.log(`\n========== ${label} ==========`);
  console.log(`goal: ${goal}`);
  await resetFixture();
  await resetThreadStorage();
  await guidePanel.evaluate(() => { window.__wire = []; });
  await obs.evaluate(() => { window.__wire = []; });

  const poller = startPoller(threadId, label);
  const t0 = Date.now();
  const startRes = await host({ type: 'START_GUIDE', tabId, goal });
  console.log(`START_GUIDE ok=${startRes?.ok}`);

  if (onStarted) await onStarted({ waitUntil, page, host, threadId, threadSnapshot, guidePanel, obs });
  else {
    // Default: wait for either a GUIDE_STATE, an AGENT_ANSWER (notify), or timeout.
    await waitUntil(async () => {
      const w = await mergedWire();
      return w.some((r) => ['GUIDE_STATE', 'AGENT_ANSWER', 'SESSION_ENDED'].includes(r.msg?.type));
    }, timeoutMs);
    await page.waitForTimeout(1500); // let any immediate follow-up (bind_result round trip) settle
  }

  // Snapshot what is actually painted *before* END_GUIDE tears anything down.
  const visibleText = await panelVisibleText(guidePanel);

  poller.stop();
  const wire = await mergedWire();
  const finalState = await threadSnapshot(threadId);
  const elapsedMs = Date.now() - t0;

  // Correlate EFFECT_RESULT with its EFFECT_REQUEST (for the table to
  // re-verify against) and attach an independent verdict to each.
  const requestsByEffectId = new Map(wire.filter((r) => r.msg?.type === 'EFFECT_REQUEST').map((r) => [r.msg.effectId, r.msg]));
  const verified = wire.map((r) => {
    if (r.msg?.type !== 'EFFECT_RESULT') return r;
    const req = requestsByEffectId.get(r.msg.effectId);
    if (r.msg.outcome?.ok && req?.kind === 'callModel') {
      try {
        return { ...r, verdict: reVerify(r.msg.outcome.value, req.params.table) };
      } catch (e) {
        return { ...r, verdict: { error: `re-verify threw: ${String(e?.message ?? e)}` } };
      }
    }
    if (r.msg.outcome && r.msg.outcome.ok === false) {
      return { ...r, verdict: { fromPanelGate: true, error: r.msg.outcome.error, retryable: r.msg.outcome.retryable } };
    }
    return r;
  });

  // Persist every wire message verbatim — this is the piece the first pass
  // never wrote to disk (only run_summary counts were), which is why the
  // model's actual raw output was unrecoverable after that run was killed.
  for (const rec of verified) logRecord({ kind: 'wire', run: label, ...rec });
  logRecord({ kind: 'panel_visible_text', run: label, text: visibleText });

  const record = { label, goal, elapsedMs, stateHistory: poller.history, wire: verified, finalState, visibleText };
  runs.push(record);
  logRecord({ kind: 'run_summary', label, goal, elapsedMs, wireCount: wire.length, stateTransitions: poller.history.length });

  console.log(`elapsed=${elapsedMs}ms state transitions=${poller.history.length} wire messages=${wire.length}`);
  console.log(`final ThreadState: ${finalState.state ? JSON.stringify({ rev: finalState.state.rev, cursor: finalState.state.cursor, ending: finalState.state.ending, callCount: finalState.state.callCount, evidence: finalState.state.evidence, check: finalState.state.check, inflight: finalState.state.inflight }) : 'null (no S2 thread — S1/local path likely taken, or never started)'}`);
  const notify = verified.find((r) => r.msg?.type === 'AGENT_ANSWER');
  if (notify) console.log(`AGENT_ANSWER 文案: ${notify.msg.text}`);
  const effResult = verified.find((r) => r.msg?.type === 'EFFECT_RESULT');
  if (effResult) {
    console.log(`EFFECT_RESULT outcome.ok=${effResult.msg.outcome?.ok}`);
    if (effResult.verdict) console.log(`独立复核: ${JSON.stringify(effResult.verdict).slice(0, 500)}`);
  }
  console.log(`侧栏可见文本 (${visibleText.length} 字符): ${visibleText.slice(0, 300).replace(/\n/g, ' ⏎ ')}`);

  await endGuide();
  return record;
}

/** Resolves as soon as either a `GUIDE_STATE(index:0)` (steps were produced)
 *  or an `AGENT_ANSWER` (the model/validation gave up in some way) shows up —
 *  whichever comes first, rather than always burning the full timeout when a
 *  notify already answered the question. */
async function waitForFirstStepOrNotify(timeoutMs = 90_000) {
  return await waitUntil(async () => {
    const w = await mergedWire();
    const step0 = w.find((r) => r.msg?.type === 'GUIDE_STATE' && r.msg.index === 0);
    const notify = w.find((r) => r.msg?.type === 'AGENT_ANSWER');
    if (step0) return { kind: 'step', rec: step0 };
    if (notify) return { kind: 'notify', rec: notify };
    return null;
  }, timeoutMs);
}

/* ── Run 1: multi-step goal, full lifecycle, then click the real bound target
 *    to observe what STEP_CONFIRMED actually does to an S2 thread. ── */
await runScenario('Run 1 — 多步目标（首次）+ 真实点击', '把 web-a 设为私有', {
  timeoutMs: 90_000,
  onStarted: async ({ page }) => {
    const got = await waitForFirstStepOrNotify(90_000);
    if (!got) console.log('90s 内既未见 GUIDE_STATE 也未见 AGENT_ANSWER（可能调用挂起或超时）');
    else if (got.kind === 'notify') console.log(`模型未产出可呈现的步骤，收到 notify: ${got.rec.msg.text}`);
    else console.log('第 1 步已呈现');
    await page.waitForTimeout(400);

    // Click whatever the overlay is actually pointing at — real Playwright
    // click, at real coordinates, exactly like a user would. This is the
    // *test driver* acting, not the extension (executed=0 is a claim about
    // the extension's own code, not about this harness).
    const status = await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }), tabId);
    console.log(`overlay status before click: ${JSON.stringify(status?.data)}`);
    if (status?.data?.status === 'shown' && status?.data?.rect) {
      const [x, y, w, h] = status.data.rect;
      await page.mouse.click(x + w / 2, y + h / 2);
      console.log(`clicked highlighted target at (${Math.round(x + w / 2)}, ${Math.round(y + h / 2)})`);
    } else {
      console.log('overlay 不是 shown 状态，跳过真实点击');
    }
    await page.waitForTimeout(1500);
  },
});

/* ── Run 2: same goal again, fresh thread — compare model output stability,
 *    do not click through. ── */
await runScenario('Run 2 — 同一个多步目标（第二次）', '把 web-a 设为私有', {
  timeoutMs: 90_000,
  onStarted: async ({ waitUntil, page }) => {
    await waitUntil(async () => {
      const w = await mergedWire();
      return w.some((r) => ['GUIDE_STATE', 'AGENT_ANSWER'].includes(r.msg?.type));
    }, 90_000);
    await page.waitForTimeout(1000);
  },
});

/* ── Run 3: goal with no reasonable starting point on this page. ── */
await runScenario('Run 3 — 当前页面没有合理起点', '帮我查一下明天东京的天气', {
  timeoutMs: 90_000,
  onStarted: async ({ waitUntil, page }) => {
    await waitUntil(async () => {
      const w = await mergedWire();
      return w.some((r) => ['GUIDE_STATE', 'AGENT_ANSWER'].includes(r.msg?.type));
    }, 90_000);
    await page.waitForTimeout(1000);
  },
});

/* ── Run 4: mid-flight page structure change → does replanning trigger? ── */
await runScenario('Run 4 — 中途页面结构变化', '把 web-a 设为私有', {
  timeoutMs: 120_000,
  onStarted: async ({ page }) => {
    const got = await waitForFirstStepOrNotify(90_000);
    if (!got) {
      console.log('90s 内既未见 GUIDE_STATE 也未见 AGENT_ANSWER — 无法测试重规划（首次调用本身未落地）');
      return;
    }
    if (got.kind === 'notify') {
      console.log(`首次调用未产出可呈现的步骤（收到 notify: ${got.rec.msg.text}）— 本遍无法测试"中途结构变化触发重规划"，因为根本没有"中途"：连第一步都没有呈现。这本身就是一个观测结果，如实记录，不强行制造变化。`);
      return;
    }
    console.log('第 1 步已呈现（列表页）— 继续测试中途结构变化');
    await page.waitForTimeout(500);
    const requestsBefore = (await mergedWire()).filter((r) => r.msg?.type === 'EFFECT_REQUEST').length;

    // slice-6-style negative control: a non-landmark mutation must NOT trigger a replan.
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.textContent = '一个新按钮';
      document.querySelector('#app').appendChild(b);
    });
    await page.waitForTimeout(900);
    const afterNoise = (await mergedWire()).filter((r) => r.msg?.type === 'EFFECT_REQUEST').length;
    console.log(`非 landmark 变化后 EFFECT_REQUEST 计数：before=${requestsBefore} after=${afterNoise}（应相等）`);

    // Real landmark/heading change: swap to the detail view via the page's
    // own script (not a click on the guide's own highlighted target — that
    // is Run 1's separate concern).
    await page.evaluate(() => window.renderDetail('web-a'));
    console.log('已触发 list → detail 的结构变化（h1 与 region 都变了）');
    await waitUntil(async () => {
      const w = await mergedWire();
      return w.filter((r) => r.msg?.type === 'EFFECT_REQUEST').length > afterNoise;
    }, 90_000);
    await page.waitForTimeout(2500); // let the replan's own round trip settle
  },
});

/* ── Run 5: ambiguous goal — two symmetric "移除" targets, no disambiguator. ── */
await runScenario('Run 5 — 含糊目标（两个对称目标）', '把这台服务器下线', {
  timeoutMs: 90_000,
  onStarted: async ({ waitUntil, page }) => {
    await waitUntil(async () => {
      const w = await mergedWire();
      return w.some((r) => ['GUIDE_STATE', 'AGENT_ANSWER'].includes(r.msg?.type));
    }, 90_000);
    await page.waitForTimeout(1500);
  },
});

/* ═══════════ cost tally + final dump ═══════════ */
let totalCalls = 0;
let totalPrompt = 0;
let totalCompletion = 0;
let totalTokens = 0;
// Correlate EFFECT_RESULT with its EFFECT_REQUEST (by effectId) to know which
// were callModel vs fetchDoc (S2 never issued a real fetchDoc in this spike —
// need_docs was never produced — but keep the check honest rather than assuming).
for (const run of runs) {
  const requests = new Map(run.wire.filter((r) => r.msg?.type === 'EFFECT_REQUEST').map((r) => [r.msg.effectId, r.msg]));
  for (const rec of run.wire) {
    if (rec.msg?.type !== 'EFFECT_RESULT') continue;
    const req = requests.get(rec.msg.effectId);
    if (req?.kind !== 'callModel') continue;
    totalCalls += 1;
    if (rec.msg.outcome?.ok && rec.msg.outcome.usage) {
      totalPrompt += rec.msg.outcome.usage.prompt ?? 0;
      totalCompletion += rec.msg.outcome.usage.completion ?? 0;
      totalTokens += rec.msg.outcome.usage.total ?? 0;
    }
  }
}
console.log(`\n========== 成本汇总 ==========`);
console.log(`callModel 次数：${totalCalls}`);
console.log(`token：prompt=${totalPrompt} completion=${totalCompletion} total=${totalTokens}`);
logRecord({ kind: 'cost_summary', totalCalls, totalPrompt, totalCompletion, totalTokens });

console.log(`\n完整逐字记录：${LOG_PATH}`);

await guidePanel.close();
await obs.close();
await ctx.close();
server.close();
process.exit(0);
