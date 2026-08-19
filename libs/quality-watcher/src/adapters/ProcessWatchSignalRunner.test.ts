/**
 * Tests for ProcessWatchSignalRunner: a watch-mode ISignalRunner backed by a
 * long-lived subprocess (spawned once, not per file change) whose stdout is
 * parsed for cycle boundaries by an injected parser.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { ProcessWatchSignalRunner, type WatchedChildProcess, type WatchOutputParser } from './ProcessWatchSignalRunner.js';
import { SignalType } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';

/** Fake child process: records chunk listeners so tests can push output and simulate kill(). */
function fakeChildProcess() {
  let stdoutListener: ((chunk: string) => void) | null = null;
  const killed = { value: false };
  const child: WatchedChildProcess = {
    stdout: { on: (_event, listener) => { stdoutListener = listener; } },
    stderr: { on: () => undefined },
    kill: () => { killed.value = true; },
  };
  return {
    child,
    emit: (chunk: string) => stdoutListener?.(chunk),
    isKilled: () => killed.value,
  };
}

/** Parses "---CYCLE:pass---" / "---CYCLE:fail:<msg>---" markers, consuming up through the marker. */
const testParser: WatchOutputParser = (buffer) => {
  const passIdx = buffer.indexOf('---CYCLE:pass---');
  const failMatch = buffer.match(/---CYCLE:fail:(.*?)---/);
  const failIdx = failMatch?.index ?? -1;

  // Whichever marker appears first in the buffer is the next cycle to
  // report — a chunk can contain more than one complete cycle.
  if (failIdx !== -1 && (passIdx === -1 || failIdx < passIdx)) {
    return {
      consumedThrough: failIdx + (failMatch?.[0].length ?? 0),
      state: { state: 'fail', timestamp: new Date(), failures: [failMatch?.[1] ?? ''] },
    };
  }
  if (passIdx !== -1) {
    return { consumedThrough: passIdx + '---CYCLE:pass---'.length, state: { state: 'pass', timestamp: new Date() } };
  }
  return null;
};

