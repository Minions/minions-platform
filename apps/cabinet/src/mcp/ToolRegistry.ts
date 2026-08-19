/**
 * Tool Registry for MCP SDK Server
 * Provides type-safe tool name validation and typing
 *
 * Built-in tools are defined here. Costume-provided tools (gadgets)
 * are discovered dynamically and registered separately.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPToolMap } from '@minions/mcp-types';
import { THRONE_TOOL_NAMES, LAIR_TOOL_NAMES, CONDUCTOR_TOOL_NAMES } from '@minions/mcp-types';

/**
 * All built-in tool names handled directly by the cabinet.
 * Gadget-provided tools are NOT listed here — they are discovered
 * from costumes and registered dynamically.
 */
export const TOOL_NAMES = [
  'lair_get_state',
  'wings',
  'archives',
  'minions',
  'missions',
  'quality_status',
  'review',
  'gsd_compute_frames',
  'experiments',
] as const satisfies readonly (keyof MCPToolMap)[];

/**
 * Union type of all built-in tool names.
 * Derived from the const array, not from MCPToolMap (which also
 * includes gadget-provided tools like demos_list).
 */
export type ToolName = typeof TOOL_NAMES[number];

/**
 * Type helper to extract tool definition from MCPToolMap
 */
export type TypedTool<T extends ToolName> = MCPToolMap[T];

/**
 * Type guard to check if a string is a known built-in tool name
 */
export function isKnownTool(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export type EndpointName = 'henchery' | 'lair' | 'conductor' | 'throne' | 'all';

export const ENDPOINT_TOOL_SETS: Record<Exclude<EndpointName, 'all'>, readonly ToolName[]> = {
  henchery: [
    'quality_status',
    'review',
    // ask, movement, and plan are action groups, mounted via mountActionGroup
  ],
  lair: LAIR_TOOL_NAMES,
  conductor: [
    'wings', 'minions', 'missions', 'experiments',
  ],
  throne: THRONE_TOOL_NAMES,
};

/**
 * Endpoint assignments for gadget-provided tools.
 * Gadgets not listed here default to 'henchery'.
 */
export const GADGET_ENDPOINTS: Partial<Record<string, Exclude<EndpointName, 'all'>>> = {
  demos_list: 'throne',
};

export function getToolsForEndpoint(endpoint: EndpointName, tools: Tool[], includeGadgets: boolean): Tool[] {
  if (endpoint === 'all') return tools;
  const allowed = new Set<string>(ENDPOINT_TOOL_SETS[endpoint]);
  return tools.filter(t => {
    const isBuiltIn = isKnownTool(t.name);
    if (isBuiltIn) return allowed.has(t.name);
    // Gadgets go to their assigned endpoint (default: henchery)
    const gadgetEndpoint = GADGET_ENDPOINTS[t.name] ?? 'henchery';
    return includeGadgets && endpoint === gadgetEndpoint;
  });
}

// Re-export for consumers who need the endpoint-specific tool name types
export { THRONE_TOOL_NAMES, LAIR_TOOL_NAMES, CONDUCTOR_TOOL_NAMES };
