import { createTestCostume } from '../costume-factory';

/**
 * Planner costume for orchestration testing
 *
 * Planner sees only files (PRD, plan) but no facts.
 * This simulates a planner who creates implementation plans
 * based on requirements without needing build/test details.
 */
export const costume = createTestCostume(
  'planner',
  [] // No facts - planner only needs files
);
