import type { Ref } from '@/shared/types';
import { scanProvenance } from './scanner';

/**
 * `parseContract` is the seam (02-contract.md, extended by 01-guide-envelope-
 * smoke.md for S2). It turns a model's raw text response into one of the
 * known envelope shapes, or an `error` — and provenance verification (ADR
 * 0005) runs *inside* it, on every call, against the untouched input. There
 * is no second "validate provenance" entry point a caller could skip: an
 * envelope this function hands back has already been proven honest, in
 * production, not just in a test file.
 *
 * S1 shipped `explain` / `clarify` / `need_text`. S2's 01 task adds `guide`
 * and `need_docs` — this is the "扩大它认识的形状集合" the task names;
 * `parseContract`'s signature is unchanged. `locate` (S6) is still not
 * recognised: an envelope with that `intent`, or any `intent` this function
 * does not know, is `error`, not a silent pass-through.
 *
 * `guide`/`need_docs` recognition here is deliberately *structural only* —
 * same discipline as `recognizeClarify`'s empty `options` or `recognizeExplain`'s
 * empty `refs`. It does not require `steps` to be non-empty, does not check
 * that `action` is a member of `UserAction`, and does not check that any
 * `ref` actually exists on the current table. Those are R-a…R-e self-
 * consistency rules — 02-validate-guide.md's job (`validate.ts`), not this
 * file's. A `guide` envelope with zero `steps` parses to `kind: 'ok'` here;
 * it is `validateEnvelope`'s R-b, not `parseContract`, that turns it into a
 * `clarify`.
 */

export interface ExplainEnvelope {
  intent: 'explain';
  answer: string;
  refs: Ref[];
}

export interface ClarifyOption {
  ref: Ref;
  label: string;
}

export interface ClarifyEnvelope {
  intent: 'clarify';
  question: string;
  options: ClarifyOption[];
}

/**
 * The journey is over: nothing left on this page for the user to do.
 *
 * Its own intent rather than "a `guide` with an empty `steps`", because R-b
 * (`validate.ts`) requires `steps` to be non-empty — expressing completion that
 * way would ask `validateEnvelope` to call one shape both a violation and
 * valid. No `ref` and no control name: there is nothing to point at, which is
 * the whole content of the message.
 */
/**
 * What the model is claiming as proof that the goal is reached, chosen from a
 * closed list before it writes `why`.
 *
 * The same forcing function `previous_step` uses, for the same reason: a free
 * sentence lets "I can see it" and "I assume so" read identically, and the
 * live failures were all the second kind wearing the first one's words. It
 * also makes the mistake countable — the trace records which kind was claimed,
 * so the next run can say which kind is unreliable instead of guessing.
 */
export const DONE_EVIDENCE = ['content_on_page', 'page_address', 'step_completed'] as const;
export type DoneEvidence = (typeof DONE_EVIDENCE)[number];

export interface DoneEnvelope {
  intent: 'done';
  /** Absent only on envelopes stored before this field existed. */
  evidence?: DoneEvidence;
  why: string;
}

export interface NeedTextEnvelope {
  intent: 'need_text';
  query: string;
  blocks: string[];
}

/** One coarse waypoint in a `guide` envelope's `route`. No `ref`, no control
 *  name — see the file-level doc comment and design doc §1.3/§5.4: `route`
 *  is allowed to be invented, so its shape carries nothing a `Ref` could be. */
export interface GuideRouteHop {
  at: string;
  goal: string;
}

/** The optional arrival check on a `guide` step. `must_contain` is optional
 *  *within* an optional field — the model may give `via_ref` without a shape
 *  expectation, or omit `expect_after` entirely (§5.4: "宁可不给，也不要瞎编"). */
export interface GuideExpectAfter {
  via_ref: Ref;
  must_contain?: { role: string; name?: string };
}

export interface GuideStepIntent {
  ref: Ref;
  /**
   * What to type, for an `input` step. Composed by the model, never by us:
   * turning 「微软的开源 AI 工具」 into a query a search box will actually
   * answer (`org:microsoft ai`) is judgement about the site and the goal
   * together, which is the thing the model is here for — a keyword extractor
   * on our side would be guessing at both.
   *
   * Optional, because some inputs only the user can fill (an instance name, a
   * personal note). Absent means the card says where to type and stops there.
   * Displayed, never typed: the keyboard stays the user's («只指路，不开车»).
   */
  value?: string;
  action: string;
  why: string;
  expect_after?: GuideExpectAfter;
}

/** The model's own reading of what the last step accomplished. Required by
 *  the schema, so a well-formed `guide` always carries one. */
const GUIDE_PREVIOUS_STEP = ['first_plan', 'worked', 'no_change'] as const;

