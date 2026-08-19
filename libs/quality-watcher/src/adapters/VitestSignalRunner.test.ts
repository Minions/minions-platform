import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { VitestSignalRunner, createVitestStarter, type VitestStarter } from './VitestSignalRunner.js';
import { SignalType } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import type { VitestResolution } from './resolveWorkRepoVitest.js';

/** Fake starter: captures the one onRunStart/onRunEnd pair for the shared instance so tests can fire them. */
function fakeStarter() {
  let callbacks: { onRunStart: () => void; onRunEnd: (result: { failures: string[]; warnings: string[]; moduleIds: string[] }) => void } | undefined;
  let closed = false;
  let pauseCalls = 0;
  let resumeCalls = 0;
  let lastActivity: Date | null = null;
  const starter: VitestStarter = vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
    callbacks = { onRunStart, onRunEnd };
    return {
      close: async () => { closed = true; },
      pause: () => { pauseCalls += 1; },
      resume: () => { resumeCalls += 1; },
      lastActivityAt: () => lastActivity,
    };
  });
  return {
    starter,
    fireRunStart: () => callbacks?.onRunStart(),
    fireRunEnd: (failures: string[] = [], warnings: string[] = [], moduleIds: string[] = []) => callbacks?.onRunEnd({ failures, warnings, moduleIds }),
    isClosed: () => closed,
    pauseCallCount: () => pauseCalls,
    resumeCallCount: () => resumeCalls,
    setLastActivity: (d: Date | null) => { lastActivity = d; },
  };
}

function discoverFixed(dirs: string[]) {
  return async () => dirs;
}

