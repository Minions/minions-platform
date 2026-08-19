import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { SignalWedgeMonitor, SignalWedgeEvents, isSettled } from './SignalWedgeMonitor.js';
import { SignalType, type SignalState } from '../SignalState.js';
import type { ISignalRunner } from '../ISignalRunner.js';

function fakeRunner(
  state: SignalState,
  opts: { withPauseResume?: boolean; lastActivityAt?: Date | null } = {}
): ISignalRunner & {
  startCalls: number;
  stopCalls: number;
  pauseCalls: number;
  resumeCalls: number;
  setLastActivityAt: (d: Date | null) => void;
} {
  let activityAt: Date | null = opts.lastActivityAt ?? null;
  const runner = {
    signalType: SignalType.Tests,
    strategy: 'watch-mode' as const,
    startCalls: 0,
    stopCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    start: async () => { runner.startCalls += 1; },
    stop: async () => { runner.stopCalls += 1; },
    getState: () => state,
    setLastActivityAt: (d: Date | null) => { activityAt = d; },
  } as ISignalRunner & { startCalls: number; stopCalls: number; pauseCalls: number; resumeCalls: number; setLastActivityAt: (d: Date | null) => void };
  if (opts.withPauseResume) {
    runner.pause = async () => { runner.pauseCalls += 1; };
    runner.resume = async () => { runner.resumeCalls += 1; };
  }
  if ('lastActivityAt' in opts) {
    runner.lastActivityAt = () => activityAt;
  }
  return runner;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const minutesAfter = (mins: number) => new Date(T0.getTime() + mins * 60_000);
const secondsAfter = (secs: number) => new Date(T0.getTime() + secs * 1000);

describe('isSettled', () => {
  it('is true immediately for a pass/fail result — an explicit run-completion signal, no debounce needed', () => {
    expect(isSettled(fakeRunner({ state: 'pass', timestamp: T0 }), { state: 'pass', timestamp: T0 }, T0)).toBe(true);
    expect(isSettled(fakeRunner({ state: 'fail', timestamp: T0, failures: [] }), { state: 'fail', timestamp: T0, failures: [] }, T0)).toBe(true);
  });

  it('is false for a running signal with activity inside the settle window', () => {
    const state: SignalState = { state: 'running', timestamp: T0, failures: [] };
    const runner = fakeRunner(state, { lastActivityAt: secondsAfter(0.5) });
    expect(isSettled(runner, state, secondsAfter(1), 1000)).toBe(false);
  });

  it('is true for a running signal once its activity is older than the settle window', () => {
    const state: SignalState = { state: 'running', timestamp: T0, failures: [] };
    const runner = fakeRunner(state, { lastActivityAt: T0 });
    expect(isSettled(runner, state, secondsAfter(1.5), 1000)).toBe(true);
  });

  it('falls back to state.timestamp when the runner has no lastActivityAt support', () => {
    const state: SignalState = { state: 'pending', timestamp: T0 };
    const runner = fakeRunner(state);
    expect(isSettled(runner, state, secondsAfter(0.5), 1000)).toBe(false);
    expect(isSettled(runner, state, secondsAfter(1.5), 1000)).toBe(true);
  });
});

describe('SignalWedgeMonitor', () => {
  it('does nothing for a fresh settled result', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus);
    const runner = fakeRunner({ state: 'pass', timestamp: minutesAfter(1) }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(1.1));

    expect(monitor.isWedged(SignalType.Tests)).toBe(false);
    expect(runner.pauseCalls).toBe(0);
    expect(runner.stopCalls).toBe(0);
  });

  it('does nothing for a signal still running well within idlePatienceMs (no lastActivityAt support)', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 45_000 });
    const runner = fakeRunner({ state: 'running', timestamp: T0, failures: [] });

    await monitor.check(SignalType.Tests, runner, T0, secondsAfter(10));

    expect(monitor.isWedged(SignalType.Tests)).toBe(false);
  });

  it('flags a frozen settled result past staleGraceMs and attempts pause/resume first', async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.on(SignalWedgeEvents.Wedged, (e) => events.push(`wedged:${e.signalType}`));
    await new Promise((r) => setTimeout(r, 0));
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));

    expect(monitor.isWedged(SignalType.Tests)).toBe(true);
    expect(runner.pauseCalls).toBe(1);
    expect(runner.resumeCalls).toBe(1);
    expect(runner.stopCalls).toBe(0);
    expect(events).toEqual(['wedged:tests']);
  });

  it('flags a signal stuck running past idlePatienceMs with no activity ever observed (no lastActivityAt support)', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 45_000 });
    const runner = fakeRunner({ state: 'running', timestamp: T0, failures: [] }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, secondsAfter(46));

    expect(monitor.isWedged(SignalType.Tests)).toBe(true);
    expect(runner.pauseCalls).toBe(1);
  });

  describe('lastActivityAt-based detection (covers warmup and mid-run alike)', () => {
    it('does not flag a running signal whose activity keeps advancing, no matter how long the overall run takes', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 20_000 });
      const runner = fakeRunner({ state: 'running', timestamp: T0, failures: [] }, { lastActivityAt: secondsAfter(119) });

      // The run has been going for exactly 2 minutes — far past idlePatienceMs
      // — but activity was observed 1 second ago, well inside the settle window.
      await monitor.check(SignalType.Tests, runner, T0, minutesAfter(2));

      expect(monitor.isWedged(SignalType.Tests)).toBe(false);
    });

    it('flags a running signal once its activity goes silent for longer than idlePatienceMs', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 20_000 });
      const runner = fakeRunner({ state: 'running', timestamp: T0, failures: [] }, { lastActivityAt: secondsAfter(60) });

      // Activity was observed at t=60s; now it's t=81s — 21s of silence,
      // past idlePatienceMs, regardless of how long the run has been open overall.
      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(81));

      expect(monitor.isWedged(SignalType.Tests)).toBe(true);
    });

    it('detects a stall during warmup too — activity seeded at start()-time, before any real output, still ages out past idlePatienceMs', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 45_000 });
      // Simulates a runner that seeded lastActivityAt at start() (see
      // VitestSignalRunner/ProcessWatchSignalRunner/ViteBuildWatchSignalRunner's
      // own startedAt seeding) but has produced literally nothing since —
      // a hung spawn or a cold start that never got going.
      const runner = fakeRunner({ state: 'pending', timestamp: T0 }, { lastActivityAt: T0 });

      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(30));
      expect(monitor.isWedged(SignalType.Tests)).toBe(false);

      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(46));
      expect(monitor.isWedged(SignalType.Tests)).toBe(true);
    });

    it('recovers once activity resumes, even before the run settles to pass/fail', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 20_000 });
      const runner = fakeRunner({ state: 'running', timestamp: T0, failures: [] }, { lastActivityAt: T0 });

      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(21));
      expect(monitor.isWedged(SignalType.Tests)).toBe(true);

      runner.setLastActivityAt(secondsAfter(25));
      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(26));

      expect(monitor.isWedged(SignalType.Tests)).toBe(false);
    });
  });

  it('goes straight to stop()/start() when the runner has no pause()/resume()', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'fail', timestamp: T0, failures: ['boom'] });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));

    expect(runner.stopCalls).toBe(1);
    expect(runner.startCalls).toBe(1);
  });

  it('escalates to stop()/start() only after escalateAfterMs since the pause/resume attempt, while still wedged', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000, escalateAfterMs: 30_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    expect(runner.pauseCalls).toBe(1);
    expect(runner.stopCalls).toBe(0);

    // Still wedged (state unchanged), but only 10s after the first attempt — too soon to escalate.
    await monitor.check(SignalType.Tests, runner, T0, new Date(minutesAfter(6).getTime() + 10_000));
    expect(runner.stopCalls).toBe(0);

    // Now 31s after the first recovery attempt — escalates.
    await monitor.check(SignalType.Tests, runner, T0, new Date(minutesAfter(6).getTime() + 31_000));
    expect(runner.stopCalls).toBe(1);
    expect(runner.startCalls).toBe(1);
  });

  it('does not escalate a second time once already at the kill-recreate stage', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000, escalateAfterMs: 30_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    await monitor.check(SignalType.Tests, runner, T0, new Date(minutesAfter(6).getTime() + 31_000));
    expect(runner.stopCalls).toBe(1);

    await monitor.check(SignalType.Tests, runner, T0, new Date(minutesAfter(6).getTime() + 90_000));
    expect(runner.stopCalls).toBe(1);
    expect(runner.startCalls).toBe(1);
  });

  it('emits Recovered and clears wedged state once the runner produces a fresh result', async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.on(SignalWedgeEvents.Recovered, (e) => events.push(`recovered:${e.signalType}`));
    await new Promise((r) => setTimeout(r, 0));
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    expect(monitor.isWedged(SignalType.Tests)).toBe(true);

    // Recovery kicks in and produces a fresh result after the reference point.
    (runner as unknown as { getState: () => SignalState }).getState = () => ({ state: 'pass', timestamp: minutesAfter(6.5) });
    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(7));

    expect(monitor.isWedged(SignalType.Tests)).toBe(false);
    expect(events).toEqual(['recovered:tests']);
  });

  it('does not immediately re-flag a just-recovered signal against a stale referenceAt older than the recovery attempt', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    expect(monitor.isWedged(SignalType.Tests)).toBe(true);

    // referenceAt (T0) hasn't moved, but the recovery attempt just happened
    // at minutesAfter(6) — a re-check moments later must not treat this as
    // already 5 minutes stale again relative to the old referenceAt.
    await monitor.check(SignalType.Tests, runner, T0, new Date(minutesAfter(6).getTime() + 1000));

    expect(monitor.isWedged(SignalType.Tests)).toBe(true);
  });

  it('wedgedSignals() lists every currently wedged signal type', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    expect(monitor.wedgedSignals()).toEqual([]);
    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    expect(monitor.wedgedSignals()).toEqual([SignalType.Tests]);
  });

  it('wedgeInfo() reports wedgedSince while wedged, and undefined once recovered', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

    expect(monitor.wedgeInfo(SignalType.Tests)).toBeUndefined();

    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(6));
    expect(monitor.wedgeInfo(SignalType.Tests)).toEqual({ wedgedSince: minutesAfter(6) });

    (runner as unknown as { getState: () => SignalState }).getState = () => ({ state: 'pass', timestamp: minutesAfter(6.5) });
    await monitor.check(SignalType.Tests, runner, T0, minutesAfter(7));
    expect(monitor.wedgeInfo(SignalType.Tests)).toBeUndefined();
  });

  it('does not throw when a recovery attempt itself fails, and stays wedged', async () => {
    const eventBus = new EventBus();
    const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
    const runner = fakeRunner({ state: 'pass', timestamp: T0 });
    runner.stop = vi.fn(async () => { throw new Error('spawn failed'); });

    await expect(monitor.check(SignalType.Tests, runner, T0, minutesAfter(6))).resolves.toBeUndefined();
    expect(monitor.isWedged(SignalType.Tests)).toBe(true);
  });

  describe('check() per-call overrides', () => {
    it('a tighter staleGraceMs override flags wedged sooner than the constructor default', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

      // Nowhere near the constructor's 5-minute default...
      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(4));
      expect(monitor.isWedged(SignalType.Tests)).toBe(false);

      // ...but well past a 3s override.
      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(4), { staleGraceMs: 3_000 });
      expect(monitor.isWedged(SignalType.Tests)).toBe(true);
    });

    it('an override applies only to that one call — the next call without one falls back to the constructor default', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });

      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(1), { staleGraceMs: 3_000 });
      expect(monitor.isWedged(SignalType.Tests)).toBe(false);
    });
  });

  describe('trendingWarning', () => {
    it('returns undefined well within the threshold', () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 10_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 });

      expect(monitor.trendingWarning(SignalType.Tests, runner, { state: 'pass', timestamp: T0 }, T0, secondsAfter(1))).toBeUndefined();
    });

    it('warns once past half the threshold, without yet being wedged', () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 10_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 });
      const state: SignalState = { state: 'pass', timestamp: T0 };

      const warning = monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(6));

      expect(warning).toContain('tests');
      expect(warning).toContain('60%');
    });

    it('returns undefined once the full threshold is crossed — that is wedgeInfo()\'s job, not this', () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 10_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 });
      const state: SignalState = { state: 'pass', timestamp: T0 };

      expect(monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(11))).toBeUndefined();
    });

    it('returns undefined once a signal is already flagged wedged', async () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 }, { withPauseResume: true });
      await monitor.check(SignalType.Tests, runner, T0, secondsAfter(6));
      expect(monitor.isWedged(SignalType.Tests)).toBe(true);

      const state: SignalState = { state: 'pass', timestamp: T0 };
      expect(monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(6))).toBeUndefined();
    });

    it('respects a per-call override the same way check() does', () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { staleGraceMs: 5 * 60_000 });
      const runner = fakeRunner({ state: 'pass', timestamp: T0 });
      const state: SignalState = { state: 'pass', timestamp: T0 };

      expect(monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(2))).toBeUndefined();
      expect(monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(2), { staleGraceMs: 3_000 })).toContain('tests');
    });

    it('warns for a running signal trending toward idlePatienceMs, using lastActivityAt', () => {
      const eventBus = new EventBus();
      const monitor = new SignalWedgeMonitor(eventBus, { idlePatienceMs: 10_000, settleWindowMs: 1000 });
      const state: SignalState = { state: 'running', timestamp: T0, failures: [] };
      const runner = fakeRunner(state, { lastActivityAt: T0 });

      const warning = monitor.trendingWarning(SignalType.Tests, runner, state, T0, secondsAfter(6));

      expect(warning).toContain('running');
      expect(warning).toContain('60%');
    });
  });
});
