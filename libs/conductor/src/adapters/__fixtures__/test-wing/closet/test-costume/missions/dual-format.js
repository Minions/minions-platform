/**
 * Dual-format mission - exists as both .js and .md to test deduplication
 */
import { Effect } from 'effect';

export const mission = {
  name: 'dual-format',
  description: 'Mission available in both JS and MD format',
  api: 'effect',
  args: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'Operation mode' },
    },
    required: [],
  },
  run(ctx, args) {
    return Effect.sync(() => {
      ctx.emit('log', { level: 'info', message: `Dual: ${args.mode ?? 'js'}` });
    });
  },
};
