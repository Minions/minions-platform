/**
 * Emit Event Gadget Implementation
 *
 * Provides the executable implementation for the emit_event gadget.
 * This gadget allows minions to emit structured events that appear on the
 * mission's event bus with full validation.
 *
 * Implementation uses Effect for functional error handling and relies on
 * the EventBus.emitFromEffect() method to emit events with the minion as source.
 */

import { Effect, Schema, ParseResult, Either } from 'effect';
import type { Costume } from '@minions/costumes';
import type { IEventBus } from '@minions/events';
import type { ToolResult, EmitEventInput } from '@minions/gadgets';
import { findCostumeEvent } from './helpers';

/**
 * Execute emit_event gadget
 *
 * Validates the event type exists in the costume, validates the payload against
 * the event's schema, and emits the event to the mission's event bus with the
 * minion instance as the source.
 *
 * @param costume - The costume defining available events
 * @param eventBus - The mission's event bus for emission
 * @param minionId - The minion instance ID for event source tagging
 * @param input - Validated input containing eventType and payload
 * @returns Effect producing ToolResult with emission confirmation or error
 *
 * @example
 * ```typescript
 * const result = executeEmitEvent(costume, eventBus, 'minion-123', {
 *   eventType: 'test-passed',
 *   payload: { testName: 'auth', duration: 145 }
 * });
 * const toolResult = Effect.runSync(result);
 * // Returns: { success: true, result: { eventType, message, timestamp } }
 * ```
 */
export function executeEmitEvent(
  costume: Costume,
  eventBus: IEventBus,
  minionId: string,
  input: EmitEventInput
): Effect.Effect<ToolResult, never, never> {
  const { eventType, payload } = input;

  // Look up the event using shared helper
  const eventLookup = findCostumeEvent(costume, eventType, 'emit event');
  if (Either.isLeft(eventLookup)) {
    return Effect.succeed({ success: false, error: eventLookup.left });
  }
  const costumeEvent = eventLookup.right;

  const event = costumeEvent.event;

  // If event has a schema, validate the payload
  const eventSchema = event.schema;
  if (eventSchema) {
    return Effect.gen(function* () {
      // Try to validate the payload
      const validationResult = yield* Schema.decodeUnknown(eventSchema)(payload).pipe(
        Effect.either
      );

      // If validation failed, format the error descriptively
      if (validationResult._tag === 'Left') {
        const parseError = validationResult.left;

        // Format the parse error into an actionable message
        const errorMessage = formatValidationError(eventType, parseError);

        return {
          success: false,
          error: errorMessage,
        } as ToolResult;
      }

      // Payload is valid, emit the event
      const emitResult = yield* eventBus.emitFromEffect(event, payload, minionId).pipe(
        Effect.either
      );

      // Check if emission failed (should be rare)
      if (emitResult._tag === 'Left') {
        return {
          success: false,
          error: `Failed to emit event '${eventType}': ${String(emitResult.left)}`,
        } as ToolResult;
      }

      // Success - return confirmation
      return {
        success: true,
        result: {
          eventType,
          message: `Event '${eventType}' emitted successfully`,
          timestamp: Date.now(),
        },
      } as ToolResult;
    }) as Effect.Effect<ToolResult, never, never>;
  }

  // No schema - emit without validation
  return Effect.gen(function* () {
    const emitResult = yield* eventBus.emitFromEffect(event, payload, minionId).pipe(
      Effect.either
    );

    // Check if emission failed
    if (emitResult._tag === 'Left') {
      return {
        success: false,
        error: `Failed to emit event '${eventType}': ${String(emitResult.left)}`,
      } as ToolResult;
    }

    // Success - return confirmation
    return {
      success: true,
      result: {
        eventType,
        message: `Event '${eventType}' emitted successfully`,
        timestamp: Date.now(),
      },
    } as ToolResult;
  });
}

/**
 * Format a ParseError into an actionable error message
 *
 * Extracts key information from Effect Schema's ParseError to provide
 * descriptive feedback about missing, wrong, or extra fields.
 *
 * @param eventType - The event type being validated
 * @param error - The ParseError from schema validation
 * @returns Formatted error message for the minion
 */
function formatValidationError(eventType: string, error: ParseResult.ParseError): string {
  // Get the error message from the parse error
  const errorDetails = ParseResult.ArrayFormatter.formatErrorSync(error);

  // Format into a clear, actionable message
  const issues = errorDetails.map((detail) => `  - ${detail.message}`).join('\n');

  return `Event '${eventType}' payload validation failed:\n${issues}\n\nPlease check the event schema using get_event_schema and ensure your payload matches the required structure.`;
}
