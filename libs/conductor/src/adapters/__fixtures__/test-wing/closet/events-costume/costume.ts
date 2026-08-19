/**
 * Test costume with events for testing gadget creation
 */
import { defineEvent } from '@minions/costumes';
import { Schema } from 'effect';

// Define test events with schemas
const TestEvents = {
  TaskComplete: defineEvent<{ taskId: string; result: string }>(
    'task-complete',
    Schema.Struct({
      taskId: Schema.String,
      result: Schema.String,
    })
  ),
  Blocked: defineEvent<{ reason: string }>(
    'blocked',
    Schema.Struct({ reason: Schema.String })
  ),
};

export const costume = {
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a test agent with events.',
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
  events: [
    {
      event: TestEvents.TaskComplete,
      guidance: 'Emit when task is complete',
    },
    {
      event: TestEvents.Blocked,
      guidance: 'Emit when blocked',
    },
  ],
  injectFacts: [],
};
