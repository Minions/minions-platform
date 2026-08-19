import type { Sandbox } from '@minions/file-store';
import type { SelfHeal } from './types.js';

/**
 * Runs each self-heal's check, healing only the ones whose condition
 * doesn't already hold. A failing heal is logged and skipped — it must
 * never block cabinet startup — and gets another chance on the next
 * startup (or whenever this is invoked again), since there's no ledger
 * marking it "attempted."
 */
export async function runSelfHeals(lair: Sandbox, heals: readonly SelfHeal[]): Promise<void> {
  for (const heal of heals) {
    try {
      const healthy = await heal.check(lair);
      if (healthy) continue;
      console.log(`[self-heal] ${heal.id}: healing — ${heal.description}`);
      await heal.heal(lair);
    } catch (err) {
      console.error(`[self-heal] ${heal.id} failed (continuing startup):`, err instanceof Error ? err.message : err);
    }
  }
}
