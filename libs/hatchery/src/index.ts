/**
 * Hatchery Domain - Public API
 *
 * This is the barrel export file that exposes the public API of the Hatchery domain.
 */

// Domain Types (re-exported from @minions/domain-types)
export type {
  MinionSpec,
  MinionClient,
  Tool,
  MinionMessage,
  UserMessage,
  TextMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  ErrorMessage,
  StatusMessage,
  IMinion,
  MessageFilter,
} from '@minions/domain-types';
export { ReconfigureError } from '@minions/domain-types';

// Port Interfaces
export type { IHatchery } from './ports/IHatchery';
export type { IMinionClient } from './ports/IMinionClient';
export type { ISpawnEventEmitter } from './ports/ISpawnEventEmitter';

// Production Implementations
export { ProductionHatchery } from './adapters/hatcheries/ProductionHatchery';
export { ClaudeCodeClient } from './adapters/clients/ClaudeCodeClient';
export { OpenCodeClient } from './adapters/clients/OpenCodeClient';
export { RealMinion } from './adapters/minions/RealMinion';

// Test Implementations
export { ZombieHatchery } from './adapters/hatcheries/ZombieHatchery';
export { BrainlessMinion } from './adapters/minions/BrainlessMinion';

// Domain Events
export { MinionEvents } from './domain/MinionEvents';
