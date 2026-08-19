import { defaultOnError, type ErrorHandler } from './runDetached.js';

export interface SchedulePeriodicOptions {
  /** Upper bound (ms) of random jitter added to each interval, so repos sharing a schedule don't all fire in the same instant. */
  jitterMs?: number;
  onError?: ErrorHandler;
}

export interface PeriodicHandle {
  stop(): void;
}

/**
 * Ticks `fn` every `intervalMs` (plus jitter). If the previous tick's `fn` is
 * still running when the next tick would fire, that tick is skipped (not
 * queued) — a slow or hung run just produces a few no-op ticks instead of a
 * pile of overlapping calls. Each tick's error is isolated: it's reported to
 * `onError` and does not stop the schedule.
 */
export function schedulePeriodic(
  fn: () => void | Promise<void>,
  intervalMs: number,
  options: SchedulePeriodicOptions = {}
): PeriodicHandle {
  const { jitterMs = 0, onError = defaultOnError } = options;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const nextDelay = () => intervalMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, nextDelay());
  };

  const tick = () => {
    if (stopped) return;
    if (running) {
      scheduleNext();
      return;
    }
    running = true;
    Promise.resolve()
      .then(fn)
      .catch(onError)
      .finally(() => {
        running = false;
        scheduleNext();
      });
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
