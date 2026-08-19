/**
 * File-Triggered Signal Runner
 *
 * ISignalRunner adapter for signal sources with no watch mode of their own —
 * oxlint and custom-rules ESLint today. Watches the wing's checkout for file
 * changes (debounced, same scoping/filtering as before) but a change only
 * *invalidates* the cached result — it does not launch a fresh check.
 * Actually running the (fast but still real) one-shot process is deferred
 * until the next status read finds no valid cached result and calls
 * ensureFresh() — see QualityWatcher.getStatus/awaitStatus. A status check
 * always wants a result for the current codebase, so there's no separate
 * "force" path: ensureFresh() is the only way in, called on every read.
 *
 * Unlike Tests/Types/Build (Vitest, vue-tsc, Vite — each has its own
 * persistent watch process/API this library attaches to directly), oxlint
 * and custom-lint have no such mode: each check is a fresh, if fast,
 * one-shot run, so there's no benefit to running one on every file change
 * nobody has asked about yet.
 *
 * `pause()`/`resume()` make this operate from the outside exactly like the
 * watch-mode runners (see ISignalRunner.pause's doc comment), by design —
 * this runner does NOT independently defer while a git rebase/merge/
 * cherry-pick/revert is in progress (an earlier version did, checking
 * `isGitOperationInProgress` on every launch); it relies entirely on the
 * caller (WingSignalWatchers, driven by cabinet around `movement start`/
 * `merge`/`promote` — see docs/design/quality-watcher-process-redesign.md)
 * to pause() it first, same as every other signal. This means the watcher
 * process needs no signal-specific special-casing anywhere, and this runner
 * can safely participate in Tier 1 wedge recovery (SignalWedgeMonitor) like
 * any other, even though nothing about its own design requires that.
 * pause() stops the fs.watch outright (no work at all while paused, not
 * just "don't act on it yet") and abandons whatever check is currently in
 * flight; resume() re-arms the watch and unconditionally launches a fresh
 * check, mirroring VitestSignalRunner.resume()'s "reattaching alone would
 * silently miss whatever changed while paused" reasoning.
 *
 * "Abandons" an in-flight check, not "kills" it: `ProcessRunner` (see
 * runProcess.ts) has no cancellation hook, and CustomLint runs ESLint
 * in-process (see runCustomLint.ts) with nothing to kill at all — pausing
 * just stops that in-flight result from ever being applied once it resolves
 * (see `checkGeneration` below) and immediately frees this runner to launch
 * a new one. A paused-then-resumed oxlint run's real OS process keeps
 * running to completion in the background (oxlint is normally a 1-2s check
 * — see runOxlint.ts), same bounded-cost tradeoff the old in-process
 * QualityWatcher's `resetStuckState()` already accepted for the same
 * structural reason ("there's nothing to cancel it with").
 */

import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { IEventBus } from '@minions/events';
import type { ISignalRunner, ExecutionStrategy } from '../ISignalRunner.js';
import { SignalType, type SignalState } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import type { ProcessRunner, ProcessResult } from './runProcess.js';

/**
 * Path segments whose changes never warrant a re-check: build/vcs/tooling
 * output (node_modules, .git, .nx, dist, coverage), plus wing-level areas
 * that are siblings of a work repo — not descendants — and so shouldn't
 * normally appear under a correctly-scoped watch root at all (private/info/
 * closet/tool logs). Kept here too as defense in depth: this list is what
 * actually protects against noise if a caller ever points the watcher at a
 * wing root instead of a single work repo's root.
 *
 * Exported for reuse by callers that need to prune a directory *traversal*
 * (skip descending into these by name) rather than judge a single file
 * *change event* — see runCustomLint.ts's own per-file discovery walk. Not
 * the same job as `isIgnoredPath` below (which also encodes change-event
 * -specific heuristics, like the bare-project-directory case, that would
 * wrongly prune an entire real project out of a traversal) — this plain
 * name list is the part that's actually safe to reuse for that.
 */
export const IGNORED_PATH_SEGMENTS = [
  'node_modules', '.git', '.nx', 'dist', 'coverage',
  'private', 'info', 'closet', '.claude', '.costume',
];

/**
 * File suffixes that never warrant a re-check. In particular tsc's own
 * incremental build info (`*.tsbuildinfo`) is written at arbitrary locations
 * (often the repo/project root, outside any ignored directory) by the very
 * typecheck run this watcher triggers — without this, each typecheck run
 * would re-trigger itself (and any co-watched signal) forever.
 */
const IGNORED_SUFFIXES = ['.tsbuildinfo', '.log'];

/**
 * Exact filenames that never warrant a re-check (tool/session logs, plus
 * `log-tool-use.cjs` — the `TOOL_LOG_HOOK_SCRIPT_NAME` from
 * `@minions/movement-branching` — which gets idempotently reprovisioned
 * with identical content on every tool call in an active AI coding session,
 * i.e. constantly while this watcher is in active use).
 */
const IGNORED_FILENAMES = ['tool-log.jsonl', 'log-tool-use.cjs'];

