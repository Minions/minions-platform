/**
 * Signal Wedge Monitor
 *
 * Tier 1 of the three-tier resilience design (see
 * docs/design/quality-watcher-process-redesign.md): per-signal wedge
 * detection with a cheapest-first recovery ladder, entirely inside the
 * watcher process.
 *
 * Deliberately built from two SEPARATE ideas, not one combined timeout:
 *
 * 1. `isSettled()` — a cheap, local, generic fact: "is this runner
 *    currently producing new output/progress right now?" A `pass`/`fail`
 *    result is settled immediately (an explicit run-completion signal —
 *    no need to wait for anything). A `running`/`pending` runner is
 *    settled once it's gone `settleWindowMs` (default 1s) without a
 *    `lastActivityAt()` update. This says nothing about whether being
 *    settled is OK — a healthy, idle-between-changes watcher is settled
 *    essentially all the time. It's uniform across warmup and a
 *    long-running check alike, because `lastActivityAt()` is seeded the
 *    moment `start()` is called (see its own doc comment), not just once
 *    real output begins.
 *
 * 2. Whether a settled runner counts as *wedged* is a judgment this class
 *    makes using information the runner itself doesn't have: has there
 *    been a reason (a relevant file change) to expect a fresh reaction,
 *    and how long is this level of the system willing to wait for one
 *    (`patienceMs`)? A different caller with different context (e.g. an
 *    editing agent that just changed one specific file and expects a
 *    near-immediate reaction) could reasonably apply its own, shorter
 *    patience to the exact same `isSettled()`/`lastActivityAt()` facts —
 *    this class is only one such level, the one that knows "the
 *    filesystem changed and enough time has passed that any healthy
 *    runner should have reacted by now."
 *
 * Recovery is a ladder, cheapest first: a runner with a real `pause()`/
 * `resume()` (see ISignalRunner) tries that first — cheap, since it's
 * meant to preserve warm state. Only if the runner is STILL wedged after
 * `escalateAfterMs` more does this escalate to a full `stop()`/`start()`
 * (kill and recreate just that runner — never the whole process; that's
 * Tier 3's job). A runner with no `pause()`/`resume()` at all has no cheap
 * option, so its first attempt already is the kill-and-recreate stage.
 *
 * `check()` takes `referenceAt`/`now` as explicit `Date` parameters rather
 * than reading the clock itself, so tests never need real timers — a
 * caller (WingSignalWatchers) is responsible for tracking "most recent
 * relevant file change" per repo and calling this on some cadence.
 */

import { defineEvent, type IEventBus } from '@minions/events';
import { SignalType, type SignalState } from '../SignalState.js';
import type { ISignalRunner } from '../ISignalRunner.js';

/** Emitted once when a signal first looks wedged, and once when it's next seen healthy — never repeated while it stays wedged. Heartbeat/status reporting can read `SignalWedgeMonitor.wedgedSignals()` directly instead of accumulating these. */
export const SignalWedgeEvents = {
  Wedged: defineEvent<{ signalType: SignalType }>('signal-wedge-monitor:wedged'),
  Recovered: defineEvent<{ signalType: SignalType }>('signal-wedge-monitor:recovered'),
} as const;

