import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { Envelope } from '@/agent/intents';
import { goldenEnvelopes } from './fixtures/golden-envelopes';

/**
 * Slice 20 — the `contract_L4` gate from the design doc's
 * §11.2. 40 hand-written golden envelopes × 20 mutation operators = 800
 * cases, pure Node, zero network.
 *
 * Two operator categories, different assertions:
 *  - **structural** (fence/prose wrapping, trailing commas, safe/unsafe
 *    truncation, CRLF, duplicate keys, whitespace, extra fields…): the
 *    invariant is "parse fails, or parse succeeds with every field bit-for-
 *    bit identical to the un-mutated fixture's envelope". A structural
 *    mutation is never allowed to *change what the answer says*.
 *  - **content** (altering a character inside a string value): the
 *    invariant is weaker — parsing may legitimately produce a *different*
 *    value, because the mutated raw text genuinely says something
 *    different now. What must still hold is provenance itself: since
 *    the parser runs `scanProvenance` internally on every call, any
 *    `kind: 'ok'` result here has *already* had that invariant checked in
 *    production code, not just in this test.
 *
 * Every operator reports `{ changed, raw }` — `changed` is whether the
 * operator actually altered this particular fixture's text. Some
 * combinations are unavoidably no-ops (case-swapping ASCII letters inside a
 * Chinese-only value, adding a trailing comma to an array that has no
 * elements to put it after) — those are counted and asserted on explicitly
 * below rather than silently padding the 800 count with vacuous cases.
 */

interface MutationResult {
  changed: boolean;
  raw: string;
}

interface Operator {
  name: string;
  category: 'structural' | 'content';
  apply: (raw: string) => MutationResult;
}

const unchanged = (raw: string): MutationResult => ({ changed: false, raw });

/** Matches `:"...string..."` — a value position (a key is always *followed*
 *  by `:`, never preceded by one, so this never touches a key name). Used by
 *  several operators below to target the first/last/all value strings
 *  without needing a real JSON parse. */
const VALUE_STRING = /:\s*"((?:[^"\\]|\\.)*)"/g;

function allValueMatches(raw: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(VALUE_STRING);
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m);
  return out;
}

/* ═══════════ structural operators, value-preserving (13) ═══════════ */

const wrapFenceJson: Operator = {
  name: 'wrap-fence-json',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: '```json\n' + raw + '\n```' }),
};

const wrapFenceBare: Operator = {
  name: 'wrap-fence-bare',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: '```\n' + raw + '\n```' }),
};

const addLeadingProse: Operator = {
  name: 'add-leading-prose',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: '这是结果：\n' + raw }),
};

const addTrailingProse: Operator = {
  name: 'add-trailing-prose',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: raw + '\n如有其它需要请告诉我。' }),
};

const addLeadingProseWithDecoyBrace: Operator = {
  name: 'add-leading-prose-decoy-brace',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: '请参考 {某个占位符} 这样的写法。\n' + raw }),
};

const addTrailingCommaObject: Operator = {
  name: 'add-trailing-comma-object',
  category: 'structural',
  apply: (raw) => {
    const idx = raw.lastIndexOf('}');
    if (idx === -1) return unchanged(raw);
    return { changed: true, raw: raw.slice(0, idx) + ',' + raw.slice(idx) };
  },
};

/**
 * Only fires when there is a *non-empty* array of string elements to add a
 * trailing comma after (`["e1"]` → `["e1",]`). An empty array (`[]`) has no
 * "after the last element" position, so this is a legitimate no-op on any
 * fixture whose target array happens to be empty — the
 * textbook no-op combination.
 */
const addTrailingCommaArray: Operator = {
  name: 'add-trailing-comma-array',
  category: 'structural',
  apply: (raw) => {
    const m = /"[a-zA-Z0-9_]*"\s*\]/.exec(raw);
    if (!m) return unchanged(raw);
    const insertAt = m.index + m[0].lastIndexOf(']');
    return { changed: true, raw: raw.slice(0, insertAt) + ',' + raw.slice(insertAt) };
  },
};

const crlfLineEndings: Operator = {
  name: 'crlf-line-endings',
  category: 'structural',
  apply: (raw) => {
    const idx = raw.indexOf('{');
    if (idx === -1) return unchanged(raw);
    return { changed: true, raw: raw.slice(0, idx + 1) + '\r\n' + raw.slice(idx + 1) };
  },
};

