/**
 * Event Persistence Subscription Adapter
 *
 * Bridges EventBus to IEventPersister by automatically persisting all events
 * that flow through the bus. This adapter keeps the EventBus pure - persistence
 * is a conductor concern, not an events concern.
 *
 * Key characteristics:
 * - Subscribes to all events on the bus
 * - Non-blocking: errors are logged but don't throw
 * - Lifecycle managed via start() and stop() methods
 * - Flushes persister on stop() to ensure durability
 *
 * ## Implementation Note
 *
 * This adapter accesses the EventBus's internal PubSub to subscribe to all events.
 * Since IEventBus doesn't expose a wildcard subscription method, we cast to access
 * the internal implementation. This is safe within the conductor package since
 * EventBus and EventPersistenceSubscription are both internal adapters.
 *
 * @example
 * ```typescript
 * const subscription = new EventPersistenceSubscription(eventBus, persister);
 *
 * // Start persisting events
 * subscription.start();
 *
 * // Events are now automatically persisted
 * eventBus.emit(SomeEvent, { data: 'value' });
 *
 * // Stop persisting and flush
 * await subscription.stop();
 * ```
 */

import { Effect, PubSub, Stream, Fiber } from 'effect';
import type { IEventBus, TypedEvent, AnyEventDeclaration } from '@minions/events';
import type { IEventPersister } from '../domain/EventPersister';

/**
 * Shape of EventBus's internal PubSub, accessed reflectively since IEventBus
 * doesn't expose a wildcard subscription method. Mirrors the private
 * `pubsub` field on the concrete `EventBus` class in @minions/events.
 */
interface EventBusWithPubSub {
  readonly pubsub?: PubSub.PubSub<TypedEvent<AnyEventDeclaration>>;
}

/**
 * Event Persistence Subscription
 *
 * Automatically persists all events emitted on the event bus to an IEventPersister.
 * This adapter bridges the EventBus (from @minions/events) to persistence
 * (a conductor domain concern).
 *
 * ## Error Handling
 *
 * Persistence errors are logged to console but do not throw. This ensures that
 * persistence issues don't disrupt mission execution or event delivery to other
 * handlers.
 *
 * ## Lifecycle
 *
 * - `start()`: Begin subscribing and persisting events
 * - `stop()`: Unsubscribe and flush any remaining events to storage
 *
 * The subscription must be explicitly started and stopped. This gives the conductor
 * control over when persistence is active.
 */
export class EventPersistenceSubscription {
  private fiber?: Fiber.RuntimeFiber<void, never>;
  private readonly eventBus: IEventBus;
  private readonly persister: IEventPersister;

  /**
   * Creates an event persistence subscription
   *
   * @param eventBus - The event bus to subscribe to
   * @param persister - The persister to write events to
   */
  constructor(eventBus: IEventBus, persister: IEventPersister) {
    this.eventBus = eventBus;
    this.persister = persister;
  }

  /**
   * Start subscribing to events and persisting them
   *
   * Events will be appended to the persister as they occur. Persistence errors
   * are logged but do not disrupt event flow.
   *
   * This method can be called multiple times safely - subsequent calls are no-ops
   * if already started.
   */
  start(): void {
    // Don't start if already subscribed
    if (this.fiber) {
      return;
    }

    // Access the internal PubSub from EventBus to subscribe to all events
    // This is a pragmatic solution: cast to access the internal implementation.
    // The EventBus remains pure - this adapter knows about the implementation
    // details to bridge EventBus to persistence.
    const eventBusInternal = this.eventBus as unknown as EventBusWithPubSub;

    if (!eventBusInternal.pubsub) {
      throw new Error(
        'EventPersistenceSubscription requires EventBus to have a pubsub property. ' +
        'Ensure you are using the standard EventBus implementation.'
      );
    }

    // Create a scoped stream that subscribes to all events on the PubSub.
    // Must use Stream.unwrapScoped so the PubSub.subscribe gets a proper Scope
    // (PubSub.subscribe requires Scope to manage the subscription lifecycle).
    const pubsub = eventBusInternal.pubsub;
    const allEvents = Stream.unwrapScoped(
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(pubsub);
        return Stream.fromQueue(queue);
      })
    );

    // Run the stream consumer in a forked fiber, persisting each event
    this.fiber = Effect.runFork(
      Stream.runForEach(allEvents, (event) => this.persistEvent(event))
    );
  }

  /**
   * Stop subscribing to events and flush the persister
   *
   * Unsubscribes from the event bus and ensures all buffered events are
   * written to durable storage.
   *
   * Returns a Promise that resolves when the persister has been flushed.
   * If flush fails, the error is logged but the Promise still resolves
   * (non-blocking behavior).
   */
  async stop(): Promise<void> {
    // Only stop if there's an active subscription
    if (!this.fiber) {
      return;
    }

    // Interrupt the subscription fiber
    await Effect.runPromise(
      Effect.forkDaemon(Fiber.interrupt(this.fiber))
    );
    this.fiber = undefined;

    // Flush the persister to ensure all events are written
    try {
      await Effect.runPromise(this.persister.flush());
    } catch (error) {
      // Log but don't throw - persistence errors are non-blocking
      console.error('EventPersistenceSubscription: Error flushing persister on stop:', error);
    }
  }

  /**
   * Persist a single event
   *
   * Appends the event to the persister. Errors are logged but do not throw.
   */
  private persistEvent(
    event: TypedEvent<AnyEventDeclaration>
  ): Effect.Effect<void, never, never> {
    const persister = this.persister;
    return Effect.gen(function* () {
      const result = yield* Effect.either(persister.append(event));
      if (result._tag === 'Left') {
        // Log but don't fail - persistence errors shouldn't break missions
        console.error('EventPersistenceSubscription: Error persisting event:', result.left);
      }
    });
  }
}
