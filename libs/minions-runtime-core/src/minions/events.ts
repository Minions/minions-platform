/**
 * Content block types for minion executor events.
 * These types are standardized across all executor implementations.
 */
export type ContentBlock =
  | { type: 'reasoning'; content: string }
  | { type: 'message'; content: string; role: 'assistant' }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: string; isError?: boolean };

/**
 * Event interface for all minion executors.
 * All executors (ClaudeCodeExecutor, LightweightExecutor, SimulatedMinionExecutor)
 * must emit these events with identical semantics.
 */
export interface MinionExecutorEvents {
  /**
   * Emitted when Claude begins processing a message.
   * Fired after sendMessage() is called, before any content is emitted.
   */
  turn_started: () => void;

  /**
   * Emitted for each content block (reasoning, message, tool_use, tool_result).
   * Can be emitted multiple times during a single turn.
   */
  content: (block: ContentBlock) => void;

  /**
   * Emitted when turn completes (message fully processed).
   * After this event, a new turn can begin via sendMessage().
   */
  turn_ended: () => void;

  /**
   * Emitted on errors (doesn't end session or turn).
   * The session remains active after an error.
   */
  error: (error: Error) => void;

  /**
   * Emitted when session terminates.
   * Only fired on stop() or fatal error.
   * Includes optional exit code and signal.
   */
  session_ended: (code?: number, signal?: string) => void;
}
