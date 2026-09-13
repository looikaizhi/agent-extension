import type { QuestionOutputModule } from './output-module';
import { clarify } from './output/clarify';
import { explain } from './output/explain';
import { needText } from './output/need-text';

/**
 * The one place a question's answers are registered. The order here is the
 * order the model reads them in — the numbered paragraphs of the answer-shape
 * guide follow it.
 */
export const QUESTION_OUTPUT_MODULES = [explain, clarify, needText] as const;

type EnvelopeOf<M> = M extends QuestionOutputModule<infer E> ? E : never;

/** The envelopes a question can be answered with. */
export type QuestionEnvelope = EnvelopeOf<(typeof QUESTION_OUTPUT_MODULES)[number]>;
export type QuestionIntent = QuestionEnvelope['intent'];

const MODULES: readonly QuestionOutputModule<QuestionEnvelope>[] = QUESTION_OUTPUT_MODULES;

export function moduleFor(intent: string): QuestionOutputModule<QuestionEnvelope> | undefined {
  return MODULES.find((m) => m.intent === intent);
}

/** The module an envelope's own intent names, typed for exactly that envelope. */
export function moduleOf<E extends QuestionEnvelope>(envelope: E): QuestionOutputModule<E> {
  const m = moduleFor(envelope.intent);
  if (!m) throw new Error(`registry: no module for「${envelope.intent}」`);
  // The one cast in the registry: the module found by an envelope's own
  // intent is, by construction, the module for that envelope.
  return m as unknown as QuestionOutputModule<E>;
}
