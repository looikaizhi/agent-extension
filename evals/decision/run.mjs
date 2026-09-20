/**
 * `npm run eval:decision` — answers Decision eval states again with a real
 * model and scores them (CONTEXT.md `Decision eval`).
 *
 * Every state is answered `--passes` times (3 by default) through today's
 * code: the guide's run loop, a real Provider, the Context rebuilt under this
 * run's Plugins (`replay.ts`). States the owner has annotated are scored right
 * or wrong; the rest still count toward failures and toward refs pointed off
 * the table or at sensitive controls (`score.ts`).
 *
 * Run:
 *   npm run eval:decision -- (--from <Task eval run> | --corpus <file>) [--annotations <file>]
 *     [--plugins none|a,b] [--passes 3] [--filter <regex>] [--limit <n>] [--concurrency 4]
 *     [--run <id>] [--base-url …] [--model …] [--price in,cached,out]
 *
 * `--from` takes every state out of a Task eval run's log; `--corpus` reads a
 * file `extract.mjs --out` wrote. Annotations default to
 * `evals/decision/annotations.json` when it exists; every one is checked
 * against its state's table before anything is sent. The result goes to
 * `evals/decision/runs/<id>/results.json`, versioned — what the run was made
 * with, the report, every answer verbatim — and is never overwritten.
 *
 * The baseline is the run `evals/decision/baseline.json` names (`{ "run": … }`).
 * When there is one, its answers are scored again against today's annotations
 * and the run is held to the gate (`gate.ts`): any check that fails makes the
 * exit code non-zero. Changing the baseline is that file, edited by hand —
 * after the corpus grows, or the default model changes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../fingerprint.ts';
import { SHARED_OPTIONS, modelFrom, pluginsFrom, providerConfig, readEnv, runIdFrom } from '../options.ts';
import { statesOf } from './corpus.ts';
import { replay } from './replay.ts';
import { gate } from './gate.ts';
import { decisionReport, stateRunsOf } from './report.ts';
import { checkAnnotation } from './score.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const rel = (p) => path.relative(repo, p);
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const ndjson = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const positive = (name, v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} ${v}：要求正整数`);
  return n;
};
const DEFAULT_ANNOTATIONS = path.join(here, 'annotations.json');

/** Everything a run needs, read and checked before a single request goes out. */
function setup(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      ...SHARED_OPTIONS,
      from: { type: 'string' },
      corpus: { type: 'string' },
      annotations: { type: 'string' },
      passes: { type: 'string', default: '3' },
      filter: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
    },
  });
  const env = readEnv(repo);
  if (!env.DEEPSEEK_API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY（.env.local）。');

  if (Boolean(values.from) === Boolean(values.corpus)) throw new Error('语料二选一：--from <真机轮次 id> 或 --corpus <文件>');
  let states;
  let source;
  let skipped = [];
  if (values.from) {
    const got = statesOf(ndjson(path.join(repo, 'evals/task/runs', values.from, 'raw/log.ndjson')));
    ({ states, skipped } = got);
    source = `真机轮次 ${values.from}`;
  } else {
    states = ndjson(path.resolve(values.corpus));
    source = rel(path.resolve(values.corpus));
  }
  if (values.filter) {
    const re = new RegExp(values.filter);
    states = states.filter((s) => re.test(s.id));
  }
  if (values.limit) states = states.slice(0, positive('limit', values.limit));
  if (!states.length) throw new Error('这组参数选不出任何状态');

  const annotationsFile = values.annotations
    ? path.resolve(values.annotations)
    : fs.existsSync(DEFAULT_ANNOTATIONS)
      ? DEFAULT_ANNOTATIONS
      : undefined;
  const annotations = annotationsFile ? JSON.parse(fs.readFileSync(annotationsFile, 'utf8')) : [];
  if (!Array.isArray(annotations)) throw new Error(`${rel(annotationsFile)}：应当是一组标注`);
  const byId = new Map(states.map((s) => [s.id, s]));
  for (const a of annotations) {
    const s = byId.get(a.state);
    if (s) checkAnnotation(s.context.table, a);
  }

  const run = runIdFrom(values.run);
  const out = path.join(here, 'runs', run, 'results.json');
  if (fs.existsSync(out)) throw new Error(`${rel(out)} 已经存在：结果不覆盖，换一个 --run`);

  const model = modelFrom(values, env);
  return {
    run,
    out,
    states,
    skipped,
    source,
    annotations,
    annotationsFile,
    plugins: pluginsFrom(values.plugins),
    passes: positive('passes', values.passes),
    concurrency: positive('concurrency', values.concurrency),
    model,
    cfg: providerConfig(model, env.DEEPSEEK_API_KEY),
  };
}

