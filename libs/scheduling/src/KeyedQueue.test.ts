import { describe, it, expect, vi } from 'vitest';
import { KeyedQueue } from './KeyedQueue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('KeyedQueue', () => {
  it('serializes two calls sharing a key', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const first = deferred<void>();

    const a = queue.run('repo-1', async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const b = queue.run('repo-1', async () => {
      order.push('b-start');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    first.resolve();
    await a;
    await b;
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('does not block calls under a different key', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const first = deferred<void>();

    const a = queue.run('repo-1', async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const b = queue.run('repo-2', async () => {
      order.push('b-start');
    });

    // b (a different key) resolves without waiting for a's in-flight call.
    await b;
    expect(order).toContain('b-start');
    expect(order).not.toContain('a-end');

    first.resolve();
    await a;
    expect(order).toEqual(['a-start', 'b-start', 'a-end']);
  });

  it('gives each call its own result, not coalesced', async () => {
    const queue = new KeyedQueue();
    const a = queue.run('repo-1', async () => 'first');
    const b = queue.run('repo-1', async () => 'second');
    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
  });

  it('a rejected call does not block later calls for the same key', async () => {
    const queue = new KeyedQueue();
    const a = queue.run('repo-1', async () => {
      throw new Error('boom');
    });
    const b = queue.run('repo-1', async () => 'still runs');

    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('still runs');
  });

  it('propagates the actual error to the caller that queued it', async () => {
    const queue = new KeyedQueue();
    const error = new Error('specific failure');
    const result = queue.run('repo-1', async () => {
      throw error;
    });
    await expect(result).rejects.toBe(error);
  });

  it('runs calls for the same key in submission order even when later ones resolve faster', async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];
    const runOne = (n: number, delayMs: number) =>
      queue.run('repo-1', async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(n);
      });

    vi.useFakeTimers();
    const p1 = runOne(1, 20);
    const p2 = runOne(2, 1);
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);
    vi.useRealTimers();

    expect(order).toEqual([1, 2]);
  });
});
