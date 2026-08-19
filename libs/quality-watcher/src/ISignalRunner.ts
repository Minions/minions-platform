/**
 * Signal Runner Interface
 *
 * Defines the port interface for running individual quality signals.
 * This is the hexagonal architecture port that all signal runner adapters
 * (watch mode, on-demand, file-triggered) will implement.
 */

import type { SignalState, SignalType } from './SignalState.js';

/**
 * Execution strategy for a signal runner
 *
 * Determines how the runner executes quality checks:
 * - watch-mode: Leverages native watch mode (jest --watch, tsc --watch)
 * - on-demand: Executes once per explicit request
 * - file-triggered: Watches for file changes and executes on change
 *
 * @example
 * ```typescript
 * const runner: ISignalRunner = createSignalRunner({
 *   signalType: SignalType.Tests,
 *   strategy: 'watch-mode',
 * });
 * ```
 */
export type ExecutionStrategy = 'watch-mode' | 'on-demand' | 'file-triggered';

/**
 * Signal runner event discriminated union
 *
 * @deprecated Use SignalRunnerEvents from SignalRunnerEvents.ts instead.
 * Events are now emitted via @minions/events EventBus.
 *
 * This type is kept for backward compatibility but will be removed in the future.
 */
export type SignalRunnerEvent =
  | {
      type: 'started';
    }
  | {
      type: 'stopped';
    }
  | {
      type: 'state-changed';
      state: SignalState;
    }
  | {
      type: 'error';
      error: Error;
    };

/**
 * Signal runner interface
 *
 * Port interface that all signal runner implementations must satisfy.
 * A signal runner is responsible for executing a single quality signal
 * (tests, types, lint, or build) using a specific execution strategy.
 *
 * The runner maintains an internal state cache and emits events via an
 * injected IEventBus when state changes occur. Orchestrators subscribe
 * to these events to coordinate multiple runners.
 *
 * Lifecycle:
 * 1. Create runner instance with injected EventBus (not yet running)
 * 2. Call start() to begin execution
 * 3. Receive events via EventBus subscriptions (SignalRunnerEvents)
 * 4. Call getState() to retrieve current cached state at any time
 * 5. Call stop() to halt execution and clean up
 *
 * @example
 * ```typescript
 * const eventBus = new EventBus();
 * const runner = createSignalRunner({
 *   signalType: SignalType.Tests,
 *   strategy: 'watch-mode',
 *   eventBus,
 * });
 *
 * // Subscribe to events
 * eventBus.on(SignalRunnerEvents.StateChanged, (event) => {
 *   if (event.signalType === SignalType.Tests) {
 *     orchestrator.handleStateChange(event.state);
 *   }
 * });
 *
 * await runner.start();
 * const currentState = runner.getState(); // Synchronous, cached state
 * await runner.stop();
 * ```
 */
export interface ISignalRunner {
  /**
   * Type of quality signal this runner executes
   *
   * Determines which quality check to run (tests, types, lint, or build).
   * This is immutable - a runner's signal type cannot change after creation.
   */
  readonly signalType: SignalType;

  /**
   * Execution strategy for this runner
   *
   * Determines how the runner executes quality checks (watch-mode, on-demand,
   * or file-triggered). This is immutable - a runner's strategy cannot change
   * after creation. Different strategies require different runner instances.
   */
  readonly strategy: ExecutionStrategy;

  /**
   * Start the signal runner
   *
   * Initiates execution based on the runner's strategy. For watch-mode runners,
   * this starts the watch process. For on-demand runners, this executes once.
   * For file-triggered runners, this sets up file watching.
   *
   * Emits SignalRunnerEvents.Started via the EventBus when execution begins.
   *
   * @throws Error if runner cannot start (e.g., missing tool, invalid config)
   */
  start(): Promise<void>;

  /**
   * Stop the signal runner
   *
   * Halts execution and cleans up resources. Any running quality checks are
   * cancelled. After stopping, the runner can be restarted by calling start()
   * again.
   *
   * Emits SignalRunnerEvents.Stopped via the EventBus when execution halts.
   */
  stop(): Promise<void>;

  /**
   * Get the current signal state
   *
   * Returns the current cached state immediately without waiting for the
   * signal to complete. This is a synchronous operation that reflects the
   * most recent known state.
   *
   * The state is updated internally as the runner executes, and
   * SignalRunnerEvents.StateChanged events are emitted via the EventBus
   * when updates occur.
   *
   * @returns Current signal state from cached state
   */
  getState(): SignalState;

