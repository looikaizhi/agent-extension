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
const { values, positionals } = parseArgs({
  allowPositionals: true,
  // 可以给多份：标注页的数据库是一路攒下来的，里面同时有好几批的标注，而每一
  // 条都要对着**它自己那一批**的元素表核对。只给一份，别批的标注会被判成
  // 「这批语料里没有这个状态」而整批拉取失败。
  options: { corpus: { type: 'string', multiple: true }, out: { type: 'string' } },
});
const [dir] = positionals;
if (!dir) {
  console.error('用法: node --experimental-transform-types --import ./evals/alias-loader-register.mjs evals/decision/pull-annotations.mjs <read_db 的目录> [--corpus 文件]');
  process.exit(1);
}
const docsDir = path.join(path.resolve(dir), 'annotations');
const corpora = (values.corpus ?? [path.join(here, 'batch-1.ndjson')]).map((c) => path.resolve(c));
const states = corpora.flatMap((f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l)),
);
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
// 一批一份：`--corpus` 可以给好几份（数据库里同时有好几批的标注），但写出去的
// 那一份仍然按批分开——跑分时 `--annotations` 同样可以给好几份，合起来才是完整
// 的那把尺子。
const file = values.out ? path.resolve(repo, values.out) : path.join(here, 'annotations.json');
fs.writeFileSync(file, JSON.stringify(annotations, null, 2) + '\n');
const by = {};
for (const a of annotations) for (const i of a.intents) by[i] = (by[i] ?? 0) + 1;
console.log(
  `写入 ${path.relative(repo, file)}：${annotations.length}/${states.length} 个状态有标注（${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，') || '—'}）`,
);
