/**
 * Event Declaration System
 *
 * Provides a unified type-safe system for declaring and using events.
 * Both well-known events and user-defined events use identical syntax.
 *
 * Key principles:
 * - Payload type is explicit in the declaration, not inferred
 * - Well-known and user-defined events work identically
 * - TypeScript autocomplete works on event payloads in handlers
 * - Event types are discoverable through constant objects
 * - Runtime validation via Effect Schema ensures type safety
 *
 * @example
 * ```typescript
 * import { Schema } from 'effect';
 *
 * // Define events with schemas
 * const MyEvents = {
 *   TaskComplete: defineEvent<{ taskId: string; result: string }>(
 *     'task-complete',
 *     Schema.Struct({
 *       taskId: Schema.String,
 *       result: Schema.String,
 *     })
 *   ),
 *   Blocked: defineEvent<{ reason: string }>(
 *     'blocked',
 *     Schema.Struct({ reason: Schema.String })
 *   ),
 * } as const;
 *
 * // Use events (fully typed and runtime validated)
 * ctx.events.on(MyEvents.TaskComplete, (event) => {
 *   event.taskId;  // autocomplete works
 *   event.result;
 * });
 * ```
 */
import { JSONSchema } from 'effect';
/**
 * Helper to create typed event declarations
 *
 * Creates an EventDeclaration with an explicit payload type.
 * The payload type must be specified as a generic parameter.
 * Optionally provide a Schema for runtime validation.
 *
 * @template P - The payload type for this event
 * @param type - Event type identifier (unique string)
 * @param schema - Optional Schema for runtime validation
 * @returns A typed EventDeclaration
 *
 * @example
 * ```typescript
 * import { Schema } from 'effect';
 *
 * // Without schema (no runtime validation)
 * const TurnComplete = defineEvent<{ minionId: string }>('turn-complete');
 *
 * // With schema (runtime validation enabled)
 * const TaskDone = defineEvent<{ result: string }>(
 *   'task-done',
 *   Schema.Struct({ result: Schema.String })
 * );
 *
 * const NoPayload = defineEvent<void>('simple-event');
 * ```
 */
export function defineEvent(type, 
schema) {
    return {
        type,
        payload: undefined,
        __parentType: undefined,
        schema: schema,
    };
}
/**
 * Event registry to track parent-child relationships
 *
 * Maps child event types to their parent event types.
 * When a child event is emitted, it will also be dispatched to parent listeners.
 */
const childToParentMap = new Map();
/**
 * Define a child event that extends a parent event
 *
 * Creates a new event declaration that is a child of a parent event.
 * When the child event is emitted, listeners registered for the parent
 * event will also receive it. The child payload must extend the parent payload.
 * Optionally provide a Schema for runtime validation.
 *
 * @template ParentEvent - The parent event declaration
 * @template ChildPayload - The child payload type (must extend parent payload)
 * @param parent - The parent event declaration
 * @param childType - Event type identifier for the child (unique string)
 * @param schema - Optional Schema for runtime validation
 * @returns A typed EventDeclaration for the child event
 *
 * @example
 * ```typescript
 * import { Schema } from 'effect';
 *
 * // Parent event
 * const GadgetUse = defineEvent<{ minionId: string; gadgetName: string }>(
 *   'gadget-use',
 *   Schema.Struct({
 *     minionId: Schema.String,
 *     gadgetName: Schema.String,
 *   })
 * );
 *
 * // Child events extend parent payload with schema
 * const WriteGadgetUse = defineChildEvent<
 *   typeof GadgetUse,
 *   { minionId: string; gadgetName: string; filePath: string; content: string }
 * >(
 *   GadgetUse,
 *   'write-gadget-use',
 *   Schema.Struct({
 *     minionId: Schema.String,
 *     gadgetName: Schema.String,
 *     filePath: Schema.String,
 *     content: Schema.String,
 *   })
 * );
 *
 * // Listeners for GadgetUse receive WriteGadgetUse events
 * ctx.events.on(GadgetUse, (event) => {
 *   // Receives both GadgetUse and WriteGadgetUse events
 * });
 *
 * // Listeners for WriteGadgetUse only receive WriteGadgetUse events
 * ctx.events.on(WriteGadgetUse, (event) => {
 *   // Only receives WriteGadgetUse events
 *   event.filePath; // Child-specific field
 * });
 * ```
 */
export function defineChildEvent(parent, childType, 
schema) {
    // Register the parent-child relationship
    childToParentMap.set(childType, parent.type);
    return {
        type: childType,
        payload: undefined,
        __parentType: parent.type,
        schema: schema,
    };
}
/**
 * Get the parent event type for a child event type
 *
 * @param eventType - The event type to check
 * @returns The parent event type, or undefined if not a child event
 * @internal
 */
export function getParentEventType(eventType) {
    return childToParentMap.get(eventType);
}
/**
 * Get all ancestor event types for a child event type
 *
 * Returns the full chain of ancestors from immediate parent to root.
 * For example, if we have GrandParent -> Parent -> Child, calling
 * getAncestorChain('child') returns ['parent', 'grandparent'].
 *
 * @param eventType - The event type to check
 * @returns Array of ancestor event types (immediate parent first, root last)
 * @internal
 */
export function getAncestorChain(eventType) {
    const ancestors = [];
    let currentType = eventType;
    while (true) {
        const parentType = childToParentMap.get(currentType);
        if (parentType === undefined) {
            break;
        }
        ancestors.push(parentType);
        currentType = parentType;
    }
    return ancestors;
}
/**
 * Check if an event type is a child event
 *
 * @param eventType - The event type to check
 * @returns True if the event is a child event
 * @internal
 */
export function isChildEvent(eventType) {
    return childToParentMap.has(eventType);
}
/**
 * Get schema information for an event declaration
 *
 * Returns JSON Schema representation of the event's payload schema
 * using Effect Schema's JSONSchema module. This is useful for gadgets
 * that need to provide schema information to minions.
 *
 * @param event - The event declaration
 * @returns JSON Schema object if schema is defined, undefined otherwise
 *
 * @example
 * ```typescript
 * const TestEvent = defineEvent<{ name: string; count: number }>(
 *   'test-event',
 *   Schema.Struct({
 *     name: Schema.String,
 *     count: Schema.Number,
 *   })
 * );
 *
 * const schemaInfo = getEventSchemaInfo(TestEvent);
 * // Returns JSON Schema representation
 * ```
 */
export function getEventSchemaInfo(event) {
    if (!event.schema) {
        return undefined;
    }
    // Convert Effect Schema to JSON Schema
    return JSONSchema.make(event.schema);
}
//# sourceMappingURL=EventDeclaration.js.map