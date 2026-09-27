/**
 * Observability spike — the guided flow against a real site, github.com, with
 * the real DeepSeek endpoint. NOT a test: no pass/fail verdicts, never joins
 * CI, costs real money.
 *
 * What the earlier spike (`live-guide-run.mjs`) could not show: it drove a
 * local two-view mini-SPA, so every "page change" was a same-document
 * re-render. The breakpoints that carry a real multi-page journey — a full
 * navigation, and a menu opening with no navigation at all — never fired
 * there, and the bugs sitting on both were invisible.
 *
 * Two scenarios, one per breakpoint kind:
 *
 *   A. 跨页导航 — start on a repo page, goal spans pages. The harness clicks
 *      the highlighted control like a user would; Chrome navigates; the
 *      content script that would have reported the change is destroyed by
 *      that same navigation. `chrome.tabs.onUpdated` is the only survivor.
 *   B. 同页 DOM 变化 — GitHub's `Code ▾` dropdown. No navigation, no new
 *      landmark, no new heading: `structureHash` does not move, and only the
 *      control-list half of `pageChange` can see it.
 *
 * The harness does the clicking, never the extension — that is the product
 * boundary («只指路，不开车») and also what makes the click a real user
 * action rather than a simulated one from inside the thing under observation.
 *
 * Run:
 *   npm run eval:task -- [--goals id,id | --site host] [--passes 3]
 *                        [--plugins none | skill,…] [--run <id>]
 *                        [--base-url <url>] [--model <name>] [--price in,cached,out]
 *
 * Every argument has a default: every goal, 3 passes, the Plugins the product
 * ships switched on, the endpoint and model from `.env.local`, a run id from
 * the start time. Prices are per million tokens; without them a run reports
 * tokens and no cost.
 *
 * Each run gets `evals/task/runs/<id>/` and never touches another run's. Its
 * log, screenshots and video go under `raw/`, which is not versioned, and the
 * log's first line says what the run was made with.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGINS, pluginKey } from '@/agent/context/plugins';
import { fingerprint } from '../fingerprint.ts';
import { callsOf } from './calls.mjs';
import { SHARED_OPTIONS, modelFrom, pluginsFrom, providerConfig, readEnv, runIdFrom } from '../options.ts';
import { judge } from './arrival.ts';
import { GOALS } from './goals.ts';
import { resultOf } from './results.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const env = readEnv(repo);
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY（.env.local）。');
  process.exit(1);
}

/**
 * The sites a run signs into, and how to tell who each one thinks this is.
 * A journey on one of these hosts only runs signed in (`signIn`).
 *
 * `who` runs in the page, so it is self-contained. Credentials come from
 * `.env.local` and are never printed.
 */
const ACCOUNTS = [
  {
    host: 'github.com',
    account: env.GITHUB_EMAIL,
    password: env.GITHUB_PASSWORD,
    keys: 'GITHUB_EMAIL/GITHUB_PASSWORD',
    home: 'https://github.com/',
    login: 'https://github.com/login',
    form: { account: '#login_field', password: '#password', submit: 'input[type="submit"], button[type="submit"]' },
    who: () => document.querySelector('meta[name="user-login"]')?.content || null,
  },
  {
    host: 'gitee.com',
    account: env.GITEE_ACCOUNT,
    password: env.GITEE_PASSWORD,
    keys: 'GITEE_ACCOUNT/GITEE_PASSWORD',
    // A classic page, the goals' own starting point: signed in, `/` is a React
    // dashboard with no `gon` to ask.
    home: 'https://gitee.com/chinabugotech/hutool',
    // Seen from outside China, /login is the overseas page — Google, GitHub,
    // or an email and a mailed code. The page's own 「跳转到中文版登陆页」 is
    // this anchor, and it brings the account-and-password form back.
    login: 'https://gitee.com/login#lang=zh-CN',
    // Two forms on that page carry `#user_login` (password, phone): only the
    // password one is ours. The page encrypts the password itself on submit,
    // which is why it is typed and submitted through the form.
    form: {
      account: 'form.session-login__with-password #user_login',
      password: 'form.session-login__with-password #user_password',
      submit: 'form.session-login__with-password input[type="submit"]',
    },
    // Seen from outside China the interface is English (`user_locale=en`); the
    // goals are written in Chinese for Chinese users, who see it in Chinese.
    // Set again before every journey (`openAt`), so nothing the site sends
    // back in between can switch it.
    cookies: [{ name: 'user_locale', value: 'zh-CN', domain: '.gitee.com', path: '/' }],
    // `gon` is the bootstrap of gitee's classic pages. Signed in,
    // `tour_env.current_user` is the username and `info.current_user` the
    // user; signed out, null and false.
    who: () => {
      const g = window.gon ?? {};
      const name = (u) => (typeof u === 'object' ? String(u.username ?? u.login ?? u.name ?? 'signed-in') : String(u));
      const u = g.tour_env?.current_user ?? g.current_user;
      if (u) return name(u);
      return g.info?.current_user ? name(g.info.current_user === true ? 'signed-in' : g.info.current_user) : null;
    },
  },
];
/** How long a sign-in stopped by a captcha or a device check waits for the owner to finish it by hand. */
const MANUAL_SIGN_IN_MS = 3 * 60_000;
const accountFor = (url) => ACCOUNTS.find((a) => a.host === new URL(url).hostname);

/* ═══════════ one browser per process ═══════════
 *
 * `main()` opens it; the helpers below drive it. They read these handles when
 * called instead of taking them as arguments: a harness process runs one
 * browser for its whole life, and threading six handles through every helper
 * would change every line of them for nothing.
 */
