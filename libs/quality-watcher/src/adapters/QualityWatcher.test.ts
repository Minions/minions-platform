/**
 * Tests for QualityWatcher: three continuously-watched signals (tests via
 * Vitest, types via vue-tsc, build via Vite) plus two on-demand signals
 * (oxlint, custom-lint) whose file-triggered debounce only invalidates a
 * cached result — getStatus()/awaitStatus() are what actually launch a run
 * for those when there's nothing valid cached.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { QualityWatcher } from './QualityWatcher.js';
import { SignalType } from '../SignalState.js';
import type { ProcessResult, ProcessRunner } from './runProcess.js';
import type { VitestStarter } from './VitestSignalRunner.js';
import type { ViteBuildStarter } from './ViteBuildWatchSignalRunner.js';
import type { WatchedChildProcess } from './ProcessWatchSignalRunner.js';

/** Fake fs.watch: every runner gets its own watcher; none of these tests need to fire changes. */
function fakeWatchFs(): typeof import('node:fs').watch {
  return ((_path: string, _opts: unknown, _listener: (...args: unknown[]) => void) => ({
    close: () => undefined,
  })) as unknown as typeof import('node:fs').watch;
}

/** Like fakeWatchFs, but counts how many times the underlying fs.watch is actually invoked. */
function countingWatchFs() {
  let calls = 0;
  const watchFs = ((_path: string, _opts: unknown, _listener: (...args: unknown[]) => void) => {
    calls += 1;
    return { close: () => undefined };
  }) as unknown as typeof import('node:fs').watch;
  return { watchFs, callCount: () => calls };
}

/** Fake fs.watch that records its listener so a test can fire a change through it directly. */
function triggerableWatchFs() {
  let onChange: ((eventType: string, filename: string | null) => void) | null = null;
  const watchFs = ((_path: string, _opts: unknown, listener: (eventType: string, filename: string | null) => void) => {
    onChange = listener;
    return { close: () => undefined };
  }) as unknown as typeof import('node:fs').watch;
  return {
    watchFs,
    fireChange: (filename = 'src/foo.ts') => onChange?.('change', filename),
    fireRename: (filename = 'src/foo.ts') => onChange?.('rename', filename),
  };
}

function watchProcessFor(results: Partial<Record<string, ProcessResult>>): ProcessRunner {
  return (_cwd, target) => Promise.resolve(results[target] ?? { exitCode: 0, output: '' });
}

/** Fake Vitest starter: resolves to pass immediately unless told to fail. pause()/resume() are spies, so a test can confirm the cheap pause/resume path (not a full stop()/start() restart) was actually used. */
function fakeVitestStarter(failures: string[] = [], moduleIds: string[] = []): VitestStarter & { pauseCalls: () => number; resumeCalls: () => number } {
  let pauseCalls = 0;
  let resumeCalls = 0;
  const starter = vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
    onRunStart();
    onRunEnd({ failures, warnings: [], moduleIds });
    return {
      close: async () => undefined,
      pause: () => { pauseCalls += 1; },
      resume: () => { resumeCalls += 1; },
      lastActivityAt: () => null,
    };
  });
  return Object.assign(starter, { pauseCalls: () => pauseCalls, resumeCalls: () => resumeCalls });
}

/** Fake Vite build starter: resolves to pass immediately unless told to fail. */
function fakeViteBuildStarter(failures: string[] = []): ViteBuildStarter {
  return vi.fn(async (_cwd, onCycleStart, onCycleEnd) => {
    onCycleStart();
    onCycleEnd({ failures });
    return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
  });
}

/** Fake vue-tsc subprocess: emits a clean cycle immediately unless told to fail. */
function fakeVueTscSpawn(errorCount = 0): (cwd: string) => WatchedChildProcess {
  return vi.fn((_cwd: string) => {
    let listener: ((chunk: string) => void) | null = null;
    const child: WatchedChildProcess = {
      stdout: {
        on: (_event, l) => {
          listener = l;
          queueMicrotask(() => listener?.(`Found ${errorCount} errors. Watching for file changes.\n`));
        },
      },
      stderr: { on: () => undefined },
      kill: () => undefined,
    };
    return child;
  });
}

