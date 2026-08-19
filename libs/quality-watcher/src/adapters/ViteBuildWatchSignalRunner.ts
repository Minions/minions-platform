/**
 * Vite Build Watch Signal Runner
 *
 * Production `build` signal: a single persistent build watcher per work
 * repo via Vite's JS API (`build()` with `build.watch` set returns a
 * Rollup `RollupWatcher` — an event emitter, not a one-shot promise), in
 * place of the previous on-demand-only `nx run-many -t build --all`. This
 * is what makes `build` a continuously-watched signal at all: there was no
 * reliable incremental build path before Vite's own watcher was wired in
 * directly, so it stayed on-demand and never auto-started.
 *
 * The watcher fires 'event' with a `code` for each stage of a rebuild
 * cycle (BUNDLE_START, END, ERROR, ...); this adapter only needs END
 * (cycle finished clean) and ERROR (cycle failed) to update SignalState.
 *
 * The Vite module used is the target repo's own installed copy (see
 * resolveWorkRepoVite.ts), not one bundled into Cabinet — Cabinet's
 * production esbuild bundle flattens Vite's file layout, which breaks its
 * internal `import.meta.url`-relative self-lookups. Using the repo's own
 * install also means build-watching happens with that repo's actual
 * pinned Vite version, config, and plugins, matching how the types/oxlint/
 * custom-lint signals already defer to each repo's own toolchain.
 */

import type { IEventBus } from '@minions/events';
import type { ISignalRunner, ExecutionStrategy } from '../ISignalRunner.js';
import { SignalType, type SignalState } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import { resolveWorkRepoVite } from './resolveWorkRepoVite.js';
import { hasBuildableViteEntry } from './hasBuildableViteEntry.js';

export type ViteBuildCycleResult = { failures: string[]; warnings: string[] };

export type ViteBuildHandle = { close(): Promise<void>; lastActivityAt(): Date | null };

/**
 * Starts a watch-mode Vite build in `cwd`, invoking `onCycleStart` when a
 * (re)build begins and `onCycleEnd` when it settles. Injectable so tests
 * never touch the real Vite/Rollup API; the default calls Vite's `build()`
 * for real.
 */
export type ViteBuildStarter = (cwd: string, onCycleStart: () => void, onCycleEnd: (result: ViteBuildCycleResult) => void) => Promise<ViteBuildHandle>;

const NOOP_HANDLE: ViteBuildHandle = { close: async () => undefined, lastActivityAt: () => null };

/**
 * Builds the default starter around an injectable Vite resolver, so tests
 * can exercise the not-found/unsupported-version branches without a real
 * `node_modules` fixture on disk. `defaultViteBuildStarter` below is this
 * with the real `resolveWorkRepoVite`.
 */
export function createViteBuildStarter(
  resolveVite: typeof resolveWorkRepoVite = resolveWorkRepoVite,
  hasEntry: typeof hasBuildableViteEntry = hasBuildableViteEntry
): ViteBuildStarter {
  return async (cwd, onCycleStart, onCycleEnd) => {
    const resolution = await resolveVite(cwd);

    if (resolution.kind === 'not-found') {
      // Not every work repo builds with Vite at all — nothing to watch
      // here, and nothing to fail on. Same convention as runCustomLint's
      // "no config present" case: report an instant pass rather than
      // erroring.
      onCycleStart();
      onCycleEnd({ failures: [], warnings: [] });
      return NOOP_HANDLE;
    }

    if (resolution.kind === 'ok' && !(await hasEntry(cwd))) {
      // `vite` resolves (e.g. a hoisted devDependency used only by nested
      // per-app configs) but this repo has no root-level Vite project to
      // build — same "nothing to watch here" outcome as not-found, just
      // detected one layer down (see hasBuildableViteEntry.ts).
      onCycleStart();
      onCycleEnd({ failures: [], warnings: [] });
      return NOOP_HANDLE;
    }

    if (resolution.kind === 'unsupported-version') {
      // A real mismatch, not an absence — surface it clearly once and
      // stop, rather than repeatedly retrying against a Vite build API
      // Cabinet isn't built to handle.
      onCycleStart();
      onCycleEnd({ failures: [resolution.message], warnings: [] });
      return NOOP_HANDLE;
    }

    const { build } = (await import(resolution.entryUrl)) as typeof import('vite');
    // Reset per cycle in BUNDLE_START below; mutated in place (never
    // reassigned) since the logger below closes over these exact array
    // identities. Replaces the old `logLevel: 'silent'` — that silently
    // discarded everything instead of capturing it as a reportable warning.
    //
    // `errors` is tracked separately from `warnings`, NOT via the shared
    // createWarningCapturingLogger (which deliberately folds warn/warnOnce/
    // error into one array — correct for VitestSignalRunner, which never
    // derives pass/fail from logger output at all, only from its own
    // reporter's real test results). This runner has no such independent
    // failure channel: the watcher's 'ERROR' event alone isn't enough —
    // confirmed live against this repo's installed rolldown-vite, an
    // unresolved-import build failure is reported via the logger's error()
    // call while the watcher still emits a plain 'END', not 'ERROR'. Without
    // this, that class of real, fatal build failure silently reported as
    // `pass` (with the failure text buried in `warnings`, easy to miss).
    const warnings: string[] = [];
    const errors: string[] = [];
    // Set on every watcher 'event' callback — see `ISignalRunner.lastActivityAt`'s doc comment.
    let lastActivity: Date | null = null;
    const logger = {
      info: (_msg: string) => undefined,
      warn(msg: string) { warnings.push(msg); },
      warnOnce(msg: string) { warnings.push(msg); },
      error(msg: string) { errors.push(msg); },
      clearScreen: () => undefined,
      hasErrorLogged: () => false,
      hasWarned: false,
    };
    const result = await build({ root: cwd, customLogger: logger, build: { watch: {} } });
    // With `build.watch` set, Vite's build() returns a RollupWatcher (an
    // event emitter) instead of the usual RollupOutput — never an array here.
    const watcher = result as unknown as {
      on(event: 'event', listener: (e: { code: string; error?: unknown }) => void): void;
      close(): Promise<void>;
    };

    watcher.on('event', (event) => {
      lastActivity = new Date();
      if (event.code === 'BUNDLE_START') {
        warnings.length = 0;
        errors.length = 0;
        onCycleStart();
      } else if (event.code === 'END') {
        onCycleEnd(
          errors.length > 0
            ? { failures: [...errors], warnings: [...warnings] }
            : { failures: [], warnings: [...warnings] }
        );
      } else if (event.code === 'ERROR') {
        onCycleEnd({
          failures: [event.error instanceof Error ? event.error.message : String(event.error), ...errors],
          warnings: [...warnings],
        });
      }
    });

    return { close: () => watcher.close(), lastActivityAt: () => lastActivity };
  };
}

