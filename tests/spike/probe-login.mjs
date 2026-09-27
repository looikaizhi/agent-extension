/** 取证：GitHub 登录到底停在哪一步。每一步都打印落地页与页面上的关键文案。 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(repo, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const CFT = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const udd = fs.mkdtempSync('/tmp/pg-login-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT, headless: false, args: ['--no-first-run', '--window-size=1280,860'],
  viewport: { width: 1280, height: 860 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const where = async (tag) => {
  const info = await page.evaluate(() => ({
    title: document.title,
    who: document.querySelector('meta[name="user-login"]')?.content || null,
    h1: document.querySelector('h1')?.textContent?.trim().slice(0, 70) || null,
    flash: [...document.querySelectorAll('.flash, [role=alert], .js-flash-alert')]
      .map((e) => e.textContent.trim().slice(0, 90)).filter(Boolean).slice(0, 3),
  }));
  console.log(`\n[${tag}] ${page.url().slice(0, 80)}`);
  console.log(`   title=${info.title} | user-login=${info.who} | h1=${info.h1}`);
  if (info.flash.length) console.log(`   提示: ${JSON.stringify(info.flash, null, 0)}`);
};

await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await where('登录页');
await page.fill('#login_field', env.GITHUB_EMAIL);
await page.fill('#password', env.GITHUB_PASSWORD);
await page.click('input[type="submit"], button[type="submit"]');
await page.waitForTimeout(6000);
await where('提交之后');   // ← 上次就是这一页被 goto 冲掉了
await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await where('回到首页');
await page.screenshot({ path: path.join(repo, 'tests/spike/login-probe.png') });
console.log('\n截图：tests/spike/login-probe.png');
await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
