/**
 * Events Domain - Public API
 *
 * Provides the event declaration system and event bus for AI minions.
 *
 * This is a hexagonal domain that owns the event infrastructure. It has no
 * dependencies on other minions packages - only Effect for infrastructure.
 * Other domains integrate via dependency injection and define their own events.
 *
 * See ARCHITECTURE.md for integration patterns.
 */

// Event declaration system
export type {
  EventDeclaration,
  AnyEventDeclaration,
  PayloadOf,
  ParentTypeOf,
  EventsWithParent,
  ChildEventsOf,
  DescendantEventsOf,
  EventWithDescendants,
  TypedEvent,
  TypedEventUnion,
} from './EventDeclaration';

export {
  defineEvent,
  defineChildEvent,
  getParentEventType,
  getAncestorChain,
  isChildEvent,
  getEventSchemaInfo,
} from './EventDeclaration';

// Event bus infrastructure events
export { EventBusEvents, WellKnownEvents } from './WellKnownEvents';

// Event bus
export type {
  IEventBus,
  EventSource,
  EventFilterOptions,
  ActiveListener,
  Unsubscribe,
} from './EventBus';

export { EventBus, Src } from './EventBus';
