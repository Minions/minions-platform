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
// Export event gadget types
export { GetEventSchemaInput, GetEventSchemaResult, EmitEventInput, EmitEventResult, } from './event-gadgets';
//# sourceMappingURL=index.js.map