describe('VitestSignalRunner', () => {
  it('starts pending and starts one shared Vitest instance across every discovered project directory', async () => {
    const eventBus = new EventBus();
    const { starter } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a', '/wing/work/local/apps/b']));

    expect(runner.getState().state).toBe('pending');
    await runner.start();

    expect(starter).toHaveBeenCalledWith(
      '/wing/work/local',
      ['/wing/work/local/libs/a', '/wing/work/local/apps/b'],
      expect.any(Function),
      expect.any(Function)
    );
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('reports the Tests signal type and watch-mode strategy', () => {
    const runner = new VitestSignalRunner('/wing/work/local', new EventBus(), fakeStarter().starter, discoverFixed([]));
    expect(runner.signalType).toBe(SignalType.Tests);
    expect(runner.strategy).toBe('watch-mode');
  });

  it('transitions to running when the shared instance starts a run', async () => {
    const eventBus = new EventBus();
    const { starter, fireRunStart } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
    await runner.start();

    fireRunStart();

    expect(runner.getState().state).toBe('running');
  });

  it('transitions to pass once the shared instance reports a clean run', async () => {
    const eventBus = new EventBus();
    const { starter, fireRunEnd } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a', '/wing/work/local/apps/b']));
    await runner.start();

    fireRunEnd([]);

    expect(runner.getState().state).toBe('pass');
  });

  it('reports fail with the failures the shared instance reported', async () => {
    const eventBus = new EventBus();
    const { starter, fireRunEnd } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a', '/wing/work/local/apps/b']));
    await runner.start();

    fireRunEnd(['apps/b/ConfirmationDialog.test.ts: ConfirmationDialog > emits cancel: expected undefined to be truthy']);

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['apps/b/ConfirmationDialog.test.ts: ConfirmationDialog > emits cancel: expected undefined to be truthy']);
    }
  });

  it('carries warnings through on a passing run instead of dropping them', async () => {
    const eventBus = new EventBus();
    const { starter, fireRunEnd } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
    await runner.start();

    fireRunEnd([], ['[vite] "punycode" module is deprecated']);

    const state = runner.getState();
    expect(state.state).toBe('pass');
    expect(state.warnings).toEqual(['[vite] "punycode" module is deprecated']);
  });

  it('does not start a second Vitest instance on repeated start()', async () => {
    const eventBus = new EventBus();
    const { starter } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));

    await runner.start();
    await runner.start();

    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('reports fail if the starter rejects, without throwing out of start()', async () => {
    const eventBus = new EventBus();
    const starter: VitestStarter = vi.fn(async () => {
      throw new Error('VITEST_FILES_NOT_FOUND: No test files found');
    });
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));

    await expect(runner.start()).resolves.toBeUndefined();

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures[0]).toContain('VITEST_FILES_NOT_FOUND');
    }
  });

  it('stop() safely no-ops when the starter rejected on start', async () => {
    const eventBus = new EventBus();
    const starter: VitestStarter = vi.fn(async () => {
      throw new Error('boom');
    });
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
    await runner.start();

    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('closes the shared Vitest instance on stop', async () => {
    const eventBus = new EventBus();
    const { starter, isClosed } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a', '/wing/work/local/apps/b']));
    await runner.start();

    await runner.stop();

    expect(isClosed()).toBe(true);
  });

  it('pause()/resume() delegate to the handle instead of closing it', async () => {
    const eventBus = new EventBus();
    const { starter, isClosed, pauseCallCount, resumeCallCount } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
    await runner.start();

    await runner.pause();
    expect(pauseCallCount()).toBe(1);
    expect(isClosed()).toBe(false);

    await runner.resume();
    expect(resumeCallCount()).toBe(1);
    expect(isClosed()).toBe(false);
  });

  it('lastActivityAt() is null before start(), then delegates to the handle', async () => {
    const eventBus = new EventBus();
    const { starter, setLastActivity } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));

    expect(runner.lastActivityAt()).toBeNull();

    await runner.start();
    const activityAt = new Date('2026-01-01T00:00:00Z');
    setLastActivity(activityAt);

    expect(runner.lastActivityAt()).toBe(activityAt);
  });

  it('lastActivityAt() is seeded the moment start() is called, before the handle even exists (covers warmup)', async () => {
    const eventBus = new EventBus();
    const resolveStarterBox: { current: (() => void) | null } = { current: null };
    const slowStarter: VitestStarter = () =>
      new Promise((resolve) => {
        resolveStarterBox.current = () => resolve({ close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null });
      });
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, slowStarter, discoverFixed(['/wing/work/local/libs/a']));

    expect(runner.lastActivityAt()).toBeNull();
    const startPromise = runner.start();

    // Still mid-warmup — the starter (project discovery, startVitest()
    // resolving) hasn't returned a handle yet — but lastActivityAt() must
    // already report a real, recent timestamp, not null.
    expect(runner.lastActivityAt()).not.toBeNull();

    // Let discoverProjectDirs's own microtask resolve so the starter (and
    // resolveStarterBox.current) actually gets invoked before we try to resolve it.
    await new Promise((r) => setTimeout(r, 0));
    resolveStarterBox.current?.();
    await startPromise;
  });

  it('pause()/resume() are no-ops before start()', async () => {
    const eventBus = new EventBus();
    const { starter } = fakeStarter();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));

    await expect(runner.pause()).resolves.toBeUndefined();
    await expect(runner.resume()).resolves.toBeUndefined();
  });

  it('emits started/state-changed/stopped events', async () => {
    const eventBus = new EventBus();
    const { starter, fireRunEnd } = fakeStarter();
    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.Started, () => events.push('started'));
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(`state:${e.state.state}`));
    eventBus.on(SignalRunnerEvents.Stopped, () => events.push('stopped'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
    await runner.start();
    fireRunEnd([]);
    await runner.stop();

    expect(events).toEqual(['started', 'state:pass', 'stopped']);
  });
});

