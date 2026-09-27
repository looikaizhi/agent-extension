import type { FlagStore } from '@/agent/flags';

/** Switches as a harness writes them into `storage.local` before a run. Read
 *  live, so a test can change one between two calls. */
export const flagStore = (values: Record<string, unknown> = {}): FlagStore => ({
  get: async (k) => (k in values ? { [k]: values[k] } : {}),
});
