/**
 * Simple test mission - no external dependencies
 */
export const mission = {
  name: 'simple',
  description: 'A simple test mission',
  args: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'A test value' },
    },
    required: [],
  },
  run: async (ctx: { emit: (event: unknown) => void }, args: { value?: string }) => {
    ctx.emit({ type: 'log', level: 'info', message: `Simple: ${args.value ?? 'default'}` });
    return { result: args.value ?? 'default' };
  },
};