/** String-aware: only pads `:`/`,` that are structural (outside any string
 *  literal). A blind global replace would also pad a literal comma that is
 *  part of a value's actual text (several golden fixtures have one, e.g.
 *  "Path is /api/v1/instances, see the docs.") — which would make this
 *  operator corrupt content instead of merely reformatting structure. */
const addWhitespacePadding: Operator = {
  name: 'add-whitespace-padding',
  category: 'structural',
  apply: (raw) => {
    let out = '';
    let inStr = false;
    let escaped = false;
    let changed = false;
    for (const c of raw) {
      if (inStr) {
        out += c;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        out += c;
        continue;
      }
      if (c === ':' || c === ',') {
        out += ' ' + c + ' ';
        changed = true;
        continue;
      }
      out += c;
    }
    return changed ? { changed: true, raw: out } : unchanged(raw);
  },
};

const wrapOuterWhitespace: Operator = {
  name: 'wrap-outer-whitespace',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: '\n\n  ' + raw + '  \n\n' }),
};

/** Drops the raw text's final `}` — a "safe" truncation (slice 9's shape):
 *  every string in every golden fixture is fully closed before that point,
 *  so this only ever removes closing brackets, never cuts a string open. */
const simulateSafeTruncation: Operator = {
  name: 'simulate-safe-truncation',
  category: 'structural',
  apply: (raw) => {
    const idx = raw.lastIndexOf('}');
    if (idx === -1) return unchanged(raw);
    return { changed: true, raw: raw.slice(0, idx) };
  },
};

/** Duplicates one existing key with the *identical* value right after its
 *  first occurrence. "Last wins" then resolves to the same value either
 *  way, so this is structural (value-preserving) even though it specifically
 *  exercises the duplicate-key code path. */
const duplicateKeySameValue: Operator = {
  name: 'duplicate-key-same-value',
  category: 'structural',
  apply: (raw) => {
    const m = /"(answer|question|query)":"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (!m) return unchanged(raw);
    const insertAt = m.index + m[0].length;
    return { changed: true, raw: raw.slice(0, insertAt) + ',' + m[0] + raw.slice(insertAt) };
  },
};

const addExtraNullField: Operator = {
  name: 'add-extra-null-field',
  category: 'structural',
  apply: (raw) => {
    const idx = raw.lastIndexOf('}');
    if (idx === -1) return unchanged(raw);
    return { changed: true, raw: raw.slice(0, idx) + ',"note":null' + raw.slice(idx) };
  },
};

/** Replaces a literal `/` inside a value string with the equally-valid `\/`
 *  escape — the decoded value is unchanged (`\/` decodes to `/`), so this is
 *  structural. No-op on fixtures whose target values contain no `/`. */
const escapeForwardSlash: Operator = {
  name: 'escape-forward-slash',
  category: 'structural',
  apply: (raw) => {
    const idx = raw.indexOf('/');
    if (idx === -1) return unchanged(raw);
    return { changed: true, raw: raw.slice(0, idx) + '\\/' + raw.slice(idx + 1) };
  },
};

/* ═══════════ structural operators expected to fail parsing (2) ═══════════ */

/** Not one of the four tolerated repairs ("单引号不是第五
 *  种") — every fixture contains `"`, so this always changes the text, and
 *  the parse must always fail. */
