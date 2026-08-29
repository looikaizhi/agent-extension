/**
 * Per-key serialization: tasks sharing a key run one after another, tasks
 * under different keys run freely.
 *
 * `background.ts` needs this because one user click can wake four independent
 * re-plan triggers for the same tab — the confirming click, the target
 * vanishing, the structure watcher, and the completed navigation — and
 * nothing stopped them running at once. Concurrently they raced each other's
 * extractions, spent overlapping model calls against the same thread, and
 * each overwrote the one `replan:{threadId}` record the others had just
 * written, so only the last finisher's account of what happened survived.
 *
 * The queue holds *only* the tail of each chain, and drops the key once its
 * chain drains, so a long-lived worker does not accumulate an entry per tab
 * it has ever guided.
 */
export function createSerialQueue() {
  const tails = new Map<string, Promise<unknown>>();

  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    // `.then` on both settlements: a task that throws must not stop the next
    // one from running. The rejection still reaches its own caller, because
    // that is a different promise from the one chained here.
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/**
 * Serialization plus latest-wins: a task still waiting its turn is abandoned
 * the moment a newer task claims the same key.
 *
 * `background.ts` re-plans on four independent triggers — the confirming
 * click, the target vanishing, the structure watcher, and the completed
 * navigation — and they all describe consecutive states of one transition.
 * Whichever runs last sees a page that subsumes what the earlier ones would
 * have seen, so their extraction and their model call are spent on a screen
 * that was already stale before the work began.
 *
 * What it actually does, measured across four live 15-journey runs: it drops
 * 8–34 redundant re-plans per run. Each drop is an extraction skipped on a
 * screen that was already superseded before the work began, and after 09's
 * settle gate it is also a *wait* skipped — the queued run would have paused
 * for a page that the run replacing it re-reads anyway.
 *
 * What it does **not** do, despite being built for it: reduce model calls per
 * hop. That stayed at 1.42 → 1.39, inside the noise. The prediction was wrong
 * about where the cost lived — a re-plan dispatches its model call and returns
 * immediately, so the call stays in flight in the panel long after the
 * function that started it is gone, and the next re-plan is not queued behind
 * anything to be superseded. Cost came down later, from 09's in-transit gate,
 * not from here. Kept because dropping obsolete work is worth doing on its own
 * terms, not because it achieved what it was proposed for.
 *
 * `onSuperseded` exists so the skip is reportable. A gate that silently
 * declines to do work is exactly what took two live debugging rounds to find
 * the last time, and `ReplanTrace` is where this one has to show up.
 */
export function createLatestWinsQueue() {
  const queue = createSerialQueue();
  const claims = new Map<string, number>();

  return function run(key: string, task: () => Promise<void>, onSuperseded?: () => Promise<void>): Promise<void> {
    const claim = (claims.get(key) ?? 0) + 1;
    claims.set(key, claim);
    return queue(key, async () => {
      if (claims.get(key) !== claim) return onSuperseded?.();
      await task();
    });
  };
}
