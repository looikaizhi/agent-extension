import { complete, describeProviderError, type ChatMessage, type Usage } from '@/agent/provider/provider';
import { buildRepairPrompt } from '@/agent/prompts/repair';
import type { ProviderConfig } from '@/shared/settings';
import { questionAgent, type QuestionContext } from './agent';
import type { QuestionEnvelope } from './registry';

/**
 * The question agent's run loop, in one straight line: first call → read →
 * (read failed) exactly one repair → read → check. No loop, no retry counter —
 * "1 主调用 + ≤1 修复" falls out of there being exactly two literal calls to
 * `send` below, not out of anything that counts. `send` reads one request to
 * its end and returns; it never calls itself and never decides to try again,
 * so sharing it costs the bound nothing — the same way the guide's loop shares
 * its own.
 *
 * Its repair is not the guide's. The guide resends its whole request with a
 * note appended; a question's repair is a brand-new minimal conversation that
 * never sees the page (design doc §5.9) — which is why each agent has a loop
 * of its own.
 *
 * It used to live inside the side panel's React component, where nothing
 * could run it without a browser. Here it runs in node against any
 * `complete`. The panel still triggers it, cancels it and shows what it says;
 * it no longer calls the model, reads the answer or starts a repair.
 */

/** Which of the two requests an event is about. */
export type QuestionCall = 'primary' | 'repair';

/** What the panel shows while it waits. Never load-bearing: drop every one of
 *  these and the run still produces the same result. */
export type QuestionEvent =
  /** How much of an answer has arrived — a count, never the text. What has
   *  arrived has not been read or checked yet, and may never become a legal
   *  envelope at all (要害三). */
  | { kind: 'receiving'; call: QuestionCall; chars: number }
  /** A request that reached the provider, with what it said it cost — `null`
   *  when it failed before saying. It went out either way, so it counts. */
  | { kind: 'billed'; call: QuestionCall; usage: Usage | null }
  | { kind: 'repairing' };

export type QuestionResult =
  | { kind: 'answered'; envelope: QuestionEnvelope }
  /**
   * `transport`: the provider or the network — nothing was said. `parse`: the
   * model answered, but not as a question's envelope, even after the repair.
   * `violation`: a well-formed answer that points at something it may not.
   * They read alike as a sentence and mean different things to the user.
   */
  | { kind: 'failed'; reason: 'transport' | 'parse' | 'violation'; message: string }
  /** Cancelled — a newer question, a tab switch, the panel closing. Not a
   *  failure, and nothing to say. */
  | { kind: 'aborted' };

const ABORTED: QuestionResult = { kind: 'aborted' };

const notForQuestions = (intent: string) => `模型返回了问答流程不支持的信封类型「${intent}」。`;

/** One request, read to its end: the text, or what it failed with. What
 *  arrives is counted and billed as it comes; it is never shown. */
async function send(
  completeFn: typeof complete,
  cfg: ProviderConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  call: QuestionCall,
  onEvent: (e: QuestionEvent) => void,
): Promise<{ text: string } | { error: unknown }> {
  let text = '';
  try {
    for await (const d of completeFn(cfg, messages, signal)) {
      text += d.content;
      if (d.usage) onEvent({ kind: 'billed', call, usage: d.usage });
      else onEvent({ kind: 'receiving', call, chars: text.length });
    }
    return { text };
  } catch (error) {
    return { error };
  }
}

export async function runQuestion(
  ctx: QuestionContext,
  cfg: ProviderConfig,
  signal: AbortSignal,
  onEvent: (e: QuestionEvent) => void = () => {},
  completeFn: typeof complete = complete,
): Promise<QuestionResult> {
  // ─── Primary call: the only place this question spends money before
  // knowing whether the output even parses. ───
  const primary = await send(completeFn, cfg, questionAgent.buildMessages(ctx), signal, 'primary', onEvent);
  if (signal.aborted) return ABORTED; // superseded or closed — not a failure, and nothing to bill
  if ('error' in primary) {
    // The request went out even though it failed, so it still counts.
    onEvent({ kind: 'billed', call: 'primary', usage: null });
    return { kind: 'failed', reason: 'transport', message: describeProviderError(primary.error) };
  }

  let reading = questionAgent.parseOutput(primary.text);

  if (reading.kind === 'error') {
    onEvent({ kind: 'repairing' });
    // ─── Repair call: the structurally-guaranteed *only* second attempt — a
    // brand-new minimal conversation carrying the first answer verbatim,
    // never the original one with the bad output appended, and never fed the
    // page content a second time. There is no third call site for this to
    // loop into. ───
    const repair = await send(completeFn, cfg, buildRepairPrompt(primary.text, questionAgent.outputShape), signal, 'repair', onEvent);
    if (signal.aborted) return ABORTED;
    if ('error' in repair) {
      onEvent({ kind: 'billed', call: 'repair', usage: null });
      return { kind: 'failed', reason: 'transport', message: describeProviderError(repair.error) };
    }
    reading = questionAgent.parseOutput(repair.text);
  }

  if (reading.kind === 'error') return { kind: 'failed', reason: 'parse', message: reading.message };
  // The guide agent's answer, on either call: said plainly, never repaired —
  // a repair would only be asked to rewrite a well-formed answer into a shape
  // it did not mean.
  if (reading.kind === 'foreign') return { kind: 'failed', reason: 'parse', message: notForQuestions(reading.intent) };

  const validated = questionAgent.validate(reading.envelope, ctx.table);
  if (validated.kind === 'violation') return { kind: 'failed', reason: 'violation', message: validated.reason };
  return { kind: 'answered', envelope: reading.envelope };
}