let ctx;
let sw;
let extId;
let page;
let guidePanel;
let obs;
/** This run's `raw/shots/` and `raw/log.ndjson` (see `main`). */
let SHOTS;
let LOG_PATH;
const logRecord = (rec) => fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');

/**
 * Headed, slowed and recorded — this spike is watched, not just tallied. A
 * green count says the breakpoint fired; only the picture says the highlight
 * landed on the control a person would have aimed at.
 *
 * `slowMo` applies to every Playwright operation, including the `sw.evaluate`
 * polls in `waitForThread`, so it is deliberately modest: the moments worth
 * watching are given their own explicit pauses below instead of taxing every
 * poll to buy them.
 */
async function launch(provider) {
  const udd = fs.mkdtempSync('/tmp/pg-gh-');
  ctx = await chromium.launchPersistentContext(udd, {
    executablePath: CFT,
    headless: false,
    slowMo: 250,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--window-size=1440,900',
    ],
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: path.join(SHOTS, 'video'), size: { width: 1440, height: 900 } },
  });

  sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  extId = new URL(sw.url()).host;
  console.log(`[setup] 扩展已加载，SW ${extId}`);

  page = await ctx.newPage();

  await sw.evaluate(
    async (config) => await chrome.storage.local.set({ provider: config }),
    providerConfig(provider, DEEPSEEK_API_KEY),
  );
  console.log('[setup] provider 已写入 storage.local');

  // 调试 trace（`agent/agents/guide/trace.ts`）——默认关，这里显式打开。开着它这一轮
  // 才能把每次调用真正发出去的 system/user 与模型原文一并落盘；日志里原本只有
  // 最终结果，一次成功的修复轮在里面是不留痕迹的，而那恰恰是「这次调用花了几
  // 次请求」唯一说得清的地方。
  await sw.evaluate(async () => await chrome.storage.local.set({ 'trace:enabled': true }));
  console.log('[setup] 调试 trace 已打开');

  guidePanel = await openPanel('guidePanel');
  obs = await openPanel('obs');
  await page.bringToFront();
}

/* Two panels: `chrome.runtime.sendMessage` never delivers back to the sending
 * page's own listeners, so a single acting panel would miss its own outgoing
 * EFFECT_RESULT. See live-guide-run.mjs for the full reasoning. */
async function openPanel(label) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await p.evaluate((l) => {
    window.__wire = [];
    window.__label = l;
    chrome.runtime.onMessage.addListener((m) => window.__wire.push({ at: Date.now(), msg: m }));
  }, label);
  return p;
}
const host =async (msg) => await guidePanel.evaluate(async (m) => await chrome.runtime.sendMessage(m), msg);

/**
 * Sign in to one site before its first journey, and again whenever a journey
 * finds the session gone. A signed-out visitor is shown a different site —
 * GitHub rate-limits it onto `Signing in → Username or email`, gitee hides
 * what only members see — so a journey never runs signed out: a sign-in that
 * does not take stops the run.
 *
 * A captcha or a device check the form cannot pass is left to the owner: the
 * browser is on screen, and the run waits for them to finish it by hand.
 *
 * The *harness* types here, never the extension: «只指路，不开车» is the
 * product boundary, and a spike that logged in through the guide would be
 * measuring something this product does not do.
 */
async function signIn(a) {
  if (!a.account || !a.password) throw new Error(`.env.local 没有 ${a.keys}：${a.host} 的目标要登录之后才跑`);
  let user = await whoAtHome(a);
  if (!user) {
    try {
      await page.goto(a.login, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1500);
      if (!(await page.isVisible(a.form.password))) await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(a.form.password, { state: 'visible', timeout: 15_000 });
      await page.fill(a.form.account, a.account);
      await page.fill(a.form.password, a.password);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click(a.form.submit)]);
      await page.waitForTimeout(4000);
    } catch (e) {
      console.log(`[setup] ${a.host} 的登录表单没按预期出现：${String(e).slice(0, 90)}`);
    }
    user = await whoAtHome(a);
  }
  if (!user) {
    console.log(
      `[setup] ⚠️ ${a.host} 还没登录上（可能要过验证码或设备验证）：请在 harness 打开的浏览器窗口里完成登录，最多等 ${MANUAL_SIGN_IN_MS / 60_000} 分钟`,
    );
    const until = Date.now() + MANUAL_SIGN_IN_MS;
    while (!user && Date.now() < until) {
      await page.waitForTimeout(5000);
      user = await page.evaluate(a.who).catch(() => null);
    }
    if (!user) user = await whoAtHome(a);
  }
  if (!user) throw new Error(`${a.host} 没登录上，停下：匿名看到的不是用户看到的那个站（当前页 ${page.url().slice(0, 70)}）`);
  console.log(`[setup] ${a.host} 已登录：${user}`);
  return user;
}

/** The site's home page, freshly loaded, asked who is signed in. */
async function whoAtHome(a) {
  await page.goto(a.home, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);
  return await page.evaluate(a.who).catch(() => null);
}