export type SignalWedgeMonitorOptions = {
  /**
   * How stale a settled pass/fail result must be, past the reference
   * point, before it's judged wedged — in practice, "how long to wait for
   * the very first reaction to a relevant change" (once a runner DOES
   * react, its state leaves pass/fail for running/pending, which this
   * branch no longer applies to — see `idlePatienceMs` for that case
   * instead). Defaults to 3 seconds — the backup default when a caller
   * passes nothing is deliberately tiny, not generous: a wedged signal is
   * a worse outcome than an occasional false-positive recovery attempt
   * (cheap, since Tier 1 always tries pause()/resume() first), so this
   * fails fast by default rather than waiting a long time "just in case."
   * Measured live against a real repo (apps/throne-room, 110 source
   * files): a brand-new test file was picked up by Vitest's own watch and
   * produced a completed run in under 1 second, consistently (three runs,
   * 672-979ms total; first observed activity 116-187ms) — 3s is a
   * deliberately generous multiple of that, not a guess.
   *
   * A `'file-triggered'` runner (oxlint/custom-lint — see
   * `FileTriggeredSignalRunner`'s own doc comment) is deliberately lazy:
   * it only ever reacts to a status read calling `ensureFresh()`, not to
   * elapsed time on its own. This tiny default does NOT special-case that
   * — instead, `WingSignalWatchers.checkForWedges()` itself calls
   * `ensureFresh()` on every runner before checking for wedges, so a
   * file-triggered signal gets the exact same fair chance to react before
   * being judged as a watch-mode one, and no separate, more generous
   * timeout is needed at all.
   */
  staleGraceMs?: number;
  /** How long a running/pending runner may go without a `lastActivityAt()` update before it's considered "settled" (see the class doc comment) rather than actively working. Defaults to 1 second — deliberately short: this is just "is anything happening right now," not itself the wedge judgment. */
  settleWindowMs?: number;
  /**
   * Once a running/pending runner is settled, how long that's tolerated
   * before it's judged wedged — this level's own patience, per the class
   * doc comment. Defaults to 5s (down from an earlier, unmeasured 45s,
   * then 15s): live measurement showed sub-200ms activity cadence for a
   * runner with real `lastActivityAt()` support, and oxlint/custom-lint
   * (which don't have one, so use the coarser `getState().timestamp`
   * fallback) normally complete in 1-2s — 5s stays a real margin above
   * both without waiting long "just in case." Measured from the runner's
   * own `lastActivityAt()` (or `getState().timestamp` as a fallback), so
   * it applies uniformly to a stalled warmup and a run that went silent
   * partway through.
   */
  idlePatienceMs?: number;
  /** How long to give a cheap pause()/resume() attempt to clear the wedge before escalating to a full stop()/start(). Defaults to 5s (down from an unmeasured 30s, then 10s) — a cheap pause/resume either works almost immediately or it doesn't; there's little reason to wait to find out. */
  escalateAfterMs?: number;
};

/** See `SignalWedgeMonitorOptions.staleGraceMs`'s doc comment — tiny by design, not a guess. */
const DEFAULT_STALE_GRACE_MS = 3 * 1000;
const DEFAULT_SETTLE_WINDOW_MS = 1000;
const DEFAULT_IDLE_PATIENCE_MS = 5 * 1000;
const DEFAULT_ESCALATE_AFTER_MS = 5 * 1000;
/** Once elapsed time toward whichever threshold currently governs a signal crosses this fraction without yet being wedged, `trendingWarning()` starts advising — mirrors the old in-process QualityWatcher's own `PERF_DEGRADED_THRESHOLD_FRACTION`. */
const TRENDING_THRESHOLD_FRACTION = 0.5;

type RecoveryStage = 'pause-resume' | 'kill-recreate';

type WedgeRecord = {
  wedgedSince: Date;
  stage: RecoveryStage;
  lastRecoveryAt: Date;
};

/**
 * "Is this runner currently producing new output/progress, right now?" —
 * see the class doc comment. Exported since it's a useful fact on its own
 * (e.g. status/heartbeat reporting), independent of any wedge judgment.
 */
export function isSettled(runner: ISignalRunner, state: SignalState, now: Date, settleWindowMs: number = DEFAULT_SETTLE_WINDOW_MS): boolean {
  if (state.state === 'pass' || state.state === 'fail') return true;
  if (state.state !== 'running' && state.state !== 'pending') return false;
  const activityAt = runner.lastActivityAt?.() ?? state.timestamp;
  return now.getTime() - activityAt.getTime() >= settleWindowMs;
}

type LooksWedgedOptions = {
  staleGraceMs: number;
  settleWindowMs: number;
  idlePatienceMs: number;
};

function looksWedged(runner: ISignalRunner, state: SignalState, referenceAt: Date, now: Date, opts: LooksWedgedOptions): boolean {
  const fraction = elapsedFraction(runner, state, referenceAt, now, opts);
  return fraction !== null && fraction >= 1;
}

/**
 * How far elapsed time is toward whichever threshold currently governs
 * `state` (as a fraction of that threshold — 1.0 means "at or past it",
 * i.e. `looksWedged`), or `null` if no threshold applies right now (a
 * runner that HAS reacted and is still within its liveness window). Shared
 * by `looksWedged` (>= 1) and `trendingWarning` (>= TRENDING_THRESHOLD_FRACTION,
 * < 1) so the two can never disagree about which threshold is in play.
 */
