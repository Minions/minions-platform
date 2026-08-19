/**
 * Greet test mission - no external dependencies
 */
export const mission = {
  name: 'greet',
  description: 'A greeting test mission',
  args: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' },
    },
    required: ['name'],
  },
  run: async (ctx: { emit: (event: unknown) => void }, args: { name: string }) => {
    ctx.emit({ type: 'log', level: 'info', message: `Hello, ${args.name}!` });
    return { greeting: `Hello, ${args.name}!` };
  },
};
