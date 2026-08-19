import type { PlanItem } from '@minions/planner-types';

/**
 * Whether `id`'s subtree still justifies onPath=true after a claim release.
 *
 * A node keeps the goal path alive if it (or any descendant) is still
 * claimed by someone, OR has reached a demoable state (demoLink set).
 * Reaching demo before releasing a claim means "this is done enough to
 * hand off — anyone may pick it up from here," so the goal survives.
 * Releasing a node with no demoLink abandons that branch of the goal.
 */
export function subtreeKeepsGoalPath(id: string, items: Record<string, PlanItem>): boolean {
  const it = items[id];
  if (!it) return false;
  if (it.claimedBy || it.demoLink) return true;
  return it.children.some((c) => subtreeKeepsGoalPath(c, items));
}