function elapsedFraction(runner: ISignalRunner, state: SignalState, referenceAt: Date, now: Date, opts: LooksWedgedOptions): number | null {
  if (state.state === 'pass' || state.state === 'fail') {
    if (state.timestamp > referenceAt) return null;
    return (now.getTime() - referenceAt.getTime()) / opts.staleGraceMs;
  }
  if (state.state === 'running' || state.state === 'pending') {
    if (!isSettled(runner, state, now, opts.settleWindowMs)) return null;
    const activityAt = runner.lastActivityAt?.() ?? state.timestamp;
    return (now.getTime() - activityAt.getTime()) / opts.idlePatienceMs;
  }
  // 'stale' is a report-time-only substitution runners never self-report via getState().
  return null;
}

export class SignalWedgeMonitor {
  private readonly wedged = new Map<SignalType, WedgeRecord>();
  private readonly staleGraceMs: number;
  private readonly settleWindowMs: number;
  private readonly idlePatienceMs: number;
  private readonly escalateAfterMs: number;

  constructor(
    private readonly eventBus: IEventBus,
    options: SignalWedgeMonitorOptions = {}
  ) {
    this.staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
    this.settleWindowMs = options.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
    this.idlePatienceMs = options.idlePatienceMs ?? DEFAULT_IDLE_PATIENCE_MS;
    this.escalateAfterMs = options.escalateAfterMs ?? DEFAULT_ESCALATE_AFTER_MS;
  }

  isWedged(signalType: SignalType): boolean {
    return this.wedged.has(signalType);
  }

  /** Every signal currently believed wedged — for a heartbeat payload naming known-wedged items, per the design doc. */
  wedgedSignals(): SignalType[] {
    return Array.from(this.wedged.keys());
  }

  /**
   * Report-time-only "getting close to being flagged wedged" advice —
   * ported from the old in-process QualityWatcher's own
   * `applyPerfDegradedAdvice`/`PERF_DEGRADED_THRESHOLD_FRACTION`. Once a
   * signal is at least half the way toward whichever threshold currently
   * governs it (without having crossed it — a signal already wedged has
   * `wedgeInfo()` for that instead), returns a human-readable warning a
   * caller can fold into `SignalState.warnings`; returns undefined
   * otherwise. Never mutates `wedged` itself — purely a read of the same
   * `elapsedFraction` `check()` uses to decide wedged-or-not, so the two
   * can never disagree about which threshold is in play.
   */
  trendingWarning(signalType: SignalType, runner: ISignalRunner, state: SignalState, referenceAt: Date, now: Date, overrides: Partial<SignalWedgeMonitorOptions> = {}): string | undefined {
    if (this.wedged.has(signalType)) return undefined;
    const opts: LooksWedgedOptions = {
      staleGraceMs: overrides.staleGraceMs ?? this.staleGraceMs,
      settleWindowMs: overrides.settleWindowMs ?? this.settleWindowMs,
      idlePatienceMs: overrides.idlePatienceMs ?? this.idlePatienceMs,
    };
    const fraction = elapsedFraction(runner, state, referenceAt, now, opts);
    if (fraction === null || fraction < TRENDING_THRESHOLD_FRACTION || fraction >= 1) return undefined;

    const isSettledBranch = state.state === 'pass' || state.state === 'fail';
    const thresholdMs = isSettledBranch ? opts.staleGraceMs : opts.idlePatienceMs;
    const elapsedMs = Math.round(fraction * thresholdMs);
    const pct = Math.round(fraction * 100);
    const activity = isSettledBranch
      ? `hasn't produced a fresh result since the last relevant change`
      : `has been ${state.state} without any observed activity`;
    return (
      `${signalType} quality signal ${activity} for ${Math.round(elapsedMs / 1000)}s — ${pct}% of the ` +
      `${Math.round(thresholdMs / 1000)}s threshold before it's reported as wedged. Performance looks ` +
      `degraded — investigate and speed up this check before it crosses that threshold.`
    );
  }

