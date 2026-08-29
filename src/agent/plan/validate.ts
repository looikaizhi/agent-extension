import type { Envelope, GuideEnvelope, GuideExpectAfter, GuideRouteHop, GuideStepIntent } from './contract';
import { tokensOf } from '@/core/locator/lexical';
import type { LexicalResult } from '@/core/locator/lexical';
import { descriptorOf } from '@/core/packs/bind';
import type { BindResult } from '@/core/packs/bind';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Check } from '@/agent/host/thread';
import type { GuideStep, UserAction } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/** R-d's membership set. A `Set<string>` (not `Set<UserAction>`) so `.has`
 *  accepts the model's raw, unnarrowed `string` without a cast at the call
 *  site — the `satisfies` clause is what keeps this list honest against the
 *  real `UserAction` union. */
const USER_ACTIONS = new Set<string>(
  ['click', 'input', 'select', 'toggle', 'scroll', 'observe'] satisfies UserAction[],
);

// `ok.envelope` is now the full five-shape `Envelope` (contract.ts). 01 left
// this at `KnownEnvelope` (three intents) deliberately — `guide`/`need_docs`
// didn't have R-a…R-e yet — and this file is what
// fills that in: `claimedRefs` below is now exhaustive over all five.
// `KnownEnvelope` itself is untouched in contract.ts; it still names exactly
// the three intents `qa.ts`'s QA path renders, which is a different
// guarantee than "this file has rules for it".
export type ValidateResult = { kind: 'ok'; envelope: Envelope } | { kind: 'violation'; reason: string };

/**
 * An envelope-shaped object whose `intent` is not one of the intents this
 * file has rules for — `locate` (S6), or anything else a future stage
 * introduces. `validateEnvelope` accepts this alongside `Envelope` on
 * purpose: its intent gate does not assume the caller went through
 * `parseContract` first (03-validate.md Seam) — a caller, or a test, must be
 * able to hand it a shape `parseContract` doesn't even recognise yet, with
 * no cast. See the Gotchas section on why this check is not simply
 * delegated to `parseContract`'s own recognizer.
 */
export interface UnknownIntentEnvelope {
  intent: string;
  [key: string]: unknown;
}

const violation = (reason: string): ValidateResult => ({ kind: 'violation', reason });

const KNOWN_INTENTS = new Set(['explain', 'clarify', 'need_text', 'guide', 'need_docs', 'done']);

/** The one authority for "which intents this file has R-a…R-e rules for
 *  right now" (03-validate.md Gotchas, extended by 02-validate-guide.md). */
function isKnownIntent(envelope: Envelope | UnknownIntentEnvelope): envelope is Envelope {
  return KNOWN_INTENTS.has(envelope.intent);
}

/**
 * Refs a given envelope shape stakes a claim on — the set R-a/R-e run
 * against. `need_text`'s `blocks` are body-block ids, not refs (03-validate.md
 * §"need_text 不做 blocks 归属校验"), so it contributes none.
 *
 * `guide`'s `expect_after.via_ref` is claimed alongside `steps[i].ref` on
 * purpose (02-validate-guide.md slice 8): the Gotchas call it "同一类需要核对
 * 的字段" as the step's own `ref`, so it goes through the identical R-a/R-e
 * check via this same loop rather than a second bespoke one. `route` is not
 * claimed at all — see this file's Gotchas on why `route` never goes near
 * R-a.
 */
function claimedRefs(envelope: Envelope): readonly Ref[] {
  switch (envelope.intent) {
    case 'explain':
      return envelope.refs;
    case 'clarify':
      return envelope.options.map((o) => o.ref);
    case 'need_text':
      return [];
    case 'guide':
      return envelope.steps.flatMap((s) => (s.expect_after ? [s.ref, s.expect_after.via_ref] : [s.ref]));
    case 'need_docs':
      return [envelope.via_ref];
    case 'done':
      // Nothing to point at is the message. R-a/R-e have no work here.
      return [];
  }
}

