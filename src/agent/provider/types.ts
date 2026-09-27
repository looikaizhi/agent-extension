import type { ProtocolId } from '@/shared/settings';
import type { HttpRequest } from './transport';

/**
 * The common language between the run loop and a protocol adapter: what a
 * call is, what comes back from one, and what an adapter can say about
 * itself. Written here rather than taken from a package — no new runtime
 * dependency — but shaped by the potholes the Vercel AI SDK already drove
 * into: content parts as an array, per-protocol options under a namespace,
 * and warnings as data rather than a console line.
 *
 * Nothing in this file knows a wire format. Turning one of these into bytes
 * is `protocols/`'s job, and putting those bytes on a socket is
 * `transport.ts`'s.
 */

/* ═══════════ what goes to the model ═══════════ */

/**
 * One piece of one message.
 *
 * An array of parts, never `content: string | null`. The flat spelling cannot
 * say "an assistant turn that is a tool call and nothing else" without a null,
 * cannot carry a reasoning block beside text, and forces every protocol that
 * has real parts to flatten and then guess its way back.
 *
 * `reasoning` is here although `openai-chat` never produces or sends one:
 * OpenAI Responses requires the model's own reasoning item to be handed back
 * with the tool result it precedes, so a shape with nowhere to put it would
 * have to be reopened the moment a second protocol arrived. An adapter that
 * cannot send one drops it and says so in `warnings`.
 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  // No tool name on the result: none of the three wire formats carries one
  // there (`tool_call_id` / `call_id` / `tool_use_id` and the output, that is
  // all), so a field every adapter would have to invent a value for is a field
  // that only ever gets one wrong.
  | { type: 'tool-result'; toolCallId: string; output: string };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: readonly ModelContentPart[];
}

/**
 * One callable function. Flat on purpose: Chat Completions nests it under
 * `function`, Responses does not, and Anthropic spells the schema
 * `input_schema` — so the neutral shape picks none of the three and each
 * adapter writes its own.
 *
 * `strict` asks the endpoint to *enforce* the schema rather than treat it as
 * advice. Measured on deepseek-chat: with it, a `required` field the model was
 * dropping in 2 of 16 draws stopped being dropped. Not total enforcement — one
 * draw in 24 still omitted a required array — so a caller keeps validating.
 */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema. Neutral because every protocol here takes JSON Schema. */
  inputSchema: unknown;
  strict?: boolean;
}

/** `'required'` = must call one of them, model picks which. */
export type ToolChoice = 'auto' | 'required' | 'none';

/**
 * Fields that only one protocol knows where to put, under that protocol's id.
 *
 * Namespaced rather than mixed into `ModelRequest`, so a field one endpoint
 * needs (DeepSeek's `thinking`, `settings.ts`) cannot leak into a request to
 * some other endpoint that would quietly ignore it. An adapter reads its own
 * namespace and warns about the rest.
 */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface ModelRequest {
  model: string;
  messages: readonly ModelMessage[];
  tools?: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  providerOptions?: ProviderOptions;
}

/* ═══════════ what an adapter could not do ═══════════ */

/**
 * Something the adapter dropped or could not honour, carried as data to the
 * run loop (it lands on the Round — CONTEXT.md `Conversation`).
 *
 * The point is that there is no third option: a field this protocol does not
 * take is either refused or named here. Silently dropping it is what makes a
 * compatibility layer feel like a broken product three layers up.
 */
export type ModelWarning =
  | { type: 'unsupported-setting'; setting: string; detail?: string }
  | { type: 'other'; message: string };

/**
 * What a `Protocol` can say about itself before a request goes out, and the
 * whole list of it (CONTEXT.md `Capability`).
 *
 * A capability is on this list only because a branch reads it, and only when
 * it holds for the whole protocol. Anything that varies by endpoint — whether
 * `tool_choice: required` is honoured, most of all — is a property of the
 * `Provider` and does not belong here: DeepSeek, Qwen, GLM and Gemini all
 * speak `openai-chat` and differ.
 */
