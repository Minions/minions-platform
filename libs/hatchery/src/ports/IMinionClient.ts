import type { MinionSpec, MinionMessage } from '@minions/domain-types';

/**
 * Client abstraction for different AI implementations
 *
 * IMinionClient abstracts over different AI client types (Claude Code, Anthropic SDK, etc.)
 * Each client implementation handles the specifics of spawning processes, managing connections,
 * and translating messages to/from the client's format.
 *
 * Clients are always running from start() until stop(). They handle the low-level communication
 * with the actual AI service or process.
 *
 * Implementations:
 * - ClaudeCodeClient: Spawns claude CLI process
 * - AnthropicAgenticClient: Uses Anthropic SDK
 * - OpenCodeClient: Integrates with OpenCode
 * - CodePuppyClient: Integrates with CodePuppy
 * - BrainlessClient: Test fake for testing
 */
export interface IMinionClient {
  /** Client type identifier (e.g., 'claude-code', 'anthropic-agentic') */
  readonly type: string;

  /**
   * Start the client with given specification
   *
   * This may involve:
   * - Spawning a subprocess (Claude Code, OpenCode, CodePuppy)
   * - Initializing SDK connection (Anthropic)
   * - Setting up streams and communication channels
   *
   * The client should be ready to send/receive messages after this completes.
   *
   * @param spec - Minion specification with client configuration
   */
  start(spec: MinionSpec): Promise<void>;

  /**
   * Stop the client and clean up resources
   *
   * This may involve:
   * - Terminating subprocesses
   * - Closing connections
   * - Cleaning up streams
   *
   * After calling stop(), the receive() iterator should complete.
   */
  stop(): Promise<void>;

  /**
   * Send a message to the client
   *
   * @param message - Message to send to the client
   */
  send(message: MinionMessage): Promise<void>;

  /**
   * Receive messages from the client
   *
   * This async iterator runs until the client is stopped and provides a COMPLETE TRANSCRIPT
   * of all information related to the minion, including:
   * - All stdout output (as StatusMessage with metadata.source='stdout')
   * - All stderr output (as ErrorMessage with metadata.source='stderr')
   * - Parsed/structured messages (TextMessage, etc.)
   *
   * The transcript requirement ensures that consumers can reconstruct the full execution
   * history and debug issues by examining all output from the underlying process.
   *
   * @returns Async iterator that yields messages from the client
   */
  receive(): AsyncIterableIterator<MinionMessage>;

  /**
   * Kill the client immediately (may kill process or terminate connection)
   */
  kill(): void;

  /**
   * Interrupt the client's current operation (may send escape/interrupt signal)
   */
  interrupt(): void;
}
