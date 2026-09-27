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
import { ProviderError } from '../transport';

/**
 * OpenAI Responses — the wire OpenAI's current models require.
 *
 * This is the protocol the whole seam was cut for, and the only real proof it
 * fits: a seam with one occupant is always the right shape. Everything this
 * adapter needed that the neutral types could not say was fixed in the types
 * (the `reasoning` event), never patched around here.
 *
 * What it differs on, against first-party documentation (2026-09-23):
 *
 *  - **Tools are flat** — `{type, name, description, parameters, strict}`, not
 *    nested under `function`. The single easiest difference to get wrong.
 *  - The conversation is `input`, a list of *items*, not `messages`. A turn
 *    that is a tool call is its own item, not a message with a field on it —
 *    so one neutral assistant message can become two items.
 *  - Pairing is `call_id`, not `tool_call_id`.
 *  - A reasoning item must come back with the tool result it preceded, and it
 *    must come back as the endpoint's own item. This adapter keeps that item
 *    verbatim in `providerOptions` and echoes it; it never rebuilds one.
 *  - The stream says outright where a call begins
 *    (`response.output_item.added`), so nothing here guesses — the guessing
 *    that Chat Completions forces stays inside that adapter.
 *
 * Not written here, and that is the point: anything about bytes. Chunk
 * boundaries, CRLF, heartbeats and the byte cap were solved once in
 * `transport.ts`, so this file has no fixture for any of them.
 */

const PATH = '/responses';
const NAMESPACE = 'openai-responses';

/* ═══════════ writing the request ═══════════ */

type InputItem = Record<string, unknown>;

const reasoningPartOf = (parts: readonly ModelContentPart[]) =>
  parts.find((p): p is Extract<ModelContentPart, { type: 'reasoning' }> => p.type === 'reasoning');

/**
 * The endpoint's own reasoning item, if this part is carrying one.
 *
 * Echoed rather than rebuilt: what OpenAI wants back is the item it issued,
 * `id` and all, and an adapter that reassembled one from the summary text
 * would be inventing a continuation token. A part with no item to echo — one
 * that came from some other protocol — is dropped and said so in `warnings`.
 */
const carriedItem = (part: Extract<ModelContentPart, { type: 'reasoning' }>): InputItem | undefined => {
  const item = part.providerOptions?.[NAMESPACE]?.item;
  return typeof item === 'object' && item !== null ? (item as InputItem) : undefined;
};

const textOf = (parts: readonly ModelContentPart[]): string =>
  parts
    .filter((p): p is Extract<ModelContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');

/** One neutral message as input items — plural, because a reasoning block and
 *  the call it preceded are two items on this wire. */
function inputItems(m: ModelMessage): InputItem[] {
  const calls = m.content.filter((p): p is Extract<ModelContentPart, { type: 'tool-call' }> => p.type === 'tool-call');
  if (calls.length) {
    const reasoning = reasoningPartOf(m.content);
    const carried = reasoning ? carriedItem(reasoning) : undefined;
    return [
      // Before the call it belongs to: the endpoint refuses a reasoning item
      // that is not followed by the item it reasoned toward.
      ...(carried ? [carried] : []),
      ...calls.map((c): InputItem => ({ type: 'function_call', call_id: c.toolCallId, name: c.toolName, arguments: c.input })),
    ];
  }
  const result = m.content.find((p): p is Extract<ModelContentPart, { type: 'tool-result' }> => p.type === 'tool-result');
  if (result) return [{ type: 'function_call_output', call_id: result.toolCallId, output: result.output }];
  // `input_text` for what goes in, `output_text` for what the model said — one
  // of the few places this wire distinguishes direction.
  const part = m.role === 'assistant' ? 'output_text' : 'input_text';
  return [{ role: m.role, content: [{ type: part, text: textOf(m.content) }] }];
}

/** A tool as this wire wants it: flat, unlike Chat Completions. */
const wireTool = (t: ToolSpec) => ({
  type: 'function' as const,
  name: t.name,
  ...(t.description === undefined ? {} : { description: t.description }),
  parameters: t.inputSchema,
  ...(t.strict === undefined ? {} : { strict: t.strict }),
});

function warningsFor(request: ModelRequest): ModelWarning[] {
  const warnings: ModelWarning[] = [];
  const orphaned = request.messages.some((m) => {
    const r = reasoningPartOf(m.content);
    return r !== undefined && carriedItem(r) === undefined;
  });
  if (orphaned) {
    warnings.push({
      type: 'unsupported-setting',
      setting: 'reasoning',
      detail: '这一段推理不是这个端点自己发的（没有它的原始 item），没法原样回传，已丢弃',
    });
  }
  for (const namespace of Object.keys(request.providerOptions ?? {})) {
    if (namespace === NAMESPACE) continue;
    warnings.push({
      type: 'unsupported-setting',
      setting: `providerOptions.${namespace}`,
      detail: `这些字段是写给 ${namespace} 的，${NAMESPACE} 不认识，已丢弃`,
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
      body: JSON.stringify({
        model: request.model,
        input: request.messages.flatMap(inputItems),
        stream: true,
        // No `stream_options`: this wire reports usage on `response.completed`
        // without being asked, so there is nothing to opt into.
        temperature: request.temperature,
        ...request.providerOptions?.['openai-responses'],
        ...(request.tools?.length
          ? {
              tools: request.tools.map(wireTool),
              tool_choice: request.toolChoice ?? 'required',
              parallel_tool_calls: false,
            }
          : {}),
      }),
    },
  };
}

/* ═══════════ reading the answer ═══════════ */

/** One SSE data line's payload. The event name is repeated in the body as
 *  `type`, so the `event:` lines above them need not be read at all. */
interface ResponsesEvent {
  type?: string;
  output_index?: number;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; id?: string; summary?: { text?: string }[] };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string; code?: string };
  };
  error?: { message?: string; code?: string };
}

