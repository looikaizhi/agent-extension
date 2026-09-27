import type { Talk } from '@/agent/conversation/entries';
import type { ModelContentPart, ModelMessage, ToolSpec } from '@/agent/provider/types';
import type { Ref } from '@/shared/types';
import type { PromptTable } from '@/core/extractor/types';
import type { ParseResult } from '@/agent/envelope/contract';
import type { GuideHistory } from '@/agent/context/user-message';
import type { NonceCache } from '@/agent/context/nonce';
import { tableOf, type Since, type TurnOnWire } from '@/agent/context/turn';
import { toPromptText } from '@/core/extractor/project';
import { INTENTS } from '@/agent/intents';
import { refsViolation, type ValidateResult } from '@/agent/envelope/validate';
import { CHOICE_GUIDE, LANGUAGE_GUIDE, MARK_GUIDE, TOOL_CHOICE_CLOSING, toolChoiceOpening } from '@/agent/prompts/system';
import { buildGuideUserMessage, buildToolResultText, FINAL_CALL_TEXT } from '@/agent/context/user-message';
import { parseToolContract, type EnvelopeReader } from '@/agent/envelope/contract';
import { GUIDE_INTENT_MODULES, isRegistered, moduleFor, moduleOf, type GuideAgentEnvelope } from './registry';

/**
 * The guide agent, in one place.
 *
 * A model call in this codebase is spread across two processes and eight
 * files by necessity, not by choice: the SSE request lives in the
 * side panel because a service worker is killed at 30 seconds (CONTEXT.md
 * `Panel`), and the decisions live in a pure reducer that never touches the
 * network (`Thread`). Both constraints are load-bearing and neither is negotiable. What
 * they cost is the ability to read the agent: to see, in one screen, what
 * system prompt it sends, what user message it builds, and what it does with
 * the answer. `machine.ts` imported the parser, `effects.ts` imported the
 * prompt builders, and nothing anywhere named the thing they belonged to.
 *
 * This file names it. `guideAgent` is the façade, and it assembles rather
 * than implements: the intents registered for it (`registry.ts`) bring their
 * own tools, policy lines, recognition and consequences; what both agents
 * share — the reading machinery, R-a/R-e — stays in
 * `envelope/contract.ts` / `envelope/validate.ts`; the prompt text stays in
 * `prompts/system.ts`. What it adds is the order — tools and policy lines in
 * registry order — and how an answer is read: by its own modules, with every
 * intent the product knows as the measure of what is someone else's. Everything it sends the model is frozen byte for
 * byte by `tests/unit/model-input-snapshot.spec.ts`, which is the only reason
 * to trust that moving a piece out of here changed no behaviour.
 *
 * Pure by construction: no `fetch`, no `chrome.*`, no `await`. Sending the
 * messages this file builds is `guide/runner.ts`'s job, and the architecture
 * guard keeps `host/` from ever reaching that far.
 */

/**
 * Everything the guide agent needs to know to plan its next move: the user's
 * goal, the page as it is right now, and where this guide has already been.
 *
 * The same three fields cross the wire as `CallModelParams` (`thread/effect.ts`)
 * — not a coincidence, since shipping this context to the panel is what that
 * wire is *for*. They stay two declarations all the same: `effect.ts` states
 * in its own header that it is deliberately a leaf, duplicating a few field
 * lists rather than importing, and collapsing one of those duplicates would
 * quietly repeal that. Structural typing means a `CallModelParams` is already
 * accepted wherever a `GuideContext` is asked for, so the duplication costs
 * nothing at the call site; if the two ever need to diverge, they can.
 */
export interface GuideContext {
  goal: string;
  table: PromptTable;
  history: GuideHistory;
  /** What the enabled Plugins add (`agent/context/plugins.ts`) — today a site's
   *  `Skill`, absent for every site without one, which is most of them. The
   *  system message stays general; this is where a site's own vocabulary goes
   *  instead. */
  contributions?: readonly string[];
  /** What was said earlier in this conversation (`CallModelParams.recent`). */
  recent?: readonly Talk[];
  /** Refs that appeared since the last call, when the page did not navigate.
   *  Absent on the first call and after every navigation. */
  freshRefs?: readonly Ref[];
  /** What woke the model, when a reading did. Absent otherwise. */
  since?: Since;
  /** The step's last call (ticket 09): only answers are on offer. */
  final?: true;
  /** The step's conversation so far (CONTEXT.md `Turn`), once it has a round.
   *  `table` is then the page read last — the one the schema's refs and the
   *  answer's check come from — and the opening message shows the turn's own. */
  turn?: TurnOnWire;
}

/**
 * The system message: the tool-choice policy — its opening, each registered
 * intent's own line in registry order, its closing — then how to pick a
 * control, how to read the table, and which language to answer in.
 */
const GUIDE_SYSTEM = [
  toolChoiceOpening(GUIDE_INTENT_MODULES.length),
  GUIDE_INTENT_MODULES.map((m) => m.policy).join('\n'),
  TOOL_CHOICE_CLOSING,
  CHOICE_GUIDE,
  MARK_GUIDE,
  LANGUAGE_GUIDE,
].join('\n\n');

/** One message that is nothing but text. Parts rather than a bare string
 *  because that is what every protocol can express; which of them collapses it
 *  back to a string is the adapter's business, not this file's. */
const said = (role: ModelMessage['role'], text: string): ModelMessage => ({ role, content: [{ type: 'text', text }] });

