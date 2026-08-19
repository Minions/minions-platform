import { Effect, PubSub, Stream, Fiber, Scope, Schema, ParseResult, Cause } from 'effect';
import type {
  AnyEventDeclaration,
  TypedEvent,
  TypedEventUnion,
  PayloadOf,
} from './EventDeclaration';
import { getAncestorChain } from './EventDeclaration';
import { EventBusEvents } from './WellKnownEvents';

/**
 * Source wildcards for event filtering
 */
export const Src = {
  /** Any minion source (excludes mission/external) */
  AnyMinion: Symbol('AnyMinion'),
  /** Any source (minion, mission, or external) */
  Any: Symbol('Any'),
} as const;

/**
 * Type for event source filtering
 */
export type EventSource =
  | { readonly id: string }
  | typeof Src.AnyMinion
  | typeof Src.Any;

/**
 * Options for filtering event subscriptions
 */
export interface EventFilterOptions<EventType> {
  /** Filter by event source */
  from?: EventSource;

  /** Filter by custom condition */
  condition?: (event: EventType) => boolean;

  /**
   * Scope for automatic listener cleanup
   * When the Scope closes, the listener will be automatically unsubscribed.
   */
  scope?: Scope.Scope;
}

/**
 * Information about an active listener
 */
export interface ActiveListener {
  readonly id: string;
  readonly eventType: string;
  readonly hasScope: boolean;
  readonly createdAt: number;
  readonly isLongLived: boolean;
}

/**
 * Function to unsubscribe from an event (used by on() helper)
 */
export type Unsubscribe = () => void;

/**
 * Mission-scoped event bus powered by Effect's PubSub and Stream
 *
 * This is the Effect-based implementation that replaces the custom EventEmitter-based EventBus.
 * Primary API returns Streams for composability. Helper methods (on, once) provided for convenience.
 *
 * @template Universe - Union of all EventDeclarations in this bus's scope
 */
