/**
 * Invalid costume with event missing guidance
 */
import { defineEvent } from '@minions/costumes';
import { Schema } from 'effect';

const GoodEvent = defineEvent<{ data: string }>(
  'good-event',
  Schema.Struct({ data: Schema.String })
);

export const costume = {
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'Invalid costume',
  events: [
    {
      event: GoodEvent,
      guidance: '', // Empty guidance (invalid)
    },
  ],
};