  /**
   * Called whenever a caller reads status (QualityWatcher.getStatus /
   * awaitStatus) — a chance for a runner with no persistent watch process
   * of its own (FileTriggeredSignalRunner: oxlint, custom-lint) to launch
   * a check now if, and only if, its cached result was invalidated by a
   * file change since it last ran. A no-op when the cached result is still
   * valid, when a check is already in flight, or for runners that are
   * always continuously live and so have nothing to invalidate.
   *
   * This is the only way such a runner ever launches a check — a status
   * read always wants a result for the current codebase, so there's no
   * separate "force" method to bypass it with.
   *
   * Optional: a runner whose strategy is always continuously live (the
   * watch-mode runners backed by a persistent subprocess/instance — tests,
   * types, build) has nothing to invalidate and can omit this entirely.
   */
  ensureFresh?(): void;

  /**
   * Belt-and-suspenders recovery hook for QualityWatcher's staleness guard
   * (see its `checkForWedgedSignals`): called when this runner's cached
   * result has been judged wedged — settled `pass`/`fail`, but its
   * timestamp predates the most recent relevant change (or a prior recovery
   * attempt) by more than the watcher's grace period, with no fresher
   * result since. Should clear whatever internal bookkeeping is blocking a
   * fresh attempt (e.g. an in-flight guard that never got released) so the
   * runner's own `ensureFresh()`, called immediately after, actually
   * launches a new check instead of continuing to no-op.
   *
   * Optional: only meaningful for on-demand/file-triggered runners with
   * such bookkeeping to reset (FileTriggeredSignalRunner: oxlint,
   * custom-lint). Watch-mode runners (tests, types, build) recover via a
   * full stop()/start() cycle instead — see QualityWatcher's
   * `attemptRecovery`.
   */
  resetStuckState?(): void;

  /**
   * Whether the most recently completed run actually exercised the file at
   * `absPath`. Lets a caller confirm a specific file was really picked up
   * rather than inferring it from a timestamp alone — see
   * VitestSignalRunner.hasRunFile() and QualityWatcher's use of it to avoid
   * an unnecessary full restart when Vitest's own watch mode already
   * noticed a newly-arrived test file on its own.
   *
   * Optional: only meaningful for a runner whose single process/instance
   * covers a discoverable, filterable set of source files (Vitest's
   * `test.projects`); other runners can omit it entirely.
   */
  hasRunFile?(absPath: string): boolean;

  /**
   * Stop reacting to file changes without tearing down whatever expensive
   * warm state this runner holds (module graph, transform cache, worker
   * pool, ...) — cheaper and faster to recover from than a full
   * `stop()`/`start()` cycle. Intended for a caller that knows a burst of
   * irrelevant filesystem churn is coming (e.g. quality-watcher-process
   * pausing a whole wing's runners around a git rebase driven by cabinet —
   * see docs/design/quality-watcher-process-redesign.md) and wants every
   * runner to sit out that churn in whatever way suits its own mechanism,
   * not just watch-mode ones: a file-triggered runner (oxlint, custom-lint)
   * pausing means not even registering its fs watch, so it does no work at
   * all while paused, not just "don't act on it yet".
   *
   * Optional: a runner has this only if it has a meaningfully cheaper
   * pause than a full stop — implement `stop()`/`start()` unconditionally
   * regardless of whether this is present, so a caller can always fall back
   * to that. No-op-safe if called before `start()` or while already paused.
   */
  pause?(): Promise<void>;

  /** The `resume()` counterpart to `pause()` — see its doc comment. No-op-safe if called without a matching `pause()` first. */
  resume?(): Promise<void>;

  /**
   * When this runner last observed real, fine-grained evidence that its
   * underlying tool is doing something — a completed test case, a chunk of
   * subprocess stdout, a build-watcher event — as opposed to `getState()`'s
   * `timestamp`, which only advances on a full state *transition*
   * (pending → running → pass/fail) and says nothing about whether a
   * long-running `running` state is actually progressing or has silently
   * stalled.
   *
   * Seeded the moment `start()` is called (before the underlying tool has
   * produced anything at all), not just once real output begins — a cold
   * start (project discovery, a subprocess spawning, a worker pool
   * spinning up) is exactly the phase most likely to hang silently, so it
   * needs the same "how long since real evidence of life" measurement as
   * any other phase, not a separate blind spot covered only by a coarser
   * timeout.
   *
   * This lets a caller derive whether the runner currently looks
   * "settled" (quiescent — no activity for some short window, or an
   * explicit pass/fail result) purely from this one fact, uniformly
   * across warmup and a long-running check alike. Whether a settled
   * runner should be considered wedged is then a judgment that needs
   * information this method alone doesn't have (does the caller expect
   * it to be active right now?) — see SignalWedgeMonitor, which is one
   * such caller; a different caller with different context (e.g. an
   * editing agent that just changed a specific file) could reasonably
   * apply its own, different patience to the same underlying fact.
   *
   * Returns null only before `start()` has ever been called.
   *
   * Optional: a runner whose underlying tool has no finer-grained progress
   * signal than its own state transitions can omit this — callers fall
   * back to `getState().timestamp` with a coarser measurement for those.
   */
  lastActivityAt?(): Date | null;
}
