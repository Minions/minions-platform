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

import { Schema, JSONSchema } from 'effect';

/**
 * EventDeclaration explicitly states the payload type
 *
 * The payload type is part of the declaration, not inferred from usage.
 * This provides better type checking and makes the payload structure
 * discoverable without finding an emit() call.
 *
 * @template P - The payload type for this event
 * @template TypeStr - The literal event type string (for discriminated unions)
 * @template ParentType - The parent event type string (if this is a child event)
 */
export interface EventDeclaration<
  P = unknown,
  TypeStr extends string = string,
  ParentType extends string = never
> {
  /** Event type identifier (literal string for discriminated unions) */
  readonly type: TypeStr;

  /**
   * Payload type marker (compile-time only)
   *
   * This field exists only for TypeScript type inference.
   * At runtime, it is always undefined.
   */
  readonly payload: P;

  /**
   * Parent event type marker (compile-time only)
   *
   * For child events, this holds the parent's event type string.
   * For root events, this is never.
   *
   * This field exists only for TypeScript type inference.
   * At runtime, it is always undefined.
   */
  readonly __parentType: ParentType;

  /**
   * Schema for runtime payload validation
   *
   * When provided, the event bus will validate payloads against this schema
   * before emitting events. Validation errors are descriptive and actionable.
   */
  readonly schema?: Schema.Schema<P, unknown, never>;
}

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
export function defineEvent<P, const TypeStr extends string = string>(
  type: TypeStr,
  // `Schema.Schema`'s decode-input parameter (`I`) is invariant, so a schema built via
  // `Schema.Struct(...)` (whose `I` is normally the struct's own field shape, i.e. `I = P`)
  // doesn't structurally match a parameter typed as `Schema.Schema<P, unknown, never>`. Both
  // conventions are used by callers in this codebase - schemas constructed directly
  // (`I = P`) and schemas explicitly cast to `Schema.Schema<P, unknown, never>` (e.g. when a
  // field's validated shape is looser than its declared payload type) - so we accept both.
  schema?: Schema.Schema<P, unknown, never> | Schema.Schema<P, P, never>
): EventDeclaration<P, TypeStr, never> {
  return {
    type,
    payload: undefined as unknown as P,
    __parentType: undefined as never,
    schema: schema as Schema.Schema<P, unknown, never> | undefined,
  };
}

/**
 * A schema-erased view of an EventDeclaration
 *
 * Used as the generic constraint for `Universe`/`E`/`ParentEvent` type parameters
 * throughout this module and in EventBus. We deliberately omit `schema` here: its
 * type (`Schema.Schema<P, unknown, never>`) uses `P` in both a covariant position
 * (the decoded payload shape) and a contravariant one (the schema's internal
 * `annotations` method parameter), which makes `EventDeclaration` invariant in `P`.
 * That means no widening substitution for `P` (e.g. `unknown`) can make a concrete
 * `EventDeclaration<SpecificPayload, ...>` structurally assignable to a wildcard
 * bound that still carries `schema` in its shape.
 *
 * None of the type-level helpers below ever need to read `schema` - only `type`,
 * `payload`, and `__parentType` - so dropping it from the bound removes the
 * invariant field and gives a genuine, type-safe "any EventDeclaration" bound.
 */
export type AnyEventDeclaration<
  P = unknown,
  TypeStr extends string = string,
  ParentType extends string = string
> = Pick<EventDeclaration<P, TypeStr, ParentType>, 'type' | 'payload' | '__parentType'>;

/**
 * Extract the payload type from an EventDeclaration
 *
 * @template E - The EventDeclaration type
 */
export type PayloadOf<E extends AnyEventDeclaration> = E['payload'];

/**
 * Extract the parent event type string from a child event
 *
 * @template E - The EventDeclaration type
 */
export type ParentTypeOf<E extends AnyEventDeclaration> = E['__parentType'];

/**
 * Find all events in a universe that have the given parent type
 *
 * @template Universe - Union of all EventDeclarations to search
 * @template ParentTypeStr - The parent event type string to match
 */
export type EventsWithParent<
  Universe extends AnyEventDeclaration,
  ParentTypeStr extends string
> = string extends ParentTypeStr
  ? // `ParentTypeStr` widened all the way to `string` (e.g. an event whose `type` wasn't
    // pinned to a literal) carries no usable type-level identity to match children
    // against, so there is nothing we can soundly resolve as "its descendants".
    never
  : Universe extends unknown
    ? ParentTypeOf<Universe> extends ParentTypeStr
      ? Universe
      : never
    : never;

/**
 * Find all direct children of a parent event
 *
 * @template Universe - Union of all EventDeclarations to search
 * @template ParentEvent - The parent event declaration
 */
export type ChildEventsOf<
  Universe extends AnyEventDeclaration,
  ParentEvent extends AnyEventDeclaration
