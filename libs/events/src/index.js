/**
 * Events Package - Public API
 *
 * Provides the event declaration system and event bus for AI minions.
 * This is a foundational package with no dependencies on other minions packages.
 */
export { defineEvent, defineChildEvent, getParentEventType, getAncestorChain, isChildEvent, getEventSchemaInfo, } from './EventDeclaration';
// Event bus infrastructure events
export { EventBusEvents, WellKnownEvents } from './WellKnownEvents';
export { EventBus, Src } from './EventBus';
//# sourceMappingURL=index.js.map