/**
 * Tests for WingQualityWatcher: composes one QualityWatcher per work repo
 * in a wing and unifies their results — needed for multi-work wings, where
 * each work/<name> is an independently checked-out repo.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { WingQualityWatcher } from './WingQualityWatcher.js';
import { SignalType } from '../SignalState.js';
import type { ProcessResult, ProcessRunner } from './runProcess.js';
import type { VitestStarter } from './VitestSignalRunner.js';
import type { ViteBuildStarter } from './ViteBuildWatchSignalRunner.js';
import type { WatchedChildProcess } from './ProcessWatchSignalRunner.js';

function fakeWatchFs(): typeof import('node:fs').watch {
  return ((_path: string, _opts: unknown, _listener: (...args: unknown[]) => void) => ({
    close: () => undefined,
  })) as unknown as typeof import('node:fs').watch;
}

function watchProcessFor(results: Partial<Record<string, ProcessResult>>): ProcessRunner {
  return (_cwd, target) => Promise.resolve(results[target] ?? { exitCode: 0, output: '' });
}

function fakeVitestStarter(failures: string[] = []): VitestStarter {
  return vi.fn(async (_cwd, _projectDirs, onRunStart, onRunEnd) => {
    onRunStart();
    onRunEnd({ failures, warnings: [], moduleIds: [] });
    return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
  });
}

function fakeViteBuildStarter(failures: string[] = []): ViteBuildStarter {
  return vi.fn(async (_cwd, onCycleStart, onCycleEnd) => {
    onCycleStart();
    onCycleEnd({ failures, warnings: [] });
    return { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };
  });
}

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

function defaultOptions(overrides: Record<string, unknown> = {}) {
  return {
    vitestStarter: fakeVitestStarter(),
    discoverVitestProjectDirs: async (cwd: string) => [cwd],
    viteBuildStarter: fakeViteBuildStarter(),
    vueTscSpawn: fakeVueTscSpawn(),
    oxlintProcess: watchProcessFor({}),
    customLintProcess: watchProcessFor({}),
    watchFs: fakeWatchFs(),
    debounceMs: 0,
    ...overrides,
  };
}

describe('WingQualityWatcher', () => {
  it('starts and stops every per-repo watcher', async () => {
    const watcher = new WingQualityWatcher(
      'my-wing',
      { local: '/wing/work/local', extra: '/wing/work/extra' },
      new EventBus(),
      defaultOptions()
    );

    expect(watcher.isRunning()).toBe(false);
    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it('reports pass only when every repo passes', async () => {
    const watcher = new WingQualityWatcher(
      'my-wing',
      { local: '/wing/work/local', extra: '/wing/work/extra' },
      new EventBus(),
      defaultOptions()
    );
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Tests].state).toBe('pass');
    expect(status[SignalType.Types].state).toBe('pass');
    expect(status[SignalType.Build].state).toBe('pass');
    expect(status[SignalType.OxLint].state).toBe('pass');
  });

  it('a single-repo wing behaves the same as one QualityWatcher', async () => {
    const watcher = new WingQualityWatcher(
      'my-wing',
      { local: '/wing/work/local' },
      new EventBus(),
      defaultOptions({ oxlintProcess: watchProcessFor({ oxlint: { exitCode: 1, output: 'lint error' } }) })
    );
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.OxLint].state).toBe('fail');
    if (status[SignalType.OxLint].state === 'fail') {
      expect(status[SignalType.OxLint].failures).toEqual(['[local] lint error']);
    }
  });

  it('throws if started while already running', async () => {
    const watcher = new WingQualityWatcher('my-wing', { local: '/wing/work/local' }, new EventBus(), defaultOptions());
    await watcher.start();

    await expect(watcher.start()).rejects.toThrow('already running');
  });

  it('build settles across all repos — it is a genuine watch source now, not on-demand-only', async () => {
    const watcher = new WingQualityWatcher(
      'my-wing',
      { local: '/wing/work/local', extra: '/wing/work/extra' },
      new EventBus(),
      defaultOptions()
    );
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(status[SignalType.Build].state).toBe('pass');
  });

  it('awaitStatus() launches the on-demand oxlint signal in every repo watcher on its own', async () => {
    // The same options object (and so the same oxlintProcess fake) is
    // shared across both repos' QualityWatcher instances — its call count
    // reflects runs from both, so a count of 2 shows it reached every repo
    // watcher, not just one.
    const oxlintProcess = vi.fn(watchProcessFor({}));
    const watcher = new WingQualityWatcher(
      'my-wing',
      { local: '/wing/work/local', extra: '/wing/work/extra' },
      new EventBus(),
      defaultOptions({ oxlintProcess })
    );
    await watcher.start();

    const status = await watcher.awaitStatus(1000);

    expect(oxlintProcess).toHaveBeenCalledTimes(2);
    expect(status[SignalType.OxLint].state).toBe('pass');
  });
});