async function wire() {
  const [a, b] = await Promise.all([guidePanel.evaluate(() => window.__wire), obs.evaluate(() => window.__wire)]);
  const seen = new Set();
  const out = [];
  for (const r of [...a, ...b].sort((x, y) => x.at - y.at)) {
    const k = JSON.stringify(r.msg);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.msg);
  }
  return out;
}
/** This tab's conversation, asked the way the panel asks it. */
async function conversationOf(tabId) {
  const view = await guidePanel.evaluate(async (t) => await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION', tabId: t }), tabId);
  return view?.conversation?.entries ?? [];
}
const clearWire = async () => {
  await guidePanel.evaluate(() => (window.__wire = []));
  await obs.evaluate(() => (window.__wire = []));
};

let shotSeq = 0;
/** The newest frame's file name. A journey's last is what its report shows. */
let lastShot = null;
/** One frame at a moment worth looking at. Named by round and phase so the
 *  folder reads in the same order as the transcript. */
async function shoot(label, phase) {
  await page.waitForTimeout(1200); // let the overlay settle before the frame
  const name = `${String(++shotSeq).padStart(2, '0')}-${label.replace(/[^0-9A-Za-z\u4e00-\u9fa5]+/g, '')}-${phase}.png`;
  await page
    .screenshot({ path: path.join(SHOTS, name) })
    .then(() => {
      lastShot = name;
    })
    .catch(() => {});
}

const tabIdOf = async () =>
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id ?? null;
  });

/** The S2 thread as the host has it persisted right now. */
const threadOf = async (tabId) =>
  await sw.evaluate(async (id) => {
    const k = `guide:tab-${id}`;
    return (await chrome.storage.session.get(k))[k] ?? null;
  }, tabId);

/** The Run record a journey left — where its terminal lives once its thread is
 *  gone. Goals repeat across passes, so it is the newest for this goal written
 *  since the journey started. Polled briefly: a journey the harness ends may be
 *  recorded after `END_GUIDE` has answered. */
async function recordFor(goal, since) {
  for (let i = 0; i < 20; i++) {
    const rec = await sw.evaluate(
      async ([g, t]) => {
        const all = (await chrome.storage.local.get('run:records'))['run:records'] ?? [];
        return [...all].reverse().find((r) => r.goal === g && new Date(r.at).getTime() >= t) ?? null;
      },
      [goal, since],
    );
    if (rec) return rec;
    await page.waitForTimeout(250);
  }
  return null;
}
const recordSummary = (rec) =>
  rec ? { ending: rec.ending, confirmation: rec.confirmation, steps: rec.steps, calls: rec.calls, plugins: rec.plugins } : null;

/** Waits until `pred(thread)` holds, or gives up. Polls the host's own
 *  persisted state rather than the wire, so what it reports is what the guide
 *  actually believes — not what happened to be broadcast. */
async function waitForThread(tabId, pred, { timeoutMs = 60_000, label = '' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await threadOf(tabId);
    // Gone means over: the host records a run and drops its thread the moment
    // it ends (done, a quota, a safety stop), so there is nothing left to wait
    // for. Waiting anyway burned the whole timeout on every ending.
    if (!t) return null;
    if (pred(t)) return t;
    await page.waitForTimeout(500);
  }
  console.log(`   ⚠️ 等待超时（${label}），最后一次 thread:`, JSON.stringify(await threadOf(tabId))?.slice(0, 400));
  return null;
}

function describeThread(t) {
  if (!t) return '（无线程）';
  const step = t.steps?.[t.cursor];
  return [
    `rev=${t.rev}`,
    `ending=${t.ending ?? 'active'}`,
    `calls=${t.callCount}`,
    `steps=${t.steps?.length ?? 0}`,
    `cursor=${t.cursor}`,
    t.clarify ? `clarify=${t.clarify}` : null,
    t.inflight ? `inflight=${t.inflight.kind}` : 'inflight=null',
    step ? `当前步=「${step.title}」(${step.expectedUserAction})` : null,
    t.route?.length ? `route=${t.route.map((h) => h.at).join(' → ')}` : null,
  ]
    .filter(Boolean)
    .join('  ');
}

async function startGuide(url, goal, label) {
  console.log(`\n${'═'.repeat(78)}\n${label}\n  页面: ${url}\n  目标: ${goal}\n${'═'.repeat(78)}`);
  // A click in an earlier round can open a *new* tab — GitHub's README images
  // are links, and one of them is a PNG. `tabIdOf()` asks Chrome for whichever
  // tab is active, not for the one this harness drives, so a stray tab
  // silently becomes the tab every later round reads. That is how six rounds
  // in a row planned against an empty element table on a 1584×396 image while
  // `page.goto` kept dutifully navigating a tab nobody was looking at. Close
  // whatever the last round opened, and put the driven tab back in front
  // before anything asks which tab is active.
  for (const p of ctx.pages()) if (p !== page && p !== guidePanel && p !== obs) await p.close().catch(() => {});
  await page.bringToFront();
  await openAt(url);
  // Who the site thinks this is. On a site with an account a journey starts
  // signed in: a session that lapsed is renewed, and the journey starts over
  // from a clean origin.
  const account = accountFor(url);
  let login = account ? await page.evaluate(account.who).catch(() => null) : null;
  if (account && !login) {
    login = await signIn(account);
    await openAt(url);
  }
  await clearWire();
  const tabId = await tabIdOf();
  const t0 = Date.now();
  const res = await host({ type: 'SAID', tabId, text: goal });
  console.log(`  SAID ok=${res?.ok}`);
  const t = await waitForThread(tabId, (x) => x.inflight === null, { label: '第一次规划' });
  console.log(`  ← ${Math.round((Date.now() - t0) / 1000)}s  ${describeThread(t)}`);
  await shoot(label, '1-第一步已高亮');
  logRecord({ scenario: label, phase: 'start', url, goal, login, ms: Date.now() - t0, thread: t });
  return { tabId, thread: t };
}

/**
 * A journey's start page, reached from a clean origin: off the site first, so
 * no page of it is open to write its state back; its state cleared; the
 * cookies its account sets put back (`ACCOUNTS`); then the page.
 */
