/**
 * Process Watch Signal Runner
 *
 * Generic ISignalRunner for tools whose own watch mode is a long-lived
 * subprocess with no in-process Node API — vue-tsc's `--watch` today; any
 * future signal source that only exposes a CLI is a new instance of this,
 * not a new class. The subprocess is spawned ONCE at start() and lives for
 * the runner's lifetime; there is no per-file-change respawn — the tool's
 * own watch mode does the incremental work and this adapter just parses its
 * stdout stream for cycle boundaries.
 *
 * The quality-watcher never sees the subprocess directly: this adapter owns
 * spawning it, buffering its output, and turning that output into
 * SignalState transitions via an injected parser.
 */

import type { IEventBus } from '@minions/events';
import type { ISignalRunner, ExecutionStrategy } from '../ISignalRunner.js';
import { SignalType, type SignalState } from '../SignalState.js';
import { SignalRunnerEvents } from '../SignalRunnerEvents.js';
import { killProcessTree } from './killProcessTree.js';

/** Minimal shape this runner needs from a spawned child process. */
export type WatchedChildProcess = {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  kill(): void;
  /** PID of the spawned process, when known — used to kill its whole subtree (see killProcessTree). */
  pid?: number;
};

/**
 * Scans `buffer` (all output received so far since the last successful
 * parse) for one complete watch-cycle result. Returns null if no full cycle
 * boundary has appeared yet — the runner keeps buffering.
 *
 * `consumedThrough` tells the runner how much of `buffer` this parse
 * consumed, so it can slice the remainder off for the next call rather than
 * re-scanning output already accounted for.
 */
export type WatchOutputParser = (buffer: string) => { consumedThrough: number; state: SignalState } | null;

export class ProcessWatchSignalRunner implements ISignalRunner {
  readonly strategy: ExecutionStrategy = 'watch-mode';

  private state: SignalState;
  private child: WatchedChildProcess | null = null;
  private buffer = '';
  /** Set on every stdout/stderr chunk received — see `lastActivityAt()`. A black-box CLI subprocess exposes no finer progress signal than "it's still writing to its own output streams." */
  private lastActivity: Date | null = null;

  constructor(
    readonly signalType: SignalType,
    private readonly spawnProcess: () => WatchedChildProcess,
    private readonly parseOutput: WatchOutputParser,
    private readonly eventBus: IEventBus
  ) {
    this.state = { state: 'pending', timestamp: new Date() };
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.eventBus.emit(SignalRunnerEvents.Started, { signalType: this.signalType });
    // A restart (see QualityWatcher.restartWedgedSignal) calls stop() then
    // start() on this same instance — without this reset, `state` would
    // keep showing the stale pass/fail result that got it restarted in the
    // first place until the fresh process's own first cycle completes,
    // which for a cold restart can take a while. 'pending' is exempt from
    // the wedged check (see restartWatchModeSignalsIfWedged), so resetting
    // here is what actually stops a slow-to-restart signal from being
    // killed again before it gets a fair chance to converge.
    this.state = { state: 'pending', timestamp: new Date() };
    // Seeded here, not left null until the first chunk — covers the
    // warmup gap (process spawned but hasn't written anything yet) with
    // the exact same "how long since real evidence of life" mechanism
    // used once output starts, instead of leaving that window as a blind
    // spot only a coarser, separate cold-start timeout could see.
    this.lastActivity = new Date();
    this.child = this.spawnProcess();

    const onChunk = (chunk: Buffer | string) => {
      this.lastActivity = new Date();
      this.buffer += chunk.toString();
      this.drainBuffer();
    };
    this.child.stdout?.on('data', onChunk);
    this.child.stderr?.on('data', onChunk);
  }

  async stop(): Promise<void> {
    if (this.child) killProcessTree(this.child);
    this.child = null;
    this.buffer = '';
    this.eventBus.emit(SignalRunnerEvents.Stopped, { signalType: this.signalType });
  }

  getState(): SignalState {
    return this.state;
  }

  /** See `ISignalRunner.lastActivityAt`'s doc comment. */
  lastActivityAt(): Date | null {
    return this.lastActivity;
  }

  /**
   * A full stop()/start() cycle — not a true detach/reattach pause. The
   * watched tool's watch mode is a black-box subprocess with no known
   * cheaper mechanism to stop it reacting to file changes short of killing
   * it (unlike VitestSignalRunner, which has a public API for exactly
   * this — see its own pause() doc comment). Still worth having: whatever
   * incremental-rebuild caching the tool itself does on disk (e.g. tsc's
   * `.tsbuildinfo`) bounds the cost of the restart on resume(), and it's
   * strictly better than reacting to every file touched during, say, a git
   * rebase. `getState()` correctly reports `pending` between pause() and
   * the fresh process's first result, since start() already resets state
   * to `pending` — no special-casing needed here.
   */
  async pause(): Promise<void> {
    await this.stop();
  }

  /** See pause()'s doc comment — the resume counterpart is just start(). */
  async resume(): Promise<void> {
    await this.start();
  }

  private drainBuffer(): void {
    let result = this.parseOutput(this.buffer);
    while (result) {
      this.buffer = this.buffer.slice(result.consumedThrough);
      this.transitionTo(result.state);
      result = this.parseOutput(this.buffer);
    }
  }

  private transitionTo(newState: SignalState): void {
    this.state = newState;
    this.eventBus.emit(SignalRunnerEvents.StateChanged, { signalType: this.signalType, state: newState });
  }
}
