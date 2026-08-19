import type { SelfHeal } from './types.js';
import { planTomlFormatHeal } from './planTomlFormat.js';

export type { SelfHeal } from './types.js';
export { runSelfHeals } from './runSelfHeals.js';

/**
 * Ordered registry of every self-heal that runs at cabinet startup. Add new
 * ones here; once a heal's condition can no longer fail in practice (every
 * lair anyone still opens has long since healed), delete its entry — there's
 * no ledger anywhere else to clean up.
 */
export const selfHeals: readonly SelfHeal[] = [planTomlFormatHeal];
