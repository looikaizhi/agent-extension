import type { ChatMessage } from '@/agent/provider/provider';
import type { PromptTable } from '@/core/extractor/types';
import { INTENTS } from '@/agent/intents';
import { parseContract, type EnvelopeReader, type ParseResult } from '@/agent/envelope/contract';
import { LANGUAGE_GUIDE, MARK_GUIDE, answerShapeOpening } from '@/agent/prompts/system';
import { buildQuestionUserMessage } from '@/agent/context/user-message';
import { refsViolation, type ValidateResult } from '@/agent/envelope/validate';
import type { QuestionAnswer } from './output-module';
import { QUESTION_OUTPUT_MODULES, moduleFor, moduleOf, type QuestionEnvelope, type QuestionIntent } from './registry';

/**
 * The question agent, in one place — the same shape as the guide agent
 * (`guide/agent.ts`): a name, its instructions, how it builds its messages,
 * the shape of an answer, how an answer is read, and how it is checked.
 *
 * It answers in free-text JSON, not through tool calling, so its answer shape
 * is prose the model reads (`outputShape`) rather than a schema. Pure by
 * construction: no `fetch`, no `chrome.*`, no `await`. Sending the messages
 * is `question/runner.ts`'s job.
 */

export interface QuestionContext {
  /** What the user asked. Surrounding whitespace is not part of the question. */
  question: string;
  table: PromptTable;
}

/** What an answer must look like, in the prose the model reads: the opening,
 *  then each answer's own paragraph, numbered in registry order. */
const ANSWER_SHAPE = [
  answerShapeOpening(QUESTION_OUTPUT_MODULES.length),
  ...QUESTION_OUTPUT_MODULES.map((m, i) => `${i + 1}. ${m.shape}`),
].join('\n\n');

/** The system message: the answer shape, how to read the table, and which
 *  language to answer in. */
const QUESTION_SYSTEM = [ANSWER_SHAPE, MARK_GUIDE, LANGUAGE_GUIDE].join('\n\n');

/** Recognition as this agent does it: its own answers by their modules, and
 *  every other intent the product knows as the guide agent's. */
const QUESTION_READER: EnvelopeReader<QuestionEnvelope> = { shapeFor: moduleFor, known: INTENTS };

export const questionAgent = {
  name: 'question',

  /** The system message, verbatim — the same string `buildMessages` sends. */
  instructions: QUESTION_SYSTEM,

  /** What an answer must look like. The repair request carries it too, since
   *  that request never sees the first one. */
  outputShape: ANSWER_SHAPE,

  buildMessages: (ctx: QuestionContext): ChatMessage[] => [
    { role: 'system', content: QUESTION_SYSTEM },
    { role: 'user', content: buildQuestionUserMessage(ctx.question.trim(), ctx.table) },
  ],

  parseOutput: (raw: string): ParseResult<QuestionEnvelope> => parseContract(raw, QUESTION_READER),

  /** R-a/R-e against the page the question was asked on: every ref the answer
   *  points at is on the table and not sensitive. A question's answers have no
   *  rules of their own beyond these. */
  validate: (envelope: QuestionEnvelope, table: PromptTable): ValidateResult<QuestionEnvelope> => {
    const reason = refsViolation(moduleOf(envelope).claimedRefs(envelope), table);
    return reason === null ? { kind: 'ok', envelope } : { kind: 'violation', reason };
  },

  /** What the panel shows for an answer that passed `validate`, and what it
   *  highlights — the answering module's to say. */
  answer: (envelope: QuestionEnvelope, table: PromptTable): QuestionAnswer<QuestionIntent> =>
    moduleOf(envelope).answer(envelope, table),
} as const;
