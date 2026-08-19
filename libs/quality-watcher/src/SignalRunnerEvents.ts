/**
 * Signal Runner Events
 *
 * Events emitted by signal runners using the @minions/events EventBus.
 * These events notify orchestrators of runner lifecycle and state changes.
 */

import { defineEvent } from '@minions/events';
import type { SignalType, SignalState } from './SignalState.js';

/**
 * Signal runner events
 *
 * All signal runners emit these events via the injected EventBus.
 * Event types:
 * - Started: Runner has begun execution
 * - Stopped: Runner has stopped (either completed or halted)
 * - StateChanged: Signal state has changed (includes signal type and new state)
 * - Error: Runner encountered an error (includes signal type and error details)
 *
 * @example
 * ```typescript
 * // Subscribe to state changes
 * eventBus.on(SignalRunnerEvents.StateChanged, (event) => {
 *   console.log('Signal type:', event.signalType);
 *   console.log('New state:', event.state.state);
 * });
 *
 * // Emit from runner
 * eventBus.emit(SignalRunnerEvents.Started, {
 *   signalType: SignalType.Tests,
 * });
 * ```
 */
export const SignalRunnerEvents = {
  Started: defineEvent<{ signalType: SignalType }>('signal-runner:started'),
  Stopped: defineEvent<{ signalType: SignalType }>('signal-runner:stopped'),
  StateChanged: defineEvent<{ signalType: SignalType; state: SignalState }>('signal-runner:state-changed'),
  Error: defineEvent<{ signalType: SignalType; error: Error }>('signal-runner:error'),
} as const;