/** What the model says the user's previous step accomplished, decided before
 *  it plans this one. `first_plan` on the opening call; `worked` when the page
 *  moved or new controls appeared; `no_change` when neither did. */
export type PreviousStep = (typeof GUIDE_PREVIOUS_STEP)[number];

export interface GuideEnvelope {
  intent: 'guide';
  /** Absent only on envelopes stored before this field existed. */
  previous_step?: PreviousStep;
  route: GuideRouteHop[];
  steps: GuideStepIntent[];
}

export interface NeedDocsEnvelope {
  intent: 'need_docs';
  via_ref: Ref;
  query: string;
}

export type Envelope =
  | ExplainEnvelope
  | ClarifyEnvelope
  | NeedTextEnvelope
  | GuideEnvelope
  | NeedDocsEnvelope
  | DoneEnvelope;

/**
 * The three intents the QA path (ADR 0004) actually renders — `explain` /
 * `clarify` / `need_text`, the shapes `validate.ts`'s `KNOWN_INTENTS` still
 * gates on and `qa.ts`'s `describeAnswer` still switches over. `guide` /
 * `need_docs` are S2's `AgentHost` path (`agent/api.ts`), never QA's.
 *
 * Exists so that guarantee is a compile-time proof shared by both files
 * instead of two independent "trust me, `isKnownIntent` already excluded
 * `guide`" comments — `Envelope` growing to five members (01-guide-envelope-
 * smoke.md) would otherwise make `claimedRefs` and `describeAnswer`'s
 * switches non-exhaustive for a reason neither file is meant to deal with.
 */
export type KnownEnvelope = ExplainEnvelope | ClarifyEnvelope | NeedTextEnvelope;

export type ParseResult = { kind: 'ok'; envelope: Envelope } | { kind: 'error'; message: string };

const err = (message: string): ParseResult => ({ kind: 'error', message });

export function parseContract(raw: string): ParseResult {
  const parsed = extractCandidate(raw);
  if (parsed === undefined) return err('无法从模型输出中解析出合法 JSON（容错解析全部尝试失败）');

  // Provenance runs against `raw` — the untouched input — never against
  // `parsed` or any other cleaned intermediate. See ADR 0005: the scanner
  // is the only thing allowed to answer "is this honest", and it can only
  // do that against what the model actually said.
  const violation = scanProvenance(raw, parsed);
  if (violation) {
    const at = violation.path.length ? violation.path.join('.') : '(顶层)';
    return err(`解析结果在路径「${at}」处无法在原始输出中找到对应字面量：${violation.reason}`);
  }

  const envelope = recognizeEnvelope(parsed);
  if (!envelope) return err(explainRecognitionFailure(parsed));

  return { kind: 'ok', envelope };
}

/**
 * The tool-calling counterpart of `parseContract`.
 *
 * The endpoint hands back two things: which function the model chose, and the
 * arguments text it wrote. The function name *is* the intent — a structured
 * field the API reports, never something recovered from prose — so the model
 * is never asked to write `intent` at all, and this attaches it afterwards.
 *
 * That ordering is what keeps ADR 0005 intact. `scanProvenance` anchors by
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
export function parseToolContract(toolName: string, rawArgs: string): ParseResult {
  const parsed = extractCandidate(rawArgs);
  if (parsed === undefined) return err('工具调用的 arguments 不是合法 JSON（容错解析全部尝试失败）');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return err('工具调用的 arguments 不是一个 JSON 对象');

  const violation = scanProvenance(rawArgs, parsed);
  if (violation) {
    const at = violation.path.length ? violation.path.join('.') : '(顶层)';
    return err(`解析结果在路径「${at}」处无法在原始输出中找到对应字面量：${violation.reason}`);
  }

  const envelope = recognizeEnvelope({ ...(parsed as Record<string, unknown>), intent: toolName });
  if (!envelope) return err(explainRecognitionFailure({ ...(parsed as Record<string, unknown>), intent: toolName }));

  return { kind: 'ok', envelope };
}

/* ═══════════ shape recognition — runs only after provenance has passed ═══════════ */

/** Every intent `recognizeEnvelope` actually handles, in its own switch order. */
const RECOGNISED_INTENTS = ['explain', 'clarify', 'need_text', 'guide', 'need_docs', 'done'] as const;

/**
 * Why the shape was rejected, in enough detail to act on.
 *
 * The single sentence this replaced named only S1's three intents — long after
 * `guide`/`need_docs`/`done` were recognised too — and reported a `guide`
 * envelope missing one `why` with the same words as an envelope of an entirely
 * unknown kind. Live consequence: a github.com journey died at hop 0, and the
 * message sent the investigation looking for a routing bug that did not exist.
 *
 * Only ever runs on the failure path, so it is free to re-walk the object.
 */
