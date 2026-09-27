import type { ParseResult } from '@/agent/envelope/contract';
import { verdictFor, type ProviderConfig } from '@/shared/settings';
import { callModel } from '@/agent/provider/call';
import type { ModelContentPart, ModelMessage, ToolSpec } from '@/agent/provider/types';
import { describeProviderError, ProviderError } from '@/agent/provider/transport';
import type { EffectFailureKind, EffectUsage } from '@/agent/thread/effect';
import { guideAgent, type GuideContext } from './agent';
import type { GuideAgentEnvelope } from './registry';
import type { NonceCache } from '@/agent/context/nonce';

/**
 * The guide agent's run loop, in one readable pass: build messages → send →
 * parse → (repair once) → validate. Python's agent SDKs give you this shape
 * for free; here it had to be reassembled, because the 30-second service-worker limit (CONTEXT.md `Panel`) forces the actual
 * request to happen in the side panel while every decision about it belongs
 * to the pure reducer in the service worker.
 *
 * This file is the only place in `src/agent` that *asks* for the network, and
 * it does so through `callModel()` alone — which asks `transport.ts`, the one
 * file that actually opens a socket. `tests/unit/architecture.spec.ts`
 * forbids anything under `agent/host/` from reaching it — the host decides,
 * the runner executes, and nothing about that split changes just because the
 * two now sit under one directory.
 *
 * It is an async generator on purpose. The events it yields are what an
 * observer needs to answer "what did we actually send, and what came back"
 * (`guide/trace.ts` subscribes to them); the value it *returns* is what the
 * caller needs to make decisions. Keeping those apart matters: a caller that
 * ignores every event still gets `providerCalls` and `failureKind`, so no
 * accounting depends on somebody having remembered to listen.
 */

/** What an observer sees. Never load-bearing — drop every one of these and
 *  the run still produces the same `RunResult`. */
export type RunEvent =
  | { kind: 'request'; system: string; user: string; tools?: string }
  | { kind: 'raw'; text: string }
  | { kind: 'parse_error'; message: string }
  | { kind: 'repair'; system: string; user: string }
  | { kind: 'settled'; envelope: GuideAgentEnvelope }
  | { kind: 'violation'; reason: string };

export interface RunResult {
  /** The model's original text, verbatim. On the repair path this is the
   *  repaired output, because that is the text that parsed — the provenance
   *  scanner (CONTEXT.md `Provenance`) has to run over what was actually said. */
  raw: string;
  usage?: EffectUsage;
  /**
   * How many requests actually reached the provider. `1` normally, `2` when
   * the repair round ran, `0` when the first request never left. The host
   * charges its quota against this rather than against "one per effect",
   * which is what let 12 dispatched effects spend up to 24 real requests
   * while `callCount` reported 12 (design doc §5.9).
   */
  providerCalls: number;
  /**
   * Why the run failed, as the wire's three kinds. `transport` is the provider
   * or the network — nothing was said. `parse` is a model that answered but
   * not in the envelope shape, twice. `violation` is a well-formed envelope
   * that R-a…R-e refused. They read identically as an error string and mean
   * completely different things to the user, which is why the host used to
   * greet all three with 「调用失败」.
   */
  failure?: { kind: EffectFailureKind; error: string; retryable: boolean };
  /** The function the model called. The host needs it to re-derive the
   *  envelope: `raw` is the arguments text and carries no intent. */
  tool?: string;
  /** The endpoint's id for that call, when it gave one — what a tool round is
   *  paired by when it is replayed to the model with its result. */
  callId?: string;
  /** The reasoning the endpoint reported before that call, opaque, to go back
   *  with its result. Absent on protocols that report none. */
  reasoning?: Extract<ModelContentPart, { type: 'reasoning' }>;
}

/**
 * Adds why the endpoint stopped, when it says something a reader can act on.
 *
 * Only `length` earns a sentence: it turns "the model wrote broken JSON" into
 * "the model was cut off mid-answer", and those want opposite responses. Every
 * other value is left out on purpose — the vocabulary varies between
 * endpoints, and a message that guesses is worse than one that does not
 * mention it. A corpus entry once carried arguments that ended mid-token and
 * was filed as a malformed model; nothing in the record could say otherwise.
 */
const explain = (message: string, finishReason?: string): string =>
  finishReason === 'length' ? `${message}（端点报告输出被截断：finish_reason=length）` : message;