async function openAt(url) {
  await page.goto('about:blank');
  await clearSiteState(url);
  const cookies = accountFor(url)?.cookies;
  if (cookies?.length) await ctx.addCookies(cookies);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500); // GitHub hydrates a lot after DOMContentLoaded
}

/**
 * Everything the goal's site keeps between visits except its cookies, so a
 * journey starts with no memory of the last one while the sign-in survives.
 * github keeps its recent searches in `localStorage` (`github-search-history`,
 * measured by `tests/spike/probe-recent-search.mjs`), and run 7's P2-4 pressed
 * Enter on the one the previous journey had left there.
 */
async function clearSiteState(url) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', {
    origin: new URL(url).origin,
    storageTypes: 'local_storage,session_storage,indexeddb,cache_storage,service_workers,websql',
  });
  await cdp.detach();
}

/**
 * P-2's card, answered the way a user answers it: 「继续，带我去」 in the side
 * panel. The step behind the card is already loaded, so answering costs no
 * model call; the step is then painted and clicked like any other.
 *
 * Dispatched rather than clicked through Playwright: a real click brings the
 * panel's tab to the front, the panel follows whichever tab is active, and the
 * card would then answer for the panel's own tab instead of the page's. A real
 * side panel sits beside the page rather than taking its place.
 */
async function answerCrossSite(tabId, thread) {
  const from = new URL(thread.table.url).host;
  const to = thread.pendingCrossSite;
  const button = guidePanel.getByRole('button', { name: '继续，带我去' });
  try {
    await button.waitFor({ state: 'attached', timeout: 10_000 });
    await button.dispatchEvent('click');
  } catch (e) {
    return { from, to, answered: false, why: `侧栏里没有出现跨站确认卡：${String(e).split('\n')[0]}` };
  }
  const after = await waitForThread(tabId, (x) => !x.pendingCrossSite, { timeoutMs: 10_000, label: '跨站确认之后' });
  return after ? { from, to, answered: true } : { from, to, answered: false, why: '点了「继续，带我去」，线程仍停在待确认跨站' };
}

/** Clicks whatever the guide is currently pointing at, as a user would —
 *  located by the step's own `descriptor` (role + accessible name), which is
 *  the same identity a human reads off the screen. Never touches the
 *  extension's registry or refs. */
async function clickCurrentStep(thread, tabId) {
  const step = thread?.steps?.[thread.cursor];
  if (!step) return { clicked: false, why: '没有可点的步骤' };

  // Click the rect the overlay is actually outlining — that is what a user
  // aims at, and it is the only unambiguous identification of the element the
  // extension bound. A `getByRole(role, {name})` lookup is a *second*,
  // independent guess at the same element: on this very page GitHub has more
  // than one control accessibly named "Code", `.first()` picked one of them,
  // and nothing said whether it was the one wearing the highlight.
  // Wait for the highlight to be on screen before aiming at it. `waitForThread`
  // returns as soon as `inflight` clears, which `applyGuideInput` does when it
  // *persists* — the HIGHLIGHT that `renderGuideOutcome` sends afterwards has
  // not painted yet. The first version clicked into that gap and read back
  // `{visible:false, rect:null, status:'idle'}`, which looks exactly like a
  // guide that failed to highlight.
  let st = null;
  let rect = null;
  for (let i = 0; i < 30 && !rect; i++) {
    st = await sw.evaluate(
      async (id) => await chrome.tabs.sendMessage(id, { type: 'DEBUG_GET_OVERLAY_STATE' }),
      tabId,
    );
    rect = st?.data?.rect ?? null;
    if (!rect) await page.waitForTimeout(500);
  }
  if (!rect) return { clicked: false, why: `等了 15 秒浮层仍没有矩形：${JSON.stringify(st)?.slice(0, 160)}` };
  const [x, y, w, h] = rect;
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  const who = `${step.descriptor?.role} "${step.descriptor?.name}"`;
  try {
    // Dispatch on what the step actually asks for. Clicking every step is why
    // five journeys from github.com all stalled on hop 1: the first step is a
    // search box with `action: 'input'`, and clicking a search box does
    // nothing, so the page never moved and the model kept re-proposing it.
    if (step.expectedUserAction === 'input') {
      if (!step.value) return { clicked: false, why: `要输入，但模型没给 value（只有用户知道该填什么）` };
      await page.mouse.click(cx, cy);
      // Select-all before typing, or the value is *appended* to whatever the
      // box already holds. GitHub's /repos page ships its search box
      // pre-filled with `contributed-by:@me`, so five rounds typed
      // `contributed-by:@men8n`, then `…men8nn8n`, then `…men8n-io/n8n` — a
      // query that can never match, so the model kept re-proposing the same
      // box and the run scored it as the model repeating itself. 16 of the 40
      // repeats measured on github.com were this one line. A person told
      // 「在这个框里输入 n8n」 replaces what is there; typing on top of it is
      // not the instruction being followed.
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(step.value, { delay: 30 });
      await page.keyboard.press('Enter');
      return { clicked: true, what: `在 ${who} 里输入「${step.value}」并回车` };
    }
    await page.mouse.click(cx, cy);
    return { clicked: true, what: `点了 ${who} @ ${cx},${cy}` };
  } catch (e) {
    return { clicked: false, why: `操作失败：${String(e).split('\n')[0]}` };
  }
}




