/**
 * Quality Watcher
 *
 * Background quality monitoring system for continuously tracking the state
 * of tests, types, lint, build, oxlint, and custom-rules-only lint.
 */

export { SignalType, type SignalState } from './SignalState.js';
export { GLOBAL_SIGNALS, DEV_SIGNALS } from './SignalCategory.js';
export {
  type QualityStatus,
  type OverallState,
  calculateOverallState,
  applyWarningPolicy,
  allPendingQualityStatus,
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
export { type ProcessRunner, type ProcessResult, runProcessCommand } from './adapters/runProcess.js';
export { FileTriggeredSignalRunner, isIgnoredPath } from './adapters/FileTriggeredSignalRunner.js';
export {
  SignalWedgeMonitor,
  SignalWedgeEvents,
  isSettled,
  type SignalWedgeMonitorOptions,
} from './adapters/SignalWedgeMonitor.js';
export { TEST_FILE_PATTERN } from './adapters/hasAnyTestFile.js';
export { AlwaysPassSignalRunner } from './adapters/AlwaysPassSignalRunner.js';
export { QualityWatcher, type QualityWatcherOptions } from './adapters/QualityWatcher.js';
export { WingQualityWatcher } from './adapters/WingQualityWatcher.js';
export { RemoteQualityWatcher, buildStatusUrl, parseStatusResponse } from './adapters/RemoteQualityWatcher.js';
export { mergeQualityStatuses, combineSignalStates } from './adapters/mergeQualityStatus.js';
export { createSharedFsWatch } from './adapters/sharedFsWatch.js';
export {
  ProcessWatchSignalRunner,
  type WatchedChildProcess,
  type WatchOutputParser,
} from './adapters/ProcessWatchSignalRunner.js';
export { parseTscWatchOutput } from './adapters/parseTscWatchOutput.js';
export { VueTscWatchSignalRunner } from './adapters/VueTscWatchSignalRunner.js';
export { VitestSignalRunner, createVitestStarter, type VitestStarter, type VitestRunResult } from './adapters/VitestSignalRunner.js';
export { createWarningCapturingLogger } from './adapters/createWarningCapturingLogger.js';
export { discoverVitestProjectDirs } from './adapters/discoverVitestProjectDirs.js';
export {
  ViteBuildWatchSignalRunner,
  createViteBuildStarter,
  type ViteBuildStarter,
  type ViteBuildCycleResult,
} from './adapters/ViteBuildWatchSignalRunner.js';
export {
  hasWorkRepoPackage,
  resolveFromSources,
  workRepoPackageEntrySource,
  resolveWorkRepoPackageEntry,
  type PackageResolver,
  type PackageResolution,
  type PackageSource,
  type PackageEntryResolution,
  type WorkRepoPackageEntry,
  type WorkRepoPackageEntryOptions,
} from './adapters/resolveWorkRepoPackage.js';
export {
  resolveWorkRepoVite,
  type ViteResolution,
  MIN_SUPPORTED_VITE_MAJOR,
  MAX_SUPPORTED_VITE_MAJOR,
} from './adapters/resolveWorkRepoVite.js';
export {
  resolveWorkRepoVitest,
  type VitestResolution,
  MIN_SUPPORTED_VITEST_MAJOR,
  MAX_SUPPORTED_VITEST_MAJOR,
} from './adapters/resolveWorkRepoVitest.js';
export {
  runOxlint,
  createOxlintProcess,
  materializeDefaultOxlintConfig,
  type FallbackOxlint,
  type CreateOxlintProcessOptions,
} from './adapters/runOxlint.js';
export { DEFAULT_OXLINT_CONFIG } from './adapters/defaultOxlintConfig.js';
export {
  runCustomLint,
  createCustomLintProcess,
  resetCustomLintInstance,
  loadRuleDataFile,
  resetRuleDataFileCache,
  CUSTOM_LINT_CONFIG_FILENAME,
  type CreateCustomLintProcessOptions,
} from './adapters/runCustomLint.js';
export {
  ensureNxProjectGraphCache,
  resetNxProjectGraphCache,
  type Spawner as NxProjectGraphSpawner,
} from './adapters/ensureNxProjectGraphCache.js';
