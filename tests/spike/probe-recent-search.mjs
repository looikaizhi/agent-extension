/**
 * 取证：github 的「最近搜索」存在哪里，清掉什么才能让它不串到下一趟。
 *
 * 第七轮 P2-4 回车时选中的是「最近搜索」里上一趟留下的 n8n-io/n8n-docs。harness
 * 要在每一趟之前清掉它，同时保持登录——所以先量：搜一次，然后依次
 *   B. 只清 localStorage 与 sessionStorage；
 *   C. 用 CDP 清掉这个 origin 除 cookie 以外的全部存储；
 * 每一步都重新打开搜索框，看最近搜索还在不在、登录名还在不在。
 *
 * 不装扩展、不调模型，不花钱。
 *
 * Run:
 *   node tests/spike/probe-recent-search.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(repo, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const CFT = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const SHOTS = path.join(here, 'probe-recent-search-shots');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/pg-recent-'), {
  executablePath: CFT, headless: false, args: ['--no-first-run', '--window-size=1440,900'], viewport: { width: 1440, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const who = async () => await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content || null);

await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
await page.fill('#login_field', env.GITHUB_EMAIL);
await page.fill('#password', env.GITHUB_PASSWORD);
await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.click('input[type="submit"], button[type="submit"]')]);
await page.waitForTimeout(4000);
await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
console.log(`登录名：${await who()}`);

/** Opens the header search, reads what the dropdown offers, closes it. */
async function recentOffered(tag) {
  await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.keyboard.press('/');
  await page.waitForTimeout(1500);
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
  );
  await page.screenshot({ path: path.join(SHOTS, `${tag}.png`) });
  await page.keyboard.press('Escape');
  const storage = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    idb: (await indexedDB.databases?.())?.map((d) => d.name) ?? '（不支持列举）',
  }));
  console.log(`\n[${tag}] 登录名=${await who()}`);
  console.log(`  下拉里的选项（${options.length}）：${JSON.stringify(options.slice(0, 12))}`);
  console.log(`  含 n8n-docs：${options.some((o) => o.includes('n8n-docs'))}`);
  console.log(`  localStorage 键：${JSON.stringify(storage.local)}`);
  console.log(`  sessionStorage 键：${JSON.stringify(storage.session)}`);
  console.log(`  IndexedDB：${JSON.stringify(storage.idb)}`);
}

// A — search once through the header box, the way the harness does.
await page.keyboard.press('/');
await page.waitForTimeout(1200);
await page.keyboard.type('n8n-io/n8n-docs', { delay: 30 });
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
console.log(`搜索后落在：${page.url()}`);
await recentOffered('A-搜过之后');

// B — local and session storage only.
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await recentOffered('B-清了local与session之后');

// C — everything the origin keeps except cookies.
const cdp = await ctx.newCDPSession(page);
await cdp.send('Storage.clearDataForOrigin', {
  origin: 'https://github.com',
  storageTypes: 'local_storage,session_storage,indexeddb,cache_storage,service_workers,websql',
});
await recentOffered('C-清了除cookie外的全部之后');

console.log(`\n截图：${path.relative(repo, SHOTS)}`);
await ctx.close();