/** Anything that means the run did not end where a healthy run ends. */
function anomaliesOf(t, entries) {
  const out = [];
  if (!t) return ['线程已不在：这一趟已经结束（终态即删，见 Run record），或者根本没有开始'];
  // An empty element table is never a model result — it means the extension
  // read a document with nothing operable in it (an image, a PDF), which in
  // this harness means it read the wrong tab. Say so in those words: read as
  // a model verdict instead, an empty table produces invented refs and empty
  // actions that look exactly like a prompt regression.
  if (t.table && !t.table.items?.length)
    out.push(`⚠️ 元素表为空（读到的是 ${t.table.url}）——仪器故障，本轮不构成对模型的观测`);
  if (t.ending) out.push(`ending=${t.ending}`);
  if (t.inflight) out.push(`结束时仍有 inflight=${t.inflight.kind}（线程被焊死）`);
  if (t.clarify) out.push(`停在澄清 ${t.clarify}`);
  if (t.spentSteps >= 12) out.push('整趟步数用满');
  out.push(`模型调用 ${t.callCount} 次，走了 ${t.spentSteps} 步`);
  for (const e of entries) {
    if (e.kind === 'note') out.push(`宿主说: ${String(e.text).slice(0, 80)}`);
    if (e.kind === 'ask') out.push(`反问: ${String(e.text).slice(0, 60)}`);
    if (e.kind === 'answer') out.push(`回答: ${String(e.text).slice(0, 60)}`);
  }
  return out;
}

/**
 * The overlay's own state, read from the page.
 *
 * The shadow root is closed, but the host element is not, and `Overlay.paint`
 * writes `data-status` onto it. Until now this spike watched only the panel
 * broadcasts and the thread record — both of which live in the worker — so
 * everything the *renderer* decided locally was invisible here. That blind
 * spot is why "点击后浮层提前说找不到" had to be reported by a human.
 */
const overlayNow = async () =>
  await page
    .evaluate(() => {
      const h = document.querySelector('[data-page-guide]');
      if (!h) return { present: false };
      return { present: true, status: h.dataset.status, display: getComputedStyle(h).display };
    })
    .catch(() => ({ present: false, unreadable: true }));

/** Record every `data-status` transition from now until the next read. A
 *  navigation destroys the observer, and that absence is itself a signal. */
const watchOverlay = async () =>
  await page
    .evaluate(() => {
      window.__st = [];
      window.__stObs?.disconnect();
      const h = document.querySelector('[data-page-guide]');
      if (!h) return false;
      window.__st.push(h.dataset.status);
      window.__stObs = new MutationObserver(() => window.__st.push(h.dataset.status));
      window.__stObs.observe(h, { attributes: true, attributeFilter: ['data-status'] });
      return true;
    })
    .catch(() => false);

const overlaySeen = async () => await page.evaluate(() => window.__st ?? []).catch(() => []);


/**
 * One journey: start the guide on the goal's page, walk it the way a user
 * would until it ends or stops moving, end it, and write one log row.
 * `round` is the goal's position in this run's goal set.
 */
