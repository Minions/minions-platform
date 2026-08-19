/**
 * Get Event Schema Gadget Tests
 *
 * Tests the executeGetEventSchema function that powers the get_event_schema
 * gadget. Covers all success and error cases.
 */

import { describe, it, expect } from 'vitest';
import { Effect, Schema } from 'effect';
import { executeGetEventSchema } from '../getEventSchema';
import { defineEvent } from '@minions/costumes';
import type { Costume, CostumeEvent } from '@minions/costumes';
import { TestEvents, TestCostumes, createTestCostume } from './test-helpers';

describe('executeGetEventSchema', () => {
  // Use shared test events from test-helpers
  const { TestPassed: TestEvent, BuildFailed: BuildFailedEvent, NoSchema: EventWithoutSchema } = TestEvents;

  describe('successful schema retrieval', () => {
    it('should return success with schema and guidance for valid event type', () => {
      const costume = createTestCostume({
        events: [
          {
            event: TestEvent,
            guidance: 'Emit when a test finishes executing successfully',
          },
        ],
      });

      const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
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
            required: expect.arrayContaining(['testName', 'duration']),
          }),
          guidance: 'Emit when a test finishes executing successfully',
        },
      });
    });

    it('should return correct schema for different event types', () => {
      const costume = createTestCostume({
        events: [
          {
            event: TestEvent,
            guidance: 'Test guidance',
          },
          {
            event: BuildFailedEvent,
            guidance: 'Build guidance',
          },
        ],
      });

      const result1 = executeGetEventSchema(costume, { eventType: 'test-passed' });
      const toolResult1 = Effect.runSync(result1);

      const result2 = executeGetEventSchema(costume, { eventType: 'build-failed' });
      const toolResult2 = Effect.runSync(result2);

      // Both should succeed with different schemas
      expect(toolResult1.success).toBe(true);
      expect(toolResult2.success).toBe(true);

      if (toolResult1.success && toolResult2.success) {
        const result1 = toolResult1.result as { eventType: string; schema: unknown };
        const result2 = toolResult2.result as { eventType: string; schema: unknown };
        expect(result1.eventType).toBe('test-passed');
        expect(result2.eventType).toBe('build-failed');
        expect(result1.schema).not.toEqual(result2.schema);
      }
    });

    it('should handle complex nested schemas', () => {
      const ComplexEvent = TestEvents.Complex;

      const costume = createTestCostume({
        events: [
          {
            event: ComplexEvent,
            guidance: 'Emit when test suite completes',
          },
        ],
      });

      const result = executeGetEventSchema(costume, { eventType: 'complex-event' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toMatchObject({
        success: true,
        result: {
          eventType: 'complex-event',
          schema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              metadata: expect.objectContaining({
                type: 'object',
              }),
              results: expect.objectContaining({
                type: 'array',
              }),
            }),
          }),
          guidance: 'Emit when test suite completes',
        },
      });
    });
  });

  describe('error cases', () => {
    it('should return failure when costume has no events defined', () => {
      const costume = TestCostumes.withUndefinedEvents();

      const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error: 'No events are defined in this costume. Cannot query event schema.',
      });
    });

    it('should return failure when costume has empty events array', () => {
      const costume = TestCostumes.withNoEvents();

      const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error: 'No events are defined in this costume. Cannot query event schema.',
      });
    });

    it('should return failure with available events when event type not found', () => {
      const costume = TestCostumes.withMultipleEvents();

      const result = executeGetEventSchema(costume, { eventType: 'nonexistent-event' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error:
          "Event type 'nonexistent-event' not found in costume. Available events: test-passed, build-failed",
      });
    });

    it('should return failure when event exists but has no schema', () => {
      const costume = createTestCostume({
        events: [
          {
            event: EventWithoutSchema,
            guidance: 'Event guidance',
          },
        ],
      });

      const result = executeGetEventSchema(costume, { eventType: 'no-schema-event' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toEqual({
        success: false,
        error:
          "Event type 'no-schema-event' exists but has no schema defined. Cannot provide schema information.",
      });
    });

    it('should list all available events when one is not found', () => {
      const Event1 = defineEvent<{ a: string }>('event-1', Schema.Struct({ a: Schema.String }));
      const Event2 = defineEvent<{ b: number }>('event-2', Schema.Struct({ b: Schema.Number }));
      const Event3 = defineEvent<{ c: boolean }>(
        'event-3',
        Schema.Struct({ c: Schema.Boolean })
      );

      const costume: Costume = {
        model: 'test-model',
        events: [
          { event: Event1 as unknown as CostumeEvent['event'], guidance: 'G1' },
          { event: Event2 as unknown as CostumeEvent['event'], guidance: 'G2' },
          { event: Event3 as unknown as CostumeEvent['event'], guidance: 'G3' },
        ],
      };

      const result = executeGetEventSchema(costume, { eventType: 'event-4' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toMatchObject({
        success: false,
        error: expect.stringContaining('event-1, event-2, event-3'),
      });
    });
  });

  describe('Effect handling', () => {
    it('should return Effect that can be composed', () => {
      const costume = TestCostumes.withTestEvent();

      const effect = executeGetEventSchema(costume, { eventType: 'test-passed' });

      // Should be composable with other Effects
      const composedEffect = Effect.map(effect, (toolResult) => {
        if (toolResult.success) {
          return `Found schema for ${(toolResult.result as { eventType: string }).eventType}`;
        }
        return 'Error';
      });

      const result = Effect.runSync(composedEffect);
      expect(result).toBe('Found schema for test-passed');
    });

    it('should never fail (returns success: false instead)', () => {
      const costume = TestCostumes.withNoEvents();

      const effect = executeGetEventSchema(costume, { eventType: 'any-event' });

      // Should not throw, should return success: false
      expect(() => Effect.runSync(effect)).not.toThrow();

      const result = Effect.runSync(effect);
      expect(result.success).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle event with empty guidance string', () => {
      const costume = createTestCostume({
        events: [
          {
            event: TestEvent,
            guidance: '',
          },
        ],
      });

      const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toMatchObject({
        success: true,
        result: {
          eventType: 'test-passed',
          guidance: '',
        },
      });
    });

    it('should handle single event in costume', () => {
      const costume = TestCostumes.withTestEvent();

      const result = executeGetEventSchema(costume, { eventType: 'test-passed' });
      const toolResult = Effect.runSync(result);

      expect(toolResult.success).toBe(true);
    });

    it('should handle many events in costume', () => {
      const events = Array.from({ length: 50 }, (_, i) => ({
        event: defineEvent<{ index: number }>(
          `event-${i}`,
          Schema.Struct({ index: Schema.Number })
        ),
        guidance: `Guidance ${i}`,
      }));

      const costume = createTestCostume({ events });

      const result = executeGetEventSchema(costume, { eventType: 'event-25' });
      const toolResult = Effect.runSync(result);

      expect(toolResult).toMatchObject({
        success: true,
        result: {
          eventType: 'event-25',
          guidance: 'Guidance 25',
        },
      });
    });
  });
});
