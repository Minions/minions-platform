/**
 * Simple test mission - no external dependencies
 */
import { Effect } from 'effect';

export const mission = {
  name: 'simple',
  description: 'A simple test mission',
  api: 'effect' as const,
  args: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'A test value' },
    },
    required: [],
  },
  run(ctx: { emit: (type: string, data?: Record<string, unknown>) => void }, args: { value?: string }) {
    return Effect.sync(() => {
      ctx.emit('log', { level: 'info', message: `Simple: ${args.value ?? 'default'}` });
    });
  },
};