export function validateEnvelope(envelope: Envelope | UnknownIntentEnvelope, table: PromptTable): ValidateResult {
  // §5.8: an intent this file doesn't recognise is a contract violation, not
  // a question for the user — it goes to `error`/`violation`, never `clarify`.
  if (!isKnownIntent(envelope)) return violation(`intent「${envelope.intent}」不在已知范围内`);

  if (envelope.intent === 'guide') {
    // R-b, front half only: "至少一步" is a pure structural check. "第一步绑定
    // 成功" needs a real bind attempt against the live DOM and is 03's job —
    // see this file's Seam/Gotchas.
    if (envelope.steps.length === 0) return violation('guide.steps 为空：R-b 要求至少一步');

    // R-d: `action` must be a member of `UserAction`. A model handing back an
    // enum-adjacent string (English interfaces commonly produce `'tap'` /
    // `'press'`) is never silently mapped onto the nearest value — that would
    // hide "the model didn't actually commit to a clear action" from the user.
    for (const step of envelope.steps) {
      if (!USER_ACTIONS.has(step.action)) return violation(`action「${step.action}」不在 UserAction 枚举内`);
    }
  }

  const itemByRef = new Map<Ref, PromptItem>(table.items.map((i) => [i.ref, i]));

  // A single loop, never a `.filter()`: one illegal member anywhere in the
  // claimed set fails the *whole* envelope (03-validate.md §"数组里出现任意
  // 一个非法成员 → 整体判失败"). There is no "keep the legal ones" path here.
  for (const ref of claimedRefs(envelope)) {
    const item = itemByRef.get(ref);
    if (!item) return violation(`ref「${ref}」不在本次快照内`); // R-a
    if (item.sensitive) return violation(`ref「${ref}」指向敏感元素，不可引用`); // R-e
  }

  return { kind: 'ok', envelope };
}

/**
 * §5.5's mapping, model envelope → runtime `GuideStep` (`src/shared/protocol.ts`).
 * Only ever called after `validateEnvelope` has returned `ok` for the
 * envelope `stepEnvelope` came from (Seam) — every field this function
 * reads has already been checked to exist on `table` and not be `sensitive`
 * (R-a/R-e), and `stepEnvelope.action` has already been checked to be a
 * member of `UserAction` (R-d). That is why there is no `actionForRole`
 * fallback branch here: adding one would only be defending against input
 * this function's sole legitimate caller can never hand it — see the
 * "unreachable" test in validate.spec.ts, which proves R-d already turns
 * that input into a `violation` before anyone gets this far.
 */
export function toGuideStep(stepEnvelope: GuideStepIntent, table: PromptTable): GuideStep {
  // Non-null: guaranteed by R-a, which the caller has already run.
  const item = table.items.find((i) => i.ref === stepEnvelope.ref)!;
  return {
    ref: item.ref,
    descriptor: descriptorOf(item),
    expectedUserAction: stepEnvelope.action as UserAction,
    title: item.name || item.role,
    detail: stepEnvelope.why,
    ...(stepEnvelope.value !== undefined ? { value: stepEnvelope.value } : {}),
  };
}

/**
 * The `Check` axis, finally computed from something (§5.7, CONTEXT.md).
 *
 * `expect_after` has been parsed and ref-checked since 01, and then dropped on
 * the floor: `toGuideStep` never carried it into `GuideStep`, and `check` was
 * written once at `start` as `'unknown'` and never again. The mechanism, the
 * field and the axis all existed; nothing ever asked the question.
 *
 * Answers "did this step do what the model said it would", not "is the goal
 * met" — those are different questions and only the first one has an objective
 * judge. `must_contain` is optional inside an optional field (§5.4: "宁可不给,
 * 也不要瞎编"), and its absence is `skipped` — we genuinely did not check —
 * while its presence and absence *from the arrived page* is `unknown`: we
 * checked and did not find it. Calling that second case `skipped` would file a
 * real negative under a word that means the opposite.
 *
 * Matched on `role` + `name` only. `expect_after` describes a shape the model
 * expects to see, not an element it has a handle on — there is no ref to
 * compare, and there could not be: the ref space is a different snapshot's.
 */
