/**
 * Event Serialization for Persistence
 *
 * Provides JSON Lines format serialization for TypedEvents, enabling
 * event persistence and replay for mission state inspection, debugging,
 * and resumption across session boundaries.
 *
 * JSON Lines format: each event is a single line of JSON, allowing
 * streaming append without rewriting the entire file.
 */

import type { AnyEventDeclaration, TypedEvent } from '@minions/events';

/**
 * Serialized representation of a TypedEvent for persistence
 *
 * This format preserves all information needed to reconstruct a TypedEvent,
 * including the event type, payload, source identifier, and timestamp.
 *
 * Source serialization:
 * - Minion events: minion ID (e.g., "minion-abc123")
 * - Mission events: 'mission'
 * - External events: 'external:name' (e.g., 'external:test-watch')
 */
export interface SerializedEvent {
  /** Event type identifier */
  type: string;

  /** Event payload (JSON-serializable) */
  payload: Record<string, unknown>;

  /** Source identifier as string */
  source: string;

  /** Timestamp when event was emitted (milliseconds since epoch) */
  timestamp: number;
}

/**
 * Serialize a TypedEvent to SerializedEvent format
 *
 * Extracts the event metadata (__type, __source, __timestamp) and combines
 * with the payload to create a serialized representation suitable for
 * JSON Lines persistence.
 *
 * @param event - The TypedEvent to serialize
 * @returns SerializedEvent ready for JSON stringification
 *
 * @example
 * ```typescript
 * const typedEvent: TypedEvent<typeof MyEvent> = {
 *   taskId: '123',
 *   result: 'success',
 *   __type: 'task-complete',
 *   __source: 'minion-abc',
 *   __timestamp: 1234567890,
 * };
 *
 * const serialized = serializeEvent(typedEvent);
 * // { type: 'task-complete', payload: { taskId: '123', result: 'success' }, source: 'minion-abc', timestamp: 1234567890 }
 *
 * const jsonLine = JSON.stringify(serialized);
 * // One line, ready to append to file
 * ```
 */
export function serializeEvent<E extends AnyEventDeclaration>(
  event: TypedEvent<E>
): SerializedEvent {
  // Extract metadata fields
  const { __type, __source, __timestamp, ...payload } = event;

  return {
    type: __type,
    payload: payload as Record<string, unknown>,
    source: __source,
    timestamp: __timestamp,
  };
}

/**
 * Deserialize a SerializedEvent back to TypedEvent format
 *
 * Reconstructs a TypedEvent from its serialized representation by
 * spreading the payload and adding back the metadata fields.
 *
 * Note: This does not validate the payload against any schema. It assumes
 * the serialized data is valid. For validation, use Effect Schema separately.
 *
 * @param serialized - The SerializedEvent to deserialize
 * @returns TypedEvent with metadata fields restored
 *
 * @example
 * ```typescript
 * const serialized: SerializedEvent = {
 *   type: 'task-complete',
 *   payload: { taskId: '123', result: 'success' },
 *   source: 'minion-abc',
 *   timestamp: 1234567890,
 * };
 *
 * const typedEvent = deserializeEvent(serialized);
 * // {
 * //   taskId: '123',
 * //   result: 'success',
 * //   __type: 'task-complete',
 * //   __source: 'minion-abc',
 * //   __timestamp: 1234567890,
 * // }
 * ```
 */
export function deserializeEvent(
  serialized: SerializedEvent
): TypedEvent<AnyEventDeclaration> {
  return {
    ...serialized.payload,
    __type: serialized.type,
    __source: serialized.source,
    __timestamp: serialized.timestamp,
  } as TypedEvent<AnyEventDeclaration>;
}

/**
 * Serialize a TypedEvent to a JSON Lines format string
 *
 * Combines serialization and JSON stringification in one step.
 * The result is a single line of JSON suitable for appending to a file.
 *
 * @param event - The TypedEvent to serialize
 * @returns JSON string (single line, no trailing newline)
 *
 * @example
 * ```typescript
 * const line = serializeEventToJsonLine(event);
 * // '{"type":"task-complete","payload":{"taskId":"123"},"source":"minion-abc","timestamp":1234567890}'
 * ```
 */
export function serializeEventToJsonLine<E extends AnyEventDeclaration>(
  event: TypedEvent<E>
): string {
  return JSON.stringify(serializeEvent(event));
}

/**
 * Deserialize a JSON Lines format string to TypedEvent
 *
 * Parses a JSON line and deserializes it to a TypedEvent.
 * Throws if the JSON is malformed.
 *
 * @param line - JSON string representing a serialized event
 * @returns Deserialized TypedEvent
 * @throws SyntaxError if JSON parsing fails
 *
 * @example
 * ```typescript
 * const line = '{"type":"task-complete","payload":{"taskId":"123"},"source":"minion-abc","timestamp":1234567890}';
 * const event = deserializeEventFromJsonLine(line);
 * ```
 */
export function deserializeEventFromJsonLine(
  line: string
): TypedEvent<AnyEventDeclaration> {
  const serialized = JSON.parse(line) as SerializedEvent;
  return deserializeEvent(serialized);
}