/**
 * An envelope-shaped object whose `intent` is not one an agent answers with —
 * `locate` (S6), or anything else a future stage introduces. `validate` below
 * accepts this alongside its own envelopes on purpose: its intent
 * gate does not assume the caller went through recognition first — a caller,
 * or a test, must be able to hand it a shape recognition does not even know
 * yet, with no cast.
 */
export interface UnknownIntentEnvelope {
  intent: string;
  [key: string]: unknown;
}

/** §5.8: an intent an agent does not answer with is a contract violation, not
 *  a question for the user — it goes to `violation`, never `ask`. */
const unknownIntent = (intent: string) => `intent「${intent}」不在已知范围内`;

/** Recognition as this agent does it: each answer by its module, and the
 *  list an unrecognised answer is told is the same registry, read off once. */
const GUIDE_READER: EnvelopeReader<GuideAgentEnvelope> = { shapeFor: moduleFor, known: INTENTS };

export const guideAgent = {
  name: 'guide',

  /**
   * Every intent the guide agent can answer with, as a function the model
   * calls, in registry order — expressed the way every mainstream endpoint
   * expects it rather than as a bespoke text format only a strong model can
   * follow.
   *
   * `strict: true` on every one (`tool-schema.ts`): a `required` array the
   * model was dropping in 2 of 16 draws stopped being dropped. Partial
   * enforcement is still worth having.
   *
   * No `intent` property anywhere: the function name carries it (see
   * `parseToolContract`), and asking for it makes the model write prose.
   *
   * The descriptions carry the *bar* for reaching a tool, not just a label —
   * the measurement behind that sits with the tool it was about
   * (`output/ask.ts`).
   *
   * On a step's last call only the answers are offered: a step that has
   * looked three times has to say what it has, not look again.
   */
  outputSchema: (ctx: GuideContext): ToolSpec[] =>
    GUIDE_INTENT_MODULES.filter((m) => !ctx.final || m.kind === 'output').map((m) => m.tool(ctx)),

  /** The system message, verbatim — the same string `buildMessages` sends. */
  instructions: GUIDE_SYSTEM,

  /**
   * The system message, the user message, then one call-and-result pair per
   * tool round — in the order they happened, the call replayed as the model
   * made it and its result paired by the call's id.
   *
   * The user message is the page the step opened on, rebuilt byte for byte on
   * every round so the endpoint's prefix cache holds; what the model read
   * since is in the rounds. `nonces` keeps one nonce per snapshot for the
   * same reason (`context/nonce.ts`); without it each page gets a fresh one.
   *
   * On a step's last call one more message comes after everything, ours:
   * answer now (`FINAL_CALL_TEXT`). Last, so nothing before it changes.
   */
  buildMessages: (ctx: GuideContext, nonces?: NonceCache): ModelMessage[] => {
    const nonceOf = (t: PromptTable) => nonces?.(t.snapshotId, toPromptText(t));
    const opening = ctx.turn?.table ?? ctx.table;
    const fresh = ctx.turn ? ctx.turn.freshRefs : ctx.freshRefs;
    const since = ctx.turn ? ctx.turn.since : ctx.since;
    return [
      said('system', GUIDE_SYSTEM),
      said('user', buildGuideUserMessage(ctx.goal, opening, ctx.history, ctx.contributions, fresh, nonceOf(opening), since, ctx.recent)),
      ...(ctx.turn?.rounds ?? []).flatMap((r): ModelMessage[] => {
        const read = tableOf(r.result);
        // One nonce per snapshot for a page; per call for a document, which is
        // the same text on every later round of the step.
        const nonce = read ? nonceOf(read) : r.result.kind === 'doc' ? nonces?.(r.call.id, r.result.text) : undefined;
        return [
          {
            role: 'assistant',
            // The reasoning item first, then the call it reasoned toward — the
            // order OpenAI Responses requires, and nothing for a protocol that
            // reports none (`context/turn.ts`).
            content: [
              ...(r.call.reasoning ? [r.call.reasoning] : []),
              { type: 'tool-call' as const, toolCallId: r.call.id, toolName: r.call.name, input: r.call.args },
            ],
          },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: r.call.id, output: buildToolResultText(r.result, nonce) }] },
        ];
      }),
      ...(ctx.final ? [said('user', FINAL_CALL_TEXT)] : []),
    ];
  },

  /**
   * The endpoint reports which function the model called; that name is the
   * intent. `rawArgs` is what the model wrote, byte for byte, and the
   * provenance scanner runs on exactly that (see `parseToolContract`).
   */
  parseOutput: (toolName: string, rawArgs: string): ParseResult<GuideAgentEnvelope> =>
    parseToolContract(toolName, rawArgs, GUIDE_READER),

  /**
   * Takes the table rather than a whole `GuideContext`: R-a…R-f judge an
   * envelope against the page it was written for, and neither the goal nor
   * the history is an input to any of them. Handing it a context would mean
   * `machine.ts` assembling two fields nothing reads.
   */
  validate: (
    envelope: GuideAgentEnvelope | UnknownIntentEnvelope,
    table: PromptTable,
  ): ValidateResult<GuideAgentEnvelope> => {
    if (!isRegistered(envelope)) return { kind: 'violation', reason: unknownIntent(envelope.intent) };
    const m = moduleOf(envelope);
    // The shared rules first — every ref the envelope claims is on this table
    // and not sensitive (R-a/R-e) — then the answering intent's own. A plan
    // that breaks both is refused for the ref.
    const reason = refsViolation(m.claimedRefs(envelope), table) ?? m.violation(envelope, table);
    return reason === null ? { kind: 'ok', envelope } : { kind: 'violation', reason };
  },
} as const;
