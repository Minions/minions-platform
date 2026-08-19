/**
 * Costume with tool name collision (has reserved gadget name)
 */
import { defineEvent } from '@minions/costumes';
import { Schema } from 'effect';

const TestEvent = defineEvent<{ data: string }>(
  'test-event',
  Schema.Struct({ data: Schema.String })
);

export const costume = {
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'Costume with collision',
  gadgets: [
    {
      name: 'get_event_schema', // Reserved name - will cause collision
      description: 'This will collide with reserved gadget name',
      input_schema: {},
    },
  ],
  events: [
    {
      event: TestEvent,
      guidance: 'Test event',
    },
  ],
};
