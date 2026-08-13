/**
 * Phase 2 of the eval loop: pure scoring, no browser.
 *
 * Every number here is computed without a model. That is the point — §7.4:
 *
 *   top-1 accuracy = recall@budget × representation distinguishability
 *                    × model conditional accuracy
 *
 * and the first two factors are measurable today. Step 2 swaps `scoreNodes` for
 * `await resolve()` and this file produces the real top-1 unchanged.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bindStep, matchCount } from '../../src/core/packs/bind.ts';
import { scoreNodes } from '../../src/core/locator/lexical.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURED = path.join(here, 'captured');

const GATES = {
  'recall@budget': { min: 95, unit: '%' },
  'ambiguity@budget': { max: 5, unit: '%' },
  target_ambiguity: { max: 3, unit: '%' },
  top1_ceiling: { min: 92, unit: '%' },
  emptyName: { max: 10, unit: '%' },
  'L-1 唯一且正确': { min: 90, unit: '%' },
  'L-2 多候选': { max: 8, unit: '%' },
  'L-3 无命中': { max: 2, unit: '%' },
  'L-4 唯一但错误': { max: 0, unit: '%' },
};

const files = fs.existsSync(CAPTURED)
  ? fs.readdirSync(CAPTURED).filter((f) => f.endsWith('.json'))
  : [];
if (files.length === 0) {
  console.error('没有采集产物。先跑 `npm run eval` 或 `node tests/eval/capture.mjs`。');
  process.exit(1);
}

/** Two rects are the same target if every edge agrees within a pixel. */
const sameRect = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.every((v, i) => Math.abs(v - b[i]) <= 1);

const acc = {
  targets: 0,
  recalled: 0,
  ambiguousTargets: 0,
  ceiling: 0,
  L1: 0,
  L2: 0,
  L3: 0,
  L4: 0,
  baselineTop1: 0,
  items: 0,
  dupRaw: 0,
  dupBudget: 0,
  emptyName: 0,
  emitted: 0,
  adv: 0,
};
const byGroup = new Map();
const rows = [];
const violations = [];

for (const file of files.sort()) {
  const { slug, table, targets } = JSON.parse(fs.readFileSync(path.join(CAPTURED, file), 'utf8'));

  // Page-level representation quality.
  const keyRaw = (i) => `${i.role}|${i.name}`;
  const keyBudget = (i) => `${i.path.join('›')}|${i.role}|${i.name}`;
  const count = (fn) => {
    const m = new Map();
    for (const i of table.items) m.set(fn(i), (m.get(fn(i)) ?? 0) + 1);
    return table.items.filter((i) => m.get(fn(i)) > 1).length;
  };
  // A fixture built so that (path, role, name) *cannot* be unique does not
  // belong in a page-level ambiguity average — that gate was calibrated on real
  // pages, and applying it to an adversarial corpus is a category error. It is
  // not exempted, it is asserted differently: every ambiguous item must carry a
  // stable `nth`, which is the whole point of having one.
  const adversarial = targets.some((t) => t.adversarial);
  if (adversarial) {
    const m = new Map();
    for (const i of table.items) m.set(keyBudget(i), (m.get(keyBudget(i)) ?? 0) + 1);
    const missing = table.items.filter((i) => m.get(keyBudget(i)) > 1 && i.nth === undefined);
    if (missing.length)
      violations.push(`${slug}: ${missing.length} 个不可区分项没有分到 nth`);
  } else {
    acc.items += table.items.length;
    acc.dupRaw += count(keyRaw);
    acc.dupBudget += count(keyBudget);
  }
  acc.adv += adversarial ? 1 : 0;
  acc.emptyName += table.stats.emptyName;
  acc.emitted += table.stats.emitted;

  const row = { slug, items: table.items.length, ms: table.stats.ms.total, L: [] };

  for (const t of targets) {
    acc.targets += 1;
    const g = byGroup.get(t.group) ?? { n: 0, recalled: 0, l1: 0 };
    g.n += 1;

    // recall@budget — can the target be named at all from the prompt table?
    const inTable = bindStep(t.descriptor, table).kind !== 'not_found';
    if (inTable) {
      acc.recalled += 1;
      g.recalled += 1;
    }

    // Distinguishability, measured on the projected table.
    const k = matchCount(t.descriptor, table);
    if (k > 1) acc.ambiguousTargets += 1;
    acc.ceiling += k > 0 ? 1 / k : 0;

    // L-0…L-4, decided geometrically against the live rect, not against the
    // extractor's own opinion of what it found.
    const ack = t.ack ?? {};
    let tier;
    if (ack.candidates?.length) tier = 'L2';
    else if (!ack.resolved) tier = 'L3';
    else tier = sameRect(ack.rect, t.trueRect) ? 'L1' : 'L4';
    acc[tier] += 1;
    if (tier === 'L1') g.l1 += 1;
    row.L.push(`${t.id}:${tier}`);
    if (tier === 'L4')
      violations.push(`L-4 ${slug}/${t.id}: 指到了 ${JSON.stringify(ack.rect)}，真值 ${JSON.stringify(t.trueRect)}`);

    // The zero-model lower bound: how far does plain lexical matching get?
    const top = scoreNodes(t.goal, table.items)[0];
    if (top && bindStep(t.descriptor, { ...table, items: [top.item] }).kind === 'unique')
      acc.baselineTop1 += 1;

    byGroup.set(t.group, g);
  }
  rows.push(row);
}

