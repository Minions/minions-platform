/**
 * Invalid costume with event missing schema
 */
import { defineEvent } from '@minions/costumes';

// Event without schema (invalid)
const BadEvent = defineEvent<{ data: string }>('bad-event');

export const costume = {
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'Invalid costume',
  events: [
    {
      event: BadEvent,
      guidance: 'This will fail validation',
    },
  ],
};
