/**
 * The labelling page for a batch: for every state, the goal, the steps
 * already walked, the element table and what the model answered then; the
 * owner picks the right intent and, for `point`, every step that counts.
 * What the owner picks is kept in the page's own database, one document per
 * state (collection `annotations`), and pulled back with `pull-annotations.mjs`.
 *
 * Run:
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     evals/decision/label.mjs [--corpus evals/decision/batch-1.ndjson]
 *
 * Writes `evals/decision/raw/label/index.html`; publish it with the `db`
 * capability. A state from a journey the owner judged 「到了」 (the run's
 * `verdicts/`) comes with the model's own answer as a suggestion; the rest
 * come with none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { guideAgent } from '@/agent/agents/guide/agent';
import { GUIDE_STEP_ACTIONS } from '@/agent/agents/guide/output/point';
import { docIdOf } from './annotations.ts';
import { describe } from './select.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values } = parseArgs({ options: { corpus: { type: 'string' } } });
const corpus = path.resolve(values.corpus ?? path.join(here, 'batch-1.ndjson'));
const states = fs
  .readFileSync(corpus, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

/** `runs/<run>/verdicts/<P遍-目标>.json`, as the report page's pull left them. */
const verdictCache = new Map();
function verdictOf(run, key) {
  if (!verdictCache.has(run)) {
    const dir = path.join(repo, 'evals/task/runs', run, 'verdicts');
    const v = {};
    if (fs.existsSync(dir))
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        v[f.slice(0, -5)] = j.verdict ?? j.data?.verdict;
      }
    verdictCache.set(run, v);
  }
  return verdictCache.get(run)[key];
}

/** The answer the state recorded, as far as the page shows it. */
function answerOf(s) {
  const o = s.answer;
  if (!o?.ok) return { intent: 'none' };
  const p = o.tool ? guideAgent.parseOutput(o.tool, String(o.value)) : guideAgent.parseTextOutput(String(o.value));
  if (p.kind !== 'ok') return { intent: p.kind === 'foreign' ? p.intent : 'unreadable' };
  const e = p.envelope;
  return {
    intent: e.intent,
    steps: e.intent === 'point' ? [{ ref: e.ref, action: e.action, why: e.why }] : [],
    why: e.why ?? null,
    question: e.question ?? null,
    options: e.options?.map((x) => ({ ref: x.ref, label: x.label })) ?? [],
  };
}

const where = new Map(describe(states).map((c) => [c.id, c]));
const data = states.map((s) => {
  const answer = answerOf(s);
  const judged = verdictOf(s.run, `P${s.pass}-${s.goal}`) === 'arrived';
  const first = answer.steps?.[0];
  const suggestion =
    judged && ['point', 'done', 'ask', 'read_doc'].includes(answer.intent)
      ? { intent: answer.intent, acceptable: answer.intent === 'point' && first ? [{ ref: first.ref, actions: [first.action] }] : [] }
      : null;
  const c = where.get(s.id);
  return {
    id: s.id,
    doc: docIdOf(s.id),
    goal: s.context.goal,
    goalId: s.goal,
    site: c.site,
    position: c.position,
    pass: s.pass,
    hop: s.hop,
    url: s.context.table.url,
    title: s.context.table.title,
    omitted: s.context.table.omitted,
    done: s.context.history.done.map((d) => ({ title: d.title, outcome: d.outcome })),
    route: s.context.history.route ?? [],
    items: s.context.table.items.map((i) => ({
      ref: i.ref,
      role: i.role,
      name: i.name,
      path: (i.path ?? []).join(' › '),
      ...(i.sensitive ? { sensitive: true } : {}),
    })),
    answer,
    suggestion,
  };
});

const out = path.join(here, 'raw/label');
fs.mkdirSync(out, { recursive: true });
const json = JSON.stringify({ states: data, actions: GUIDE_STEP_ACTIONS }).replace(/</g, '\\u003c');
// A function, not a string: page text is full of `$&` and `$'`, which a
// replacement string would read as patterns.
const html = fs.readFileSync(path.join(here, 'label.html'), 'utf8').replace('/*__DATA__*/null', () => json);
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(
  `标注页：${path.relative(repo, path.join(out, 'index.html'))}（${data.length} 个状态，${data.filter((d) => d.suggestion).length} 个带建议，${(Buffer.byteLength(html) / 1e6).toFixed(1)}MB）`,
);
