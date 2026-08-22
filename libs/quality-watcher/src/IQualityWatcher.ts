/**
 * Quality Watcher Interface
 *
 * Defines the contract for a quality watcher instance that monitors
 * quality signals (tests, types, lint, build) for a wing.
 */

import type { QualityStatus } from './QualityStatus.js';

/**
 * Quality watcher interface
 *
 * A quality watcher continuously monitors quality signals for a wing and
 * maintains cached state that can be retrieved synchronously.
 *
 * The watcher runs quality checks in the background and updates its internal
 * state as signals complete. The getStatus() method returns the current cached
 * state immediately without waiting for signals to complete.
 *
 * Lifecycle:
 * 1. Create watcher instance (not yet running)
 * 2. Call start() to begin monitoring
 * 3. Call getStatus() to retrieve current cached state at any time
 * 4. Call stop() to halt monitoring and clean up
 *
 * @example
 * ```typescript
 * const watcher = createQualityWatcher({ wingName: 'my-wing' });
 * await watcher.start();
 * const status = watcher.getStatus(); // Returns immediately with cached state
 * await watcher.stop();
 * ```
 */
export interface IQualityWatcher {
  /**
   * Name of the wing this watcher monitors
   */
  readonly wingName: string;

  /**
   * Start the quality watcher
   *
   * Initiates background monitoring of quality signals. May throw if the
   * watcher cannot start (e.g., invalid wing configuration, missing tools).
   *
   * @throws Error if watcher cannot start
   */
  start(): Promise<void>;

  /**
   * Stop the quality watcher
   *
   * Halts background monitoring and cleans up resources. Any running signal
   * checks are cancelled. After stopping, the watcher can be restarted by
   * calling start() again.
   */
  stop(): Promise<void>;

  /**
   * Get the current quality status
   *
   * Returns the current cached state immediately without waiting for signals
   * to complete. This is a synchronous operation that reflects the most
   * recent known state of all quality signals.
   *
   * The returned status may indicate partial results (isPartial: true) if
   * some signals are still running. Call this method repeatedly to get
   * updated state as signals complete.
   *
   * For signals with no watch mode of their own (oxlint, custom-lint), this
   * call is also what launches a fresh check if a file change since the
   * last run invalidated the cached result — the check itself still runs
   * in the background, so this returns immediately with whatever's cached
   * (likely 'pending' the moment the check was launched).
   *
   * @param treatWarningsAsWarnings - When true, a signal carrying warnings
   * keeps its own pass/fail state and warnings are reported separately,
   * non-blocking. Default false: any signal with warnings reports as
   * `fail` even if the underlying check passed, so warnings can't quietly
   * accumulate unaddressed (see QualityStatus's `applyWarningPolicy`).
   * @returns Current quality status from cached state
   */
  getStatus(treatWarningsAsWarnings?: boolean): QualityStatus;

  /**
   * Check if the watcher is currently running
   *
   * Returns true if the watcher has been started and is actively monitoring,
   * false if it has not been started or has been stopped.
   *
   * @returns Whether the watcher is running
   */
  isRunning(): boolean;

  /**
   * Get the current quality status, briefly waiting for signals still running
   *
   * Unlike getStatus(), this does not return purely-cached state instantly.
   * For any signal that is currently 'running', it waits up to `maxWaitMs`
   * for that signal to settle (pass/fail) or to report its first failure —
   * whichever comes first — then returns whatever is known at that point.
   * A signal that never settles or fails within the window is returned as
   * 'running' (with whatever failures had accumulated, possibly none).
   *
   * Intended for request/response callers (e.g. an MCP tool call). Signals
   * with no watch mode of their own (oxlint, custom-lint) are launched here
   * too if their cached result was invalidated since the last run (see
   * getStatus), so this waits for those the same way it waits for a
   * continuously-running signal that just happens to be mid-check.
   *
   * @param maxWaitMs - Maximum time to wait per running signal (default: 5000)
   * @param treatWarningsAsWarnings - See `getStatus`. Default false (strict).
   * @returns Quality status reflecting the latest known state
   */
  awaitStatus(maxWaitMs?: number, treatWarningsAsWarnings?: boolean): Promise<QualityStatus>;

  /**
   * Suspend monitoring without tearing down state, for a caller that knows a
   * burst of irrelevant churn is coming (e.g. cabinet pausing around a
   * `movement start`/`merge`/`promote` git operation). Not part of every
   * watcher's contract: only meaningful for a watcher whose real state lives
   * in another process it can ask to pause — an in-process watcher already
   * has its own autonomous git-operation pause and has nothing to gain from
   * this. Callers detect support structurally (`typeof watcher.pause ===
   * 'function'`), not by importing any concrete watcher class — that
   * structural check is the only thing that distinguishes "this watcher
   * supports pause/resume" from "this watcher doesn't," so implementers that
   * support it must supply both `pause` and `resume` together.
   */
  pause?(): Promise<void>;

  /** The `resume()` counterpart to `pause()` — see its doc comment. */
  resume?(): Promise<void>;
}
