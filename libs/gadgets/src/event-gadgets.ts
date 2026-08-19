/**
 * Event Gadget Type Definitions
 *
 * Defines the input and output types for the two auto-injected event gadgets
 * that minions use to interact with the mission event system:
 *
 * 1. get_event_schema: Query the expected payload schema for an event type
 * 2. emit_event: Emit a structured event with validation
 *
 * These types use Effect Schema for runtime validation and provide clear
 * contracts between minions and the event system.
 */

import { Schema } from 'effect';

// ============================================================================
// get_event_schema Gadget
// ============================================================================

/**
 * Input schema for get_event_schema gadget
 *
 * Allows minions to query the expected payload structure for any event
 * defined in their costume.
 */
export const GetEventSchemaInput = Schema.Struct({
  /**
   * Name of the event type to retrieve schema for
   *
   * @example "test-passed", "build-failed", "task-complete"
   */
  eventType: Schema.String,
});

/**
 * TypeScript type for GetEventSchemaInput
 *
 * Extracted from the Schema definition for use in function signatures
 * and type annotations.
 */
export type GetEventSchemaInput = Schema.Schema.Type<typeof GetEventSchemaInput>;

/**
 * Output schema for successful get_event_schema result
 *
 * Returns the JSON Schema representation of the event's payload structure.
 * This allows minions to understand what fields are required/optional
 * and what types are expected.
 */
export const GetEventSchemaResult = Schema.Struct({
  /**
   * Name of the event type
   */
  eventType: Schema.String,

  /**
   * JSON Schema describing the event's payload structure
   *
   * This follows the JSON Schema specification and can be used by
   * minions to validate their payloads before emission.
   *
   * @example
   * {
   *   "type": "object",
   *   "properties": {
   *     "testName": { "type": "string" },
   *     "duration": { "type": "number" }
   *   },
   *   "required": ["testName", "duration"]
   * }
   */
  schema: Schema.Unknown,

  /**
   * Human-readable guidance for when to emit this event
   *
   * Provides context to minions about the purpose and timing of the event.
   *
   * @example "Emit when a test finishes executing successfully"
   */
  guidance: Schema.String,
});

/**
 * TypeScript type for GetEventSchemaResult
 */
export type GetEventSchemaResult = Schema.Schema.Type<typeof GetEventSchemaResult>;

// ============================================================================
// emit_event Gadget
// ============================================================================

/**
 * Input schema for emit_event gadget
 *
 * Allows minions to emit structured events with validation against
 * the event's declared schema.
 */
export const EmitEventInput = Schema.Struct({
  /**
   * Name of the event type to emit
   *
   * Must match an event type defined in the minion's costume.
   *
   * @example "test-passed", "build-failed", "task-complete"
   */
  eventType: Schema.String,

  /**
   * Event payload data
   *
   * This will be validated against the event's declared schema.
   * Must conform to the structure returned by get_event_schema.
   *
   * @example { testName: "should handle errors", duration: 145 }
   */
  payload: Schema.Unknown,
});

/**
 * TypeScript type for EmitEventInput
 */
export type EmitEventInput = Schema.Schema.Type<typeof EmitEventInput>;

/**
 * Output schema for successful emit_event result
 *
 * Confirms that the event was emitted successfully and provides
 * metadata about the emission.
 */
export const EmitEventResult = Schema.Struct({
  /**
   * Name of the emitted event type
   */
  eventType: Schema.String,

  /**
   * Confirmation message
   *
   * @example "Event 'test-passed' emitted successfully"
   */
  message: Schema.String,

  /**
   * Timestamp when the event was emitted
   *
   * Unix timestamp in milliseconds.
   */
  timestamp: Schema.Number,
});

/**
 * TypeScript type for EmitEventResult
 */
export type EmitEventResult = Schema.Schema.Type<typeof EmitEventResult>;

// ============================================================================
// Tool Input Schema Helpers
// ============================================================================

/**
 * Convert an Effect Schema to MCP-compatible JSON Schema
 *
 * This helper converts Effect Schema definitions into the JSON Schema
 * format expected by MCP (Model Context Protocol) tool definitions.
 *
 * @param schema - The Effect Schema to convert
 * @returns JSON Schema object suitable for MCP tool input_schema
 *
 * @example
 * ```typescript
 * import { JSONSchema } from 'effect';
 *
 * const jsonSchema = JSONSchema.make(GetEventSchemaInput);
 * // Returns MCP-compatible JSON Schema
 * ```
 */
// Note: This is actually provided by Effect's JSONSchema module,
// so we just document its usage here rather than re-implementing.
