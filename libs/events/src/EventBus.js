import { Effect, PubSub, Stream, Fiber, Scope, Schema, Cause } from 'effect';
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
};
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
export class EventBus {
    pubsub;
    listenerRegistry = new Map();
    listenerIdCounter = 0;
    longLivedThresholdMs;
    /**
     * Create a new EventBus
     *
     * The PubSub is created immediately for synchronous operation.
     *
     * @param longLivedThresholdMs - Threshold for flagging long-lived listeners (default: 5 minutes)
     */
    constructor(longLivedThresholdMs = DEFAULT_LONG_LIVED_THRESHOLD_MS) {
        this.longLivedThresholdMs = longLivedThresholdMs;
        // Create PubSub immediately for synchronous operation
        this.pubsub = Effect.runSync(PubSub.unbounded());
    }
    /**
     * Get the PubSub instance
     */
    getPubSub() {
        return this.pubsub;
    }
    on(event, handler, options) {
        const stream = this.subscribe(event, options);
        // Register listener for tracking
        const listenerId = `listener-${++this.listenerIdCounter}`;
        // Flag to track if this is a HandlerError handler (for infinite loop prevention)
        const isHandlerErrorHandler = event.type === 'handler-error';
        // Bind emitFrom to avoid this aliasing in generator
        const emitHandlerError = this.emitFrom.bind(this);
        // Run the stream consumer in the background with error catching
        const fiber = Effect.runFork(Stream.runForEach(stream, (typedEvent) => Effect.gen(function* () {
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
                    console.error(`HandlerError handler ${listenerId} threw an error (not re-emitting to prevent infinite loop):`, error);
                    return;
                }
                // Create a Cause from the error for full error tracing
                const cause = Cause.fail(error);
                // Emit HandlerError event with full context
                // Note: We emit synchronously to preserve isolation - other handlers
                // for the original event will still run
                emitHandlerError(EventBusEvents.HandlerError, {
                    handlerId: listenerId,
                    eventType: typedEvent.__type,
                    cause,
                    originalEvent: typedEvent,
                }, 'event-bus');
            }
        })));
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
                Effect.runSync(Effect.gen(function* () {
                    yield* Effect.forkDaemon(Fiber.interrupt(entry.fiber));
                }));
                this.listenerRegistry.delete(listenerId);
            }
        };
        // If a scope is provided, register the unsubscribe as a finalizer
        if (options?.scope) {
            Effect.runSync(Scope.addFinalizer(options.scope, Effect.sync(() => {
                unsubscribe();
            })));
        }
        return unsubscribe;
    }
    subscribe(event, options) {
        const pubsub = this.getPubSub();
        const matchesSource = this.matchesSource.bind(this);
        return Stream.unwrapScoped(Effect.gen(function* () {
            // Subscribe to the PubSub (this is scoped and will be cleaned up)
            const queue = yield* PubSub.subscribe(pubsub);
            // Create a stream from the queue
            const baseStream = Stream.fromQueue(queue);
            // Filter for this event type and its descendants
            const typeFilteredStream = Stream.filter(baseStream, (typedEvent) => {
                if (typedEvent.__type === event.type) {
                    return true;
                }
                // Check if this event is a child of the target event
                const ancestors = getAncestorChain(typedEvent.__type);
                return ancestors.includes(event.type);
            });
            // Apply source filter
            const sourceFilteredStream = options?.from !== undefined
                ? Stream.filter(typeFilteredStream, (typedEvent) => matchesSource(typedEvent.__source, options.from))
                : typeFilteredStream;
            // Apply condition filter
            const conditionFilteredStream = options?.condition !== undefined
                ? Stream.filter(sourceFilteredStream, options.condition)
                : sourceFilteredStream;
            return conditionFilteredStream;
        }));
    }
    once(event, options) {
        const stream = this.subscribe(event, options);
        // Register listener for tracking if scope is provided
        const listenerId = options?.scope ? `listener-${++this.listenerIdCounter}` : undefined;
        // Run the stream to get the first event
        const fiber = Effect.runFork(Stream.runCollect(Stream.take(stream, 1)).pipe(Effect.map((chunk) => Array.from(chunk)[0])));
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
            Effect.runSync(Scope.addFinalizer(options.scope, Effect.sync(() => {
                Effect.runSync(Effect.gen(function* () {
                    yield* Effect.forkDaemon(Fiber.interrupt(fiber));
                }));
                this.listenerRegistry.delete(listenerId);
            })));
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
    emit(event, payload) {
        Effect.runSync(this.emitEffect(event, payload));
    }
    emitEffect(event, payload) {
        return this.emitFromEffect(event, payload, 'mission');
    }
    emitFrom(event, payload, source) {
        Effect.runSync(this.emitFromEffect(event, payload, source));
    }
    emitFromEffect(event, payload, source) {
        const pubsub = this.getPubSub();
        // Validate payload against schema if provided
        const validationEffect = event.schema
            ? Effect.gen(function* () {
                yield* Schema.decodeUnknown(event.schema)(payload);
                return payload;
            })
            : Effect.succeed(payload);
        return Effect.gen(function* () {
            // Validate the payload
            const validatedPayload = yield* validationEffect;
            // Create the typed event
            const typedEvent = {
                ...validatedPayload,
                __type: event.type,
                __source: source,
                __timestamp: Date.now(),
            };
            // Publish to PubSub
            yield* PubSub.publish(pubsub, typedEvent);
        });
    }
    getActiveListeners() {
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
    matchesSource(eventSource, filter) {
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
//# sourceMappingURL=EventBus.js.map