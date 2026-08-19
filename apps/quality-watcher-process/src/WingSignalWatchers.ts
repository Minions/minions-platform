/**
 * One wing's collection of per-repo signal watchers — one `VitestSignalRunner`
 * (Tests), one `VueTscWatchSignalRunner` (Types), one
 * `ViteBuildWatchSignalRunner` (Build), and one `FileTriggeredSignalRunner`
 * each for OxLint and CustomLint, per work repo, mirroring
 * `QualityWatcher`/`WingQualityWatcher`'s existing composition shape (all
 * five signals, same runner classes — this process just hosts them instead
 * of Cabinet's own process). The two `FileTriggeredSignalRunner`s share one
 * fs.watch handle per repo (see `createSharedFsWatch`), same convention as
 * `QualityWatcher` itself.
 *
 * `pause()`/`resume()` are a wing-level concept (see
 * docs/design/quality-watcher-process-redesign.md): they fan out to every
 * runner across every repo, best-effort — a runner without the capability
 * (`ISignalRunner.pause?`/`resume?` absent) is silently skipped, not an
 * error. Every runner here — OxLint/CustomLint included — implements
 * pause()/resume() uniformly (see FileTriggeredSignalRunner's own doc
 * comment for why it no longer needs its own independent git-operation
 * defense the way it once did), so this class never needs to special-case
 * any particular signal.
 */
import type { IEventBus } from '@minions/events';
import { EventBus } from '@minions/events';
import {
  SignalType,
  allPendingQualityStatus,
  mergeQualityStatuses,
  VitestSignalRunner,
  VueTscWatchSignalRunner,
  ViteBuildWatchSignalRunner,
  FileTriggeredSignalRunner,
  runOxlint,
  runCustomLint,
  createSharedFsWatch,
  SignalWedgeMonitor,
  type ISignalRunner,
  type SignalState,
  type QualityStatus,
} from '@minions/quality-watcher';
import { RepoFileChangeTracker } from './RepoFileChangeTracker.js';

export type RunnerFactory = (repoPath: string, eventBus: IEventBus) => ISignalRunner[];
export type WedgeMonitorFactory = (eventBus: IEventBus) => SignalWedgeMonitor;
export type ChangeTrackerFactory = (repoPath: string) => RepoFileChangeTracker;

/** How often awaitStatus() re-polls getStatus() while waiting for a running/pending/stale signal to settle. */
const DEFAULT_AWAIT_STATUS_POLL_MS = 100;

/**
 * How long a newly-arrived test file gets to show up in a completed Vitest
 * run before its restart is forced unconditionally — ported from the old
 * in-process QualityWatcher's own `testFileArrivalVerifyMs`/
 * `DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS` (5s there too). Most new test files
 * ARE picked up by Vitest's own watch mode on their own — confirmed live
 * against apps/throne-room, a real 110-source-file repo: a brand-new test
 * file was exercised in a completed run 672-979ms after arrival, across
 * three separate measurements — so this window exists purely to bound the
 * rare case where Vitest's own incremental watch misses one (confirmed in
 * production), not to cover the common, fast path.
 */
const DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS = 5_000;

function defaultRunnerFactory(repoPath: string, eventBus: IEventBus): ISignalRunner[] {
  // Scoped to this one repo/call — createSharedFsWatch dedupes by watched
  // path, and OxLint/CustomLint below are the only two runners here that
  // watch the filesystem directly (Tests/Types/Build each attach to their
  // own tool's watch mode instead), so a fresh instance per repo is exactly
  // right: it's shared between exactly those two, and nothing else.
  const sharedWatchFs = createSharedFsWatch();
  return [
    new VitestSignalRunner(repoPath, eventBus),
    new VueTscWatchSignalRunner(repoPath, eventBus),
    new ViteBuildWatchSignalRunner(repoPath, eventBus),
    new FileTriggeredSignalRunner(SignalType.OxLint, 'oxlint', repoPath, eventBus, runOxlint, undefined, sharedWatchFs),
    new FileTriggeredSignalRunner(SignalType.CustomLint, 'custom-lint', repoPath, eventBus, runCustomLint, undefined, sharedWatchFs),
  ];
}

