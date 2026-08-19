import { createInMemorySandbox } from '@minions/file-store';
import { runPlanStoreContractTests } from '@minions/planner-types';
import { WorktreePlanStore } from './WorktreePlanStore.js';

// Verify that WorktreePlanStore also passes all contract tests when backed
// by a plain Directory (not a Worktree). This covers the use-case where the
// plan data lives inside an existing repo checkout, accessed via DiskSandbox.
runPlanStoreContractTests('WorktreePlanStore (Directory)', async () => {
  const sandbox = createInMemorySandbox();
  // sandbox.root is a Directory; create a subdirectory to use as the plan dir
  const planDir = await sandbox.root.createDirectory('plan');
  return new WorktreePlanStore(planDir);
});
