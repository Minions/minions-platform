import { Data, Effect } from 'effect';
import type { MinionSpec } from './MinionSpec';
import type { MinionMessage } from './MinionMessage';
import type { Costume } from '@minions/costumes';

/**
 * Error thrown when minion reconfiguration fails
 *
 * Common reasons:
 * - Attempting to change the model (not allowed)
 * - Invalid costume properties
 */
export class ReconfigureError extends Data.TaggedError('ReconfigureError')<{
  reason: string;
  minionId: string;
}> {}

/**
 * Filter options for receiving messages
 */
export interface MessageFilter {
  /** Filter to a single message type */
  type?: string;
  /** Filter to multiple message types */
  types?: string[];
}

/**
 * Core minion interface - represents a bidirectional async communication channel
 *
 * IMinion provides a simple co-routine abstraction for communicating with AI agents.
 * Minions are always running from creation until they die. When a minion dies,
 * the receive() iterator completes.
 *
 * Production code sends messages via send() and receives responses via the receive()
 * async iterator co-routine.
 *
 * Different implementations:
 * - RealMinion: Communicates with actual AI clients
 * - BrainlessMinion: Test fake with dual co-routines for testing
 */
export interface IMinion {
  /** Unique identifier for this minion instance */
  readonly id: string;

  /** Specification used to create this minion */
  readonly spec: MinionSpec;

  /**
   * Current costume configuration for this minion
   *
   * If the minion was spawned with a costume, this reflects the current costume
   * configuration (including any changes from reconfigure()).
   *
   * If the minion was spawned without a costume (legacy spawn), this is undefined.
   */
  readonly costume?: Costume;

  /**
   * Send a message to the minion (production → minion)
   *
   * @param message - Message to send to the minion
   */
  send(message: MinionMessage): Promise<void>;

  /**
   * Receive messages from the minion (minion → production)
   *
   * This async iterator runs until the minion dies. When the minion
   * is no longer alive, the iterator completes.
   *
   * @param filter - Optional filter to receive only specific message types
   * @returns Async iterator that yields messages from the minion
   */
  receive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage>;

  /**
   * Reconfigure this minion with a new costume
   *
   * Completely replaces the current costume with the provided costume.
   * This is like "taking off costume A and putting on costume B".
   *
   * **Important constraints:**
   * - The model CANNOT be changed. Attempting to change the model will fail
   *   with ReconfigureError.
   * - The workbench is preserved (when implemented). Reconfiguring does not
   *   affect the minion's workbench or context.
   * - The minion ID remains unchanged.
   *
   * **Complete replacement semantics:**
   * - After reconfigure from A to B, the minion looks identical to if it was
   *   spawned with costume B.
   * - All properties from the old costume are discarded.
   * - There is no blending or merging of properties.
   *
   * @param costume - Complete costume to replace the current costume with
   * @returns Effect that succeeds with void or fails with ReconfigureError
   *
   * @example
   * ```typescript
   * // Replace entire costume
   * const newCostume: Costume = {
   *   model: 'same-model', // Must match current model
   *   systemPrompt: 'You are now a code reviewer...',
   *   gadgets: [reviewGadget],
   *   skills: [],
   *   events: [reviewEvent],
   *   injectFacts: ['structure']
   * };
   * yield* minion.reconfigure(newCostume)
   *
   * // This will FAIL - cannot change model
   * const invalidCostume: Costume = {
   *   model: 'different-model',  // ❌ ReconfigureError
   *   // ... rest of costume
   * };
   * yield* minion.reconfigure(invalidCostume)
   * ```
   */
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never>;

  /**
   * Current processing status of the minion
   *
   * Status transitions:
   * - 'waiting' -> 'processing' (on send)
   * - 'processing' -> 'waiting' (on turn complete)
   * - any -> 'dead' (after kill)
   *
   * The status is exposed as an Effect Ref for reactive monitoring.
   */
  readonly status: 'processing' | 'waiting' | 'dead';

  /**
   * Kill the minion, terminating its process/execution
   *
   * For real minions, this may kill the underlying process or send a termination message.
   * For test minions, this stops the minion's co-routines.
   * After calling kill(), the receive() iterator will complete.
   */
  kill(): void;

  /**
   * Interrupt the minion's current operation
   *
   * For real minions, this may send an escape keypress or interrupt signal.
   * For test minions, this may interrupt the current back-side operation.
   * The minion continues running after interrupt, but may cancel its current task.
   */
  interrupt(): void;
}
