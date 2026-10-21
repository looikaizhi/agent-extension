// 侧栏那一半的效果图：把一段对话种进 storage.session，再按真侧栏的宽度截图。
// 零模型调用——这里要拍的是界面，不是模型。
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = path.join(repo, 'docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const udd = fs.mkdtempSync('/tmp/pg-panel-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  deviceScaleFactor: 2,
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://github.com/n8n-io/n8n', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(1500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://github.com/*' }))[0]?.id ?? null);
console.log('被引导的标签页', tabId);

const at = Date.now();
const conv = {
  tabId,
  rev: 6,
  entries: [
    { id: 'e1', at: at - 42_000, kind: 'said', text: '帮我把这个仓库的克隆地址拿到手' },
    {
      id: 'e2',
      at: at - 38_000,
      kind: 'step',
      text: 'Code',
      detail: '克隆地址在这个按钮展开的面板里——点开它，HTTPS 那一栏就是要复制的地址。',
      step: { entryId: 'e2', title: 'Code', index: 0, total: null, presentationId: `tab-${tabId}#1`, outcome: 'used' },
      axes: { evidence: 'model', check: 'unknown', binding: 'bound' },
      route: [{ at: '仓库主页', goal: '展开 Code 面板' }, { at: 'Code 面板', goal: '复制 HTTPS 地址' }],
      usage: { prompt: 4298, completion: 267 },
    },
    {
      id: 'e3',
      at: at - 12_000,
      kind: 'step',
      text: 'Copy url to clipboard',
      detail: 'HTTPS 那一栏右边的复制按钮，点一下地址就在剪贴板里了。',
      step: { entryId: 'e3', title: 'Copy url to clipboard', index: 1, total: null, presentationId: `tab-${tabId}#2` },
      axes: { evidence: 'model', check: 'unknown', binding: 'bound' },
      usage: { prompt: 5117, completion: 198 },
    },
    { id: 'e4', at: at - 2_000, kind: 'said', text: '这个仓库是做什么的？' },
    {
      id: 'e5',
      at: at - 1_000,
      kind: 'answer',
      text: 'n8n 是一个工作流自动化平台：把不同系统用可视化的方式连起来，也能在节点里写代码，支持自托管或云端，官方列出 400+ 个集成。这一页上「About」那一栏写的就是这句，旁边的标签（ai / automation / workflow）也是同一件事。',
      usage: { prompt: 5240, completion: 312 },
    },
  ],
};
await sw.evaluate(async ([id, c]) => await chrome.storage.session.set({ [`conv:tab-${id}`]: c }), [tabId, conv]);

// 模型配置那一页要拍「已经连上」的样子：第 2 步只有端点答过话才是活的。
// 这把 Key 是假的，只为把界面推到已配置那一支，界面上本来也是打码的。
await sw.evaluate(
  async (c) => await chrome.storage.local.set({ provider: c }),
  {
    preset: 'deepseek',
    protocol: 'openai-chat',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    apiKey: 'sk-screenshot-not-a-real-key-0000',
    requestByModel: { 'deepseek-v4-pro': { thinking: { type: 'disabled' } } },
    verdictByModel: { 'deepseek-v4-pro': 'supported', 'deepseek-flash': 'unsupported' },
    contextWindow: 128_000,
  },
);

const panel = await ctx.newPage();
await panel.setViewportSize({ width: 420, height: 660 });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
// 侧栏认的是「这个窗口里此刻 active 的标签页」。截图会把侧栏顶到前台，所以先让它
// 加载完、解析到自己那一刻的 active 标签页之前，把 GitHub 设回 active。
await sw.evaluate(async (id) => await chrome.tabs.update(id, { active: true }), tabId);
await panel.waitForTimeout(1800);
await panel.screenshot({ path: path.join(OUT, 'panel-conversation.png') });
console.log('① 对话 →', path.join(OUT, 'panel-conversation.png'));

// ② 工具与设置：外观在最上面，底下是三条去处
await panel.locator('button.to-settings').click();
await panel.waitForTimeout(900);
await panel.setViewportSize({ width: 420, height: 780 });
await panel.waitForTimeout(400);
await panel.screenshot({ path: path.join(OUT, 'panel-settings.png') });
console.log('② 设置 →', path.join(OUT, 'panel-settings.png'));

// ③ 模型配置：两步连接的形状——先连端点，再在端点上验收一个模型
await panel.getByRole('button', { name: /模型配置/ }).click();
await panel.setViewportSize({ width: 420, height: 1010 });
await panel.waitForTimeout(900);
await panel.screenshot({ path: path.join(OUT, 'panel-model.png') });
console.log('③ 模型配置 →', path.join(OUT, 'panel-model.png'));

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
