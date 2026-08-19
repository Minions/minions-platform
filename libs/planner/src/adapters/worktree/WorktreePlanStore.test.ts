import { createInMemorySandbox } from '@minions/file-store';
import { runPlanStoreContractTests } from '@minions/planner-types';
import { WorktreePlanStore } from './WorktreePlanStore.js';

runPlanStoreContractTests('WorktreePlanStore', async () => {
  const sandbox = createInMemorySandbox();
  const repo = await sandbox.initBare(sandbox.root, 'test.git');
  const planDir = await repo.createWorktree(sandbox.root, 'plan', 'main');
  return new WorktreePlanStore(planDir);
});