async function trip(r, pass, round, plugins) {
  const label = `P${pass}-${r.id}`;
  const since = Date.now();
  const { tabId, thread } = await startGuide(r.url, r.goal, label);

  const row = { pass, round, id: r.id, type: r.type, goal: r.goal, url: r.url };
  /** Where each hop's window starts in the journey's wire (see `callsOf`). */
  const marks = [];

  if (!thread?.steps?.length) {
    row.result = '没有第一步';
    row.endUrl = page.url();
    row.anomalies = anomaliesOf(thread, await conversationOf(tabId));
    console.log(`  结果: ${row.result} — ${row.anomalies.join('; ') || '无线索'}`);
    await endTrip(row, tabId, since, plugins);
    const calls = callsOf(await wire(), marks, row);
    settle(row, thread, r, calls);
    // 也要落盘。这条路径过去直接 `continue`，于是最该被检查的失败——一步都没
    // 走出去的那些——反而是唯一进不了结构化日志的。
    row.shot = lastShot;
    logRecord({ ...row, thread });
    for (const c of calls) logRecord(c);
    return { row, result: resultOf(row, calls) };
  }

  row.step1 = thread.steps[thread.cursor]?.title;
  row.hops = [];

  // Walk the whole journey, not one hop. Every earlier run started a page or
  // two from the target, so the breakpoint *sequence* was length 1 and only
  // "can it cross one breakpoint" was ever tested. From github.com the same
  // goals are four or five hops deep, which is the shape the product is for.
  // Eight, not six. Three journeys ended one hop short of arriving — P2-7 with
  // 「workflows, (Directory)」 queued, P3-7 with 「Actions」, P2-4 back on the
  // repository page having just named the Releases entry. None of them was
  // lost; the budget was, and it went on recovering from one wrong turn: P3-7
  // spent hops 1-3 perfectly, took a wrong tab on hop 4, and burned 5 and 6
  // walking back to where hop 3 had already put it. Raising this alone would
  // only buy more room to wander, which is why 09 (reason before choosing the
  // ref) comes first; this is the headroom that lets a corrected journey land.
  for (let hop = 1; hop <= 8; hop++) {
    let before = await threadOf(tabId);
    if (!before?.steps?.length) break;
    // The next step leaves the site, and the product asks before showing it.
    // Before this, the harness waited for a highlight that the card was
    // holding back and ended the journey itself — every goal that has to
    // leave its site stopped there (spec A's smoke run, journey 6).
    if (before.pendingCrossSite) {
      const answer = await answerCrossSite(tabId, before);
      row.crossSite = [...(row.crossSite ?? []), { hop, ...answer }];
      console.log(
        `\n  [第 ${hop} 跳] 跨站确认卡 ${answer.from} → ${answer.to}：${answer.answered ? '点了「继续，带我去」' : `没答上——${answer.why}`}`,
      );
      if (!answer.answered) {
        row.hops.push({ hop, title: before.steps[before.cursor]?.title, stopped: answer.why });
        break;
      }
      before = await threadOf(tabId);
      if (!before?.steps?.length) break;
    }
    const callsBefore = before.callCount;
    const cursorBefore = before.cursor;
    const title = before.steps[before.cursor]?.title;
    const urlBefore = page.url();

    // The journey's wire is cleared once, when it starts, and each hop reads its
    // own window of it from here. Clearing it at every hop dropped whatever went
    // out between two hops — a second re-plan of a page that arrives in two
    // stages can go out while the previous hop's last screenshot is taken.
    const mark = (await wire()).length;
    marks.push({ hop, from: mark });
    // 两个面板页是在目标页之后创建的，所以目标页默认并不是窗口里的活动标签。
    // 真实用户看着的那一页总是活动的，让观测更贴近真实。
    await page.bringToFront().catch(() => {});
    await watchOverlay();
    const overlayBefore = await overlayNow();
    // The frame the *user* is looking at when this hop begins: the step is
    // highlighted and nothing has been clicked yet. Without it the folder only
    // ever shows aftermaths, and "what was on screen when it chose this" —
    // the question every repeat raises — has no frame to answer it.
    await shoot(label, `${hop}-第${hop}跳点击前`);
    const click = await clickCurrentStep(before, tabId);
    console.log(`\n  [第 ${hop} 跳] 指的是「${title}」 → ${click.clicked ? `点了 ${click.what}` : `未能点击：${click.why}`}`);
    if (!click.clicked) {
      row.hops.push({ hop, title, stopped: click.why });
      break;
    }
    await shoot(label, `${hop}-点完第${hop}跳`);
    await page.waitForTimeout(8000);
    const after = await waitForThread(tabId, (x) => x.inflight === null && x.callCount > callsBefore, {
      timeoutMs: 45_000,
      label: `第 ${hop} 跳之后的重规划`,
    });
    const final = after ?? (await threadOf(tabId));
    const w = (await wire()).slice(mark);
    // 两种话术都要认：模型自己判定到达说「看起来已经到了」，兜底判定打转说
    // 「引导在原地打转」。只认前者时，F5 拆分话术后兜底的那些就整批消失了，
    // 「done 收尾 9/15 → 2/15」于是成了我自己造出来的假象。
    const entries = await conversationOf(tabId);
    const doneMsg = entries.find(
      (e) => e.kind === 'note' && (String(e.text).startsWith('看起来已经到了') || String(e.text).startsWith('引导在原地打转')),
    );
    const next = final?.steps?.[final.cursor]?.title;
    // The entry for *this* hop, not the newest one: by the time a hop is
    // reported the model has usually answered again, and the newest entry is
    // the next step's.
    const mine = [...entries].reverse().find((e) => e.kind === 'step' && e.text === title);
    if (mine?.detail) console.log(`     [思考] ${mine.detail}`);
    const rounds = mine?.rounds ?? [];
    if (rounds.length) console.log(`     [工具] ${rounds.map((r) => `${r.tool}${r.got ? `（${r.got}）` : ''}`).join(' → ')}`);
    const statuses = await overlaySeen();
    const overlayAfter = await overlayNow();
    console.log(
      `     [浮层] 点击前=${overlayBefore.present ? overlayBefore.status : '不在'}` +
        ` 跃迁=${JSON.stringify(statuses)}` +
        ` 结束时=${overlayAfter.present ? `${overlayAfter.status}/${overlayAfter.display}` : '不在'}`,
    );
    console.log(`     URL ${page.url() === urlBefore ? '没变' : `→ ${page.url()}`}  调用 ${callsBefore}→${final?.callCount ?? '—'}  状态=${final ? (final.ending ?? 'active') : '已结束（线程已删）'}  下一步=${next ?? '—'}${doneMsg ? '  ⟨收到 done 提案⟩' : ''}`);
    // A cycle, not just an immediate repeat: 搜索按钮 → 搜索框 → 搜索按钮
    // reads as "no repeats" if each hop is only compared with the one before it.
    const seenBefore = row.hops.some((h) => h.title === next);
    row.hops.push({
      hop,
      title,
      urlAfter: page.url(),
      // The calls themselves are logged once each, as `kind: 'call'` rows.
      effects: w.filter((m) => m?.type === 'EFFECT_REQUEST' && m.kind === 'callModel').map((m) => m.effectId),
      calls: final?.callCount,
      next,
      doneProposed: Boolean(doneMsg),
      ending: final?.ending,
      overlay: { before: overlayBefore, transitions: statuses, after: overlayAfter },
      repeated: next === title || seenBefore,
    });
    await shoot(label, `${hop}-第${hop}跳重规划后`);
    if (doneMsg) row.done = true;
    // A run that ended — `done`, a quota, a safety stop — has no thread left:
    // the host records it and drops it at once, so `final` is null here and the
    // journey stops. (`done` used to be a proposal that left `status` active;
    // that is no longer the product.)
    if (!final || final.ending) break;
    if (!next) break;
    // "Nothing new to walk" is a question about the *thread*, not about whether
    // a model call happened. The old test was `!after` — no new call, so stop —
    // and it was wrong for every multi-step plan: a step that opens a dialog
    // does not move the page, so nothing re-plans (correctly), and the reducer
    // advances the cursor to the next step on its own. Five rounds were cut off
    // exactly there, each with an `input「Search or jump to」` still queued —
    // the step that types the repository name and moves the journey on. The
    // harness stopped one hop before the thing that works, then scored the
    // round as a failure.
    // Two signals, and deliberately not `rev`: the reducer bumps `rev` even for
    // an input it rejects, so keying on it would let a dead step spin until the
    // hop cap. A new call means a new plan; a moved cursor means the plan we
    // already have has a next step. Neither happening is the real dead end —
    // which is what the three frozen rounds looked like, cursor still 0 and the
    // same button re-proposed.
    const advanced =
      final !== null && (final.callCount !== callsBefore || final.cursor !== cursorBefore);
    if (!advanced) break;
  }

  const final0 = await threadOf(tabId);
  row.endUrl = page.url();
  row.anomalies = anomaliesOf(final0, await conversationOf(tabId));
  row.fired = (row.hops.length ?? 0) > 0;
  row.clicked = row.hops.some((h) => !h.stopped);
  await endTrip(row, tabId, since, plugins);
  const calls = callsOf(await wire(), marks, row);
  settle(row, final0, r, calls);
  console.log(`  走了 ${row.hops.length} 跳，${calls.length} 次模型调用，异常: ${row.anomalies.length ? row.anomalies.join('; ') : '无'}`);
  row.shot = lastShot;
  logRecord({ ...row, thread: final0 });
  for (const c of calls) logRecord(c);
  return { row, result: resultOf(row, calls) };
}

