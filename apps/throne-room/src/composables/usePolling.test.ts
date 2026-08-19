import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePolling } from './usePolling';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls callback at specified interval', async () => {
    const callback = vi.fn();
    const { start } = usePolling(callback, 1000);

    start();

    expect(callback).toHaveBeenCalledTimes(1); // Initial call

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('stops polling when stop called', () => {
    const callback = vi.fn();
    const { start, stop } = usePolling(callback, 1000);

    start();
    expect(callback).toHaveBeenCalledTimes(1);

    stop();

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1); // No additional calls
  });

  it('pauses polling when pause called', () => {
    const callback = vi.fn();
    const { start, pause } = usePolling(callback, 1000);

    start();
    expect(callback).toHaveBeenCalledTimes(1);

    pause();

    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1); // No additional calls
  });

  it('resumes polling after pause', () => {
    const callback = vi.fn();
    const { start, pause, resume } = usePolling(callback, 1000);

    start();
    pause();

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    resume();

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('provides isPolling reactive state', () => {
    const callback = vi.fn();
    const { start, stop, pause, resume, isPolling } = usePolling(callback, 1000);

    expect(isPolling.value).toBe(false);

    start();
    expect(isPolling.value).toBe(true);

    pause();
    expect(isPolling.value).toBe(false);

    resume();
    expect(isPolling.value).toBe(true);

    stop();
    expect(isPolling.value).toBe(false);
  });

  it('handles async callbacks', async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const { start } = usePolling(callback, 1000);

    start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
