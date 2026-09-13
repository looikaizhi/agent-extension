import type { BindResult } from '@/core/descriptor/bind';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideExpectAfter } from '@/shared/types';
import type { Check, ClarifyTrigger } from './thread';

/**
 * What the reducer judges about a page it landed on, rather than about what
 * the model wrote. `judgeArrival` settles the `Check` axis: whether a step's
 * predicted landing (a guide answer's `expect_after`) showed up. Only a
 * breakpoint can answer that, and the guide module already imports the
 * Thread's helpers, so living there would close a cycle through
 * `transitions.ts`.
 *
 * `judgeFirstStepBind` is CL-2's judgement over a table-only bind. Nothing in
 * the product calls it — the reducer's `bind_result` handler reads the
 * renderer's live report instead (see its comment in `machine.ts`). It came
 * here with the move; deleting it is a change of its own.
 */

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
  // Role alone is not evidence. A model that knows it will land on *a link*
  // but cannot say which one has told us almost nothing — "does this page have
  // any link" passes on nearly every page, and a `pass` that always passes
  // devalues the whole `Check` axis. So this is `skipped`: not checked, rather
  // than checked against something that cannot fail.
  //
  // The alternative was to keep refusing the envelope outright, which is what
  // `contract.ts` used to do. That is worse in the one direction that matters —
  // strict mode forces every property to be present, so demanding a name the
  // model does not have is an invitation to invent one, and a made-up
  // expectation is worse than no expectation. Accept the honest "I don't know",
  // and decline to grade it.
  const name = expect.must_contain?.name;
  if (name === undefined) return 'skipped';
  const role = expect.must_contain!.role;
  return table.items.some((i) => i.role === role && norm(i.name) === norm(name)) ? 'pass' : 'unknown';
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * CL-2: "the first step's bind comes back `ambiguous`". The bind attempt
 * itself is out of this file's scope — it needs a live DOM extraction
 * against the tab's *current* page — but the
 * judgment ("given that result, do we escalate to `clarify`") does not need
 * one. It is checked here, on a `BindResult`, rather than by looking the
 * model's `ref` up in `table` directly, because a direct lookup structurally
 * cannot produce it: a model-supplied `ref` is a snapshot-unique key, so
 * looking it up can only ever be "found" or "not found" (R-a's job, in `envelope/validate.ts`).
 * `ambiguous` only exists one layer down, at `bindStep`'s descriptor-based
 * re-match (`bindStep(descriptorOf(item), table)`) — what a cross-snapshot
 * rebind actually runs. See validate.spec.ts's hand-built table where two
 * elements share one descriptor for a worked example of that re-match
 * genuinely coming back tied.
 */
export function judgeFirstStepBind(bind: BindResult): Extract<ClarifyTrigger, 'CL-2'> | null {
  return bind.kind === 'ambiguous' ? 'CL-2' : null;
}
