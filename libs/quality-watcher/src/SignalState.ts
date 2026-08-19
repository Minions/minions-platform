/**
 * Quality Signal State Types
 *
 * Core types for representing the state of individual quality signals
 * (tests, types, lint, build).
 */

/**
 * Signal type enumeration
 *
 * Defines the four quality signals monitored by the watcher.
 */
export enum SignalType {
  Tests = 'tests',
  Types = 'types',
  Build = 'build',
  /**
   * Fast, whole-repo oxlint pass — no `nx affected` scoping needed, it's
   * fast enough to just re-scan everything. Covers everything a "standard"
   * lint would (oxlint is ~50-100x faster than ESLint for the same rule);
   * whatever it can't check belongs in CustomLint instead. There is no
   * separate standard-ESLint signal — between OxLint and CustomLint, one of
   * the two covers every rule the old combined lint check used to.
   */
  OxLint = 'oxlint',
  /** Custom-rules-only ESLint pass for what oxlint can't check (workspace-graph-aware rules, Vue template rules) — no type-aware parsing. See runCustomLint.ts. */
  CustomLint = 'customLint',
}

/**
 * Signal state discriminated union
 *
 * Represents the current state of a quality signal. Uses a discriminated
 * union pattern for type safety, ensuring failures are only accessible
 * on fail and running states.
 *
 * States:
 * - pass: Signal completed successfully with no errors
 * - fail: Signal completed with errors (includes failures array)
 * - running: Signal is currently executing (may include partial failures)
 * - pending: Signal has not yet started
 * - stale: The runner stopped producing fresh results — its cached result
 *   predates the most recent relevant change (or a prior recovery attempt)
 *   by more than the watcher's grace period. Deliberately carries no
 *   `failures`/advice content: whatever the frozen result used to say
 *   (pass or fail) is no longer trustworthy, so it's withheld rather than
 *   risk reporting it as current. See QualityWatcher's staleness guard,
 *   which computes this at report time (never stored as a runner's own
 *   `getState()`) and drives an automatic recovery attempt alongside it.
 *
 * The running state supports early return scenarios where we've found
 * some failures but execution is still in progress.
 *
 * Each failure string is the complete, unmodified output for one failure
 * (e.g., one test failure with full stack trace).
 *
 * `warnings` is separate from `failures`: a signal can be `pass` and still
 * carry warnings (e.g. a deprecation notice logged by the underlying tool
 * during an otherwise-clean run). It's optional and omitted/empty when a
 * signal doesn't support warning capture at all (only the in-process
 * Vitest/Vite-backed runners currently populate it — see
 * VitestSignalRunner and ViteBuildWatchSignalRunner). Whether warnings
 * should also flip `state` to `fail` is a policy decision made by the
 * caller (see QualityStatus's `applyWarningPolicy`), not baked in here —
 * this type just records what was observed.
 */
export type SignalState =
  | {
      state: 'pass';
      timestamp: Date;
      warnings?: string[];
    }
  | {
      state: 'fail';
      timestamp: Date;
      failures: string[];
      warnings?: string[];
    }
  | {
      state: 'running';
      timestamp: Date;
      failures: string[];
      warnings?: string[];
    }
  | {
      state: 'pending';
      timestamp: Date;
      warnings?: string[];
    }
  | {
      state: 'stale';
      /** When this stale reading was computed — not when the frozen result was produced. */
      timestamp: Date;
      /** When the underlying (now-untrusted) cached result was actually produced. */
      staleSince: Date;
      /** Honest, human-readable explanation — this signal is broken and recovery is being attempted. Never a substitute for real pass/fail detail. */
      message: string;
      warnings?: string[];
    };
