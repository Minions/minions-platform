/**
 * Quality Watcher
 *
 * Real IQualityWatcher implementation for one work repo, backed by five
 * independent signal runners, uniformly behind ISignalRunner:
 *
 * - tests: VitestSignalRunner — one persistent in-process Vitest instance
 *   for the whole work repo (`startVitest({ watch: true, projects: [...] })`)
 *   — see VitestSignalRunner for why one shared `test.projects` instance is
 *   now used instead of one per project directory. Each project's own watch
 *   mode still tracks its own import graph and reruns only the test files
 *   whose transitive dependencies changed.
 * - types: VueTscWatchSignalRunner — one persistent `vue-tsc --watch`
 *   subprocess (tsc's own incremental watch machinery, Vue-aware).
 * - build: ViteBuildWatchSignalRunner — one persistent Vite build watcher
 *   (`build()` with `build.watch` set, a Rollup watcher under the hood).
 * - oxlint, custom-lint: FileTriggeredSignalRunner — oxlint and ESLint have
 *   no watch mode of their own and each check is a full process run, so
 *   these are on demand: a shared fs.watch (see sharedFsWatch.ts) only
 *   invalidates the cached result on a qualifying change (same scoping as
 *   before); the actual re-run is deferred until the next status read finds
 *   no valid cached result — see ensureFreshWhereStale() below.
 *
 * start() launches tests/types/build's persistent watchers and arms the
 * oxlint/custom-lint file watchers (without running them) once. getStatus()
 * is a synchronous read of whatever's cached, but first gives any stale
 * on-demand signal a chance to launch. awaitStatus() is for request/response
 * callers (e.g. the quality_status MCP tool): it does the same, then waits
 * briefly for any currently-running signal to settle instead of returning a
 * snapshot mid-flight.
 *
 * getStatus()/awaitStatus() also run a watch-mode staleness guard —
 * restartWatchModeSignalsIfWedged() — that restarts tests/types/build if
 * their cached result looks like it's stopped reacting to file changes
 * (see that method's doc comment for the live symptom this was added for).
 */

import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import type { IEventBus } from '@minions/events';
import { EventBus } from '@minions/events';
import type { IQualityWatcher } from '../IQualityWatcher.js';
import { SignalType, type SignalState } from '../SignalState.js';
import { applyWarningPolicy, simplifyForReporting, type QualityStatus } from '../QualityStatus.js';
import type { ISignalRunner } from '../ISignalRunner.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import type { ProcessRunner } from './runProcess.js';
import { FileTriggeredSignalRunner, isIgnoredPath } from './FileTriggeredSignalRunner.js';
import { VitestSignalRunner, type VitestStarter } from './VitestSignalRunner.js';
import { TEST_FILE_PATTERN } from './hasAnyTestFile.js';
import { VueTscWatchSignalRunner } from './VueTscWatchSignalRunner.js';
import { ViteBuildWatchSignalRunner, type ViteBuildStarter } from './ViteBuildWatchSignalRunner.js';
import type { WatchedChildProcess } from './ProcessWatchSignalRunner.js';
import { runOxlint } from './runOxlint.js';
import { runCustomLint } from './runCustomLint.js';
import { createSharedFsWatch } from './sharedFsWatch.js';
import { AlwaysPassSignalRunner } from './AlwaysPassSignalRunner.js';
import { GLOBAL_SIGNALS, DEV_SIGNALS } from '../SignalCategory.js';
import { getGitOperationStatus } from './gitOperationInProgress.js';

/** Every SignalType this watcher tracks — always all five, whether or not each one has a real runner behind it (see `QualityWatcherOptions.signals`). */
const ALL_SIGNALS = [SignalType.Tests, SignalType.Types, SignalType.Build, SignalType.OxLint, SignalType.CustomLint] as const;

/** Default active set: every category — identical to `DEV_SIGNALS` alone today, since `GLOBAL_SIGNALS` is currently empty, but automatically grows the moment a real global signal is added. */
const DEFAULT_ACTIVE_SIGNALS: readonly SignalType[] = [...GLOBAL_SIGNALS, ...DEV_SIGNALS];

/**
 * The three signals backed by a persistent watch-mode process/instance
 * (Vitest, vue-tsc, Vite build) rather than FileTriggeredSignalRunner's
 * on-demand relaunch. These are the ones `restartWatchModeSignalsIfWedged`
 * below can wedge and needs to nurse back to health — see its doc comment.
 */
const WATCH_MODE_SIGNALS = [SignalType.Tests, SignalType.Types, SignalType.Build] as const;

const DEFAULT_MAX_WAIT_MS = 5000;

/**
 * How long a watch-mode signal's cached result is allowed to sit older than
 * the most recent qualifying file change (or, after a restart, than the
 * restart itself — see `lastRestartAt`) before it's treated as wedged and
 * restarted — see `restartWatchModeSignalsIfWedged`. Only needs to cover the
 * time between a change/restart and the runner's own *first reaction* to it
 * (transitioning off its last settled pass/fail into 'running'); 'running'
 * itself is exempt from this check no matter how long the actual run takes
 * (see the strategy comment on that method), so this is not a completion
 * budget. Generous on purpose regardless: a cold restart of a heavy
 * monorepo's watch-mode tooling (full project discovery, worker pool
 * startup, ...) can legitimately take minutes before it even gets to that
 * first reaction, and a signal wrongly killed mid-startup only restarts the
 * same slow cold start again — see runners' own state-reset-on-start (each
 * sets state back to 'pending', itself exempt from this check) for the other
 * half of what actually breaks that loop.
 */
const DEFAULT_STALE_WATCHER_GRACE_MS = 5 * 60 * 1000;

/**
 * How long a watch-mode signal (tests/types/build) is allowed to sit in
 * `running`/`pending` — counted from when it entered that state, not from
 * the last file change — before `checkStuckRunning` reports it as `stale`
 * too, distinct from `restartWatchModeSignalsIfWedged`'s frozen-result wedge
 * detection above. That existing guard is deliberately blind to this case:
 * it only ever looks at a *settled* pass/fail result, so a signal that never
 * gets there in the first place — its very first run hangs, or a subprocess
 * spawn silently never produces output — sits reported as `running`/
 * `pending` forever, which every caller (including the movement commit gate)
 * otherwise treats as "still working, nothing to act on yet" indefinitely.
 *
 * This does NOT trigger a restart (see `checkStuckRunning`'s own comment) —
 * only reports the situation honestly — so erring on the shorter side here
 * costs an earlier, possibly premature report on a legitimately slow first
 * run, never a wrongly-killed in-progress one. 45 seconds trades that risk
 * for catching a genuinely wedged signal quickly rather than leaving a
 * broken watcher silently invisible to the movement commit gate for long.
 */
const DEFAULT_STUCK_RUNNING_GRACE_MS = 45 * 1000;

