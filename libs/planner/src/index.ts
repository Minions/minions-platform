// Re-exported for backward compatibility — new code that only needs the
// interfaces/types (no filesystem/git implementation) should depend on
// @minions/planner-types directly instead of this package.
export type { ItemType, PlanItem, SubtreeIndex, NodeId, IPlanStore } from '@minions/planner-types';
export { generateId, asNodeId, runPlanStoreContractTests } from '@minions/planner-types';

import type { IPlanStore } from '@minions/planner-types';
import type { Worktree, Directory } from '@minions/file-store';
import { InMemoryPlanStore } from './adapters/memory/index.js';
import { WorktreePlanStore } from './adapters/worktree/index.js';

/**
 * Creates an in-memory IPlanStore (for tests). Only the interface is
 * exposed — InMemoryPlanStore's concrete type never appears in a
 * consumer's types, so swapping the implementation later isn't a breaking
 * change for anyone who only imports this factory.
 */
export function createInMemoryPlanStore(): IPlanStore {
  return new InMemoryPlanStore();
}

/**
 * Creates a file-backed IPlanStore rooted at `planDir`. See
 * createInMemoryPlanStore() for why this returns IPlanStore rather than
 * the concrete WorktreePlanStore type.
 */
export function createWorktreePlanStore(planDir: Worktree | Directory): IPlanStore {
  return new WorktreePlanStore(planDir);
}

// Exposed for the .meta/plan/**/index.json -> content.toml + claims.toml
// self-heal (apps/cabinet/src/selfHeal/planTomlFormat.ts) — reuses the
// store's own (de)serialization and plan-dir resolution rather than
// duplicating the TOML format or the originPlanPath lookup.
export {
  serializeContent,
  serializeClaims,
  type ContentFields,
  type ClaimFields,
} from './adapters/worktree/planToml.js';

export { handlePlanTool } from './PlanTool.js';
export type { PlanToolResult } from './PlanTool.js';

export { createPlanActionGroup, resolvePlanDir, setQualityWatcherFactory } from './PlanActionGroup.js';
