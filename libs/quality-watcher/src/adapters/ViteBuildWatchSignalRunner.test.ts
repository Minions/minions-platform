import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { ViteBuildWatchSignalRunner, createViteBuildStarter, type ViteBuildStarter } from './ViteBuildWatchSignalRunner.js';
import { SignalType } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import type { ViteResolution } from './resolveWorkRepoVite.js';

function fakeStarter() {
  let onCycleStart: (() => void) | null = null;
  let onCycleEnd: ((result: { failures: string[]; warnings: string[] }) => void) | null = null;
  const closed = { value: false };
  let lastActivity: Date | null = null;
  const starter: ViteBuildStarter = vi.fn(async (_cwd, start, end) => {
    onCycleStart = start;
    onCycleEnd = end;
    return { close: async () => { closed.value = true; }, lastActivityAt: () => lastActivity };
  });
  return {
    starter,
    fireCycleStart: () => onCycleStart?.(),
    fireCycleEnd: (failures: string[] = [], warnings: string[] = []) => onCycleEnd?.({ failures, warnings }),
    isClosed: () => closed.value,
    setLastActivity: (d: Date | null) => { lastActivity = d; },
  };
}

describe('ViteBuildWatchSignalRunner', () => {
  it('starts pending and calls the starter with cwd on start()', async () => {
    const eventBus = new EventBus();
    const { starter } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    expect(runner.getState().state).toBe('pending');
    await runner.start();

    expect(starter).toHaveBeenCalledWith('/wing/work/local', expect.any(Function), expect.any(Function));
  });

  it('reports the Build signal type and watch-mode strategy', () => {
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', new EventBus(), fakeStarter().starter);
    expect(runner.signalType).toBe(SignalType.Build);
    expect(runner.strategy).toBe('watch-mode');
  });

  it('transitions to running when a build cycle starts', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleStart } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    fireCycleStart();

    expect(runner.getState().state).toBe('running');
  });

  it('transitions to pass when a build cycle ends cleanly', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleEnd } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    fireCycleEnd([]);

    expect(runner.getState().state).toBe('pass');
  });

  it('transitions to fail with the reported build error', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleEnd } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    fireCycleEnd(['Could not resolve "./missing.ts"']);

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['Could not resolve "./missing.ts"']);
    }
  });

  it('carries warnings through on a clean build instead of dropping them', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleEnd } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    fireCycleEnd([], ['[plugin:vite:css] @import is deprecated']);

    const state = runner.getState();
    expect(state.state).toBe('pass');
    expect(state.warnings).toEqual(['[plugin:vite:css] @import is deprecated']);
  });

  it('does not start a second build watcher on repeated start()', async () => {
    const eventBus = new EventBus();
    const { starter } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    await runner.start();
    await runner.start();

    expect(starter).toHaveBeenCalledTimes(1);
  });

  it('closes the build watcher on stop', async () => {
    const eventBus = new EventBus();
    const { starter, isClosed } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    await runner.stop();

    expect(isClosed()).toBe(true);
  });

  it('pause() closes the watcher (same as stop()) and resume() starts a fresh one', async () => {
    const eventBus = new EventBus();
    const { starter, isClosed, fireCycleEnd } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();

    await runner.pause();
    expect(isClosed()).toBe(true);

    await runner.resume();
    expect(starter).toHaveBeenCalledTimes(2);

    fireCycleEnd([]);
    expect(runner.getState().state).toBe('pass');
  });

  it('getState() reports pending between pause() and resume() reporting a fresh cycle', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleEnd } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();
    fireCycleEnd([]);
    expect(runner.getState().state).toBe('pass');

    await runner.pause();
    await runner.resume();

    expect(runner.getState().state).toBe('pending');
  });

  it('lastActivityAt() is seeded the moment start() is called, before the watcher even exists (covers warmup)', async () => {
    const eventBus = new EventBus();
    const resolveStarterBox: { current: (() => void) | null } = { current: null };
    const slowStarter: ViteBuildStarter = () =>
      new Promise((resolve) => {
        resolveStarterBox.current = () => resolve({ close: async () => undefined, lastActivityAt: () => null });
      });
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, slowStarter);

    expect(runner.lastActivityAt()).toBeNull();
    const startPromise = runner.start();

    expect(runner.lastActivityAt()).not.toBeNull();

    resolveStarterBox.current?.();
    await startPromise;
  });

  it('lastActivityAt() is null before start(), then delegates to the handle', async () => {
    const eventBus = new EventBus();
    const { starter, setLastActivity } = fakeStarter();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    expect(runner.lastActivityAt()).toBeNull();

    await runner.start();
    const activityAt = new Date('2026-01-01T00:00:00Z');
    setLastActivity(activityAt);

    expect(runner.lastActivityAt()).toBe(activityAt);
  });

  it('emits started/state-changed/stopped events', async () => {
    const eventBus = new EventBus();
    const { starter, fireCycleEnd } = fakeStarter();
    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.Started, () => events.push('started'));
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(`state:${e.state.state}`));
    eventBus.on(SignalRunnerEvents.Stopped, () => events.push('stopped'));
    // EventBus.on() subscribes via a background fiber; give it a tick to
    // actually attach before anything emits.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);
    await runner.start();
    fireCycleEnd([]);
    await runner.stop();

    expect(events).toEqual(['started', 'state:pass', 'stopped']);
  });
});

describe('createViteBuildStarter — repo-owned Vite resolution', () => {
  it('reports an instant pass when the repo has no installed Vite at all', async () => {
    const resolveVite = vi.fn((): Promise<ViteResolution> => Promise.resolve({ kind: 'not-found' }));
    const starter = createViteBuildStarter(resolveVite);
    const eventBus = new EventBus();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    await runner.start();

    expect(resolveVite).toHaveBeenCalledWith('/wing/work/local');
    expect(runner.getState().state).toBe('pass');
  });

  it('reports a fail with a clear message when the repo\'s Vite version is unsupported, and does not import anything', async () => {
    const resolveVite = vi.fn(
      (): Promise<ViteResolution> => Promise.resolve({ kind: 'unsupported-version', version: '2.0.0', message: 'update your Vite or Cabinet' })
    );
    const starter = createViteBuildStarter(resolveVite);
    const eventBus = new EventBus();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    await runner.start();

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['update your Vite or Cabinet']);
    }
  });

  it('stop() on a not-found/unsupported resolution is a no-op, not an error', async () => {
    const resolveVite = vi.fn((): Promise<ViteResolution> => Promise.resolve({ kind: 'not-found' }));
    const starter = createViteBuildStarter(resolveVite);
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', new EventBus(), starter);
    await runner.start();

    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('reports an instant pass, without importing Vite, when the package resolves but the repo has no root-level Vite project', async () => {
    // e.g. `vite` hoisted as a devDependency used only by nested per-app
    // configs in an nx/pnpm monorepo — resolvable from the root, but there's
    // no root vite.config/index.html for `build()` to target.
    const resolveVite = vi.fn(
      (): Promise<ViteResolution> => Promise.resolve({ kind: 'ok', version: '5.0.0', entryUrl: 'file:///should-not-be-imported.js' })
    );
    const hasEntry = vi.fn(async () => false);
    const starter = createViteBuildStarter(resolveVite, hasEntry);
    const eventBus = new EventBus();
    const runner = new ViteBuildWatchSignalRunner('/wing/work/local', eventBus, starter);

    await runner.start();

    expect(hasEntry).toHaveBeenCalledWith('/wing/work/local');
    expect(runner.getState().state).toBe('pass');
  });
});
