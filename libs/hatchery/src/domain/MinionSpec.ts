import type { Costume } from '@minions/costumes';

/**
 * Supported minion client types
 */
export type MinionClient =
  | 'claude-code'
  | 'anthropic-agentic'
  | 'opencode'
  | 'code-puppy'
  | 'brainless';

/**
 * MCP-style tool definition
 */
export interface Tool {
  name: string;
  description: string;
  input_schema?: unknown;
}

/**
 * Specification for creating a minion
 *
 * A MinionSpec is a declarative description of how to create and configure a minion.
 * It includes the client type, working directory (wing), model selection,
 * and optional configuration for prompts, tools, and metadata.
 */
export interface MinionSpec {
  /** Which AI client to use for this minion */
  client: MinionClient;

  /** Path to the wing (working directory) where the minion operates */
  wing: string;

  /** Model identifier (e.g., "claude-sonnet-4-20250514") */
  model: string;

  /**
   * Whether to use the client's built-in system prompt
   * Default: true
   */
  useBuiltInSystemPrompt: boolean;

  /**
   * Optional custom agent prompt to replace or extend the system prompt
   * Behavior depends on useBuiltInSystemPrompt setting
   */
  agentPrompt?: string;

  /** Optional MCP-style tool definitions to provide to the minion */
  tools?: Tool[];

  /** Optional human-readable name for this minion */
  name?: string;

  /** Optional arbitrary metadata for application use */
  metadata?: Record<string, unknown>;

  /**
   * Optional session ID for conversation history persistence across process restarts.
   *
   * When provided, clients that support native session resumption (e.g., claude-code's
   * --session-id) will use this ID to restore previous conversation context.
   * If not provided, clients may generate their own.
   *
   * Typically generated once by the owning system (e.g., Cabinet) and reused
   * across multiple agent process invocations for the same minion.
   */
  sessionId?: string;

  /**
   * Optional costume configuration
   *
   * When a minion is spawned with a costume, the resolved costume is stored here.
   * This allows minions to track their current costume and support reconfiguration.
   */
  costume?: Costume;
}
