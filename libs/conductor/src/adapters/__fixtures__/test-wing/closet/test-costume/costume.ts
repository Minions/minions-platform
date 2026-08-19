/**
 * Test costume for unit testing
 */
export const costume = {
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a test agent.',
  gadgets: [
    {
      name: 'test-tool',
      description: 'A test tool',
      input_schema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
    },
  ],
  skills: [],
  events: [],
  injectFacts: ['test', 'build'],
};
