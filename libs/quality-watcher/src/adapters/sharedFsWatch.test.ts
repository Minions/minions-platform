/**
 * Tests for createSharedFsWatch: coalesces multiple fs.watch registrations
 * on the same path into one underlying watcher, fanned out to subscribers.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSharedFsWatch } from './sharedFsWatch.js';

/** Fake fs.watch: records how many times the real watch function was invoked per path. */
function fakeFsWatch() {
  const listenersByPath = new Map<string, Array<(eventType: string, filename: string | null) => void>>();
  const closedByPath = new Map<string, number>();
  const watchFsImpl = vi.fn((path: string, _opts: unknown, listener: (eventType: string, filename: string | null) => void) => {
    const listeners = listenersByPath.get(path) ?? [];
    listeners.push(listener);
    listenersByPath.set(path, listeners);
    return {
      close: () => {
        closedByPath.set(path, (closedByPath.get(path) ?? 0) + 1);
      },
    };
  });
  return {
    watchFsImpl: watchFsImpl as unknown as typeof import('node:fs').watch,
    fireChange: (path: string, filename: string | null = 'src/foo.ts') => {
      for (const listener of listenersByPath.get(path) ?? []) listener('change', filename);
    },
    realWatchCallCount: () => watchFsImpl.mock.calls.length,
    closeCount: (path: string) => closedByPath.get(path) ?? 0,
  };
}

describe('createSharedFsWatch', () => {
  it('creates only one real watcher for two subscriptions to the same path', () => {
    const { watchFsImpl, realWatchCallCount } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);

    sharedWatch('/wing', { recursive: true }, () => undefined);
    sharedWatch('/wing', { recursive: true }, () => undefined);

    expect(realWatchCallCount()).toBe(1);
  });

  it('creates separate real watchers for different paths', () => {
    const { watchFsImpl, realWatchCallCount } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);

    sharedWatch('/wing/local', { recursive: true }, () => undefined);
    sharedWatch('/wing/global', { recursive: true }, () => undefined);

    expect(realWatchCallCount()).toBe(2);
  });

  it('fans a single underlying event out to every subscriber of that path', () => {
    const { watchFsImpl, fireChange } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);
    const seenByA: Array<string | null> = [];
    const seenByB: Array<string | null> = [];

    sharedWatch('/wing', { recursive: true }, (_type, filename) => seenByA.push(filename));
    sharedWatch('/wing', { recursive: true }, (_type, filename) => seenByB.push(filename));
    fireChange('/wing', 'src/a.ts');

    expect(seenByA).toEqual(['src/a.ts']);
    expect(seenByB).toEqual(['src/a.ts']);
  });

  it('keeps the real watcher open until every subscriber for that path has closed', () => {
    const { watchFsImpl, closeCount } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);

    const first = sharedWatch('/wing', { recursive: true }, () => undefined);
    const second = sharedWatch('/wing', { recursive: true }, () => undefined);

    first.close();
    expect(closeCount('/wing')).toBe(0);

    second.close();
    expect(closeCount('/wing')).toBe(1);
  });

  it('lets a closed subscriber re-subscribe, starting a fresh real watcher for that path', () => {
    const { watchFsImpl, realWatchCallCount } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);

    const first = sharedWatch('/wing', { recursive: true }, () => undefined);
    first.close();
    sharedWatch('/wing', { recursive: true }, () => undefined);

    expect(realWatchCallCount()).toBe(2);
  });

  it('stops delivering events to a subscriber that has closed, while others keep receiving them', () => {
    const { watchFsImpl, fireChange } = fakeFsWatch();
    const sharedWatch = createSharedFsWatch(watchFsImpl);
    const seenByA: Array<string | null> = [];
    const seenByB: Array<string | null> = [];

    const subA = sharedWatch('/wing', { recursive: true }, (_type, filename) => seenByA.push(filename));
    sharedWatch('/wing', { recursive: true }, (_type, filename) => seenByB.push(filename));

    subA.close();
    fireChange('/wing', 'src/a.ts');

    expect(seenByA).toEqual([]);
    expect(seenByB).toEqual(['src/a.ts']);
  });
});
