// 用今天的构建，在真站点上拍几张效果图。零模型调用：直接给渲染层发一条
// HIGHLIGHT，画的是产品自己的浮层，绑定也是产品自己的 descriptor 绑定。
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const repo = '/Users/kellylim/agent-extension';
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = path.join(repo, 'docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const udd = fs.mkdtempSync('/tmp/pg-shots-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.setViewportSize({ width: 1440, height: 900 });

const target = process.argv[2] ?? 'https://github.com/n8n-io/n8n';
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(2500);

const tabId = await sw.evaluate(async (u) => {
  const [t] = await chrome.tabs.query({ url: `${new URL(u).origin}/*` });
  return t?.id ?? null;
}, target);
console.log('tabId', tabId);

// 内容脚本：静态注册已经会自己进去，这里只是确认它在答话
// 外观（夜航 / 景深 × 白天 / 黑夜）：浮层跟着 storage 走，所以先写再画。
const look = process.argv[7];
if (look) {
  const [style, mode] = look.split(':');
  await sw.evaluate(async (a) => await chrome.storage.local.set({ appearance: a }), { style, mode });
  await page.waitForTimeout(600);
  console.log('外观', look);
}

const ping = await sw.evaluate(
  async (id) => await chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }).catch((e) => String(e)),
  tabId,
);
console.log('ping', JSON.stringify(ping));

const ex = await sw.evaluate(
  async (id) =>
    await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: { maxNodes: 400 } }, { frameId: 0 }),
  tabId,
);
console.log('items', ex?.data?.items?.length, 'omitted', ex?.data?.omitted);
fs.writeFileSync('/tmp/table.json', JSON.stringify(ex?.data?.items?.slice(0, 80) ?? [], null, 1));

const want = process.argv[3] ?? 'Code';
const item = (ex?.data?.items ?? []).find((i) => i.name === want) ?? (ex?.data?.items ?? []).find((i) => (i.name || '').includes(want));
console.log('picked', JSON.stringify(item));
if (!item) process.exit(1);

const ack = await sw.evaluate(
  async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }, { frameId: 0 }),
  [
    tabId,
    {
      sessionId: `tab-${tabId}`,
      presentationId: `tab-${tabId}#1`,
      snapshotId: ex.data.snapshotId,
      view: ex.data.url,
      mode: 'guide',
      progress: { index: 0, total: null },
      autoScroll: true,
      step: {
        ref: item.ref,
        descriptor: { role: item.role, name: item.name, ...(item.path?.length ? { scope: item.path.at(-1) } : {}) },
        expectedUserAction: 'click',
        title: process.argv[4] ?? item.name,
        detail: process.argv[5] ?? '克隆地址在这个按钮展开的面板里——点开它，HTTPS 那一栏就是要复制的地址。',
      },
    },
  ],
);
console.log('ack', JSON.stringify(ack));
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, process.argv[6] ?? 'guide-on-github.png') });
console.log('拍好了 →', path.join(OUT, process.argv[6] ?? 'guide-on-github.png'));

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