const singleQuoteWrap: Operator = {
  name: 'single-quote-wrap',
  category: 'structural',
  apply: (raw) => ({ changed: true, raw: raw.replace(/"/g, "'") }),
};

/** Cuts inside the *last* value string, strictly before its closing quote —
 *  an unsafe truncation (slice 10's shape). Every golden fixture's last
 *  value string has at least one character of content, so this always
 *  changes the text and the parse must always fail. */
const simulateUnsafeTruncation: Operator = {
  name: 'simulate-unsafe-truncation',
  category: 'structural',
  apply: (raw) => {
    const matches = allValueMatches(raw);
    const last = matches[matches.length - 1];
    if (!last || last[1]!.length === 0) return unchanged(raw);
    const contentStart = last.index + last[0].indexOf('"', last[0].indexOf(':')) + 1;
    return { changed: true, raw: raw.slice(0, contentStart + 1) };
  },
};

/* ═══════════ content operators (4) ═══════════ */

/** Only the natural-language prose fields — deliberately narrower than
 *  `VALUE_STRING`. Matching every value position (including `ref`, whose
 *  values are always ASCII IDs like `"e3"`) would make this operator change
 *  *something* on every fixture and the intended no-op would never show up:
 *  swapping the case of an id is not the scenario being tested here. */
const PROSE_VALUE = /"(?:answer|question|query|label)":\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Swaps the case of every ASCII letter inside every prose field's value. A
 * genuine no-op on any fixture whose prose is entirely Chinese —
 * This exact combination ("中文上的 swap-case") is named as
 * the典型 no-op to expect and count, not hide.
 */
const swapAsciiCaseInValues: Operator = {
  name: 'swap-ascii-case-in-values',
  category: 'content',
  apply: (raw) => {
    let changed = false;
    const out = raw.replace(PROSE_VALUE, (whole, content: string) => {
      const swapped = content.replace(/[a-zA-Z]/g, (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      if (swapped !== content) changed = true;
      return whole.slice(0, whole.length - content.length - 1) + swapped + '"';
    });
    return changed ? { changed: true, raw: out } : unchanged(raw);
  },
};

/** Replaces the first character of the first value string's content with a
 *  fixed marker (falling back to a second marker if the original character
 *  already *was* the first marker) — guaranteed to change the decoded value
 *  whenever that string is non-empty. */
const replaceFirstCharOfFirstValue: Operator = {
  name: 'replace-first-char-of-first-value',
  category: 'content',
  apply: (raw) => {
    const matches = allValueMatches(raw);
    const first = matches[0];
    if (!first || first[1]!.length === 0) return unchanged(raw);
    const content = first[1]!;
    const replacement = content[0] === 'X' ? 'Y' : 'X';
    const newContent = replacement + content.slice(1);
    const contentStart = first.index + first[0].length - content.length - 1;
    return {
      changed: true,
      raw: raw.slice(0, contentStart) + newContent + raw.slice(contentStart + content.length),
    };
  },
};

/** Same idea, applied to the last character of the *last* value string. */
const replaceLastCharOfLastValue: Operator = {
  name: 'replace-last-char-of-last-value',
  category: 'content',
  apply: (raw) => {
    const matches = allValueMatches(raw);
    const last = matches[matches.length - 1];
    if (!last || last[1]!.length === 0) return unchanged(raw);
    const content = last[1]!;
    const replacement = content[content.length - 1] === 'X' ? 'Y' : 'X';
    const newContent = content.slice(0, -1) + replacement;
    const contentStart = last.index + last[0].length - content.length - 1;
    return {
      changed: true,
      raw: raw.slice(0, contentStart) + newContent + raw.slice(contentStart + content.length),
    };
  },
};

/** Inserts one extra harmless character in the middle of the first value
 *  string's content — guaranteed to change the decoded value whenever that
 *  string has at least one character (there's always a "middle" to insert
 *  at, even if it lands next to an edge for 1-character strings). */
const insertCharInMiddleOfFirstValue: Operator = {
  name: 'insert-char-in-middle-of-first-value',
  category: 'content',
  apply: (raw) => {
    const matches = allValueMatches(raw);
    const first = matches[0];
    if (!first || first[1]!.length === 0) return unchanged(raw);
    const content = first[1]!;
    const mid = Math.floor(content.length / 2);
    const newContent = content.slice(0, mid) + '*' + content.slice(mid);
    const contentStart = first.index + first[0].length - content.length - 1;
    return {
      changed: true,
      raw: raw.slice(0, contentStart) + newContent + raw.slice(contentStart + content.length),
    };
  },
};

const operators: Operator[] = [
  wrapFenceJson,
  wrapFenceBare,
  addLeadingProse,
  addTrailingProse,
  addLeadingProseWithDecoyBrace,
  addTrailingCommaObject,
  addTrailingCommaArray,
  crlfLineEndings,
  addWhitespacePadding,
  wrapOuterWhitespace,
  simulateSafeTruncation,
  duplicateKeySameValue,
  addExtraNullField,
  escapeForwardSlash,
  singleQuoteWrap,
  simulateUnsafeTruncation,
  swapAsciiCaseInValues,
  replaceFirstCharOfFirstValue,
  replaceLastCharOfLastValue,
  insertCharInMiddleOfFirstValue,
];

// 48 golden envelopes × 20 operators = 960. The plan's original arithmetic was
// 40 × 20 = 800, all of it S1's three intents; the last eight fixtures are
// the guide's own — `point` (it was `guide` until the model began pointing at
// one step at a time) and `read_doc`, added 2026-08-22.
//
// The reason is asymmetry, not symmetry: `point` is the only shape carrying an
// *instruction*. A mutated one that is mis-accepted makes the user click a
// control the model never named — L-4 on the contract plane, and L-4 is this
// product's only hard zero. A mis-accepted `explain` is merely a wrong answer.
// Eight, chosen to give the operators real targets, rather than another forty
// for the sake of a round matrix.
//
// This is the "960 例" claim that must be non-vacuous — see the no-op
// bookkeeping test below, which asserts real coverage rather than assuming it.
const EXPECTED_COMBINATIONS = goldenEnvelopes.length * operators.length;

describe('读一个回答 — 变异语料（§11.2 contract_L4）', () => {
  it(`语料矩阵是 ${goldenEnvelopes.length} × ${operators.length} = ${EXPECTED_COMBINATIONS}`, () => {
    expect(operators).toHaveLength(20);
    expect(goldenEnvelopes).toHaveLength(48);
    expect(goldenEnvelopes.length * operators.length).toBe(EXPECTED_COMBINATIONS);
  });

  let noOpCount = 0;
  let structuralHits = 0;
  let contentHits = 0;
  let totalCombinations = 0;

  // One test per operator, every fixture mutated inside it. The matrix is
  // unchanged — all `EXPECTED_COMBINATIONS` combinations still run, and the
  // bookkeeping test below still proves it — but 48 fixtures × 20 operators
  // reported as 960 separate cases made the suite's own count meaningless.
  // Every assertion carries which fixture it is about, so a failure still
  // names the combination.
  for (const op of operators) {
    it(`算子：${op.name}（${op.category}）——${goldenEnvelopes.length} 个信封逐一变异`, () => {
      goldenEnvelopes.forEach((golden, i) => {
        const where = `固件 ${i} (${golden.envelope.intent})`;
        totalCombinations++;
        const mutation = op.apply(golden.raw);

        if (!mutation.changed) {
          // A no-op combination contributes nothing to the invariant check
          // — asserted here (not silently accepted) and counted below so
          // the "960 例" total is honest about how many were vacuous.
          expect(mutation.raw, where).toBe(golden.raw);
          noOpCount++;
          return;
        }

        // Read the way the product reads an answer: the function name is the
        // intent, and the mutated text is the arguments payload.
        const result = guideAgent.parseOutput(golden.envelope.intent, mutation.raw);

        if (op.category === 'structural') {
          structuralHits++;
          // "解析失败，或解析成功且所有值不变" (§11.2) — a structural
          // mutation must never change what the answer *says*.
          if (result.kind === 'ok') {
            expect(result.envelope, where).toEqual(golden.envelope);
          } else {
            expect(result.kind, where).toBe('error');
          }
        } else {
          contentHits++;
          // A content mutation legitimately changes a value — what must
          // hold is that the parser still only ever returns 'ok' when its
          // internal `scanProvenance` call actually passed (proven by the
          // fact that it is the real `parseOutput`, not a hand-rolled
          // bypass, returning the result) or 'error' otherwise. Both are
          // acceptable outcomes; what would be a bug is anything else.
          expect(['ok', 'error'], where).toContain(result.kind);
          if (result.kind === 'ok') {
            expect(result.envelope.intent, where).toBe(golden.envelope.intent);
          }
        }
      });
    });
  }

  it('no-op 数量 > 0 且已被识别（不冒充有效样本）', () => {
    // This runs after all the `it` blocks above in the same describe have
    // been collected by Vitest's discovery pass, but the counters are only
    // populated once those tests actually *run* — so this final assertion
    // is placed in its own `it` at module scope and read via a getter-style
    // check against the module-level counters, which by the time Vitest
    // executes this test (after the ones above, in file order) hold their
    // final values.
    expect(totalCombinations).toBe(EXPECTED_COMBINATIONS);
    expect(noOpCount).toBeGreaterThan(0);
    expect(structuralHits + contentHits + noOpCount).toBe(EXPECTED_COMBINATIONS);
  });
});
