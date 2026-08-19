import type { MinionSpec } from '@minions/domain-types';
import type { ExecutableGadget } from '@minions/gadgets';
import type { MinionSpecWithExtensions } from '../../domain/MinionSpecExtensions';

/**
 * Extract executable gadgets from spec if present
 *
 * ExtendedMinionSpec includes executableGadgets but hatchery only knows
 * about base MinionSpec. This helper safely extracts the property.
 *
 * @param spec - The minion specification (may be ExtendedMinionSpec)
 * @returns Executable gadgets array if present, undefined otherwise
 */
export function extractExecutableGadgets(spec: MinionSpec): ExecutableGadget[] | undefined {
  return (spec as MinionSpecWithExtensions).executableGadgets;
}
