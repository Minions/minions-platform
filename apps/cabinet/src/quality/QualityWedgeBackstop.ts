/**
 * Tier 2 of the three-tier crash/wedge resilience design (see
 * docs/design/quality-watcher-process-redesign.md): cabinet's own
 * independent staleness backstop over every wing's live
 * `RemoteQualityWatcher`-backed signal state, distinct from (and secondary
 * to) the in-process `SignalWedgeMonitor` (Tier 1) that already runs inside
 * the watcher process on every wedge-check tick. This exists specifically
 * for the case Tier 1 itself failed to notice or act — that process under
 * load, or a bug in its own detection — not as a faster or more precise
 * detector than Tier 1.
 *
 * On each tick, `check()` actively refreshes (`awaitStatus()`, no wait) the
 * cache of every currently-running `RemoteQualityWatcher`, then applies the
 * same coarse "no fresh result in N minutes" heuristic cabinet already uses
 * elsewhere (see `WingActivityTracker.INACTIVE_GRACE_MS`) to each signal's
 * own `timestamp`. A signal it judges possibly stuck gets an explicit
 * `POST /unwedge {wing, signalType}` to the watcher process — the *same*
 * per-signal recovery path (`WingSignalWatchers.unwedge`) Tier 1's own
 * periodic check drives, not a second mechanism. This makes false positives
 * cheap and safe by construction: the watcher process re-judges wedged-or-
 * not using its own real, fine-grained evidence (activity ticks, not just a
 * timestamp) before doing anything, so a genuinely healthy-but-slow signal
 * (e.g. CustomLint mid-run) is always a no-op there, regardless of how
 * coarse cabinet's own guess was.
 */
import { SignalType, RemoteQualityWatcher, type IQualityWatcher, type QualityStatus } from '@minions/quality-watcher';

/**
 * How long a `running`/`pending` signal may sit at the same timestamp before
 * cabinet treats it as possibly stuck. Deliberately much larger than Tier
 * 1's own worst-case recovery window — Tier 2 exists to catch a wedge Tier 1
 * itself missed, not to race it or duplicate its job with a coarser,
 * timestamp-only heuristic. That worst case is gated by
 * `WEDGE_CHECK_INTERVAL_MS` (15s, `apps/quality-watcher-process/src/server.ts`),
 * not just `SignalWedgeMonitor`'s own `staleGraceMs`/`escalateAfterMs`
 * defaults: `SignalWedgeMonitor.check()` only actually runs on whatever 15s
 * tick lands after a threshold is crossed, and the pause-resume → kill-
 * recreate escalation is likewise only evaluated on the next tick after
 * `escalateAfterMs` has elapsed — so detection can lag up to one full
 * interval, and escalation up to another, before a kill-recreate attempt
 * even starts. Worst case is therefore close to 2 * WEDGE_CHECK_INTERVAL_MS
 * (~30s), not the sub-15s the raw `staleGraceMs`/`escalateAfterMs` constants
 * alone would suggest. 90s still gives Tier 1 a healthy ~3x margin over that
 * real worst case to have already recovered on its own before this ever
 * fires — and Tier 1's own `'stale'` substitution (see
 * `WingSignalWatchers.reportedStateFor`) means Tier 2 never even observes a
 * signal Tier 1 is already in the middle of recovering, so this bound only
 * matters for a wedge Tier 1's own detection genuinely missed.
 */
const DEFAULT_STALE_BOUND_MS = 90_000;

/** How often `start()`'s own timer drives a check. */
const DEFAULT_CHECK_INTERVAL_MS = 20_000;

/**
 * Pure: which (wing, signal) pairs, across the given per-wing statuses, look
 * possibly stuck as of `now` — a `running`/`pending` signal whose own
 * `timestamp` hasn't moved in at least `staleBoundMs`. `pass`/`fail` are
 * settled results, not evidence of anything stuck; `stale` means the
 * watcher process itself already knows and is already recovering it (Tier
 * 1's own job, nothing for this backstop to add).
 */
export function findStuckSignals(
  entries: ReadonlyArray<readonly [string, QualityStatus]>,
  now: Date,
  staleBoundMs: number,
): Array<{ wingName: string; signalType: SignalType }> {
  const stuck: Array<{ wingName: string; signalType: SignalType }> = [];
  for (const [wingName, status] of entries) {
    for (const signalType of Object.values(SignalType)) {
      const state = status[signalType];
      if (state.state !== 'running' && state.state !== 'pending') continue;
      if (now.getTime() - state.timestamp.getTime() < staleBoundMs) continue;
      stuck.push({ wingName, signalType });
    }
  }
  return stuck;
}

function isRunningRemoteWatcher(watcher: IQualityWatcher): watcher is RemoteQualityWatcher {
  return watcher instanceof RemoteQualityWatcher && watcher.isRunning();
}

export class QualityWedgeBackstop {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getWatchers: () => ReadonlyMap<string, IQualityWatcher>,
    private readonly getBaseUrl: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly staleBoundMs: number = DEFAULT_STALE_BOUND_MS,
    private readonly checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
  ) {}

  /** Starts the periodic check timer. Unref'd so it never keeps cabinet alive on its own; idempotent — a second call while already started is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check(new Date()).catch((err: unknown) => {
        console.error('[QualityWedgeBackstop] check failed:', err);
      });
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One check tick — a plain method taking an explicit `now`, not a timer
   * itself, so tests never need real timers (mirrors
   * `WingWatcherRegistry.checkForWedges`'s own shape on the watcher-process
   * side). Only running `RemoteQualityWatcher`s are considered — the old
   * in-process `WingQualityWatcher` has its own resilience story, and a
   * cooled-down (stopped) wing has nothing live to be stuck.
   */
  async check(now: Date): Promise<void> {
    const running = [...this.getWatchers().entries()].filter(
      (entry): entry is [string, RemoteQualityWatcher] => isRunningRemoteWatcher(entry[1]),
    );
    if (running.length === 0) return;

    await Promise.all(
      running.map(([, watcher]) =>
        watcher.awaitStatus().catch((err: unknown) => {
          console.error('[QualityWedgeBackstop] failed to refresh status before checking for staleness:', err);
        }),
      ),
    );

    const stuck = findStuckSignals(
      running.map(([wingName, watcher]) => [wingName, watcher.getStatus()] as const),
      now,
      this.staleBoundMs,
    );
    if (stuck.length === 0) return;

    const baseUrl = await this.getBaseUrl();
    for (const { wingName, signalType } of stuck) {
      await this.sendUnwedge(baseUrl, wingName, signalType);
    }
  }

  private async sendUnwedge(baseUrl: string, wingName: string, signalType: SignalType): Promise<void> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/unwedge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wing: wingName, signalType }),
      });
      if (!response.ok) {
        console.error(`[QualityWedgeBackstop] unwedge ${wingName}/${signalType} returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.error(`[QualityWedgeBackstop] failed to send unwedge for ${wingName}/${signalType}:`, err);
    }
  }
}
