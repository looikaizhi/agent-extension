/**
 * Turning an endpoint's own words into a sentence the user can act on.
 *
 * Text in, text out, no imports: the reducer renders the failure line
 * (`thread/machine.ts`) and may not load anything that can touch the network,
 * a clock or storage (N-2). Keeping this apart from `provider.ts` is what lets
 * the settings page and a guide that is already running say the same sentence
 * about the same wall instead of each growing its own.
 */

/**
 * The one wall a user can climb over.
 *
 * Measured 2026-09-25 on an aggregator, and 2026-09-14 on DeepSeek's own
 * endpoint: a model whose thinking mode is on refuses `tool_choice: required`
 * outright, and every answer this product asks for is a tool call. Both
 * vendors say so in their own words, and both sentences contain "thinking":
 *
 *   «The tool_choice parameter does not support being set to required or
 *    object in thinking mode»            — 通义 / DashScope
 *   «Thinking mode does not support this tool_choice»  — DeepSeek
 *
 * The test is the endpoint's sentence, never the model's name: on that same
 * endpoint `qwen3-235b-a22b-thinking-2507` answers normally while
 * `qwen3.7-plus` — nothing in the name to warn you — hits the wall.
 */
export const isThinkingRefusal = (text: string): boolean => /thinking/i.test(text);

/** Said wherever that wall is hit, so the user reads the same thing whether it
 *  happened on the settings page or halfway through a guide. */
export const THINKING_WALL =
  '这个模型开着「思考模式」，而本产品每次都要求模型必须调用一个函数——它在思考模式下不接受这个要求。';

/** The way out, pointing at the button that does it. Only the settings page
 *  has that button, so a guide that hits the wall is told where it lives. */
export const THINKING_WALL_FIX = '到「模型配置」里点「关掉思考，再试一次」，或者换一个模型。';

/**
 * One extra sentence to put after an endpoint's own words, or nothing.
 *
 * Nothing is the common case and has to stay cheap to say: inventing advice
 * for an error nobody has measured is how a user ends up chasing the wrong
 * thing. Only the wall above qualifies today.
 */
export const adviceFor = (endpointWords: string): string | null =>
  isThinkingRefusal(endpointWords) ? `${THINKING_WALL}${THINKING_WALL_FIX}` : null;
