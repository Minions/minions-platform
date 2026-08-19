/**
 * Aggregate Quality Status Types
 *
 * Types and helpers for representing the complete quality status across
 * all four signals (tests, types, lint, build).
 */

import { SignalType, type SignalState } from './SignalState.js';

/**
 * Aggregate quality status across all four signals
 *
 * This type represents the complete quality state for a wing, including
 * the state of each individual signal and metadata about the aggregate.
 *
 * This is the type returned by the MCP tool. It supports partial results
 * (some signals still running) for early return scenarios.
 */
export type QualityStatus = {
  /**
   * State of each quality signal
   */
  [SignalType.Tests]: SignalState;
  [SignalType.Types]: SignalState;
  [SignalType.Build]: SignalState;
  [SignalType.OxLint]: SignalState;
  [SignalType.CustomLint]: SignalState;

  /**
   * Timestamp indicating when this aggregate was created
   */
  aggregatedAt: Date;

  /**
   * Flag indicating if any signals are still running
   *
   * When true, the status represents partial results - some signals
   * are still executing and their state may change.
   */
  isPartial: boolean;
};

/**
 * A `QualityStatus` with every signal `pending` as of `now` — the natural
 * "nothing has run yet" value. Shared by anything that needs to hand out a
 * placeholder before real signal state exists: a stub server response
 * (`apps/quality-watcher-process`'s walking-skeleton status endpoint) and a
 * client's just-constructed initial cache (`RemoteQualityWatcher`), so both
 * agree on the same shape without duplicating it.
 */
export function allPendingQualityStatus(now: Date): QualityStatus {
  const pending: SignalState = { state: 'pending', timestamp: now };
  return {
    [SignalType.Tests]: pending,
    [SignalType.Types]: pending,
    [SignalType.Build]: pending,
    [SignalType.OxLint]: pending,
    [SignalType.CustomLint]: pending,
    aggregatedAt: now,
    isPartial: true,
  };
}

/**
 * Promotes a warning-bearing SignalState to `fail` unless the caller opted
 * into `treatWarningsAsWarnings`. Warnings never disappear either way —
 * this only changes what `state` reports, not what was observed — but by
 * default a signal that's technically `pass` while still logging
 * deprecation notices or other non-fatal warnings reports as `fail`, so it
 * shows up as something to fix rather than something to silently keep
 * ignoring. `running`/`pending` signals are left alone even when they
 * already carry partial warnings — there's nothing actionable to report
 * yet until the check settles into pass or fail.
 */
function applySignalWarningPolicy(state: SignalState, treatWarningsAsWarnings: boolean): SignalState {
  const warnings = state.warnings ?? [];
  if (treatWarningsAsWarnings || warnings.length === 0 || state.state !== 'pass') {
    return state;
  }
  return {
    state: 'fail',
    timestamp: state.timestamp,
    failures: warnings.map((w) => `[warning treated as error] ${w}`),
    warnings,
  };
}

/**
 * Applies the warning policy to every signal in a QualityStatus.
 *
 * Default (treatWarningsAsWarnings: false, i.e. omitted) is strict: any
 * signal carrying warnings is reported as `fail` even if the underlying
 * check itself passed, so warnings can't quietly accumulate unaddressed.
 * Pass `treatWarningsAsWarnings: true` to see the tool's raw pass/fail
 * instead, with warnings reported separately and non-blocking — useful for
 * work deliberately scoped away from an existing warning backlog.
 */
/**
 * Collapses `pending` into `running` for external reporting. Internally,
 * `pending` (invalidated/not-yet-started) and `running` (actively
 * executing) are distinct so a runner can track its own lifecycle precisely
 * — see FileTriggeredSignalRunner's dirty/inFlight bookkeeping — but a
 * caller of `quality_status` has no use for that distinction: both mean
 * "no current answer, still working". A caller only ever needs four
 * buckets — pass ("OK"), fail ("failed, here's what to fix"), running
 * ("still working, maybe with partial failures already"), and stale ("no
 * valid info right now") — so `pending` is folded into `running` (with an
 * empty `failures` array, matching a `running` check that hasn't found
 * anything yet) here, at the single point every `QualityStatus` this
 * library returns passes through on its way out.
 */
function toReportedState(state: SignalState): SignalState {
  if (state.state !== 'pending') return state;
  return { state: 'running', timestamp: state.timestamp, failures: [], ...(state.warnings ? { warnings: state.warnings } : {}) };
}

/** Applies {@link toReportedState} to every signal in a QualityStatus. */
export function simplifyForReporting(status: QualityStatus): QualityStatus {
  const states = Object.fromEntries(
    Object.values(SignalType).map((signalType) => [signalType, toReportedState(status[signalType])])
  ) as Record<SignalType, SignalState>;
  return { ...status, ...states };
}

export function applyWarningPolicy(status: QualityStatus, treatWarningsAsWarnings: boolean): QualityStatus {
  const states = Object.fromEntries(
    Object.values(SignalType).map((signalType) => [signalType, applySignalWarningPolicy(status[signalType], treatWarningsAsWarnings)])
  ) as Record<SignalType, SignalState>;

  return { ...status, ...states };
}

/**
 * Overall quality state computed from all signals
 */
export type OverallState = 'pass' | 'fail' | 'running' | 'pending' | 'stale';

/**
 * Calculate the overall quality state from an aggregate status
 *
 * Business logic for computing aggregate state:
 * - pass: All signals are in pass state
 * - fail: Any signal is in fail state (failures take priority)
 * - stale: No signal is failing, but at least one has stopped producing
 *   fresh results (see QualityWatcher's staleness guard) — surfaced
 *   distinctly rather than folded into `running` or `pending` so a caller
 *   never mistakes "this signal is broken right now" for "still working
 *   normally, just not done yet".
 * - running: Any signal is running and none are failing or stale
 * - pending: All signals are pending
 *
 * @param status - The aggregate quality status
 * @returns The computed overall state
 */
export function calculateOverallState(status: QualityStatus): OverallState {
  const signals = [
    status[SignalType.Tests],
    status[SignalType.Types],
    status[SignalType.Build],
    status[SignalType.OxLint],
    status[SignalType.CustomLint],
  ];

  // fail takes priority - any failure means overall fail
  if (signals.some((signal) => signal.state === 'fail')) {
    return 'fail';
  }

  // stale is next priority - a broken/wedged signal is more concerning than
  // one that's merely still running, and must never be silently absorbed
  // into "pass" or "pending".
  if (signals.some((signal) => signal.state === 'stale')) {
    return 'stale';
  }

  // running is next priority - any running (without failures) means overall running
  if (signals.some((signal) => signal.state === 'running')) {
    return 'running';
  }

  // pass requires all signals to be passing
  if (signals.every((signal) => signal.state === 'pass')) {
    return 'pass';
  }

  // otherwise, all signals must be pending
  return 'pending';
}
