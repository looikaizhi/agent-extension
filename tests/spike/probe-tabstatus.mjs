/**
 * 取证：从用户按下回车那一刻起，`chrome.tabs.get(tabId).status` 走过哪些值？
 *
 * 09 第一版用 DOM 静默判「跳转落定」，在会重渲染的页面上永不满足。浏览器
 * 自己对「这一页还在路上吗」有权威答案，问题只是：它在关键的那 50 毫秒
 * （`target-lost` 触发的时刻）到底已经变成 loading 了没有。量出来再设计。
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = '/Users/kellylim/agent-extension';
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const udd = fs.mkdtempSync('/tmp/pg-tabstatus-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT, headless: false, ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1440,900'],
  viewport: { width: 1440, height: 900 },
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
const page = await ctx.newPage();
const tabId = () => sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);

async function sample(label, act) {
  await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const id = await tabId();
  const t0 = Date.now();
  const seen = [];
  const poll = setInterval(async () => {
    try {
      const s = await sw.evaluate(async (i) => {
        const t = await chrome.tabs.get(i);
        return { status: t.status, url: (t.url || '').slice(0, 52) };
      }, id);
      seen.push({ ms: Date.now() - t0, ...s });
    } catch { /* worker asleep */ }
  }, 40);
  await act();
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(poll);
  console.log(`\n══ ${label} ══`);
  let last = null;
  for (const s of seen) {
    const key = `${s.status}|${s.url}`;
    if (key !== last) { console.log(`  +${String(s.ms).padStart(5)}ms  ${s.status.padEnd(9)} ${s.url}`); last = key; }
  }
}

await sample('整页导航：搜索框输入 n8n 并回车', async () => {
  await page.getByRole('button', { name: /Search or jump to/ }).first().click();
  await page.waitForTimeout(700);
  await page.keyboard.type('n8n');
  await page.keyboard.press('Enter');
});

await sample('同页浮层：只点开搜索下拉，不导航', async () => {
  await page.getByRole('button', { name: /Search or jump to/ }).first().click();
});

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
