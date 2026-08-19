import { EventEmitter } from 'events';
import { ContentBlock } from './events';

/**
 * Simulated minion executor for testing.
 *
 * This executor provides full control over the turn lifecycle and event emission,
 * allowing tests to simulate various scenarios without hitting real APIs.
 *
 * Key Features:
 * - Granular control: Test code explicitly controls when each event fires
 * - Timing control: Works with fake timers for deterministic timing tests
 * - Same interface: Presents identical interface to ClaudeCodeExecutor and LightweightExecutor
 *
 * Usage in tests:
 * ```typescript
 * const executor = new SimulatedMinionExecutor();
 * await executor.start();
 *
 * executor.sendMessage('Hello'); // Emits 'turn_started'
 * await executor.respondWith({ type: 'message', content: 'Hi', role: 'assistant' }); // Emits 'content'
 * await executor.finishTurn(); // Emits 'turn_ended'
 *
 * executor.stop(); // Emits 'session_ended'
 * ```
 */
export class SimulatedMinionExecutor extends EventEmitter {
  private sessionActive = false;
  private turnActive = false;

  /**
   * Initialize the session.
   * Must be called before sendMessage().
   */
  async start(): Promise<void> {
    if (this.sessionActive) {
      throw new Error('Session already active');
    }
    this.sessionActive = true;
    this.turnActive = false;
  }

  /**
   * Send a message to the executor.
   * Starts a new turn and emits 'turn_started'.
   *
   * @param _message - The message to send (unused in simulation, test controls responses)
   * @throws If session is not active or a turn is already in progress
   */
  sendMessage(_message: string): void {
    if (!this.sessionActive) {
      throw new Error('Session not active');
    }
    if (this.turnActive) {
      throw new Error(
        'Turn already in progress - call finishTurn() first'
      );
    }

    this.turnActive = true;
    this.emit('turn_started');
  }

  /**
   * Simulate response content blocks.
   * Emits 'content' event for each block.
   * Can be called multiple times during a turn to simulate streaming.
   *
   * @param blocks - One or more content blocks to emit
   * @throws If no turn is active
   */
  async respondWith(...blocks: ContentBlock[]): Promise<void> {
    if (!this.turnActive) {
      throw new Error('No turn active - call sendMessage() first');
    }

    for (const block of blocks) {
      this.emit('content', block);
    }
  }

  /**
   * Finish the current turn.
   * Emits 'turn_ended' and allows a new turn to begin.
   *
   * @throws If no turn is active
   */
  async finishTurn(): Promise<void> {
    if (!this.turnActive) {
      throw new Error('No turn active');
    }

    this.emit('turn_ended');
    this.turnActive = false;
  }

  /**
   * Emit an error event.
   * Does not end the turn or session - allows testing error recovery.
   *
   * @param error - The error to emit
   */
  emitError(error: Error): void {
    this.emit('error', error);
  }

  /**
   * Stop the session.
   * Emits 'session_ended' and sets session to inactive.
   * Can be called during an active turn.
   */
  stop(): void {
    this.sessionActive = false;
    this.turnActive = false;
    this.emit('session_ended');
  }

  /**
   * Check if the session is currently active.
   *
   * @returns true if session is active, false otherwise
   */
  isRunning(): boolean {
    return this.sessionActive;
  }
}
