/**
 * Get Event Schema Gadget Implementation
 *
 * Provides the executable implementation for the get_event_schema gadget.
 * This gadget allows minions to query the expected payload schema for any
 * event defined in their costume.
 *
 * Implementation uses Effect for functional error handling and relies on
 * the getEventSchemaInfo() helper from EventDeclaration to convert Effect
 * Schemas to JSON Schema format.
 */

import { Effect, Either } from 'effect';
import type { Costume } from '@minions/costumes';
import { getEventSchemaInfo } from '@minions/costumes';
import type { ToolResult, GetEventSchemaInput } from '@minions/gadgets';
import { findCostumeEvent } from './helpers';

/**
 * Execute get_event_schema gadget
 *
 * Looks up an event type in the costume's events array and returns its
 * JSON Schema representation along with guidance for when to emit it.
 *
 * @param costume - The costume defining available events
 * @param input - Validated input containing eventType
 * @returns Effect producing ToolResult with schema info or error
 *
 * @example
 * ```typescript
 * const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
 * const toolResult = Effect.runSync(result);
 * // Returns: { success: true, result: { eventType, schema, guidance } }
 * ```
 */
export function executeGetEventSchema(
  costume: Costume,
  input: GetEventSchemaInput
): Effect.Effect<ToolResult, never, never> {
  const { eventType } = input;

  // Look up the event using shared helper
  const eventLookup = findCostumeEvent(costume, eventType);
  if (Either.isLeft(eventLookup)) {
    return Effect.succeed({ success: false, error: eventLookup.left });
  }
  const costumeEvent = eventLookup.right;

  // Get schema info using helper
  const schemaInfo = getEventSchemaInfo(costumeEvent.event);

  // Check if event has a schema defined
  if (schemaInfo === undefined) {
    return Effect.succeed({
      success: false,
      error: `Event type '${eventType}' exists but has no schema defined. Cannot provide schema information.`,
    });
  }

  // Return success with schema and guidance
  return Effect.succeed({
    success: true,
    result: {
      eventType,
      schema: schemaInfo,
      guidance: costumeEvent.guidance,
    },
  });
}