describe('ProcessWatchSignalRunner', () => {
  it('starts pending and spawns the process on start()', async () => {
    const eventBus = new EventBus();
    const { child } = fakeChildProcess();
    const spawnProcess = vi.fn(() => child);
    const runner = new ProcessWatchSignalRunner(SignalType.Types, spawnProcess, testParser, eventBus);

    expect(runner.getState().state).toBe('pending');
    await runner.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(runner.getState().state).toBe('pending');
  });

  it('transitions to pass when a pass cycle marker appears in stdout', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();

    emit('Starting compilation...\n---CYCLE:pass---\n');

    expect(runner.getState().state).toBe('pass');
  });

  it('transitions to fail with the parsed failure message', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();

    emit('---CYCLE:fail:3 errors found---\n');

    const state = runner.getState();
    expect(state.state).toBe('fail');
    if (state.state === 'fail') {
      expect(state.failures).toEqual(['3 errors found']);
    }
  });

  it('handles multiple cycles arriving across separate chunks', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();

    emit('---CYCLE:fail:first error---\n');
    expect(runner.getState().state).toBe('fail');

    emit('---CYCLE:pass---\n');
    expect(runner.getState().state).toBe('pass');
  });

  it('parses two cycles present in a single chunk without losing either', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(e.state.state));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();

    emit('---CYCLE:fail:first---\n---CYCLE:pass---\n');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(['fail', 'pass']);
    expect(runner.getState().state).toBe('pass');
  });

  it('kills the subprocess on stop', async () => {
    const eventBus = new EventBus();
    const { child, isKilled } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();

    await runner.stop();

    expect(isKilled()).toBe(true);
  });

  it('kills the whole process group by pid on stop, on POSIX', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const eventBus = new EventBus();
      const { child, isKilled } = fakeChildProcess();
      child.pid = 4242;
      const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
      await runner.start();

      await runner.stop();

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      // The group kill succeeded — no need to fall back to killing just the one pid.
      expect(isKilled()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      killSpy.mockRestore();
    }
  });

  it('falls back to plain kill() when the pid-based group kill throws, on POSIX', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    try {
      const eventBus = new EventBus();
      const { child, isKilled } = fakeChildProcess();
      child.pid = 4242;
      const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
      await runner.start();

      await runner.stop();

      expect(isKilled()).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      killSpy.mockRestore();
    }
  });

  it('does not spawn a second process if start() is called again while already running', async () => {
    const eventBus = new EventBus();
    const spawnProcess = vi.fn(() => fakeChildProcess().child);
    const runner = new ProcessWatchSignalRunner(SignalType.Types, spawnProcess, testParser, eventBus);

    await runner.start();
    await runner.start();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('pause() kills the subprocess (same as stop()) and resume() spawns a fresh one', async () => {
    const eventBus = new EventBus();
    const first = fakeChildProcess();
    const second = fakeChildProcess();
    let spawnCount = 0;
    const spawnProcess = vi.fn(() => {
      spawnCount += 1;
      return spawnCount === 1 ? first.child : second.child;
    });
    const runner = new ProcessWatchSignalRunner(SignalType.Types, spawnProcess, testParser, eventBus);
    await runner.start();

    await runner.pause();
    expect(first.isKilled()).toBe(true);

    await runner.resume();
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    second.emit('---CYCLE:pass---\n');
    expect(runner.getState().state).toBe('pass');
  });

  it('getState() reports pending between pause() and resume() reporting a fresh result', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();
    emit('---CYCLE:pass---\n');
    expect(runner.getState().state).toBe('pass');

    await runner.pause();
    await runner.resume();

    expect(runner.getState().state).toBe('pending');
  });

  it('lastActivityAt() is null before start(), then advances on every stdout/stderr chunk received, even with no complete cycle yet', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);

    expect(runner.lastActivityAt()).toBeNull();

    await runner.start();
    emit('Starting compilation...\n');
    const first = runner.lastActivityAt();
    expect(first).not.toBeNull();

    emit('still checking...\n');
    const second = runner.lastActivityAt();
    expect(second).not.toBeNull();
    expect((second as Date).getTime()).toBeGreaterThanOrEqual((first as Date).getTime());
  });

  it('lastActivityAt() re-seeds to a fresh timestamp (not null) on a restart via pause()/resume() — covers the new process\'s own warmup', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const second = fakeChildProcess();
    let spawnCount = 0;
    const spawnProcess = vi.fn(() => {
      spawnCount += 1;
      return spawnCount === 1 ? child : second.child;
    });
    const runner = new ProcessWatchSignalRunner(SignalType.Types, spawnProcess, testParser, eventBus);
    await runner.start();
    emit('Starting compilation...\n');
    const beforeRestart = runner.lastActivityAt();
    expect(beforeRestart).not.toBeNull();

    await runner.pause();
    await runner.resume();

    const afterRestart = runner.lastActivityAt();
    expect(afterRestart).not.toBeNull();
    expect((afterRestart as Date).getTime()).toBeGreaterThanOrEqual((beforeRestart as Date).getTime());
  });

  it('emits started/state-changed/stopped events', async () => {
    const eventBus = new EventBus();
    const { child, emit } = fakeChildProcess();
    const events: string[] = [];
    eventBus.on(SignalRunnerEvents.Started, () => events.push('started'));
    eventBus.on(SignalRunnerEvents.StateChanged, (e) => events.push(`state:${e.state.state}`));
    eventBus.on(SignalRunnerEvents.Stopped, () => events.push('stopped'));
    // EventBus.on() subscribes via a background fiber; give it a tick to
    // actually attach before anything emits.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runner = new ProcessWatchSignalRunner(SignalType.Types, () => child, testParser, eventBus);
    await runner.start();
    emit('---CYCLE:pass---\n');
    await runner.stop();

    expect(events).toEqual(['started', 'state:pass', 'stopped']);
  });
});
