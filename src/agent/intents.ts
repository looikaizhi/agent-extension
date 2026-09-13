import type { Never } from '@/shared/types';
import { GUIDE_INTENT_MODULES, type GuideAgentEnvelope } from './agents/guide/registry';
import { QUESTION_OUTPUT_MODULES, type QuestionEnvelope } from './agents/question/registry';

/**
 * Every intent this product knows, across both agents — read off their
 * registries, so an intent exists here exactly when some module answers with
 * it. Question first, then the guide's own: the order the product has always
 * listed them in, back to a model that named one nobody knows.
 *
 * Both agents read this list, so each loads the other's registry. That is the
 * price of telling "the other agent's answer" apart from "a malformed one":
 * the first is said plainly, the second is repaired.
 */
export type Intent = Envelope['intent'];

/** Every envelope either agent answers with (CONTEXT.md `Envelope`). */
export type Envelope = QuestionEnvelope | GuideAgentEnvelope;
export const INTENTS: readonly Intent[] = [
  ...new Set<Intent>([...QUESTION_OUTPUT_MODULES, ...GUIDE_INTENT_MODULES].map((m) => m.intent)),
];

/** An intent both agents answer with is one shape: the envelopes the two
 *  registries give it are the same type, both ways. */
type SharedIntent = QuestionEnvelope['intent'] & GuideAgentEnvelope['intent'];
type _OneShapePerSharedIntent = Never<
  | Exclude<Extract<QuestionEnvelope, { intent: SharedIntent }>, Extract<GuideAgentEnvelope, { intent: SharedIntent }>>
  | Exclude<Extract<GuideAgentEnvelope, { intent: SharedIntent }>, Extract<QuestionEnvelope, { intent: SharedIntent }>>
>;