function explainRecognitionFailure(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return '模型输出不是一个 JSON 对象（信封必须是对象，不能是数组或标量）';

  const obj = parsed as Record<string, unknown>;
  const known = RECOGNISED_INTENTS.join(' / ');
  if (typeof obj.intent !== 'string') return `信封缺少 intent 字段（或类型不是字符串）。认得的有：${known}`;
  if (!(RECOGNISED_INTENTS as readonly string[]).includes(obj.intent))
    return `不认得的 intent「${obj.intent}」。认得的有：${known}`;

  const missing = (path: string, field: string) => `${obj.intent} 信封的 ${path} 缺少 ${field} 字段（或类型不对）`;

  if (obj.intent === 'guide') {
    if (!Array.isArray(obj.route)) return missing('顶层', 'route（必须是数组）');
    for (const [i, hop] of obj.route.entries()) {
      if (typeof hop !== 'object' || hop === null) return missing(`route[${i}]`, '对象结构');
      const h = hop as Record<string, unknown>;
      for (const f of ['at', 'goal']) if (typeof h[f] !== 'string') return missing(`route[${i}]`, f);
    }
    if (!Array.isArray(obj.steps)) return missing('顶层', 'steps（必须是数组）');
    for (const [i, raw] of obj.steps.entries()) {
      if (typeof raw !== 'object' || raw === null) return missing(`steps[${i}]`, '对象结构');
      const st = raw as Record<string, unknown>;
      for (const f of ['ref', 'action', 'why']) if (typeof st[f] !== 'string') return missing(`steps[${i}]`, f);
      if (st.value !== undefined && st.value !== null && typeof st.value !== 'string')
        return missing(`steps[${i}]`, 'value（有的话必须是字符串）');
      if (st.expect_after !== undefined && st.expect_after !== null) {
        if (typeof st.expect_after !== 'object') return missing(`steps[${i}].expect_after`, '对象结构');
        if (typeof (st.expect_after as Record<string, unknown>).via_ref !== 'string')
          return missing(`steps[${i}].expect_after`, 'via_ref');
      }
    }
  }

  // The remaining intents are small enough that naming the required fields is
  // more useful than re-walking them.
  const required: Record<string, string> = {
    explain: 'answer（字符串）',
    clarify: 'question（字符串）+ options（{ref,label} 数组）',
    need_text: 'query（字符串）+ blocks（字符串数组）',
    need_docs: 'via_ref + query',
    done: 'why（字符串）',
    guide: 'route + steps',
  };
  return `${obj.intent} 信封的形状不合，需要：${required[obj.intent]}`;
}

function recognizeEnvelope(parsed: unknown): Envelope | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.intent !== 'string') return null;
  switch (obj.intent) {
    case 'explain':
      return recognizeExplain(obj);
    case 'clarify':
      return recognizeClarify(obj);
    case 'need_text':
      return recognizeNeedText(obj);
    case 'guide':
      return recognizeGuide(obj);
    case 'need_docs':
      return recognizeNeedDocs(obj);
    case 'done': {
      if (typeof obj.why !== 'string') return null;
      // Carried when recognisable, dropped otherwise — same discipline as
      // `previous_step`. Nothing downstream decides on it; it exists to make
      // the model name its grounds, and to be countable afterwards.
      const evidence = (DONE_EVIDENCE as readonly string[]).includes(obj.evidence as string)
        ? (obj.evidence as DoneEvidence)
        : undefined;
      return { intent: 'done', ...(evidence ? { evidence } : {}), why: obj.why };
    }
    default:
      return null;
  }
}

function recognizeExplain(obj: Record<string, unknown>): ExplainEnvelope | null {
  if (typeof obj.answer !== 'string') return null;
  // `refs` is the one optional S1 field (see the contract.spec.ts comment on
  // slice 16 for why this specific field): a model declining to name any
  // evidence, whether by omitting the key or sending `null`, is an ordinary
  // "this answer isn't page-grounded" — both normalize to the same `[]`.
  if (obj.refs === undefined || obj.refs === null) return { intent: 'explain', answer: obj.answer, refs: [] };
  if (!Array.isArray(obj.refs) || !obj.refs.every((r) => typeof r === 'string')) return null;
  return { intent: 'explain', answer: obj.answer, refs: obj.refs as Ref[] };
}

function recognizeClarify(obj: Record<string, unknown>): ClarifyEnvelope | null {
  if (typeof obj.question !== 'string') return null;
  if (!Array.isArray(obj.options)) return null;
  const options: ClarifyOption[] = [];
  for (const raw of obj.options) {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.ref !== 'string' || typeof o.label !== 'string') return null;
    options.push({ ref: o.ref as Ref, label: o.label });
  }
  return { intent: 'clarify', question: obj.question, options };
}