  /**
   * When `signalType` was first judged wedged — lets a caller build an
   * honest `stale` `SignalState` (see that type's own doc comment) instead
   * of reporting whatever frozen/stuck result the runner itself still
   * returns from `getState()`. Returns undefined when not wedged. Unlike
   * the old in-process QualityWatcher's report-only stuck-running case,
   * Tier 1 always has a recovery attempt underway the moment this is
   * non-undefined (see `check()`'s ladder) — there's no "report-only, no
   * recovery attempted" case to distinguish here.
   */
  wedgeInfo(signalType: SignalType): { wedgedSince: Date } | undefined {
    const record = this.wedged.get(signalType);
    return record ? { wedgedSince: record.wedgedSince } : undefined;
  }

  /**
   * `referenceAt` is the most recent relevant file change (or whatever
   * else the caller considers a reason a settled result should have gone
   * stale) — the caller's job to compute, e.g. via an fs.watch on the repo.
   *
   * `overrides` lets the caller apply different real-world timing
   * expectations per call without this class needing to know *why* — e.g.
   * `WingSignalWatchers` passes a much tighter `staleGraceMs` for a
   * watch-mode runner (which should react to a change in milliseconds)
   * than for a deliberately lazy `FileTriggeredSignalRunner` (which only
   * ever reacts to a status read, not to elapsed time). That's the
   * caller's domain knowledge about what kind of signal this is — this
   * class stays strategy-agnostic, same as `check()`'s uniform recovery
   * ladder below.
   */
  async check(signalType: SignalType, runner: ISignalRunner, referenceAt: Date, now: Date, overrides: Partial<SignalWedgeMonitorOptions> = {}): Promise<void> {
    const existing = this.wedged.get(signalType);
    const opts: LooksWedgedOptions = {
      staleGraceMs: overrides.staleGraceMs ?? this.staleGraceMs,
      settleWindowMs: overrides.settleWindowMs ?? this.settleWindowMs,
      idlePatienceMs: overrides.idlePatienceMs ?? this.idlePatienceMs,
    };
    // `referenceAt` is used as-is, not advanced to a prior recovery attempt's
    // own timestamp: a recovery that actually worked shows up as a state
    // transition (a fresh settled result, or 'pending' from a restart — both
    // fail `looksWedged` on their own), so there's no need to give a
    // just-attempted recovery its own separate grace window here. Escalation
    // timing (below) is intentionally the only thing keyed off
    // `lastRecoveryAt`.
    const wedgedNow = looksWedged(runner, runner.getState(), referenceAt, now, opts);

    if (!wedgedNow) {
      if (existing) {
        this.wedged.delete(signalType);
        this.eventBus.emit(SignalWedgeEvents.Recovered, { signalType });
      }
      return;
    }

    if (!existing) {
      this.eventBus.emit(SignalWedgeEvents.Wedged, { signalType });
      const stage = await this.attemptRecovery(signalType, runner, 'pause-resume');
      this.wedged.set(signalType, { wedgedSince: now, stage, lastRecoveryAt: now });
      return;
    }

    if (existing.stage === 'pause-resume' && now.getTime() - existing.lastRecoveryAt.getTime() >= this.escalateAfterMs) {
      const stage = await this.attemptRecovery(signalType, runner, 'kill-recreate');
      this.wedged.set(signalType, { ...existing, stage, lastRecoveryAt: now });
    }
    // Already at 'kill-recreate' and still wedged: Tier 1 stops here by
    // design ("never the whole process for this tier") — Tier 2 (cabinet
    // backstop) and Tier 3 (whole-process heartbeat) pick up from here.
  }

  /** Returns the stage actually performed — 'pause-resume' escalates itself to 'kill-recreate' when the runner has no pause()/resume() to try. */
  private async attemptRecovery(signalType: SignalType, runner: ISignalRunner, desiredStage: RecoveryStage): Promise<RecoveryStage> {
    try {
      if (desiredStage === 'pause-resume' && runner.pause && runner.resume) {
        await runner.pause();
        await runner.resume();
        return 'pause-resume';
      }
      await runner.stop();
      await runner.start();
      return 'kill-recreate';
    } catch (error) {
      console.error(`[SignalWedgeMonitor] Recovery attempt (${desiredStage}) failed for wedged ${signalType} signal:`, error);
      return desiredStage;
    }
  }
}
