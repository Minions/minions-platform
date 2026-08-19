/**
 * Message structure for bidirectional communication with minions
 *
 * MinionMessage uses discriminated unions to represent all possible message types
 * that any AI client could generate. No translation is performed - these messages
 * represent the raw communication between production code and AI clients.
 *
 * Message flow:
 * - Production → Minion: user messages (requests, prompts)
 * - Minion → Production: text, thinking, tool_use, tool_result, error, status
 */
export type MinionMessage =
  | UserMessage
  | TextMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | ErrorMessage
  | StatusMessage;

/**
 * User message - from production code to minion
 */
export interface UserMessage {
  type: 'user';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Text message - assistant text response from minion
 */
export interface TextMessage {
  type: 'text';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Thinking message - extended reasoning/thinking from minion
 * (e.g., Claude's <thinking> blocks, o1's reasoning traces)
 */
export interface ThinkingMessage {
  type: 'thinking';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Tool use message - minion requesting to execute a tool
 */
export interface ToolUseMessage {
  type: 'tool_use';
  id: string;              // Unique ID for this tool use
  name: string;            // Tool name to execute
  input: Record<string, unknown>; // Tool input parameters (JSON-shaped tool call arguments)
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Tool result message - result from tool execution back to minion
 */
export interface ToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;     // ID of the tool use this responds to
  content: unknown;        // Tool execution result (shape depends on the tool)
  is_error?: boolean;      // Whether the tool execution failed
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Error message - error from the minion/client
 */
export interface ErrorMessage {
  type: 'error';
  error: {
    message: string;       // Human-readable error message
    code?: string;         // Error code (e.g., 'rate_limit', 'invalid_request')
    details?: unknown;     // Additional error details (shape varies by client/error code)
  };
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Status message - status update from minion
 * (e.g., "thinking...", "working...", "done")
 */
export interface StatusMessage {
  type: 'status';
  status: string;          // Status description
  timestamp: number;
  metadata?: Record<string, unknown>;
}