/**
 * What the journey is judged on, and the verdict: the final URL, what was on
 * screen when it stopped, and the programmatic Arrival (`arrival.ts`). Plus its
 * own count of calls and tokens, which the results file carries.
 */
function settle(row, thread, goal, calls) {
  row.lastStep = lastStepOf(thread, row.record, row.hops);
  row.verdict = judge(row.endUrl, row.lastStep, goal.accept);
  row.arrived = row.verdict.arrived;
  row.modelCalls = calls.length;
  row.tokens = calls.reduce(
    (t, c) => {
      const u = c.outcome?.usage;
      if (!u) return t;
      return { prompt: t.prompt + (u.prompt ?? 0), completion: t.completion + (u.completion ?? 0), cached: t.cached + (u.cachedPrompt ?? 0) };
    },
    { prompt: 0, completion: 0, cached: 0 },
  );
  const why = row.verdict.missed === 'url' ? '终点不对' : '最后一步不对';
  console.log(
    `  程序化判据：${row.verdict.arrived ? '到了' : `没到（${why}）`}——终点 ${row.endUrl}，最后一步 ${describeLast(row.lastStep)}`,
  );
}

/**
 * What was on screen when the journey stopped — the half of an Arrival a URL
 * cannot see. `thread` is the thread as it was before the harness ended the
 * journey; a journey that ended itself has none, and its Run record says how.
 */
function lastStepOf(thread, record, hops = []) {
  if (thread) {
    const s = thread.steps?.[thread.cursor];
    if (!s) return { kind: 'none', why: '线程还在，但没有待走的一步' };
    return {
      kind: 'step',
      role: s.descriptor?.role ?? '',
      name: s.descriptor?.name ?? '',
      action: s.expectedUserAction,
      ...(thread.pendingCrossSite ? { behindCrossSiteCard: true } : {}),
    };
  }
  if (record?.ending === 'model_done') {
    // What the user did just before the model said done: for an acting goal,
    // done counts only after a step that takes effect (`goals.ts`). Taken from
    // the hops the harness walked, not from the Run record's confirmed steps —
    // a Copy button changes nothing on the page, so its effect is `none`.
    const walked = hops.filter((h) => !h.stopped).at(-1);
    return { kind: 'done', ...(walked?.title ? { after: walked.title } : {}) };
  }
  return { kind: 'none', why: record ? `以 ${record.ending} 结束，屏幕上没有高亮` : '找不到 Run record' };
}

const describeLast = (s) =>
  s.kind === 'done'
    ? `done${s.after ? `（在「${s.after}」之后）` : ''}`
    : s.kind === 'step'
      ? `${s.action} ${s.role}「${s.name}」${s.behindCrossSiteCard ? '（在跨站确认卡后面）' : ''}`
      : `无（${s.why}）`;


/**
 * Ends the journey if it is still going, then reads the Run record every
 * journey leaves and checks it was made with the Plugins this run asked for.
 * A journey that was not is an instrument failure: it cannot be put down to
 * this run's combination, so it is not an observation of the model.
 */
async function endTrip(row, tabId, since, plugins) {
  await host({ type: 'END_GUIDE', tabId });
  const rec = await recordFor(row.goal, since);
  row.record = recordSummary(rec);
  if (rec)
    console.log(
      `  终态（Run record）: ${rec.ending} / 确认 ${rec.confirmation}，${rec.steps.length} 步，${rec.calls} 次调用，Plugin [${rec.plugins.join(', ')}]`,
    );
  const asked = [...plugins].sort().join(', ');
  const got = rec ? [...rec.plugins].sort().join(', ') : null;
  if (got !== asked) {
    row.instrumentFailure = rec ? `Run record 记下的 Plugin 组合是 [${got}]，这次指定的是 [${asked}]` : '找不到这一趟的 Run record';
    console.log(`  ⚠️ 仪器故障：${row.instrumentFailure}——这一趟不当作对模型的观测`);
  }
}

/**
 * One eval run. Everything that varies between runs is an argument, and all
 * of it goes into the log's first line before the first journey starts.
 */
