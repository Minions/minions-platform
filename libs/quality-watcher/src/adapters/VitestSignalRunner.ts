/**
 * Vitest Signal Runner
 *
 * Production `tests` signal: one persistent in-process Vitest instance for
 * the whole work repo (via `startVitest` from `vitest/node`, `watch: true`,
 * `test.projects` set to every discovered project directory — see
 * discoverVitestProjectDirs.ts), instead of spawning `nx affected -t test`
 * as a fresh subprocess on every debounced file change.
 *
 * An earlier version of this file ran one fully separate Vitest instance
 * *per project directory* instead of one shared `test.projects` instance —
 * worked around long-standing Vitest bugs (vitest-dev/vitest#5734, #7964)
 * where mixing Node-environment and browser/jsdom-environment projects in
 * one process leaked one project's Node-builtin externalization rules into
 * another's, breaking things like `util.promisify` and Vue component
 * mounting. Vitest 4 rewrote its module loading (vite-node →
 * module-runner), which fixed this — confirmed live against this repo's
 * actual mixed node/jsdom projects, thousands of tests, zero failures — so
 * `test.projects` is safe again, and strictly better on all three axes that
 * matter here:
 *   - Parallelism: one shared worker pool (`pool: 'threads'`, Vitest's
 *     default `fileParallelism`/`maxWorkers`) gives real intra- *and*
 *     cross-project parallelism, instead of the old design's forced
 *     single-worker-per-project (itself a workaround for the OS-process
 *     explosion below) whose only parallelism came from running N separate
 *     watch-mode instances side by side.
 *   - Only-affected-tests: unchanged — each project's own dependency graph
 *     inside the shared instance still reruns only the test files whose
 *     transitive dependencies actually changed. This was always Vitest's
 *     own watch-mode machinery, not something the old per-instance design
 *     provided itself.
 *   - Process count: one Vitest process total (still zero OS-process forks
 *     within it, via `pool: 'threads'`), instead of one long-lived Node
 *     process per discovered project — this repo alone discovers ~26.
 *
 * `onTestRunStart`/`onTestRunEnd` fire once per watch-mode run cycle for
 * the whole shared instance — a cycle can span every project's changed
 * files, or just one project's if only its files changed — so this reports
 * one `tests` SignalState directly from that reporter, no more per-project
 * state map to combine "worst wins".
 */

import path from 'node:path';
import type { IEventBus } from '@minions/events';
import type { TestModule, SerializedError } from 'vitest/node';
import type { ISignalRunner, ExecutionStrategy } from '../ISignalRunner.js';
import { SignalType, type SignalState } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import { discoverVitestProjectDirs } from './discoverVitestProjectDirs.js';
import { resolveWorkRepoVitest } from './resolveWorkRepoVitest.js';
import { createWarningCapturingLogger } from './createWarningCapturingLogger.js';
import { hasAnyTestFile } from './hasAnyTestFile.js';

export type VitestRunResult = { failures: string[]; warnings: string[]; moduleIds: string[] };

/**
 * Normalizes a file path for membership checks against a completed run's
 * module id set (see `hasRunFile`) — case-insensitively on Windows, where
 * the same file can arrive with different drive-letter/segment casing from
 * fs.watch than from Vitest's own reporter.
 */
function normalizeModulePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * What a VitestStarter must return so this runner can shut it down again —
 * and, per `ISignalRunner.pause`/`resume`'s doc comment, stop/start reacting
 * to file changes without a full close+restart. `pause`/`resume` are
 * synchronous: they just detach/reattach the shared instance's own file-watch
 * listeners (see `defaultVitestStarter`'s doc comment for exactly how), no
 * I/O of their own.
 */
export type VitestHandle = { close(): Promise<void>; pause(): void; resume(): void; lastActivityAt(): Date | null };

/**
 * Starts a watch-mode Vitest run rooted at `cwd`, with `test.projects` set
 * to `projectDirs`, invoking `onRunStart` when a run begins and `onRunEnd`
 * when it completes. Injectable so tests never touch the real Vitest Node
 * API; the default calls `startVitest` for real.
 */
export type VitestStarter = (cwd: string, projectDirs: string[], onRunStart: () => void, onRunEnd: (result: VitestRunResult) => void) => Promise<VitestHandle>;

function collectFailures(testModules: readonly TestModule[], unhandledErrors: readonly SerializedError[]): string[] {
  const failures: string[] = [];
  for (const testModule of testModules) {
    for (const error of testModule.errors()) {
      failures.push(`${testModule.moduleId}: ${error.message}`);
    }
    for (const test of testModule.children.allTests('failed')) {
      const result = test.result();
      for (const error of result.state === 'failed' ? result.errors : []) {
        failures.push(`${test.fullName}: ${error.message}`);
      }
    }
  }
  for (const error of unhandledErrors) {
    failures.push(error.message);
  }
  return failures;
}

const NOOP_HANDLE: VitestHandle = { close: async () => undefined, pause: () => undefined, resume: () => undefined, lastActivityAt: () => null };

/**
 * Builds the default starter around an injectable Vitest resolver, so tests
 * can exercise the not-found/unsupported-version branches without a real
 * `node_modules` fixture on disk. `defaultVitestStarter` below is this with
 * the real `resolveWorkRepoVitest`.
 */
export function createVitestStarter(
  resolveVitest: typeof resolveWorkRepoVitest = resolveWorkRepoVitest,
  hasTestFiles: (dir: string) => Promise<boolean> = hasAnyTestFile
): VitestStarter {
  return async (cwd, discoveredProjectDirs, onRunStart, onRunEnd) => {
    if (discoveredProjectDirs.length === 0) {
      // Nothing discovered to watch (a repo with no Vitest projects at
      // all). Same convention as the not-found/unsupported-version
      // branches below: report an instant pass rather than staying pending
      // forever.
      onRunStart();
      onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      return NOOP_HANDLE;
    }

    const resolution = await resolveVitest(cwd);

    if (resolution.kind === 'not-found') {
      // The repo has no Vitest installed at all, despite having project
      // dirs with a `test: {...}` config block (e.g. a config authored
      // for a future migration). Nothing to watch here, and nothing to
      // fail on. Same convention as resolveWorkRepoVite's build-signal
      // starter.
      onRunStart();
      onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      return NOOP_HANDLE;
    }

    if (resolution.kind === 'unsupported-version') {
      // A real mismatch, not an absence — surface it clearly once and
      // stop, rather than repeatedly retrying against a reporter API this
      // runner isn't built to handle.
      onRunStart();
      onRunEnd({ failures: [resolution.message], warnings: [], moduleIds: [] });
      return NOOP_HANDLE;
    }

    // A dir can declare a real `test: {...}` config (so
    // discoverVitestProjectDirs rightly finds it) and still transiently have
    // zero matching test files on disk right now — mid-refactor, a file just
    // renamed/deleted, etc. Filter those out of what we ask this shared
    // instance to watch, rather than relying on `passWithNoTests` to make
    // Vitest itself tolerate it: that depends on exactly how the work repo's
    // installed Vitest patch happens to implement watch-mode's zero-files
    // case, which is not consistent across the 4.x line (some patches throw
    // FilesNotFoundError from a second, unguarded internal `ctx.start()` call
    // that lands as a bare unhandled rejection no call-site try/catch can
    // reach — see the `startVitest()` call below). Never asking Vitest to
    // watch a directory with nothing in it sidesteps that regardless of
    // which exact 4.x/2.x/3.x patch is installed.
    // Wrapped, not passed directly: Array.map's callback receives
    // (element, index, array), and hasTestFiles's optional second parameter
    // (readDir) would otherwise receive the numeric index instead of
    // undefined — its default never applies, and readDir(dir) throws
    // "readDir is not a function" the moment index isn't a function itself.
    const hasTestFilesResults = await Promise.all(discoveredProjectDirs.map((dir) => hasTestFiles(dir)));
    const projectDirs = discoveredProjectDirs.filter((_dir, index) => hasTestFilesResults[index]);
    const skipped = discoveredProjectDirs.filter((dir) => !projectDirs.includes(dir));
    if (skipped.length > 0) {
      console.error(`[VitestSignalRunner] Skipping project dir(s) with no test files currently on disk: ${skipped.join(', ')}`);
    }

    if (projectDirs.length === 0) {
      // Every discovered dir is currently empty of test files (e.g. a
      // repo-wide refactor in flight). Same "nothing to run" convention as
      // above — a stale-watcher restart will pick these back up once files
      // reappear (see QualityWatcher.restartWatchModeSignalsIfWedged).
      onRunStart();
      onRunEnd({ failures: [], warnings: [], moduleIds: [] });
      return NOOP_HANDLE;
    }

    const { startVitest } = (await import(resolution.entryUrl)) as typeof import('vitest/node');

    // Reset per run: warnings logged during a run belong to that run, not
    // whatever the previous run in this same long-lived instance happened
    // to log — a fixed deprecation notice should stop showing up. Mutated
    // in place (never reassigned) since createWarningCapturingLogger closes
    // over this exact array identity.
    const warnings: string[] = [];
    // Set on every reporter callback Vitest fires *during* a run, not just
    // at the run's start/end — see `ISignalRunner.lastActivityAt`'s doc
    // comment. A run over a large/slow suite can legitimately take far
    // longer than any fixed timeout would allow; what actually
    // distinguishes that from a genuinely stalled run is whether Vitest is
    // still producing per-file/per-test results at all, not how long the
    // run has been open.
    let lastActivity: Date | null = null;

    const reporter = {
      onTestRunStart() {
        warnings.length = 0;
        lastActivity = new Date();
        onRunStart();
      },
      onTestModuleStart() {
        lastActivity = new Date();
      },
      onTestCaseResult() {
        lastActivity = new Date();
      },
      onTestRunEnd(testModules: readonly TestModule[], unhandledErrors: readonly SerializedError[]) {
        lastActivity = new Date();
        onRunEnd({
          failures: collectFailures(testModules, unhandledErrors),
          warnings: [...warnings],
          moduleIds: testModules.map((m) => m.moduleId),
        });
      },
    };

    const vitest = await startVitest(
      'test',
      [],
      // passWithNoTests: correct intent (a project dir having a Vitest
      // config but zero matching test files is a normal state, not a fatal
      // one), but NOT sufficient by itself to stop VITEST_FILES_NOT_FOUND
      // from crashing the process in watch mode. Vitest's own
      // `Vitest.start()` throws FilesNotFoundError unconditionally when
      // watch is true and zero files are found (ignoring passWithNoTests
      // entirely — see node_modules/vitest/dist/chunks/cli-api.*.js), and
      // `startVitest()`'s internal `onAfterSetServer` hook calls
      // `ctx.start()` a second time with no try/catch around it at all, so
      // that second throw becomes an unhandled rejection regardless of
      // anything passed here. The two real defenses against that are (a)
      // apps/cabinet/src/main.ts's unhandledRejection/uncaughtException
      // handlers, and (b) the hasAnyTestFile filter above, which keeps any
      // zero-test-file dir out of `projects` so this code path is never
      // reached at all — kept as `projects` here (not
      // `discoveredProjectDirs`) specifically for that reason.
      // pool: 'threads' — Vitest's default pool ('forks', isolate: true)
      // forks a real OS child process per test file for isolation. With
      // every discovered project's files running through this one shared
      // instance, that would be however many test files across the whole
      // repo, simultaneously, for the life of the process — observed live
      // as 260+ leaked tinypool/dist/entry/process.js processes on one
      // wing's cabinet under the old per-project design (which hit the same
      // 'forks' default multiplied by ~26 concurrent instances), the real
      // resource driver behind the MaxListenersExceededWarning symptom and
      // very plausibly what actually exhausted the crashed prod server.
      // `fileParallelism`/`maxWorkers` are deliberately left at Vitest's own
      // defaults here (parallel, worker count based on CPU count): threads
      // are cheap, there's exactly one Vitest instance for the whole repo
      // now (not one per project), and this runner's whole point is
      // reporting pass/fail state as fast as watch mode can produce it.
      // Cabinet's own process can be running with NODE_ENV=production (its
      // own production build sets that on the whole process) — Vitest only
      // defaults NODE_ENV to 'test' when it's unset (`process.env.NODE_ENV
      // ??= 'test'`), so left alone every test file would run believing it's
      // in production. `env` here is spread into each worker's own process
      // env at spawn time (see Vitest's `createPool`/`resolveOptions`), not
      // into Cabinet's ambient `process.env` — this scopes the override to
      // the test workers alone and leaves everything else in Cabinet's own
      // process (including the build signal below) unaffected.
      //
      // teardownTimeout: raised well past Vitest's own default (10s) —
      // observed live as repeated "[vitest-pool]: Timeout terminating
      // threads worker for test files ..." errors on a heavy repo's shared
      // instance. That default assumes roughly one project's worth of
      // concurrent load; this runner deliberately keeps every discovered
      // project's files running through ONE shared instance (see above), so
      // a worker winding down after its own test file finishes is
      // competing for CPU with however many other projects' workers are
      // still mid-run at that same moment — comfortably enough to blow past
      // 10s on a big repo under real concurrency, without the worker itself
      // being stuck.
      {
        watch: true,
        root: cwd,
        projects: projectDirs,
        reporters: [reporter],
        passWithNoTests: true,
        pool: 'threads',
        teardownTimeout: 60_000,
        env: { NODE_ENV: 'test' },
      },
      // stdin: a fake, non-TTY stdin. Vitest's startVitest() only registers
      // its interactive keyboard shortcuts (press 'q' to quit, 'a' to rerun
      // all, ...) when `stdin.isTTY` is true — otherwise it falls back to
      // the real process.stdin, and 'q' would exit this one shared instance
      // out from under the whole watcher. cabinet's own main.ts already
      // owns real interactive stdin handling (its own 'q'-to-quit) for the
      // process as a whole.
      { customLogger: createWarningCapturingLogger(warnings) },
      { stdin: { isTTY: false } as unknown as NodeJS.ReadStream }
    );
    return {
      close: () => Promise.resolve(vitest?.close()),
      // vitest.watcher (a VitestWatcher) attaches/detaches its own
      // change/unlink/add listeners onto the real chokidar instance
      // (vitest.vite.watcher) via registerWatcher()/unregisterWatcher() —
      // confirmed against the actually-installed vitest@4.1.10
      // (node_modules/vitest/dist/chunks/cli-api.*.js): both are public,
      // undocumented (no CHANGELOG entry — treat as a version-pinned
      // implementation detail, same spirit as this file's other
      // Vitest-version caveats above), and exactly what's needed here —
      // pausing stops runs from firing on transient churn (e.g. a git
      // rebase) while the module graph, transform cache, and worker pool
      // all stay warm; resuming just reattaches, no restart needed.
      //
      // Reattaching alone would silently miss whatever actually changed
      // while paused: chokidar doesn't replay file-system events that
      // happened while Vitest wasn't listening, it only fires on the next
      // real event — confirmed live, a file edited during a pause window
      // and left unedited after resume never reran. So resume also calls
      // the same `start()` Vitest's own 'a' watch-mode shortcut uses to
      // rerun everything (`vitest.start(): Promise<TestRunResult>`,
      // reusing the reporter already registered on this instance, so
      // onTestRunStart/onTestRunEnd fire exactly as they would for any
      // other run) — a full recheck, not just changed files, which is the
      // right tradeoff for the actual trigger (a git rebase can touch many
      // files at once, and a full check is what's warranted after one
      // regardless of exactly which files it touched). Fire-and-forget:
      // resume() itself must stay synchronous, and any failure surfaces
      // through the normal onTestRunEnd -> transitionTo(fail) path, not
      // here.
      pause: () => vitest?.watcher.unregisterWatcher(),
      resume: () => {
        vitest?.watcher.registerWatcher();
        vitest?.start().catch((error: unknown) => {
          console.error('[VitestSignalRunner] Failed to rerun after resume():', error);
        });
      },
      lastActivityAt: () => lastActivity,
    };
  };
}

const defaultVitestStarter: VitestStarter = createVitestStarter();

export class VitestSignalRunner implements ISignalRunner {
  readonly signalType = SignalType.Tests;
  readonly strategy: ExecutionStrategy = 'watch-mode';

  private state: SignalState;
  private handle: VitestHandle | null = null;
  /** File paths (normalized via normalizeModulePath) actually exercised by the most recently completed run — see hasRunFile(). */
  private lastRunFiles: Set<string> = new Set();
  /** Set at the top of start(), before `this.handle` exists — see `lastActivityAt()`. Covers the warmup gap (project discovery, `startVitest()` resolving, worker pool spin-up) that can legitimately take several seconds with nothing else to report yet. */
  private startedAt: Date | null = null;

  constructor(
    private readonly cwd: string,
    private readonly eventBus: IEventBus,
    private readonly starter: VitestStarter = defaultVitestStarter,
    private readonly discoverProjectDirs: (cwd: string) => Promise<string[]> = discoverVitestProjectDirs
  ) {
    this.state = { state: 'pending', timestamp: new Date() };
  }

  async start(): Promise<void> {
    if (this.handle) return;
    this.eventBus.emit(SignalRunnerEvents.Started, { signalType: this.signalType });
    // A restart (see QualityWatcher.restartWedgedSignal) calls stop() then
    // start() on this same instance — without this reset, `state` would
    // keep showing the stale pass/fail result that got it restarted in the
    // first place until the fresh instance's own first cycle completes,
    // which for a cold restart can take a while. 'pending' is exempt from
    // the wedged check (see restartWatchModeSignalsIfWedged), so resetting
    // here is what actually stops a slow-to-restart signal from being
    // killed again before it gets a fair chance to converge.
    this.state = { state: 'pending', timestamp: new Date() };
    this.startedAt = new Date();

    const projectDirs = await this.discoverProjectDirs(this.cwd);
    try {
      this.handle = await this.starter(
        this.cwd,
        projectDirs,
        () => this.transitionTo({ state: 'running', timestamp: new Date(), failures: [] }),
        (result) => {
          this.lastRunFiles = new Set(result.moduleIds.map(normalizeModulePath));
          this.transitionTo(
            result.failures.length > 0
              ? { state: 'fail', timestamp: new Date(), failures: result.failures, warnings: result.warnings }
              : { state: 'pass', timestamp: new Date(), warnings: result.warnings }
          );
        }
      );
    } catch (error) {
      // The shared Vitest instance failing to start (a config problem in
      // any one discovered project, ...) must not propagate past this
      // runner nor the process — see apps/cabinet/src/main.ts's
      // unhandledRejection/uncaughtException handlers for why a
      // per-call-site catch is the primary defense, not just a backstop.
      this.transitionTo({ state: 'fail', timestamp: new Date(), failures: [String(error)] });
      this.handle = NOOP_HANDLE;
    }
  }

  async stop(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    this.eventBus.emit(SignalRunnerEvents.Stopped, { signalType: this.signalType });
  }

  getState(): SignalState {
    return this.state;
  }

  /** See `ISignalRunner.lastActivityAt`'s doc comment. Null before `start()`; falls back to the start()-time seed while still warming up (before `handle` exists). */
  lastActivityAt(): Date | null {
    return this.handle?.lastActivityAt() ?? this.startedAt;
  }

  /** No-op-safe before `start()` — see `ISignalRunner.pause`'s doc comment. */
  async pause(): Promise<void> {
    this.handle?.pause();
  }

  /** No-op-safe without a matching `pause()` — see `ISignalRunner.resume`'s doc comment. */
  async resume(): Promise<void> {
    this.handle?.resume();
  }

  /**
   * Whether the most recently completed run actually exercised `absPath` —
   * used by QualityWatcher to confirm a newly-arrived test file got picked
   * up by this shared instance's own watch mode before paying for a full
   * cold restart (see restartWatchModeSignalsIfWedged's verify-then-restart
   * flow). Reflects only the latest cycle; a file present in an earlier run
   * but dropped from the current one (e.g. deleted) correctly reports false.
   */
  hasRunFile(absPath: string): boolean {
    return this.lastRunFiles.has(normalizeModulePath(absPath));
  }

  private transitionTo(newState: SignalState): void {
    this.state = newState;
    this.eventBus.emit(SignalRunnerEvents.StateChanged, { signalType: this.signalType, state: newState });
  }
}
