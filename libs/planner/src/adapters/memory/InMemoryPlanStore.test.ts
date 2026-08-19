import { runPlanStoreContractTests } from '@minions/planner-types';
import { InMemoryPlanStore } from './InMemoryPlanStore.js';

runPlanStoreContractTests(
  'InMemoryPlanStore',
  async () => new InMemoryPlanStore(),
);