/**
 * Filename substrings that never warrant a re-check. In particular, Vite
 * writes a transient `vite.config.<ts>.timestamp-<n>-<hash>.mjs` (or
 * `vitest.config...`) next to each project's config file every time it
 * loads that config — i.e. on every single test/build run this watcher
 * triggers. Already gitignored workspace-wide (see root .gitignore); ignore
 * it here too or every run re-triggers itself the same way tsbuildinfo did.
 */
const IGNORED_SUBSTRINGS = ['.timestamp-'];

/**
 * Top-level project roots in this workspace layout. A bare `<root>/<name>`
 * change event (exactly two path segments, nothing nested inside) — as
 * opposed to `<root>/<name>/src/foo.ts` — was observed live, recurring
 * every ~60s in a fixed cycle through the same set of libs, with a warm nx
 * daemon running. A genuine source edit always touches a named file nested
 * inside a project directory; this shape only ever showed up as what looks
 * like the daemon's own background project-graph bookkeeping. Ignore it.
 */
const PROJECT_ROOT_SEGMENTS = ['libs', 'apps', 'costumes', 'domains'];

/**
 * Exported for reuse by callers needing the exact same "does this change
 * even count" filtering (e.g. RepoFileChangeTracker in
 * apps/quality-watcher-process, feeding SignalWedgeMonitor's reference
 * point).
 */
