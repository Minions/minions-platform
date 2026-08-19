/**
 * Greet test mission - no external dependencies
 */
import { Effect } from 'effect';

export const mission = {
  name: 'greet',
  description: 'A greeting test mission',
  api: 'effect' as const,
  args: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' },
    },
    required: ['name'],
  },
  run(ctx: { emit: (type: string, data?: Record<string, unknown>) => void }, args: { name: string }) {
    return Effect.sync(() => {
      ctx.emit('log', { level: 'info', message: `Hello, ${args.name}!` });
    });
  },
};
