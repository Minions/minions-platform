import { describe, it, expect } from 'vitest';
import { defineEvent } from '@minions/events';
import type { TypedEvent } from '@minions/events';
import {
  serializeEvent,
  deserializeEvent,
  serializeEventToJsonLine,
  deserializeEventFromJsonLine,
  type SerializedEvent,
} from './EventSerialization';

describe('EventSerialization', () => {
  describe('SerializedEvent type', () => {
    it('has the required fields', () => {
      const serialized: SerializedEvent = {
        type: 'test-event',
        payload: { value: 123 },
        source: 'mission',
        timestamp: 1234567890,
      };

      expect(serialized).toHaveProperty('type');
      expect(serialized).toHaveProperty('payload');
      expect(serialized).toHaveProperty('source');
      expect(serialized).toHaveProperty('timestamp');
    });
  });

  describe('serializeEvent', () => {
    it('serializes a TypedEvent with payload fields', () => {
      const TestEvent = defineEvent<{ taskId: string; result: string }>('task-complete');

      const typedEvent: TypedEvent<typeof TestEvent> = {
        taskId: '123',
        result: 'success',
        __type: 'task-complete',
        __source: 'minion-abc',
        __timestamp: 1234567890,
      };

      const serialized = serializeEvent(typedEvent);

      expect(serialized).toEqual({
        type: 'task-complete',
        payload: {
          taskId: '123',
          result: 'success',
        },
        source: 'minion-abc',
        timestamp: 1234567890,
      });
    });

    it('serializes a TypedEvent with no payload fields', () => {
      const SimpleEvent = defineEvent<Record<string, never>>('simple-event');

      const typedEvent = {
        __type: 'simple-event',
        __source: 'mission',
        __timestamp: 9876543210,
      } as TypedEvent<typeof SimpleEvent>;

      const serialized = serializeEvent(typedEvent);

      expect(serialized).toEqual({
        type: 'simple-event',
        payload: {},
        source: 'mission',
        timestamp: 9876543210,
      });
    });

    it('serializes external event source correctly', () => {
      const TestEvent = defineEvent<{ state: string }>('test-state');

      const typedEvent: TypedEvent<typeof TestEvent> = {
        state: 'passing',
        __type: 'test-state',
        __source: 'external:test-watch',
        __timestamp: 1111111111,
      };

      const serialized = serializeEvent(typedEvent);

      expect(serialized.source).toBe('external:test-watch');
    });

    it('serializes nested payload correctly', () => {
      const ComplexEvent = defineEvent<{
        user: { id: string; name: string };
        metadata: { tags: string[] };
      }>('complex-event');

      const typedEvent: TypedEvent<typeof ComplexEvent> = {
        user: { id: 'user-1', name: 'Alice' },
        metadata: { tags: ['important', 'urgent'] },
        __type: 'complex-event',
        __source: 'minion-xyz',
        __timestamp: 5555555555,
      };

      const serialized = serializeEvent(typedEvent);

      expect(serialized.payload).toEqual({
        user: { id: 'user-1', name: 'Alice' },
        metadata: { tags: ['important', 'urgent'] },
      });
    });
  });

  describe('deserializeEvent', () => {
    it('deserializes a SerializedEvent to TypedEvent', () => {
      const serialized: SerializedEvent = {
        type: 'task-complete',
        payload: {
          taskId: '123',
          result: 'success',
        },
        source: 'minion-abc',
        timestamp: 1234567890,
      };

      const typedEvent = deserializeEvent(serialized);

      expect(typedEvent).toEqual({
        taskId: '123',
        result: 'success',
        __type: 'task-complete',
        __source: 'minion-abc',
        __timestamp: 1234567890,
      });
    });

    it('deserializes event with empty payload', () => {
      const serialized: SerializedEvent = {
        type: 'simple-event',
        payload: {},
        source: 'mission',
        timestamp: 9876543210,
      };

      const typedEvent = deserializeEvent(serialized);

      expect(typedEvent).toEqual({
        __type: 'simple-event',
        __source: 'mission',
        __timestamp: 9876543210,
      });
    });

    it('preserves external source identifier', () => {
      const serialized: SerializedEvent = {
        type: 'test-state',
        payload: { state: 'passing' },
        source: 'external:test-watch',
        timestamp: 1111111111,
      };

      const typedEvent = deserializeEvent(serialized);

      expect(typedEvent.__source).toBe('external:test-watch');
    });

    it('preserves nested payload structure', () => {
      const serialized: SerializedEvent = {
        type: 'complex-event',
        payload: {
          user: { id: 'user-1', name: 'Alice' },
          metadata: { tags: ['important', 'urgent'] },
        },
        source: 'minion-xyz',
        timestamp: 5555555555,
      };

      const typedEvent = deserializeEvent(serialized) as unknown as {
        user: { id: string; name: string };
        metadata: { tags: string[] };
      };

      expect(typedEvent.user).toEqual({ id: 'user-1', name: 'Alice' });
      expect(typedEvent.metadata).toEqual({ tags: ['important', 'urgent'] });
    });
  });

  describe('round-trip serialization', () => {
    it('correctly round-trips a simple event', () => {
      const TestEvent = defineEvent<{ value: number }>('test-event');

      const original: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'minion-123',
        __timestamp: 1000000000,
      };

      const serialized = serializeEvent(original);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(original);
    });

    it('correctly round-trips a complex event', () => {
      const ComplexEvent = defineEvent<{
        id: string;
        data: { count: number; items: string[] };
        flags: { active: boolean; verified: boolean };
      }>('complex-event');

      const original: TypedEvent<typeof ComplexEvent> = {
        id: 'evt-001',
        data: { count: 3, items: ['a', 'b', 'c'] },
        flags: { active: true, verified: false },
        __type: 'complex-event',
        __source: 'mission',
        __timestamp: 2000000000,
      };

      const serialized = serializeEvent(original);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(original);
    });

    it('correctly round-trips event with minion source', () => {
      const Event = defineEvent<{ status: string }>('status-changed');

      const original: TypedEvent<typeof Event> = {
        status: 'processing',
        __type: 'status-changed',
        __source: 'minion-developer-001',
        __timestamp: 3000000000,
      };

      const serialized = serializeEvent(original);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(original);
      expect(deserialized.__source).toBe('minion-developer-001');
    });

    it('correctly round-trips event with mission source', () => {
      const Event = defineEvent<{ message: string }>('progress-update');

      const original: TypedEvent<typeof Event> = {
        message: 'Step 1 complete',
        __type: 'progress-update',
        __source: 'mission',
        __timestamp: 4000000000,
      };

      const serialized = serializeEvent(original);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(original);
      expect(deserialized.__source).toBe('mission');
    });

    it('correctly round-trips event with external source', () => {
      const Event = defineEvent<{ exitCode: number }>('process-exited');

      const original: TypedEvent<typeof Event> = {
        exitCode: 0,
        __type: 'process-exited',
        __source: 'external:build-watch',
        __timestamp: 5000000000,
      };

      const serialized = serializeEvent(original);
      const deserialized = deserializeEvent(serialized);

      expect(deserialized).toEqual(original);
      expect(deserialized.__source).toBe('external:build-watch');
    });
  });

  describe('JSON Lines format', () => {
    it('serializes to single-line JSON string', () => {
      const TestEvent = defineEvent<{ value: string }>('test');

      const typedEvent: TypedEvent<typeof TestEvent> = {
        value: 'hello',
        __type: 'test',
        __source: 'mission',
        __timestamp: 1234567890,
      };

      const line = serializeEventToJsonLine(typedEvent);

      // Should be valid JSON
      expect(() => JSON.parse(line)).not.toThrow();

      // Should not contain newlines
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\r');
    });

    it('deserializes from JSON Lines string', () => {
      const line = '{"type":"task-done","payload":{"result":"success"},"source":"minion-abc","timestamp":9999999999}';

      const event = deserializeEventFromJsonLine(line);

      expect(event).toEqual({
        result: 'success',
        __type: 'task-done',
        __source: 'minion-abc',
        __timestamp: 9999999999,
      });
    });

    it('round-trips through JSON Lines format', () => {
      const TestEvent = defineEvent<{
        count: number;
        tags: string[];
      }>('multi-field-event');

      const original: TypedEvent<typeof TestEvent> = {
        count: 5,
        tags: ['alpha', 'beta'],
        __type: 'multi-field-event',
        __source: 'minion-test',
        __timestamp: 7777777777,
      };

      const line = serializeEventToJsonLine(original);
      const deserialized = deserializeEventFromJsonLine(line);

      expect(deserialized).toEqual(original);
    });

    it('handles multiple events as separate lines', () => {
      const Event1 = defineEvent<{ id: number }>('event-1');
      const Event2 = defineEvent<{ name: string }>('event-2');

      const event1: TypedEvent<typeof Event1> = {
        id: 1,
        __type: 'event-1',
        __source: 'mission',
        __timestamp: 1000,
      };

      const event2: TypedEvent<typeof Event2> = {
        name: 'test',
        __type: 'event-2',
        __source: 'mission',
        __timestamp: 2000,
      };

      const line1 = serializeEventToJsonLine(event1);
      const line2 = serializeEventToJsonLine(event2);

      // Each line is separate and valid
      const lines = [line1, line2].join('\n');
      const parsedLines = lines.split('\n');

      expect(parsedLines).toHaveLength(2);

      const deserialized1 = deserializeEventFromJsonLine(parsedLines[0]);
      const deserialized2 = deserializeEventFromJsonLine(parsedLines[1]);

      expect(deserialized1).toEqual(event1);
      expect(deserialized2).toEqual(event2);
    });

    it('throws on malformed JSON', () => {
      const invalidJson = '{"type":"incomplete"';

      expect(() => deserializeEventFromJsonLine(invalidJson)).toThrow(SyntaxError);
    });
  });

  describe('payload preservation', () => {
    it('preserves string values', () => {
      const Event = defineEvent<{ message: string }>('msg');
      const event: TypedEvent<typeof Event> = {
        message: 'Hello, world!',
        __type: 'msg',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.message).toBe('Hello, world!');
    });

    it('preserves number values', () => {
      const Event = defineEvent<{ value: number }>('num');
      const event: TypedEvent<typeof Event> = {
        value: 123.456,
        __type: 'num',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.value).toBe(123.456);
    });

    it('preserves boolean values', () => {
      const Event = defineEvent<{ flag: boolean }>('bool');
      const event: TypedEvent<typeof Event> = {
        flag: true,
        __type: 'bool',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.flag).toBe(true);
    });

    it('preserves null values', () => {
      const Event = defineEvent<{ value: string | null }>('nullable');
      const event: TypedEvent<typeof Event> = {
        value: null,
        __type: 'nullable',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.value).toBe(null);
    });

    it('preserves array values', () => {
      const Event = defineEvent<{ items: string[] }>('arr');
      const event: TypedEvent<typeof Event> = {
        items: ['a', 'b', 'c'],
        __type: 'arr',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.items).toEqual(['a', 'b', 'c']);
    });

    it('preserves nested object values', () => {
      const Event = defineEvent<{
        nested: { level1: { level2: { value: string } } };
      }>('deep');

      const event: TypedEvent<typeof Event> = {
        nested: { level1: { level2: { value: 'deep value' } } },
        __type: 'deep',
        __source: 'mission',
        __timestamp: 1000,
      };

      const line = serializeEventToJsonLine(event);
      const deserialized = deserializeEventFromJsonLine(line) as unknown as TypedEvent<typeof Event>;

      expect(deserialized.nested.level1.level2.value).toBe('deep value');
    });
  });
});
