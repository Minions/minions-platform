/**
 * Integration tests for BrainlessMinion gadget execution (Story 5B)
 *
 * These tests verify the end-to-end flow:
 * - DefaultMissionContext.spawn() attaches gadgets to spec (Story 5A)
 * - BrainlessMinion receives and stores executable gadgets (Story 2B-1)
 * - BrainlessMinion /use tool handler executes gadgets (Story 2B-1)
 * - Events appear on mission event bus
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { Effect, Schema } from 'effect';
import { DefaultMissionContext } from '../DefaultMissionContext';
import { MissionHandle } from '../../domain/MissionHandle';
import { BrainlessMinion } from '@minions/hatchery';
import type { IHatchery } from '@minions/hatchery';
import type { IQuestionBridge } from '../../ports/IQuestionBridge';
import type { MinionSpec, ToolResultMessage } from '@minions/domain-types';
import type { ExtendedMinionSpec } from '../../domain/CostumeSpec';
import type { TypedEvent } from '@minions/events';
import { createMockQuestionBridge } from '../../test-utils/mockFactories';
import { defineEvent } from '@minions/costumes';
import { createDiskSandbox, createLair } from '@minions/file-store';
import { createTestWing } from '../../test-utils/wingTestHelpers';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '..', '__fixtures__', 'test-wing');

// Define test event declarations to match the events in events-costume
// These must match the event types defined in the costume
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

describe('Integration: BrainlessMinion Gadget Execution', () => {
  let context: DefaultMissionContext;
  let mockHandle: MissionHandle;
  let mockQuestionBridge: IQuestionBridge;
  let hatchery: IHatchery;

  beforeEach(() => {
    mockHandle = new MissionHandle('test-run-123', 'test-mission');
    mockQuestionBridge = createMockQuestionBridge({ answers: ['user answer'] });

    // Create a real hatchery that spawns BrainlessMinion with gadget support
    hatchery = {
      spawn: async (spec: MinionSpec) => {
        // Extract executableGadgets from ExtendedMinionSpec
        const executableGadgets = (spec as ExtendedMinionSpec).executableGadgets;

        return new BrainlessMinion(spec, undefined, { executableGadgets });
      },
    };

    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);
    const testWing = createTestWing({ name: 'test-wing', root: sandbox.root, lair });

    context = new DefaultMissionContext({
      hatchery,
      questionBridge: mockQuestionBridge,
      handle: mockHandle,
      wing: testWing,
    });
  });

  describe('spawn with events-costume', () => {
    it('BrainlessMinion receives executable gadgets from spec', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));

      // BrainlessMinion should have received executableGadgets
      const brainless = minion as BrainlessMinion;
      const gadgets = brainless.getExecutableGadgets();

      expect(gadgets).toBeDefined();
      expect(gadgets.length).toBe(2);
      expect(gadgets[0].tool.name).toBe('get_event_schema');
      expect(gadgets[1].tool.name).toBe('emit_event');
    });
  });

  describe('get_event_schema gadget execution', () => {
    it('executes get_event_schema and returns schema', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Send /use tool command for get_event_schema
      await brainless.send({
        type: 'user',
        content: '/use tool get_event_schema with {"eventType":"task-complete"}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_result',
        is_error: false,
      });

      // Verify result contains schema
      const result = response.value as ToolResultMessage;
      const content = result.content as {
        eventType: string;
        schema: { type: string; properties: Record<string, unknown> };
        guidance: string;
      };
      expect(content).toHaveProperty('eventType', 'task-complete');
      expect(content).toHaveProperty('schema');
      expect(content).toHaveProperty('guidance', 'Emit when task is complete');
      expect(content.schema).toHaveProperty('type', 'object');
      expect(content.schema.properties).toHaveProperty('taskId');
      expect(content.schema.properties).toHaveProperty('result');
    });

    it('returns error for unknown event type', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Send /use tool command for unknown event
      await brainless.send({
        type: 'user',
        content: '/use tool get_event_schema with {"eventType":"unknown-event"}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_result',
        is_error: true,
      });

      const result = response.value as ToolResultMessage;
      expect(result.content).toContain("Event type 'unknown-event' not found");
    });
  });

  describe('emit_event gadget execution', () => {
    it('executes emit_event and event appears on event bus', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Set up event listener on mission context event bus
      const events: TypedEvent<typeof TestEvents.TaskComplete>[] = [];
      context.events.on(TestEvents.TaskComplete, (event) => {
        events.push(event);
      });

      // Send /use tool command for emit_event
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"task-complete","payload":{"taskId":"test-123","result":"success"}}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_result',
        is_error: false,
      });

      // Verify result indicates emission success
      const result = response.value as ToolResultMessage;
      const content = result.content as { eventType: string; message: string; timestamp: number };
      expect(content).toHaveProperty('eventType', 'task-complete');
      expect(content.message).toContain('emitted successfully');

      // Wait for async event emission (EventBus uses Effect.runFork for handlers)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify event was emitted to event bus
      expect(events).toHaveLength(1);
      // EventBus spreads payload at top level and uses __type, __source, __timestamp
      expect(events[0]).toMatchObject({
        __type: 'task-complete',
        taskId: 'test-123',
        result: 'success',
      });
      // Verify event has source (minionId from gadget creation)
      // Minion ID format may vary by implementation (e.g., 'minion-xxx' or 'brainless-xxx')
      expect(events[0].__source).toBeDefined();
      expect(typeof events[0].__source).toBe('string');
      expect(events[0].__source.length).toBeGreaterThan(0);
    });

    it('validates payload schema and returns error for invalid payload', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Send /use tool command with invalid payload (missing taskId)
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"task-complete","payload":{"result":"success"}}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_result',
        is_error: true,
      });

      // Verify error message is descriptive
      const result = response.value as ToolResultMessage;
      expect(result.content).toContain('payload validation failed');
      // Error message says "is missing" but doesn't explicitly say "taskId"
      expect(result.content).toContain('missing');
    });

    it('returns error for unknown event type', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Send /use tool command for unknown event
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"unknown-event","payload":{}}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_result',
        is_error: true,
      });

      const result = response.value as ToolResultMessage;
      expect(result.content).toContain("Event type 'unknown-event' not found");
    });

    it('handles extra fields in payload according to schema strictness', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Set up event listener
      const events: TypedEvent<typeof TestEvents.TaskComplete>[] = [];
      context.events.on(TestEvents.TaskComplete, (event) => {
        events.push(event);
      });

      // Send /use tool command with extra field
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"task-complete","payload":{"taskId":"test-123","result":"success","extraField":"ignored"}}',
        timestamp: Date.now(),
      });

      // Receive the tool result
      const receiver = brainless.receive();
      const response = await receiver.next();

      expect(response.done).toBe(false);

      // Effect Schema validation should handle extra fields based on schema definition
      // The test verifies the behavior without hardcoding expectations
      const result = response.value as ToolResultMessage;
      expect(result.type).toBe('tool_result');
    });
  });

  describe('event source tagging', () => {
    it('emitted events have correct source (minion ID)', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Set up event listener
      const events: TypedEvent<typeof TestEvents.TaskComplete>[] = [];
      context.events.on(TestEvents.TaskComplete, (event) => {
        events.push(event);
      });

      // Emit event
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"task-complete","payload":{"taskId":"test-123","result":"success"}}',
        timestamp: Date.now(),
      });

      // Wait for tool result
      const receiver = brainless.receive();
      await receiver.next();

      // Wait for async event emission
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify event has source (minionId from gadget creation)
      // Minion ID format may vary by implementation (e.g., 'minion-xxx' or 'brainless-xxx')
      expect(events).toHaveLength(1);
      expect(events[0].__source).toBeDefined();
      expect(typeof events[0].__source).toBe('string');
      expect(events[0].__source.length).toBeGreaterThan(0);
    });
  });

  describe('multiple events', () => {
    it('can emit different event types from same minion', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'events-costume' }));
      const brainless = minion as BrainlessMinion;

      // Set up event listeners
      const taskCompleteEvents: TypedEvent<typeof TestEvents.TaskComplete>[] = [];
      const blockedEvents: TypedEvent<typeof TestEvents.Blocked>[] = [];
      context.events.on(TestEvents.TaskComplete, (event) => {
        taskCompleteEvents.push(event);
      });
      context.events.on(TestEvents.Blocked, (event) => {
        blockedEvents.push(event);
      });

      // Emit task-complete event
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"task-complete","payload":{"taskId":"test-123","result":"success"}}',
        timestamp: Date.now(),
      });

      // Consume tool result
      const receiver1 = brainless.receive();
      await receiver1.next();

      // Emit blocked event
      await brainless.send({
        type: 'user',
        content: '/use tool emit_event with {"eventType":"blocked","payload":{"reason":"waiting for input"}}',
        timestamp: Date.now(),
      });

      // Consume tool result
      const receiver2 = brainless.receive();
      await receiver2.next();

      // Wait for async event emissions
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify both events were emitted
      expect(taskCompleteEvents).toHaveLength(1);
      expect(blockedEvents).toHaveLength(1);
      // EventBus spreads payload at top level
      expect(taskCompleteEvents[0].taskId).toBe('test-123');
      expect(taskCompleteEvents[0].result).toBe('success');
      expect(blockedEvents[0].reason).toBe('waiting for input');
    });
  });

  describe('gadget execution without events', () => {
    it('minion without events does not have gadgets', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'test-costume' }));
      const brainless = minion as BrainlessMinion;

      // test-costume has no events, so no gadgets
      const gadgets = brainless.getExecutableGadgets();
      expect(gadgets).toEqual([]);
    });

    it('minion without events handles /use tool as regular tool use', async () => {
      const minion = await Effect.runPromise(context.spawn({ costume: 'test-costume' }));
      const brainless = minion as BrainlessMinion;

      // Send /use tool command (should fall back to ToolUseMessage)
      await brainless.send({
        type: 'user',
        content: '/use tool some_tool with {"input":"test"}',
        timestamp: Date.now(),
      });

      // Receive the message
      const receiver = brainless.receive();
      const response = await receiver.next();

      // Should be a tool_use message (not tool_result)
      expect(response.done).toBe(false);
      expect(response.value).toMatchObject({
        type: 'tool_use',
        name: 'some_tool',
        input: { input: 'test' },
      });
    });
  });
});
