/**
 * Takes a Task eval run's log apart into Decision eval states and checks that
 * every one of them replays as the same call (`corpus.ts`).
 *
 * Run:
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/extract.mjs <run id> [--out <file>]
 *
 * Without `--out` it only checks. With it, the states that rebuild byte for
 * byte are written one per line; a state that does not is never written — a
 * replay that is not the recorded call would measure something else. Exits
 * non-zero when any state fails the check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../fingerprint.ts';
import { differences, statesOf } from './corpus.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const [run] = positionals;
if (!run) {
  console.error('用法: node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/extract.mjs <轮次 id> [--out <文件>]');
  process.exit(1);
}

const log = path.join(repo, 'evals/task/runs', run, 'raw/log.ndjson');
const rows = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const { states, skipped } = statesOf(rows);
console.log(`轮次 ${run}：${states.length} 个状态${skipped.length ? `；${skipped.length} 次调用没成为状态` : ''}`);
for (const s of skipped) console.log(`  跳过 ${s.call}：${s.why}`);

const now = fingerprint();
const then = states[0]?.fingerprint;
// 同 run.mjs：陈述两个值，不替下面那道逐字节核对下结论——它就在几行之后，
// 说得比指纹准。（指纹口径改于 2026-09-24，跨口径的两个值不可比。）
if (then && then !== now)
  console.log(
    `⚠️ 这一轮的快照指纹是 ${then}，当前代码是 ${now}：下面的逐字节核对会说清还剩多少条对得上。要整批抽出来，就用产生它的那一版代码。`,
  );

const good = [];
const bad = [];
for (const s of states) {
  const parts = differences(s);
  if (parts.length) bad.push({ id: s.id, parts });
  else good.push(s);
}
console.log(`逐字节核对：${good.length} 个通过，${bad.length} 个对不上`);
for (const b of bad) console.log(`  ${b.id}：${b.parts.join('、')} 对不上`);

if (values.out) {
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, good.map((s) => JSON.stringify(s)).join('\n') + (good.length ? '\n' : ''));
  console.log(`写入 ${good.length} 个状态：${path.relative(repo, path.resolve(values.out))}`);
}
process.exit(bad.length ? 1 : 0);
