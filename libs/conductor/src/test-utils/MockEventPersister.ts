import { Effect } from 'effect';
import type { TypedEvent, AnyEventDeclaration } from '@minions/events';
import type { IEventPersister } from '../domain/EventPersister';
import { PersistError } from '../domain/EventPersister';
import type { SerializedEvent } from '../domain/EventSerialization';
import { serializeEvent } from '../domain/EventSerialization';

/**
 * Configuration options for MockEventPersister behavior
 */
export interface MockEventPersisterOptions {
  /**
   * If set, append() will fail with this error
   */
  appendError?: Error;

  /**
   * If set, flush() will fail with this error
   */
  flushError?: Error;

  /**
   * If set, load() will fail with this error
   */
  loadError?: Error;

  /**
   * If true, operations on a closed persister will throw
   * Default: true
   */
  enforceCloseChecks?: boolean;
}

/**
 * Mock implementation of IEventPersister for testing.
 *
 * This provides in-memory event storage and supports:
 * - Storing both raw TypedEvents (via append) and pre-serialized events
 * - Configurable error injection for testing error handling
 * - Operation tracking (flush count, close count)
 * - Optional enforcement of closed state checks
 *
 * @example Basic usage
 * ```ts
 * const persister = new MockEventPersister();
 * await Effect.runPromise(persister.append(event));
 * const events = await Effect.runPromise(persister.load());
 * ```
 *
 * @example With error injection
 * ```ts
 * const persister = new MockEventPersister({
 *   appendError: new Error('Simulated failure')
 * });
 * // append() will now fail
 * ```
 *
 * @example Adding pre-serialized events for test setup
 * ```ts
 * const persister = new MockEventPersister();
 * persister.addSerializedEvents([
 *   { type: 'event-1', payload: { value: 1 }, source: 'test', timestamp: 1000 }
 * ]);
 * const events = await Effect.runPromise(persister.load());
 * // events will include the pre-serialized event
 * ```
 */
export class MockEventPersister implements IEventPersister {
  private events: SerializedEvent[] = [];
  private closed = false;

  // Public tracking for test assertions
  public readonly appendedEvents: TypedEvent<AnyEventDeclaration>[] = [];
  public flushCallCount = 0;
  public closeCallCount = 0;

  // Configurable error injection
  public appendError?: Error;
  public flushError?: Error;
  public loadError?: Error;

  private enforceCloseChecks: boolean;

  constructor(options: MockEventPersisterOptions = {}) {
    this.appendError = options.appendError;
    this.flushError = options.flushError;
    this.loadError = options.loadError;
    this.enforceCloseChecks = options.enforceCloseChecks ?? true;
  }

  /**
   * Add pre-serialized events directly to the persister.
   * Useful for test setup when you want to simulate loading existing events.
   */
  addSerializedEvents(events: SerializedEvent[]): void {
    this.events.push(...events);
  }

  private checkClosed(): void {
    if (this.enforceCloseChecks && this.closed) {
      throw new PersistError({ message: 'Persister is closed' });
    }
  }

  append(event: TypedEvent<AnyEventDeclaration>): Effect.Effect<void, PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      if (this.appendError) {
        throw this.appendError;
      }
      this.appendedEvents.push(event);
      this.events.push(serializeEvent(event));
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Append failed',
            cause: error,
          })
        )
      )
    );
  }

  flush(): Effect.Effect<void, PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      this.flushCallCount++;
      if (this.flushError) {
        throw this.flushError;
      }
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Flush failed',
            cause: error,
          })
        )
      )
    );
  }

  load(): Effect.Effect<SerializedEvent[], PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      if (this.loadError) {
        throw this.loadError;
      }
      return [...this.events];
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Load failed',
            cause: error,
          })
        )
      )
    );
  }

  exists(): Effect.Effect<boolean, PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      return this.events.length > 0;
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Exists check failed',
            cause: error,
          })
        )
      )
    );
  }

  count(): Effect.Effect<number, PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      return this.events.length;
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Count failed',
            cause: error,
          })
        )
      )
    );
  }

  clear(): Effect.Effect<void, PersistError, never> {
    return Effect.sync(() => {
      this.checkClosed();
      this.events = [];
      this.appendedEvents.length = 0;
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Clear failed',
            cause: error,
          })
        )
      )
    );
  }

  close(): Effect.Effect<void, PersistError, never> {
    return Effect.sync(() => {
      this.closeCallCount++;
      this.closed = true;
    }).pipe(
      Effect.catchAllDefect((error) =>
        Effect.fail(
          new PersistError({
            message: error instanceof Error ? error.message : 'Close failed',
            cause: error,
          })
        )
      )
    );
  }
}
