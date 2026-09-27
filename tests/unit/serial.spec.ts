import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '@/shared/serial';

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSerialQueue', () => {
  it('1. 同一个 key 的两个任务不重叠：第二个要等第一个结束才开始', async () => {
    const run = createSerialQueue();
    const first = deferred();
    const order: string[] = [];

    const a = run('t1', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = run('t1', async () => {
      order.push('b:start');
    });

    // Let every already-runnable microtask drain. `b` must still be waiting.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('2. 不同 key 之间不互相阻塞', async () => {
    const run = createSerialQueue();
    const blocker = deferred();
    const order: string[] = [];

    const a = run('t1', async () => {
      order.push('a:start');
      await blocker.promise;
    });
    const b = run('t2', async () => {
      order.push('b:start');
    });

    await b;
    expect(order).toEqual(['a:start', 'b:start']);

    blocker.resolve();
    await a;
  });

  it('3. 一个任务抛错，不会毒化同 key 的后续任务，错误只交给它自己的调用方', async () => {
    const run = createSerialQueue();
    const boom = new Error('boom');

    const failing = run('t1', async () => {
      throw boom;
    });
    const next = run('t1', async () => 'ok');

    await expect(failing).rejects.toBe(boom);
    await expect(next).resolves.toBe('ok');
  });
});
