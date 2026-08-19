/**
 * Gadgets Package - Domain Types
 *
 * This package defines the core interfaces for executable gadgets - tools with
 * mission context that can be injected into minions at spawn time.
 *
 * Key architectural boundaries:
 * - This package depends ONLY on Effect (no conductor, hatchery, or domain-types)
 * - ExecutableGadget defines the clean interface between conductor and hatchery
 * - Gadget implementations live in conductor's adapters layer
 * - Hatchery receives ExecutableGadgets as opaque closures and executes them
 *
 * @example
 * ```typescript
 * import { ExecutableGadget, ToolResult } from '@minions/gadgets';
 * import { Effect } from 'effect';
 *
 * // Create a gadget with mission context
 * const myGadget: ExecutableGadget = {
 *   tool: {
 *     name: 'emit_event',
 *     description: 'Emit a structured event',
 *     input_schema: { type: 'object', properties: { ... } }
 *   },
 *   execute: (input: unknown) => Effect.succeed({
 *     success: true,
 *     result: 'Event emitted successfully'
 *   })
 * };
 * ```
 */
import { Effect } from 'effect';
/**
 * Tool definition compatible with MCP (Model Context Protocol)
 *
 * Defines the metadata for a tool that can be exposed to AI models.
 * This is the declarative part - what the tool is and what it accepts.
 */
export interface Tool {
    /**
     * Unique identifier for the tool
     * @example "emit_event", "get_event_schema"
     */
    name: string;
    /**
     * Human-readable description of what the tool does
     * @example "Emit a structured event to the mission's event bus"
     */
    description: string;
    /**
     * JSON Schema describing the tool's input parameters
     * Compatible with MCP input_schema format
     */
    input_schema?: Record<string, unknown>;
}
/**
 * Result of a gadget execution
 *
 * Gadgets return either success with a result or failure with an error message.
 * Errors are returned as ToolResult (not thrown) to make them visible to the AI
 * model for retry logic.
 */
export type ToolResult = {
    success: true;
    result: unknown;
} | {
    success: false;
    error: string;
};
/**
 * Executable gadget with mission context
 *
 * An ExecutableGadget combines a tool definition with an executable implementation
 * that has mission context (costume, event bus, etc.) captured in its closure.
 *
 * This is the architectural boundary between conductor (which creates gadgets with
 * context) and hatchery (which executes gadgets without knowing about context).
 *
 * Key design decisions:
 * - execute returns Effect<ToolResult, never, never> - no error channel, no context
 * - All errors are captured in the ToolResult.error field
 * - Synchronous execution model (Effect runs immediately)
 * - Gadget implementations capture mission context in closures
 *
 * @example
 * ```typescript
 * const eventGadget: ExecutableGadget = {
 *   tool: {
 *     name: 'emit_event',
 *     description: 'Emit event with validation',
 *     input_schema: { type: 'object', properties: { eventType: { type: 'string' } } }
 *   },
 *   execute: (input) => Effect.gen(function* () {
 *     // Implementation has access to mission context via closure
 *     const validated = yield* validateEvent(input);
 *     yield* eventBus.emit(validated);
 *     return { success: true, result: 'Event emitted' };
 *   }).pipe(
 *     Effect.catchAll((error) => Effect.succeed({
 *       success: false,
 *       error: String(error)
 *     }))
 *   )
 * };
 * ```
 */
export interface ExecutableGadget {
    /**
     * Tool definition (metadata)
     *
     * This is what gets added to the minion's spec.tools array so the AI
     * model knows the tool exists and how to call it.
     */
    tool: Tool;
    /**
     * Executable implementation with mission context
     *
     * The execute function has mission context (costume, event bus, etc.)
     * captured in its closure. It accepts raw input and returns an Effect
     * that produces a ToolResult.
     *
     * Error handling: All errors must be caught and returned as ToolResult
     * with success: false. This makes errors visible to the AI for retry.
     *
     * @param input - Raw input from the AI model (typically an object)
     * @returns Effect that produces ToolResult (never fails, never requires context)
     */
    execute: (input: unknown) => Effect.Effect<ToolResult, never, never>;
}
/**
 * Factory function type for creating context-aware gadgets
 *
 * A GadgetFactory is a function that captures specific context (costume,
 * event bus, etc.) and returns an array of ExecutableGadgets that use that
 * context.
 *
 * The factory pattern separates conductor concerns (what context to provide)
 * from gadget implementations (how to use that context).
 *
 * @template TContext - The type of context needed by the gadgets
 *
 * @example
 * ```typescript
 * interface EventGadgetContext {
 *   costume: Costume;
 *   eventBus: IEventBus;
 *   minionId: string;
 * }
 *
 * const createEventGadgets: GadgetFactory<EventGadgetContext> = (context) => [
 *   createGetEventSchemaGadget(context),
 *   createEmitEventGadget(context),
 * ];
 * ```
 */
export type GadgetFactory<TContext> = (context: TContext) => ExecutableGadget[];
export { GetEventSchemaInput, GetEventSchemaResult, EmitEventInput, EmitEventResult, } from './event-gadgets';
export type { GetEventSchemaInput as GetEventSchemaInputType, GetEventSchemaResult as GetEventSchemaResultType, EmitEventInput as EmitEventInputType, EmitEventResult as EmitEventResultType, } from './event-gadgets';
//# sourceMappingURL=index.d.ts.map