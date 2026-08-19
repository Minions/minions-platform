/**
 * Event Gadget Factory Tests
 *
 * Tests the factory function that creates executable event gadgets with
 * closures over mission context.
 */

import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { createEventGadgets } from '../factory';
import { EventBus } from '@minions/events';
import { TestCostumes, createTestCostume } from './test-helpers';

describe('createEventGadgets', () => {
  // Use shared test costume from test-helpers
  const testCostume = TestCostumes.withTestEvent();

  // Test event bus
  const testEventBus = new EventBus();
  const testMinionId = 'test-minion-123';
  const getMinionId = () => testMinionId;

  describe('factory function', () => {
    it('should create an array of two gadgets', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);

      expect(gadgets).toHaveLength(2);
      expect(gadgets[0]).toHaveProperty('tool');
      expect(gadgets[0]).toHaveProperty('execute');
      expect(gadgets[1]).toHaveProperty('tool');
      expect(gadgets[1]).toHaveProperty('execute');
    });

    it('should create get_event_schema gadget as first element', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const getEventSchemaGadget = gadgets[0];

      expect(getEventSchemaGadget.tool.name).toBe('get_event_schema');
      expect(getEventSchemaGadget.tool.description).toContain('Query the expected payload schema');
      expect(getEventSchemaGadget.tool.input_schema).toBeDefined();
    });

    it('should create emit_event gadget as second element', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const emitEventGadget = gadgets[1];

      expect(emitEventGadget.tool.name).toBe('emit_event');
      expect(emitEventGadget.tool.description).toContain('Emit a structured event');
      expect(emitEventGadget.tool.input_schema).toBeDefined();
    });
  });

  describe('get_event_schema gadget', () => {
    it('should have execute function that returns Effect<ToolResult, never, never>', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const getEventSchemaGadget = gadgets[0];

      const result = getEventSchemaGadget.execute({ eventType: 'test-event' });

      // Should be an Effect
      expect(result).toHaveProperty('_tag');
    });

    it('should return success ToolResult with schema and guidance', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const getEventSchemaGadget = gadgets[0];

      const result = getEventSchemaGadget.execute({ eventType: 'test-passed' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toMatchObject({
        success: true,
        result: {
          eventType: 'test-passed',
          schema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              testName: expect.any(Object),
              duration: expect.any(Object),
            }),
          }),
          guidance: 'Emit when test passes',
        },
      });
    });

    it('should capture costume in closure', () => {
      const costume1 = createTestCostume({ model: 'model-1' });
      const costume2 = createTestCostume({ model: 'model-2' });

      const gadgets1 = createEventGadgets(costume1, testEventBus, () => 'minion-1');
      const gadgets2 = createEventGadgets(costume2, testEventBus, () => 'minion-2');

      // Each gadget should be independent with its own closure
      expect(gadgets1[0]).not.toBe(gadgets2[0]);
    });
  });

  describe('emit_event gadget', () => {
    it('should have execute function that returns Effect<ToolResult, never, never>', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const emitEventGadget = gadgets[1];

      const result = emitEventGadget.execute({
        eventType: 'test-event',
        payload: { data: 'test' },
      });

      // Should be an Effect
      expect(result).toHaveProperty('_op');
    });

    it('should return success ToolResult after emitting event', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const emitEventGadget = gadgets[1];

      const result = emitEventGadget.execute({
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 100 },
      });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: true,
        result: {
          eventType: 'test-passed',
          message: expect.stringContaining('emitted successfully'),
          timestamp: expect.any(Number),
        },
      });
    });

    it('should capture eventBus and minionId in closure', () => {
      const eventBus1 = new EventBus();
      const eventBus2 = new EventBus();

      const gadgets1 = createEventGadgets(testCostume, eventBus1, () => 'minion-1');
      const gadgets2 = createEventGadgets(testCostume, eventBus2, () => 'minion-2');

      // Each gadget should be independent with its own closure
      expect(gadgets1[1]).not.toBe(gadgets2[1]);
    });
  });

  describe('closure isolation', () => {
    it('should create independent gadget instances for different minions', () => {
      const gadgets1 = createEventGadgets(testCostume, testEventBus, () => 'minion-1');
      const gadgets2 = createEventGadgets(testCostume, testEventBus, () => 'minion-2');

      // Tool definitions are identical
      expect(gadgets1[0].tool).toEqual(gadgets2[0].tool);
      expect(gadgets1[1].tool).toEqual(gadgets2[1].tool);

      // But execute functions are different instances (different closures)
      expect(gadgets1[0].execute).not.toBe(gadgets2[0].execute);
      expect(gadgets1[1].execute).not.toBe(gadgets2[1].execute);
    });
  });

  describe('tool input schemas', () => {
    it('should have valid JSON Schema for get_event_schema', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const schema = gadgets[0].tool.input_schema;

      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      if (!schema) throw new Error('expected get_event_schema input_schema to be defined');
      expect(schema.properties).toHaveProperty('eventType');
    });

    it('should have valid JSON Schema for emit_event', () => {
      const gadgets = createEventGadgets(testCostume, testEventBus, getMinionId);
      const schema = gadgets[1].tool.input_schema;

      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      if (!schema) throw new Error('expected emit_event input_schema to be defined');
      expect(schema.properties).toHaveProperty('eventType');
      expect(schema.properties).toHaveProperty('payload');
    });
  });
});
