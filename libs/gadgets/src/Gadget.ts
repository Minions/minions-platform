/**
 * Gadget - A file-backed executable function parallel to Mission
 *
 * Gadgets and missions are both dynamically loaded TypeScript functions.
 * They differ only in context:
 * - A Mission has minion history (MissionContext with emit, spawn, ask)
 * - A Gadget does NOT have minion history (GadgetContext with file access only)
 *
 * Gadgets live in `gadgets/` directories within costume closets and are
 * loaded by ClosetGadgetLoader, parallel to how ClosetMissionLoader
 * loads missions from `missions/` directories.
 *
 * @example
 * ```typescript
 * export const gadget: Gadget<{ name: string }> = {
 *   name: 'create_costume',
 *   description: 'Create a new costume from a template',
 *   args: {
 *     type: 'object',
 *     properties: {
 *       name: { type: 'string', description: 'Name of the costume to create' },
 *     },
 *     required: ['name'],
 *   },
 *   async execute(ctx, args) {
 *     const wing = ctx.getWing('my-wing');
 *     // ... do work
 *     return { success: true, result: { created: args.name } };
 *   },
 * };
 * ```
 */

import type { Wing } from '@minions/file-store';
import type { ToolResult } from './index';

/**
 * JSON Schema type for gadget arguments
 *
 * Follows the JSON Schema specification (subset used by MCP inputSchema).
 * Identical structure to MissionArgsSchema.
 */
export interface GadgetArgsSchema {
  type: 'object';
  properties: Record<string, GadgetPropertySchema>;
  required?: string[];
  description?: string;
}

/**
 * Schema for a single property in the gadget arguments
 */
export interface GadgetPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: GadgetPropertySchema;
  properties?: Record<string, GadgetPropertySchema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
}

/**
 * Context provided to gadgets at execution time
 *
 * Gadgets get a simpler context than missions: no minion history,
 * no event bus, no spawn capability. Just file system access.
 */
export interface GadgetContext {
  /** Look up a wing by name */
  getWing(wingName: string): Wing | undefined;
  /** Absolute path to the lair root */
  lairRoot: string;
}

/**
 * Result type for gadget execution
 *
 * Reuses the existing ToolResult type from the gadgets package.
 */
export type GadgetResult = ToolResult;

/**
 * Gadget definition with typed arguments
 *
 * A Gadget is a dynamically loaded function that executes without minion
 * context. Gadgets are loaded from `gadgets/` directories in costume closets
 * and registered as MCP tools on the cabinet server.
 *
 * @template TArgs - Type of the gadget arguments
 */
export interface Gadget<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique name identifying this gadget */
  name: string;

  /** Human-readable description of what this gadget does */
  description: string;

  /** JSON Schema for validating and documenting arguments */
  args: GadgetArgsSchema;

  /**
   * Execute the gadget
   *
   * @param ctx - Gadget context with file system access
   * @param args - Typed gadget arguments
   * @returns Result indicating success or failure
   */
  execute(ctx: GadgetContext, args: TArgs): Promise<GadgetResult>;
}

/**
 * Type guard to check if a value is a valid Gadget
 */
export function isGadget(value: unknown): value is Gadget {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.args === 'object' &&
    obj.args !== null &&
    typeof obj.execute === 'function'
  );
}
