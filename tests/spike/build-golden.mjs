/**
 * Rebuilds the two arrays of `tests/unit/fixtures/golden-guide-envelopes.ts` —
 * `goldenGuideCalls` and `malformedToolCalls` — from the latest capture of
 * `guide-envelope-smoke.mjs` (`guide-smoke-log.ndjson`). Everything else in
 * that file (its header, the tables, the types) is left as it is; add the
 * capture's paragraph to the header by hand.
 *
 * Every string goes in verbatim through `JSON.stringify`, never retyped. Each
 * annotation is derived from `rawOutput` and the table alone — a plain
 * `JSON.parse` and a direct ref lookup — never by running the guide agent's
 * parser or validator, which is what keeps the tests that replay those
 * functions against this corpus from grading themselves.
 *
 * The corpus is replaced by the capture; the malformed calls accumulate. A
 * call the parser must survive stays one whatever the prompt says, so the
 * ones already in the fixture are kept, and older logs named on the command
 * line add theirs.
 *
 * Run (after the capture):
 *   node --experimental-transform-types --import ./evals/alias-loader-register.mjs \
 *     tests/spike/build-golden.mjs [older capture log…]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, malformedToolCalls as KEPT } from '../unit/fixtures/golden-guide-envelopes.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '../unit/fixtures/golden-guide-envelopes.ts');
const read = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    // The 150-item and 1-item tables only isolate fixed prompt overhead; a call
    // that errored has nothing to keep.
    .filter((r) => r.tableId in TABLES && !r.error);
const records = read(path.join(HERE, 'guide-smoke-log.ndjson'));
const older = process.argv.slice(2).flatMap((f) => read(path.resolve(f)));

/** The functions the guide offers — written out, not read off the registry,
 *  for the same reason the annotations are: this file must not ask the product
 *  what counts. */
const OFFERED = ['point', 'ask', 'explain', 'observe', 'wait_for', 'read_doc', 'done'];

/** Why a call is malformed, or `null` when it parses into something scorable. */
function malformedWhy(r) {
  // Seen live on 2026-09-17: well-formed `read_doc` arguments under the name
  // 「ne新tool」 — the endpoint garbled the function name itself.
  if (!OFFERED.includes(r.tool)) return '函数名不是提供给模型的任何一个';
  let args;
  try {
    args = JSON.parse(r.rawOutput);
  } catch {
    return 'arguments 不是合法 JSON';
  }
  return r.tool === 'point' && typeof args.ref !== 'string' ? 'point 调用没有 ref' : null;
}

const q = (s) => JSON.stringify(s);
const toolsText = (t) => (typeof t === 'string' ? t : JSON.stringify(t));

/** A claimed ref's element, and whether another element reads exactly like it. */
function lookup(table, ref) {
  const item = table.items.find((i) => i.ref === ref);
  if (!item) return { item: null, binding: 'unbound' };
  const twins = table.items.filter(
    (i) => i.role === item.role && i.name === item.name && JSON.stringify(i.path) === JSON.stringify(item.path) && i.nth === item.nth,
  );
  return { item, binding: twins.length > 1 ? 'ambiguous' : 'bound' };
}

