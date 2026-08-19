/**
 * Event Gadget Factory
 *
 * Factory function that creates executable event gadgets with mission context.
 * This keeps conductor concerns (costume, event bus) separate from hatchery.
 *
 * The factory creates two auto-injected gadgets:
 * - get_event_schema: Query expected payload schema for an event type
 * - emit_event: Emit a structured event with validation
 *
 * Each gadget captures costume and eventBus references in closures, making them
 * self-contained executable functions that hatchery can invoke without knowing
 * about conductor internals.
 */

import { Effect, JSONSchema } from 'effect';
import type { Costume } from '@minions/costumes';
import type { IEventBus } from '@minions/events';
import {
  type ExecutableGadget,
  type ToolResult,
  GetEventSchemaInput,
  type GetEventSchemaInput as GetEventSchemaInputType,
  EmitEventInput,
  type EmitEventInput as EmitEventInputType,
} from '@minions/gadgets';
import { executeGetEventSchema } from './getEventSchema';
import { executeEmitEvent } from './emitEvent';

/**
 * Create event gadgets for a minion
 *
 * Factory function that creates both get_event_schema and emit_event gadgets
 * with closures over mission context (costume and event bus).
 *
 * @param costume - The costume defining available events
 * @param eventBus - The mission's event bus for emission
 * @param getMinionId - Function that returns the minion instance ID for event source tagging
 * @returns Array containing both event gadgets
 *
 * @example
 * ```typescript
 * const gadgets = createEventGadgets(costume, eventBus, () => minion.id);
 * // Returns: [getEventSchemaGadget, emitEventGadget]
 * ```
 */
export function createEventGadgets(
  costume: Costume,
  eventBus: IEventBus,
  getMinionId: () => string
): ExecutableGadget[] {
  // Create get_event_schema gadget
  const getEventSchemaGadget: ExecutableGadget = {
    tool: {
      name: 'get_event_schema',
      description:
        'Query the expected payload schema for an event type defined in your costume',
      input_schema: JSONSchema.make(GetEventSchemaInput) as unknown as Record<string, unknown>,
    },
    execute: (input: unknown): Effect.Effect<ToolResult, never, never> => {
      return executeGetEventSchema(costume, input as GetEventSchemaInputType);
    },
  };

  // Create emit_event gadget
  const emitEventGadget: ExecutableGadget = {
    tool: {
      name: 'emit_event',
      description: 'Emit a structured event with validation',
      input_schema: JSONSchema.make(EmitEventInput) as unknown as Record<string, unknown>,
    },
    execute: (input: unknown): Effect.Effect<ToolResult, never, never> => {
      // Get minion ID at execution time, not creation time
      const minionId = getMinionId();
      return executeEmitEvent(costume, eventBus, minionId, input as EmitEventInputType);
    },
  };

  return [getEventSchemaGadget, emitEventGadget];
}