/**
 * Once a signal is at least this fraction of the way toward
 * `stuckRunningGraceMs` or `staleWatcherGraceMs` — without having crossed
 * either yet — `applyPerfDegradedAdvice` attaches a performance-degradation
 * warning to its reported state. Mirrors runProcess.ts's own
 * `PERF_DEGRADED_THRESHOLD_FRACTION` (same idea — a timeout-like threshold
 * that's worth flagging as trending-bad well before it's actually crossed —
 * applied here to report-level grace periods instead of one subprocess
 * call's own timeout, so kept as its own constant rather than shared).
 */
const PERF_DEGRADED_THRESHOLD_FRACTION = 0.5;

/**
 * How long a newly-arrived test file gets to show up in a completed Vitest
 * run before its restart is forced unconditionally — see
 * `restartWatchModeSignalsIfWedged`'s verify-then-restart flow. Most new
 * test files ARE picked up by Vitest's own watch mode on their own; this
 * window exists so those common cases skip the expensive full-suite cold
 * restart entirely; only a file Vitest demonstrably missed (or never got a
 * chance to run at all within this window) pays that cost.
 */
const DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS = 5_000;

/**
 * How often to poll `getGitOperationStatus` while running, to pause/resume
 * the three watch-mode signals (tests/types/build) around a rebase/merge/
 * cherry-pick/revert — see `pollGitOperationState`'s doc comment for why
 * these three specifically need this and FileTriggeredSignalRunner (oxlint,
 * custom-lint) doesn't. A plain timer, not piggybacked on the shared fs.watch
 * callback: the watch-mode runners' own internal file watchers (Vitest's,
 * vue-tsc's, Vite's) see the same raw fs events at essentially the same time
 * ours does, so there's no ordering guarantee we'd detect and pause before
 * they've already started reacting to the first wave — an independent poll
 * at least bounds how long the pause takes to kick in. Cheap enough to poll
 * often: `getGitOperationStatus` is a handful of `fs.access`/`fs.stat`
 * calls on small files, no subprocess.
 */
const GIT_OPERATION_POLL_MS = 1000;

export type QualityWatcherOptions = {
  /** Starter used by the Vitest-backed tests signal. Defaults to a real `startVitest({ watch: true })`. */
  vitestStarter?: VitestStarter;
  /** Discovers project directories for the tests signal (fed into one shared Vitest instance's `test.projects`). Defaults to a real filesystem walk. */
  discoverVitestProjectDirs?: (cwd: string) => Promise<string[]>;
  /** Starter used by the Vite-build-backed build signal. Defaults to a real `build()` with `build.watch` set. */
  viteBuildStarter?: ViteBuildStarter;
  /** Spawns the vue-tsc watch subprocess for the types signal. Defaults to `pnpm exec vue-tsc --watch --noEmit`. */
  vueTscSpawn?: (cwd: string) => WatchedChildProcess;
  /** ProcessRunner used by the oxlint signal. Defaults to running `oxlint` directly. */
  oxlintProcess?: ProcessRunner;
  /** ProcessRunner used by the custom-lint signal. Defaults to a persistent in-process ESLint instance running only a repo's own custom rules, if any. */
  customLintProcess?: ProcessRunner;
  /** Debounce window for the file-triggered runners (oxlint, custom-lint), in ms. Defaults to 1000. */
  debounceMs?: number;
  /** Injectable fs.watch, for tests. */
  watchFs?: typeof fsWatch;
  /** Grace period for the watch-mode staleness guard, in ms. Defaults to {@link DEFAULT_STALE_WATCHER_GRACE_MS}. */
  staleWatcherGraceMs?: number;
  /** Grace period for the stuck-running/pending guard (tests/types/build never settling), in ms. Defaults to {@link DEFAULT_STUCK_RUNNING_GRACE_MS}. */
  stuckRunningGraceMs?: number;
  /** How long a newly-arrived test file gets to appear in a completed Vitest run before its restart is forced. Defaults to {@link DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS}. */
  testFileArrivalVerifyMs?: number;
  /** Injectable git-operation-status check, for tests. Defaults to the real `getGitOperationStatus`. */
  checkGitOperationStatus?: (cwd: string) => Promise<{ inProgress: boolean; stable: boolean }>;
  /** Poll interval (ms) for pausing/resuming watch-mode signals around a git operation. Defaults to {@link GIT_OPERATION_POLL_MS}. */
  gitOperationPollMs?: number;
  /**
   * Which signals this watcher actually runs real tooling for — every other
   * `SignalType` gets an `AlwaysPassSignalRunner` stand-in instead, so the
   * status shape stays complete without spawning tooling this watcher was
   * never configured to check. Defaults to every category
   * (`GLOBAL_SIGNALS` ∪ `DEV_SIGNALS`) — today's full behavior, unchanged.
   * Pass `GLOBAL_SIGNALS` alone for a docs/plan-only watcher (e.g. the
   * cabinet's own) that never runs software-dev tooling.
   */
  signals?: readonly SignalType[];
};

export class QualityWatcher implements IQualityWatcher {
  private running = false;
  private readonly eventBus: IEventBus;
  private readonly runners: Record<SignalType, ISignalRunner>;
  private readonly cwd: string;
  private readonly sharedWatchFs: typeof fsWatch;
  private readonly staleWatcherGraceMs: number;
  private readonly stuckRunningGraceMs: number;
  private readonly testFileArrivalVerifyMs: number;
  private readonly checkGitOperationStatus: (cwd: string) => Promise<{ inProgress: boolean; stable: boolean }>;
  private readonly gitOperationPollMs: number;
  /** Set by the fs watch registered in start(); most recent qualifying file change, or null if none seen yet this run. */
  private lastFileChangeAt: Date | null = null;
  private staleChangeWatcher: { close(): void } | null = null;
  /** True while the watch-mode signals (tests/types/build) are stopped because a git operation was last observed in progress — see `pollGitOperationState`. */
  private pausedForGitOperation = false;
  /** Guards against an overlapping poll tick if a stop()/start() cycle somehow outlives one poll interval. */
  private gitOperationCheckInFlight = false;
  private gitOperationPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Watch-mode signals currently being torn down and restarted by `restartWatchModeSignalsIfWedged`, so a second stale read mid-restart doesn't pile on a second restart. */
  private readonly restartingSignals = new Set<SignalType>();
  /** When each watch-mode signal was last restarted for looking wedged — see `restartWatchModeSignalsIfWedged`'s use of this to give a freshly restarted signal its own grace period. */
  private readonly lastRestartAt = new Map<SignalType, Date>();
  /**
   * New files matching Vitest's test-file naming, seen via the fs watch
   * registered in start() but not yet confirmed to have been picked up by
   * the tests signal (or force-restarted) — keyed by absolute path, valued
   * by when each first arrived. See `restartWatchModeSignalsIfWedged`'s
   * verify-then-restart flow, which this feeds.
   */
  private readonly pendingTestFileArrivals = new Map<string, Date>();

