/**
 * Picks a labelled batch out of a Task eval run (`select.ts`) and writes it as
 * a corpus file — the states `eval:decision --corpus` answers, versioned.
 *
 * Run:
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/batch.mjs <run id> [--arrived] [--size 60] [--out evals/decision/batch-1.ndjson]
 *
 * Only states that rebuild byte for byte through today's code are candidates
 * (`corpus.ts`): a replay of anything else would measure a different call.
 * With `--arrived`, only states of journeys the owner judged 「到了」 — the ones
 * whose recorded answers can serve as keys (`keys.mjs`). The same run, flag
 * and size always give the same batch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { differences, statesOf } from './corpus.ts';
import { describe, selectBatch } from './select.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: 'string', default: '60' }, out: { type: 'string' }, arrived: { type: 'boolean', default: false } },
});
const [run] = positionals;
const size = Number(values.size);
if (!run || !Number.isInteger(size) || size < 1) {
  console.error('用法: node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/batch.mjs <轮次 id> [--size 60] [--out 文件]');
  process.exit(1);
}
const out = path.resolve(values.out ?? path.join(here, 'batch-1.ndjson'));

const rows = fs
  .readFileSync(path.join(repo, 'evals/task/runs', run, 'raw/log.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const { states, skipped } = statesOf(rows);
const good = states.filter((s) => differences(s).length === 0);
console.log(`轮次 ${run}：${states.length} 个状态，${good.length} 个能逐字节重拼${skipped.length ? `；${skipped.length} 次调用没有 trace` : ''}`);

let pool = good;
if (values.arrived) {
  const dir = path.join(repo, 'evals/task/runs', run, 'verdicts');
  const verdictOf = (s) => {
    const f = path.join(dir, `P${s.pass}-${s.goal}.json`);
    if (!fs.existsSync(f)) return undefined;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.verdict ?? j.data?.verdict;
  };
  pool = good.filter((s) => verdictOf(s) === 'arrived');
  console.log(`只取你判了「到了」的趟：${pool.length} 个状态`);
}

const cands = describe(pool);
const ids = new Set(selectBatch(cands, size));
const batch = pool.filter((s) => ids.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, batch.map((s) => JSON.stringify(s)).join('\n') + '\n');

const NAMES = { opening: '开局', middle: '中途', end: '临近终点' };
const tally = {};
for (const c of cands.filter((c) => ids.has(c.id))) {
  const k = `${c.site}｜${NAMES[c.position]}｜${c.intent}`;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log(`挑出 ${batch.length} 个（要 ${size} 个）：`);
for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`写入 ${path.relative(repo, out)}（${(fs.statSync(out).size / 1e6).toFixed(1)}MB）`);
