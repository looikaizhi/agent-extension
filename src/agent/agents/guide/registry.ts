import { needDocs } from '@/agent/tools/need-docs';
import { clarify } from './output/clarify';
import { guide } from './output/guide';
import { done } from './output/done';
import type { GuideIntentModule } from './intent-module';

/**
 * The one place a guide intent is registered. Everything that needs to know
 * which intents exist — the tools the model is offered, the system message's
 * policy, recognition, validation, the trace, the reducer — asks here first.
 *
 * The order here is the order the model reads them in — the tools it is
 * offered and the lines of the tool-choice policy both follow it. Every intent
 * the guide agent answers with is here; the contract keeps only what both
 * agents share.
 */
export const GUIDE_INTENT_MODULES = [guide, clarify, needDocs, done] as const;

type EnvelopeOf<M> = M extends GuideIntentModule<infer E> ? E : never;

/** The envelopes the guide agent answers with. */
export type GuideAgentEnvelope = EnvelopeOf<(typeof GUIDE_INTENT_MODULES)[number]>;

const MODULES: readonly GuideIntentModule<GuideAgentEnvelope>[] = GUIDE_INTENT_MODULES;

export function moduleFor(intent: string): GuideIntentModule<GuideAgentEnvelope> | undefined {
  return MODULES.find((m) => m.intent === intent);
}

export function isRegistered(envelope: { intent: string }): envelope is GuideAgentEnvelope {
  return moduleFor(envelope.intent) !== undefined;
}

/** The module an envelope's own intent names, typed for exactly that envelope. */
export function moduleOf<E extends GuideAgentEnvelope>(envelope: E): GuideIntentModule<E> {
  const m = moduleFor(envelope.intent);
  if (!m) throw new Error(`registry: no module for「${envelope.intent}」`);
  // The one cast in the registry: the module found by an envelope's own
  // intent is, by construction, the module for that envelope.
  return m as unknown as GuideIntentModule<E>;
}
