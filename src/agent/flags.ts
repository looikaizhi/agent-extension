/**
 * The agent's switches — the trace switch and each Plugin's
 * (`agent/context/plugins.ts`) — and the one way to read them.
 *
 * They live in `storage.local`: `storage.session` belongs to the service
 * worker (N-6), and the side panel is the side that has to read the trace
 * switch. A stored value rather than a build flag, because a trace that shows what a failing
 * run actually sent has to work against a production build — which a
 * compile-time flag cannot reach.
 *
 * N-1: no `chrome.*` here. The store arrives as a port, so this runs in a
 * plain node test.
 */

/** The one operation reading a switch needs. `ThreadStore` (`thread/ports.ts`)
 *  is a superset and satisfies it structurally. */
export interface FlagStore {
  get(key: string): Promise<Record<string, unknown>>;
}

/** Records what a run sent and got back (`guide/trace.ts`). */
export const TRACE_ENABLED_KEY = 'trace:enabled';

/**
 * Never throws. A stored boolean is the answer; anything else — nothing
 * stored, a value of another type, a read that fails — is `fallback`. For the
 * trace switch that is "off": a storage read that fails is not a reason to
 * start recording page content, nor to fail the call behind it. A Plugin
 * passes its own default instead.
 */
export async function isFlagOn(store: FlagStore, key: string, fallback = false): Promise<boolean> {
  try {
    const stored = (await store.get(key))[key];
    return typeof stored === 'boolean' ? stored : fallback;
  } catch {
    return fallback;
  }
}