export interface Capability {
  /** Does a tool call come with an id? Without one the repair round has to
   *  re-send the request unchanged instead of pairing (`guide/runner.ts`). */
  toolCallId: boolean;
  /** Does this wire format report prompt-cache figures? Read by the settings
   *  page's native-vs-compatibility line. */
  promptCaching: boolean;
}

/* ═══════════ what comes back ═══════════ */

/** Real once the endpoint reports it; character-count based otherwise (`estimated: true`). */
export interface ModelUsage {
  prompt: number;
  completion: number;
  total: number;
  /** How much of `prompt` the endpoint served from its prefix cache. Absent
   *  where the endpoint does not report it — nothing measured is not the same
   *  as nothing cached. */
  cachedPrompt?: number;
  estimated: boolean;
}

/**
 * One event from a model's answer, as a discriminated union.
 *
 * The union is the point. A flat `{ content, tool? }` forces the reader to
 * guess which fragment carries a tool call's name and id — true for Chat
 * Completions, which has no start event, and false for Responses
 * (`response.output_item.added`) and Anthropic (`content_block_start`), both
 * of which say outright where a call begins. A shape that cannot express
 * "this is the start" makes two protocols that know it pretend they do not.
 *
 * `raw` is the model's own bytes for that fragment, kept apart from `delta`
 * so provenance (CONTEXT.md `Provenance`) has something no adapter has
 * touched: the scanner is an independent second implementation and must read
 * what was actually said, not a cleaned-up copy.
 */
export type ModelDelta =
  | { type: 'stream-start'; warnings: readonly ModelWarning[] }
  | { type: 'text-delta'; text: string }
  /**
   * A reasoning block the model produced, to be handed back with the tool
   * result it precedes.
   *
   * Added when the second protocol arrived and the first thing it needed was
   * something the union could not say — which is what a second protocol is
   * for. Responses *requires* the item back on the next request, and what has
   * to go back is the endpoint's own item, not a rendering of it, so the item
   * rides in `providerOptions` under the protocol that issued it and the
   * adapter echoes it verbatim. `text` is the human-readable summary, which
   * may be empty and is never what gets sent back.
   */
  | { type: 'reasoning'; text: string; providerOptions?: ProviderOptions }
  | { type: 'tool-input-start'; id?: string; name: string; index: number }
  | { type: 'tool-input-delta'; index: number; delta: string; raw: string }
  | {
      type: 'finish';
      /**
       * Why the endpoint stopped. Reported, never trusted: every endpoint
       * returns it but the vocabulary is theirs — some answer `stop` for a
       * tool call OpenAI would call `tool_calls`. Worth acting on only for
       * `length`, which says the output was cut off rather than finished.
       */
      reason?: string;
      /** On the last delta of every stream, without exception. */
      usage?: ModelUsage;
    };

/* ═══════════ the adapter contract ═══════════ */

/**
 * What `prepare` hands back: the request, and everything this protocol could
 * not carry. The warnings travel with the call rather than being thrown away
 * here — `parse` puts them on the stream's first event.
 */
export interface PreparedRequest {
  http: HttpRequest;
  warnings: readonly ModelWarning[];
}

/**
 * One wire format (CONTEXT.md `Protocol`).
 *
 * Two pure functions and a declaration, and nothing else: no `fetch`, no
 * clock, no key. `prepare` writes the request; `parse` reads the lines
 * `transport` hands back — lines, not bytes, because a chunk boundary is
 * SSE's problem and was solved once.
 *
 * Pure is not the same as stateless: `parse` has to remember things across
 * lines, and says so where it is implemented.
 */
export interface Protocol {
  id: ProtocolId;
  /** Shown in the settings page's protocol picker. */
  label: string;
  capabilities: Capability;
  prepare(request: ModelRequest): PreparedRequest;
  /** `stream-start` is not produced here — the warnings it carries come from
   *  `prepare`, which this half never sees. Whoever calls both emits it. */
  parse(lines: AsyncIterable<string>): AsyncIterable<ModelDelta>;
}