export function judgeArrival(expect: GuideExpectAfter, table: PromptTable): Check {
  if (!expect.must_contain) return 'skipped';
  const want = expect.must_contain;
  return table.items.some((i) => i.role === want.role && norm(i.name) === norm(want.name)) ? 'pass' : 'unknown';
}

/** Every reason a thread can be parked on a question (design doc §5.8). What
 *  `ThreadState.clarify` records. */
export type ClarifyTrigger = 'CL-1' | 'CL-2' | 'CL-3' | 'CL-4';

/** The three a judgement in this file can reach. CL-1 — the model returning
 *  `intent: 'clarify'` itself — is already a distinct envelope shape by the
 *  time anything in `agent/plan` sees it, so nothing here ever has to decide
 *  it; saying so in the return type keeps that fact checkable rather than
 *  merely stated. */
export type ClarifyEscalation = Exclude<ClarifyTrigger, 'CL-1'>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * CL-4's "宽松文本匹配": does *any* token of `hop.at`/`hop.goal` show up, as
 * a plain substring, anywhere in the current table's `name`/`path` text?
 * Reuses `tokensOf` (lexical.ts) purely for its CJK bigram splitting —
 * Chinese route text has no spaces to split words on, and this file has no
 * reason to reinvent that segmentation a second time (AGENTS.md). This is
 * *not* a bind attempt: no role is checked, no uniqueness required — just
 * "did the model's route description leave any trace on this page at all".
 */
function hasTextualTrace(hop: GuideRouteHop, table: PromptTable): boolean {
  const haystack = norm(table.items.flatMap((i) => [i.name, ...i.path]).join(' '));
  for (const token of tokensOf(norm(`${hop.at} ${hop.goal}`))) {
    if (haystack.includes(token)) return true;
  }
  return false;
}

/**
 * CL-3 / CL-4. Independent of `validateEnvelope`: a `guide` envelope can
 * pass every one of R-a…R-e and still trip one of these — they detect "the
 * model doesn't seem to know this platform", a different question from "is
 * this envelope self-consistent" (this file's Gotchas, design doc §5.8).
 * Takes an already-recognised `GuideEnvelope` (post-`parseContract`), not
 * the wider `Envelope` union — every field this function reads (`steps`,
 * `route`) only exists on that shape.
 */
export function judgeClarifyEscalation(
  envelope: GuideEnvelope,
  table: PromptTable,
  localFallback: LexicalResult,
): ClarifyEscalation | null {
  // CL-3: the model gave no ref to start from, and the local lexical
  // baseline — independent of the model — agrees there is nothing to find.
  // Either signal alone is unremarkable; both at once is "no reasonable
  // starting point".
  if (envelope.steps.length === 0 && localFallback.kind === 'none') return 'CL-3';

  // CL-4: the model's own coarse waypoint doesn't correspond to anything on
  // this page, in any textual sense — the one signal design doc §1.3 trusts
  // over the model's self-assessment of "do I know this platform".
  const firstHop = envelope.route[0];
  if (firstHop && !hasTextualTrace(firstHop, table)) return 'CL-4';

  return null;
}

/**
 * CL-2: "the first step's bind comes back `ambiguous`". The bind attempt
 * itself is out of this file's scope — it needs a live DOM extraction
 * against the tab's *current* page — but the
 * judgment ("given that result, do we escalate to `clarify`") does not need
 * one. It is checked here, on a `BindResult`, rather than by looking the
 * model's `ref` up in `table` directly, because a direct lookup structurally
 * cannot produce it: a model-supplied `ref` is a snapshot-unique key, so
 * looking it up can only ever be "found" or "not found" (R-a's job, above).
 * `ambiguous` only exists one layer down, at `bindStep`'s descriptor-based
 * re-match (`bindStep(descriptorOf(item), table)`) — what a cross-snapshot
 * rebind actually runs. See validate.spec.ts's hand-built table where two
 * elements share one descriptor for a worked example of that re-match
 * genuinely coming back tied.
 */
export function judgeFirstStepBind(bind: BindResult): ClarifyEscalation | null {
  return bind.kind === 'ambiguous' ? 'CL-2' : null;
}
