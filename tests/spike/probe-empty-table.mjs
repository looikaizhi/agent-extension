/**
 * Forensics, not a test: why does a fully-rendered GitHub search results page
 * extract as zero controls?
 *
 * Costs nothing and calls no model — this only runs `EXTRACT` and reads the
 * stats the extractor already records. `ExtractStats` carries the whole funnel
 * (`elementsScanned → candidates → visible → emitted`) plus `modalScoped`, so
 * the level at which the count collapses is a fact to be read here, not a
 * hypothesis to be argued.
 *
 * Run:
 *   npx wxt build && node tests/spike/probe-empty-table.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const udd = fs.mkdtempSync('/tmp/pg-probe-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1440,900'],
  viewport: { width: 1440, height: 900 },
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const page = await ctx.newPage();

/** The three selector families `findModalScope` tries, reported exactly as it
 *  would see them — plus whether each match is something a user can see. */
const modalReport = () =>
  page.evaluate(() => {
    const describe = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaModal: el.getAttribute('aria-modal'),
        hidden: el.hasAttribute('hidden'),
        ariaHidden: el.getAttribute('aria-hidden'),
        display: cs.display,
        visibility: cs.visibility,
        rect: [Math.round(r.width), Math.round(r.height)],
        checkVisibility: typeof el.checkVisibility === 'function' ? el.checkVisibility() : null,
        controlsInside: el.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]').length,
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 60)) || null,
      };
    };
    const openDialogs = [...document.querySelectorAll('dialog[open]')].filter((e) => e.matches(':modal'));
    const popovers = [...document.querySelectorAll('[popover]:popover-open')];
    const ariaModals = [
      ...document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]:not([data-page-guide]),[role="alertdialog"][aria-modal="true"]:not([data-page-guide])',
      ),
    ];
    return {
      totalControlsOnPage: document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]').length,
      openDialogs: openDialogs.map(describe),
      popovers: popovers.map(describe),
      ariaModals: ariaModals.map(describe),
      // Which one `findModalScope` would actually return, in its own order.
      wouldScopeTo: openDialogs[0]
        ? 'dialog[open]:modal'
        : popovers[0]
          ? '[popover]:popover-open'
          : ariaModals[0]
            ? '[role=dialog][aria-modal=true]'
            : null,
    };
  });

async function probe(label, url) {
  console.log(`\n══════ ${label} ══════\n${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // well past anything a replan would wait

  const m = await modalReport();
  console.log(`页面上的控件总数（浏览器视角）：${m.totalControlsOnPage}`);
  console.log(`findModalScope 会锁进：${m.wouldScopeTo ?? '（不锁，扫全文档）'}`);
  for (const [k, list] of Object.entries({ 'dialog[open]': m.openDialogs, popover: m.popovers, ariaModal: m.ariaModals }))
    for (const d of list) console.log(`   [${k}] ${JSON.stringify(d)}`);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  for (const budget of [
    { maxNodes: 400 },
    { maxNodes: 1000 },
  ]) {
    const r = await sw.evaluate(
      async ([id, b]) => {
        try {
          await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content-scripts/content.js'] });
        } catch {
          /* already injected */
        }
        return await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: b });
      },
      [tabId, budget],
    );
    const t = r?.data;
    console.log(
      `预算 ${JSON.stringify(budget)} → items=${t?.items?.length ?? 'ERR'}  modalScoped=${t?.stats?.modalScoped}  ` +
        `漏斗 scanned=${t?.stats?.elementsScanned} cand=${t?.stats?.candidates} visible=${t?.stats?.visible} emitted=${t?.stats?.emitted}` +
        `  emptyName=${t?.stats?.emptyName} shadow=${t?.stats?.shadowRoots} ms=${t?.stats?.ms?.total?.toFixed?.(1)}`,
    );
    if (!r?.ok) console.log(`   原始响应：${JSON.stringify(r)?.slice(0, 300)}`);
  }
}

await probe('对照组：GitHub 首页', 'https://github.com/');
await probe('故障现场：搜索结果页', 'https://github.com/search?q=n8n&type=repositories');
await probe('第二现场：任意仓库页', 'https://github.com/n8n-io/n8n');

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
