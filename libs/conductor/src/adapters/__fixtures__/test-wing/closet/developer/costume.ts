import { createTestCostume } from '../costume-factory';

/**
 * Developer costume for orchestration testing
 *
 * Developer sees files plus build and structure facts.
 * This simulates a developer who needs to know how to build
 * the project and understand its structure.
 */
export const costume = createTestCostume(
  'developer',
  ['build', 'structure'] // Developer needs build/structure facts
);
