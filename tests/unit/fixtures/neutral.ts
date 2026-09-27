import type { ModelDelta, ModelMessage, ModelUsage } from '@/agent/provider/types';

/**
 * Writing a scripted endpoint's answer, now that an answer is a sequence of
 * typed events rather than a bag of optional fields.
 *
 * These exist because the same three shapes were being hand-written in a dozen
 * files, and because a discriminated union makes the hand-written version
 * longer than the thing it is standing in for. Nothing here decides anything —
 * every test still says what its endpoint answers; it just says it once.
 */

/** A message's text. Parts that are not text (a tool call, a result) render as
 *  nothing, which is what a reader of the prompt sees. */
export const textOf = (m: ModelMessage | undefined): string =>
  (m?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

export const USAGE: ModelUsage = { prompt: 10, completion: 20, total: 30, estimated: false };

/** The last event of every stream, without exception (CONTEXT.md — 用量落在最后一个 delta 上). */
export const finish = (usage: ModelUsage | undefined = USAGE, reason?: string): ModelDelta => ({
  type: 'finish',
  ...(reason ? { reason } : {}),
  ...(usage ? { usage } : {}),
});

/**
 * One tool call, split across `pieces` fragments the way a real endpoint
 * streams it: the start event first, then the arguments a piece at a time.
 */
export function toolCall(
  name: string,
  args: string,
  { id, index = 0, pieces = 1 }: { id?: string; index?: number; pieces?: number } = {},
): ModelDelta[] {
  const size = Math.ceil(args.length / pieces) || args.length;
  const fragments = pieces <= 1 ? [args] : (args.match(new RegExp(`[\\s\\S]{1,${Math.max(1, size)}}`, 'g')) ?? [args]);
  return [
    { type: 'tool-input-start', ...(id ? { id } : {}), name, index },
    ...fragments.filter(Boolean).map((delta): ModelDelta => ({ type: 'tool-input-delta', index, delta, raw: delta })),
  ];
}

/** A stream that is one tool call and nothing else. */
export const answering = (name: string, args: string, opts?: { id?: string; index?: number; pieces?: number }): ModelDelta[] => [
  ...toolCall(name, args, opts),
  finish(),
];

/** A stream that is prose and no tool call — an endpoint ignoring `tool_choice`. */
export const saying = (text: string): ModelDelta[] => [{ type: 'text-delta', text }, finish()];
