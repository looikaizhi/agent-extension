import type { ProtocolId } from '@/shared/settings';
import type { Protocol } from '../types';
import { openaiChat } from './openai-chat';
import { openaiResponses } from './openai-responses';

/**
 * Every wire format this product can speak, by id.
 *
 * A `Record<ProtocolId, Protocol>` rather than an array: the ids are declared
 * with the rest of what gets stored (`shared/settings.ts`), so an id that a
 * saved config could carry and no adapter answers for does not compile. The
 * settings page reads this to offer the choice; the run loop will read it to
 * make one, once it speaks neutral.
 */
export const PROTOCOLS: Record<ProtocolId, Protocol> = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
};