/**
 * One repo's signal states (keyed by whichever `SignalType`s it actually has
 * runners for), padded out to a full QualityStatus (everything else pending)
 * so `mergeQualityStatuses` can combine it with its siblings. Reading from a
 * lookup rather than named per-signal parameters means the next signal
 * (Build) drops in here without changing this function's signature again.
 */
function buildRepoStatus(states: Partial<Record<SignalType, SignalState>>, now: Date): QualityStatus {
  const pending: SignalState = { state: 'pending', timestamp: now };
  const get = (signalType: SignalType): SignalState => states[signalType] ?? pending;
  return {
    [SignalType.Tests]: get(SignalType.Tests),
    [SignalType.Types]: get(SignalType.Types),
    [SignalType.Build]: get(SignalType.Build),
    [SignalType.OxLint]: get(SignalType.OxLint),
    [SignalType.CustomLint]: get(SignalType.CustomLint),
    aggregatedAt: now,
    isPartial: Object.values(states).some((state) => state.state === 'running' || state.state === 'pending' || state.state === 'stale'),
  };
}

/**
 * `SignalWedgeMonitor`'s own defaults (see its doc comments) are already
 * tiny and apply uniformly to every signal here — no per-signal override
 * table at all. Two things make that safe:
 *
 * - `staleGraceMs` (how long a settled pass/fail may sit stale before a
 *   relevant change): a `FileTriggeredSignalRunner` (OxLint/CustomLint) is
 *   deliberately lazy — only reacts to a status read calling
 *   `ensureFresh()`, not to elapsed time on its own (see that class's own
 *   doc comment) — but `checkForWedges()` below calls `ensureFresh()` on
 *   every runner before checking, so it gets the exact same fair chance to
 *   react before being judged as any watch-mode signal.
 *
 * - `idlePatienceMs` (how long a signal may sit *actively working* before
 *   being judged stuck): this used to genuinely vary by tool — measured
 *   live against this repo's real monorepo, oxlint took ~1.7s but
 *   custom-lint (non-type-aware ESLint, real work over a big repo) took
 *   ~27s, which would have false-positived under a uniform tiny default.
 *   `runCustomLint.ts` no longer runs as one opaque batch call, though: it
 *   lints file by file over the same warm ESLint instance (measured
 *   near-identical total cost — 15524ms batch vs 15900ms per-file over 832
 *   real files) and reports a real completion tick after every file via
 *   `ProcessRunner`'s `onActivity`, which `FileTriggeredSignalRunner` wires
 *   straight into `lastActivityAt()`. That per-file cadence (measured
 *   max gap: 215ms) is what the tiny default is actually being measured
 *   against now, not custom-lint's total wall-clock time — so total
 *   runtime can keep growing as the ruleset/repo grows without ever
 *   needing this table's help again.
 */

/**
 * A signal a `SignalWedgeMonitor` currently believes is wedged reports as
 * `stale` here rather than whatever frozen/stuck result the runner's own
 * `getState()` still returns — see `SignalState`'s own doc comment for why
 * that distinction matters to a caller (the movement commit gate in
 * particular): a frozen `pass` masquerading as current is worse than
 * honestly saying "unknown, recovery in progress." A signal that's merely
 * trending toward that (see `SignalWedgeMonitor.trendingWarning`) gets an
 * advisory warning folded in instead, ported from the old in-process
 * QualityWatcher's own `applyPerfDegradedAdvice`.
 */
function reportedStateFor(runner: ISignalRunner, monitor: SignalWedgeMonitor | undefined, referenceAt: Date, now: Date): SignalState {
  const wedge = monitor?.wedgeInfo(runner.signalType);
  if (wedge) {
    const ageS = Math.round((now.getTime() - wedge.wedgedSince.getTime()) / 1000);
    return {
      state: 'stale',
      timestamp: now,
      staleSince: wedge.wedgedSince,
      message:
        `${runner.signalType} quality signal looks wedged as of ${wedge.wedgedSince.toISOString()} ` +
        `(${ageS}s ago) — no fresh result since, despite a more recent relevant change (or it never settled ` +
        `at all). This is not a pass or a fail — the true current state is unknown. An automatic recovery ` +
        `attempt is in progress right now; retry shortly. If this keeps recurring across retries, treat it ` +
        `as a broken tool to investigate/escalate, not as a quality result to act on.`,
    };
  }

  const state = runner.getState();
  const trending = monitor?.trendingWarning(runner.signalType, runner, state, referenceAt, now);
  if (!trending) return state;
  return { ...state, warnings: [...(state.warnings ?? []), trending] };
}