function recognizeNeedText(obj: Record<string, unknown>): NeedTextEnvelope | null {
  if (typeof obj.query !== 'string') return null;
  if (!Array.isArray(obj.blocks) || !obj.blocks.every((b) => typeof b === 'string')) return null;
  return { intent: 'need_text', query: obj.query, blocks: obj.blocks as string[] };
}

/**
 * Structural only (see the file-level doc comment): `route` and `steps` may
 * both be empty arrays, `action` is accepted as any string (R-d's enum
 * membership check is `validate.ts`'s job), and no `ref` is checked against
 * any table here — `parseContract` has no table to check it against.
 */
function recognizeGuide(obj: Record<string, unknown>): GuideEnvelope | null {
  if (!Array.isArray(obj.route)) return null;
  const route: GuideRouteHop[] = [];
  for (const raw of obj.route) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== 'string' || typeof r.goal !== 'string') return null;
    route.push({ at: r.at, goal: r.goal });
  }

  if (!Array.isArray(obj.steps)) return null;
  const steps: GuideStepIntent[] = [];
  for (const raw of obj.steps) {
    const step = recognizeGuideStep(raw);
    if (!step) return null;
    steps.push(step);
  }

  // Carried when present and recognisable, dropped otherwise. A wrong value
  // here is not worth refusing a whole plan over: nothing downstream decides
  // anything on it — it exists to make the model look at the page before it
  // plans, and it earns its place in the trace either way.
  const previous = (GUIDE_PREVIOUS_STEP as readonly string[]).includes(obj.previous_step as string)
    ? (obj.previous_step as PreviousStep)
    : undefined;

  return { intent: 'guide', ...(previous ? { previous_step: previous } : {}), route, steps };
}

function recognizeGuideStep(raw: unknown): GuideStepIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.ref !== 'string' || typeof s.action !== 'string' || typeof s.why !== 'string') return null;
  const step: GuideStepIntent = { ref: s.ref as Ref, action: s.action, why: s.why };
  // Absent and `null` are the same event, the same way `expect_after` below
  // already treats them — and now they have to be, because a schema that is
  // valid under OpenAI's strict mode has no way to say "optional" except a
  // union with null, so a model obeying it writes `"value": null` for every
  // step that is not an `input`. A wrong *type* is still a malformed envelope,
  // never something to coerce into shape.
  if (s.value !== undefined && s.value !== null) {
    if (typeof s.value !== 'string') return null;
    step.value = s.value;
  }

  // `expect_after` absent or `null` both mean "declined to give one" — same
  // normalization `recognizeExplain` already applies to `refs` (see slice
  // 16a in contract.spec.ts): a model that has no arrival check to offer and
  // a model that omits the key entirely are the same event, not two.
  if (s.expect_after === undefined || s.expect_after === null) return step;
  if (typeof s.expect_after !== 'object') return null;
  const ea = s.expect_after as Record<string, unknown>;
  if (typeof ea.via_ref !== 'string') return null;
  const expectAfter: GuideExpectAfter = { via_ref: ea.via_ref as Ref };

  if (ea.must_contain !== undefined && ea.must_contain !== null) {
    if (typeof ea.must_contain !== 'object') return null;
    const mc = ea.must_contain as Record<string, unknown>;
    if (typeof mc.role !== 'string') return null;
    // A null `name` is "no constraint on the name", read the same way `value`
    // and `expect_after` already read theirs. Strict mode forces every property
    // to be present, so a model that can name the landing *role* but not its
    // text has no other way to say so — and one live draw did exactly that,
    // `{"role":"link","name":null}`, which the old check refused, throwing away
    // an otherwise perfectly good envelope over the one field it was least
    // sure of.
    if (mc.name !== undefined && mc.name !== null && typeof mc.name !== 'string') return null;
    expectAfter.must_contain =
      typeof mc.name === 'string' ? { role: mc.role, name: mc.name } : { role: mc.role };
  }
  step.expect_after = expectAfter;
  return step;
}

function recognizeNeedDocs(obj: Record<string, unknown>): NeedDocsEnvelope | null {
  if (typeof obj.via_ref !== 'string') return null;
  if (typeof obj.query !== 'string') return null;
  return { intent: 'need_docs', via_ref: obj.via_ref as Ref, query: obj.query };
}

/* ═══════════ fault-tolerant extraction — main-parser side (ADR 0005: this
   half shares nothing with scanner.ts beyond the language's own JSON.parse) ═══════════ */

/**
 * 02-contract.md names four tolerance strategies, in order: markdown fence
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
