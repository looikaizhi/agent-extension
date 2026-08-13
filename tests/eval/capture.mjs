/**
 * Phase 1 of the eval loop: drive the real extension against the Tier A corpus
 * and dump everything a scorer needs.
 *
 * Phase 2 (`score.mjs`) runs in Node with no browser, which is the whole point
 * of `project()` being pure — and it means a regression can be re-scored later
 * against a captured artefact instead of re-run against a moving page.
 *
 * Ground truth is geometric. Each fixture marks its target with
 * `data-eval="<id>"`; we read that element's rect straight from the page, then
 * ask the renderer to resolve the annotation's descriptor and compare the two
 * rects. Nothing about that comparison can be fooled by the extractor agreeing
 * with itself — which is exactly the failure mode a metric harness must not
 * have.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const EXT = path.join(repo, 'dist/chrome-mv3');
const CFT =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const FIXTURES = path.join(here, 'fixtures');
const OUT = path.join(here, 'captured');
const annotations = JSON.parse(fs.readFileSync(path.join(here, 'annotations.json'), 'utf8'));

const server = http
  .createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]);
    const file = path.join(FIXTURES, name);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  })
  .listen(0);
const PORT = server.address().port;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const udd = fs.mkdtempSync('/tmp/pg-eval-');
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: CFT,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  viewport: { width: 1280, height: 860 },
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));

const BUDGET = { maxNodes: 150, viewportBands: 1 };
let failures = 0;

for (const [slug, notes] of Object.entries(annotations)) {
  const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/${slug}.html`, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const tabId = await sw.evaluate(
      async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null,
      `http://127.0.0.1:${PORT}/*`,
    );

    const ex = await sw.evaluate(
      async ([id, b]) =>
        await chrome.tabs.sendMessage(id, { type: 'EXTRACT', profile: 'interactive', budget: b }),
      [tabId, BUDGET],
    );
    if (!ex?.ok) throw new Error(ex?.message ?? 'EXTRACT failed');

    const targets = [];
    for (const note of notes) {
      // Ground truth: where the annotated element actually is on screen.
      const trueRect = await page.evaluate((id) => {
        // Must pierce shadow roots: half the corpus exists to test them, and a
        // plain `querySelector` silently returns null there — which the scorer
        // would then have reported as an L-4, the one hard-zero gate. A metric
        // harness that can manufacture its own worst finding is worse than none.
        const deep = (root) => {
          const hit = root.querySelector(`[data-eval="${id}"]`);
          if (hit) return hit;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              const inner = deep(el.shadowRoot);
              if (inner) return inner;
            }
          }
          return null;
        };
        const el = deep(document);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }, note.id);

      // What the product would actually point at, through the whole pipeline.
      const ack = await sw.evaluate(
        async ([id, cmd]) => await chrome.tabs.sendMessage(id, { type: 'HIGHLIGHT', command: cmd }),
        [
          tabId,
          {
            sessionId: 'eval',
            snapshotId: ex.data.snapshotId,
            mode: 'locate',
            progress: { index: 0, total: 1 },
            autoScroll: false,
            step: {
              descriptor: note.descriptor,
              expectedUserAction: 'click',
              title: note.goal,
              confidence: 1,
            },
          },
        ],
      );
      await sw.evaluate(async (id) => await chrome.tabs.sendMessage(id, { type: 'CLEAR' }), tabId);
      targets.push({ ...note, trueRect, ack: ack?.ok ? ack.data : { failure: 'transport' } });
    }

    fs.writeFileSync(
      path.join(OUT, `${slug}.json`),
      JSON.stringify({ slug, table: ex.data, targets }, null, 1),
    );
    console.log(
      `✅ ${slug.padEnd(24)} ${String(ex.data.items.length).padStart(3)} 控件  ` +
        `歧义 ${String(ex.data.ambiguity).padStart(5)}%  ${ex.data.stats.ms.total}ms`,
    );
  } catch (e) {
    failures += 1;
    console.log(`❌ ${slug.padEnd(24)} ${String(e.message).split('\n')[0].slice(0, 70)}`);
  }
  await page.close();
}

await ctx.close();
server.close();
fs.rmSync(udd, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
