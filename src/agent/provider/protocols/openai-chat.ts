import type {
  ModelContentPart,
  ModelDelta,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ModelWarning,
  PreparedRequest,
  Protocol,
  ToolSpec,
} from '../types';
// The provider layer's failure taxonomy, not a socket: a data line that says
// the model failed is a `contract` error whichever protocol wrote it.
import { ProviderError } from '../transport';

/**
 * OpenAI Chat Completions — the format eight of this product's presets speak
 * (DeepSeek, Kimi, GLM, Qwen, OpenRouter, SiliconFlow, Ollama, LM Studio),
 * which is why the adapter is written for the protocol and not for any one of
 * them.
 *
 * A pure function in, a pure function out: no `fetch`, no clock, no
 * environment, and above all **no key**. `prepare` returns headers without
 * authorization and says `auth: 'bearer'` instead; `transport.ts` attaches it.
 * That is not tidiness — "the API key has exactly one destination" is the
 * reason this product does not use a provider SDK, and an adapter that built
 * its own `Authorization` header would give that up from the inside. The
 * architecture guard holds the whole directory to it.
 */

const PATH = '/chat/completions';

/**
 * A message as this wire wants it.
 *
 * The key order is deliberate and load-bearing: it is what the bytes look
 * like, and a request equal to the byte was the only evidence that moving this
 * code changed nothing — evidence produced once, while both paths were alive,
 * and retired with the path it was about. A tool result
 * spells `tool_call_id` before `content`; an assistant turn that is only a
 * tool call carries an explicit `content: null`, which every OpenAI-compatible
 * endpoint expects and some require.
 */
type WireMessage =
  | { role: string; content: string }
  | { role: 'assistant'; content: null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const textOf = (parts: readonly ModelContentPart[]): string =>
  parts
    .filter((p): p is Extract<ModelContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');

function wireMessage(m: ModelMessage): WireMessage {
  const calls = m.content.filter((p): p is Extract<ModelContentPart, { type: 'tool-call' }> => p.type === 'tool-call');
  if (calls.length) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({ id: c.toolCallId, type: 'function' as const, function: { name: c.toolName, arguments: c.input } })),
    };
  }
  const result = m.content.find((p): p is Extract<ModelContentPart, { type: 'tool-result' }> => p.type === 'tool-result');
  if (result) return { role: 'tool', tool_call_id: result.toolCallId, content: result.output };
  return { role: m.role, content: textOf(m.content) };
}

/** A tool as this wire wants it: nested under `function`, unlike Responses. */
const wireTool = (t: ToolSpec) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    ...(t.description === undefined ? {} : { description: t.description }),
    ...(t.strict === undefined ? {} : { strict: t.strict }),
    parameters: t.inputSchema,
  },
});

/**
 * What this protocol had to drop.
 *
 * Two things can be dropped here and neither may be silent: a reasoning block
 * (Chat Completions has no way to send the model's own reasoning back, while
 * Responses requires exactly that), and options addressed to some other
 * protocol.
 */
function warningsFor(request: ModelRequest): ModelWarning[] {
  const warnings: ModelWarning[] = [];
  if (request.messages.some((m) => m.content.some((p) => p.type === 'reasoning'))) {
    warnings.push({
      type: 'unsupported-setting',
      setting: 'reasoning',
      detail: 'Chat Completions 没有回传模型自己那段推理的位置，这一段没有发出去',
    });
  }
  for (const namespace of Object.keys(request.providerOptions ?? {})) {
    if (namespace === 'openai-chat') continue;
    warnings.push({
      type: 'unsupported-setting',
      setting: `providerOptions.${namespace}`,
      detail: `这些字段是写给 ${namespace} 的，openai-chat 不认识，已丢弃`,
    });
  }
  return warnings;
}

function prepare(request: ModelRequest): PreparedRequest {
  return {
    warnings: warningsFor(request),
    http: {
      path: PATH,
      method: 'POST',
      auth: 'bearer',
      headers: { 'Content-Type': 'application/json' },
      // Serialized here, by the adapter, rather than handed over as an object
      // for someone else to stringify: the request-body whitelist in
      // `architecture.spec.ts` reads this literal out of the syntax tree, so
      // a body assembled anywhere else is a body nobody reviewed.
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(wireMessage),
        stream: true,
        stream_options: { include_usage: true },
        // Stated, not inherited. The guide's one repair round is a re-draw of
        // the identical request (`guide/runner.ts`), which only recovers
        // anything if the endpoint is free to answer differently — against a
        // provider whose default is 0 it would reproduce the same bad answer
        // and spend a second call to do it.
        temperature: request.temperature,
        ...request.providerOptions?.['openai-chat'],
        ...(request.tools?.length
          ? {
              tools: request.tools.map(wireTool),
              tool_choice: request.toolChoice ?? 'required',
              // A hint, not a mechanism. Anthropic's compatibility layer
              // documents it as fully supported; most others do not mention
              // it, and an unlisted parameter is silently dropped rather than
              // refused — DeepSeek returns 200 for a field invented on the
              // spot, so a 200 proves nothing about it being honoured. What
              // actually guarantees one envelope is the runner demultiplexing
              // by `index` and taking the first call.
              parallel_tool_calls: false,
            }
          : {}),
      }),
    },
  };
}

