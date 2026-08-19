import { Data, Effect } from 'effect';
import type { AnyEventDeclaration, TypedEvent } from '@minions/events';
import type { SerializedEvent } from './EventSerialization';

/**
 * Event Persister Port Interface
 *
 * Defines the contract for event persistence implementations (file-based,
 * database, in-memory for tests). This is a hexagonal architecture PORT
 * in the conductor domain - implementations are adapters.
 *
 * Key capabilities:
 * - Append events incrementally (streaming writes)
 * - Load all events for replay
 * - Check existence and count for resume logic
 * - Clear for test scenarios
 * - Proper resource cleanup
 *
 * The Effect-based design provides:
 * - Consistent error handling via PersistError
 * - Composable operations
 * - Safe resource management
 */

/**
 * Event persistence error
 *
 * Represents failures in event persistence operations (I/O errors,
 * permission issues, corruption, etc.).
 */
export class PersistError extends Data.TaggedError('PersistError')<{
  /** Human-readable error message */
  message: string;
  /** Original error if available */
  cause?: unknown;
}> {}

/**
 * Event persister port interface
 *
 * This port allows the conductor domain to persist and load events
 * without depending on specific storage implementations. Adapters
 * can provide file-based, database, or in-memory implementations.
 *
 * Thread safety: Implementations should be safe for sequential access
 * within a single mission run. Concurrent access across multiple runs
 * is not required.
 *
 * @example
 * ```typescript
 * // Append events as they occur
 * const appendEffect = persister.append(event);
 * await Effect.runPromise(appendEffect);
 *
 * // Ensure all events written before continuing
 * const flushEffect = persister.flush();
 * await Effect.runPromise(flushEffect);
 *
 * // Load all events for replay
 * const loadEffect = persister.load();
 * const events = await Effect.runPromise(loadEffect);
 *
 * // Check if we're resuming or starting fresh
 * const existsEffect = persister.exists();
 * const hasEvents = await Effect.runPromise(existsEffect);
 *
 * // Get count without loading all events
 * const countEffect = persister.count();
 * const eventCount = await Effect.runPromise(countEffect);
 *
 * // Clear for test scenarios
 * const clearEffect = persister.clear();
 * await Effect.runPromise(clearEffect);
 *
 * // Cleanup when done
 * const closeEffect = persister.close();
 * await Effect.runPromise(closeEffect);
 * ```
 */
export interface IEventPersister {
  /**
   * Append a single event to persistence
   *
   * Writes the event in a streaming fashion (e.g., append to JSON Lines file).
   * May buffer writes internally - call flush() to ensure all events are
   * written to durable storage.
   *
   * @param event - The TypedEvent to persist
   * @returns Effect that succeeds with void or fails with PersistError
   */
  append(
    event: TypedEvent<AnyEventDeclaration>
  ): Effect.Effect<void, PersistError, never>;

  /**
   * Flush all buffered events to durable storage
   *
   * Ensures all previously appended events are written and synced.
   * This is critical before mission completion or before expecting
   * events to be readable by another process.
   *
   * @returns Effect that succeeds with void or fails with PersistError
   */
  flush(): Effect.Effect<void, PersistError, never>;

  /**
   * Load all persisted events
   *
   * Reads all events from storage and returns them in chronological order.
   * Used for mission state reconstruction and replay.
   *
   * @returns Effect that succeeds with array of SerializedEvent or fails with PersistError
   */
  load(): Effect.Effect<SerializedEvent[], PersistError, never>;

  /**
   * Check if any events exist in storage
   *
   * Used to determine if a mission is resuming (events exist) or
   * starting fresh (no events).
   *
   * @returns Effect that succeeds with boolean or fails with PersistError
   */
  exists(): Effect.Effect<boolean, PersistError, never>;

  /**
   * Get count of persisted events without loading them all
   *
   * Efficient way to check how many events are stored without reading
   * all event data into memory. Useful for progress indicators and
   * resume logic.
   *
   * @returns Effect that succeeds with event count or fails with PersistError
   */
  count(): Effect.Effect<number, PersistError, never>;

  /**
   * Clear all persisted events
   *
   * Removes all events from storage. Primarily used in test scenarios
   * where missions need to start completely fresh.
   *
   * Warning: This is destructive and should only be used when you're
   * certain you want to lose all event history.
   *
   * @returns Effect that succeeds with void or fails with PersistError
   */
  clear(): Effect.Effect<void, PersistError, never>;

  /**
   * Cleanup and release resources
   *
   * Closes any file handles, database connections, or other resources.
   * Should be called when the persister is no longer needed.
   *
   * Implementations should be idempotent - calling close() multiple times
   * should be safe.
   *
   * @returns Effect that succeeds with void or fails with PersistError
   */
  close(): Effect.Effect<void, PersistError, never>;
}