const isRetryable = (err: unknown): boolean => (err instanceof ProviderError ? err.retryable : true);

/**
 * Within one request the last `usage` wins; across requests they add.
 *
 * The provider layer emits `usage` exactly once, on the final `Delta` of a
 * stream (`provider.ts`'s `parseDataLine`, and effect.spec.ts's own note),
 * so in practice a call contributes one number and the two halves of this
 * rule never disagree. Spelling it out anyway, because the code this replaces
 * used *both* rules — assignment on the first request, per-delta accumulation
 * on the repair — and an endpoint that reported cumulative usage per chunk
 * would have made the repair path silently multiply the bill.
 */
const addUsage = (a: EffectUsage | undefined, b: EffectUsage | undefined): EffectUsage | undefined => {
  if (!a || !b) return a ?? b;
  const cached = (a.cachedPrompt ?? 0) + (b.cachedPrompt ?? 0);
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
    // Absent on both sides stays absent: a repair whose endpoint reported no
    // cache figure must not be summed into a confident zero.
    ...(a.cachedPrompt !== undefined || b.cachedPrompt !== undefined ? { cachedPrompt: cached } : {}),
  };
};

/** The text of a message, for the trace. Messages are content parts now; a
 *  trace entry is not, and must not become one — see `Trace` in
 *  `shared/types.ts` for what reads these strings and what silently breaks
 *  when they stop being strings. */
