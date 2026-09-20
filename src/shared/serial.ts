/**
 * Per-key serialization: tasks sharing a key run one after another, tasks
 * under different keys run freely.
 *
 * A thread's writes need this (`agent/thread/writer.ts`): each reads the thread,
 * computes, and writes it back, and two interleaved would each overwrite what
 * the other just wrote — or resurrect a thread that had already ended.
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
