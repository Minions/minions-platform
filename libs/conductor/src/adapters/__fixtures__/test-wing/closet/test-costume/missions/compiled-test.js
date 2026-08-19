/**
 * Compiled test mission - simulates a .js file from compiled TypeScript
 */
import { Effect } from 'effect';

export const mission = {
  name: 'compiled-test',
  description: 'A compiled JavaScript test mission',
  api: 'effect',
  args: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: [],
  },
  run(ctx, args) {
    return Effect.sync(() => {
      ctx.emit('log', { level: 'info', message: `Compiled: ${args.input ?? 'default'}` });
    });
  },
};
