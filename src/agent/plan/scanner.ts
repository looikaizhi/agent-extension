/**
 * Provenance scanner — the second, independently written half of the
 * contract-plane L-4 gate (ADR 0005, docs/adr/0005-provenance-scanner-shares-no-code.md).
 *
 * `contract.ts` turns a noisy model response into a clean JS value by
 * stripping fences, discarding surrounding prose, forgiving a trailing
 * comma and, in one narrow case, repairing a truncated tail. Every one of
 * those steps is a place a bug could quietly *invent* a value instead of
 * merely cleaning one up. Checking that invariant by re-running the same
 * code would only prove the parser agrees with itself.
 *
 * So this file re-derives, from scratch, everything it needs to answer one
 * question per path: "does the ORIGINAL text contain a literal here, and
 * does it decode to the value the parser produced?" It never imports from
 * `./contract`, never receives `contract.ts`'s cleaned/repaired text (only
 * the untouched `raw` the model actually returned), and never calls any of
 * its named helpers. The only line shared with `contract.ts` anywhere in
 * this file is the built-in `JSON.parse`, and only ever to decode ONE
 * string literal this file has already isolated by its own char-by-char
 * scan — never to discover structure. Do not "deduplicate" this file
 * against `contract.ts`'s fence/prose/bracket helpers, however similar they
 * look: that would silently turn this gate into "the parser agrees with
 * itself", which is the exact failure mode ADR 0005 exists to prevent.
 */

export type Path = readonly (string | number)[];

export interface ScanViolation {
  path: Path;
  reason: string;
}

/**
 * Verifies the design doc's §5.2 invariant for every scalar reachable in
 * `parsed`: a string at path P must have, at the same path in `raw`, a JSON
 * string literal that decodes (via `JSON.parse` on that one isolated
 * literal) to the same value. Numbers/booleans/null are compared as literal
 * text, not converted-then-compared (see `scalarLiteralOk` below).
 *
 * Returns `null` when every scalar checks out, or the first violation found
 * (path order: depth-first, object keys in `Object.keys` order, array
 * elements in index order — deterministic, not "whichever" is found first).
 */
export function scanProvenance(raw: string, parsed: unknown): ScanViolation | null {
  if (typeof parsed !== 'object' || parsed === null) {
    // Every S1 envelope is a top-level object. A bare top-level scalar/array
    // has no path-addressable root to anchor on, so there is nothing this
    // scanner can usefully check — callers never hit this for real envelope
    // output, but it must not throw.
    return null;
  }
  const root = findRoot(raw, parsed as Record<string, unknown> | unknown[]);
  if (root === null) return { path: [], reason: '原始文本中找不到与解析结果顶层字段匹配的对象' };
  return walkValue(parsed, raw, root, []);
}

/* ═══════════ char-level primitives — independent of contract.ts ═══════════ */

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function skipWs(text: string, i: number): number {
  let j = i;
  while (j < text.length && isWs(text[j]!)) j++;
  return j;
}

/**
 * `text[i]` must be `"`. Walks forward tracking backslash-escapes to find
 * the matching unescaped closing quote. Returns the index just past it, or
 * -1 if the text runs out first (an unterminated string — see the module
 * doc: this scanner is only ever reached for text whose strings are all
 * properly closed, because a genuinely mid-string truncation is rejected
 * before `scanProvenance` is called at all).
 */
