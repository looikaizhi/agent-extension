/**
 * Rebuilds a run's `results.json` from its raw log, with today's `resultOf`.
 *
 * For a run recorded before a result carried what the report needs now — the
 * pages each hop left, the sensitive-pointing count, the last frame. The log
 * holds all of it; the old results file simply did not copy it out.
 *
 * Run:
 *   node --experimental-strip-types --import ./evals/alias-loader-register.mjs \
 *     evals/task/rebuild-results.mjs <run id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultOf } from './results.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = process.argv[2];
if (!run) {
  console.error('用法: node --experimental-strip-types --import ./evals/alias-loader-register.mjs evals/task/rebuild-results.mjs <轮次 id>');
  process.exit(1);
}
const dir = path.join(here, 'runs', run);
const rows = fs.readFileSync(path.join(dir, 'raw', 'log.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const { kind: _kind, ...about } = rows.find((r) => r.kind === 'header');
const shots = fs.existsSync(path.join(dir, 'raw', 'shots')) ? fs.readdirSync(path.join(dir, 'raw', 'shots')).filter((f) => f.endsWith('.png')).sort() : [];

/** The newest frame the harness named after this journey (`shoot()`): its
 *  label with everything but letters and digits dropped. */
const lastShotOf = (t) => {
  const label = `P${t.pass}-${t.id}`.replace(/[^0-9A-Za-z一-龥]+/g, '');
  return shots.filter((f) => f.split('-')[1] === label).at(-1) ?? null;
};

const trips = rows.filter((r) => r.round !== undefined && r.pass !== undefined);
const calls = rows.filter((r) => r.kind === 'call');
const results = {
  ...about,
  trips: trips.map((t) => resultOf(t, calls.filter((c) => c.pass === t.pass && c.id === t.id), t.shot ?? lastShotOf(t))),
};
fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`重建 ${path.relative(path.resolve(here, '../..'), path.join(dir, 'results.json'))}：${results.trips.length} 趟，最后一帧找到 ${results.trips.filter((t) => t.shot).length} 张`);
