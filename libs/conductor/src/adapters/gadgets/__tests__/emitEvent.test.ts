/**
 * Emit Event Gadget Tests
 *
 * Tests the executeEmitEvent function that powers the emit_event gadget.
 * Covers all success and error cases including validation errors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Effect, ParseResult, Schema } from 'effect';
import { executeEmitEvent } from '../emitEvent';
import { defineEvent } from '@minions/costumes';
import { TestEvents, TestCostumes, createTestCostume, TestEventBus } from './test-helpers';

describe('executeEmitEvent', () => {
  // Use shared test events from test-helpers
  const { NoSchema: EventWithoutSchema, Complex: ComplexEvent } = TestEvents;

  // Use TestEventBus instead of mocks
  let testEventBus: TestEventBus;

  beforeEach(() => {
    testEventBus = new TestEventBus();
  });

  describe('successful event emission', () => {
    it('should emit event with valid payload and return success', () => {
      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'auth-test', duration: 145 },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      // Verify success result
      expect(toolResult.success).toBe(true);
      if (toolResult.success) {
        const result = toolResult.result as { eventType: string; message: string; timestamp: number };
        expect(result.eventType).toBe('test-passed');
        expect(result.message).toBe("Event 'test-passed' emitted successfully");
        expect(result.timestamp).toBeGreaterThan(0);
      }

      // Verify event was emitted correctly
      expect(testEventBus.wasEventEmitted('test-passed')).toBe(true);
      const emitted = testEventBus.findEmittedEvent('test-passed');
      expect(emitted?.payload).toEqual({ testName: 'auth-test', duration: 145 });
      expect(emitted?.source).toBe('minion-123');
    });

    it('should emit event without schema validation', () => {
      const costume = createTestCostume({
        events: [
          {
            event: EventWithoutSchema,
            guidance: 'No schema event',
          },
        ],
      });

      const input = {
        eventType: 'no-schema-event',
        payload: { data: 'any-data', extra: 'fields-allowed' },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(true);
      expect(testEventBus.wasEventEmitted('no-schema-event')).toBe(true);
      const emitted = testEventBus.findEmittedEvent('no-schema-event');
      expect(emitted?.payload).toEqual({ data: 'any-data', extra: 'fields-allowed' });
    });

    it('should handle complex nested payloads', () => {
      const costume = createTestCostume({
        events: [
          {
            event: ComplexEvent,
            guidance: 'Complex event',
          },
        ],
      });

      const input = {
        eventType: 'complex-event',
        payload: {
          metadata: { timestamp: 1234567890, source: 'test-runner' },
          results: [
            { name: 'test-1', passed: true },
            { name: 'test-2', passed: false },
          ],
        },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(true);
      expect(testEventBus.wasEventEmitted('complex-event')).toBe(true);
      const emitted = testEventBus.findEmittedEvent('complex-event');
      expect(emitted?.payload).toEqual(input.payload);
    });

    it('should use correct minion ID as source', () => {
      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 100 },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-456', input);
      Effect.runSync(result);

      const emitted = testEventBus.findEmittedEvent('test-passed');
      expect(emitted?.source).toBe('minion-456');
    });
  });

  describe('validation errors', () => {
    it('should return failure when payload is missing required fields', () => {
      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test' }, // Missing duration
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(false);
      if (!toolResult.success) {
        expect(toolResult.error).toContain("Event 'test-passed' payload validation failed");
        expect(toolResult.error).toContain('is missing');
      }

      // Should not emit if validation fails
      expect(testEventBus.wasEventEmitted('test-passed')).toBe(false);
    });

    it('should return failure when payload has wrong field types', () => {
      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 'not-a-number' }, // Wrong type
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(false);
      if (!toolResult.success) {
        expect(toolResult.error).toContain("Event 'test-passed' payload validation failed");
        expect(toolResult.error).toContain('Expected number');
      }

      expect(testEventBus.wasEventEmitted('test-passed')).toBe(false);
    });

    it('should return failure with helpful message for nested validation errors', () => {
      const costume = createTestCostume({
        events: [{ event: ComplexEvent, guidance: 'Complex' }],
      });

      const input = {
        eventType: 'complex-event',
        payload: {
          metadata: { timestamp: 'not-a-number', source: 'test' }, // Wrong type in nested field
          results: [],
        },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(false);
      if (!toolResult.success) {
        expect(toolResult.error).toContain("Event 'complex-event' payload validation failed");
        expect(toolResult.error).toContain('get_event_schema');
      }

      expect(testEventBus.wasEventEmitted('complex-event')).toBe(false);
    });
  });

  describe('error cases', () => {
    it('should return failure when costume has no events defined', () => {
      const costume = TestCostumes.withUndefinedEvents();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 100 },
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error: 'No events are defined in this costume. Cannot emit event.',
      });

      expect(testEventBus.emittedEvents.length).toBe(0);
    });

    it('should return failure when costume has empty events array', () => {
      const costume = TestCostumes.withNoEvents();

      const input = {
        eventType: 'test-passed',
        payload: {},
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error: 'No events are defined in this costume. Cannot emit event.',
      });
    });

    it('should return failure with available events when event type not found', () => {
      const costume = TestCostumes.withMultipleEvents();

      const input = {
        eventType: 'nonexistent-event',
        payload: {},
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error:
          "Event type 'nonexistent-event' not found in costume. Available events: test-passed, build-failed",
      });

      expect(testEventBus.emittedEvents.length).toBe(0);
    });

    it('should handle emission failure gracefully', () => {
      // Create a test bus that fails on emit
      class FailingEventBus extends TestEventBus {
        override emitFromEffect(): Effect.Effect<void, ParseResult.ParseError, never> {
          return Effect.fail(new Error('Bus error')) as unknown as Effect.Effect<
            void,
            ParseResult.ParseError,
            never
          >;
        }
      }
      const failingEventBus = new FailingEventBus();

      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 100 },
      };

      const result = executeEmitEvent(costume, failingEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(false);
      if (!toolResult.success) {
        expect(toolResult.error).toContain("Failed to emit event 'test-passed'");
      }
    });
  });

  describe('Effect handling', () => {
    it('should return Effect that can be composed', () => {
      const costume = TestCostumes.withTestEvent();

      const input = {
        eventType: 'test-passed',
        payload: { testName: 'test', duration: 100 },
      };

      const effect = executeEmitEvent(costume, testEventBus, 'minion-123', input);

      // Should be composable with other Effects
      const composedEffect = Effect.map(effect, (toolResult) => {
        if (toolResult.success) {
          return `Emitted ${(toolResult.result as { eventType: string }).eventType}`;
        }
        return 'Error';
      });

      const result = Effect.runSync(composedEffect);
      expect(result).toBe('Emitted test-passed');
    });

    it('should never fail (returns success: false instead)', () => {
      const costume = TestCostumes.withNoEvents();

      const input = {
        eventType: 'any-event',
        payload: {},
      };

      const effect = executeEmitEvent(costume, testEventBus, 'minion-123', input);

      // Should not throw, should return success: false
      expect(() => Effect.runSync(effect)).not.toThrow();

      const result = Effect.runSync(effect);
      expect(result.success).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty payload for event without schema', () => {
      const EmptyEvent = defineEvent<void>('empty-event');

      const costume = createTestCostume({
        events: [{ event: EmptyEvent, guidance: 'Empty' }],
      });

      const input = {
        eventType: 'empty-event',
        payload: undefined,
      };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(true);
    });

    it('should handle multiple events with same structure', () => {
      const Event1 = defineEvent<{ value: number }>(
        'event-1',
        Schema.Struct({ value: Schema.Number })
      );
      const Event2 = defineEvent<{ value: number }>(
        'event-2',
        Schema.Struct({ value: Schema.Number })
      );

      const costume = createTestCostume({
        events: [
          { event: Event1, guidance: 'E1' },
          { event: Event2, guidance: 'E2' },
        ],
      });

      // Emit first event
      const result1 = executeEmitEvent(costume, testEventBus, 'minion-123', {
        eventType: 'event-1',
        payload: { value: 1 },
      });
      const toolResult1 = Effect.runSync(result1);

      // Emit second event
      const result2 = executeEmitEvent(costume, testEventBus, 'minion-123', {
        eventType: 'event-2',
        payload: { value: 2 },
      });
      const toolResult2 = Effect.runSync(result2);

      expect(toolResult1.success).toBe(true);
      expect(toolResult2.success).toBe(true);
      expect(testEventBus.emittedEvents.length).toBe(2);
    });

    it('should preserve payload data exactly as provided when valid', () => {
      const costume = TestCostumes.withTestEvent();

      const payload = { testName: 'my-test', duration: 250 };
      const input = { eventType: 'test-passed', payload };

      const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
      Effect.runSync(result);

      // Verify the exact payload was passed through
      const emitted = testEventBus.findEmittedEvent('test-passed');
      expect(emitted?.payload).toEqual(payload);
    });
  });
});
