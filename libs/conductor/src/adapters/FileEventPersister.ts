/**
 * File-based Event Persister Adapter
 *
 * Implements IEventPersister using file-store's IFile interface.
 * Persists events as JSON Lines format (one event per line).
 *
 * This is a hexagonal architecture ADAPTER that provides file-based
 * event persistence for the conductor domain.
 *
 * Key characteristics:
 * - Uses file-store exclusively (no direct fs access)
 * - Unbuffered writes (immediate append, no internal buffering)
 * - JSON Lines format (one event per line)
 * - Graceful handling of missing files and malformed lines
 */

import { Effect } from 'effect';
import type { File } from '@minions/file-store';
import type { EventDeclaration, TypedEvent } from '@minions/events';
import type { IEventPersister } from '../domain/EventPersister';
import { PersistError } from '../domain/EventPersister';
import type { SerializedEvent } from '../domain/EventSerialization';
import { serializeEventToJsonLine } from '../domain/EventSerialization';

/**
 * File-based event persister using file-store
 *
 * Persists events to a file in JSON Lines format (one JSON object per line).
 * Each event is written immediately (unbuffered) for safety and simplicity.
 *
 * Error handling:
 * - Missing file is treated as empty (no events)
 * - Malformed JSON lines are skipped with a console warning
 * - I/O errors are wrapped in PersistError
 *
 * @example
 * ```typescript
 * const file = await sandbox.child('events.jsonl');
 * const persister = new FileEventPersister(file.node as File);
 *
 * // Append events
 * await Effect.runPromise(persister.append(event));
 *
 * // Load all events
 * const events = await Effect.runPromise(persister.load());
 * ```
 */
export class FileEventPersister implements IEventPersister {
  private lastLoadCorruptedCount = 0;
  /**
   * Creates a file-based event persister
   *
   * @param file - The IFile instance to persist to (from file-store)
   */
  constructor(private readonly file: File) {}

  /**
   * Append a single event to the file
   *
   * Writes the event as a single JSON line immediately (no buffering).
   * Creates parent directories if they don't exist.
   *
   * @param event - The TypedEvent to persist
   * @returns Effect that succeeds with void or fails with PersistError
   */
  append(
    event: TypedEvent<EventDeclaration>
  ): Effect.Effect<void, PersistError, never> {
    return Effect.tryPromise({
      try: async () => {
        const line = serializeEventToJsonLine(event);
        // Append with newline to create JSON Lines format
        await this.file.append(line + '\n');
      },
      catch: (error) =>
        new PersistError({
          message: `Failed to append event to file: ${this.file.path}`,
          cause: error,
        }),
    });
  }

  /**
   * Flush buffered events to storage
   *
   * For unbuffered implementation, this is a no-op since events
   * are written immediately in append().
   *
   * @returns Effect that succeeds immediately
   */
  flush(): Effect.Effect<void, PersistError, never> {
    // No buffering in this implementation, so flush is a no-op
    return Effect.succeed(undefined);
  }

  /**
   * Load all persisted events
   *
   * Reads the file line-by-line, deserializes each JSON line to
   * a SerializedEvent, and returns them in order.
   *
   * Graceful handling:
   * - Missing file returns empty array
   * - Malformed JSON lines are skipped with console warning
   *
   * After loading, call getLastLoadCorruptedCount() to check if any
   * events were skipped due to corruption.
   *
   * @returns Effect that succeeds with array of SerializedEvent or fails with PersistError
   */
  load(): Effect.Effect<SerializedEvent[], PersistError, never> {
    return Effect.tryPromise({
      try: async () => {
        this.lastLoadCorruptedCount = 0;

        const exists = await this.file.exists();
        if (!exists) {
          return [];
        }

        const content = await this.file.read();
        if (content.trim() === '') {
          return [];
        }

        const lines = content.split('\n').filter((line) => line.trim() !== '');
        const events: SerializedEvent[] = [];

        for (const line of lines) {
          try {
            const serialized = JSON.parse(line) as SerializedEvent;
            events.push(serialized);
          } catch (error) {
            // Skip malformed lines with warning
            this.lastLoadCorruptedCount++;
            console.warn(
              `Skipping malformed event line in ${this.file.path}:`,
              line,
              error
            );
          }
        }

        return events;
      },
      catch: (error) =>
        new PersistError({
          message: `Failed to load events from file: ${this.file.path}`,
          cause: error,
        }),
    });
  }

  /**
   * Check if any events exist
   *
   * Returns true if the file exists, false otherwise.
   * Does not check if the file is empty.
   *
   * @returns Effect that succeeds with boolean or fails with PersistError
   */
  exists(): Effect.Effect<boolean, PersistError, never> {
    return Effect.tryPromise({
      try: async () => {
        return await this.file.exists();
      },
      catch: (error) =>
        new PersistError({
          message: `Failed to check if events exist: ${this.file.path}`,
          cause: error,
        }),
    });
  }

  /**
   * Get count of persisted events
   *
   * Reads the file line-by-line and counts non-empty lines.
   * More efficient than loading all events into memory.
   *
   * @returns Effect that succeeds with event count or fails with PersistError
   */
  count(): Effect.Effect<number, PersistError, never> {
    return Effect.tryPromise({
      try: async () => {
        const exists = await this.file.exists();
        if (!exists) {
          return 0;
        }

        const content = await this.file.read();
        if (content.trim() === '') {
          return 0;
        }

        const lines = content.split('\n').filter((line) => line.trim() !== '');
        return lines.length;
      },
      catch: (error) =>
        new PersistError({
          message: `Failed to count events in file: ${this.file.path}`,
          cause: error,
        }),
    });
  }

  /**
   * Clear all persisted events
   *
   * Deletes the file if it exists.
   *
   * @returns Effect that succeeds with void or fails with PersistError
   */
  clear(): Effect.Effect<void, PersistError, never> {
    return Effect.tryPromise({
      try: async () => {
        const exists = await this.file.exists();
        if (exists) {
          await this.file.delete();
        }
      },
      catch: (error) =>
        new PersistError({
          message: `Failed to clear events file: ${this.file.path}`,
          cause: error,
        }),
    });
  }

  /**
   * Get count of corrupted events from last load operation
   *
   * Returns the number of malformed lines that were skipped during
   * the most recent load() call. This allows callers to detect
   * corruption without changing the load() return type.
   *
   * @returns Number of corrupted events skipped in last load()
   */
  getLastLoadCorruptedCount(): number {
    return this.lastLoadCorruptedCount;
  }

  /**
   * Cleanup and release resources
   *
   * For file-based implementation with unbuffered writes, there are
   * no resources to clean up. This is a no-op.
   *
   * @returns Effect that succeeds immediately
   */
  close(): Effect.Effect<void, PersistError, never> {
    // No resources to clean up for unbuffered file writes
    return Effect.succeed(undefined);
  }
}
