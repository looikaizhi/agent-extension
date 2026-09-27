import { guideAgent, type GuideContext } from '@/agent/agents/guide/agent';
import type { ModelMessage } from '@/agent/provider/types';

/**
 * What the model reads, as text — the one place that knows how to render a
 * `Context` into it.
 *
 * Two things downstream ask that same question and must never answer it
 * differently. The fingerprint asks it to decide whether two eval results are
 * comparable; the Decision corpus asks it to prove a recorded state replays as
 * the same call. Written twice, they drift the day either side changes — and
 * the failure is silent on both: the fingerprint would report a difference
 * that is not there, and the corpus check would report a match that is not
 * either.
 *
 * Three strings and nothing else, because three strings are all a protocol
 * cannot touch. The request's other fields — the wire's key order, `stream`,
 * `tool_choice`, whatever a preset adds — belong to a wire format, and hashing
 * them made the answer to "did the prompt change?" move every time the *way*
 * it was sent changed.
 */

/** The wrapper around the element table carries a random marker (S-01).
 *  Pinned to one value on every side, so everything else can be compared. */
export const NONCE = '00000000-0000-4000-8000-000000000000';

export interface RenderedCall {
  system: string;
  user: string;
  tools: string;
}

/** A message's text. Messages are content parts; these three are not, and the
 *  reason they stay text is written on `Trace` in `src/shared/types.ts`. */
const textOf = (m: ModelMessage | undefined): string =>
  (m?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

export function renderedCall(ctx: GuideContext, nonce: () => string = () => NONCE): RenderedCall {
  const [system, user] = guideAgent.buildMessages(ctx, nonce);
  return {
    system: textOf(system),
    user: textOf(user),
    tools: JSON.stringify(guideAgent.outputSchema(ctx)),
  };
}
