/**
 * Conductor Event Declarations
 *
 * Re-exports event declaration system and well-known events from @minions/events.
 */

// Re-export event declaration system from @minions/events
export type {
  EventDeclaration,
  PayloadOf,
  ParentTypeOf,
  EventsWithParent,
  ChildEventsOf,
  DescendantEventsOf,
  EventWithDescendants,
  TypedEvent,
  TypedEventUnion,
} from '@minions/events';

export {
  defineEvent,
  defineChildEvent,
  getParentEventType,
  getAncestorChain,
  isChildEvent,
  getEventSchemaInfo,
} from '@minions/events';

// Re-export event bus infrastructure events from @minions/events
export { EventBusEvents, WellKnownEvents } from '@minions/events';
