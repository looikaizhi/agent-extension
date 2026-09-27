import type { Ref } from '@/shared/types';
import { scanProvenance } from './scanner';

/**
 * `parseToolContract` is the seam (design doc §5.1–§5.2). It turns what an
 * endpoint reports — the function the model called, and the arguments text it
 * wrote — into one of the known envelope shapes, or an `error`; and provenance
 * verification (CONTEXT.md `Provenance`) runs *inside* it, on every call,
 * against the untouched input. There is no second "validate provenance" entry
 * point a caller could skip: an envelope this function hands back has already
 * been proven honest, in production, not just in a test file.
 *
 * There was a second door once — a reader for an answer written as free text,
 * for an endpoint that ignores `tool_choice: 'required'`. It worked, and it
 * was never wired up: the trigger needed an `intent` field the system prompt
 * never taught, so no model was ever told it could answer that way, and 165
 * recorded states from real runs contain zero answers that arrived without a
 * tool call. Refusing such an endpoint *before* the request goes out says
 * something the user can act on; reading its prose said nothing to anyone.
 *
 * This file is the part both agents share: the reading machinery —
 * extraction, provenance, and what the model is told when an answer names no
 * intent, or one nobody knows. Every shape belongs to the agent that answers
 * with it, in that agent's modules; which shapes an answer is read *as* is the
 * `EnvelopeReader` each agent passes in. `locate` (S6) is still not
 * recognised: an envelope with that `intent`, or any `intent` nobody knows, is
 * `error`, not a silent pass-through.
 */

/** One of an agent's shapes: how it is recognised, and what the model is told
 *  when it is not. */
export interface EnvelopeShape<E> {
  /** The envelope read out of the answer, or `null`. Only ever runs after
   *  provenance has passed. */
  recognize(obj: Record<string, unknown>): E | null;
  /** What the model is told when `recognize` refused — a whole sentence, so a
   *  shape with nested fields can name the one that is wrong (`shapeMismatch`
   *  is the sentence for the rest). */
  explain(obj: Record<string, unknown>): string;
}

/** How the agent reads an answer: by its shapes, looked up by intent, against
 *  every intent the product knows (`agent/intents.ts`). */
export interface EnvelopeReader<E> {
  /** The shape for one of the agent's intents; `undefined` for any other. */
  shapeFor(intent: string): EnvelopeShape<E> | undefined;
  /** Every intent the product knows — listed back to a model that named one
   *  nobody does. */
  known: readonly string[];
}

export type ParseResult<E> = { kind: 'ok'; envelope: E } | { kind: 'error'; message: string };

const err = (message: string) => ({ kind: 'error', message }) as const;

/** "Recognised the intent, not the shape — here is what it needs." One
 *  sentence for every intent, whichever file explains it. */
export const shapeMismatch = (intent: string, need: string) => `${intent} 信封的形状不合，需要：${need}`;

/**
 * The endpoint hands back two things: which function the model chose, and the
 * arguments text it wrote. The function name *is* the intent — a structured
 * field the API reports, never something recovered from prose — so the model
 * is never asked to write `intent` at all, and this attaches it afterwards.
 *
 * That ordering is what keeps the provenance rule intact. `scanProvenance` anchors by
 * path: it walks the parsed value and demands a matching literal at the same
 * path in the raw text. So it runs here against `rawArgs` and the model's own
 * fields, before `intent` exists — scanning text with an `intent` we spliced
 * in ourselves would be checking our own writing, and scanning the model's
 * text against an object carrying a field that text never had would fail at
 * the root for a reason that has nothing to do with honesty.
 *
 * Asking the model for `intent` anyway was tried and is worse: pinned to a
 * single-value enum it still came back holding a free-text restatement of the
 * user's goal in 6 of 8 draws, because a property called `intent` reads as
 * "the user's intent" no matter what the schema says.
 */
export function parseToolContract<E>(toolName: string, rawArgs: string, reader: EnvelopeReader<E>): ParseResult<E> {
  const parsed = extractCandidate(rawArgs);
  if (parsed === undefined) return err('工具调用的 arguments 不是合法 JSON（容错解析全部尝试失败）');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return err('工具调用的 arguments 不是一个 JSON 对象');

  const violation = scanProvenance(rawArgs, parsed);
  if (violation) {
    const at = violation.path.length ? violation.path.join('.') : '(顶层)';
    return err(`解析结果在路径「${at}」处无法在原始输出中找到对应字面量：${violation.reason}`);
  }

  return read({ ...(parsed as Record<string, unknown>), intent: toolName }, reader);
}

/* ═══════════ reading — runs only after provenance has passed ═══════════ */

/**
 * Why an answer names no intent this product knows, in enough detail to act
 * on — or `null` when it names one. What is wrong with the shape of a known
 * intent is its own shape's to say.
 *
 * Only ever runs on the failure path, so it is free to re-walk the object.
 */
function explainUnnamed(parsed: unknown, known: readonly string[]): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return '模型输出不是一个 JSON 对象（信封必须是对象，不能是数组或标量）';
  const intent = (parsed as Record<string, unknown>).intent;
  const listed = known.join(' / ');
  if (typeof intent !== 'string') return `信封缺少 intent 字段（或类型不是字符串）。认得的有：${listed}`;
  if (!known.includes(intent)) return `不认得的 intent「${intent}」。认得的有：${listed}`;
  return null;
}

