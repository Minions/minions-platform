/**
 * Per-key FIFO serialization. Calls sharing a key run one at a time, in
 * submission order; calls with different keys never block each other. Each
 * call gets its own invocation and its own result — nothing is shared or
 * coalesced between callers the way a cache would be, and a failure in one
 * queued call never blocks the ones queued after it.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn);
    const nextTail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, nextTail);
    return result;
  }
}
