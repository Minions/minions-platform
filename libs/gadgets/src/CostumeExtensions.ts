/**
 * CostumeExtensions - the tool surface a costume exposes through Cabinet.
 *
 * Parallel to Gadget (this file's sibling): a costume exposes its tools via
 * ONE exported factory function from a fixed entry-point file (`extensions.ts`
 * at the costume root, loaded the same file:// + dynamic import() way
 * ClosetGadgetLoader already loads `gadgets/*.ts`), returning a CostumeExtensions
 * value built from the *exact same* ActionGroupDef type built-in domains use
 * (mounted via MCPServer.mountActionGroup(def, endpoints, actionEndpoints)) —
 * not a parallel shape — plus any flat Gadgets for simple cases. Both action
 * groups AND flat gadgets can target multiple endpoints, same as built-ins can
 * (MCPServer.ts:165-171) — a gadget is not restricted to a single endpoint.
 *
 * Manifest decision: costume.json needs NO new field for this feature. The
 * fixed filename convention already says "load extensions from here" with
 * zero JSON. The one legitimate reason to add a manifest field would be an
 * explicit opt-in flag gating dynamic code execution (defense-in-depth) —
 * but this repo's existing gadgets/*.ts convention already dynamically
 * imports and executes costume-local TypeScript with no such opt-in, so
 * requiring one here alone would be inconsistent, not defense-in-depth.
 * If that changes for gadgets, it should change for extensions the same way,
 * as one shared decision — not bolted onto this feature alone.
 */

import type { ActionGroupDef } from '@minions/mcp-types';
import type { Gadget } from './Gadget';
import { isGadget } from './Gadget';

/**
 * Endpoints an ActionGroupDef can be mounted on by a costume.
 *
 * Deliberately excludes 'all' — that value is a cabinet-internal wildcard
 * used for stateless/unscoped sessions, never a real mount target a costume
 * author would declare.
 */
export type ExtensionEndpointName = 'henchery' | 'lair' | 'conductor' | 'throne';

/**
 * One ActionGroupDef plus the endpoints (and optional per-action overrides)
 * it should be mounted on. Field names/shapes mirror
 * MCPServer.mountActionGroup(def, endpoints, actionEndpoints)'s own
 * parameters so the loader can spread this directly into that call.
 */
export interface CostumeActionGroup {
  /** The action group definition — reused unchanged from @minions/mcp-types. */
  def: ActionGroupDef;
  /** Which endpoint(s) expose this action group as a tool. */
  endpoints: ExtensionEndpointName[];
  /**
   * Optional per-action endpoint restrictions, keyed by action name.
   * When present for an action, that action is only available on the
   * listed endpoints (must be a subset of `endpoints`). Omitted actions
   * inherit the group-level `endpoints`.
   */
  actionEndpoints?: Partial<Record<string, ExtensionEndpointName[]>>;
}

/**
 * One flat Gadget plus the endpoint(s) it should be mounted on. Parallel to
 * CostumeActionGroup — a gadget is just as capable of multi-endpoint mounting
 * as an action group is, matching how built-in tools work (any built-in tool
 * can be registered on any subset of endpoints via ENDPOINT_TOOL_SETS).
 */
export interface CostumeGadgetMount {
  /** The gadget definition. */
  gadget: Gadget;
  /** Which endpoint(s) expose this gadget as a tool. */
  endpoints: ExtensionEndpointName[];
}

/**
 * The full tool surface a costume exposes through Cabinet.
 * Returned by the costume's extensions entry-point factory.
 */
export interface CostumeExtensions {
  /** Zero or more ActionGroupDefs, each with their own endpoint targeting. */
  actionGroups?: CostumeActionGroup[];
  /** Zero or more flat Gadgets, each with their own endpoint targeting. */
  gadgets?: CostumeGadgetMount[];
}

/**
 * Signature a costume's extensions entry-point file must export:
 *
 * ```typescript
 * export function getExtensions(): CostumeExtensions {
 *   return { actionGroups: [{ def: myActionGroupDef, endpoints: ['henchery'] }] };
 * }
 * ```
 */
export type CostumeExtensionsFactory = () => CostumeExtensions;

const VALID_EXTENSION_ENDPOINTS = new Set<ExtensionEndpointName>(['henchery', 'lair', 'conductor', 'throne']);

function isExtensionEndpointName(value: unknown): value is ExtensionEndpointName {
  return typeof value === 'string' && VALID_EXTENSION_ENDPOINTS.has(value as ExtensionEndpointName);
}

function isActionGroupDefShape(value: unknown): value is ActionGroupDef {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.coreActions === 'object' &&
    obj.coreActions !== null
  );
}

/**
 * Type guard for a single CostumeActionGroup entry.
 */
export function isCostumeActionGroup(value: unknown): value is CostumeActionGroup {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (!isActionGroupDefShape(obj.def)) return false;
  if (!Array.isArray(obj.endpoints) || obj.endpoints.length === 0) return false;
  if (!obj.endpoints.every(isExtensionEndpointName)) return false;

  if (obj.actionEndpoints !== undefined) {
    if (typeof obj.actionEndpoints !== 'object' || obj.actionEndpoints === null) return false;
    for (const eps of Object.values(obj.actionEndpoints as Record<string, unknown>)) {
      if (eps === undefined) continue;
      if (!Array.isArray(eps) || !eps.every(isExtensionEndpointName)) return false;
    }
  }

  return true;
}

/**
 * Type guard for a single CostumeGadgetMount entry.
 */
export function isCostumeGadgetMount(value: unknown): value is CostumeGadgetMount {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (!isGadget(obj.gadget)) return false;
  if (!Array.isArray(obj.endpoints) || obj.endpoints.length === 0) return false;
  if (!obj.endpoints.every(isExtensionEndpointName)) return false;

  return true;
}

/**
 * Type guard to check if a value is a valid CostumeExtensions object.
 * Rejects malformed extensions so the loader can name the offending costume
 * in a clear error rather than failing deep inside dispatch.
 */
export function isCostumeExtensions(value: unknown): value is CostumeExtensions {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.actionGroups !== undefined) {
    if (!Array.isArray(obj.actionGroups)) return false;
    if (!obj.actionGroups.every(isCostumeActionGroup)) return false;
  }

  if (obj.gadgets !== undefined) {
    if (!Array.isArray(obj.gadgets)) return false;
    if (!obj.gadgets.every(isCostumeGadgetMount)) return false;
  }

  return true;
}
