/**
 * States where the journey already stood on its target and the model did not
 * say so — the set that measures the guide's "到了又兜出去" (walking on from a
 * page that already answers the goal).
 *
 * A state qualifies when its goal is a sighting goal (the user wants to see
 * something) and its page is one the goal's criterion accepts with `done`
 * (`evals/task/goals.ts`), while the model's recorded answer was anything but
 * `done`. Its key is `done`: by the owner's own criterion this page is the
 * end. Goals whose criterion also accepts a page further on, so that walking
 * on is not wrong either, are left out with `--exclude`.
 *
 * Run:
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/on-target.mjs <run id>… [--exclude a,b] \
 *     [--out evals/decision/on-target.ndjson] [--keys evals/decision/on-target-annotations.json]
 *
 * Then `eval:decision --corpus <out> --annotations <keys>`: the intent
 * accuracy there is how often the model now says 到了 where it walked on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GOALS } from '../task/goals.ts';
import { differences, statesOf } from './corpus.ts';
import { recordedIntent } from './select.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values, positionals: runs } = parseArgs({
  allowPositionals: true,
  options: { exclude: { type: 'string' }, out: { type: 'string' }, keys: { type: 'string' } },
});
if (!runs.length) {
  console.error('用法: node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/on-target.mjs <轮次>… [--exclude a,b] [--out 文件] [--keys 文件]');
  process.exit(1);
}
const exclude = new Set((values.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const out = path.resolve(values.out ?? path.join(here, 'on-target.ndjson'));
const keysOut = path.resolve(values.keys ?? path.join(here, 'on-target-annotations.json'));

/** The page is one the goal accepts, and accepts with a plain `done`. */
const isEnd = (goal, url) => goal.accept.some((a) => a.url.test(url) && a.lastSteps.some((l) => l.done === true && !l.after));

const picked = [];
for (const run of runs) {
  const rows = fs
    .readFileSync(path.join(repo, 'evals/task/runs', run, 'raw/log.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const s of statesOf(rows).states) {
    const goal = GOALS.find((g) => g.id === s.goal);
    if (!goal || goal.type !== 'sighting' || exclude.has(goal.id)) continue;
    if (!isEnd(goal, s.context.table.url) || recordedIntent(s) === 'done') continue;
    if (differences(s).length) continue; // a replay of anything else would be a different call
    picked.push(s);
  }
}
picked.sort((a, b) => (a.id < b.id ? -1 : 1));
fs.writeFileSync(out, picked.map((s) => JSON.stringify(s)).join('\n') + '\n');
fs.writeFileSync(keysOut, JSON.stringify(picked.map((s) => ({ state: s.id, intent: 'done' })), null, 2) + '\n');

const by = {};
for (const s of picked) by[s.goal] = (by[s.goal] ?? 0) + 1;
console.log(`${picked.length} 个状态停在目标页上、当时没说到了${exclude.size ? `（不含 ${[...exclude].join('、')}）` : ''}：${JSON.stringify(by)}`);
console.log(`语料 ${path.relative(repo, out)}；标准答案 ${path.relative(repo, keysOut)}`);
