/**
 * Shared fs.watch
 *
 * Coalesces multiple recursive `fs.watch(cwd, ...)` registrations on the same
 * path into a single underlying OS watch handle, fanning events out to every
 * subscriber. `QualityWatcher` runs two file-triggered signal runners
 * (oxlint, custom-lint — see FileTriggeredSignalRunner) that both watch the
 * exact same work-repo root — without this, that's two separate recursive
 * fs.watch handles doing identical path filtering over the same tree. (Tests,
 * types, and build each attach to their own tool's watch mode instead of
 * fs.watch at all, so they never go through this.)
 *
 * Refcounted: the real watcher is created on the first subscription to a
 * given path and closed once the last subscriber for that path closes.
 */

import { watch as fsWatch, type PathLike, type WatchOptions } from 'node:fs';

type WatchListener = (eventType: string, filename: string | null) => void;

type SharedEntry = {
  readonly watcher: { close(): void };
  readonly listeners: Set<WatchListener>;
};

/**
 * Returns a drop-in replacement for `fs.watch` that shares one real watcher
 * per distinct path across all calls made through the returned function.
 */
export function createSharedFsWatch(watchFsImpl: typeof fsWatch = fsWatch): typeof fsWatch {
  const entries = new Map<string, SharedEntry>();

  const sharedWatch = (path: PathLike, options: WatchOptions, listener: WatchListener) => {
    const key = String(path);
    let entry = entries.get(key);
    if (!entry) {
      const listeners = new Set<WatchListener>();
      const watcher = watchFsImpl(path, options, (eventType, filename) => {
        for (const l of listeners) l(eventType, filename as string | null);
      });
      entry = { watcher, listeners };
      entries.set(key, entry);
    }
    entry.listeners.add(listener);

    return {
      close: () => {
        const current = entries.get(key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          current.watcher.close();
          entries.delete(key);
        }
      },
    };
  };

  return sharedWatch as unknown as typeof fsWatch;
}
