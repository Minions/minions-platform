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
export type MinionMessage = UserMessage | TextMessage | ThinkingMessage | ToolUseMessage | ToolResultMessage | ErrorMessage | StatusMessage;
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
    id: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
/**
 * Tool result message - result from tool execution back to minion
 */
export interface ToolResultMessage {
    type: 'tool_result';
    tool_use_id: string;
    content: unknown;
    is_error?: boolean;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
/**
 * Error message - error from the minion/client
 */
export interface ErrorMessage {
    type: 'error';
    error: {
        message: string;
        code?: string;
        details?: unknown;
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
    status: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
//# sourceMappingURL=MinionMessage.d.ts.map