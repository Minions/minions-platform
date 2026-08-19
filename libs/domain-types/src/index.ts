/**
 * Domain Types - Shared domain types for minions ecosystem
 *
 * This package contains the shared domain types that both conductor and hatchery
 * depend on, breaking the circular peer dependency.
 *
 * Key types:
 * - IMinion: Core minion interface (port)
 * - MinionSpec: Specification for creating a minion
 * - MinionMessage: Bidirectional message types
 * - MinionClient: Supported client types
 */

// Core Minion Interface
export type { IMinion, MessageFilter } from './IMinion';
export { ReconfigureError } from './IMinion';

// Minion Specification
export type { MinionSpec, MinionClient, Tool } from './MinionSpec';

// Minion Messages
export type {
  MinionMessage,
  UserMessage,
  TextMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  ErrorMessage,
  StatusMessage,
} from './MinionMessage';

// Workbench
export type {
  IWorkbench,
  FileKnowledge,
  ProjectFact,
  FileChangeEvent,
  FileChangeCallback,
  FileHandle,
} from './Workbench';

// Workbench Injection
export { workbenchToSyntheticHistory } from './WorkbenchInjection';
