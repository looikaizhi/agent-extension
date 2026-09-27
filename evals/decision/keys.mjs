/**
 * Writes `evals/decision/annotations.json` from the recorded answers of a
 * batch picked with `batch.mjs --arrived` — keys from journeys the owner
 * judged 「到了」, instead of labels made by hand (`annotations.ts`).
 *
 * Run:
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/keys.mjs [--corpus evals/decision/batch-1.ndjson]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { keysFromAnswers } from './annotations.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values } = parseArgs({ options: { corpus: { type: 'string' } } });
const corpus = path.resolve(values.corpus ?? path.join(here, 'batch-1.ndjson'));
const states = fs
  .readFileSync(corpus, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const { annotations, skipped } = keysFromAnswers(states);
const file = path.join(here, 'annotations.json');
fs.writeFileSync(file, JSON.stringify(annotations, null, 2) + '\n');
const by = {};
for (const a of annotations) for (const i of a.intents) by[i] = (by[i] ?? 0) + 1;
console.log(
  `写入 ${path.relative(repo, file)}：${annotations.length}/${states.length} 个状态有标准答案（${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，')}）`,
);
for (const s of skipped) console.log(`  跳过 ${s.state}：${s.why}`);
