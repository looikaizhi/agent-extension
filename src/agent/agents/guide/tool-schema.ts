import type { ToolSpec } from '@/agent/provider/types';
import type { GuideAgentEnvelope } from './registry';

/**
 * How one of the guide agent's intents is written as a function the model can
 * call — strict mode, every property required, no extra keys. Shared by every
 * intent's module, so each writes its own schema one way, and what the model
 * is offered does not depend on which file an intent happens to live in.
 *
 * Flat, the way the neutral `ToolSpec` is: Chat Completions nests a tool under
 * `function`, Responses does not, and Anthropic calls the schema
 * `input_schema`. Writing any one of those here would be the wire format
 * leaking back into the agent, which is what this seam exists to stop.
 */

export const str = (description?: string) => (description ? { type: 'string', description } : { type: 'string' });

/**
 * Optional, said the only way OpenAI's strict mode allows it to be said: a
 * union with null, with the key still listed in `required`. "Leave it out" is
 * not expressible there — every property must be required — so a model obeying
 * the schema writes an explicit null, and `contract.ts` reads null and absent
 * as the same event.
 */
export const nullable = (description: string) => ({ type: ['string', 'null'], description });

export const fn = (
  name: GuideAgentEnvelope['intent'],
  description: string,
  required: readonly string[],
  properties: Record<string, unknown>,
): ToolSpec => ({
  name,
  description,
  strict: true,
  inputSchema: { type: 'object', additionalProperties: false, required: [...required], properties },
});
