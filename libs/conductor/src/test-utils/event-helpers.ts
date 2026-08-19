import type { TypedEvent, EventDeclaration } from '@minions/events';
import type { SerializedEvent } from '../domain/EventSerialization';

/**
 * Creates a test event with the given type and payload.
 * Used across event persistence tests to create consistent test data.
 *
 * @param type - The event type
 * @param payload - The event payload
 * @param source - The event source (defaults to 'test-source')
 * @param timestamp - The event timestamp (defaults to Date.now())
 * @returns A TypedEvent with the given properties
 */
export function createTestEvent(
  type: string,
  payload: Record<string, unknown>,
  source = 'test-source',
  timestamp: number = Date.now()
): TypedEvent<EventDeclaration> {
  return {
    ...payload,
    __type: type,
    __source: source,
    __timestamp: timestamp,
  };
}

/**
 * Creates a serialized event for testing event loading and state reconstruction.
 * This creates events in the serialized format (as they would appear after persistence).
 *
 * @param type - The event type
 * @param payload - The event payload
 * @param source - The event source (defaults to 'mission')
 * @param timestamp - The event timestamp (defaults to Date.now())
 * @returns A SerializedEvent with the given properties
 */
export function createSerializedEvent(
  type: string,
  payload: Record<string, unknown>,
  source = 'mission',
  timestamp: number = Date.now()
): SerializedEvent {
  return {
    type,
    payload,
    source,
    timestamp,
  };
}