const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);
const metrics = {
  'recall@budget': pct(acc.recalled, acc.targets),
  ambiguity_raw: pct(acc.dupRaw, acc.items),
  'ambiguity@budget': pct(acc.dupBudget, acc.items),
  target_ambiguity: pct(acc.ambiguousTargets, acc.targets),
  top1_ceiling: pct(acc.ceiling, acc.targets),
  emptyName: pct(acc.emptyName, acc.emitted),
  'L-1 唯一且正确': pct(acc.L1, acc.targets),
  'L-2 多候选': pct(acc.L2, acc.targets),
  'L-3 无命中': pct(acc.L3, acc.targets),
  'L-4 唯一但错误': pct(acc.L4, acc.targets),
  'baseline top-1（词法，无门槛）': pct(acc.baselineTop1, acc.targets),
};

console.log(
  `\n语料：${files.length} 个 fixture，${acc.targets} 个标注目标` +
    `（其中 ${acc.adv} 个刻意不可区分，不计入页面级歧义率）\n`,
);
console.log('指标                              值        门槛      判定');
console.log('─'.repeat(64));
let failed = 0;
for (const [name, value] of Object.entries(metrics)) {
  const gate = GATES[name];
  let verdict = '—';
  if (gate) {
    const ok = gate.min !== undefined ? value >= gate.min : value <= gate.max;
    if (!ok) failed += 1;
    verdict = ok ? '✅' : '❌';
  }
  const want = gate ? (gate.min !== undefined ? `≥ ${gate.min}%` : `≤ ${gate.max}%`) : '';
  console.log(`${name.padEnd(34)}${String(value + '%').padEnd(10)}${want.padEnd(10)}${verdict}`);
}

console.log(
  '\n注：页面级 `ambiguity@budget` 的正式门槛跑在真实站点语料上（`npm run measure`）。' +
    '\n    这里的值只覆盖 Tier A，语料构成由我们自己决定，不能代表真实页面。',
);

console.log('\n分组 recall —— 告诉我们下一个该修什么');
console.log('─'.repeat(64));
for (const [group, g] of [...byGroup.entries()].sort((a, b) => a[1].recalled / a[1].n - b[1].recalled / b[1].n))
  console.log(`  ${group.padEnd(20)} recall ${pct(g.recalled, g.n)}%   L-1 ${pct(g.l1, g.n)}%   (n=${g.n})`);

if (violations.length) {
  console.log('\n硬门槛违例：');
  for (const v of violations) console.log('  ✗ ' + v);
}

console.log(`\n逐 fixture：`);
for (const r of rows) console.log(`  ${r.slug.padEnd(24)} ${String(r.items).padStart(3)} 控件 ${String(r.ms).padStart(6)}ms  ${r.L.join(' ')}`);

console.log(failed ? `\n❌ ${failed} 项未达门槛` : '\n✅ 全部门槛通过');
process.exit(failed ? 1 : 0);