  // --- Staleness-reporting guard (see `checkStaleness`) ---
  //
  // A deliberately SEPARATE, additional layer from the watch-mode
  // detect-and-restart machinery above (`restartingSignals`/`lastRestartAt`/
  // `restartWatchModeSignalsIfWedged`/`restartWedgedSignal`), which already
  // existed and is left untouched. That machinery's job is narrow: notice a
  // watch-mode signal (tests/types/build) stopped reacting and restart it.
  // This layer's job is different and broader: for EVERY signal, decide
  // whether the *reported* result can currently be trusted at all, and if
  // not, say so honestly (`SignalState`'s `stale` variant) instead of
  // letting a caller act on a frozen pass/fail. It reads the watch-mode
  // machinery's own `lastRestartAt` (never writes it) so it doesn't
  // contradict that machinery's own grace period, but it never calls
  // `restartWedgedSignal` or otherwise drives a watch-mode restart itself —
  // only `restartWatchModeSignalsIfWedged` does that. For file-triggered
  // signals (oxlint, custom-lint), which had no recovery mechanism of their
  // own at all before this, this layer both reports staleness AND attempts
  // recovery — see `attemptFileTriggeredRecovery`.
  /**
   * Signals currently reported as `stale` (see SignalState), keyed by the
   * timestamp of the frozen result that triggered the flag — i.e. exactly
   * `staleSince`. Populated by `checkStaleness` when a signal looks wedged,
   * consulted by `buildStatus` to substitute a `stale` SignalState in place
   * of whatever the runner itself is still (possibly incorrectly)
   * reporting, and cleared the moment that runner produces ANY result newer
   * than the flagged timestamp — proof it's alive again, whether or not the
   * fresh result has fully settled yet.
   */
  private readonly reportedStaleSince = new Map<SignalType, Date>();
  /**
   * Why each entry in `reportedStaleSince` was flagged — `'frozen'` for
   * `checkStaleness`'s case (a settled result stopped updating) or
   * `'stuck-running'` for `checkStuckRunning`'s case (never settled at all).
   * `staleState` reads this to avoid claiming an automatic recovery attempt
   * is underway for the stuck-running case, where none is made (see that
   * method's own comment for why). Always set together with, and cleared
   * together with, the corresponding `reportedStaleSince` entry.
   */
  private readonly staleCause = new Map<SignalType, 'frozen' | 'stuck-running'>();
  /** File-triggered signals (oxlint, custom-lint) currently having a `resetStuckState()` + `ensureFresh()` recovery attempt in flight — see `attemptFileTriggeredRecovery`. Never used for watch-mode signals; those are `restartingSignals`'s concern. */
  private readonly fileTriggeredRecoveryInFlight = new Set<SignalType>();
  /** When each file-triggered signal's last recovery attempt was made — this layer's own cooldown, independent of the watch-mode machinery's `lastRestartAt`. */
  private readonly lastFileTriggeredRecoveryAt = new Map<SignalType, Date>();

