import { describe, it, expect } from 'vitest';
import { RepoFileChangeTracker } from './RepoFileChangeTracker.js';

function fakeWatchFs() {
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  const watchFsImpl = ((_path: unknown, _opts: unknown, cb: (eventType: string, filename: string | null) => void) => {
    listener = cb;
    return { close: () => undefined };
  }) as unknown as typeof import('node:fs').watch;
  return { watchFsImpl, fire: (eventType: string, filename: string | null) => listener?.(eventType, filename) };
}

describe('RepoFileChangeTracker', () => {
  it('starts with no observed change', () => {
    const { watchFsImpl } = fakeWatchFs();
    const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);
    expect(tracker.lastRelevantChangeAt()).toBeNull();
  });

  it('records a timestamp for a real source-file change', () => {
    const { watchFsImpl, fire } = fakeWatchFs();
    const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

    fire('change', 'src/foo.ts');

    expect(tracker.lastRelevantChangeAt()).not.toBeNull();
  });

  it('ignores changes under filtered paths (node_modules, .git, ...)', () => {
    const { watchFsImpl, fire } = fakeWatchFs();
    const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

    fire('change', 'node_modules/some-pkg/index.js');
    fire('change', '.git/index');

    expect(tracker.lastRelevantChangeAt()).toBeNull();
  });

  it('closes the underlying watch handle', () => {
    let closed = false;
    const watchFsImpl = ((_path: unknown, _opts: unknown, _cb: unknown) => ({ close: () => { closed = true; } })) as unknown as typeof import('node:fs').watch;
    const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

    tracker.close();

    expect(closed).toBe(true);
  });

  describe('pendingTestFileArrivals', () => {
    it('records a "rename" event matching Vitest\'s test-file naming as a new arrival', () => {
      const { watchFsImpl, fire } = fakeWatchFs();
      const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

      fire('rename', 'src/new.spec.ts');

      const arrivals = tracker.pendingTestFileArrivals();
      expect(arrivals.size).toBe(1);
      expect(Array.from(arrivals.keys())[0]).toContain('new.spec.ts');
    });

    it('does not treat a "change" event (an edit, not an arrival) as a new arrival, even if the name matches', () => {
      const { watchFsImpl, fire } = fakeWatchFs();
      const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

      fire('change', 'src/existing.spec.ts');

      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });

    it('does not treat a "rename" of a non-test file as an arrival', () => {
      const { watchFsImpl, fire } = fakeWatchFs();
      const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

      fire('rename', 'src/component.ts');

      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });

    it('keeps the first-seen timestamp for a repeated rename of the same path', async () => {
      const { watchFsImpl, fire } = fakeWatchFs();
      const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);

      fire('rename', 'src/new.spec.ts');
      const first = Array.from(tracker.pendingTestFileArrivals().values())[0];
      await new Promise((r) => setTimeout(r, 5));
      fire('rename', 'src/new.spec.ts');

      expect(tracker.pendingTestFileArrivals().size).toBe(1);
      expect(Array.from(tracker.pendingTestFileArrivals().values())[0]).toEqual(first);
    });

    it('clearTestFileArrival() removes just the one path; clearAllTestFileArrivals() removes everything', () => {
      const { watchFsImpl, fire } = fakeWatchFs();
      const tracker = new RepoFileChangeTracker('/repo', watchFsImpl);
      fire('rename', 'src/a.spec.ts');
      fire('rename', 'src/b.spec.ts');
      const [pathA] = tracker.pendingTestFileArrivals().keys();

      tracker.clearTestFileArrival(pathA);
      expect(tracker.pendingTestFileArrivals().size).toBe(1);

      tracker.clearAllTestFileArrivals();
      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });
  });
});
