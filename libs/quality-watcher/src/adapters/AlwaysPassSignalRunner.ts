import type { ExecutionStrategy, ISignalRunner } from '../ISignalRunner.js';
import type { SignalState, SignalType } from '../SignalState.js';

/**
 * Stand-in for a `SignalType` outside a `QualityWatcher`'s configured active
 * set (see `QualityWatcherOptions.signals`) — e.g. every dev signal, for the
 * cabinet's own global-only watcher. Always reports pass, starts/stops
 * nothing. Exists so `QualityWatcher`'s status shape stays a complete
 * `Record<SignalType, SignalState>` without spawning real tooling (vitest,
 * vue-tsc, oxlint, ...) for a signal this watcher was never configured to
 * check — "not configured" and "nothing to report" are the same fact here.
 */
export class AlwaysPassSignalRunner implements ISignalRunner {
  readonly strategy: ExecutionStrategy = 'on-demand';

  constructor(readonly signalType: SignalType) {}

  // oxlint-disable-next-line no-empty-function -- intentional: nothing to start
  async start(): Promise<void> {}

  // oxlint-disable-next-line no-empty-function -- intentional: nothing to stop
  async stop(): Promise<void> {}

  getState(): SignalState {
    return { state: 'pass', timestamp: new Date() };
  }
}
