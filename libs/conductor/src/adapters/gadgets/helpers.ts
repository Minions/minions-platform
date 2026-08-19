/**
 * Shared helper functions for gadget implementations
 *
 * These helpers extract common patterns used across multiple gadgets
 * to reduce duplication and ensure consistent behavior.
 */

import { Either } from 'effect';
import type { Costume, CostumeEvent } from '@minions/costumes';

/**
 * Look up an event in a costume's events array
 *
 * Validates that the costume has events defined and searches for the
 * specified event type. Returns descriptive error messages if the event
 * is not found or if no events are defined.
 *
 * @param costume - The costume to search
 * @param eventType - The event type to find
 * @param context - Context for error messages (default: "query event schema")
 * @returns Either.right(costumeEvent) on success, Either.left(errorMessage) on failure
 *
 * @example
 * ```typescript
 * const result = findCostumeEvent(costume, 'test-passed', 'emit event');
 * if (Either.isLeft(result)) {
 *   return Effect.succeed({ success: false, error: result.left });
 * }
 * const costumeEvent = result.right;
 * // Use costumeEvent.event and costumeEvent.guidance
 * ```
 */
export function findCostumeEvent(
  costume: Costume,
  eventType: string,
  context = 'query event schema'
): Either.Either<CostumeEvent, string> {
  // Check if costume has any events defined
  if (!costume.events || costume.events.length === 0) {
    return Either.left(
      `No events are defined in this costume. Cannot ${context}.`
    );
  }

  // Look up the event
  const costumeEvent = costume.events.find((e) => e.event.type === eventType);

  // Event not found
  if (!costumeEvent) {
    const availableEvents = costume.events.map((e) => e.event.type).join(', ');
    return Either.left(
      `Event type '${eventType}' not found in costume. Available events: ${availableEvents}`
    );
  }

  return Either.right(costumeEvent);
}
