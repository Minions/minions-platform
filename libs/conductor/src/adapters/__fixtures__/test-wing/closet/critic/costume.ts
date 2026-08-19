import { createTestCostume } from '../costume-factory';

/**
 * Critic costume for orchestration testing
 *
 * Critic sees files plus structure facts only.
 * This simulates a code reviewer who needs to understand
 * the codebase structure but doesn't need build details.
 */
export const costume = createTestCostume(
  'critic',
  ['structure'] // Critic only needs structure facts
);
