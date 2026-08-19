/**
 * Factory for creating test costume fixtures
 *
 * Reduces duplication across costume files by providing a standard
 * structure with only role-specific customization.
 */
export function createTestCostume(
  role: string,
  injectFacts: string[]
) {
  return {
    model: 'claude-sonnet-4-20250514',
    systemPrompt: `You are a ${role} agent.`,
    gadgets: [],
    skills: [],
    events: [],
    injectFacts,
  };
}
