/**
 * Domain layer barrel exports
 */

export type { MinionSpec, MinionClient, Tool } from './MinionSpec';
export { MinionEvents } from './MinionEvents';
export type {
  MinionMessage,
  UserMessage,
  TextMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  ErrorMessage,
  StatusMessage
} from './MinionMessage';

export {
  TEST_PROMPTS,
  promptForText,
  promptForThinking,
  promptForToolUse,
  promptForError,
  promptForStatus,
  createToolResult
} from './TestPrompts';

// Re-export Costume from @minions/costumes to avoid type duplication
export type { Costume } from '@minions/costumes';