  constructor(
    readonly wingName: string,
    cwd: string,
    eventBus: IEventBus = new EventBus(),
    options: QualityWatcherOptions = {}
  ) {
    this.eventBus = eventBus;
    this.cwd = cwd;
    const {
      vitestStarter,
      discoverVitestProjectDirs: discoverProjectDirs,
      viteBuildStarter,
      vueTscSpawn,
      oxlintProcess = runOxlint,
      customLintProcess = runCustomLint,
      debounceMs = 1000,
      watchFs: watchFsImpl = fsWatch,
      staleWatcherGraceMs = DEFAULT_STALE_WATCHER_GRACE_MS,
      stuckRunningGraceMs = DEFAULT_STUCK_RUNNING_GRACE_MS,
      testFileArrivalVerifyMs = DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS,
      signals: activeSignals = DEFAULT_ACTIVE_SIGNALS,
      checkGitOperationStatus = getGitOperationStatus,
      gitOperationPollMs = GIT_OPERATION_POLL_MS,
    } = options;
    this.staleWatcherGraceMs = staleWatcherGraceMs;
    this.stuckRunningGraceMs = stuckRunningGraceMs;
    this.testFileArrivalVerifyMs = testFileArrivalVerifyMs;
    this.checkGitOperationStatus = checkGitOperationStatus;
    this.gitOperationPollMs = gitOperationPollMs;

    // oxlint and custom-lint both watch this same `cwd` recursively via
    // fs.watch; route them through one shared watcher instead of each
    // registering its own real OS watch handle (see sharedFsWatch.ts). The
    // watch-mode staleness guard below registers a third subscriber on this
    // same shared watcher rather than opening its own handle.
    this.sharedWatchFs = createSharedFsWatch(watchFsImpl);

    const isActive = (signalType: SignalType) => activeSignals.includes(signalType);
    this.runners = {
      [SignalType.Tests]: isActive(SignalType.Tests)
        ? new VitestSignalRunner(cwd, eventBus, vitestStarter, discoverProjectDirs)
        : new AlwaysPassSignalRunner(SignalType.Tests),
      [SignalType.Types]: isActive(SignalType.Types)
        ? new VueTscWatchSignalRunner(cwd, eventBus, vueTscSpawn)
        : new AlwaysPassSignalRunner(SignalType.Types),
      [SignalType.Build]: isActive(SignalType.Build)
        ? new ViteBuildWatchSignalRunner(cwd, eventBus, viteBuildStarter)
        : new AlwaysPassSignalRunner(SignalType.Build),
      [SignalType.OxLint]: isActive(SignalType.OxLint)
        ? new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', cwd, eventBus, oxlintProcess, debounceMs, this.sharedWatchFs)
        : new AlwaysPassSignalRunner(SignalType.OxLint),
      [SignalType.CustomLint]: isActive(SignalType.CustomLint)
        ? new FileTriggeredSignalRunner(SignalType.CustomLint, 'custom-lint', cwd, eventBus, customLintProcess, debounceMs, this.sharedWatchFs)
        : new AlwaysPassSignalRunner(SignalType.CustomLint),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Watcher is already running');
    }
    this.running = true;
    // One signal failing to start (a subprocess spawn failure, a Vitest
    // project rejecting on cold start, ...) must not stop the other four
    // from starting, and must not propagate past this watcher — see
    // apps/cabinet/src/main.ts's unhandledRejection/uncaughtException
    // handlers for why a per-call-site catch is the primary defense, not
    // just a backstop.
    await Promise.all(
      ALL_SIGNALS.map((signalType) =>
        this.runners[signalType].start().catch((error) => {
          console.error(`[QualityWatcher] Failed to start ${signalType} signal for wing ${this.wingName}:`, error);
        })
      )
    );
    this.lastFileChangeAt = null;
    this.pendingTestFileArrivals.clear();
    this.restartingSignals.clear();
    this.lastRestartAt.clear();
    this.reportedStaleSince.clear();
    this.staleCause.clear();
    this.fileTriggeredRecoveryInFlight.clear();
    this.lastFileTriggeredRecoveryAt.clear();
    this.staleChangeWatcher = this.sharedWatchFs(this.cwd, { recursive: true }, (eventType, filename) => {
      if (isIgnoredPath(filename)) return;
      this.lastFileChangeAt = new Date();
      // 'rename' is Node's fs.watch event for a path appearing, disappearing,
      // or being renamed in the watched tree (as opposed to 'change', an
      // existing file's contents/metadata being modified) — the best signal
      // this API gives us that `filename` is a *new* test file rather than an
      // edit to one Vitest already knows about. See
      // restartWatchModeSignalsIfWedged for why that distinction matters here.
      if (eventType === 'rename' && filename && TEST_FILE_PATTERN.test(filename)) {
        const absPath = path.resolve(this.cwd, filename);
        if (!this.pendingTestFileArrivals.has(absPath)) {
          this.pendingTestFileArrivals.set(absPath, new Date());
        }
      }
    });
    this.pausedForGitOperation = false;
    this.gitOperationPollTimer = setInterval(() => void this.pollGitOperationState(), this.gitOperationPollMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.staleChangeWatcher?.close();
    this.staleChangeWatcher = null;
    if (this.gitOperationPollTimer) {
      clearInterval(this.gitOperationPollTimer);
      this.gitOperationPollTimer = null;
    }
    await Promise.all(Object.values(this.runners).map((runner) => runner.stop()));
  }

  /**
   * Pauses/resumes every signal around a rebase/merge/cherry-pick/revert.
   * All five signals implement `pause()`/`resume()` uniformly now (see
   * ISignalRunner's doc comment and FileTriggeredSignalRunner's — that one
   * used to defer on its own via `isGitOperationInProgress` instead of
   * relying on an external pause; it no longer does, so this poll is now
   * the only thing protecting it here too), so this calls `pause()`/
   * `resume()` on all of `ALL_SIGNALS` uniformly, falling back to
   * `stop()`/`start()` only for a hypothetical future runner that doesn't
   * implement the cheaper pair. The three watch-mode signals in particular
   * have no equivalent of a "defer the launch" escape hatch the way
   * FileTriggeredSignalRunner briefly had: each owns a persistent watch
   * process/instance (Vitest's own file watcher, `vue-tsc --watch`, Vite's
   * build watcher) that reacts to raw filesystem events on its own,
   * completely outside this watcher's control, the instant they happen. A
   * `movement merge` rebase can rewrite a large number of files in a single
   * burst; without this, that burst drives all three watch-mode
   * processes/instances into simultaneous heavy re-collection/re-run work
   * against a working tree git is still actively rewriting underneath them —
   * exactly the kind of load `VitestSignalRunner`'s own comments document as
   * "very plausibly what actually exhausted the crashed prod server" in an
   * earlier incident (a different resource shape, but the same root cause:
   * watch-mode tooling reacting to a git-driven file-change storm with no
   * awareness a git operation is in flight).
   *
   * This can't guarantee catching the very first instant of a burst — this
   * watcher's own poll and each tool's internal file watcher observe the
   * same raw fs events with no ordering guarantee between them — but it
   * bounds how long the exposure lasts (stopping mid-burst cuts off further
   * reactive work).
   *
   * Deliberately does NOT resume just because the operation has gone quiet
   * for a while — a timing guess like that has no reliable way to tell "git
   * paused between two of a rebase's commits" (routinely under a second, but
   * not bounded — a big diff, a slow disk, or exactly the load this exists
   * to relieve can all stretch that gap) apart from "git genuinely halted,
   * waiting on a human." Getting it wrong in the resume direction is
   * expensive in exactly the way this must never be: `VitestSignalRunner`
   * has no cheap "pause reactivity" primitive, only stop()/start(), and
   * start() is a full cold reinit (fresh project discovery, a fresh worker
   * pool, a full initial run) — worth paying once for a real halt or once a
   * whole rebase finishes, not viable to pay per commit. `getGitOperationStatus`
   * sidesteps the guess entirely: `stable` reflects git's own `stopped-sha`
   * marker, written by the sequencer if and only if it has actually halted a
   * step (confirmed empirically — absent through an automatic multi-commit
   * replay, present the instant a step halts, rewritten fresh at each new
   * halt, gone the moment the whole rebase finishes) — see that function's
   * own doc comment. That makes resume-on-stable exactly as immediate as
   * resume-on-cleared, with no window to tune and no risk of firing between
   * commits.
   *
   * On the resume side this also guarantees recovery even though the
   * operation's own last write (removing `.git/rebase-merge`) happens under
   * `.git`, which the shared fs.watch this class already runs deliberately
   * ignores (see `isIgnoredPath`) and so would never otherwise trigger a
   * resume on its own.
   *
   * Deliberately independent of `restartingSignals`/`restartWedgedSignal`
   * (the staleness-driven restart machinery) — a stop() here while a restart
   * is also in flight for the same signal is safe (`stop()`/`start()` are
   * documented idempotent-safe to call again), and re-using that same
   * bookkeeping would conflate "wedged, needs a cold restart" with "healthy,
   * just paused for git" in ways `restartWatchModeSignalsIfWedged`'s own
   * grace-period math isn't built to reason about.
   */
  private async pollGitOperationState(): Promise<void> {
    if (this.gitOperationCheckInFlight) return;
    this.gitOperationCheckInFlight = true;
    try {
      const { inProgress, stable } = await this.checkGitOperationStatus(this.cwd);
      const shouldPause = inProgress && !stable;
      if (shouldPause && !this.pausedForGitOperation) {
        this.pausedForGitOperation = true;
        console.error(`[QualityWatcher] Git operation actively in progress for wing ${this.wingName} — pausing all signals.`);
        await Promise.all(
          ALL_SIGNALS.map((signalType) => {
            const runner = this.runners[signalType];
            return (runner.pause?.() ?? runner.stop()).catch((error: unknown) => {
              console.error(`[QualityWatcher] Failed to pause ${signalType} signal for wing ${this.wingName}:`, error);
            });
          })
        );
      } else if (!shouldPause && this.pausedForGitOperation) {
        this.pausedForGitOperation = false;
        console.error(
          `[QualityWatcher] Git operation ${inProgress ? 'halted (stable) — resuming all signals to pick up the current state.' : 'cleared — resuming all signals.'} (wing ${this.wingName})`
        );
        await Promise.all(
          ALL_SIGNALS.map((signalType) => {
            const runner = this.runners[signalType];
            return (runner.resume?.() ?? runner.start()).catch((error: unknown) => {
              console.error(`[QualityWatcher] Failed to resume ${signalType} signal for wing ${this.wingName}:`, error);
            });
          })
        );
      }
    } finally {
      this.gitOperationCheckInFlight = false;
    }
  }

  getStatus(treatWarningsAsWarnings = false): QualityStatus {
    this.ensureFreshWhereStale();
    return simplifyForReporting(applyWarningPolicy(this.buildStatus((signalType) => this.runners[signalType].getState()), treatWarningsAsWarnings));
  }

  async awaitStatus(maxWaitMs: number = DEFAULT_MAX_WAIT_MS, treatWarningsAsWarnings = false): Promise<QualityStatus> {
    // Tests/types/build are genuine watch sources, guaranteed to eventually
    // move past 'pending'/'running' on their own. Oxlint/custom-lint are
    // on-demand now — a file change only invalidates their cached result —
    // so ensureFreshWhereStale() below is what actually launches a run for
    // any of those with nothing valid cached, before we wait on any of them.
    this.ensureFreshWhereStale();
    const entries = await Promise.all(
      ALL_SIGNALS.map(async (signalType) => [signalType, await this.awaitSettledOrTimeout(this.runners[signalType], maxWaitMs)] as const)
    );
    const states = Object.fromEntries(entries) as Record<SignalType, SignalState>;
    return simplifyForReporting(applyWarningPolicy(this.buildStatus((signalType) => states[signalType]), treatWarningsAsWarnings));
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Launch a run for any signal (oxlint, custom-lint) whose cached result
   * was invalidated by a file change and hasn't been re-run since — see
   * FileTriggeredSignalRunner.ensureFresh(). A no-op for signals with
   * nothing to invalidate (tests, types, build — always continuously live
   * watchers with no such optional method).
   */
  private ensureFreshWhereStale(): void {
    if (!this.running) return;
    for (const runner of Object.values(this.runners)) {
      runner.ensureFresh?.();
    }
    this.restartWatchModeSignalsIfWedged();
    this.checkStaleness();
    this.checkStuckRunning();
  }

  /**
   * Tests/types/build are assumed to be "genuine watch sources, guaranteed
   * to eventually move past pending/running on their own" (see
   * awaitStatus's own comment) — but that assumption depends on the
   * underlying watch-mode process/instance (Vitest's own file watcher,
   * vue-tsc --watch, Vite's build.watch) actually noticing every file
   * change, every time, for as long as this watcher runs. Observed live: a
   * long-running Vitest watch instance can stop reacting to further file
   * changes (its cached `tests` result stays 'pass'/'fail' from well before
   * a later fix, unchanged across many subsequent writes) without ever
   * emitting a failure — nothing here would know, because these three
   * signals have no equivalent of FileTriggeredSignalRunner's own
   * ensureFresh()/dirty tracking to fall back on.
   *
   * This is that fallback: reuses the same shared fs.watch already open for
   * oxlint/custom-lint (see the constructor) as an independent, always-on
   * "did anything relevant change" signal, and treats a watch-mode runner
   * as wedged if its cached result predates the most recent qualifying
   * change by more than `staleWatcherGraceMs` — long enough that a merely
   * slow (not stuck) run would have finished. A wedged signal is nursed
   * back to health the same way its own `start()` is meant to be
   * idempotent-safe to call again: stop() the (possibly already-dead)
   * process/instance and start() a fresh one. `restartingSignals` guards
   * against firing a second restart for the same signal while the first is
   * still in flight — status reads happen far more often than a stop+start
   * cycle takes.
   *
   * A restart itself does not reset the runner's cached state — stop()
   * simply tears down the process/instance, and the old pass/fail result
   * (with its now-stale timestamp) sits there until the freshly spawned
   * replacement completes its own first cycle, which for a cold Vitest
   * instance, vue-tsc full recheck, or Vite build can legitimately take
   * longer than one poll interval. Comparing every poll against only
   * `lastFileChangeAt` doesn't account for that: the very next stale read
   * would see the same stale timestamp and restart again, killing each
   * replacement before it ever gets to converge — confirmed live as an
   * unbroken loop of "looks wedged — restarting it" that never recovers.
   * `lastRestartAt` fixes this by giving each signal its own grace window
   * measured from its own most recent restart (whichever is later of that
   * and the last file change), so a replacement that's merely still warming
   * up is never mistaken for wedged again before it's had a fair chance.
   *
   * The timestamp comparison above has a further blind spot this method also
   * covers: it only proves the *whole runner* stopped reacting to *anything*,
   * never that it's reacting to everything it should. Confirmed live: a new
   * `*.spec.ts` file dropped into a directory Vitest was already watching
   * never appeared in `tests` results, yet the signal never looked stale —
   * an unrelated file elsewhere in the repo kept getting touched, Vitest's
   * shared instance kept producing real, timely pass/fail results for
   * *those* files, and each one refreshed `state.timestamp` past
   * `lastFileChangeAt`. The staleness check above cannot see this: from its
   * point of view the signal never stopped moving.
   *
   * `pendingTestFileArrivals` covers that gap, but deliberately doesn't force
   * a restart the instant a new test file is seen — most new test files
   * genuinely ARE picked up by Vitest's own watch mode without help, and a
   * forced restart means a full cold `test.projects` re-discovery plus
   * Vitest's own full initial run, not a scoped incremental one. Paying that
   * cost on every single new file, every time, would make routine
   * TDD-style "add a spec file" work needlessly slow. So each arrival gets
   * `testFileArrivalVerifyMs` to resolve on its own first: once the tests
   * signal completes a run cycle *after* the file arrived, `hasRunFile()`
   * says for certain whether Vitest actually exercised it — if so, drop it,
   * no restart needed; if a completed run demonstrably missed it, or no run
   * has completed at all by the deadline (Vitest itself may be the thing
   * that's stuck), force the cold restart, which — unlike Vitest's own
   * incremental watch — always does a full initial file glob and so
   * reliably recovers regardless of why the incremental path missed it.
   *
   * Generalized to every signal, not just the three watch-mode ones: oxlint
   * and custom-lint (FileTriggeredSignalRunner) have their own internal
   * dirty/inFlight bookkeeping to stay fresh under normal operation, but
   * that bookkeeping is itself just code and can fail in ways its own
   * try/catch/finally doesn't cover (confirmed live: `runProcess` hanging
   * forever rather than throwing leaves `inFlight` stuck true with no
   * timeout to catch it). This is exactly the gap the SEPARATE staleness
   * layer below (`checkStaleness`) exists for, for those two signals — see
   * its own doc comment. This method's own recovery mechanism stays scoped
   * to `WATCH_MODE_SIGNALS`, unchanged.
   */
  private restartWatchModeSignalsIfWedged(): void {
    this.checkPendingTestFileArrivals();

    if (!this.lastFileChangeAt) return;
    const changeAt = this.lastFileChangeAt;

    for (const signalType of WATCH_MODE_SIGNALS) {
      if (this.restartingSignals.has(signalType)) continue;
      const restartedAt = this.lastRestartAt.get(signalType);
      const referenceAt = restartedAt && restartedAt > changeAt ? restartedAt : changeAt;
      if (Date.now() - referenceAt.getTime() < this.staleWatcherGraceMs) continue;

      const runner = this.runners[signalType];
      const state = runner.getState();
      // 'pending'/'running' are still expected to move on their own; only a
      // *settled* result not provably newer than the reference point is
      // evidence the runner stopped reacting, not just that it's mid-cycle
      // (or still converging after a recent restart). Ties (equal
      // millisecond) count as stale, not fresh: wall-clock resolution isn't
      // fine enough to prove the result reflects the change, and a spurious
      // restart on a genuine tie is harmless next to missing a real wedge.
      if (state.state !== 'pass' && state.state !== 'fail') continue;
      if (state.timestamp > referenceAt) continue;
      this.restartWedgedSignal(signalType, runner);
    }
  }

  /**
   * Resolves each pending new-test-file arrival one of three ways: verified
   * picked up (drop it, no restart), confirmed missed by a completed run
   * (force a restart), or still genuinely unresolved (leave it pending for
   * the next check) — see restartWatchModeSignalsIfWedged's doc comment for
   * why this waits instead of restarting immediately. A single restart
   * clears every pending arrival, not just the one that triggered it: one
   * cold restart re-globs every test file, so any other arrivals still
   * waiting are satisfied by the same restart and don't need their own.
   */
  private checkPendingTestFileArrivals(): void {
    if (this.pendingTestFileArrivals.size === 0) return;
    if (this.restartingSignals.has(SignalType.Tests)) return;

    const testsRunner = this.runners[SignalType.Tests];
    const testsState = testsRunner.getState();
    const hasCompletedRunSince = (seenAt: Date) =>
      (testsState.state === 'pass' || testsState.state === 'fail') && testsState.timestamp > seenAt;

    let mustRestart = false;
    for (const [absPath, seenAt] of this.pendingTestFileArrivals) {
      if (hasCompletedRunSince(seenAt)) {
        if (testsRunner.hasRunFile?.(absPath)) {
          this.pendingTestFileArrivals.delete(absPath);
          continue;
        }
        mustRestart = true;
        break;
      }
      if (Date.now() - seenAt.getTime() >= this.testFileArrivalVerifyMs) {
        mustRestart = true;
        break;
      }
      // Neither verified nor timed out yet — leave it pending.
    }

    if (mustRestart) {
      this.pendingTestFileArrivals.clear();
      this.restartWedgedSignal(
        SignalType.Tests,
        testsRunner,
        'a new test file appeared and wasn\'t picked up by Vitest\'s own watch mode in time'
      );
    }
  }

  private restartWedgedSignal(
    signalType: SignalType,
    runner: ISignalRunner,
    reason = 'looks wedged (stale since before the last file change)'
  ): void {
    this.restartingSignals.add(signalType);
    this.lastRestartAt.set(signalType, new Date());
    void (async () => {
      try {
        console.error(`[QualityWatcher] ${signalType} signal for wing ${this.wingName} ${reason} — restarting it.`);
        await runner.stop();
        await runner.start();
      } catch (error) {
        console.error(`[QualityWatcher] Failed to restart wedged ${signalType} signal for wing ${this.wingName}:`, error);
      } finally {
        this.restartingSignals.delete(signalType);
      }
    })();
  }

  /**
   * SEPARATE, additional staleness-reporting layer — not a replacement for
   * `restartWatchModeSignalsIfWedged` above, which keeps detecting and
   * restarting wedged watch-mode signals exactly as it always has. This
   * method exists for two distinct reasons that method doesn't cover:
   *
   * 1. For EVERY signal (including tests/types/build), decide whether the
   *    currently cached result can actually be trusted, and if not, make
   *    that honestly visible to a caller as `SignalState`'s `stale` variant
   *    (see `buildStatus`) instead of silently letting a frozen pass/fail
   *    keep looking current while `restartWatchModeSignalsIfWedged` (for
   *    those three) works on it in the background. This check reads that
   *    method's own `lastRestartAt` (never writes it) purely so it doesn't
   *    contradict that method's grace period by flagging a signal that's
   *    merely still warming up after a restart already in flight — it never
   *    calls `restartWedgedSignal` or otherwise drives a watch-mode restart
   *    itself.
   *
   * 2. For oxlint/custom-lint (FileTriggeredSignalRunner), which have their
   *    own internal dirty/inFlight bookkeeping to stay fresh under normal
   *    operation but no equivalent of `restartWatchModeSignalsIfWedged` to
   *    fall back on if that bookkeeping itself gets stuck (confirmed live:
   *    `runProcess` hanging forever rather than throwing leaves `inFlight`
   *    stuck true, with no timeout here to catch it) — this method both
   *    reports the staleness AND is the only thing that attempts recovery
   *    for these two, via `attemptFileTriggeredRecovery`.
   *
   * Clearing a `reportedStaleSince` flag once a signal recovers is
   * `buildStatus`'s job, not this method's — it happens against whatever
   * state is actually about to be reported (which, for `awaitStatus`, can
   * be fresher than anything this method observed) rather than a second,
   * possibly-stale check here.
   */
  /**
   * The point in time `checkStaleness` (and `applyReactivityPerfAdvice`,
   * which shares this exact reasoning) measures "how long has this signal
   * gone without a fresh result" from: whichever is later of `changeAt` (the
   * last qualifying file change) or this signal's own most recent recovery
   * attempt (`lastRestartAt` for watch-mode, `lastFileTriggeredRecoveryAt`
   * for file-triggered) — a signal that was *just* restarted/recovered
   * shouldn't be judged against a change from before that recovery even
   * started.
   */
  private staleReferenceAt(signalType: SignalType, changeAt: Date): Date {
    const isWatchMode = (WATCH_MODE_SIGNALS as readonly SignalType[]).includes(signalType);
    const priorRecoveryAt = isWatchMode ? this.lastRestartAt.get(signalType) : this.lastFileTriggeredRecoveryAt.get(signalType);
    return priorRecoveryAt && priorRecoveryAt > changeAt ? priorRecoveryAt : changeAt;
  }

  private checkStaleness(): void {
    if (!this.lastFileChangeAt) return;
    const changeAt = this.lastFileChangeAt;

    for (const signalType of ALL_SIGNALS) {
      const isWatchMode = (WATCH_MODE_SIGNALS as readonly SignalType[]).includes(signalType);
      const referenceAt = this.staleReferenceAt(signalType, changeAt);
      if (Date.now() - referenceAt.getTime() < this.staleWatcherGraceMs) continue;

      const runner = this.runners[signalType];
      const state = runner.getState();
      if (state.state !== 'pass' && state.state !== 'fail') continue;
      if (state.timestamp > referenceAt) continue;

      if (!this.reportedStaleSince.has(signalType)) {
        this.reportedStaleSince.set(signalType, state.timestamp);
        this.staleCause.set(signalType, 'frozen');
      }
      if (!isWatchMode) {
        this.attemptFileTriggeredRecovery(signalType, runner);
      }
      // Watch-mode signals: report the staleness here, but leave actually
      // recovering them entirely to restartWatchModeSignalsIfWedged — never
      // call restartWedgedSignal from this method, to avoid two independent
      // checks racing to restart the same process.
    }
  }

  /**
   * Catches the case `checkStaleness` above is structurally blind to: a
   * signal that never settles to a pass/fail at all — stuck in
   * `running`/`pending` since the moment it entered that state (see
   * `state.timestamp`, set fresh on every transition), for longer than
   * `stuckRunningGraceMs`. `checkStaleness`'s frozen-result check can never
   * see this: `state.state !== 'pass' && state.state !== 'fail'` skips it
   * outright, on the reasoning ("running is exempt no matter how long the
   * actual run takes") that's correct for a run that started recently but
   * wrong once a run has been "in progress" far longer than any real run
   * should plausibly take — at that point ambiguity between "legitimately
   * slow" and "wedged" is itself the actionable fact worth reporting, per
   * `DEFAULT_STUCK_RUNNING_GRACE_MS`'s own comment.
   *
   * Deliberately does NOT attempt a restart, unlike `checkStaleness`'s
   * file-triggered branch: an in-progress run might be seconds from
   * completing a legitimately long cold start, and killing it only to
   * restart the same slow cold start again would make a merely-slow signal
   * look permanently wedged forever (the same failure mode
   * `restartWatchModeSignalsIfWedged`'s own grace period was tuned to
   * avoid). This is report-only; `staleState` reflects that honestly instead
   * of claiming a recovery attempt that never happens (see `staleCause`).
   *
   * Applies to `ALL_SIGNALS`, not just the three watch-mode ones:
   * FileTriggeredSignalRunner (oxlint/custom-lint) no longer has its own
   * "defer the launch" escape hatch (see that class's doc comment) — once
   * `ensureFresh()` launches a check it transitions straight to `running`
   * like any other signal, so it's just as capable of getting stuck there
   * forever (e.g. a hung in-process ESLint call in runCustomLint.ts, which
   * has no bounded timeout the way runOxlint.ts's subprocess does) and just
   * as much in need of this report-only backstop. `checkStaleness`'s own
   * file-triggered branch (via `attemptFileTriggeredRecovery`) still covers
   * the complementary case — a frozen settled result — for oxlint/
   * custom-lint specifically.
   */
  private checkStuckRunning(): void {
    for (const signalType of ALL_SIGNALS) {
      if (this.reportedStaleSince.has(signalType)) continue;

      const state = this.runners[signalType].getState();
      if (state.state !== 'running' && state.state !== 'pending') continue;
      if (Date.now() - state.timestamp.getTime() < this.stuckRunningGraceMs) continue;

      this.reportedStaleSince.set(signalType, state.timestamp);
      this.staleCause.set(signalType, 'stuck-running');
    }
  }

  /**
   * The only recovery mechanism oxlint/custom-lint (FileTriggeredSignalRunner)
   * have — see `checkStaleness`'s doc comment, point 2. `resetStuckState()`
   * clears whatever internal bookkeeping is blocking a fresh attempt (e.g.
   * an `inFlight` guard that never got released), and `ensureFresh()`
   * immediately tries to launch a real check. `fileTriggeredRecoveryInFlight`
   * guards against firing a second attempt for the same signal while the
   * first is still in flight, and `lastFileTriggeredRecoveryAt` is this
   * layer's own cooldown (see `checkStaleness`), fully independent of the
   * watch-mode machinery's `lastRestartAt`.
   */
  private attemptFileTriggeredRecovery(signalType: SignalType, runner: ISignalRunner): void {
    if (this.fileTriggeredRecoveryInFlight.has(signalType)) return;
    this.fileTriggeredRecoveryInFlight.add(signalType);
    this.lastFileTriggeredRecoveryAt.set(signalType, new Date());
    void (async () => {
      try {
        console.error(`[QualityWatcher] ${signalType} signal for wing ${this.wingName} looks wedged (stale since before the last relevant change) — attempting recovery.`);
        runner.resetStuckState?.();
        runner.ensureFresh?.();
      } catch (error) {
        console.error(`[QualityWatcher] Recovery attempt failed for wedged ${signalType} signal, wing ${this.wingName}:`, error);
      } finally {
        this.fileTriggeredRecoveryInFlight.delete(signalType);
      }
    })();
  }

  /**
   * `stateFor` may return a fresher result than `reportedStaleSince` last
   * knew about — in particular, `awaitStatus` calls `checkStaleness` once up
   * front and then *waits*, during which a recovery attempt can fully
   * settle, so the state it hands in here can already be the real recovered
   * result. Re-checking `staleSince` against the actual state passed in
   * (rather than trusting the map alone) means a signal that recovered
   * *during* that wait is reported as its real fresh result immediately,
   * not held back as `stale` for another poll.
   */
  private buildStatus(stateFor: (signalType: SignalType) => SignalState): QualityStatus {
    const states = Object.fromEntries(
      Object.values(SignalType).map((signalType) => {
        const actual = stateFor(signalType);
        const staleSince = this.reportedStaleSince.get(signalType);
        if (!staleSince) return [signalType, this.applyPerfDegradedAdvice(signalType, actual)];
        if (actual.timestamp > staleSince) {
          this.reportedStaleSince.delete(signalType);
          this.staleCause.delete(signalType);
          return [signalType, this.applyPerfDegradedAdvice(signalType, actual)];
        }
        return [signalType, this.staleState(signalType, staleSince)];
      })
    ) as Record<SignalType, SignalState>;

    return {
      ...states,
      aggregatedAt: new Date(),
      isPartial: Object.values(states).some((state) => state.state === 'running' || state.state === 'pending' || state.state === 'stale'),
    };
  }

  /**
   * Report-time-only "getting close to being flagged stale" advice — not a
   * distinct staleness mechanism, and never itself contributes to
   * `reportedStaleSince`/`staleCause`. Once a signal has genuinely crossed
   * one of the two staleness thresholds this shadows, the real `stale`
   * substitution above takes over and this stops applying (a `stale` state
   * isn't passed through here).
   *
   * Covers both thresholds a signal can be silently trending toward:
   * - `applyStuckRunningAdvice`: a watch-mode signal (tests/types/build)
   *   that's been `running`/`pending` continuously for over half of
   *   `stuckRunningGraceMs` — see `checkStuckRunning`, whose full-threshold
   *   case this previews.
   * - `applyReactivityAdvice`: any signal whose last settled result predates
   *   over half of `staleWatcherGraceMs` worth of "no fresh result since the
   *   last relevant change" — see `checkStaleness`, whose full-threshold
   *   case this previews.
   *
   * Surfaced via `SignalState.warnings` (see that field's own doc) rather
   * than a separate channel: it's the existing, already-wired mechanism in
   * this codebase for "worth flagging, not itself a failure" — the same one
   * `QualityStatus.applyWarningPolicy` already governs uniformly for every
   * signal, so this doesn't need its own bespoke plumbing or policy.
   */
  private applyPerfDegradedAdvice(signalType: SignalType, state: SignalState): SignalState {
    return this.applyReactivityAdvice(signalType, this.applyStuckRunningAdvice(signalType, state));
  }

  /** See `applyPerfDegradedAdvice`'s doc comment — the "trending toward `checkStuckRunning`'s full threshold" half. Applies to every signal now — see `checkStuckRunning`'s own doc comment for why oxlint/custom-lint are included. */
  private applyStuckRunningAdvice(signalType: SignalType, state: SignalState): SignalState {
    if (state.state !== 'running' && state.state !== 'pending') return state;

    const elapsedMs = Date.now() - state.timestamp.getTime();
    if (elapsedMs < this.stuckRunningGraceMs * PERF_DEGRADED_THRESHOLD_FRACTION) return state;

    const pct = Math.round((elapsedMs / this.stuckRunningGraceMs) * 100);
    const advice =
      `${signalType} quality signal has been ${state.state} for ${Math.round(elapsedMs / 1000)}s — ${pct}% of the ` +
      `${Math.round(this.stuckRunningGraceMs / 1000)}s threshold before it's reported as stuck (see checkStuckRunning). ` +
      `Performance looks degraded — investigate and speed up this check before it crosses that threshold.`;
    return { ...state, warnings: [...(state.warnings ?? []), advice] };
  }

  /** See `applyPerfDegradedAdvice`'s doc comment — the "trending toward `checkStaleness`'s full threshold" half. */
  private applyReactivityAdvice(signalType: SignalType, state: SignalState): SignalState {
    if (!this.lastFileChangeAt) return state;
    if (state.state !== 'pass' && state.state !== 'fail') return state;

    const referenceAt = this.staleReferenceAt(signalType, this.lastFileChangeAt);
    const elapsedMs = Date.now() - referenceAt.getTime();
    if (elapsedMs < this.staleWatcherGraceMs * PERF_DEGRADED_THRESHOLD_FRACTION) return state;
    if (state.timestamp > referenceAt) return state;

    const pct = Math.round((elapsedMs / this.staleWatcherGraceMs) * 100);
    const advice =
      `${signalType} quality signal hasn't produced a fresh result since ${referenceAt.toISOString()} ` +
      `(${Math.round(elapsedMs / 1000)}s ago — ${pct}% of the ${Math.round(this.staleWatcherGraceMs / 1000)}s threshold ` +
      `before it's reported as stale, see checkStaleness). Performance looks degraded — investigate and speed up this ` +
      `check before it crosses that threshold.`;
    return { ...state, warnings: [...(state.warnings ?? []), advice] };
  }

  /**
   * Builds the honest, advice-free `stale` reading substituted for a wedged
   * signal — see SignalState's doc for why this deliberately carries no
   * failures/warnings from the frozen result it's replacing, even if that
   * result happened to be a `fail`: the point is that it's no longer known
   * to be current, not that it's known to be clean. Message content branches
   * on `staleCause` (see that field's own doc): the `'frozen'` case (a
   * settled result stopped updating — `checkStaleness`) truthfully describes
   * an automatic recovery attempt; the `'stuck-running'` case
   * (`checkStuckRunning` — never settled at all) makes none, so its message
   * says so instead of a false promise, and explicitly names the
   * legitimately-slow-vs-wedged ambiguity so a calling agent knows why
   * nothing is being auto-restarted for it.
   */
  private staleState(signalType: SignalType, staleSince: Date): SignalState {
    const cause = this.staleCause.get(signalType) ?? 'frozen';
    const ageMs = Date.now() - staleSince.getTime();
    const ageS = Math.round(ageMs / 1000);

    if (cause === 'stuck-running') {
      return {
        state: 'stale',
        timestamp: new Date(),
        staleSince,
        message:
          `${signalType} quality signal has been running/pending continuously since ${staleSince.toISOString()} ` +
          `(${ageS}s ago) without ever settling to a pass or fail. This is not a pass or a fail — the true current ` +
          `state is unknown. This may simply be a legitimately long-running check (a cold start, or a full run on a ` +
          `large codebase, can take a while), or the underlying process may be wedged — no automatic restart is ` +
          `attempted for a still-running check, since forcibly killing a near-complete run would be worse than ` +
          `waiting. If this persists well beyond what a normal run should reasonably take, treat it as a broken tool ` +
          `to investigate/escalate directly (check whether the underlying watch process for this signal is still ` +
          `alive and making progress), not as a quality result to act on.`,
      };
    }

    const recovering = this.restartingSignals.has(signalType) || this.fileTriggeredRecoveryInFlight.has(signalType);
    return {
      state: 'stale',
      timestamp: new Date(),
      staleSince,
      message:
        `${signalType} quality signal is currently broken: its last real result is from ${staleSince.toISOString()} ` +
        `(${ageS}s ago) and it has not produced a fresh one since, despite a more recent relevant ` +
        `change. This is not a pass or a fail — the true current state is unknown. ` +
        (recovering
          ? 'An automatic recovery attempt is in progress right now; retry shortly.'
          : 'An automatic recovery attempt will be made on the next check.') +
        ' If this keeps recurring across retries, treat it as a broken tool to investigate/escalate, not as a quality result to act on.',
    };
  }

  /**
   * Subscribes to StateChanged BEFORE ever reading `runner.getState()` —
   * not the other way around — specifically so a signal that settles
   * between "subscribe" and "read" can't fall through a gap and eat the
   * full `maxWaitMs` timeout despite already having a real result.
   *
   * Subscribing alone isn't enough, though: `EventBus.on()` (see
   * @minions/events) forks a background Effect fiber to actually pump
   * events rather than attaching synchronously — confirmed live, a signal
   * fast enough to settle in that same tick has its event missed entirely
   * even when `on()` is called first. This codebase's own tests elsewhere
   * work around the exact same gap by giving that fiber one tick
   * (`setTimeout(..., 0)`) before relying on it — the single deferred
   * check below does the same: by the time it runs, the listener above is
   * guaranteed live, so anything that settles from that point on is caught
   * by it, and this check itself catches anything that already happened up
   * through then (whether before this method was even called, or during
   * the fiber's own attachment window). One scheduled check, not a poll
   * loop — it doesn't repeat, and it isn't racing the listener, it's
   * covering the one window the listener provably can't.
   */
  private awaitSettledOrTimeout(runner: ISignalRunner, maxWaitMs: number): Promise<SignalState> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (state: SignalState) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(attachCheck);
        unsubscribe();
        resolve(state);
      };
      const timer = setTimeout(() => finish(runner.getState()), maxWaitMs);
      const unsubscribe = this.eventBus.on(SignalRunnerEvents.StateChanged, (event) => {
        if (event.signalType !== runner.signalType) return;
        // A WingQualityWatcher's repo watchers share one eventBus, so a
        // same-signalType StateChanged event can come from another repo's
        // runner of the same type — the event itself doesn't say which
        // runner emitted it. Re-read this specific runner's own state
        // rather than trusting event.state, so a same-typed sibling
        // settling never resolves this wait early with someone else's
        // result.
        const current = runner.getState();
        if (current.state === 'pass' || current.state === 'fail') {
          finish(current);
        } else if (current.state === 'running' && current.failures.length > 0) {
          finish(current);
        }
      });
      const attachCheck = setTimeout(() => {
        const initial = runner.getState();
        if (initial.state === 'pass' || initial.state === 'fail') finish(initial);
      }, 0);
    });
  }
}