> = EventsWithParent<Universe, ParentEvent['type']>;

/**
 * Recursively find all descendants (children + grandchildren + ...) of a parent event
 *
 * Limited to 5 levels deep to avoid excessive recursion.
 *
 * @template Universe - Union of all EventDeclarations to search
 * @template ParentEvent - The parent event declaration
 * @template Depth - Recursion depth counter (internal, do not specify)
 */
export type DescendantEventsOf<
  Universe extends AnyEventDeclaration,
  ParentEvent extends AnyEventDeclaration,
  Depth extends unknown[] = []
> = Depth['length'] extends 5
  ? ChildEventsOf<Universe, ParentEvent>
  : ChildEventsOf<Universe, ParentEvent> extends never
    ? never
    :
        | ChildEventsOf<Universe, ParentEvent>
        | DescendantEventsOf<Universe, ChildEventsOf<Universe, ParentEvent>, [unknown, ...Depth]>;

/**
 * Union of an event and all its descendants
 *
 * @template Universe - Union of all EventDeclarations to search
 * @template E - The event declaration
 */
export type EventWithDescendants<
  Universe extends AnyEventDeclaration,
  E extends AnyEventDeclaration
> = E | DescendantEventsOf<Universe, E>;

/**
 * A typed event with its source and metadata
 *
 * This is what handlers receive when an event is emitted.
 *
 * @template E - The EventDeclaration type
 */
export type TypedEvent<E extends AnyEventDeclaration> = PayloadOf<E> & {
  /** Event type identifier */
  readonly __type: E['type'];

  /** Source of the event (minion ID, 'mission', or 'external') */
  readonly __source: string;

  /** Timestamp when the event was emitted */
  readonly __timestamp: number;
};

/**
 * Union of typed events for an event and all its descendants
 *
 * This is what parent listeners receive - a discriminated union of all possible
 * child event types. The `__type` field serves as the discriminator.
 *
 * @template Universe - Union of all EventDeclarations to search
 * @template E - The event declaration
 *
 * @example
 * ```typescript
 * type AllEvents = typeof ParentEvent | typeof Child1 | typeof Child2;
 *
 * // Parent listener receives union type
 * bus.on<AllEvents>(ParentEvent, (event: TypedEventUnion<AllEvents, typeof ParentEvent>) => {
 *   // event is: TypedEvent<ParentEvent> | TypedEvent<Child1> | TypedEvent<Child2>
 *   if (event.__type === 'child-1') {
 *     // TypeScript narrows to TypedEvent<Child1>
 *     event.child1Field; // OK
 *   }
 * });
 * ```
 */
export type TypedEventUnion<
  Universe extends AnyEventDeclaration,
  E extends AnyEventDeclaration
> = EventWithDescendants<Universe, E> extends infer D
  ? D extends AnyEventDeclaration
    ? TypedEvent<D>
    : never
  : never;

/**
 * Event registry to track parent-child relationships
 *
 * Maps child event types to their parent event types.
 * When a child event is emitted, it will also be dispatched to parent listeners.
 */
const childToParentMap = new Map<string, string>();

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
export function defineChildEvent<
  ParentEvent extends AnyEventDeclaration,
  ChildPayload extends PayloadOf<ParentEvent>,
  const ChildTypeStr extends string = string
>(
  parent: ParentEvent,
  childType: ChildTypeStr,
  // See defineEvent's matching comment on why both conventions are accepted here.
  schema?: Schema.Schema<ChildPayload, unknown, never> | Schema.Schema<ChildPayload, ChildPayload, never>
): EventDeclaration<ChildPayload, ChildTypeStr, ParentEvent['type']> {
  // Register the parent-child relationship
  childToParentMap.set(childType, parent.type);

  return {
    type: childType,
    payload: undefined as unknown as ChildPayload,
    __parentType: parent.type as ParentEvent['type'],
    // See defineEvent's matching comment: widening `I` to `unknown` here is sound because
    // consumers only ever validate via `Schema.decodeUnknown`.
    schema: schema as Schema.Schema<ChildPayload, unknown, never> | undefined,
  };
}

/**
 * Get the parent event type for a child event type
 *
 * @param eventType - The event type to check
 * @returns The parent event type, or undefined if not a child event
 * @internal
 */
export function getParentEventType(eventType: string): string | undefined {
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
export function getAncestorChain(eventType: string): string[] {
  const ancestors: string[] = [];
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
export function isChildEvent(eventType: string): boolean {
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
export function getEventSchemaInfo<P, TypeStr extends string, ParentType extends string>(
  event: EventDeclaration<P, TypeStr, ParentType>
): unknown {
  const schema = event.schema;
  if (!schema) {
    return undefined;
  }

  // Convert Effect Schema to JSON Schema
  return JSONSchema.make(schema);
}