/* ═══════════ reading the answer ═══════════ */

/** One SSE data line's payload, as this wire writes it. */
interface ChatChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string;
      tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    // Two spellings for one number: OpenAI nests it, DeepSeek also reports a
    // flat pair. Whichever arrives is the same fact.
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
  // Gotcha: HTTP 200 is not proof of success — some endpoints report a
  // model-side failure as a normal SSE data line instead of a non-2xx status.
  // Left unhandled, this reads as "the model said nothing" and burns a repair
  // call on an answer that was never coming.
  error?: { message?: string; type?: string; code?: string | number };
}

function usageOf(raw: NonNullable<ChatChunk['usage']>): ModelUsage {
  const prompt = raw.prompt_tokens ?? 0;
  const completion = raw.completion_tokens ?? 0;
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens;
  return {
    prompt,
    completion,
    // Gotcha: `total_tokens` is sometimes missing even when the other two are
    // present. Writing 0 there would read as "0 tokens total" in the UI —
    // indistinguishable from a real zero-cost call — so fall back to the sum.
    total: raw.total_tokens ?? prompt + completion,
    ...(typeof cached === 'number' ? { cachedPrompt: cached } : {}),
    estimated: false,
  };
}

/**
 * Lines in, neutral events out.
 *
 * **The guessing did not go away; it moved in here.** Chat Completions has no
 * "a tool call starts now" event on the wire — the id and the name simply ride
 * the first fragment (measured against DeepSeek: 23 fragments, all three on
 * fragment 1) — so this adapter synthesizes `tool-input-start` from whichever
 * fragment for an index it sees first. What the discriminated union bought is
 * that Anthropic and Responses, which *do* say outright where a call begins
 * (`content_block_start`, `response.output_item.added`), no longer have to
 * flatten that knowledge away and let the reader guess it back.
 *
 * **And this function is pure, not stateless.** It has to remember which
 * indexes have already started, whether `[DONE]` has gone by, the finish
 * reason (which arrives on a different chunk from the usage), and the usage
 * itself. The promise the neutral side makes is no I/O, no clock, same input
 * → same output, replayable — not an absence of local variables.
 */
async function* parse(lines: AsyncIterable<string>): AsyncIterable<ModelDelta> {
  // Once the endpoint has said [DONE], anything still arriving (some proxies
  // keep the socket open and echo stray bytes) is not part of the answer —
  // stop reading it, not just stop caring. `[DONE]` is OpenAI's own marker;
  // Anthropic has none, which is why it is read here and not in `transport`.
  let done = false;
  const started = new Set<number>();
  let reason: string | undefined;
  let usage: ModelUsage | undefined;

  for await (const line of lines) {
    if (done || !line.startsWith('data:')) continue;
    const payload = line.slice(5).trimStart();
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    const chunk = JSON.parse(payload) as ChatChunk;
    if (chunk.error) {
      const detail = chunk.error.message ?? chunk.error.type ?? JSON.stringify(chunk.error);
      throw new ProviderError(`模型端点返回错误：${detail}`, 'contract', false);
    }
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (text) yield { type: 'text-delta', text };

    // Every fragment in the chunk, demultiplexed by its own `index` rather
    // than flattened to `[0]`: `parallel_tool_calls: false` is a request the
    // endpoint may ignore, and a fragment whose index was dropped is a
    // fragment reported wrongly.
    for (const call of choice?.delta?.tool_calls ?? []) {
      // `index` is optional on the wire; absent means the endpoint sends one
      // call at a time, which is index 0.
      const index = call.index ?? 0;
      if (!started.has(index)) {
        started.add(index);
        yield { type: 'tool-input-start', ...(call.id ? { id: call.id } : {}), name: call.function?.name ?? '', index };
      }
      const fragment = call.function?.arguments;
      // `raw` beside `delta` although they are the same string here: this wire
      // streams the model's own JSON text verbatim, so provenance (CONTEXT.md
      // `Provenance`) gets exactly what was said. A protocol that ever had to
      // touch `delta` would still owe the untouched bytes.
      if (fragment) yield { type: 'tool-input-delta', index, delta: fragment, raw: fragment };
    }

    if (choice?.finish_reason) reason = choice.finish_reason;
    if (chunk.usage) usage = usageOf(chunk.usage);
  }

  // Exactly one, always last: "usage rides the final event" is a hard promise
  // (CONTEXT.md — 用量落在最后一个 delta 上), and the reason and the usage
  // arrive on two different chunks, so neither can be the terminal event on
  // its own. A stream that reported no usage leaves the field empty; filling
  // it in is the caller's job, because only the caller can see the request.
  yield { type: 'finish', ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) };
}

export const openaiChat: Protocol = {
  id: 'openai-chat',
  label: 'OpenAI Chat Completions',
  capabilities: {
    // Every endpoint on this wire returns an id with a tool call, and the
    // repair round pairs on it (`tool_call_id`).
    toolCallId: true,
    // The format defines `usage.prompt_tokens_details.cached_tokens`;
    // whether a given endpoint fills it in is that endpoint's business, not
    // the protocol's.
    promptCaching: true,
  },
  prepare,
  parse,
};
