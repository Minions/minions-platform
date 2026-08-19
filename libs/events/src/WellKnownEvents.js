/**
 * Event Bus Infrastructure Events
 *
 * Events emitted by the event bus infrastructure itself.
 * Domain-specific events (minion events, mission events, etc.) should be
 * defined in their respective domain packages.
 *
 * All events include runtime validation via Effect Schema.
 */
import { Schema } from 'effect';
import { defineEvent } from './EventDeclaration';
/**
 * Event bus infrastructure events
 *
 * These events are emitted by the event bus itself, not by domain code.
 * For backward compatibility, this is aliased as WellKnownEvents.
 */
export const EventBusEvents = {
    /**
     * Emitted when an event handler throws an error
     *
     * This event enables error observability without changing handler signatures.
     * Handlers remain void functions; the event bus catches exceptions and emits
     * HandlerError events instead.
     *
     * ## Error Isolation
     *
     * When a handler throws, the event bus:
     * 1. Catches the error
     * 2. Emits a HandlerError event with full error context via Effect's Cause
     * 3. Continues delivering the original event to other handlers
     *
     * This ensures that one failing handler doesn't prevent others from running.
     *
     * ## Effect Cause Integration
     *
     * Handler errors are captured as Effect `Cause` objects, which preserve:
     * - Full stack traces
     * - Error chains (for nested/wrapped errors)
     * - Fiber context at time of failure
     *
     * Use `Cause.pretty()` to get readable error output:
     *
     * ```typescript
     * import { Cause } from 'effect';
     *
     * ctx.events.on(EventBusEvents.HandlerError, (event) => {
     *   console.error(Cause.pretty(event.cause));
     * });
     * ```
     *
     * ## Monitoring Handler Errors
     *
     * Subscribe to HandlerError events to monitor and log handler failures:
     *
     * ```typescript
     * import { Cause } from 'effect';
     *
     * // Log all handler errors with full context
     * ctx.events.on(EventBusEvents.HandlerError, (event) => {
     *   console.error(`Handler ${event.handlerId} failed on event ${event.eventType}:`);
     *   console.error(Cause.pretty(event.cause));
     * });
     *
     * // Filter errors by event type
     * ctx.events.on(EventBusEvents.HandlerError, (event) => {
     *   if (event.eventType === 'critical-event') {
     *     // Handle critical event errors specially
     *   }
     * }, { condition: (e) => e.eventType === 'critical-event' });
     *
     * // Access original event that triggered the error
     * ctx.events.on(EventBusEvents.HandlerError, (event) => {
     *   console.log('Original event:', event.originalEvent);
     * });
     * ```
     *
     * ## Infinite Loop Prevention
     *
     * If a HandlerError handler itself throws an error, the error bubbles up
     * and crashes rather than emitting another HandlerError event. This prevents
     * infinite error loops.
     */
    HandlerError: defineEvent('handler-error', 
    // Cast required because Cause is not JSON-serializable - we use Unknown for runtime
    // validation but the actual type is Cause<unknown> for type safety in handlers
    Schema.Struct({
        handlerId: Schema.String,
        eventType: Schema.String,
        cause: Schema.Unknown,
        originalEvent: Schema.Unknown,
    })),
};
/**
 * Backward compatibility alias
 *
 * @deprecated Use EventBusEvents for event bus infrastructure events,
 * or domain-specific event objects (e.g., MinionEvents from @minions/hatchery)
 */
export const WellKnownEvents = EventBusEvents;
//# sourceMappingURL=WellKnownEvents.js.map