const textOf = (m: ModelMessage | undefined): string =>
  (m?.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');

const requestEvent = (kind: 'request' | 'repair', messages: readonly ModelMessage[], tools?: readonly ToolSpec[]): RunEvent =>
  ({
    kind,
    system: textOf(messages[0]),
    user: textOf(messages[1]),
    // Rendered, not the objects: the trace is something a person reads, and
    // the schema is the half of a tool-path request that is easiest to get
    // wrong and hardest to reconstruct afterwards.
    ...(tools ? { tools: JSON.stringify(tools) } : {}),
  }) as RunEvent;

export async function* runGuide(
  ctx: GuideContext,
  cfg: ProviderConfig,
  signal: AbortSignal,
  callFn: typeof callModel = callModel,
  /** Supplied by the panel so the element table lands on a cacheable prefix
   *  (`context/nonce.ts`). Absent means a fresh nonce per call, which is correct
   *  but pays full price for the table every time. */
  nonceFor?: NonceCache,
): AsyncGenerator<RunEvent, RunResult> {
  let usage: EffectUsage | undefined;
  let calls = 0;

  /** `text` is whatever will be parsed; `tool` names the function when the
   *  endpoint made a call. `content` is kept separately so the fallback below
   *  has something to read when it did not. */
  type Said = {
    text: string;
    tool?: string;
    content: string;
    id?: string;
    finishReason?: string;
    reasoning?: Extract<ModelContentPart, { type: 'reasoning' }>;
  };
  const send = async (
    messages: readonly ModelMessage[],
    tools?: readonly ToolSpec[],
  ): Promise<Said | { error: string; retryable: boolean }> => {
    calls += 1;
    let text = '';
    let mine: EffectUsage | undefined;
    /**
     * One entry per `index`, because a stream may interleave two calls.
     *
     * We ask for one (`tool_choice: 'required'` with four mutually exclusive
     * envelopes) and could ask harder (`parallel_tool_calls: false`), but
     * neither is a guarantee: most compatible endpoints do not document that
     * parameter and silently drop what they do not know. Accumulating by the
     * index the response actually carries costs one Map and removes the
     * assumption entirely — then the *first* complete call is taken, because
     * one envelope is what this contract means, and a second would be the
     * endpoint answering a question nobody asked.
     */
    const byIndex = new Map<number, { id?: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let reasoning: Extract<ModelContentPart, { type: 'reasoning' }> | undefined;
    try {
      for await (const d of callFn(cfg, messages, signal, tools ? { tools, toolChoice: 'required' } : undefined)) {
        switch (d.type) {
          case 'text-delta':
            text += d.text;
            break;
          // The protocol says where a call begins, so nothing here guesses
          // which fragment carries the name and the id. A wire that has no
          // such event makes its adapter synthesize one — the guess survives,
          // but only inside the one adapter that needs it.
          case 'tool-input-start':
            byIndex.set(d.index, { name: d.name, args: '', ...(d.id ? { id: d.id } : {}) });
            break;
          case 'tool-input-delta': {
            const at = byIndex.get(d.index);
            if (at) at.args += d.delta;
            break;
          }
          case 'finish':
            if (d.reason) finishReason = d.reason;
            if (d.usage)
              mine = {
                prompt: d.usage.prompt,
                completion: d.usage.completion,
                total: d.usage.total,
                ...(d.usage.cachedPrompt !== undefined ? { cachedPrompt: d.usage.cachedPrompt } : {}),
              };
            break;
          // Kept whole, to be handed back with this call's result: OpenAI
          // Responses requires the item it issued, and only that adapter
          // knows what is inside it.
          case 'reasoning':
            reasoning = { type: 'reasoning', text: d.text, ...(d.providerOptions ? { providerOptions: d.providerOptions } : {}) };
            break;
          // `stream-start` carries what the adapter had to drop. Nothing reads
          // it yet — it belongs on the Round (CONTEXT.md `Conversation`), and
          // putting it there is not this change.
          case 'stream-start':
            break;
        }
      }
    } catch (err) {
      // Whatever the stream managed to report before it broke was still spent.
      usage = addUsage(usage, mine);
      return { error: describeProviderError(err), retryable: isRetryable(err) };
    }
    usage = addUsage(usage, mine);
    const first = [...byIndex.entries()].sort((a, b) => a[0] - b[0])[0]?.[1];
    // `raw` is the arguments text, verbatim. It is what the provenance
    // scanner has to see, and re-serializing it would break the provenance rule (CONTEXT.md `Provenance`).
    return {
      text: first?.args ?? '',
      content: text,
      ...(first?.name ? { tool: first.name } : {}),
      ...(first?.id ? { id: first.id } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  };

  /**
   * An answer is a tool call. There is no second way to read one.
   *
   * There used to be: text that parsed as an envelope was accepted, for an
   * endpoint that ignores `tool_choice: 'required'` and answers in prose.
   * **The mechanism worked and its tests were green — what was never wired up
   * was the trigger.** It required an `intent` field in the envelope, and the
   * system prompt has never taught an envelope format or used that word, so no
   * model was ever told it could answer that way. Across 165 recorded states
   * from real runs, zero answers arrived without a tool call. It was a path
   * that lived only in a test file.
   *
   * What replaces it is better and earlier: an endpoint known not to honour
   * forced tool calls is refused before the request goes out, where the user
   * can be told something actionable — not after a call has been paid for.
   */
  const parseSaid = (said: Said): { result: ParseResult<GuideAgentEnvelope>; tool?: string; raw: string } => {
    if (said.tool) return { result: guideAgent.parseOutput(said.tool, said.text), tool: said.tool, raw: said.text };
    return {
      result: { kind: 'error', message: said.content.trim() ? '端点没有返回工具调用，只回了一段文字' : '端点既没有返回工具调用，也没有返回任何文字' },
      raw: said.content,
    };
  };

  const tools = guideAgent.outputSchema(ctx);
  const messages = guideAgent.buildMessages(ctx, nonceFor);

  // Said before sending, not discovered after. Every answer this agent can
  // give is a tool call, so an endpoint that ignores "you must call one"
  // cannot drive this product at all — and finding that out from a reply
  // means the call was already paid for and the user got a sentence about
  // parsing instead of about their endpoint. `unknown` sends: nothing has
  // asked these endpoints yet (`settings.ts`), and refusing them all would
  // break every working configuration to guard against one that is not.
  //
  // Asked about the model this call names, not about the endpoint as a whole:
  // one address serves models that answer the forced tool call and models that
  // reply with prose, and refusing the good ones on the bad ones' account
  // would be a gate nobody could get past.
  if (verdictFor(cfg) === 'unsupported') {
    return {
      raw: '',
      providerCalls: 0,
      failure: {
        kind: 'transport',
        error: '这个端点会忽略「必须调用工具」，本产品在它上面跑不动——换一个模型或端点再验收一次；如果确认是误判，在设置里按「仍然按可用处理」。',
        retryable: false,
      },
    };
  }

  yield requestEvent('request', messages, tools);

  const first = await send(messages, tools);
  if ('error' in first) {
    return { raw: '', providerCalls: calls, ...(usage ? { usage } : {}), failure: { kind: 'transport', ...first } };
  }

  let said = first;
  let read = parseSaid(said);
  let raw = read.raw;
  let toolName = read.tool;
  yield { kind: 'raw', text: raw };

  /**
   * What was wrong with this draw, or `undefined` if nothing was.
   *
   * Parsing and validation are one verdict here, not two stages with one
   * retry between them. They used to be two: a `parse_error` bought a repair
   * round, a `violation` bought nothing but a `retryable: true` nobody read.
   * Measured over one live run — 3 parse failures, 3 repairs, all recovered;
   * 2 violations, 0 repairs, **both cost the whole round**. Not because a
   * violation is harder: one was an `action` outside the enum and the other
   * two refs concatenated into one string, each a word the model could have
   * fixed. It cost the round because the reducer keeps the previous plan when
   * a draw is rejected, and that plan had already been shown not to work.
   */
  const verdictOf = (
    r: ParseResult<GuideAgentEnvelope>,
  ): { reason: string; envelope?: never } | { reason?: never; envelope: GuideAgentEnvelope } => {
    if (r.kind === 'error') return { reason: explain(r.message, said.finishReason) };
    const v = guideAgent.validate(r.envelope, ctx.table);
    return v.kind === 'violation' ? { reason: v.reason } : { envelope: v.envelope };
  };

  let verdict = verdictOf(read.result);
  if (verdict.reason !== undefined) {
    yield read.result.kind === 'error'
      ? { kind: 'parse_error', message: verdict.reason }
      : { kind: 'violation', reason: verdict.reason };

    // Exactly one repair round, never a loop: a model that cannot produce the
    // shape twice will not produce it on the third try, and the whole cost
    // ceiling rests on a bounded number of requests per effect. One round for
    // the draw, not one per failure kind — a draw that parses and then fails
    // validation has already spent it.
    //
    // Told what was wrong, when the endpoint gave us the means to say it. The
    // wire form is fixed — replay the call as an `assistant` message, answer
    // it with a `tool` message echoing the same `id` — and the id is the whole
    // requirement: without one, that pair is malformed and OpenAI refuses it.
    // Not every compatible endpoint emits an id, so this degrades to what it
    // replaced (another draw of the identical request) rather than sending
    // something that cannot be answered.
    //
    // Re-sending the page costs almost nothing now: it is the same prefix,
    // and `context/nonce.ts` keeps it byte-identical, so the endpoint's cache
    // covers everything up to the appended pair (measured: 3584 of 3712
    // prompt tokens cached on a repeat call).
    const repairMessages: readonly ModelMessage[] =
      first.tool && first.id
        ? [
            ...messages,
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: first.id, toolName: first.tool, input: first.text }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: first.id, output: verdict.reason }] },
          ]
        : messages;
    yield requestEvent('repair', repairMessages, tools);

    const second = await send(repairMessages, tools);
    if ('error' in second) {
      return { raw, providerCalls: calls, ...(usage ? { usage } : {}), failure: { kind: 'transport', ...second } };
    }
    said = second;
    read = parseSaid(second);
    yield { kind: 'raw', text: read.raw };

    verdict = verdictOf(read.result);
    if (verdict.reason !== undefined) {
      const failed = read.result.kind === 'error';
      yield failed
        ? { kind: 'parse_error', message: verdict.reason }
        : { kind: 'violation', reason: verdict.reason };
      return {
        raw,
        providerCalls: calls,
        ...(usage ? { usage } : {}),
        failure: { kind: failed ? 'parse' : 'violation', error: verdict.reason, retryable: true },
      };
    }
    raw = read.raw;
    toolName = read.tool;
  }

  const validated = { envelope: verdict.envelope };
  yield { kind: 'settled', envelope: validated.envelope };
  // The id of the draw that was accepted — after a repair, the second one's.
  const callId = said.id;
  return {
    raw,
    providerCalls: calls,
    ...(toolName ? { tool: toolName } : {}),
    ...(callId ? { callId } : {}),
    ...(said.reasoning ? { reasoning: said.reasoning } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Drives `runGuide` to completion, discarding the events. The one-line form
 *  for callers that only want the result; anything that wants to observe the
 *  run iterates the generator itself. */
export async function runGuideToEnd(
  ctx: GuideContext,
  cfg: ProviderConfig,
  signal: AbortSignal,
  callFn: typeof callModel = callModel,
  onEvent?: (e: RunEvent) => void,
  nonceFor?: NonceCache,
): Promise<RunResult> {
  const it = runGuide(ctx, cfg, signal, callFn, nonceFor);
  let n = await it.next();
  while (!n.done) {
    onEvent?.(n.value);
    n = await it.next();
  }
  return n.value;
}