function defaultOptions(overrides: Partial<ConstructorParameters<typeof QualityWatcher>[3]> = {}) {
  return {
    vitestStarter: fakeVitestStarter(),
    discoverVitestProjectDirs: async () => ['/wing/work/local'],
    viteBuildStarter: fakeViteBuildStarter(),
    vueTscSpawn: fakeVueTscSpawn(),
    oxlintProcess: watchProcessFor({}),
    customLintProcess: watchProcessFor({}),
    watchFs: fakeWatchFs(),
    debounceMs: 0,
    ...overrides,
  };
}

describe('QualityWatcher', () => {
  it('reports isRunning false before start and true after start', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
    expect(watcher.isRunning()).toBe(false);

    await watcher.start();

    expect(watcher.isRunning()).toBe(true);
  });

  it('getStatus before start returns all signals as running (internal "pending" is collapsed into "running" for external reporting)', () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
    const status = watcher.getStatus();

    expect(status[SignalType.Tests].state).toBe('running');
    expect(status[SignalType.Types].state).toBe('running');
    expect(status[SignalType.Build].state).toBe('running');
    expect(status[SignalType.OxLint].state).toBe('running');
    expect(status[SignalType.CustomLint].state).toBe('running');
    expect(status.isPartial).toBe(true);
  });

  it('every signal settles after start() — awaitStatus launches the on-demand oxlint/custom-lint checks itself', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Tests].state).toBe('pass');
    expect(status[SignalType.Types].state).toBe('pass');
    expect(status[SignalType.Build].state).toBe('pass');
    expect(status[SignalType.OxLint].state).toBe('pass');
    expect(status[SignalType.CustomLint].state).toBe('pass');
  });

  it('awaitStatus surfaces a failing test run', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions({
      vitestStarter: fakeVitestStarter(['src/foo.test.ts > adds: expected 3 to be 4']),
    }));
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Tests].state).toBe('fail');
    if (status[SignalType.Tests].state === 'fail') {
      expect(status[SignalType.Tests].failures).toEqual(['src/foo.test.ts > adds: expected 3 to be 4']);
    }
  });

  it('awaitStatus surfaces a failing build', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions({
      viteBuildStarter: fakeViteBuildStarter(['Could not resolve "./missing.ts"']),
    }));
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Build].state).toBe('fail');
  });

  it('awaitStatus surfaces a failing typecheck', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions({
      vueTscSpawn: fakeVueTscSpawn(2),
    }));
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Types].state).toBe('fail');
  });

  it('awaitStatus surfaces a failing lint signal', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions({
      oxlintProcess: watchProcessFor({ oxlint: { exitCode: 1, output: 'lint error: unused var' } }),
    }));
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.OxLint].state).toBe('fail');
    if (status[SignalType.OxLint].state === 'fail') {
      expect(status[SignalType.OxLint].failures).toEqual(['lint error: unused var']);
    }
  });

  it('throws if started while already running', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
    await watcher.start();

    await expect(watcher.start()).rejects.toThrow('already running');
  });

  it('stop() stops the watcher', async () => {
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));

    await watcher.stop();

    expect(watcher.isRunning()).toBe(false);
  });

  it('shares a single real fs.watch handle across the two file-triggered signals (oxlint, custom-lint)', async () => {
    const { watchFs, callCount } = countingWatchFs();
    const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions({ watchFs }));

    await watcher.start();

    expect(callCount()).toBe(1);
  });

  it('a file change invalidates oxlint/custom-lint without re-running them, and the next status check relaunches only those two', async () => {
    const oxlintProcess = vi.fn(watchProcessFor({}));
    const customLintProcess = vi.fn(watchProcessFor({}));
    const { watchFs, fireChange } = triggerableWatchFs();
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ oxlintProcess, customLintProcess, watchFs })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.OxLint].state).toBe('pass'));
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('pass'));
    oxlintProcess.mockClear();
    customLintProcess.mockClear();

    fireChange('src/changed.ts');
    // Debounce is 0ms, but invalidation only flips cached state to pending —
    // it must not, on its own, launch either process. (Reading getStatus()
    // here would itself relaunch a stale signal, so check the underlying
    // process calls directly instead of racing a state read against that.)
    await new Promise((r) => setTimeout(r, 20));
    expect(oxlintProcess).not.toHaveBeenCalled();
    expect(customLintProcess).not.toHaveBeenCalled();

    // A subsequent status check is what actually launches a run for the now-stale signals.
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.OxLint].state).toBe('pass'));
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('pass'));
    expect(oxlintProcess).toHaveBeenCalledTimes(1);
    expect(customLintProcess).toHaveBeenCalledTimes(1);
  });

  it('restarts a watch-mode signal (tests) whose cached result predates a file change by more than the grace period', async () => {
    const vitestStarter = fakeVitestStarter();
    const { watchFs, fireChange } = triggerableWatchFs();
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 0 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    // Simulate the underlying Vitest watch instance going deaf to further
    // file changes: fire a qualifying change through the shared fs.watch
    // (the same one oxlint/custom-lint use), but the fake starter's
    // onRunStart/onRunEnd never fire again on their own — nothing except
    // the staleness guard would ever notice.
    fireChange('src/changed.ts');

    // Each status read is what actually runs the staleness check — poll via
    // repeated getStatus() calls, same as the on-demand oxlint/custom-lint
    // relaunch test above.
    await vi.waitFor(() => {
      watcher.getStatus();
      expect(vitestStarter).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
  });

  it('does not restart a watch-mode signal that is still within its grace period after a file change', async () => {
    const vitestStarter = fakeVitestStarter();
    const { watchFs, fireChange } = triggerableWatchFs();
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 60_000 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    fireChange('src/changed.ts');
    watcher.getStatus();
    await new Promise((r) => setTimeout(r, 20));

    expect(vitestStarter).toHaveBeenCalledTimes(1);
  });

  it('gives a freshly restarted watch-mode signal its own grace period, instead of restarting it again before it can converge', async () => {
    const { watchFs, fireChange } = triggerableWatchFs();
    let starterCalls = 0;
    const vitestStarter: VitestStarter = vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
      starterCalls += 1;
      if (starterCalls === 1) {
        onRunStart();
        onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      }
      // The restart (2nd call onward) never calls onRunStart/onRunEnd — its
      // replacement instance is still "converging", same as a real cold
      // Vitest/vue-tsc/Vite watch-mode start can legitimately take longer
      // than one poll interval. Its cached state is reset to 'pending' by
      // start() itself, not left at the earlier stale 'pass'.
      return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
    });
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 300 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    fireChange('src/changed.ts');
    await vi.waitFor(
      () => {
        watcher.getStatus();
        expect(vitestStarter).toHaveBeenCalledTimes(2);
      },
      { interval: 5 }
    );

    // The replacement hasn't converged (never calls onRunEnd) and its cached
    // state is 'pending' (reset by start()) — polling again right after the
    // restart must not treat that as a second wedge and restart again before
    // the replacement gets a fair chance to settle. Comfortably inside the
    // 300ms grace period even accounting for the polling delay above (and
    // 'pending' is exempt from the check regardless — see
    // restartWatchModeSignalsIfWedged).
    watcher.getStatus();
    await new Promise((r) => setTimeout(r, 50));
    expect(vitestStarter).toHaveBeenCalledTimes(2);
  });

  it('does not repeatedly restart a slow-to-converge replacement even once its own grace period has elapsed', async () => {
    // Regression test for the unbroken restart loop this whole mechanism
    // exists to prevent (see restartWatchModeSignalsIfWedged's doc comment):
    // with staleWatcherGraceMs effectively zero, a restarted signal whose
    // replacement hasn't converged yet must still not be treated as wedged
    // again — it's 'pending', not a stale settled result, regardless of how
    // much time has passed since the restart.
    const { watchFs, fireChange } = triggerableWatchFs();
    let starterCalls = 0;
    const vitestStarter: VitestStarter = vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
      starterCalls += 1;
      if (starterCalls === 1) {
        onRunStart();
        onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      }
      // 2nd call onward (the restart) never converges — simulates a cold
      // restart still mid-startup well past its own grace period.
      return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
    });
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 0 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    fireChange('src/changed.ts');
    await vi.waitFor(() => {
      watcher.getStatus();
      expect(vitestStarter).toHaveBeenCalledTimes(2);
    });

    // Grace period is 0ms, so every subsequent poll is well past it — before
    // the fix (state not reset on start()), each of these would see the old
    // stale 'pass' and restart again.
    for (let i = 0; i < 5; i++) {
      watcher.getStatus();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(vitestStarter).toHaveBeenCalledTimes(2);
  });

  it('does not restart immediately when a new test file appears — it waits to see if Vitest picks it up on its own', async () => {
    const vitestStarter = fakeVitestStarter();
    const { watchFs, fireRename } = triggerableWatchFs();
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 10 * 60 * 1000, testFileArrivalVerifyMs: 10 * 60 * 1000 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    fireRename('src/new-thing.spec.ts');
    watcher.getStatus();
    await new Promise((r) => setTimeout(r, 20));

    // Still within the (huge) verify window and no completed run has
    // happened since the file arrived — must not have restarted yet.
    expect(vitestStarter).toHaveBeenCalledTimes(1);
  });

  it('skips the restart when a completed run after the arrival actually included the new file', async () => {
    const { watchFs, fireRename } = triggerableWatchFs();
    const vitestStarter = vi.fn<VitestStarter>(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
      onRunStart();
      onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
    });
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 10 * 60 * 1000, testFileArrivalVerifyMs: 10 * 60 * 1000 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);
    const onRunEnd = vitestStarter.mock.calls[0][3];

    fireRename('/wing/work/local/src/new-thing.spec.ts');
    // A real elapsed gap (not just event ordering) so the run's completion
    // timestamp is strictly after the arrival's — the check requires
    // "strictly newer", and two synchronous Date.now() calls back to back
    // can otherwise land in the same millisecond.
    await new Promise((r) => setTimeout(r, 5));
    // Vitest's own watch mode notices on its own and reruns, this time
    // including the new file — simulate that completed cycle directly via
    // the same onRunEnd callback the runner is already subscribed to,
    // rather than a second starter() call (a real incremental rerun never
    // calls start() again).
    onRunEnd({ failures: [], warnings: [], moduleIds: ['/wing/work/local/src/new-thing.spec.ts'] });

    watcher.getStatus();
    await new Promise((r) => setTimeout(r, 20));

    // Verified included — no restart needed, even well within the (huge) verify window.
    expect(vitestStarter).toHaveBeenCalledTimes(1);
  });

  it('forces a restart as soon as a completed run after the arrival demonstrably missed the new file', async () => {
    const { watchFs, fireRename } = triggerableWatchFs();
    const vitestStarter = vi.fn<VitestStarter>(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
      onRunStart();
      onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
    });
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      // Huge verify window — the point of this test is that a *confirmed
      // miss* restarts immediately, without waiting the window out.
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 10 * 60 * 1000, testFileArrivalVerifyMs: 10 * 60 * 1000 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);
    const onRunEnd = vitestStarter.mock.calls[0][3];

    fireRename('/wing/work/local/src/new-thing.spec.ts');
    await new Promise((r) => setTimeout(r, 5));
    // A real run cycle completes after the arrival, but its module list
    // still doesn't include the new file — Vitest's own watch mode missed it.
    onRunEnd({ failures: [], warnings: [], moduleIds: ['/wing/work/local/src/unrelated.ts'] });

    await vi.waitFor(() => {
      watcher.getStatus();
      expect(vitestStarter).toHaveBeenCalledTimes(2);
    });
  });

  it('forces a restart once the verify window elapses with no completed run at all since the arrival', async () => {
    const { watchFs, fireRename } = triggerableWatchFs();
    let starterCalls = 0;
    const vitestStarter: VitestStarter = vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
      starterCalls += 1;
      if (starterCalls === 1) {
        onRunStart();
        onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      }
      // 2nd call onward (the restart) never settles — irrelevant to this test.
      return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
    });
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 10 * 60 * 1000, testFileArrivalVerifyMs: 15 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(starterCalls).toBe(1);

    fireRename('/wing/work/local/src/new-thing.spec.ts');
    await vi.waitFor(() => {
      watcher.getStatus();
      expect(starterCalls).toBe(2);
    });
  });

  it('does not restart the tests signal for an ordinary edit to an existing test file', async () => {
    const vitestStarter = fakeVitestStarter();
    const { watchFs, fireChange } = triggerableWatchFs();
    const watcher = new QualityWatcher(
      'my-wing',
      '/wing/work/local',
      new EventBus(),
      defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 10 * 60 * 1000 })
    );
    await watcher.start();
    await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    expect(vitestStarter).toHaveBeenCalledTimes(1);

    // 'change' (not 'rename') on a path that happens to match the test-file
    // naming pattern — an edit to a file Vitest already knows about, not a
    // new arrival — must not force a restart.
    fireChange('src/existing.spec.ts');
    watcher.getStatus();
    await new Promise((r) => setTimeout(r, 20));
    expect(vitestStarter).toHaveBeenCalledTimes(1);
  });

  describe('staleness-reporting guard (separate from, and additional to, the watch-mode restart mechanism above)', () => {
    it('reports a genuinely wedged (never-settling) custom-lint signal as stale, report-only — same as the watch-mode case, and recovers once the real underlying run finally completes', async () => {
      // FileTriggeredSignalRunner used to have its own extra defense against
      // one specific cause (a real git operation left mid-progress — see
      // that class's doc comment for why it no longer does); this guard's
      // job was always broader than that one cause. It's reproduced here
      // with a process that simply never resolves — checkStuckRunning
      // catches this the same way it already does for a watch-mode signal
      // (see the sibling describe block above), and is deliberately
      // report-only for this cause too (see checkStuckRunning's own doc
      // comment) — recovery here comes from the real underlying run finally
      // completing, not from any automatic restart.
      const { watchFs, fireChange } = triggerableWatchFs();
      const pendingResolveBox: { current: ((r: ProcessResult) => void) | null } = { current: null };
      let callCount = 0;
      const customLintProcess: ProcessRunner = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve<ProcessResult>({ exitCode: 0, output: '' });
        return new Promise<ProcessResult>((resolve) => { pendingResolveBox.current = resolve; });
      });
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        // staleWatcherGraceMs deliberately left large (the default): this
        // test isolates checkStuckRunning's own cause from checkStaleness's
        // separate frozen-result cause, which a small staleWatcherGraceMs
        // would otherwise also trigger here (the initial pass result would
        // itself look "frozen" the instant the file change fires, launching
        // its own competing recovery attempt via attemptFileTriggeredRecovery).
        defaultOptions({ customLintProcess, watchFs, stuckRunningGraceMs: 20 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('pass'));
      expect(customLintProcess).toHaveBeenCalledTimes(1);

      fireChange('src/changed.ts');

      await vi.waitFor(() => {
        expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('stale');
      });
      const staleState = watcher.getStatus()[SignalType.CustomLint];
      expect(staleState.state).toBe('stale');
      if (staleState.state === 'stale') {
        expect(staleState.message).toContain('running/pending');
        expect(staleState.message).toContain('no automatic restart is attempted');
        expect(staleState.staleSince).toBeInstanceOf(Date);
      }
      // Report-only, same as the watch-mode case: no second attempt was
      // launched just because it was flagged stale.
      expect(customLintProcess).toHaveBeenCalledTimes(2);

      // The real underlying run finally completes on its own.
      pendingResolveBox.current?.({ exitCode: 0, output: '' });
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('pass'));
      expect(customLintProcess).toHaveBeenCalledTimes(2);
    });

    it('never leaks a prior fail\'s own failure detail into a stuck-running stale reading', async () => {
      const { watchFs, fireChange } = triggerableWatchFs();
      let shouldHang = false;
      let callCount = 0;
      const customLintProcess: ProcessRunner = vi.fn(async () => {
        // Never resolves — simulates a genuinely hung check.
        if (shouldHang) return new Promise<ProcessResult>(() => undefined);
        callCount += 1;
        return callCount === 1
          ? ({ exitCode: 1, output: 'a very specific real lint violation' } as ProcessResult)
          : ({ exitCode: 0, output: '' } as ProcessResult);
      });
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ customLintProcess, watchFs, staleWatcherGraceMs: 0, stuckRunningGraceMs: 20 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('fail'));

      shouldHang = true;
      fireChange('src/changed.ts');

      await vi.waitFor(() => {
        expect(watcher.getStatus()[SignalType.CustomLint].state).toBe('stale');
      });
      const staleState = watcher.getStatus()[SignalType.CustomLint];
      expect('failures' in staleState).toBe(false);
      expect(JSON.stringify(staleState)).not.toContain('a very specific real lint violation');
    });

    it('never silently keeps reporting a frozen "pass" for a wedged watch-mode signal either — reports "stale" or "running", never the stale "pass"', async () => {
      const vitestStarter = fakeVitestStarter();
      const { watchFs, fireChange } = triggerableWatchFs();
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vitestStarter, watchFs, staleWatcherGraceMs: 0 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));

      fireChange('src/changed.ts');
      // The very next read, whenever exactly the watch-mode restart's own
      // async stop()/start() has progressed to, must be one of "stale" (this
      // new layer caught it first) or "running" (the restart already reset
      // it) — it must never still be the old frozen "pass".
      const stateRightAfter = watcher.getStatus()[SignalType.Tests];
      expect(['stale', 'running']).toContain(stateRightAfter.state);
      if (stateRightAfter.state === 'stale') {
        expect(stateRightAfter.message).toContain('tests');
      }

      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
    });

    it('reports a watch-mode signal that never settles at all (stuck in pending/running since it started) as stale, without claiming a false automatic-recovery attempt', async () => {
      // Simulates a `vue-tsc --watch` subprocess that spawns but never
      // produces a single recognizable cycle — e.g. wedged on startup by
      // something outside this codebase's control (a client repo's own
      // broken tooling). checkStaleness's frozen-result guard is blind to
      // this: the signal never settles to pass/fail even once, so it can
      // never look "frozen since a settled result". Only checkStuckRunning
      // catches it.
      const stuckVueTscSpawn = vi.fn((_cwd: string): WatchedChildProcess => ({
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        kill: () => undefined,
      }));
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vueTscSpawn: stuckVueTscSpawn, stuckRunningGraceMs: 0 })
      );
      await watcher.start();

      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Types].state).toBe('stale'));
      const state = watcher.getStatus()[SignalType.Types];
      expect(state.state).toBe('stale');
      if (state.state === 'stale') {
        expect(state.message).toContain('running/pending');
        expect(state.message).toContain('no automatic restart is attempted');
      }
      // Confirms this is genuinely report-only: no restart was ever attempted.
      expect(stuckVueTscSpawn).toHaveBeenCalledTimes(1);
    });

    it('does not flag a watch-mode signal still within its stuck-running grace period, even though it has not settled yet', async () => {
      const stuckVueTscSpawn = vi.fn((_cwd: string): WatchedChildProcess => ({
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        kill: () => undefined,
      }));
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vueTscSpawn: stuckVueTscSpawn, stuckRunningGraceMs: 10 * 60 * 1000 })
      );
      await watcher.start();

      // toReportedState collapses 'pending' into 'running' for external
      // reporting (see QualityStatus.ts) — either is fine here; only 'stale'
      // would mean this test failed to prove the grace period is honored.
      const state = watcher.getStatus()[SignalType.Types];
      expect(['pending', 'running']).toContain(state.state);
    });
  });

  describe('performance-degradation advice (report-time warning before a signal crosses a staleness threshold)', () => {
    it('warns once a watch-mode signal has been running/pending for over half of stuckRunningGraceMs, without yet being marked stale', async () => {
      const stuckVueTscSpawn = vi.fn((_cwd: string): WatchedChildProcess => ({
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        kill: () => undefined,
      }));
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vueTscSpawn: stuckVueTscSpawn, stuckRunningGraceMs: 2000 })
      );
      await watcher.start();

      // Wide margin above the 1000ms (50%) threshold and below the 2000ms
      // (100%) one, so this stays reliable under real-world scheduling
      // jitter rather than just on an idle machine.
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const midState = watcher.getStatus()[SignalType.Types];
      expect(['pending', 'running']).toContain(midState.state);
      expect(midState.warnings?.some((w) => w.includes('Performance looks degraded'))).toBe(true);

      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Types].state).toBe('stale'), { timeout: 3000 });
    }, 10_000);

    it('does not warn while a watch-mode signal is comfortably within stuckRunningGraceMs', async () => {
      const stuckVueTscSpawn = vi.fn((_cwd: string): WatchedChildProcess => ({
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        kill: () => undefined,
      }));
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vueTscSpawn: stuckVueTscSpawn, stuckRunningGraceMs: 10 * 60 * 1000 })
      );
      await watcher.start();

      const state = watcher.getStatus()[SignalType.Types];
      expect(state.warnings ?? []).toHaveLength(0);
    });

    it('warns once a settled watch-mode signal has gone over half of staleWatcherGraceMs without a fresh result since the last change, without yet being marked stale', async () => {
      // fakeVueTscSpawn only ever emits one cycle at spawn time, so once
      // Types settles to 'pass' it stays frozen there on its own — no
      // dirty/invalidate mechanic to fight, unlike a file-triggered signal
      // (see FileTriggeredSignalRunner.invalidate) — which is exactly what
      // lets this test observe the pre-threshold advice window cleanly
      // before restartWatchModeSignalsIfWedged/checkStaleness's own full
      // staleWatcherGraceMs threshold trips it.
      const vueTscSpawn = fakeVueTscSpawn();
      const { watchFs, fireChange } = triggerableWatchFs();
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vueTscSpawn, watchFs, staleWatcherGraceMs: 2000 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Types].state).toBe('pass'));

      fireChange('src/changed.ts');

      // Wide margin above the 1000ms (50%) threshold and below the 2000ms
      // (100%) one, so this stays reliable under real-world scheduling
      // jitter rather than just on an idle machine.
      await new Promise((resolve) => setTimeout(resolve, 1400));
      // getStatus's default (treatWarningsAsWarnings: false) is strict —
      // ANY warning on an otherwise-passing signal reports as 'fail' (see
      // QualityStatus.applyWarningPolicy), same as this advice would for any
      // other warning-carrying signal. Read with treatWarningsAsWarnings:
      // true here to see the raw pass-with-advisory-warning underneath.
      const midState = watcher.getStatus(true)[SignalType.Types];
      expect(midState.state).toBe('pass');
      expect(midState.warnings?.some((w) => w.includes('Performance looks degraded'))).toBe(true);
      // Under the default strict policy, this same warning surfaces as a
      // real 'fail' right away — not silently absorbed as a passive notice.
      expect(watcher.getStatus()[SignalType.Types].state).toBe('fail');
    }, 10_000);
  });

  describe('signal subsetting (QualityWatcherOptions.signals)', () => {
    it('with an empty active set, every signal reports pass immediately and no real tooling is ever invoked', async () => {
      const vitestStarter = fakeVitestStarter(['should never run']);
      const viteBuildStarter = fakeViteBuildStarter(['should never run']);
      const vueTscSpawn = fakeVueTscSpawn(1);
      const oxlintProcess = vi.fn(watchProcessFor({ oxlint: { exitCode: 1, output: 'should never run' } }));
      const customLintProcess = vi.fn(watchProcessFor({ 'custom-lint': { exitCode: 1, output: 'should never run' } }));

      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vitestStarter, viteBuildStarter, vueTscSpawn, oxlintProcess, customLintProcess, signals: [] })
      );
      await watcher.start();

      const status = watcher.getStatus();
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');

      expect(vitestStarter).not.toHaveBeenCalled();
      expect(viteBuildStarter).not.toHaveBeenCalled();
      expect(vueTscSpawn).not.toHaveBeenCalled();
      expect(oxlintProcess).not.toHaveBeenCalled();
      expect(customLintProcess).not.toHaveBeenCalled();
    });

    it('runs real tooling only for signals in the active set, stubbing every other one to pass', async () => {
      const vitestStarter = fakeVitestStarter(['a real test failure']);
      const viteBuildStarter = fakeViteBuildStarter(['should never run']);

      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vitestStarter, viteBuildStarter, signals: [SignalType.Tests] })
      );
      await watcher.start();

      const status = await watcher.awaitStatus();
      expect(status[SignalType.Tests].state).toBe('fail');
      expect(status[SignalType.Build].state).toBe('pass');
      expect(viteBuildStarter).not.toHaveBeenCalled();
    });

    it('with no signals option at all, behaves exactly as before (every signal active)', async () => {
      const watcher = new QualityWatcher('my-wing', '/wing/work/local', new EventBus(), defaultOptions());
      await watcher.start();

      const status = await watcher.awaitStatus();
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');
    });
  });

  describe('pausing watch-mode signals around a git operation', () => {
    /** Controllable fake for checkGitOperationStatus: resolves whatever `status` currently points to on every poll. */
    function controllableGitStatus(initial: { inProgress: boolean; stable: boolean }) {
      let status = initial;
      const check = vi.fn(async () => status);
      return { check, set: (next: { inProgress: boolean; stable: boolean }) => { status = next; } };
    }

    it('pauses/resumes tests via its own cheap pause()/resume() (not a full restart), and stops+restarts types/build, while a git operation is actively churning', async () => {
      // Vitest is the one signal with a genuinely cheaper pause/resume than
      // stop()/start() (see VitestSignalRunner's own doc comment) — this
      // poll now calls pause()/resume() uniformly on every signal (see its
      // own doc comment), so Vitest benefits from that cheap path instead of
      // paying for a full cold restart on every git operation the way it
      // used to. vue-tsc/Vite build have no such distinction (their
      // pause()/resume() ARE stop()/start()), so they still show up as a
      // fresh spawn/starter call.
      const vitestStarter = fakeVitestStarter();
      const viteBuildStarter = fakeViteBuildStarter();
      const vueTscSpawn = fakeVueTscSpawn();
      const { check, set } = controllableGitStatus({ inProgress: false, stable: true });
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vitestStarter, viteBuildStarter, vueTscSpawn, checkGitOperationStatus: check, gitOperationPollMs: 5 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
      expect(vitestStarter).toHaveBeenCalledTimes(1);
      expect(viteBuildStarter).toHaveBeenCalledTimes(1);
      expect(vueTscSpawn).toHaveBeenCalledTimes(1);

      set({ inProgress: true, stable: false });
      await vi.waitFor(() => expect(vitestStarter.pauseCalls()).toBe(1));
      // Give a couple more poll ticks a chance to run — must not pause again
      // just because it's still actively in progress on every subsequent
      // poll (only the pause transition itself should fire, once), and must
      // not spawn fresh vue-tsc/Vite-build instances either.
      await new Promise((r) => setTimeout(r, 30));
      expect(vitestStarter.pauseCalls()).toBe(1);
      expect(vitestStarter).toHaveBeenCalledTimes(1);
      expect(viteBuildStarter).toHaveBeenCalledTimes(1);
      expect(vueTscSpawn).toHaveBeenCalledTimes(1);

      set({ inProgress: false, stable: true });
      await vi.waitFor(() => expect(vitestStarter.resumeCalls()).toBe(1));
      // Vitest reused its existing instance — no second starter call.
      expect(vitestStarter).toHaveBeenCalledTimes(1);
      expect(viteBuildStarter).toHaveBeenCalledTimes(2);
      expect(vueTscSpawn).toHaveBeenCalledTimes(2);
    });

    it('resumes as soon as the operation goes stable (a real conflict halt), even though it is still "in progress" — never per-commit', async () => {
      // Regression test for the exact flapping this must never do: a
      // multi-commit rebase can have many ordinary inter-commit gaps before
      // (or instead of) a real halt — this must not resume/pause on any of
      // those, only on a genuine stable halt or a full clear.
      const vitestStarter = fakeVitestStarter();
      const { check, set } = controllableGitStatus({ inProgress: false, stable: true });
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ vitestStarter, checkGitOperationStatus: check, gitOperationPollMs: 5 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.Tests].state).toBe('pass'));
      expect(vitestStarter.pauseCalls()).toBe(0);

      // Actively churning through several commits — still in progress,
      // still not stable, across several poll ticks.
      set({ inProgress: true, stable: false });
      await new Promise((r) => setTimeout(r, 25));
      expect(vitestStarter.pauseCalls()).toBe(1);

      // Halts for a real conflict: still in progress, but now stable.
      set({ inProgress: true, stable: true });
      await vi.waitFor(() => expect(vitestStarter.resumeCalls()).toBe(1));

      // Agent resolves it and continues, which churns through the rest —
      // must pause again exactly once, not per remaining commit.
      set({ inProgress: true, stable: false });
      await new Promise((r) => setTimeout(r, 25));
      expect(vitestStarter.pauseCalls()).toBe(2);

      set({ inProgress: false, stable: true });
      await vi.waitFor(() => expect(vitestStarter.resumeCalls()).toBe(2));
    });

    it('pauses and resumes oxlint/custom-lint via the same pause()/resume() mechanism as the watch-mode signals', async () => {
      // FileTriggeredSignalRunner used to defer its own on-demand runs
      // during a git operation via an internal isGitOperationInProgress
      // check; it no longer does (see that class's own doc comment) — it
      // now relies entirely on an external pause()/resume(), same as every
      // other signal, so this poll is what protects it.
      const oxlintProcess = vi.fn(watchProcessFor({}));
      const { check, set } = controllableGitStatus({ inProgress: false, stable: true });
      const watcher = new QualityWatcher(
        'my-wing',
        '/wing/work/local',
        new EventBus(),
        defaultOptions({ oxlintProcess, checkGitOperationStatus: check, gitOperationPollMs: 5 })
      );
      await watcher.start();
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.OxLint].state).toBe('pass'));
      expect(oxlintProcess).toHaveBeenCalledTimes(1);

      set({ inProgress: true, stable: false });
      await vi.waitFor(() => expect(check).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));

      // Paused: no new run launched while the operation is actively churning.
      expect(oxlintProcess).toHaveBeenCalledTimes(1);
      expect(watcher.getStatus()[SignalType.OxLint].state).toBe('pass');

      set({ inProgress: false, stable: true });

      // resume() itself forces a fresh run — no separate status read needed
      // to trigger it, same as the watch-mode signals restarting on their own.
      await vi.waitFor(() => expect(oxlintProcess).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(watcher.getStatus()[SignalType.OxLint].state).toBe('pass'));
    });
  });
});