describe('createVitestStarter — repo-owned Vitest resolution', () => {
  it('reports an instant pass with no discovered project dirs, without resolving Vitest at all', async () => {
    const resolveVitest = vi.fn((): Promise<VitestResolution> => Promise.resolve({ kind: 'not-found' }));
    const starter = createVitestStarter(resolveVitest);
    const eventBus = new EventBus();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, async () => []);

    await runner.start();

    expect(resolveVitest).not.toHaveBeenCalled();
    expect(runner.getState().state).toBe('pass');
  });

  it('reports an instant pass for a repo with no installed Vitest at all', async () => {
    const resolveVitest = vi.fn((): Promise<VitestResolution> => Promise.resolve({ kind: 'not-found' }));
    const starter = createVitestStarter(resolveVitest);
    const eventBus = new EventBus();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, async () => ['/wing/work/local/libs/a']);

    await runner.start();

    expect(resolveVitest).toHaveBeenCalledWith('/wing/work/local');
    expect(runner.getState().state).toBe('pass');
  });

  it('reports a fail with a clear message when the repo\'s Vitest version is unsupported, and does not import anything', async () => {
    const resolveVitest = vi.fn(
      (): Promise<VitestResolution> => Promise.resolve({ kind: 'unsupported-version', version: '1.0.0', message: 'update your Vitest or Cabinet' })
    );
    const starter = createVitestStarter(resolveVitest);
    const eventBus = new EventBus();
    const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, async () => ['/wing/work/local/libs/a']);

    await runner.start();

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['update your Vitest or Cabinet']);
    }
  });

  it('stop() on a not-found/unsupported resolution is a no-op, not an error', async () => {
    const resolveVitest = vi.fn((): Promise<VitestResolution> => Promise.resolve({ kind: 'not-found' }));
    const starter = createVitestStarter(resolveVitest);
    const runner = new VitestSignalRunner('/wing/work/local', new EventBus(), starter, async () => ['/wing/work/local/libs/a']);
    await runner.start();

    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('reports an instant pass, without importing Vitest, when every discovered dir currently has zero test files', async () => {
    const resolveVitest = vi.fn((): Promise<VitestResolution> => Promise.resolve({ kind: 'ok', version: '4.1.9', entryUrl: 'unused:entry' }));
    const hasTestFiles = vi.fn((_dir: string): Promise<boolean> => Promise.resolve(false));
    const starter = createVitestStarter(resolveVitest, hasTestFiles);
    const runner = new VitestSignalRunner('/wing/work/local', new EventBus(), starter, async () => ['/wing/work/local/libs/a', '/wing/work/local/apps/b']);

    await runner.start();

    expect(hasTestFiles.mock.calls.map((call) => call[0])).toEqual(['/wing/work/local/libs/a', '/wing/work/local/apps/b']);
    // Exactly one arg per call — catches a `.filter(hasTestFiles)`-style regression:
    // Array.filter passes (element, index, array), and hasTestFiles' second parameter
    // (readDir, defaulted in the real implementation) would silently receive the index
    // instead of its default, breaking real directory reads.
    expect(hasTestFiles.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(runner.getState().state).toBe('pass');
  });

  describe('hasRunFile', () => {
    it('reports true only for a file actually included in the most recently completed run', async () => {
      const eventBus = new EventBus();
      const { starter, fireRunStart, fireRunEnd } = fakeStarter();
      const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
      await runner.start();

      fireRunStart();
      fireRunEnd([], [], ['/wing/work/local/libs/a/foo.spec.ts', '/wing/work/local/libs/a/bar.spec.ts']);

      expect(runner.hasRunFile('/wing/work/local/libs/a/foo.spec.ts')).toBe(true);
      expect(runner.hasRunFile('/wing/work/local/libs/a/new.spec.ts')).toBe(false);
    });

    it('replaces (not accumulates) the tracked file set on each new completed run', async () => {
      const eventBus = new EventBus();
      const { starter, fireRunStart, fireRunEnd } = fakeStarter();
      const runner = new VitestSignalRunner('/wing/work/local', eventBus, starter, discoverFixed(['/wing/work/local/libs/a']));
      await runner.start();

      fireRunStart();
      fireRunEnd([], [], ['/wing/work/local/libs/a/foo.spec.ts']);
      expect(runner.hasRunFile('/wing/work/local/libs/a/foo.spec.ts')).toBe(true);

      // A later cycle that doesn't include foo.spec.ts anymore (e.g. it was
      // deleted, or this cycle only reran a different project) must not keep
      // reporting it as present just because an earlier cycle ran it once.
      fireRunStart();
      fireRunEnd([], [], ['/wing/work/local/libs/a/new.spec.ts']);
      expect(runner.hasRunFile('/wing/work/local/libs/a/foo.spec.ts')).toBe(false);
      expect(runner.hasRunFile('/wing/work/local/libs/a/new.spec.ts')).toBe(true);
    });
  });
});
