/**
 * Costume Event Definition
 *
 * What event entrypoint files export. A CostumeEventDef wraps an
 * EventDeclaration (which includes the Effect Schema for payload
 * validation) so it can be referenced from costume.json via entrypoints.
 *
 * @example
 * ```typescript
 * // events/phase-changed.ts
 * // Import the event declaration from the appropriate package
 * export const event: CostumeEventDef = {
 *   declaration: PhaseChangedEvent,
 * };
 * ```
 */

import type { EventDeclaration } from '@minions/events';

/**
 * Event definition exported by costume event files
 */
export interface CostumeEventDef {
  declaration: EventDeclaration;
}

/**
 * Type guard for CostumeEventDef
 */
export function isCostumeEventDef(value: unknown): value is CostumeEventDef {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  // declaration must be an object with at least a 'type' property (EventDeclaration shape)
  if (typeof obj.declaration !== 'object' || obj.declaration === null) return false;
  const decl = obj.declaration as Record<string, unknown>;
  return typeof decl.type === 'string';
}