function usageOf(raw: NonNullable<NonNullable<ResponsesEvent['response']>['usage']>): ModelUsage {
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  const cached = raw.input_tokens_details?.cached_tokens;
  return {
    prompt,
    completion,
    total: raw.total_tokens ?? prompt + completion,
    ...(typeof cached === 'number' ? { cachedPrompt: cached } : {}),
    estimated: false,
  };
}

/**
 * Lines in, neutral events out.
 *
 * Pure, not stateless — the same promise the other adapter makes: it remembers
 * the usage and the finish reason across events, because they arrive on
 * different ones. What it does *not* have to remember is where a tool call
 * began: this wire says so.
 */
async function* parse(lines: AsyncIterable<string>): AsyncIterable<ModelDelta> {
  let reason: string | undefined;
  let usage: ModelUsage | undefined;

  for await (const line of lines) {
    // `event:` lines carry the same name as the payload's own `type`, so they
    // are redundant here; anything else is framing this protocol does not use.
    if (!line.startsWith('data:')) continue;
    const e = JSON.parse(line.slice(5).trimStart()) as ResponsesEvent;

    switch (e.type) {
      case 'response.output_text.delta':
        if (e.delta) yield { type: 'text-delta', text: e.delta };
        break;

      // The wire's own "a tool call starts here". No fragment has to be
      // inspected for an id or a name — they are on this event.
      case 'response.output_item.added':
        if (e.item?.type === 'function_call') {
          yield {
            type: 'tool-input-start',
            ...(e.item.call_id ? { id: e.item.call_id } : {}),
            name: e.item.name ?? '',
            index: e.output_index ?? 0,
          };
        }
        break;

      // `delta` is the model's own JSON text, verbatim — which is what keeps
      // provenance (CONTEXT.md `Provenance`) answerable on this protocol.
      case 'response.function_call_arguments.delta':
        if (e.delta) yield { type: 'tool-input-delta', index: e.output_index ?? 0, delta: e.delta, raw: e.delta };
        break;

      // The completed reasoning item, kept whole so it can go back exactly as
      // it came. The summary is for a person to read and is often empty.
      case 'response.output_item.done':
        if (e.item?.type === 'reasoning') {
          yield {
            type: 'reasoning',
            text: (e.item.summary ?? []).map((s) => s.text ?? '').join(''),
            providerOptions: { [NAMESPACE]: { item: e.item } },
          };
        }
        break;

      case 'response.completed':
      case 'response.incomplete':
        if (e.response?.usage) usage = usageOf(e.response.usage);
        reason = e.response?.incomplete_details?.reason ?? e.response?.status ?? reason;
        break;

      // HTTP 200 is not proof of success here either: a model-side failure
      // arrives as an ordinary event, and read as "the model said nothing" it
      // would burn a repair call on an answer that was never coming.
      case 'response.failed':
      case 'error': {
        const detail = e.response?.error?.message ?? e.error?.message ?? JSON.stringify(e.response?.error ?? e.error ?? {});
        throw new ProviderError(`模型端点返回错误：${detail}`, 'contract', false);
      }

      default:
        break;
    }
  }

  yield { type: 'finish', ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) };
}

export const openaiResponses: Protocol = {
  id: 'openai-responses',
  label: 'OpenAI Responses',
  capabilities: {
    // Every function call on this wire carries a `call_id`.
    toolCallId: true,
    // `usage.input_tokens_details.cached_tokens` is part of the format.
    promptCaching: true,
  },
  prepare,
  parse,
};
