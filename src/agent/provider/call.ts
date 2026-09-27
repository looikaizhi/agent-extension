import { requestFieldsFor, type ProviderConfig } from '@/shared/settings';
import { PROTOCOLS } from './protocols';
import { ProviderError, streamLines } from './transport';
import type { ModelDelta, ModelMessage, ModelRequest, ModelUsage, ToolChoice, ToolSpec } from './types';

/**
 * One model call, in neutral terms: pick the protocol this endpoint speaks,
 * let it write the request, send it, let it read the lines back.
 *
 * This is the layer between `transport` and an adapter, and it exists because
 * two things belong to neither of them. One is the stream's opening event: the
 * warnings come from `prepare`, the events from `parse`, and only something
 * holding both can put them in one stream. The other is the usage estimate
 * below.
 *
 * The run loop goes through here, and through nothing else. It used to go
 * through a function that knew one wire format by heart; that the switch
 * changed no byte was proven once, while both paths were alive, and the proof
 * was retired with the path it was about.
 */

/** Said the same way wherever the product meets a missing model: `callModel`
 *  throws it, and the host says it before a run starts rather than reading a
 *  page it would have nothing to plan with. */
export const MODEL_NOT_CONFIGURED =
  '还没有配置模型：请先在下方「模型配置（BYOK）」里填好端点和 API Key，点「连接」拿到模型列表，选一个之后点「验收并保存」。';

/**
 * `http://localhost*` / `http://127.0.0.1*` are the only endpoints that don't
 * need a key. Exact hostname match, not a substring check on the whole URL:
 * matching on substring treats `https://my-localhost-proxy.example.com/v1` as
 * local and waives the key requirement for a real public endpoint that merely
 * has "localhost" somewhere in its name. Shared between the connection steps'
 * save-time check (`provider.ts`) and the every-call guard below — one rule,
 * one implementation, so the two can never drift apart again.
 */
export function isLocalEndpoint(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Whether a model call is even possible — the same condition `callModel`
 * refuses on below, exported so a *router* can ask it before committing a request
 * to a path that can only end in that refusal.
 *
 * Every goal without handed-over steps is the model's to plan, so with none
 * configured the guide says so up front (`MODEL_NOT_CONFIGURED`) instead of
 * extracting a page it has nothing to plan with. Handed-over steps — a fixed
 * plan — never need one.
 */
export const modelIsConfigured = (cfg: ProviderConfig): boolean =>
  Boolean(cfg.apiKey) || isLocalEndpoint(cfg.baseURL);

// Rough industry-standard heuristic (~4 chars/token for English; imprecise for
// CJK, but this only ever feeds a cost *estimate* the UI labels as such —
// never billing). `Math.ceil` so a lone leftover character still counts.
const CHARS_PER_TOKEN = 4;
const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Everything in the request the model had to read.
 *
 * Counted on the neutral shape rather than on any wire's bytes, so the figure
 * does not change when the protocol does. It counts what a tool round costs on
 * both sides — the call the model made and the result sent back — which the
 * old path only did for the request half: an answer that is entirely a tool
 * call was charged as zero completion, which is the case this product is in
 * almost every time.
 */
const promptChars = (request: ModelRequest): number =>
  request.messages.reduce(
    (sum, m) =>
      sum +
      m.content.reduce((n, part) => {
        switch (part.type) {
          case 'text':
          case 'reasoning':
            return n + part.text.length;
          case 'tool-call':
            return n + part.toolName.length + part.input.length;
          case 'tool-result':
            return n + part.output.length;
        }
      }, 0),
    0,
  );

export interface ModelCallOptions {
  tools?: readonly ToolSpec[];
  /** `'required'` = must call one of them, model picks which. */
  toolChoice?: ToolChoice;
}

/**
 * What the agent said plus what this endpoint needs added to it — the two
 * halves of a request, joined here because the agent has no business knowing
 * either of the additions.
 *
 * `temperature` is stated, not inherited: the guide's one repair round is a
 * re-draw of the identical request (`guide/runner.ts`), which only recovers
 * anything if the endpoint is free to answer differently — against a provider
 * whose default is 0 it would reproduce the same bad answer and spend a second
 * call to do it. 1 is also what every measurement in `tests/spike` was taken
 * at, so the corpus and the product agree.
 *
 * The endpoint's own extra fields go under the id of the protocol it speaks,
 * because that adapter is the only one that knows where to put them
 * (`settings.ts`). They are read from the *configuration*, for the model this
 * call names — never from the preset table, which a custom endpoint can never
 * match and which would therefore leave an aggregator with no way to send the
 * one field a model needs. A preset fills those values in; it is not asked
 * again at send time.
 *
 * Exported because the model-input snapshot freezes exactly this — the whole
 * request, not the half the agent wrote.
 */
export function modelRequestFor(
  cfg: ProviderConfig,
  messages: readonly ModelMessage[],
  options?: ModelCallOptions,
): ModelRequest {
  const fields = requestFieldsFor(cfg);
  return {
    model: cfg.model,
    messages,
    ...(options?.tools?.length ? { tools: options.tools } : {}),
    ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
    temperature: 1,
    ...(Object.keys(fields).length ? { providerOptions: { [cfg.protocol]: fields } } : {}),
  };
}

export async function* callModel(
  cfg: ProviderConfig,
  messages: readonly ModelMessage[],
  signal: AbortSignal,
  options?: ModelCallOptions,
): AsyncIterable<ModelDelta> {
  if (signal.aborted) return;

  // The same gate `complete()` keeps, for the same reason: `request` carries
  // the page's element table, which is exactly the kind of thing BYOK promises
  // never leaves the machine toward a destination the user never chose. It has
  // to be caught before the request reaches `transport`, not discovered as a
  // 401 after it (and the page content) already went out.
  if (!modelIsConfigured(cfg)) throw new ProviderError(MODEL_NOT_CONFIGURED, 'auth', false);

  const request = modelRequestFor(cfg, messages, options);
  const protocol = PROTOCOLS[cfg.protocol];
  const { http, warnings } = protocol.prepare(request);
  yield { type: 'stream-start', warnings };

  let completionChars = 0;
  try {
    for await (const delta of protocol.parse(streamLines(cfg, http, signal))) {
      // An aborted call says nothing more — not even the finish event, whose
      // usage would be a number for half an answer nobody asked for.
      if (signal.aborted) return;
      if (delta.type === 'text-delta') completionChars += delta.text.length;
      if (delta.type === 'tool-input-delta') completionChars += delta.delta.length;
      if (delta.type === 'finish' && !delta.usage) {
        // "Usage rides the final event" is a hard promise, and most
        // OpenAI-compatible presets never report real usage unless the request
        // asked for it — and some not even then. The estimate is made here,
        // above the adapter, because `parse` sees lines and cannot see the
        // request, so it cannot count the prompt side at all.
        yield { ...delta, usage: estimated(request, completionChars) };
        return;
      }
      yield delta;
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal.aborted) return;
    throw new ProviderError(`网络错误：${String((err as Error)?.message ?? err)}`, 'network', true);
  }
}

/**
 * `estimated: true` is the whole point of the field, and today nothing
 * downstream can see it: the thread's own usage type has no such field, the
 * run loop drops it, and the panel writes `false` — so the cost line's 「含估
 * 算值」 never lights up for a model call. That chain is a known defect and
 * not this ticket's to fix; what matters here is not making it deeper.
 */
function estimated(request: ModelRequest, completionChars: number): ModelUsage {
  const prompt = estimateTokens(promptChars(request));
  const completion = estimateTokens(completionChars);
  return { prompt, completion, total: prompt + completion, estimated: true };
}
