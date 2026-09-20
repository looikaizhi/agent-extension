import { runGuideToEnd, type RunResult } from '@/agent/agents/guide/runner';
import { complete } from '@/agent/provider/provider';
import type { EffectUsage } from '@/agent/thread/effect';
import type { ProviderConfig } from '@/shared/settings';
import { contextFor, type State } from './corpus';

/**
 * One state answered again through today's code: the guide's run loop and a
 * real Provider, the Context rebuilt under this run's Plugins (`corpus.ts`).
 *
 * The endpoint saying "not now" — a 429, a 5xx, the network — is not the model
 * answering. Those are asked again after a growing wait; one that still fails
 * is kept as a network error, which scoring counts apart (`score.ts`).
 */

export interface Replay {
  state: string;
  pass: number;
  /** The run loop's result, as far as scoring reads it (`score.ts` `Answer`). */
  raw: string;
  tool?: string;
  failure?: RunResult['failure'];
  usage?: EffectUsage;
  providerCalls: number;
  /** Wall time of the attempt that counted, repair round included. */
  ms: number;
  /** 1 unless the endpoint had to be asked again. */
  attempts: number;
}

/** Asked again at most this many times, after 1, 2, 4, 8 seconds. */
export const RETRIES = 4;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function replay(
  state: State,
  pass: number,
  plugins: readonly string[],
  cfg: ProviderConfig,
  {
    completeFn = complete,
    wait = sleep,
    retries = RETRIES,
  }: { completeFn?: typeof complete; wait?: (ms: number) => Promise<void>; retries?: number } = {},
): Promise<Replay> {
  const ctx = contextFor(state, plugins);
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const r = await runGuideToEnd(ctx, cfg, new AbortController().signal, completeFn);
    const ms = Date.now() - started;
    if (r.failure?.kind === 'transport' && r.failure.retryable && attempt <= retries) {
      await wait(1000 * 2 ** (attempt - 1));
      continue;
    }
    return {
      state: state.id,
      pass,
      raw: r.raw,
      ...(r.tool ? { tool: r.tool } : {}),
      ...(r.failure ? { failure: r.failure } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
      providerCalls: r.providerCalls,
      ms,
      attempts: attempt,
    };
  }
}