export async function main({ run, goals, passes, plugins, model }) {
  const runDir = path.join(here, 'runs', run);
  if (fs.existsSync(runDir))
    throw new Error(`轮次 ${run} 已经存在（${path.relative(repo, runDir)}）：换一个 --run。评估从不覆盖别的轮次`);
  SHOTS = path.join(runDir, 'raw', 'shots');
  LOG_PATH = path.join(runDir, 'raw', 'log.ndjson');
  fs.mkdirSync(SHOTS, { recursive: true });
  const about = {
    run,
    startedAt: new Date().toISOString(),
    goals: goals.map((g) => g.id),
    passes,
    plugins,
    model,
    // The sites it signs into and the cookies it sets there: a run with
    // gitee in English and one with it in Chinese are not the same measurement.
    accounts: ACCOUNTS.filter((a) => goals.some((g) => new URL(g.url).hostname === a.host)).map((a) => ({
      host: a.host,
      cookies: (a.cookies ?? []).map((c) => `${c.name}=${c.value}`),
    })),
    fingerprint: fingerprint(),
  };
  logRecord({ kind: 'header', ...about });
  /** Versioned, unlike `raw/`: what the report, the pairing with the next run
   *  and the owner's verdicts are made from. */
  const RESULTS = path.join(runDir, 'results.json');
  const results = { ...about, trips: [] };

  await launch(model);
  // Every registered Plugin written on or off: one left unwritten runs at the
  // product's default, and the first line would claim a choice nobody made.
  await sw.evaluate(
    async (flags) => await chrome.storage.local.set(flags),
    Object.fromEntries(PLUGINS.map((p) => [pluginKey(p.name), plugins.includes(p.name)])),
  );
  console.log(`[setup] Plugin 组合：[${plugins.join(', ')}]`);
  for (const a of ACCOUNTS) if (goals.some((g) => new URL(g.url).hostname === a.host)) await signIn(a);

  const summary = [];
  for (let pass = 1; pass <= passes; pass++) {
    console.log(`\n${'█'.repeat(78)}\n█ 第 ${pass} 遍（共 ${passes} 遍）\n${'█'.repeat(78)}`);
    for (const [i, r] of goals.entries()) {
      const { row, result } = await trip(r, pass, i + 1, plugins);
      summary.push(row);
      // Rewritten after every journey: a run that dies halfway still leaves
      // the journeys it finished.
      results.trips.push(result);
      fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
    }
  }

  console.log(`\n${'#'.repeat(78)}\n# 汇总（${passes} 遍 × ${goals.length} 个目标）\n${'#'.repeat(78)}`);
  for (const r of summary) {
    const walked = (r.hops ?? []).map((h) => h.title).join(' → ');
    console.log(
      [
        `P${r.pass}·${r.id}`,
        `「${r.goal}」`,
        `${r.hops?.length ?? 0} 跳: ${walked || '—'}`,
        `收尾=${r.hops?.[r.hops.length - 1]?.stopped ? '走不动' : r.done ? '收到done' : '走完'}`,
        `重复=${(r.hops ?? []).filter((h) => h.repeated).length}`,
        `异常=${r.anomalies?.length ? r.anomalies.join(' / ') : '无'}`,
        ...(r.instrumentFailure ? [`仪器故障=${r.instrumentFailure}`] : []),
      ].join('  '),
    );
  }
  const hops = summary.reduce((n, r) => n + (r.hops?.length ?? 0), 0);
  const repeats = summary.reduce((n, r) => n + (r.hops ?? []).filter((h) => h.repeated).length, 0);
  const failures = summary.filter((r) => r.instrumentFailure).length;
  console.log(
    `\n总跳数 ${hops}（平均 ${(hops / summary.length).toFixed(1)}/趟）；重复 ${repeats}；以 done 收尾 ${summary.filter((r) => r.done).length}/${summary.length}；仪器故障 ${failures} 趟`,
  );
  console.log(`程序化判据：到了 ${summary.filter((r) => r.arrived).length}/${summary.length}（以你的判定为准）`);

  console.log(`\n结果：${path.relative(repo, RESULTS)}`);
  console.log(`完整记录：${path.relative(repo, LOG_PATH)}`);
  console.log(`截图：${path.relative(repo, SHOTS)}`);
  console.log(`录像：${path.relative(repo, path.join(SHOTS, 'video'))}（context 关闭后才落盘）`);
  await ctx.close();
}

/**
 * `npm run eval:task -- …` as `main`'s arguments. Anything it cannot read is
 * an error before a browser opens, never a default quietly taken instead.
 */
function fromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      ...SHARED_OPTIONS,
      goals: { type: 'string' },
      site: { type: 'string' },
      passes: { type: 'string', default: '3' },
    },
  });

  let goals = GOALS;
  if (values.goals) {
    const ids = values.goals.split(',').map((s) => s.trim());
    const unknown = ids.filter((id) => !GOALS.some((g) => g.id === id));
    if (unknown.length) throw new Error(`没有这些目标：${unknown.join(', ')}。可选：${GOALS.map((g) => g.id).join(', ')}`);
    goals = GOALS.filter((g) => ids.includes(g.id));
  }
  if (values.site) goals = goals.filter((g) => g.site === values.site);
  if (!goals.length) throw new Error('这组参数选不出任何目标');

  const passes = Number(values.passes);
  if (!Number.isInteger(passes) || passes < 1) throw new Error(`--passes ${values.passes}：要求正整数`);

  return { run: runIdFrom(values.run), goals, passes, plugins: pluginsFrom(values.plugins), model: modelFrom(values, env) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts;
  try {
    opts = fromArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  await main(opts);
}
