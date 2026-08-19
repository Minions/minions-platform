/**
 * Tracks the most recent filesystem change under one repo path, filtered
 * the same way `FileTriggeredSignalRunner` already filters oxlint/
 * custom-lint's own fs.watch (`isIgnoredPath` — node_modules, .git, build
 * output, ...). Feeds `SignalWedgeMonitor.check()`'s `referenceAt`
 * parameter: "has this watch-mode signal produced a fresh result since the
 * last relevant change" only makes sense relative to a real change, not
 * build-tool churn the signal itself would rightly ignore too.
 *
 * Also tracks brand-new test-file arrivals specifically (a 'rename' event
 * — Node's fs.watch signal for a path appearing/disappearing/renaming, as
 * opposed to 'change', an edit to a file Vitest already knows about —
 * matching Vitest's own test-file naming) on the SAME underlying fs.watch
 * handle rather than opening a second one. This is what lets
 * `WingSignalWatchers` verify a new test file actually got exercised (see
 * its own `checkNewTestFileArrivals`, ported from the old in-process
 * QualityWatcher's `checkPendingTestFileArrivals`/`restartWatchModeSignalsIfWedged`)
 * instead of trusting Vitest's own incremental watch unconditionally —
 * confirmed live, in production, that it can silently miss one.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { isIgnoredPath, TEST_FILE_PATTERN } from '@minions/quality-watcher';

export class RepoFileChangeTracker {
  private lastChangeAt: Date | null = null;
  private readonly handle: FSWatcher;
  private readonly arrivals = new Map<string, Date>();

  constructor(repoPath: string, watchFsImpl: typeof fsWatch = fsWatch) {
    this.handle = watchFsImpl(repoPath, { recursive: true }, (eventType, filename) => {
      if (isIgnoredPath(filename)) return;
      this.lastChangeAt = new Date();
      if (eventType === 'rename' && filename && TEST_FILE_PATTERN.test(filename)) {
        const absPath = path.resolve(repoPath, filename);
        if (!this.arrivals.has(absPath)) this.arrivals.set(absPath, new Date());
      }
    });
  }

  /** Null if no relevant change has been observed since this tracker started. */
  lastRelevantChangeAt(): Date | null {
    return this.lastChangeAt;
  }

  /** Absolute paths of new test files seen via 'rename', not yet confirmed picked up (or force-restarted) — keyed by when each first arrived. */
  pendingTestFileArrivals(): ReadonlyMap<string, Date> {
    return this.arrivals;
  }

  clearTestFileArrival(absPath: string): void {
    this.arrivals.delete(absPath);
  }

  clearAllTestFileArrivals(): void {
    this.arrivals.clear();
  }

  close(): void {
    this.handle.close();
  }
}
