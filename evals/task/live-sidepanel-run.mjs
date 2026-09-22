/**
 * 一句话跑在**真侧栏**里 —— `chrome.sidePanel.open()` 开出来的那一个，不是把
 * `sidepanel.html` 当标签页打开的替身。NOT a test：真模型、真站点、真花钱。
 *
 * 为什么非有这一条不可：真侧栏发给 service worker 的消息**不带
 * `sender.documentId`**，也没有 frameId、没有 tab——标签页 panel 三样都有。以文档
 * 号认 panel 的宿主因此拒绝了真侧栏的每一次 `EFFECT_CLAIM`，一次模型调用也跑不
 * 起来，界面停在「正在想」。而六轮真跑和 263 条 e2e 全是拿标签页 panel 跑的，一路
 * 全绿（票 03）。标签页 panel 只能算冒烟，「侧栏 ↔ 宿主」的结论要在这里下。
 *
 * Playwright 连不上侧栏文档，所以什么都在宿主这边看：`storage.session` 里的线程与
 * 对话，以及 worker 上另挂的一个 `onMessage` 计数器。计数器按「哪个文档发的 + 第几
 * 秒」分桶——总数看不出名堂，分桶一眼就能分清三种结局：跑完了、没人接、空转。
 *
 * Run:
 *   npm run eval:sidepanel -- [--goal "……"] [--site https://…] [--model <name>]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFrom, providerConfig, readEnv } from '../options.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SITE = arg('site', 'https://github.com/n8n-io/n8n');
const GOAL = arg('goal', '带我去看这个仓库的 issue 列表');
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const env = readEnv(repo);
const udd = fs.mkdtempSync('/tmp/pg-sidepanel-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CHROME,
  headless: false, // 真侧栏只在有头的浏览器里存在
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${repo}/dist/chrome-mv3`, `--load-extension=${repo}/dist/chrome-mv3`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await sw.evaluate(async (c) => await chrome.storage.local.set({ provider: c }), providerConfig(modelFrom({}, env), env.DEEPSEEK_API_KEY));

// 宿主收到了什么、来自谁、第几秒。分桶的理由见文件头。
await sw.evaluate(() => {
  self.__seen = [];
  chrome.runtime.onMessage.addListener((m, sender) => {
    self.__seen.push({ type: m?.type, from: sender.documentId ? sender.documentId.slice(0, 6) : '无文档号（真侧栏就是这种）', at: Date.now() });
  });
});

const page = await ctx.newPage();
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url: `${new URL(url).origin}/*` }))[0]?.id, SITE);

// `chrome.sidePanel.open()` 要一次真实的用户手势，所以借一个扩展页面点一下。
const opener = await ctx.newPage();
await opener.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
await opener.evaluate(() => {
  const b = document.createElement('button');
  b.id = 'open-side-panel';
  b.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999';
  b.onclick = async () => await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  document.body.appendChild(b);
});
await opener.click('#open-side-panel');
await opener.waitForTimeout(2000);
const kinds = async () => (await sw.evaluate(async () => (await chrome.runtime.getContexts({})).map((c) => c.contextType).sort().join(',')));
console.log('① 真侧栏已打开，扩展上下文：', await kinds());

await page.bringToFront();
console.log(`② 问一句：「${GOAL}」`);
await opener.evaluate(async ([t, text]) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text }), [tabId, GOAL]);
await page.waitForTimeout(400);
// 发起用的这个标签页本身也是一个 panel。关掉它，剩下的只有真侧栏——这次调用
// 要么被真侧栏接走，要么永远没人跑。
await opener.close();
console.log('③ 发起用的标签页已关闭，扩展上下文：', await kinds());

const state = async () =>
  await sw.evaluate(async (id) => {
    const t = (await chrome.storage.session.get(`guide:tab-${id}`))[`guide:tab-${id}`] ?? null;
    const c = (await chrome.storage.session.get(`conv:tab-${id}`))[`conv:tab-${id}`] ?? null;
    return {
      inflight: t?.inflight?.kind ?? null,
      调用数: t?.callCount ?? null,
      对话: (c?.entries ?? []).map((e) => `${e.kind}:${String(e.text).replace(/\s+/g, ' ').slice(0, 24)}`),
    };
  }, tabId);

let last = null;
for (const at of [3, 8, 15, 25, 40]) {
  await page.waitForTimeout(at === 3 ? 3000 : 1000 * (at - Number(String(last?.at ?? 0))));
  last = { at, ...(await state()) };
  console.log(`   ${at}s：inflight=${last.inflight} 调用数=${last.调用数} 对话=${JSON.stringify(last.对话)}`);
  if (!last.inflight && last.对话.some((e) => /^(step|answer|note)/.test(e))) break;
}

const seen = await sw.evaluate(() => self.__seen ?? []);
const t0 = seen[0]?.at ?? 0;
const per = new Map();
for (const m of seen) {
  const v = per.get(m.from) ?? { 条数: 0, 起: (m.at - t0) / 1000, 止: 0, 类型: new Set() };
  v.条数++;
  v.止 = Math.round((m.at - t0) / 100) / 10;
  v.类型.add(m.type);
  per.set(m.from, v);
}
console.log('④ 宿主收到的消息：');
for (const [who, v] of per) console.log(`   ${who}：${v.条数} 条，${v.起}s–${v.止}s，${[...v.类型].join('/')}`);
console.log(
  last?.inflight
    ? '\n✗ 还挂着：这次调用没人跑完。上面那份分桶说明是没人接（对方一条都没发），还是空转（每秒几百条）。'
    : '\n✓ 真侧栏自己把这次调用跑完了。',
);

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
process.exit(last?.inflight ? 1 : 0);