function read<E>(parsed: unknown, reader: EnvelopeReader<E>): ParseResult<E> {
  const unnamed = explainUnnamed(parsed, reader.known);
  if (unnamed !== null) return err(unnamed);
  const obj = parsed as Record<string, unknown>;
  const intent = obj.intent as string;
  const shape = reader.shapeFor(intent);
  if (!shape) return err(`不认得的 intent「${intent}」。认得的有：${reader.known.join(' / ')}`);
  const envelope = shape.recognize(obj);
  return envelope ? { kind: 'ok', envelope } : err(shape.explain(obj));
}

/* ═══════════ fault-tolerant extraction — main-parser side (CONTEXT.md `Provenance`: this
   half shares nothing with scanner.ts beyond the language's own JSON.parse) ═══════════ */

/**
 * Four tolerance strategies, in order: markdown fence
 * stripping, leading/trailing prose stripping, trailing-comma forgiveness,
 * and truncation repair. Only the latter three exist here as distinct code.
 *
 * Fence stripping has no dedicated function because the prose-stripping
 * candidate search below already subsumes it completely: it scans for `{`
 * left to right and retries on failure, and a markdown fence's own
 * characters (```` ``` ````, an optional language tag, the surrounding
 * newlines) never contain a literal `{` — so a fenced JSON object is just
 * another "prose" candidate this search finds on its own, with no help
 * needed. This was verified empirically, not assumed: fence-only input,
 * fence content preceded by prose with a decoy `{brace}`, fence content
 * whose *own* value strings contain a nested fence, an unclosed fence, a
 * fence with mismatched opening/closing marker lengths, an unusual/invalid
 * language tag, a fence plus prose *outside* it, and a language-tag line
 * itself containing a decoy brace all parse correctly with no fence-specific
 * code at all — see `tests/unit/contract.spec.ts` slices 4 and 5, which
 * pin this *behavior* (fenced input parses correctly) without caring which
 * internal mechanism produces it.
 *
 * Do not re-add a `stripFence` step "for clarity" or "to be explicit" — a
 * step that does no observable work is worse than no step, because the next
 * reader will assume fence-handling lives there and stop looking at the
 * candidate search that is actually doing it.
 *
 * Scans left to right for `{` candidates, string-aware bracket-balances
 * each one, and for every balanced candidate applies trailing-comma
 * forgiveness and then truncation repair before handing it to `JSON.parse`.
 * The first candidate that survives the whole remaining pipeline wins —
 * this is what lets decoy braces in surrounding prose (`请参考 {某个占位符}`)
 * fall through to the real JSON object without special-casing them, and
 * incidentally what lets a markdown fence's own characters fall through the
 * same way.
 *
 * Returns the parsed value, or `undefined` if no candidate anywhere in the
 * text ever produces valid JSON.
 */
function extractCandidate(text: string): unknown | undefined {
  let from = 0;
  while (true) {
    const idx = text.indexOf('{', from);
    if (idx === -1) return undefined;
    // A candidate that never closes before end-of-text is not necessarily a
    // decoy — it is exactly the shape strategy 4 (truncation repair) exists
    // for, so hand the whole remainder to the rest of the pipeline instead
    // of discarding it outright. `repairTruncation` is what actually decides
    // whether that remainder is safely closeable (properly-closed strings,
    // just missing brackets) or not (a string left open — see its doc).
    const end = balancedEnd(text, idx);
    const candidate = end !== -1 ? text.slice(idx, end + 1) : text.slice(idx);
    const commaForgiven = forgiveTrailingCommas(candidate);
    const repaired = repairTruncation(commaForgiven);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired);
      } catch {
        // Not valid JSON even after forgiveness+repair (e.g. single-quoted
        // strings) — fall through and try the next `{` candidate.
      }
    }
    from = idx + 1;
  }
}

/** String-aware bracket-balance scan from an opening `{` to its matching
 *  `}`. Returns the index of that `}`, or -1 if the text ends first. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Strategy 3: drop a comma that appears, after only whitespace, directly
 *  before a closing `}`/`]` — but never one inside a string literal. A
 *  string-aware char scan rather than a regex, so a value that legitimately
 *  ends in a comma right before a bracket (`"a,"`) is never touched. */
function forgiveTrailingCommas(text: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop this comma
    }
    out += c;
  }
  return out;
}

/** Strategy 4: string-aware bracket-balance repair for a truncated tail.
 *  Returns `null` when the text ends mid-string — there is no literal on
 *  that path to compare against, so guessing where the string should have
 *  closed would mean inventing content, which this function refuses to do.
 *  Otherwise appends whatever closing brackets are missing, in LIFO order. */
function repairTruncation(text: string): string | null {
  const stack: Array<'}' | ']'> = [];
  let inStr = false;
  let escaped = false;
  for (const c of text) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) return null;
  return stack.length === 0 ? text : text + stack.reverse().join('');
}
