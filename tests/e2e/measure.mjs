/**
 * Re-measure disambiguation quality on the same five real pages that produced
 * the F-9/F-10 baseline, so the fix is judged against recorded numbers rather
 * than against a fixture I wrote myself.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const EXT = '/Users/kellylim/agent-extension/dist/chrome-mv3';
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const SITES = [
  ['github-repo', 'https://github.com/microsoft/TypeScript'],
  ['github-issues', 'https://github.com/microsoft/TypeScript/issues'],
  ['mdn-element', 'https://developer.mozilla.org/en-US/docs/Web/API/Element'],
  ['stripe-api', 'https://docs.stripe.com/api'],
  ['grafana-play', 'https://play.grafana.org/'],
];

// Recorded before the F-9 / F-10 / F-12 fixes.
const BASELINE = {
  'github-repo': { items: 150, amb: 0, ms: 13 },
  'github-issues': { items: 100, amb: 11, ms: 15 },
  'mdn-element': { items: 97, amb: 3.1, ms: 361 },
  'stripe-api': { items: 108, amb: 18.5, ms: 32 },
  'grafana-play': { items: 32, amb: 6.3, ms: 6 },
};

const udd = fs.mkdtempSync('/tmp/pg-measure-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  viewport: { width: 1440, height: 900 },
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });

const rows = [];
for (const [name, url] of SITES) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const tabId = await sw.evaluate(async (u) => {
      const [t] = await chrome.tabs.query({ url: u });
      return t?.id ?? null;
    }, url.replace(/(https?:\/\/[^/]+).*/, '$1/*'));

    const res = await sw.evaluate(
      async ([id, budget]) => {
        try {
          await chrome.tabs.sendMessage(id, { type: 'PING' });
        } catch {
          await chrome.scripting.executeScript({
            target: { tabId: id },
            files: ['/content-scripts/content.js'],
          });
        }
        return await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget });
      },
      [tabId, { maxNodes: 400 }],
    );
    const t = res?.data;
    if (!t) {
      rows.push({ name, error: JSON.stringify(res).slice(0, 90) });
    } else {
      const withPath = t.items.filter((i) => i.path.length > 0).length;
      rows.push({
        name,
        items: t.items.length,
        amb: t.ambiguity,
        pathPct: +((withPath / Math.max(1, t.items.length)) * 100).toFixed(1),
        ms: t.stats.ms.total,
        degraded: t.degraded,
        nth: t.items.filter((i) => i.nth !== undefined).length,
      });
    }
  } catch (e) {
    rows.push({ name, error: String(e.message).slice(0, 90) });
  }
  await page.close();
}

console.log('\n站点            控件   歧义率            有 path   nth   耗时              degraded');
console.log('─'.repeat(88));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.name.padEnd(16)}✗ ${r.error}`);
    continue;
  }
  const b = BASELINE[r.name];
  const d = (now, before, unit = '') => {
    const arrow = now === before ? '=' : now < before ? '↓' : '↑';
    return `${String(now) + unit} (${arrow} 原 ${before}${unit})`;
  };
  console.log(
    `${r.name.padEnd(16)}${String(r.items).padEnd(7)}${d(r.amb, b.amb, '%').padEnd(18)}` +
      `${(r.pathPct + '%').padEnd(10)}${String(r.nth).padEnd(6)}${d(r.ms, b.ms, 'ms').padEnd(18)}${r.degraded}`,
  );
}

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
