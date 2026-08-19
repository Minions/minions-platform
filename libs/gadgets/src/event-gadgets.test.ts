/**
 * Tests for event gadget type definitions
 *
 * Validates that the Effect Schema definitions for event gadgets work
 * correctly and enforce proper validation rules.
 */

import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import {
  GetEventSchemaInput,
  GetEventSchemaResult,
  EmitEventInput,
  EmitEventResult,
} from './event-gadgets';

describe('Event Gadget Schemas', () => {
  describe('GetEventSchemaInput', () => {
    it('validates valid input', () => {
      const input = { eventType: 'test-passed' };
      const decoded = Schema.decodeUnknownSync(GetEventSchemaInput)(input);

      expect(decoded).toEqual({ eventType: 'test-passed' });
    });

    it('rejects input without eventType', () => {
      const input = {};

      expect(() => {
        Schema.decodeUnknownSync(GetEventSchemaInput)(input);
      }).toThrow();
    });

    it('rejects input with wrong eventType type', () => {
      const input = { eventType: 123 };

      expect(() => {
        Schema.decodeUnknownSync(GetEventSchemaInput)(input);
      }).toThrow();
    });

    it('accepts valid event type names', () => {
      const eventTypes = [
        'test-passed',
        'build-failed',
        'task-complete',
        'file-changed',
        'watch-started',
      ];

      eventTypes.forEach(eventType => {
        const decoded = Schema.decodeUnknownSync(GetEventSchemaInput)({ eventType });
        expect(decoded.eventType).toBe(eventType);
      });
    });
  });

  describe('GetEventSchemaResult', () => {
    it('validates valid output', () => {
      const output = {
        eventType: 'test-passed',
        schema: {
          type: 'object',
          properties: {
            testName: { type: 'string' },
            duration: { type: 'number' }
          },
          required: ['testName', 'duration']
        },
        guidance: 'Emit when a test finishes executing successfully'
      };

      const decoded = Schema.decodeUnknownSync(GetEventSchemaResult)(output);

      expect(decoded.eventType).toBe('test-passed');
      expect(decoded.schema).toEqual(output.schema);
      expect(decoded.guidance).toBe(output.guidance);
    });

    it('rejects output without eventType', () => {
      const output = {
        schema: { type: 'object' },
        guidance: 'Some guidance'
      };

      expect(() => {
        Schema.decodeUnknownSync(GetEventSchemaResult)(output);
      }).toThrow();
    });

    it('accepts output without schema (schema is Unknown type)', () => {
      // Schema.Unknown accepts undefined, so missing schema is valid
      const output = {
        eventType: 'test-event',
        schema: undefined,
        guidance: 'Some guidance'
      };

      const decoded = Schema.decodeUnknownSync(GetEventSchemaResult)(output);
      expect(decoded.schema).toBeUndefined();
    });

    it('rejects output without guidance', () => {
      const output = {
        eventType: 'test-event',
        schema: { type: 'object' }
      };

      expect(() => {
        Schema.decodeUnknownSync(GetEventSchemaResult)(output);
      }).toThrow();
    });

    it('accepts various schema formats', () => {
      const schemas = [
        // Simple object schema
        { type: 'object', properties: { name: { type: 'string' } } },
        // Schema with required fields
        { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        // Complex nested schema
        {
          type: 'object',
          properties: {
            test: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                results: { type: 'array', items: { type: 'string' } }
              }
            }
          }
        }
      ];

      schemas.forEach((schema, index) => {
        const output = {
          eventType: `test-event-${index}`,
          schema,
          guidance: 'Test guidance'
        };
        const decoded = Schema.decodeUnknownSync(GetEventSchemaResult)(output);
        expect(decoded.schema).toEqual(schema);
      });
    });
  });

  describe('EmitEventInput', () => {
    it('validates valid input', () => {
      const input = {
        eventType: 'test-passed',
        payload: { testName: 'should work', duration: 145 }
      };

      const decoded = Schema.decodeUnknownSync(EmitEventInput)(input);

      expect(decoded).toEqual(input);
    });

    it('rejects input without eventType', () => {
      const input = {
        payload: { data: 'test' }
      };

      expect(() => {
        Schema.decodeUnknownSync(EmitEventInput)(input);
      }).toThrow();
    });

    it('accepts input without payload (payload is Unknown type)', () => {
      // Schema.Unknown accepts undefined, so missing payload is valid
      const input = {
        eventType: 'test-event',
        payload: undefined
      };

      const decoded = Schema.decodeUnknownSync(EmitEventInput)(input);
      expect(decoded.payload).toBeUndefined();
    });

    it('accepts various payload types', () => {
      const payloads = [
        // Object payload
        { testName: 'test1', duration: 100 },
        // Nested object payload
        { test: { name: 'nested', results: ['pass', 'fail'] } },
        // Simple value payload
        'simple string',
        // Number payload
        42,
        // Array payload
        ['item1', 'item2'],
        // Null payload (valid for some events)
        null,
      ];

      payloads.forEach((payload, index) => {
        const input = {
          eventType: `test-event-${index}`,
          payload
        };
        const decoded = Schema.decodeUnknownSync(EmitEventInput)(input);
        expect(decoded.payload).toEqual(payload);
      });
    });
  });

  describe('EmitEventResult', () => {
    it('validates valid output', () => {
      const output = {
        eventType: 'test-passed',
        message: "Event 'test-passed' emitted successfully",
        timestamp: Date.now()
      };

      const decoded = Schema.decodeUnknownSync(EmitEventResult)(output);

      expect(decoded.eventType).toBe('test-passed');
      expect(decoded.message).toBe(output.message);
      expect(decoded.timestamp).toBe(output.timestamp);
    });

    it('rejects output without eventType', () => {
      const output = {
        message: 'Event emitted',
        timestamp: Date.now()
      };

      expect(() => {
        Schema.decodeUnknownSync(EmitEventResult)(output);
      }).toThrow();
    });

    it('rejects output without message', () => {
      const output = {
        eventType: 'test-event',
        timestamp: Date.now()
      };

      expect(() => {
        Schema.decodeUnknownSync(EmitEventResult)(output);
      }).toThrow();
    });

    it('rejects output without timestamp', () => {
      const output = {
        eventType: 'test-event',
        message: 'Event emitted'
      };

      expect(() => {
        Schema.decodeUnknownSync(EmitEventResult)(output);
      }).toThrow();
    });

    it('rejects output with non-number timestamp', () => {
      const output = {
        eventType: 'test-event',
        message: 'Event emitted',
        timestamp: '2024-01-01'
      };

      expect(() => {
        Schema.decodeUnknownSync(EmitEventResult)(output);
      }).toThrow();
    });

    it('accepts various confirmation messages', () => {
      const messages = [
        "Event 'test-passed' emitted successfully",
        'Event emitted',
        'Successfully emitted event test-failed with validation',
      ];

      messages.forEach((message, index) => {
        const output = {
          eventType: `test-event-${index}`,
          message,
          timestamp: Date.now()
        };
        const decoded = Schema.decodeUnknownSync(EmitEventResult)(output);
        expect(decoded.message).toBe(message);
      });
    });
  });

  describe('Type inference', () => {
    it('infers GetEventSchemaInput type correctly', () => {
      // This test validates TypeScript type inference
      const input: GetEventSchemaInput = {
        eventType: 'test-event'
      };

      expect(input.eventType).toBe('test-event');
    });

    it('infers GetEventSchemaResult type correctly', () => {
      const result: GetEventSchemaResult = {
        eventType: 'test-event',
        schema: { type: 'object' },
        guidance: 'Test guidance'
      };

      expect(result.eventType).toBe('test-event');
      expect(result.schema).toBeDefined();
      expect(result.guidance).toBe('Test guidance');
    });

    it('infers EmitEventInput type correctly', () => {
      const input: EmitEventInput = {
        eventType: 'test-event',
        payload: { data: 'test' }
      };

      expect(input.eventType).toBe('test-event');
      expect(input.payload).toEqual({ data: 'test' });
    });

    it('infers EmitEventResult type correctly', () => {
      const result: EmitEventResult = {
        eventType: 'test-event',
        message: 'Event emitted',
        timestamp: Date.now()
      };

      expect(result.eventType).toBe('test-event');
      expect(result.message).toBe('Event emitted');
      expect(result.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Schema validation error messages', () => {
    it('provides clear error for missing eventType in GetEventSchemaInput', () => {
      const input = {};

      try {
        Schema.decodeUnknownSync(GetEventSchemaInput)(input);
        expect.fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
        // Effect Schema errors contain details about missing fields
        expect(String(error)).toContain('eventType');
      }
    });

    it('provides clear error for wrong payload type in EmitEventInput', () => {
      const input = {
        eventType: 123, // Should be string
        payload: {}
      };

      try {
        Schema.decodeUnknownSync(EmitEventInput)(input);
        expect.fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
        // Effect Schema error messages contain "Expected string"
        expect(String(error)).toContain('Expected string');
      }
    });

    it('provides clear error for wrong timestamp type in EmitEventResult', () => {
      const output = {
        eventType: 'test-event',
        message: 'Event emitted',
        timestamp: 'not-a-number'
      };

      try {
        Schema.decodeUnknownSync(EmitEventResult)(output);
        expect.fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
        // Effect Schema error messages contain "Expected number"
        expect(String(error)).toContain('Expected number');
      }
    });
  });
});
