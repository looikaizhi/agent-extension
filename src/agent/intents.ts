import { GUIDE_INTENT_MODULES, type GuideAgentEnvelope } from './agents/guide/registry';

/**
 * Every intent this product knows — read off the one agent's registry, so an
 * intent exists here exactly when some module answers with it (CONTEXT.md
 * `Agent`: there is one). What an answer naming anything else is told, it is
 * told from this list.
 */
export type Intent = Envelope['intent'];

/** Every envelope the agent answers with (CONTEXT.md `Envelope`). */
export type Envelope = GuideAgentEnvelope;
export const INTENTS: readonly Intent[] = GUIDE_INTENT_MODULES.map((m) => m.intent);
