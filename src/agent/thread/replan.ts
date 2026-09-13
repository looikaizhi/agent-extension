import { createLatestWinsQueue } from '@/shared/serial';
import type { PromptTable } from '@/core/extractor/types';
import type { ThreadId } from './ports';

/**
 * Deciding when a page change is worth re-planning against.
 *
 * The hardest-won logic in the host, and until now the least verifiable: it
 * lived inline in `entrypoints/background.ts`, welded to `chrome.tabs`,
 * `chrome.storage` and the content-script channel, so every question about it
 * cost a four-minute live browser run. Three separate mistakes were found that
 * way and only that way — a settle criterion that never fired on a page that
 * re-renders, a `page-unchanged` that returned on the first look before the
 * page had a chance to move, and three hand-tuned windows that disagreed with
 * each other.
 *
 * Everything it needs from the outside world is a parameter, so the decision
 * runs in a plain node test with plain objects.
 */

/** What woke a re-plan. The two that change what happens at the end of the
 *  window are `'step-confirmed'` (the user acted, so a page that never moved
 *  is 「点了但没到」) and `'navigation'` (a completed load that reads back as
 *  the same page is a reload, so the step is painted again). */
export type ReplanTrigger = 'step-confirmed' | 'target-lost' | 'structure-changed' | 'navigation';

/** What a re-plan attempt saw. Written for every call, including the ones that
 *  decline to do anything — a gate that decides whether the guide moves owes
 *  an account of why it didn't. */
export interface ReplanTrace {
  at: number;
  trigger: ReplanTrigger;
  attempts: {
    attempt: number;
    ok: boolean;
    url?: string;
    items?: number;
    samePage?: boolean;
    /** The tab's own account of whether the page was still arriving. A table
     *  extracted mid-navigation describes the page being left. */
    inTransit?: boolean;
  }[];
  /**
   * - `replanned` — a model call went out against a fresh table.
   * - `deferred` — the page moved and was recorded, but a call was already out
   *   against the page being left, so nothing was spent. Reporting this as
   *   `replanned` is how one live run showed two re-plans for a breakpoint
   *   that made exactly one model call.
   * - `superseded` — a newer re-plan for this thread claimed the queue first.
   * - `page-unchanged` — the *whole window* closed with the page never moving.
   *   Not "the first look saw no change": `STEP_CONFIRMED` is dispatched at
   *   t≈0, and that earlier reading fired 23 times in one live run about pages
   *   that were about to change. A navigation is the one exception: it ends on
   *   its first unchanged look (`runReplan` says what that costs).
   */
  outcome: 'replanned' | 'deferred' | 'superseded' | 'page-unchanged' | 'unreadable' | 'injection-failed';
}

/** Reading the page, and asking the browser where the tab actually is. */
export interface ReplanPorts {
  /** `false` when the content script cannot be reached at all. */
  ensureReady(): Promise<boolean>;
  extract(): Promise<PromptTable | null>;
  /**
   * `samePage` — origin + pathname, not byte-for-byte: `PromptTable.url` is
   * sanitized, so strict equality rejects good tables for a reason unrelated
   * to staleness.
   *
   * `inTransit` — the browser's own answer to "has this page finished
   * arriving". Measured on github.com: a full navigation holds it for ~765 ms,
   * covering both triggers that used to commit the model call against the page
   * the user was leaving, while opening a dropdown never sets it at all — so a
   * same-page change pays nothing.
   *
   * Known gap: a same-document SPA route change does not necessarily set it.
   */
  verdict(table: PromptTable): Promise<{ samePage: boolean; inTransit: boolean }>;
  /** Hand a settled table to the reducer. `null` means the thread is gone or
   *  the page did not actually move; `spent` says whether a call went out. */
  commit(table: PromptTable): Promise<{ spent: boolean } | null>;
  /** The window closed on a confirming click that went nowhere — 设计文档's
   *  `failed`, "点了但没到". Deciding it needs a clock, which the pure
   *  reducer does not have. */
  reportSettleTimeout(): Promise<void>;
  /** A completed navigation landed where the thread already was — a reload.
   *  The content script it replaced took the overlay with it, and nothing
   *  else will paint the step again: the page did not move, so the reducer
   *  has nothing to decide. */
  redraw(): Promise<void>;
  record(trace: ReplanTrace): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Serializes every re-plan for one thread, latest wins.
 *
 * A single click on a navigating control wakes four independent triggers for
 * the same tab — the confirming click, the target vanishing, the structure
 * watcher, and the completed navigation. Run concurrently they raced each
 * other's extractions and spent overlapping model calls against one thread.
 * Keyed by `threadId`, so guides in different tabs still run in parallel.
 */
const queue = createLatestWinsQueue();

export function replan(
  threadId: ThreadId,
  ports: ReplanPorts,
  settle: readonly number[],
  trigger: ReplanTrigger,
): Promise<void> {
  return queue(
    threadId,
    () => runReplan(ports, settle, trigger),
    // Skipped work still owes an account: a gate declining silently took two
    // live debugging rounds to find the last time.
    () => ports.record({ at: ports.now(), trigger, attempts: [], outcome: 'superseded' }),
  );
}

async function runReplan(ports: ReplanPorts, settle: readonly number[], trigger: ReplanTrigger): Promise<void> {
  const trace: ReplanTrace = { at: ports.now(), trigger, attempts: [], outcome: 'unreadable' };
  const finish = (outcome: ReplanTrace['outcome']) => ports.record({ ...trace, outcome });

  if (!(await ports.ensureReady())) return finish('injection-failed');

  /** Whether any attempt got a readable table of the right, settled page. */
  let sawPage = false;

  for (let attempt = 0; attempt < settle.length; attempt++) {
    const wait = settle[attempt];
    if (wait) await ports.sleep(wait);

    const table = await ports.extract();
    if (!table) {
      trace.attempts.push({ attempt, ok: false });
      continue;
    }

    const { samePage, inTransit } = await ports.verdict(table);
    trace.attempts.push({ attempt, ok: true, url: table.url, items: table.items.length, samePage, inTransit });

    // Still arriving, so whatever was just read describes the page being left.
    if (inTransit) continue;
    // A table of a different page than the tab is on now is worse than none:
    // seen live, a re-plan after landing on a repo page was answered with the
    // organisation page's controls.
    if (!samePage) continue;
    // Zero controls means "not finished rendering", not "offers nothing".
    // Measured: `/search?q=n8n` reports complete while still rendering, and
    // accepting the empty table made the model plan against nothing.
    if (table.items.length === 0) continue;

    const outcome = await ports.commit(table);
    if (outcome) return finish(outcome.spent ? 'replanned' : 'deferred');

    // A completed navigation that reads back as the page the thread already
    // planned against is taken as a reload: the content script that held the
    // overlay went with the old document, so the step is painted again now.
    // Looking on instead holds this thread's queue for the whole window, and
    // the next reload or navigation waits behind it with no step on screen —
    // e2e went red on that in three runs out of three. The cost is measured
    // too: a page still rendering after `complete` (github.com) is no longer
    // caught here, and late renders caught fell from 78 to 35 over one live
    // run of 21 journeys.
    if (trigger === 'navigation') {
      await ports.redraw();
      return finish('page-unchanged');
    }

    // The page has not moved *yet*. Keep looking: the first look is taken
    // before the page has had any chance to respond, and no call is spent on
    // this path — a page that does move exits above on the attempt that sees it.
    sawPage = true;
  }

  if (!sawPage) return finish('unreadable');
  if (trigger === 'step-confirmed') await ports.reportSettleTimeout();
  return finish('page-unchanged');
}