/** At most `limit` at a time; results in the order of `items`. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

let o;
try {
  o = setup(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const now = await fingerprint();
const recorded = [...new Set(o.states.map((s) => s.fingerprint))];
console.log(`Decision eval ${o.run}：${o.source}，${o.states.length} 个状态 × ${o.passes} 遍；Plugin [${o.plugins.join(', ')}]；${o.model.model}`);
if (o.skipped.length) console.log(`  日志里 ${o.skipped.length} 次调用没成为状态（没有 trace）`);
console.log(`  标注：${o.annotationsFile ? `${rel(o.annotationsFile)}，${o.annotations.length} 条` : '没有'}`);
if (recorded.some((f) => f !== now))
  console.log(`  语料录于快照指纹 ${recorded.join('、')}，当前代码是 ${now}：发给模型的东西不同，这正是要量的差别`);

const startedAt = new Date().toISOString();
const jobs = o.states.flatMap((s) => Array.from({ length: o.passes }, (_, i) => ({ s, pass: i + 1 })));
let answered = 0;
const replays = await pool(jobs, o.concurrency, async ({ s, pass }) => {
  const r = await replay(s, pass, o.plugins, o.cfg);
  answered += 1;
  if (answered % 25 === 0 || answered === jobs.length) console.log(`  已答 ${answered}/${jobs.length}`);
  return r;
});

const report = decisionReport({
  tables: new Map(o.states.map((s) => [s.id, s.context.table])),
  replays,
  annotations: o.annotations,
  ...(o.model.price ? { price: o.model.price } : {}),
});

const BASELINE = path.join(here, 'baseline.json');
let verdict = null;
if (fs.existsSync(BASELINE)) {
  const baseRun = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).run;
  const base = JSON.parse(fs.readFileSync(path.join(here, 'runs', baseRun, 'results.json'), 'utf8'));
  const tables = new Map(o.states.map((s) => [s.id, s.context.table]));
  // Only the baseline's states this corpus still has can be scored again.
  const baseTables = new Map([...tables].filter(([id]) => base.replays.some((r) => r.state === id)));
  verdict = {
    baseline: baseRun,
    baselineStates: new Set(base.replays.map((r) => r.state)).size,
    ...gate(stateRunsOf(baseTables, base.replays, o.annotations), stateRunsOf(tables, replays, o.annotations)),
  };
}

fs.mkdirSync(path.dirname(o.out), { recursive: true });
fs.writeFileSync(
  o.out,
  JSON.stringify(
    {
      run: o.run,
      startedAt,
      finishedAt: new Date().toISOString(),
      plugins: o.plugins,
      model: o.model,
      fingerprint: now,
      passes: o.passes,
      corpus: {
        source: o.source,
        states: o.states.length,
        fingerprints: recorded,
        hash: hash(o.states.map((s) => [s.id, s.context])),
      },
      annotations: {
        file: o.annotationsFile ? rel(o.annotationsFile) : null,
        count: o.annotations.length,
        hash: hash([...o.annotations].sort((a, b) => (a.state < b.state ? -1 : 1))),
      },
      report,
      gate: verdict,
      replays,
    },
    null,
    2,
  ) + '\n',
);

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const iv = (r) => (r?.interval ? `（95% 区间 ${pct(r.interval.lo)}–${pct(r.interval.hi)}）` : '');
const s = report.summary;
console.log(
  `\n${s.states} 个状态（有标注 ${s.annotated}）× ${o.passes} 遍 = ${s.runs} 次回答；网络错 ${s.transport} 次，不算模型答错${report.retried ? `；${report.retried} 次回答重试过` : ''}`,
);
console.log(`解析失败率 ${pct(s.parseFailureRate)}（${s.parseFailures} 次）；校验失败率 ${pct(s.violationRate)}（${s.violations} 次）`);
console.log(`指向表外 ${s.offTable} 次；指向敏感控件 ${s.sensitive} 次`);
console.log(`回答的意图：${Object.entries(report.intents).map(([k, v]) => `${k} ${v}`).join('，') || '—'}`);
if (s.annotated) {
  console.log(`意图准确率 ${pct(s.intent?.rate)}${iv(s.intent)}；第一步准确率 ${pct(s.firstStep?.rate)}${iv(s.firstStep)}`);
  console.log(`pass^k：${s.passK.map((p, i) => `pass^${i + 1} ${p.value == null ? '—' : p.value.toFixed(3)}`).join('，')}`);
  console.log(`稳定对 ${s.stability.alwaysRight}，稳定错 ${s.stability.alwaysWrong}，时对时错 ${s.stability.mixed}`);
} else console.log('意图准确率、第一步准确率、pass^k、稳定性：这批状态还没有标注');
const t = report.tokens;
console.log(`token：输入 ${t.prompt}（缓存命中 ${t.cached}），输出 ${t.completion}；成本 ${report.cost == null ? '没给单价' : report.cost.toFixed(4)}`);
if (report.latency) console.log(`每次回答的延迟：中位 ${(report.latency.medianMs / 1000).toFixed(1)}s，p90 ${(report.latency.p90Ms / 1000).toFixed(1)}s`);
if (report.unknownAnnotations.length) console.log(`有 ${report.unknownAnnotations.length} 条标注对应的状态不在这批里，没用上`);
console.log(`结果：${rel(o.out)}`);

if (!verdict) {
  console.log(`\n还没有基线（${rel(BASELINE)}）：不出门槛`);
} else {
  const g = verdict;
  console.log(
    `\n对照基线 ${g.baseline}：基线 ${g.baselineStates} 个状态（其中 ${g.states.baseline} 个在这批语料里），本次 ${g.states.candidate} 个，共有 ${g.states.common} 个`,
  );
  for (const k of g.checks) console.log(`  ${k.pass ? '✓' : '✗'} ${k.name}：${k.detail}`);
  console.log(g.pass ? '门槛：全部通过' : '门槛：没过');
  process.exit(g.pass ? 0 : 1);
}
