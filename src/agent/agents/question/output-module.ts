import type { ClarifyOption, EnvelopeShape } from '@/agent/envelope/contract';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/** What the panel shows for an answer, and what it highlights. */
export interface QuestionAnswer<I extends string> {
  intent: I;
  /** `explain`: the model's `answer`. `clarify`: the model's `question`.
   *  `need_text`: a fixed, non-fabricated string — see `NEED_TEXT_MESSAGE`. */
  message: string;
  /** Resolved elements to highlight. Empty means "send no highlight request" —
   *  `explain` with no refs, or `need_text` always. */
  items: readonly PromptItem[];
  /** `clarify` only: every candidate's label, for display next to the
   *  highlight. Never used to pick one — the caller passes all of `items`
   *  through to the host, which puts them all in `alsoRefs` (K-6). */
  options?: readonly ClarifyOption[];
}

/**
 * One of the question agent's answers, in one module — an `Output`
 * (CONTEXT.md): its paragraph in the answer-shape guide, how it is recognised,
 * what the model is told when it is not, the refs it claims, and what the
 * panel shows for it.
 *
 * Its own interface, not the guide's (`guide/intent-module.ts`): a question is
 * answered in text, so there is no tool to offer, and it is stateless, so
 * nothing it does acts on a `Thread`. `clarify` shares only its shape with the
 * guide agent — through the contract, not through this interface.
 */
export interface QuestionOutputModule<E extends { intent: string }> extends EnvelopeShape<E> {
  readonly intent: E['intent'];
  /** Its paragraph in the answer-shape guide; the agent numbers them in
   *  registry order. */
  readonly shape: string;
  /** Every ref this envelope stakes a claim on — the set R-a and R-e run over. */
  claimedRefs(envelope: E): readonly Ref[];
  /** What the panel shows for it, and what it highlights. Pure: the showing is
   *  the panel's. */
  answer(envelope: E, table: PromptTable): QuestionAnswer<E['intent']>;
}

/**
 * Looks up `refs` in `table.items`, preserving order, dropping anything not
 * found. In practice nothing is ever dropped: R-a already proved every claimed
 * ref exists in this same table before an answer is shown. The filter exists
 * so this function's own contract does not silently depend on that upstream
 * guarantee holding forever.
 */
export function itemsFor(refs: readonly Ref[], table: PromptTable): PromptItem[] {
  const byRef = new Map(table.items.map((i) => [i.ref, i] as const));
  const out: PromptItem[] = [];
  for (const ref of refs) {
    const item = byRef.get(ref);
    if (item) out.push(item);
  }
  return out;
}