export function isIgnoredPath(filename: string | null): boolean {
  // No resolvable path at all: on the evidence gathered live, these arrived
  // in the same noisy bursts as the bare-project-directory daemon activity
  // below, not as reports of genuine, otherwise-unobservable file changes.
  if (!filename) return true;
  const segments = filename.split(/[\\/]/);
  if (IGNORED_PATH_SEGMENTS.some((seg) => segments.includes(seg))) return true;
  if (IGNORED_FILENAMES.includes(segments[segments.length - 1])) return true;
  if (IGNORED_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return true;
  if (IGNORED_SUBSTRINGS.some((substr) => filename.includes(substr))) return true;
  if (segments.length === 2 && PROJECT_ROOT_SEGMENTS.includes(segments[0])) return true;
  return false;
}

export class FileTriggeredSignalRunner implements ISignalRunner {
  readonly strategy: ExecutionStrategy = 'file-triggered';

  private state: SignalState;
  /**
   * Real, fine-grained progress evidence — see ISignalRunner.lastActivityAt's
   * doc comment. Seeded the moment a check actually launches (runCheck's
   * 'running' transition, not this class's start(), which only arms an fs
   * watch and does nothing until a check is asked for — see the class doc
   * comment) and then ticked forward by the injected ProcessRunner's
   * `onActivity` callback, if it reports anything finer-grained (see
   * runCustomLint.ts). A runner with no such reporting (oxlint's single
   * subprocess call) just keeps this at the 'running' seed until the whole
   * check settles — equivalent to falling back to `getState().timestamp`.
   */
  private activityAt: Date | null = null;
  private fsWatcher: { close(): void } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** No valid cached result: never run yet, or invalidated by a file change since the last run. */
  private dirty = true;
  /**
   * Bumped by pause() so a check already in flight at pause-time can't
   * apply its result once it resolves — see the class doc comment's
   * "abandons, not kills" note. Each runCheck() captures the generation it
   * started with and only transitions state if it's still current.
   */
  private checkGeneration = 0;
  /**
   * Absolute paths of every non-ignored file change observed since the last
   * check consumed this set (see runCheck's snapshot-and-clear, timed to
   * match `dirty`'s own reset exactly). Handed to the injected
   * `ProcessRunner` as `changedPaths` so a runner with real incremental
   * behavior (see runCustomLint.ts) can scope its own work — this class
   * stays strategy-agnostic about what "scope" even means, same as it
   * already is about everything else a specific tool does with a check.
   */
  private changedPaths = new Set<string>();
  /**
   * True when the next check must be treated as unknown/full scope rather
   * than trusting `changedPaths` — set on construction (never run yet, so
   * there's nothing meaningful to scope to) and by resume() (the fs.watch
   * was off for the whole pause, so `changedPaths` can't be a complete
   * record of what changed) and resetStuckState() (an escape-hatch "this
   * might be wrong" signal, not "this specific file changed" — stays
   * conservative rather than trusting a possibly-incomplete accumulation).
   */
  private forceFullNextCheck = true;

  constructor(
    readonly signalType: SignalType,
    private readonly target: string,
    private readonly cwd: string,
    private readonly eventBus: IEventBus,
    private readonly runProcess: ProcessRunner,
    private readonly debounceMs = 1000,
    private readonly watchFs: typeof fsWatch = fsWatch
  ) {
    this.state = { state: 'pending', timestamp: new Date() };
  }

  async start(): Promise<void> {
    if (this.fsWatcher) return;
    this.eventBus.emit(SignalRunnerEvents.Started, { signalType: this.signalType });
    this.armWatch();
  }

  async stop(): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.eventBus.emit(SignalRunnerEvents.Stopped, { signalType: this.signalType });
  }

  getState(): SignalState {
    return this.state;
  }

  lastActivityAt(): Date | null {
    return this.activityAt;
  }

  /**
   * A status read found no valid cached result for this signal — launch a
   * check now. No-op if the cached result is still valid (no qualifying
   * file change since the last run) or a check is already in flight (its
   * result will cover whatever invalidated this one).
   */
  ensureFresh(): void {
    if (!this.dirty || this.inFlight) return;
    void this.runCheck();
  }

  /**
   * Belt-and-suspenders recovery hook, kept for any caller that still wants
   * a lighter-weight nudge than a full pause()/resume() cycle: forcibly
   * clears `inFlight` and marks the cached result invalid, so the very next
   * `ensureFresh()` launches a real check even if this runner somehow got
   * wedged in a way runCheck()'s own try/catch/finally doesn't cover.
   * `SignalWedgeMonitor`'s own recovery ladder uses pause()/resume()
   * instead (see the class doc comment) — this method isn't required for
   * that anymore, but stays available and correct on its own.
   */
  resetStuckState(): void {
    this.inFlight = false;
    this.dirty = true;
    this.forceFullNextCheck = true;
  }

  /**
   * Stops reacting to file changes entirely — no fs.watch registered at
   * all, so this does no work while paused, not just "don't launch yet."
   * Whatever check is currently in flight is abandoned (see the class doc
   * comment): its eventual result is discarded rather than applied.
   */
  async pause(): Promise<void> {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.checkGeneration += 1;
    this.inFlight = false;
  }

  /**
   * Re-arms the fs.watch and unconditionally launches a fresh check —
   * mirrors VitestSignalRunner.resume() calling `vitest.start()`
   * unconditionally rather than trusting reattachment alone to notice
   * whatever changed while paused.
   */
  async resume(): Promise<void> {
    if (this.fsWatcher) return;
    this.armWatch();
    this.dirty = true;
    // Whatever accumulated before the pause is an incomplete record (the
    // watch was off for the whole pause) — not worth carrying forward.
    this.changedPaths.clear();
    this.forceFullNextCheck = true;
    void this.runCheck();
  }

  private armWatch(): void {
    this.fsWatcher = this.watchFs(this.cwd, { recursive: true }, (_eventType, filename) => {
      if (isIgnoredPath(filename)) return;
      if (filename) this.changedPaths.add(join(this.cwd, filename));
      this.scheduleInvalidate();
    });
  }

  private scheduleInvalidate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.invalidate();
    }, this.debounceMs);
  }

  private invalidate(): void {
    const wasValid = !this.dirty;
    this.dirty = true;
    if (wasValid && (this.state.state === 'pass' || this.state.state === 'fail')) {
      this.transitionTo({ state: 'pending', timestamp: new Date() });
    }
  }

  private async runCheck(): Promise<void> {
    // Defensive: ensureFresh()/resume() already guard against calling in
    // while a check is in flight; this is a backstop against a future
    // second entry point being added without that guard.
    if (this.inFlight) return;
    this.inFlight = true;
    const generation = this.checkGeneration;
    try {
      this.dirty = false;
      // Snapshot-and-clear at the exact same moment `dirty` resets, so a
      // change that arrives WHILE this check is running correctly
      // re-populates both for the next check, same as `dirty`'s own
      // "invalidated mid-flight" handling below.
      const changedPaths = this.forceFullNextCheck ? null : new Set(this.changedPaths);
      this.changedPaths.clear();
      this.forceFullNextCheck = false;
      this.activityAt = new Date();
      this.transitionTo({ state: 'running', timestamp: this.activityAt, failures: [] });

      let result: ProcessResult;
      try {
        result = await this.runProcess(this.cwd, this.target, {
          onActivity: () => {
            if (generation === this.checkGeneration) this.activityAt = new Date();
          },
          changedPaths,
        });
      } catch (err) {
        result = { exitCode: 1, output: err instanceof Error ? err.message : String(err) };
      }

      // Abandoned by a pause() while this was in flight — the fresh
      // resume() already launched (or will launch) its own check; applying
      // this stale result now would overwrite that with old news.
      if (generation !== this.checkGeneration) return;

      this.transitionTo(
        result.exitCode === 0
          ? { state: 'pass', timestamp: new Date(), warnings: result.warnings }
          : { state: 'fail', timestamp: new Date(), failures: [result.output], warnings: result.warnings }
      );
      // If a file change invalidated this signal while the check was in
      // flight, `dirty` is already true again — the next status read's
      // ensureFresh() picks it up; no need to chase it here.
    } catch (err) {
      if (generation !== this.checkGeneration) return;
      // Never let this fall through silently and leave the last cached
      // state (possibly a stale 'pass') looking current — report the
      // internal failure itself, and leave `dirty` alone so the very next
      // status read retries once whatever caused this clears.
      this.transitionTo({
        state: 'fail',
        timestamp: new Date(),
        failures: [`[${this.target}] quality watcher internal error: ${err instanceof Error ? err.message : String(err)}`],
      });
    } finally {
      if (generation === this.checkGeneration) this.inFlight = false;
    }
  }

  private transitionTo(newState: SignalState): void {
    this.state = newState;
    this.eventBus.emit(SignalRunnerEvents.StateChanged, { signalType: this.signalType, state: newState });
  }
}
