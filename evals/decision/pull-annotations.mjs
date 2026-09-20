/**
 * The owner's annotations, pulled from the labelling page's database, into
 * `evals/decision/annotations.json` — the file `eval:decision` scores against.
 *
 * Pull first with the Artifact tool: `read_db`, collection `annotations`,
 * `out_dir` some directory — the documents land in `<dir>/annotations/`. Then:
 *
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/pull-annotations.mjs <dir> [--corpus evals/decision/batch-1.ndjson]
 *
 * Every document is checked against its state's table (`annotations.ts`);
 * one that fails stops the pull and nothing is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkedAnnotations } from './annotations.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { corpus: { type: 'string' } } });
const [dir] = positionals;
if (!dir) {
  console.error('用法: node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/pull-annotations.mjs <read_db 的目录> [--corpus 文件]');
  process.exit(1);
}
const docsDir = path.join(path.resolve(dir), 'annotations');
const corpus = path.resolve(values.corpus ?? path.join(here, 'batch-1.ndjson'));
const states = fs
  .readFileSync(corpus, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const docs = fs.existsSync(docsDir)
  ? fs
      .readdirSync(docsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8')))
  : [];

let annotations;
try {
  annotations = checkedAnnotations(docs, states);
} catch (e) {
  console.error(`没写入：${e.message}`);
  process.exit(1);
}
const file = path.join(here, 'annotations.json');
fs.writeFileSync(file, JSON.stringify(annotations, null, 2) + '\n');
const by = {};
for (const a of annotations) by[a.intent] = (by[a.intent] ?? 0) + 1;
console.log(
  `写入 ${path.relative(repo, file)}：${annotations.length}/${states.length} 个状态有标注（${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，') || '—'}）`,
);
