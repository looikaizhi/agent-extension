/**
 * The guide agent's debug switch, and the one way to read it.
 *
 * It lives in `storage.local`: `storage.session` belongs to the service
 * worker (N-6), and the side panel is the side that has to read it. A stored
 * value rather than a build flag, because a trace that shows what a failing
 * run actually sent has to work against a production build — which a
 * compile-time flag cannot reach.
 *
 * N-1: no `chrome.*` here. The store arrives as a port, so this runs in a
 * plain node test.
 */

/** The one operation reading a switch needs. `ThreadStore` (`host/ports.ts`)
 *  is a superset and satisfies it structurally. */
export interface FlagStore {
  get(key: string): Promise<Record<string, unknown>>;
}

/** Records what a run sent and got back (`guide/trace.ts`). */
export const TRACE_ENABLED_KEY = 'trace:enabled';

/**
 * Never throws, and nothing but a literal `true` counts. A storage read that
 * fails is not a reason to start recording page content, nor to fail the call
 * behind it — so every uncertain answer is "off".
 */
export async function isFlagOn(store: FlagStore, key: string): Promise<boolean> {
  try {
    return (await store.get(key))[key] === true;
  } catch {
    return false;
  }
}