export interface IEventBus<Universe extends AnyEventDeclaration = AnyEventDeclaration> {
  /**
   * Subscribe to an event type with a handler (convenience method)
   *
   * This is a convenience wrapper around subscribe() + Stream.runForEach().
   * For more control, use subscribe() directly to get a Stream.
   *
   * @param event - Event declaration
   * @param handler - Synchronous handler function (will be wrapped in Effect)
   * @param options - Filter options (source, condition, owner)
   * @returns Unsubscribe function
   */
  on<E extends Universe>(
    event: E,
    handler: (event: TypedEventUnion<Universe, E>) => void,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Unsubscribe;

  /**
   * Subscribe to an event type and get a Stream (primary API)
   *
   * Returns a Stream of typed events that can be filtered, mapped, and consumed
   * using Stream operations. This is the composable Effect-native API.
   *
   * @param event - Event declaration
   * @param options - Filter options (source, condition, owner)
   * @returns Stream of typed events
   */
  subscribe<E extends Universe>(
    event: E,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Stream.Stream<TypedEventUnion<Universe, E>, never, never>;

  /**
   * Await a single event (convenience method)
   *
   * Returns a Promise that resolves with the first matching event.
   * For more control, use subscribe() + Stream.take(1).
   *
   * @param event - Event declaration
   * @param options - Filter options (source, condition, owner)
   * @returns Promise that resolves with the first matching event
   */
  once<E extends Universe>(
    event: E,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Promise<TypedEventUnion<Universe, E>>;

  /**
   * Emit a custom event (convenience method)
   *
   * Synchronously emits the event. Tagged with 'mission' as the source.
   * If the event has a schema, validates the payload and throws ParseError if invalid.
   * For Effect-based emission with error handling, use emitEffect().
   *
   * @param event - Event declaration
   * @param payload - Event payload (typed)
   * @throws ParseError if payload validation fails
   */
  emit<E extends Universe>(
    event: E,
    payload: PayloadOf<E>
  ): void;

  /**
   * Emit a custom event as an Effect (primary API)
   *
   * Returns an Effect that, when run, emits the event to all subscribers.
   * Tagged with 'mission' as the source.
   * If the event has a schema, validates the payload and fails with ParseError if invalid.
   *
   * @param event - Event declaration
   * @param payload - Event payload (typed)
   * @returns Effect that completes when the event is emitted, or fails with ParseError
   */
  emitEffect<E extends Universe>(
    event: E,
    payload: PayloadOf<E>
  ): Effect.Effect<void, ParseResult.ParseError, never>;

  /**
   * Emit an event from a specific source (internal use)
   *
   * If the event has a schema, validates the payload and throws ParseError if invalid.
   *
   * @param event - Event declaration
   * @param payload - Event payload
   * @param source - Source identifier
   * @throws ParseError if payload validation fails
   */
  emitFrom<E extends Universe>(
    event: E,
    payload: PayloadOf<E>,
    source: string
  ): void;

  /**
   * Emit an event from a specific source as an Effect (internal use)
   *
   * If the event has a schema, validates the payload and fails with ParseError if invalid.
   *
   * @param event - Event declaration
   * @param payload - Event payload
   * @param source - Source identifier
   * @returns Effect that completes when the event is emitted, or fails with ParseError
   * @internal
   */
  emitFromEffect<E extends Universe>(
    event: E,
    payload: PayloadOf<E>,
    source: string
  ): Effect.Effect<void, ParseResult.ParseError, never>;

  /**
   * Get all active listeners for debugging
   *
   * @returns Array of active listener information
   */
  getActiveListeners(): ActiveListener[];
}

/**
 * Listener registry entry
 */
interface ListenerRegistryEntry {
  id: string;
  eventType: string;
  hasScope: boolean;
  createdAt: number;
  fiber: Fiber.RuntimeFiber<void, never>;
}

/**
 * Default long-lived listener threshold in milliseconds (5 minutes)
 */
const DEFAULT_LONG_LIVED_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Effect-based EventBus implementation using PubSub and Stream
 *
 * This implementation uses Effect's PubSub primitive for pub/sub and Stream
 * for event processing. All operations return Effects.
 *
 * @template Universe - Union of all EventDeclarations in this bus's scope
 */
export class EventBus<Universe extends AnyEventDeclaration = AnyEventDeclaration>
  implements IEventBus<Universe>
{
  private readonly pubsub: PubSub.PubSub<TypedEvent<AnyEventDeclaration>>;
  private readonly listenerRegistry = new Map<string, ListenerRegistryEntry>();
  private listenerIdCounter = 0;
  private readonly longLivedThresholdMs: number;

  /**
   * Create a new EventBus
   *
   * The PubSub is created immediately for synchronous operation.
   *
   * @param longLivedThresholdMs - Threshold for flagging long-lived listeners (default: 5 minutes)
   */
  constructor(longLivedThresholdMs: number = DEFAULT_LONG_LIVED_THRESHOLD_MS) {
    this.longLivedThresholdMs = longLivedThresholdMs;
    // Create PubSub immediately for synchronous operation
    this.pubsub = Effect.runSync(PubSub.unbounded<TypedEvent<AnyEventDeclaration>>());
  }

  /**
   * Get the PubSub instance
   */
  private getPubSub(): PubSub.PubSub<TypedEvent<AnyEventDeclaration>> {
    return this.pubsub;
  }

  on<E extends Universe>(
    event: E,
    handler: (event: TypedEventUnion<Universe, E>) => void,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Unsubscribe {
    const stream = this.subscribe(event, options);

    // Register listener for tracking
    const listenerId = `listener-${++this.listenerIdCounter}`;

    // Flag to track if this is a HandlerError handler (for infinite loop prevention)
    const isHandlerErrorHandler = event.type === 'handler-error';

    // Bind emitFrom to avoid this aliasing in generator
    const emitHandlerError = this.emitFrom.bind(this);

    // Run the stream consumer in the background with error catching
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (typedEvent) =>
        Effect.gen(function* () {
          // Try to run the handler
          const result = yield* Effect.try({
            try: () => handler(typedEvent),
            catch: (error) => error,
          }).pipe(Effect.either);

          // If the handler failed, emit a HandlerError event
          if (result._tag === 'Left') {
            const error = result.left;

            // Prevent infinite loops: if this is a HandlerError handler that threw,
            // log to console and don't emit another HandlerError
            if (isHandlerErrorHandler) {
              console.error(
                `HandlerError handler ${listenerId} threw an error (not re-emitting to prevent infinite loop):`,
                error
              );
              return;
            }

            // Create a Cause from the error for full error tracing
            const cause = Cause.fail(error);

            // Emit HandlerError event with full context
            // Note: We emit synchronously to preserve isolation - other handlers
            // for the original event will still run
            emitHandlerError(
              EventBusEvents.HandlerError as unknown as E,
              {
                handlerId: listenerId,
                eventType: (typedEvent as TypedEvent<AnyEventDeclaration>).__type,
                cause,
                originalEvent: typedEvent,
              } as unknown as PayloadOf<E>,
              'event-bus'
            );
          }
        })
      )
    );

    this.listenerRegistry.set(listenerId, {
      id: listenerId,
      eventType: event.type,
      hasScope: options?.scope !== undefined,
      createdAt: Date.now(),
      fiber,
    });

    // Create unsubscribe function
    const unsubscribe = () => {
      const entry = this.listenerRegistry.get(listenerId);
      if (entry) {
        Effect.runSync(
          Effect.gen(function* () {
            yield* Effect.forkDaemon(Fiber.interrupt(entry.fiber));
          })
        );
        this.listenerRegistry.delete(listenerId);
      }
    };

    // If a scope is provided, register the unsubscribe as a finalizer
    if (options?.scope) {
      Effect.runSync(
        Scope.addFinalizer(options.scope, Effect.sync(() => {
          unsubscribe();
        }))
      );
    }

    return unsubscribe;
  }

  subscribe<E extends Universe>(
    event: E,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Stream.Stream<TypedEventUnion<Universe, E>, never, never> {
    const pubsub = this.getPubSub();
    const matchesSource = this.matchesSource.bind(this);

    return Stream.unwrapScoped(
      Effect.gen(function* () {
        // Subscribe to the PubSub (this is scoped and will be cleaned up)
        const queue = yield* PubSub.subscribe(pubsub);

        // Create a stream from the queue
        const baseStream = Stream.fromQueue(queue);

        // Filter for this event type and its descendants
        // The queue's element type only tracks `__type`/`__source`/`__timestamp` (the
        // payload is erased to `unknown` for the class-wide `Universe` bound - see
        // `AnyEventDeclaration`). Once we've filtered down to `event`'s type and its
        // descendants, the payload shape is guaranteed to match `TypedEventUnion<Universe, E>`,
        // so we narrow here rather than carrying the erased type through every filter below.
        const typeFilteredStream = Stream.filter(baseStream, (typedEvent) => {
          if (typedEvent.__type === event.type) {
            return true;
          }
          // Check if this event is a child of the target event
          const ancestors = getAncestorChain(typedEvent.__type);
          return ancestors.includes(event.type);
        }) as Stream.Stream<TypedEventUnion<Universe, E>, never, never>;

        // Apply source filter
        const sourceFilter = options?.from;
        const sourceFilteredStream = sourceFilter !== undefined
          ? Stream.filter(typeFilteredStream, (typedEvent) =>
              matchesSource((typedEvent as TypedEvent<AnyEventDeclaration>).__source, sourceFilter)
            )
          : typeFilteredStream;

        // Apply condition filter
        const conditionFilteredStream = options?.condition !== undefined
          ? Stream.filter(sourceFilteredStream, options.condition)
          : sourceFilteredStream;

        return conditionFilteredStream;
      })
    );
  }

  once<E extends Universe>(
    event: E,
    options?: EventFilterOptions<TypedEventUnion<Universe, E>>
  ): Promise<TypedEventUnion<Universe, E>> {
    const stream = this.subscribe(event, options);

    // Register listener for tracking if scope is provided
    const listenerId = options?.scope ? `listener-${++this.listenerIdCounter}` : undefined;

    // Run the stream to get the first event
    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(stream, 1)).pipe(
        Effect.map((chunk) => Array.from(chunk)[0])
      )
    );

    // Register the fiber if we have a scope
    if (listenerId && options?.scope) {
      this.listenerRegistry.set(listenerId, {
        id: listenerId,
        eventType: event.type,
        hasScope: true,
        createdAt: Date.now(),
        fiber,
      });

      // Register cleanup with the scope
      Effect.runSync(
        Scope.addFinalizer(options.scope, Effect.sync(() => {
          Effect.runSync(
            Effect.gen(function* () {
              yield* Effect.forkDaemon(Fiber.interrupt(fiber));
            })
          );
          this.listenerRegistry.delete(listenerId);
        }))
      );
    }

    // Return a promise that cleans up the listener after resolving
    return Effect.runPromise(Fiber.join(fiber)).then((result) => {
      // Clean up the listener after it resolves
      if (listenerId) {
        this.listenerRegistry.delete(listenerId);
      }
      return result;
    });
  }

  emit<E extends Universe>(
    event: E,
    payload: PayloadOf<E>
  ): void {
    Effect.runSync(this.emitEffect(event, payload));
  }

  emitEffect<E extends Universe>(
    event: E,
    payload: PayloadOf<E>
  ): Effect.Effect<void, ParseResult.ParseError, never> {
    return this.emitFromEffect(event, payload, 'mission');
  }

  emitFrom<E extends Universe>(
    event: E,
    payload: PayloadOf<E>,
    source: string
  ): void {
    Effect.runSync(this.emitFromEffect(event, payload, source));
  }

  emitFromEffect<E extends Universe>(
    event: E,
    payload: PayloadOf<E>,
    source: string
  ): Effect.Effect<void, ParseResult.ParseError, never> {
    const pubsub = this.getPubSub();

    // Validate payload against schema if provided
    // `Universe`'s bound (`AnyEventDeclaration`) intentionally omits `schema` (see its
    // doc comment), so `E` doesn't statically expose it even though every real
    // `EventDeclaration` carries it. Narrow via the concrete payload/schema shape that
    // `E` actually has at runtime instead of widening the bound (which would reintroduce
    // an invariant `P` and break assignability at call sites).
    const eventWithSchema = event as E & { schema?: Schema.Schema<PayloadOf<E>, unknown, never> };
    const schema = eventWithSchema.schema;
    const validationEffect = schema
      ? Effect.gen(function* () {
          yield* Schema.decodeUnknown(schema)(payload);
          return payload;
        })
      : Effect.succeed(payload);

    return Effect.gen(function* () {
      // Validate the payload
      const validatedPayload = yield* validationEffect;

      // Create the typed event
      const typedEvent: TypedEvent<E> = {
        ...(validatedPayload as object),
        __type: event.type,
        __source: source,
        __timestamp: Date.now(),
      } as TypedEvent<E>;

      // Publish to PubSub
      yield* PubSub.publish(pubsub, typedEvent);
    });
  }

  getActiveListeners(): ActiveListener[] {
    const now = Date.now();
    return Array.from(this.listenerRegistry.values()).map((entry) => ({
      id: entry.id,
      eventType: entry.eventType,
      hasScope: entry.hasScope,
      createdAt: entry.createdAt,
      isLongLived: now - entry.createdAt > this.longLivedThresholdMs,
    }));
  }

  /**
   * Check if a source matches a filter
   */
  private matchesSource(eventSource: string, filter: EventSource): boolean {
    if (filter === Src.Any) {
      return true;
    }

    if (filter === Src.AnyMinion) {
      return !eventSource.startsWith('mission') && !eventSource.startsWith('external:');
    }

    if (typeof filter === 'object' && 'id' in filter) {
      return eventSource === filter.id;
    }

    return false;
  }
}