export class WingSignalWatchers {
  private readonly repoRunners = new Map<string, ISignalRunner[]>();
  private readonly repoWedgeMonitors = new Map<string, SignalWedgeMonitor>();
  private readonly repoChangeTrackers = new Map<string, RepoFileChangeTracker>();

  constructor(
    private readonly eventBus: IEventBus = new EventBus(),
    private readonly createRunners: RunnerFactory = defaultRunnerFactory,
    private readonly createWedgeMonitor: WedgeMonitorFactory = (bus) => new SignalWedgeMonitor(bus),
    private readonly createChangeTracker: ChangeTrackerFactory = (repoPath) => new RepoFileChangeTracker(repoPath),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly testFileArrivalVerifyMs: number = DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS,
  ) {}

  /** Idempotent per repo alias — an alias already being watched is left alone, so calling this again with the same repoPaths is safe. */
  async start(repoPaths: Record<string, string>): Promise<void> {
    const newlyAdded: ISignalRunner[] = [];
    for (const [repoAlias, repoPath] of Object.entries(repoPaths)) {
      if (this.repoRunners.has(repoAlias)) continue;
      const runners = this.createRunners(repoPath, this.eventBus);
      this.repoRunners.set(repoAlias, runners);
      this.repoWedgeMonitors.set(repoAlias, this.createWedgeMonitor(this.eventBus));
      this.repoChangeTrackers.set(repoAlias, this.createChangeTracker(repoPath));
      newlyAdded.push(...runners);
    }
    await Promise.all(newlyAdded.map((runner) => runner.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.allRunners().map((runner) => runner.stop()));
    this.repoRunners.clear();
    for (const tracker of this.repoChangeTrackers.values()) tracker.close();
    this.repoChangeTrackers.clear();
    this.repoWedgeMonitors.clear();
  }

  /**
   * Tier 1 of the three-tier resilience design (see
   * docs/design/quality-watcher-process-redesign.md): checks every repo's
   * runners — every signal, no special-casing by `strategy` or `SignalType`
   * at all now (see the doc comment above) — for a wedge, driving each
   * repo's own `SignalWedgeMonitor` recovery ladder. A
   * runner with no cheap `pause()`/`resume()` (or no `lastActivityAt()`)
   * just falls back to that monitor's own degraded paths (a full
   * stop()/start() recovery stage; a coarser `state.timestamp`-based
   * liveness check) — this method itself doesn't need to know which.
   *
   * Calls `ensureFresh()` on every runner first — the only thing that ever
   * launches a check for a `FileTriggeredSignalRunner` — so a dirty
   * OxLint/CustomLint gets exactly the same chance to react on this tick as
   * it would on a status read, before `monitor.check()` judges whether it
   * reacted in time. Without this, a wedge check running on its own
   * schedule (independent of whether anyone's reading status) would judge
   * a signal that simply hasn't been asked yet as wedged, against the
   * now-tiny `staleGraceMs` default.
   *
   * Intended to be called on a periodic timer by the process's thin wiring
   * (see server.ts) — a plain method here, not a timer itself, so tests can
   * call it with an explicit `now` and no real clock.
   */
  async checkForWedges(now: Date): Promise<void> {
    for (const [repoAlias, runners] of this.repoRunners) {
      const monitor = this.repoWedgeMonitors.get(repoAlias);
      if (!monitor) continue;
      const referenceAt = this.repoChangeTrackers.get(repoAlias)?.lastRelevantChangeAt() ?? now;
      for (const runner of runners) {
        runner.ensureFresh?.();
        await monitor.check(runner.signalType, runner, referenceAt, now);
      }
    }
  }

  /**
   * Tier 2 entry point (see docs/design/quality-watcher-process-redesign.md):
   * an on-demand trigger for the exact same per-repo `SignalWedgeMonitor.check()`
   * that Tier 1's own periodic `checkForWedges()` drives — not a second
   * recovery mechanism. Naturally idempotent: `check()` itself judges
   * whether the runner actually looks wedged right now, using the same
   * evidence-based judgment as everywhere else in this class, so calling
   * this for a signal that's merely slow but still producing activity is a
   * safe no-op — nothing recovers, nothing restarts.
   *
   * `repoAlias` omitted checks every repo this signal exists in — cabinet's
   * own view of a wing is a single merged status across all its repos (see
   * `QualityWedgeBackstop`), not a per-repo breakdown, so it can only ever
   * name a wing + signal, never a specific repo.
   *
   * Returns one entry per repo actually checked (a repo with no runner for
   * this signalType, or a repoAlias that doesn't exist, contributes
   * nothing), each naming whether the signal is wedged right after this
   * call.
   */
  async unwedge(signalType: SignalType, repoAlias?: string): Promise<Array<{ repoAlias: string; wedged: boolean }>> {
    const now = new Date();
    const aliases = repoAlias !== undefined
      ? (this.repoRunners.has(repoAlias) ? [repoAlias] : [])
      : Array.from(this.repoRunners.keys());
    const results: Array<{ repoAlias: string; wedged: boolean }> = [];
    for (const alias of aliases) {
      const monitor = this.repoWedgeMonitors.get(alias);
      const runner = this.repoRunners.get(alias)?.find((r) => r.signalType === signalType);
      if (!runner || !monitor) continue;
      const referenceAt = this.repoChangeTrackers.get(alias)?.lastRelevantChangeAt() ?? now;
      runner.ensureFresh?.();
      await monitor.check(signalType, runner, referenceAt, now);
      results.push({ repoAlias: alias, wedged: monitor.isWedged(signalType) });
    }
    return results;
  }

  async pause(): Promise<void> {
    await Promise.all(this.allRunners().map((runner) => runner.pause?.() ?? Promise.resolve()));
  }

  async resume(): Promise<void> {
    await Promise.all(this.allRunners().map((runner) => runner.resume?.() ?? Promise.resolve()));
  }

  isRunning(): boolean {
    return this.repoRunners.size > 0;
  }

  /**
   * `ensureFresh()` is a status read's only way to launch a check for a
   * `FileTriggeredSignalRunner` (OxLint/CustomLint — see its own doc
   * comment): a no-op if its cached result is still valid or a check is
   * already in flight, so calling it on every read is always safe and is
   * the only thing that actually triggers a first/next run for those two
   * signals. Watch-mode runners (Tests/Types/Build) don't implement this
   * at all — they're always continuously live — so this is a no-op for them.
   *
   * Any signal its repo's `SignalWedgeMonitor` currently considers wedged
   * reports `stale` instead of the runner's own (possibly frozen/stuck)
   * `getState()` — see `reportedStateFor`.
   */
  getStatus(): QualityStatus {
    const now = new Date();
    if (this.repoRunners.size === 0) return allPendingQualityStatus(now);
    const perRepo = Array.from(this.repoRunners.entries(), ([repoAlias, runners]) => {
      const monitor = this.repoWedgeMonitors.get(repoAlias);
      const referenceAt = this.repoChangeTrackers.get(repoAlias)?.lastRelevantChangeAt() ?? now;
      this.checkNewTestFileArrivals(repoAlias, runners, now);
      const states = Object.fromEntries(
        runners.map((runner) => {
          runner.ensureFresh?.();
          return [runner.signalType, reportedStateFor(runner, monitor, referenceAt, now)];
        }),
      ) as Partial<Record<SignalType, SignalState>>;
      return [repoAlias, buildRepoStatus(states, now)] as const;
    });
    return mergeQualityStatuses(perRepo);
  }

  /**
   * Resolves each pending new-test-file arrival (see
   * `RepoFileChangeTracker.pendingTestFileArrivals`) one of three ways:
   * verified picked up (drop it, no restart), confirmed missed by a
   * completed run (force a restart), or still genuinely unresolved (leave
   * it pending for the next check) — ported from the old in-process
   * QualityWatcher's `checkPendingTestFileArrivals`. Only meaningful for a
   * repo's Tests runner (the only one with `hasRunFile()`) — a no-op for
   * every other signal, and a no-op entirely once `VitestSignalRunner`
   * confirms Vitest's own watch mode already noticed the arrival, which is
   * the common case (see this class's own `DEFAULT_TEST_FILE_ARRIVAL_VERIFY_MS`
   * doc comment for live timing).
   *
   * Fire-and-forget, like the old system's own `restartWedgedSignal`:
   * `getStatus()` must stay a fast, synchronous read, not block on a
   * restart actually completing — the very next read naturally reflects
   * the in-progress restart as `pending`/`running`.
   */
  private checkNewTestFileArrivals(repoAlias: string, runners: ISignalRunner[], now: Date): void {
    const tracker = this.repoChangeTrackers.get(repoAlias);
    if (!tracker) return;
    const arrivals = tracker.pendingTestFileArrivals();
    if (arrivals.size === 0) return;
    const testsRunner = runners.find((runner) => runner.signalType === SignalType.Tests);
    if (!testsRunner?.hasRunFile) return;

    const state = testsRunner.getState();
    const hasCompletedRunSince = (seenAt: Date) => (state.state === 'pass' || state.state === 'fail') && state.timestamp > seenAt;

    let mustRestart = false;
    for (const [absPath, seenAt] of arrivals) {
      if (hasCompletedRunSince(seenAt)) {
        if (testsRunner.hasRunFile(absPath)) {
          tracker.clearTestFileArrival(absPath);
          continue;
        }
        mustRestart = true;
        break;
      }
      if (now.getTime() - seenAt.getTime() >= this.testFileArrivalVerifyMs) {
        mustRestart = true;
        break;
      }
      // Neither verified nor timed out yet — leave it pending.
    }

    if (!mustRestart) return;
    tracker.clearAllTestFileArrivals();
    void (async () => {
      try {
        console.error(`[WingSignalWatchers] a new test file appeared and wasn't picked up by Vitest's own watch mode in time — restarting the tests signal.`);
        await testsRunner.stop();
        await testsRunner.start();
      } catch (error) {
        console.error('[WingSignalWatchers] failed to restart tests signal after a missed test-file arrival:', error);
      }
    })();
  }

  /**
   * `getStatus()` returns whatever's currently true, immediately —
   * `awaitStatus()` is for a caller that wants a real settled answer (the
   * movement commit gate in particular) and is willing to wait up to
   * `maxWaitMs` for one: polls `getStatus()` (so every read still triggers
   * ensureFresh()/wedge substitution exactly as normal) until it's no
   * longer partial (see `QualityStatus.isPartial` — every signal is
   * pass/fail, none running/pending/stale) or the deadline passes,
   * whichever comes first, then returns whatever that last read was.
   *
   * Deliberately a plain poll, not an event-subscription wait like the old
   * in-process `QualityWatcher.awaitSettledOrTimeout` — this now aggregates
   * across every signal of every repo in one call, and polling `getStatus()`
   * directly reuses its own settling logic instead of duplicating it against
   * a lower-level event stream (see also the EventBus subscription-timing
   * gap `QualityWatcher.awaitSettledOrTimeout` had to work around, which a
   * poll doesn't have in the first place).
   */
  async awaitStatus(maxWaitMs: number): Promise<QualityStatus> {
    // A wing with no repos started at all has nothing to ever settle —
    // `getStatus()`'s own all-pending placeholder is `isPartial: true` by
    // definition (see `allPendingQualityStatus`), which would otherwise
    // make this spin for the full `maxWaitMs` waiting for a change that
    // can never happen.
    if (!this.isRunning()) return this.getStatus();

    const deadline = Date.now() + maxWaitMs;
    let status = this.getStatus();
    while (status.isPartial && Date.now() < deadline) {
      await this.sleep(DEFAULT_AWAIT_STATUS_POLL_MS);
      status = this.getStatus();
    }
    return status;
  }

  private allRunners(): ISignalRunner[] {
    return Array.from(this.repoRunners.values()).flat();
  }
}
