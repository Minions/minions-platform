/**
 * Conductor Library - Public API
 *
 * The Conductor library enables deterministic script-driven missions
 * that orchestrate non-deterministic AI agents.
 *
 * Phase 0: TrivialRunner
 * - Spawns Claude Code via Hatchery
 * - Sends /mission-name as the first message
 * - Streams minion output as events
 *
 * Phase 1: Core Types & Interfaces
 * - Mission<TArgs> with typed arguments
 * - MissionContext for emit/spawn/ask
 * - Port interfaces for loader and runner
 */

// Domain Types - Events
export type {
  MissionEvent,
  MissionEventData,
  MissionStartedEvent,
  MissionCompletedEvent,
  MissionFailedEvent,
  MissionCancelledEvent,
  MissionProgressEvent,
  MissionLogEvent,
  MinionSpawnedEvent,
  MinionMessageEvent,
  MinionCompletedEvent,
  IMissionHandle,
} from './domain';

export { MissionHandle } from './domain';

// Re-export Effect for mission authors — avoids requiring a separate 'effect' dependency
export { Effect } from 'effect';

// Domain Types - Mission Definition (Phase 1)
export type {
  Mission,
  MissionArgsSchema,
  MissionPropertySchema,
  MissionContext,
  SpawnOptions,
  AskOptions,
  LairApi,
  CostumeInstallResult,
  InstalledCostumeSummary,
} from './domain';

export { isMission, isPromiseMission, isCostume, createLairApi, MissionExecutionError } from './domain';

// Mission utilities
export { attempt } from './utils/attempt.js';

// Domain Types - Costume Definition
export type {
  Costume,
  CostumeEvent,
  Skill,
} from './domain';

// Domain Types - Event Declaration System
export type {
  EventDeclaration,
  PayloadOf,
  TypedEvent,
} from './domain';

export { defineEvent, defineChildEvent, WellKnownEvents, getAncestorChain } from './domain';

// Domain Types - Event Bus
export type {
  IEventBus,
  EventSource,
  EventFilterOptions,
  Unsubscribe,
} from './domain';

export { EventBus, Src } from './domain';

// Domain Types - Workbench
export type {
  IWorkbench,
  FileKnowledge,
  ProjectFact,
} from './domain';

export { Workbench } from './domain';

// Port Interfaces (Phase 1)
export type {
  IMissionLoader,
  LoadedMission,
  MissionInfo,
  IMissionRunner,
  StartMissionOptions,
  IQuestionBridge,
} from './ports';

// Adapters
export { TrivialRunner, type TrivialMissionOptions } from './adapters';
export { ClosetMissionLoader, type ClosetMissionLoaderOptions } from './adapters';
export { ClosetCostumeLoader, LoadError } from './adapters';
export { DefaultMissionContext, DefaultMissionContextFactory, type DefaultMissionContextDeps } from './adapters';
export { DefaultMissionRunner, type DefaultMissionRunnerDeps } from './adapters';
export { LegacyMissionWrapper } from './adapters';
export { FileEventPersister } from './adapters';
export { EventPersistenceSubscription } from './adapters';

// Domain Types - Event Persistence
export type { IEventPersister } from './domain';
export { PersistError } from './domain';
export type { SerializedEvent } from './domain';
export {
  serializeEvent,
  deserializeEvent,
  serializeEventToJsonLine,
  deserializeEventFromJsonLine,
} from './domain';
export { loadEvents } from './domain';

// Domain Types - Mission Events (typed event declarations)
export { MissionEvents } from './domain';

// Domain Types - Orchestration State Reconstruction
export type { OrchestrationState } from './domain';
export {
  reconstructOrchestrationState,
  createInitialOrchestrationState,
  applyEventToState,
} from './domain';
