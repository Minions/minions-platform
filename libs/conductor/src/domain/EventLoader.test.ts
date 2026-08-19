import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import type { IEventPersister } from './EventPersister';
import { PersistError } from './EventPersister';
import { loadEvents } from './EventLoader';
import { createTestEvent } from '../test-utils/event-helpers';
import { MockEventPersister } from '../test-utils/MockEventPersister';
import { serializeEvent } from './EventSerialization';

describe('EventLoader', () => {
  describe('loadEvents', () => {
    it('returns empty array when no events exist', async () => {
      const persister = new MockEventPersister();

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toEqual([]);
    });

    it('loads single event correctly', async () => {
      const persister = new MockEventPersister();

      const event = createTestEvent('test-event', { value: 42 }, 'mission', 1000);
      const serialized = serializeEvent(event);
      persister.addSerializedEvents([serialized]);

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'test-event',
        payload: { value: 42 },
        source: 'mission',
        timestamp: 1000,
      });
    });

    it('loads multiple events in chronological order', async () => {
      const persister = new MockEventPersister();

      // Create events with different timestamps
      const event1 = createTestEvent('event-1', { step: 1 }, 'mission', 1000);
      const event2 = createTestEvent('event-2', { step: 2 }, 'mission', 2000);
      const event3 = createTestEvent('event-3', { step: 3 }, 'mission', 3000);

      const serialized = [
        serializeEvent(event1),
        serializeEvent(event2),
        serializeEvent(event3),
      ];
      persister.addSerializedEvents(serialized);

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toHaveLength(3);
      expect(events[0].timestamp).toBe(1000);
      expect(events[1].timestamp).toBe(2000);
      expect(events[2].timestamp).toBe(3000);
      expect(events[0].payload.step).toBe(1);
      expect(events[1].payload.step).toBe(2);
      expect(events[2].payload.step).toBe(3);
    });

    it('sorts events by timestamp even if persister returns them out of order', async () => {
      const persister = new MockEventPersister();

      // Create events and add them in non-chronological order
      const event1 = createTestEvent('event-1', { step: 1 }, 'mission', 3000);
      const event2 = createTestEvent('event-2', { step: 2 }, 'mission', 1000);
      const event3 = createTestEvent('event-3', { step: 3 }, 'mission', 2000);

      const serialized = [
        serializeEvent(event1),
        serializeEvent(event2),
        serializeEvent(event3),
      ];
      persister.addSerializedEvents(serialized);

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toHaveLength(3);
      // Should be sorted by timestamp
      expect(events[0].timestamp).toBe(1000);
      expect(events[0].payload.step).toBe(2);
      expect(events[1].timestamp).toBe(2000);
      expect(events[1].payload.step).toBe(3);
      expect(events[2].timestamp).toBe(3000);
      expect(events[2].payload.step).toBe(1);
    });

    it('preserves event data while sorting', async () => {
      const persister = new MockEventPersister();

      // Create events with complex payloads
      const event1 = createTestEvent(
        'story-started',
        { storyIndex: 1, title: 'First Story' },
        'mission',
        2000
      );
      const event2 = createTestEvent(
        'story-completed',
        { storyIndex: 1, status: 'success' },
        'mission',
        3000
      );
      const event3 = createTestEvent(
        'phase-changed',
        { phase: 'development', previousPhase: 'planning' },
        'mission',
        1000
      );

      // Add in random order
      const serialized = [
        serializeEvent(event1),
        serializeEvent(event2),
        serializeEvent(event3),
      ];
      persister.addSerializedEvents(serialized);

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toHaveLength(3);

      // Verify chronological order
      expect(events[0].type).toBe('phase-changed');
      expect(events[0].payload).toEqual({
        phase: 'development',
        previousPhase: 'planning',
      });

      expect(events[1].type).toBe('story-started');
      expect(events[1].payload).toEqual({
        storyIndex: 1,
        title: 'First Story',
      });

      expect(events[2].type).toBe('story-completed');
      expect(events[2].payload).toEqual({
        storyIndex: 1,
        status: 'success',
      });
    });

    it('handles events with same timestamp', async () => {
      const persister = new MockEventPersister();

      // Create multiple events with same timestamp
      const event1 = createTestEvent('event-1', { value: 1 }, 'mission', 1000);
      const event2 = createTestEvent('event-2', { value: 2 }, 'mission', 1000);
      const event3 = createTestEvent('event-3', { value: 3 }, 'mission', 1000);

      const serialized = [
        serializeEvent(event1),
        serializeEvent(event2),
        serializeEvent(event3),
      ];
      persister.addSerializedEvents(serialized);

      const events = await Effect.runPromise(loadEvents(persister));

      expect(events).toHaveLength(3);
      // All should have same timestamp
      expect(events[0].timestamp).toBe(1000);
      expect(events[1].timestamp).toBe(1000);
      expect(events[2].timestamp).toBe(1000);
      // Order is stable (maintains insertion order for same timestamps)
    });

    it('composes with other Effect operations', async () => {
      const persister = new MockEventPersister();

      const event1 = createTestEvent('event-1', { value: 1 }, 'mission', 1000);
      const event2 = createTestEvent('event-2', { value: 2 }, 'mission', 2000);

      const serialized = [serializeEvent(event1), serializeEvent(event2)];
      persister.addSerializedEvents(serialized);

      const program = Effect.gen(function* () {
        // Check if events exist before loading
        const exists = yield* persister.exists();
        if (!exists) {
          return [];
        }

        // Load events
        const events = yield* loadEvents(persister);

        // Filter to specific type
        const filtered = events.filter((e) => e.type === 'event-1');

        return filtered;
      });

      const result = await Effect.runPromise(program);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('event-1');
    });

    it('propagates PersistError from persister', async () => {
      // Create a persister that fails on load
      const failingPersister: IEventPersister = {
        append: () => Effect.succeed(undefined),
        flush: () => Effect.succeed(undefined),
        load: () =>
          Effect.fail(
            new PersistError({
              message: 'Failed to read event file',
              cause: new Error('File not found'),
            })
          ),
        exists: () => Effect.succeed(true),
        count: () => Effect.succeed(0),
        clear: () => Effect.succeed(undefined),
        close: () => Effect.succeed(undefined),
      };

      const loadEffect = loadEvents(failingPersister);

      await expect(Effect.runPromise(loadEffect)).rejects.toThrow();
    });
  });
});
