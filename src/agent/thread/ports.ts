import type { ExtractProfile, ProjectBudget, PromptTable } from '@/core/extractor/types';
import type { SessionId } from '@/shared/protocol';

/**
 * What the host needs from the outside world, as parameters.
 *
 * Everything the guide decides is ordinary data-in/data-out logic, but the two
 * facts it decides *on* — what is on the page, and where the tab's storage is
 * — only exist inside `chrome.*`. Declaring them here as ports is what lets
 * the deciding half run in a plain node test with plain objects, and keeps
 * `entrypoints/background.ts` as the only file that knows `chrome` exists.
 */

/** K-9: one live session per tab, and the checkpoint thread is that session. */
export type ThreadId = SessionId;

/** Reading the page. The one call the host makes into the content script. */
export interface PageAccess {
  extract(profile: ExtractProfile, budget: ProjectBudget): Promise<PromptTable>;
}

/** Where a thread survives the service worker being evicted. */
export interface ThreadStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