function scanStringEnd(text: string, i: number): number {
  let j = i + 1;
  let escaped = false;
  while (j < text.length) {
    const c = text[j]!;
    if (escaped) {
      escaped = false;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === '"') {
      return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * `text[i]` is the first character of some JSON value. Returns the index
 * just past that value's textual extent.
 *
 * String-aware for the object/array case (a `{` or `[` inside a string must
 * not perturb the depth count). Deliberately tolerant of running out of
 * text while still nested: the parser only ever *appends* missing closing
 * brackets when it repairs a safe truncation, so "this container's text
 * runs to end-of-input" is exactly the shape a safely-repaired value has in
 * the original — treating that as "ends at end-of-input" rather than
 * failing is what lets this scanner still find e.g. `refs` inside a
 * `{"intent":"explain","answer":"hi","refs":["e1"` input.
 */
function scanValueEnd(text: string, i: number): number {
  const c = text[i];
  if (c === undefined) return -1;
  if (c === '"') return scanStringEnd(text, i);
  if (c === '{' || c === '[') {
    const open = c;
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return text.length; // ran off the end while still open — see doc above
  }
  // number / true / false / null: run until a structural delimiter.
  let j = i;
  while (j < text.length && !isWs(text[j]!) && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++;
  return j;
}

/** One `"key": value` entry scanned out of an object body, in source order. */
interface Entry {
  key: string;
  valueStart: number;
  valueEnd: number;
}

/**
 * `text[objStart]` must be `{`. Scans entries left to right, in whatever
 * order they appear, stopping at a proper `}`, at end-of-input (the safe-
 * truncation tail, see `scanValueEnd`), or at the first byte that is not a
 * legal continuation (malformed input — returns whatever was already
 * found). Duplicate keys are returned in full, in order; callers that want
 * "last wins" derive that themselves from this list rather than this
 * function silently picking one.
 */
function scanEntries(text: string, objStart: number): Entry[] {
  const entries: Entry[] = [];
  let i = objStart + 1;
  while (true) {
    i = skipWs(text, i);
    if (i >= text.length) return entries;
    const c = text[i];
    if (c === '}') return entries;
    if (c === ',') {
      i++;
      continue;
    }
    if (c !== '"') return entries;
    const keyEnd = scanStringEnd(text, i);
    if (keyEnd === -1) return entries;
    let key: string;
    try {
      // The one shared line in this whole file: decoding a literal this
      // function has already, independently, sliced out by its own
      // char-by-char scan above. Never used to discover where the literal
      // starts or ends.
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return entries;
    }
    let j = skipWs(text, keyEnd);
    if (text[j] !== ':') return entries;
    j = skipWs(text, j + 1);
    const valueEnd = scanValueEnd(text, j);
    if (valueEnd === -1) return entries;
    entries.push({ key, valueStart: j, valueEnd });
    i = valueEnd;
  }
}

/** `text[arrStart]` must be `[`. Same tolerance rules as `scanEntries`. */
function scanElements(text: string, arrStart: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = arrStart + 1;
  while (true) {
    i = skipWs(text, i);
    if (i >= text.length) return out;
    const c = text[i];
    if (c === ']') return out;
    if (c === ',') {
      i++;
      continue;
    }
    const end = scanValueEnd(text, i);
    if (end === -1) return out;
    out.push({ start: i, end });
    i = end;
  }
}

/**
 * Finds the `{`/`[` in `raw` whose immediate (unresolved-duplicate) key/
 * index set matches `parsed`'s own top-level shape. Model output wrapped in
 * prose can contain decoy braces (a placeholder like `请参考 {某个占位符}`
 * written before the real JSON) — those are rejected here because their
 * scanned key set will not match, not because of any markdown-fence or
 * prose-boundary logic. Candidates are tried strictly left to right; the
 * first structural match wins.
 */
function findRoot(raw: string, parsed: Record<string, unknown> | unknown[]): number | null {
  if (Array.isArray(parsed)) {
    let from = 0;
    while (true) {
      const idx = raw.indexOf('[', from);
      if (idx === -1) return null;
      const count = scanElements(raw, idx).length;
      // An array root has no "names" to match on the way in — length is the
      // only structural signal available before recursing into elements,
      // which is what the length check below buys us over just picking the
      // first `[`.
      if (count === parsed.length) return idx;
      from = idx + 1;
    }
  }
  const expected = Object.keys(parsed);
  let from = 0;
  while (true) {
    const idx = raw.indexOf('{', from);
    if (idx === -1) return null;
    const keys = new Set(scanEntries(raw, idx).map((e) => e.key));
    if (keys.size === expected.length && expected.every((k) => keys.has(k))) return idx;
    from = idx + 1;
  }
}

/** Locates a key's value entry in the object starting at `objStart`, last
 *  occurrence wins (independently reaching the same duplicate-key
 *  resolution `JSON.parse` applies, never by asking `JSON.parse` which one
 *  it picked). */
function findKey(raw: string, objStart: number, key: string): { start: number; end: number } | null {
  const matches = scanEntries(raw, objStart).filter((e) => e.key === key);
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  return { start: last.valueStart, end: last.valueEnd };
}

function findIndex(raw: string, arrStart: number, index: number): { start: number; end: number } | null {
  const elements = scanElements(raw, arrStart);
  return elements[index] ?? null;
}

/* ═══════════ recursive walk ═══════════ */

/**
 * `containerStart` is the index in `raw` of the `{`/`[`/scalar-start that
 * corresponds to `value`'s own path (already resolved by the caller — this
 * function never re-derives the root).
 */
function walkValue(value: unknown, raw: string, containerStart: number, path: Path): ScanViolation | null {
  if (value === null) {
    // §5.2: null and a wholly absent field are equivalent, so a null here
    // needs the literal to actually read `null` (not something else); a
    // MISSING literal is handled one level up, before this function is even
    // called for an absent key — see `walkObject`/`walkArray`.
    const text = raw.slice(containerStart, containerStart + 4);
    if (text !== 'null') return { path, reason: 'null 值在原始文本中不是字面量 null' };
    return null;
  }
  if (Array.isArray(value)) {
    if (raw[containerStart] !== '[') return { path, reason: '数组路径在原始文本中不是一个数组字面量' };
    for (let i = 0; i < value.length; i++) {
      const child = findIndex(raw, containerStart, i);
      if (!child) return { path: [...path, i], reason: '数组元素在原始文本中找不到对应字面量' };
      const violation = walkValue(value[i], raw, child.start, [...path, i]);
      if (violation) return violation;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (raw[containerStart] !== '{') return { path, reason: '对象路径在原始文本中不是一个对象字面量' };
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = findKey(raw, containerStart, key);
      const childValue = (value as Record<string, unknown>)[key];
      if (!child) {
        // Missing literal is only acceptable when the parsed value is
        // itself null (§5.2 null≡missing). Anything else missing is a
        // genuine fabrication: the parser produced a scalar with no literal
        // backing it at all.
        if (childValue === null) continue;
        return { path: [...path, key], reason: '字段在原始文本中完全找不到对应字面量' };
      }
      const violation = walkValue(childValue, raw, child.start, [...path, key]);
      if (violation) return violation;
    }
    return null;
  }
  // string / number / boolean leaf — the only scalar shapes `JSON.parse` can
  // ever produce once object/array/null have been handled above.
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return { path, reason: '路径对应的值既不是对象/数组/null，也不是字符串/数字/布尔标量' };
  }
  const end = scanValueEnd(raw, containerStart);
  if (end === -1) return { path, reason: '标量字面量无法从原始文本中定位' };
  const literal = raw.slice(containerStart, end);
  const violation = scalarLiteralOk(value, literal);
  return violation ? { path, reason: violation } : null;
}

/**
 * Returns an error string, or `null` if `literal` (raw JSON source text —
 * never contract.ts's cleaned text) backs `value`.
 *
 * Strings: decode the literal (the one shared `JSON.parse` use for a single
 * isolated literal) and compare by *value*, never by literal substring —
 * `jsonUnescape("\\u4e2d\\u6587") === "中文"` even though neither is a
 * substring of the other, which is exactly the case several domestic
 * endpoints hit by escaping all non-ASCII output by default.
 *
 * Numbers/booleans: compared as literal text (`JSON.stringify(value)` vs
 * the raw literal), not by parsing the literal back into a JS number and
 * comparing — floating-point re-encoding drift (e.g. a literal written as
 * `1.50`) is explicitly out of scope for this gate.
 */
function scalarLiteralOk(value: string | number | boolean, literal: string): string | null {
  if (typeof value === 'string') {
    if (literal[0] !== '"') return '路径对应的字面量不是一个 JSON 字符串';
    let decoded: unknown;
    try {
      decoded = JSON.parse(literal);
    } catch {
      return '字符串字面量无法解码';
    }
    if (decoded !== value) return '字符串值与原始文本的字面量不一致（jsonUnescape 后比较）';
    return null;
  }
  if (typeof value === 'boolean') {
    return literal === String(value) ? null : '布尔值与原始文本的字面量不一致';
  }
  // number
  return literal === JSON.stringify(value) ? null : '数字值与原始文本的字面量不一致';
}
