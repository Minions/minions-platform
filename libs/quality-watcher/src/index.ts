/**
 * The Platform-generic surface of this package: types, pure functions, and
 * the `IQualityWatcher`/`QualityWatcherFactory` interfaces every caller
 * outside this package should depend on — never `adapters/` directly (see
 * `QualityWatcherFactory.ts`'s doc comment for why). This is also, verbatim,
 * the export surface `minions-platform`'s copy of this package ships as its
 * own `index.ts` — everything named here (plus `adapters/mergeQualityStatus.js`,
 * the one pure file physically under `adapters/`) is what that extraction
 * copies; nothing else in `adapters/` goes with it.
 */
export { SignalType, type SignalState } from './SignalState.js';
export { GLOBAL_SIGNALS, DEV_SIGNALS } from './SignalCategory.js';
export {
  type QualityStatus,
  type OverallState,
  calculateOverallState,
  applyWarningPolicy,
  allPendingQualityStatus,
  simplifyForReporting,
} from './QualityStatus.js';
export {
  type WireSignalState,
  type WireQualityStatus,
  toWireQualityStatus,
  fromWireQualityStatus,
} from './QualityStatusWireFormat.js';
export { type WatchMode } from './WatchMode.js';
export {
  type QualityStreamPayload,
  type QualityStreamEmergency,
  type WingQualityEntry,
  buildQualityStreamPayload,
} from './QualityStreamPayload.js';
export { type IQualityWatcher } from './IQualityWatcher.js';
export { MockQualityWatcher } from './MockQualityWatcher.js';
export {
  type ISignalRunner,
  type ExecutionStrategy,
  type SignalRunnerEvent,
} from './ISignalRunner.js';
export { SignalRunnerEvents } from './SignalRunnerEvents.js';
export { type QualityWatcherFactory } from './QualityWatcherFactory.js';
export { mergeQualityStatuses, combineSignalStates } from './adapters/mergeQualityStatus.js';
