/**
 * 把真实世界里撞见的一句话，录成决策语料的一条状态。
 *
 * 决策语料原本只有一个来源：任务 eval 的日志（`extract.mjs`）。但任务 eval 的到达
 * 判据里没有「答案就是终点」这种结局（`LastStep` 只有 done/step/none），所以
 * 「用户问了一句、模型该指路还是该回答」这一类局面，根本没法从那里拆出来——而
 * 2026-09-21 在真机上出错的恰恰是这一类。
 *
 * 这个录制器只做一件事：在真页面上问一句，把那一次模型调用按**语料读的那个行格式**
 * 写下来（`kind:'header'` 一行 + `kind:'call'` 若干行，见 `decision/corpus.ts`）。写出
 * 来的就是一份任务 eval 形状的 run 日志，所以下游一个字都不用改：
 *
 *   npm run eval:record -- --url <网址> --say <一句话> --id <给这条状态起的名字>
 *   node … evals/decision/extract.mjs <它打印出来的 run id> --out evals/decision/batch-2.ndjson
 *
 * NOT a test：真站点、真模型、真花钱。一次调用而已，但它确实在花钱。
 *
 * 别的参数：`--pass N`（同一句话录第几遍，语料里靠它区分）、`--wait 毫秒`（等回答的上限）、
 * `--model`、`--base-url`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { fingerprint } from '../fingerprint.ts';
import { modelFrom, providerConfig, readEnv } from '../options.ts';
import { callsOf } from '../task/calls.mjs';
import { TRACE_ENABLED_KEY } from '@/agent/flags';
import { PLUGINS, pluginKey } from '@/agent/context/plugins';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    say: { type: 'string' },
    id: { type: 'string' },
    pass: { type: 'string', default: '1' },
    wait: { type: 'string', default: '90000' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
  },
});
if (!values.url || !values.say) {
  console.error('用法: npm run eval:record -- --url <网址> --say <一句话> [--id <名字>] [--pass 1] [--wait 90000]');
  process.exit(1);
}
const GOAL_ID = values.id ?? new URL(values.url).hostname.replace(/^www\./, '').replace(/\./g, '-');
const PASS = Number(values.pass);
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const env = readEnv(repo);
const cfg = providerConfig(modelFrom({ model: values.model, baseUrl: values['base-url'] }, env), env.DEEPSEEK_API_KEY);

const udd = fs.mkdtempSync('/tmp/pg-record-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${repo}/dist/chrome-mv3`, `--load-extension=${repo}/dist/chrome-mv3`],
  viewport: { width: 1280, height: 860 },
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
// The trace is what carries the bytes the model actually read; without it a
// state cannot prove it replays as the same call, and `extract.mjs` drops it.
//
// Every registered Plugin is written on or off explicitly, and the set is
// written into the header: a state records what the call was actually made
// with, and a replay rebuilds the Context under that same set. Left to the
// product's defaults, a page with a site Skill records a user message the
// rebuild cannot reproduce — which is exactly what `extract.mjs` refuses.
const PLUGIN_NAMES = PLUGINS.map((p) => p.name);
await sw.evaluate(
  async ([c, traceKey, on]) =>
    await chrome.storage.local.set({ provider: c, [traceKey]: true, ...Object.fromEntries(on.map((k) => [k, true])) }),
  [cfg, TRACE_ENABLED_KEY, PLUGIN_NAMES.map(pluginKey)],
);

const page = await ctx.newPage();
await page.goto(values.url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url: `${new URL(url).origin}/*` }))[0]?.id, values.url);

/**
 * Two panels, for the same reason the Task eval opens two: a document does not
 * hear its own `sendMessage`, so the one running the call cannot record the
 * result it sends. The other one hears both halves.
 */
const tap = async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => {
    window.__wire = [];
    chrome.runtime.onMessage.addListener((m) => void window.__wire.push({ at: Date.now(), msg: m }));
  });
  return p;
};
const panels = [await tap(), await tap()];
const wire = async () => {
  const seen = (await Promise.all(panels.map((p) => p.evaluate(() => window.__wire)))).flat();
  const byKey = new Map(seen.map((e) => [`${e.msg?.type}:${e.msg?.effectId ?? ''}:${e.at}`, e]));
  return [...byKey.values()].sort((a, b) => a.at - b.at).map((e) => e.msg);
};

await page.bringToFront();
await page.waitForTimeout(500);
console.log(`① 在 ${values.url} 上问：「${values.say}」`);
await panels[0].evaluate(async ([t, text]) => await chrome.runtime.sendMessage({ type: 'SAID', tabId: t, text }), [tabId, values.say]);

const until = Date.now() + Number(values.wait);
let calls = [];
while (Date.now() < until) {
  await page.waitForTimeout(500);
  calls = callsOf(await wire(), [], { pass: PASS, id: GOAL_ID });
  if (calls.length && calls.every((c) => c.outcome)) break;
}
if (!calls.length) {
  console.error('② 一次模型调用都没录到——检查模型配置，或者这一页上内容脚本能不能用');
  await ctx.close();
  process.exit(1);
}

const run = `rec-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${GOAL_ID}`;
const dir = path.join(repo, 'evals/task/runs', run, 'raw');
fs.mkdirSync(dir, { recursive: true });
const rows = [
  {
    kind: 'header',
    run,
    startedAt: new Date().toISOString(),
    goals: [GOAL_ID],
    passes: PASS,
    plugins: PLUGIN_NAMES,
    model: cfg.model,
    fingerprint: fingerprint(),
  },
  ...calls,
];
fs.writeFileSync(path.join(dir, 'log.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.log(`② 录到 ${calls.length} 次调用，这一句在这一页上模型选了：${calls.map((c) => c.outcome?.tool ?? '(没回答)').join('、')}`);
console.log(`③ 写在 evals/task/runs/${run}/raw/log.ndjson`);
console.log(`   拆成语料：node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/extract.mjs ${run} --out <文件>`);

await ctx.close();
fs.rmSync(udd, { recursive: true, force: true });
