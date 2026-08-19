import type { UserMessage, ToolResultMessage } from './MinionMessage';

/**
 * Test prompts for triggering specific responses from BrainlessMinion's default back-side co-routine
 *
 * These prompts can be sent to BrainlessMinion (with default back-side enabled) to generate
 * predictable responses of different message types. This enables easy testing without needing
 * to implement custom back-side co-routines for simple cases.
 *
 * Usage:
 * ```typescript
 * await minion.send(promptForText('hello'));
 * const response = await minion.receive().next();
 * // response will be a text message with "hello"
 * ```
 */

/**
 * Standard test prompts that trigger specific response types
 */
export const TEST_PROMPTS = {
  /** Triggers a simple text response with help information */
  HELP: '/help',

  /** Triggers exact text response: "hi" */
  ECHO_HI: 'respond with exactly "hi"',

  /** Gracefully stops the minion */
  EXIT: '/exit',

  /** Triggers a thinking message followed by text response */
  THINKING: '/think about this problem',

  /** Triggers a tool use request */
  TOOL_USE: '/use tool read_file with path=/test.txt',

  /** Triggers an error response */
  ERROR: '/trigger error',

  /** Triggers a status update */
  STATUS: '/status update',
} as const;

/**
 * Generate a user message that triggers a text response
 */
export function promptForText(text: string): UserMessage {
  return {
    type: 'user',
    content: `/echo ${text}`,
    timestamp: Date.now()
  };
}

/**
 * Generate a user message that triggers a thinking message with specific content
 */
export function promptForThinking(thinkingContent: string): UserMessage {
  return {
    type: 'user',
    content: `/think ${thinkingContent}`,
    timestamp: Date.now()
  };
}

/**
 * Generate a user message that triggers a tool use with specific parameters
 */
export function promptForToolUse(toolName: string, toolInput: Record<string, unknown>): UserMessage {
  return {
    type: 'user',
    content: `/use tool ${toolName} with ${JSON.stringify(toolInput)}`,
    timestamp: Date.now()
  };
}

/**
 * Generate a user message that triggers an error with specific message
 */
export function promptForError(errorMessage: string, errorCode?: string): UserMessage {
  return {
    type: 'user',
    content: errorCode ? `/error ${errorCode}: ${errorMessage}` : `/error ${errorMessage}`,
    timestamp: Date.now()
  };
}

/**
 * Generate a user message that triggers a status update
 */
export function promptForStatus(status: string): UserMessage {
  return {
    type: 'user',
    content: `/status ${status}`,
    timestamp: Date.now()
  };
}

/**
 * Helper to create test tool result messages
 */
export function createToolResult(toolUseId: string, result: unknown, isError = false): ToolResultMessage {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: result,
    is_error: isError,
    timestamp: Date.now()
  };
}
