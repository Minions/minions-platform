/**
 * Tests for FileTriggeredSignalRunner: an on-demand ISignalRunner that
 * invalidates its cached result on a (debounced) file change instead of
 * running immediately — the actual re-run is deferred until the next
 * status read calls ensureFresh(). pause()/resume() make it operate from
 * the outside exactly like the watch-mode runners (see the class's own doc
 * comment) — it no longer defers on its own during a git operation; that's
 * entirely the caller's job now, via pause()/resume().
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { EventBus } from '@minions/events';
import { FileTriggeredSignalRunner } from './FileTriggeredSignalRunner.js';
import { SignalType } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import type { ProcessResult, ProcessRunnerContext } from './runProcess.js';

/** Fake fs.watch: records the callback so tests can fire changes manually. */
function fakeWatchFs() {
  let onChange: ((eventType: string, filename: string | null) => void) | null = null;
  const closed = { value: false };
  const watchFs = (_path: string, _opts: unknown, listener: (eventType: string, filename: string | null) => void) => {
    onChange = listener;
    closed.value = false;
    return { close: () => { closed.value = true; } };
  };
  return {
    watchFs: watchFs as unknown as typeof import('node:fs').watch,
    fireChange: (filename: string | null = 'src/foo.ts') => onChange?.('change', filename),
    isClosed: () => closed.value,
    isWatching: () => onChange !== null && !closed.value,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('FileTriggeredSignalRunner', () => {
  it('starts pending and does not launch a run on its own', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);

    await runner.start();
    expect(runner.getState().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);

    expect(runProcess).not.toHaveBeenCalled();
    expect(runner.getState().state).toBe('pending');
    vi.useRealTimers();
  });

  it('reports the file-triggered strategy', () => {
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', new EventBus(), vi.fn());
    expect(runner.strategy).toBe('file-triggered');
  });

  it('ensureFresh() launches a run when there is no valid cached result yet', async () => {
    const eventBus = new EventBus();
    const { watchFs } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();

    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));

    expect(runProcess).toHaveBeenCalledWith('/wing', 'oxlint', { onActivity: expect.any(Function), changedPaths: null });
    expect(runner.getState().state).toBe('pass');
  });

  it('ensureFresh() is a no-op once a valid result is cached', async () => {
    const eventBus = new EventBus();
    const { watchFs } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(runProcess).toHaveBeenCalledTimes(1);

    runner.ensureFresh();
    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));

    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it('a qualifying file change invalidates a cached pass result (after the debounce) instead of re-running', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(runner.getState().state).toBe('pass');
    runProcess.mockClear();

    fireChange('src/a.ts');
    await vi.advanceTimersByTimeAsync(1000);

    expect(runProcess).not.toHaveBeenCalled();
    expect(runner.getState().state).toBe('pending');

    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(runner.getState().state).toBe('pass');
    vi.useRealTimers();
  });

  it('debounces rapid successive file changes into a single invalidation', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);
    runProcess.mockClear();

    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(e.state.state));

    fireChange('src/a.ts');
    await vi.advanceTimersByTimeAsync(400);
    fireChange('src/b.ts');
    await vi.advanceTimersByTimeAsync(400);
    fireChange('src/c.ts');
    await vi.advanceTimersByTimeAsync(1000);

    // A single invalidation (pass -> pending), no run launched automatically.
    expect(events).toEqual(['pending']);
    expect(runProcess).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ignores changes under node_modules, .git, .nx, dist, and wing-level sibling areas (private/info/closet/tool logs)', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);

    fireChange('node_modules/foo/index.js');
    fireChange('.git/index');
    fireChange('.nx/cache/x');
    fireChange('libs/foo/dist/index.js');
    fireChange('../private/local/scratch.md');
    fireChange('../info/reference.md');
    fireChange('../closet/asset.png');
    fireChange('.claude/settings.json');
    fireChange('.costume/mission-state.json');
    fireChange('private/untracked/tool-log.jsonl');
    fireChange('apps/cabinet/tools/log-tool-use.cjs');
    await vi.advanceTimersByTimeAsync(1000);

    expect(runner.getState().state).toBe('pass');
    vi.useRealTimers();
  });

  it('ignores tsc incremental build info and log files, so a typecheck run cannot re-trigger itself', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.CustomLint, 'custom-lint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);

    fireChange('tsconfig.base.tsbuildinfo');
    fireChange('libs/hatchery/tsconfig.build.tsbuildinfo');
    fireChange('nx-daemon.log');
    await vi.advanceTimersByTimeAsync(1000);

    expect(runner.getState().state).toBe('pass');
    vi.useRealTimers();
  });

  it('ignores bare project-directory change events and unresolvable (null) paths — observed live as the nx daemon\'s own background activity, not real edits', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);

    fireChange('libs/file-store');
    fireChange('libs/events');
    fireChange('apps/cabinet');
    fireChange(null);
    await vi.advanceTimersByTimeAsync(1000);

    expect(runner.getState().state).toBe('pass');
    vi.useRealTimers();
  });

  it('still reacts to a real, nested source-file change under a project directory', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);

    fireChange('libs/file-store/src/index.ts');
    await vi.advanceTimersByTimeAsync(1000);

    expect(runner.getState().state).toBe('pending');
    vi.useRealTimers();
  });

  it('ignores Vite\'s transient config-loader files, so every test/build run cannot re-trigger itself', async () => {
    vi.useFakeTimers();
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();
    runner.ensureFresh();
    await vi.advanceTimersByTimeAsync(10);

    fireChange('libs/quality-watcher/vite.config.ts.timestamp-1699999999999-abc123.mjs');
    fireChange('libs/hatchery/vitest.config.ts.timestamp-1699999999999-def456.mjs');
    await vi.advanceTimersByTimeAsync(1000);

    expect(runner.getState().state).toBe('pass');
    vi.useRealTimers();
  });

  it('maps a non-zero exit to fail with the output as a failure', async () => {
    const eventBus = new EventBus();
    const { watchFs } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 1, output: 'lint error' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();

    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['lint error']);
    }
  });

  it('ensureFresh() while a check is already in flight does not launch a second overlapping run', async () => {
    const eventBus = new EventBus();
    const { watchFs, fireChange } = fakeWatchFs();
    const first = deferred<ProcessResult>();
    let callIndex = 0;
    const runProcess = vi.fn(async () => {
      const idx = callIndex++;
      if (idx === 0) return first.promise;
      return { exitCode: 0, output: '' };
    });
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 0, watchFs);
    await runner.start();

    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(runProcess).toHaveBeenCalledTimes(1);

    // A file change invalidates it again mid-flight, but a status check
    // right now must not overlap the run already in progress.
    fireChange('src/mid-flight.ts');
    await new Promise((r) => setTimeout(r, 10));
    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(runProcess).toHaveBeenCalledTimes(1);

    first.resolve({ exitCode: 0, output: '' });
    await new Promise((r) => setTimeout(r, 10));
    // The in-flight run's result doesn't cover the later change — still
    // stale, so the next status read's ensureFresh() launches another run.
    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));

    expect(runProcess).toHaveBeenCalledTimes(2);
  });

  it('closes the fs watcher on stop', async () => {
    const eventBus = new EventBus();
    const { watchFs, isClosed } = fakeWatchFs();
    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.CustomLint, 'custom-lint', '/wing', eventBus, runProcess, 1000, watchFs);
    await runner.start();

    await runner.stop();

    expect(isClosed()).toBe(true);
  });

  it('emits started/state-changed/stopped events', async () => {
    const eventBus = new EventBus();
    const { watchFs } = fakeWatchFs();
    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.Started, () => events.push('started'));
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(`state:${e.state.state}`));
    eventBus.on(SignalRunnerEvents.Stopped, () => events.push('stopped'));
    // EventBus.on() subscribes via an async fiber — give it a tick to attach
    // before emitting, or the earliest events would be missed.
    await new Promise((r) => setTimeout(r, 10));

    const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
    const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 100, watchFs);
    await runner.start();
    runner.ensureFresh();
    await new Promise((r) => setTimeout(r, 10));
    await runner.stop();

    expect(events).toEqual(['started', 'state:running', 'state:pass', 'stopped']);
  });

  describe('pause()/resume() — operates from the outside like the watch-mode runners', () => {
    it('pause() closes the fs.watch outright — no work at all while paused', async () => {
      const eventBus = new EventBus();
      const { watchFs, isWatching } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();
      expect(isWatching()).toBe(true);

      await runner.pause();

      expect(isWatching()).toBe(false);
    });

    it('resume() re-arms the watch and unconditionally launches a fresh check', async () => {
      const eventBus = new EventBus();
      const { watchFs, isWatching } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.getState().state).toBe('pass');
      runProcess.mockClear();
      await runner.pause();

      await runner.resume();
      await new Promise((r) => setTimeout(r, 10));

      expect(isWatching()).toBe(true);
      // Launched on its own, without a status read calling ensureFresh().
      expect(runProcess).toHaveBeenCalledTimes(1);
    });

    it('pause() abandons a check already in flight — its eventual result is never applied', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const inFlight = deferred<ProcessResult>();
      const runProcess = vi.fn(async () => inFlight.promise);
      const events: string[] = [];
      eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(e.state.state));
      await new Promise((r) => setTimeout(r, 10));

      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 0, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.getState().state).toBe('running');

      await runner.pause();

      // The abandoned run finally resolves — must not be applied.
      inFlight.resolve({ exitCode: 1, output: 'should never be seen' });
      await new Promise((r) => setTimeout(r, 10));

      expect(runner.getState().state).toBe('running');
      expect(events).toEqual(['running']);
    });

    it('resume() after an abandoned in-flight check launches a genuinely new run, not blocked by the old one', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const first = deferred<ProcessResult>();
      let callIndex = 0;
      const runProcess = vi.fn(async () => {
        const idx = callIndex++;
        if (idx === 0) return first.promise;
        return { exitCode: 0, output: '' };
      });
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 0, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));
      expect(runProcess).toHaveBeenCalledTimes(1);

      await runner.pause();
      await runner.resume();
      await new Promise((r) => setTimeout(r, 10));

      expect(runProcess).toHaveBeenCalledTimes(2);
      expect(runner.getState().state).toBe('pass');

      // The original abandoned check resolving afterward changes nothing.
      first.resolve({ exitCode: 1, output: 'stale, must be ignored' });
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.getState().state).toBe('pass');
    });

    it('resume() before a matching pause() (or a second resume()) is safe and does not double-launch', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();

      await runner.resume();
      await new Promise((r) => setTimeout(r, 10));

      expect(runProcess).toHaveBeenCalledTimes(0);
    });

    it('does not launch a change-triggered check while paused, and picks it up once resumed', async () => {
      const eventBus = new EventBus();
      const { watchFs, fireChange } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 0, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));
      runProcess.mockClear();

      await runner.pause();
      fireChange('src/mid-pause.ts');
      await new Promise((r) => setTimeout(r, 10));
      expect(runProcess).not.toHaveBeenCalled();

      await runner.resume();
      await new Promise((r) => setTimeout(r, 10));

      // resume() itself already forces a fresh run — this change didn't
      // need to be separately noticed for that to happen.
      expect(runProcess).toHaveBeenCalledTimes(1);
      expect(runner.getState().state).toBe('pass');
    });
  });

  describe('lastActivityAt()', () => {
    it('is null before any check has ever launched', () => {
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', new EventBus(), vi.fn());
      expect(runner.lastActivityAt()).toBeNull();
    });

    it('is seeded the moment a check launches, then advances as the injected ProcessRunner reports activity', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const activityCallbacks: Array<() => void> = [];
      const runProcess = vi.fn(async (_cwd: string, _target: string, context?: ProcessRunnerContext) => {
        if (context?.onActivity) activityCallbacks.push(context.onActivity);
        return { exitCode: 0, output: '' } as ProcessResult;
      });
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();

      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));

      const seededAt = runner.lastActivityAt();
      if (!seededAt) throw new Error('expected lastActivityAt() to be seeded');
      expect(activityCallbacks).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 5));
      activityCallbacks[0]();

      const tickedAt = runner.lastActivityAt();
      if (!tickedAt) throw new Error('expected lastActivityAt() to still be set');
      expect(tickedAt.getTime()).toBeGreaterThan(seededAt.getTime());
    });

    it('ignores an activity tick from an abandoned (paused-over) check', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const gate = deferred<void>();
      let capturedOnActivity: (() => void) | undefined;
      const runProcess = vi.fn(async (_cwd: string, _target: string, context?: ProcessRunnerContext) => {
        capturedOnActivity = context?.onActivity;
        await gate.promise;
        return { exitCode: 0, output: '' } as ProcessResult;
      });
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));
      const seededAt = runner.lastActivityAt();

      await runner.pause();
      await new Promise((r) => setTimeout(r, 5));
      capturedOnActivity?.();
      gate.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(runner.lastActivityAt()).toEqual(seededAt);
    });
  });

  describe('changedPaths threading', () => {
    it('passes changedPaths: null on the very first check', async () => {
      const eventBus = new EventBus();
      const { watchFs } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 1000, watchFs);
      await runner.start();

      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 10));

      expect(runProcess).toHaveBeenCalledWith('/wing', 'oxlint', { onActivity: expect.any(Function), changedPaths: null });
    });

    it('passes the specific accumulated changed paths (as absolute paths) on a later check', async () => {
      const eventBus = new EventBus();
      const { watchFs, fireChange } = fakeWatchFs();
      const runProcess = vi.fn(async (_cwd: string, _target: string, _context?: ProcessRunnerContext) => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 10, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));
      runProcess.mockClear();

      fireChange('src/foo.ts');
      fireChange('src/bar.ts');
      await new Promise((r) => setTimeout(r, 20));
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));

      const call = runProcess.mock.calls[0];
      expect(call[2]?.changedPaths).toEqual(new Set([join('/wing', 'src/foo.ts'), join('/wing', 'src/bar.ts')]));
    });

    it('clears the accumulated set once a check consumes it, so the next check only sees what changed since', async () => {
      const eventBus = new EventBus();
      const { watchFs, fireChange } = fakeWatchFs();
      const runProcess = vi.fn(async (_cwd: string, _target: string, _context?: ProcessRunnerContext) => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 10, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));
      runProcess.mockClear();

      fireChange('src/foo.ts');
      await new Promise((r) => setTimeout(r, 20));
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));

      fireChange('src/bar.ts');
      await new Promise((r) => setTimeout(r, 20));
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));

      expect(runProcess.mock.calls[0][2]?.changedPaths).toEqual(new Set([join('/wing', 'src/foo.ts')]));
      expect(runProcess.mock.calls[1][2]?.changedPaths).toEqual(new Set([join('/wing', 'src/bar.ts')]));
    });

    it('passes changedPaths: null again after resume(), since change tracking was off during the pause', async () => {
      const eventBus = new EventBus();
      const { watchFs, fireChange } = fakeWatchFs();
      const runProcess = vi.fn(async () => ({ exitCode: 0, output: '' }) as ProcessResult);
      const runner = new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', '/wing', eventBus, runProcess, 10, watchFs);
      await runner.start();
      runner.ensureFresh();
      await new Promise((r) => setTimeout(r, 20));

      fireChange('src/foo.ts');
      await new Promise((r) => setTimeout(r, 20));
      await runner.pause();
      runProcess.mockClear();

      await runner.resume();
      await new Promise((r) => setTimeout(r, 20));

      expect(runProcess).toHaveBeenCalledWith('/wing', 'oxlint', { onActivity: expect.any(Function), changedPaths: null });
    });
  });
});
