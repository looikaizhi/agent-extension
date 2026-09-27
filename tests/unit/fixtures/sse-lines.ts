/**
 * The same conversations as the content half of `sse-streams.ts`, in the unit
 * a protocol adapter actually reads: lines.
 *
 * Nothing here has a chunk boundary in it, and that is the point. Where a line
 * was cut, whether it ended `\r\n`, and whether a heartbeat came between two
 * of them are `transport`'s problems, settled once for every protocol
 * (`transport.spec.ts`). What is left for an adapter is what a line *says* —
 * and these are the sayings that have actually come back from a real endpoint
 * and cost something to discover.
 *
 * `data: [DONE]` is kept as a line rather than assumed: it is OpenAI's own
 * convention, not SSE's, so it is a thing this protocol reads.
 */

/** Two data lines of ordinary text. */
export const twoTextLines = (): string[] => [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
  'data: {"choices":[{"delta":{"content":" world"}}]}',
];

/** A data line survives after `[DONE]` — some proxies keep the socket open and echo it. */
export const dataAfterDone = (): string[] => [
  'data: {"choices":[{"delta":{"content":"before"}}]}',
  'data: [DONE]',
  'data: {"choices":[{"delta":{"content":"after, must be dropped"}}]}',
];

/** `stream_options.include_usage` shape: a trailing line, empty `choices`, real `usage`. */
export const usageAtEnd = (): string[] => [
  'data: {"choices":[{"delta":{"content":"Answer"}}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  'data: [DONE]',
];

/** Some endpoints omit `total_tokens` even while reporting the other two fields. */
export const usageMissingTotal = (): string[] => [
  'data: {"choices":[{"delta":{"content":"Answer"}}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
  'data: [DONE]',
];

/** DeepSeek reports its cache hit as a flat field beside the nested one OpenAI uses. */
export const usageWithCacheHit = (): string[] => [
  'data: {"choices":[{"delta":{"content":"Answer"}}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":3712,"completion_tokens":5,"total_tokens":3717,"prompt_cache_hit_tokens":3584}}',
  'data: [DONE]',
];

/** No `usage` field anywhere in the stream — the default preset's actual behaviour. */
export const noUsageEver = (): string[] => [
  'data: {"choices":[{"delta":{"content":"1234"}}]}',
  'data: {"choices":[{"delta":{"content":"5678"}}]}',
  'data: [DONE]',
];

/** HTTP 200, `text/event-stream`, but the payload is an error — some endpoints never leave the stream. */
export const errorObjectInStream = (): string[] => [
  'data: {"error":{"message":"invalid_api_key","type":"invalid_request_error"}}',
];

/**
 * One tool call, as this wire streams it: the id and the name ride the first
 * fragment and are absent from every later one (measured against DeepSeek: 23
 * fragments, all three on fragment 1). This is the shape that forces the
 * adapter to synthesize a start event.
 */
export const oneToolCall = (): string[] => [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"point","arguments":"{\\"ref\\""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"e5\\"}"}}]}}]}',
  'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
  'data: [DONE]',
];

/**
 * Two calls interleaved on one stream. `parallel_tool_calls: false` is a hint
 * the endpoint may ignore, so the index on each fragment — not its position —
 * is what says which call it belongs to.
 */
export const twoToolCallsInterleaved = (): string[] => [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"point","arguments":"{\\"a\\":1"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"done","arguments":"{\\"b\\":2"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}},{"index":1,"function":{"arguments":"}"}}]}}]}',
  'data: [DONE]',
];

/** Text and a tool fragment in one chunk — one flat delta before, two events now. */
export const textAndToolInOneChunk = (): string[] => [
  'data: {"choices":[{"delta":{"content":"让我看看","tool_calls":[{"index":0,"id":"call_1","function":{"name":"observe","arguments":"{}"}}]}}]}',
  'data: [DONE]',
];

/* ═══════════ OpenAI Responses ═══════════ */

/**
 * The same conversations again, on the other wire — and **only** these.
 *
 * There is no byte-boundary column here, and that absence is the return on
 * cutting `transport` out first: CRLF, a line split across chunks, a
 * character split mid-encoding, a missing final newline and a heartbeat were
 * each solved once, for every protocol, and a second protocol inherits all of
 * it without a single new fixture.
 *
 * Written as `data:` lines only. A real stream also carries an `event:` line
 * before each one, naming the same thing the payload's own `type` field
 * already says — so nothing reads them, and repeating them here would be
 * fixture that tests nothing.
 */

/** Ordinary text, in two deltas. */
export const responsesTwoTextDeltas = (): string[] => [
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":" world"}',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
];

/**
 * One tool call. The wire says outright where it begins — id and name arrive
 * on `output_item.added`, not smuggled onto the first fragment — so this
 * adapter never has to guess the way `openai-chat` does.
 */
export const responsesOneToolCall = (): string[] => [
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"point","arguments":""}}',
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"ref\\""}',
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":":\\"e5\\"}"}',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"point","arguments":"{\\"ref\\":\\"e5\\"}"}}',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3712,"output_tokens":9,"total_tokens":3721,"input_tokens_details":{"cached_tokens":3584}}}}',
];

/**
 * A reasoning item before the call it reasoned toward — the shape the next
 * request has to hand back, or the endpoint refuses it.
 */
export const responsesReasoningThenToolCall = (): string[] => [
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_abc","summary":[{"type":"summary_text","text":"先看清这一页"}]}}',
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"observe","arguments":""}}',
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"why\\":\\"正文像是还没加载出来\\"}"}',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
];

/** Two calls, each with its own output index. */
export const responsesTwoToolCalls = (): string[] => [
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"point","arguments":""}}',
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"done","arguments":""}}',
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"a\\":1}"}',
  'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"b\\":2}"}',
  'data: {"type":"response.completed","response":{"status":"completed"}}',
];

/** HTTP 200, and the failure arrives as an ordinary event. */
export const responsesFailedEvent = (): string[] => [
  'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"something went wrong"}}}',
];

/** The model ran out of room rather than finishing. */
export const responsesIncomplete = (): string[] => [
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"half an ans"}',
  'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":8,"total_tokens":12}}}',
];
