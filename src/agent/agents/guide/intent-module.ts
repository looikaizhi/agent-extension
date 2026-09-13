import type { EnvelopeShape } from '@/agent/envelope/contract';
import type { ToolDef } from '@/agent/provider/provider';
import type { ThreadState } from '@/agent/thread/thread';
import type { StepOut } from '@/agent/thread/transitions';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import type { GuideContext } from './agent';

/**
 * Everything one of the guide agent's intents is, in one module — whether it
 * is a `Tool` (its result goes back to the model) or an `Output` (saying it
 * ends the call; CONTEXT.md).
 *
 * The six parts used to live in six files that never imported each other: the
 * schema in the agent, recognition in the contract, its rule in the validator,
 * its paragraph in the prompt, its consequence in the reducer, its line in the
 * trace. Adding an intent meant finding all of them. Now it means writing one
 * of these and registering it (`registry.ts`): the agent's envelope union is
 * read off the registry.
 *
 * This is the guide agent's shape: its consequence acts on a `Thread`. Where a
 * module lives follows what it is — a `Tool` under `src/agent/tools/`, an
 * `Output` beside the agent that answers with it.
 *
 * Left out on purpose: how the result is shown. That happens in a process of
 * its own — the host, or the panel — and nothing under `src/agent` may touch
 * `chrome.*`.
 */
export interface GuideIntentModule<E extends { intent: string }> extends EnvelopeShape<E> {
  readonly intent: E['intent'];
  /** What the model is offered: this intent as a function it can call. */
  tool(ctx: GuideContext): ToolDef;
  /** Its line in the system message's tool-choice policy — the bar for reaching for it. */
  readonly policy: string;
  /** Every ref this envelope stakes a claim on — the set R-a and R-e run over. */
  claimedRefs(envelope: E): readonly Ref[];
  /** Its own rules, run after the shared ones (every claimed ref is on the
   *  table and not sensitive): why the envelope is refused, or `null`. */
  violation(envelope: E, table: PromptTable): string | null;
  /** Its free-text reasons, for the trace. */
  rationales(envelope: E): readonly string[];
  /** What the reducer does with it. Pure, like the reducer: N-2 covers every
   *  file the reducer can load. */
  consequence(state: ThreadState, envelope: E, ids: { nextEffectId: string; nextRev: number }): StepOut;
}