const calls = [];
const malformed = [...KEPT];
const addMalformed = (r, why) => {
  if (!malformed.some((m) => m.rawOutput === r.rawOutput))
    malformed.push({ slice: r.slice, note: r.note, tableId: r.tableId, tool: r.tool, rawOutput: r.rawOutput, why });
};
for (const r of older) {
  const why = malformedWhy(r);
  if (why) addMalformed(r, why);
}
for (const r of records) {
  const base = { slice: r.slice, note: r.note, tableId: r.tableId, tool: r.tool };
  const why = malformedWhy(r);
  if (why) {
    addMalformed(r, why);
    continue;
  }
  const args = JSON.parse(r.rawOutput);
  const table = TABLES[r.tableId];
  const refs =
    r.tool === 'point'
      ? [args.ref]
      : r.tool === 'ask'
        ? (args.options ?? []).map((o) => o.ref)
        : r.tool === 'read_doc' && args.via_ref
          ? [args.via_ref]
          : r.tool === 'explain'
            ? (args.refs ?? [])
            : [];
  const sensitive = refs.some((ref) => lookup(table, ref).item?.sensitive);
  const offTable = refs.some((ref) => !lookup(table, ref).item);
  const tail = sensitive ? '引用了敏感元素。' : '未引用敏感元素。';
  let note;
  let binding = null;
  if (r.tool === 'point') {
    const found = lookup(table, args.ref);
    // A step that names a sensitive or missing ref is refused (R-e / R-a), so
    // it has nothing to bind — read off the table, not by asking the validator.
    binding = sensitive || offTable ? null : found.binding;
    const ea = args.expect_after;
    note = `intent=point；route ${(args.route ?? []).length} 跳；previous_step=${args.previous_step}；ref=${args.ref}（${found.item?.name ?? '不在表里'}）action=${args.action}，value=${JSON.stringify(args.value ?? null)}；expect_after=${ea ? `via_ref=${ea.via_ref}` : 'null'}；${tail}`;
  } else if (r.tool === 'ask') {
    note = `intent=ask；wants=${args.wants}；options ${refs.length} 项（${refs.join('/')}）；${tail}`;
  } else if (r.tool === 'explain') {
    note = `intent=explain；refs ${refs.length} 项（${refs.map((ref) => `${ref}「${lookup(table, ref).item?.name ?? '不在表里'}」`).join('/')}）；${tail}`;
  } else if (r.tool === 'read_doc') {
    note = `intent=read_doc；via_ref=${args.via_ref}（${lookup(table, args.via_ref).item?.name ?? '不在表里'}）；${tail}`;
  } else {
    note = `intent=${r.tool}${args.evidence ? `；evidence=${args.evidence}` : ''}；${tail}`;
  }
  calls.push({
    ...base,
    goal: r.goal,
    promptText: { system: r.system, user: r.user, tools: toolsText(r.tools) },
    rawOutput: r.rawOutput,
    usage: r.usage ?? null,
    annotation: { expectedIntent: r.tool, expectedFirstStepBinding: binding, shouldCountAsSensitiveProposed: sensitive, note },
  });
}

const callText = (c) => `  {
    slice: ${q(c.slice)},
    note: ${q(c.note)},
    goal: ${q(c.goal)},
    tableId: ${q(c.tableId)},
    promptText: {
      system: ${q(c.promptText.system)},
      user: ${q(c.promptText.user)},
      tools: ${q(c.promptText.tools)},
    },
    tool: ${q(c.tool)},
    rawOutput: ${q(c.rawOutput)},
    usage: ${JSON.stringify(c.usage)},
    annotation: {
      expectedIntent: ${q(c.annotation.expectedIntent)},
      expectedFirstStepBinding: ${c.annotation.expectedFirstStepBinding === null ? 'null' : q(c.annotation.expectedFirstStepBinding)},
      shouldCountAsSensitiveProposed: ${c.annotation.shouldCountAsSensitiveProposed},
      note: ${q(c.annotation.note)},
    },
  },`;
const malformedText = (m) => `  {
    slice: ${q(m.slice)},
    note: ${q(m.note)},
    tableId: ${q(m.tableId)},
    tool: ${q(m.tool)},
    rawOutput: ${q(m.rawOutput)},
    why: ${q(m.why)},
  },`;

/** Replaces the body of `export const <name>: … = [ … ];`. */
function replaceArray(src, head, body) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`夹具里找不到「${head}」`);
  const open = start + head.length;
  const close = src.indexOf('\n];', open);
  return src.slice(0, open) + (body ? `\n${body}` : '') + src.slice(close);
}

let src = fs.readFileSync(FIXTURE, 'utf8');
src = replaceArray(src, 'export const goldenGuideCalls: GoldenGuideCall[] = [', calls.map(callText).join('\n'));
src = replaceArray(src, 'export const malformedToolCalls: MalformedToolCall[] = [', malformed.map(malformedText).join('\n'));
fs.writeFileSync(FIXTURE, src);

const by = {};
for (const c of calls) by[c.tool] = (by[c.tool] ?? 0) + 1;
console.log(`重建夹具：语料 ${calls.length} 条（${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，')}），格式坏掉的 ${malformed.length} 条`);
console.log(`system 长 ${calls[0]?.promptText.system.length} 个字符`);
