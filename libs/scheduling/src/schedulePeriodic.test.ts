import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { schedulePeriodic } from './schedulePeriodic.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('schedulePeriodic', () => {
  it('does not tick synchronously', () => {
    const fn = vi.fn();
    schedulePeriodic(fn, 100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ticks roughly every intervalMs', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    schedulePeriodic(fn, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('skips a tick (does not queue it) if the previous tick is still running', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await first;
    });

    schedulePeriodic(fn, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);

    // Two more intervals elapse while the first call is still in-flight —
    // both should be skipped, not queued up to fire the instant it finishes.
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    // Once the first call finishes, the schedule resumes on its own cadence.
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
  });

  it('reports a tick error to onError and keeps the schedule alive', async () => {
    const onError = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('tick boom');
    });

    schedulePeriodic(fn, 100, { onError });
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
  });

  it('stop() prevents any further ticks', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const handle = schedulePeriodic(fn, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('adds jitter within [0, jitterMs) on top of intervalMs', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    schedulePeriodic(fn, 100, { jitterMs: 20 });

    await vi.advanceTimersByTimeAsync(109);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });
});