const defaultViteBuildStarter: ViteBuildStarter = createViteBuildStarter();

export class ViteBuildWatchSignalRunner implements ISignalRunner {
  readonly signalType = SignalType.Build;
  readonly strategy: ExecutionStrategy = 'watch-mode';

  private state: SignalState;
  private handle: ViteBuildHandle | null = null;
  /** Set at the top of start(), before `this.handle` exists — see `lastActivityAt()`. Covers the warmup gap (resolveVite, hasBuildableViteEntry, `build()` resolving) with the same mechanism used once the watcher itself is live. */
  private startedAt: Date | null = null;

  constructor(
    private readonly cwd: string,
    private readonly eventBus: IEventBus,
    private readonly starter: ViteBuildStarter = defaultViteBuildStarter
  ) {
    this.state = { state: 'pending', timestamp: new Date() };
  }

  async start(): Promise<void> {
    if (this.handle) return;
    this.eventBus.emit(SignalRunnerEvents.Started, { signalType: this.signalType });
    // A restart (see QualityWatcher.restartWedgedSignal) calls stop() then
    // start() on this same instance — without this reset, `state` would
    // keep showing the stale pass/fail result that got it restarted in the
    // first place until the fresh watcher's own first cycle completes,
    // which for a cold restart can take a while. 'pending' is exempt from
    // the wedged check (see restartWatchModeSignalsIfWedged), so resetting
    // here is what actually stops a slow-to-restart signal from being
    // killed again before it gets a fair chance to converge.
    this.state = { state: 'pending', timestamp: new Date() };
    this.startedAt = new Date();
    try {
      this.handle = await this.starter(
        this.cwd,
        () => this.transitionTo({ state: 'running', timestamp: new Date(), failures: [] }),
        (result) =>
          this.transitionTo(
            result.failures.length > 0
              ? { state: 'fail', timestamp: new Date(), failures: result.failures, warnings: result.warnings }
              : { state: 'pass', timestamp: new Date(), warnings: result.warnings }
          )
      );
    } catch (error) {
      // The build watcher failing to start at all (a fatal config error,
      // not a build-cycle failure the event stream would otherwise report)
      // must not propagate past this runner nor the process — same
      // reasoning as VitestSignalRunner's own start() catch.
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

  /**
   * A full stop()/start() cycle — not a true detach/reattach pause, same
   * reasoning as `ProcessWatchSignalRunner.pause()`. The watcher `build()`
   * returns here is only exposed through a minimally-typed `{on, close}`
   * shape (see the cast above); there's no confirmed public
   * detach/reattach primitive the way Vitest's `VitestWatcher` has, and
   * this repo's installed Vite (rolldown-vite) is new enough that its
   * internals can't be assumed to match classic Rollup's. `getState()`
   * correctly reports `pending` between pause() and the fresh watcher's
   * first cycle, since start() already resets state to `pending`.
   */
  async pause(): Promise<void> {
    await this.stop();
  }

  /** See pause()'s doc comment — the resume counterpart is just start(). */
  async resume(): Promise<void> {
    await this.start();
  }

  private transitionTo(newState: SignalState): void {
    this.state = newState;
    this.eventBus.emit(SignalRunnerEvents.StateChanged, { signalType: this.signalType, state: newState });
  }
}
