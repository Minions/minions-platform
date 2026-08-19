import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { defineEvent } from '@minions/events';
import type { TypedEvent } from '@minions/events';
import { PersistError } from './EventPersister';
import { MockEventPersister } from '../test-utils/MockEventPersister';

describe('EventPersister', () => {
  describe('PersistError', () => {
    it('creates error with message', () => {
      const error = new PersistError({ message: 'Failed to write' });

      expect(error.message).toBe('Failed to write');
      expect(error._tag).toBe('PersistError');
    });

    it('creates error with message and cause', () => {
      const cause = new Error('Original error');
      const error = new PersistError({
        message: 'Failed to write',
        cause,
      });

      expect(error.message).toBe('Failed to write');
      expect(error.cause).toBe(cause);
    });
  });

  describe('IEventPersister interface', () => {
    const TestEvent = defineEvent<{ value: number }>('test-event');

    it('appends events successfully', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      const appendEffect = persister.append(event);
      await Effect.runPromise(appendEffect);

      const loadEffect = persister.load();
      const events = await Effect.runPromise(loadEffect);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'test-event',
        payload: { value: 42 },
        source: 'mission',
        timestamp: 1000,
      });
    });

    it('appends multiple events in order', async () => {
      const persister = new MockEventPersister();

      const event1: TypedEvent<typeof TestEvent> = {
        value: 1,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      const event2: TypedEvent<typeof TestEvent> = {
        value: 2,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 2000,
      };

      await Effect.runPromise(persister.append(event1));
      await Effect.runPromise(persister.append(event2));

      const events = await Effect.runPromise(persister.load());

      expect(events).toHaveLength(2);
      expect(events[0].payload.value).toBe(1);
      expect(events[1].payload.value).toBe(2);
    });

    it('flushes successfully', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      await Effect.runPromise(persister.append(event));
      await Effect.runPromise(persister.flush());

      const events = await Effect.runPromise(persister.load());
      expect(events).toHaveLength(1);
    });

    it('loads empty array when no events exist', async () => {
      const persister = new MockEventPersister();

      const events = await Effect.runPromise(persister.load());

      expect(events).toEqual([]);
    });

    it('exists returns false when no events', async () => {
      const persister = new MockEventPersister();

      const exists = await Effect.runPromise(persister.exists());

      expect(exists).toBe(false);
    });

    it('exists returns true when events exist', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      await Effect.runPromise(persister.append(event));

      const exists = await Effect.runPromise(persister.exists());

      expect(exists).toBe(true);
    });

    it('count returns 0 when no events', async () => {
      const persister = new MockEventPersister();

      const count = await Effect.runPromise(persister.count());

      expect(count).toBe(0);
    });

    it('count returns correct number of events', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      await Effect.runPromise(persister.append(event));
      await Effect.runPromise(persister.append(event));
      await Effect.runPromise(persister.append(event));

      const count = await Effect.runPromise(persister.count());

      expect(count).toBe(3);
    });

    it('clear removes all events', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof TestEvent> = {
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      await Effect.runPromise(persister.append(event));
      await Effect.runPromise(persister.append(event));

      await Effect.runPromise(persister.clear());

      const count = await Effect.runPromise(persister.count());
      const exists = await Effect.runPromise(persister.exists());
      const events = await Effect.runPromise(persister.load());

      expect(count).toBe(0);
      expect(exists).toBe(false);
      expect(events).toEqual([]);
    });

    it('close releases resources', async () => {
      const persister = new MockEventPersister();

      await Effect.runPromise(persister.close());

      // Operations after close should fail
      const appendEffect = persister.append({
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      } as TypedEvent<typeof TestEvent>);

      await expect(Effect.runPromise(appendEffect)).rejects.toThrow();
    });

    it('close is idempotent', async () => {
      const persister = new MockEventPersister();

      await Effect.runPromise(persister.close());
      await Effect.runPromise(persister.close());
      await Effect.runPromise(persister.close());

      // Should not throw
    });

    it('composes operations with Effect.gen', async () => {
      const persister = new MockEventPersister();

      const event1: TypedEvent<typeof TestEvent> = {
        value: 1,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      const event2: TypedEvent<typeof TestEvent> = {
        value: 2,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 2000,
      };

      const program = Effect.gen(function* () {
        yield* persister.append(event1);
        yield* persister.append(event2);
        yield* persister.flush();

        const count = yield* persister.count();
        const exists = yield* persister.exists();
        const events = yield* persister.load();

        return { count, exists, events };
      });

      const result = await Effect.runPromise(program);

      expect(result.count).toBe(2);
      expect(result.exists).toBe(true);
      expect(result.events).toHaveLength(2);
    });

    it('handles errors using Effect.catchAll', async () => {
      const persister = new MockEventPersister();

      await Effect.runPromise(persister.close());

      const program = persister.append({
        value: 42,
        __type: 'test-event',
        __source: 'mission',
        __timestamp: 1000,
      } as TypedEvent<typeof TestEvent>).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            recovered: true,
            message: error.message,
          })
        )
      );

      const result = await Effect.runPromise(program);

      expect(result).toEqual({
        recovered: true,
        message: 'Persister is closed',
      });
    });

    it('preserves event metadata through append and load', async () => {
      const persister = new MockEventPersister();

      const ComplexEvent = defineEvent<{
        user: { id: string; name: string };
        metadata: { tags: string[] };
      }>('complex-event');

      const event: TypedEvent<typeof ComplexEvent> = {
        user: { id: 'user-1', name: 'Alice' },
        metadata: { tags: ['important', 'urgent'] },
        __type: 'complex-event',
        __source: 'minion-xyz',
        __timestamp: 5555555555,
      };

      await Effect.runPromise(persister.append(event));

      const events = await Effect.runPromise(persister.load());

      expect(events[0]).toEqual({
        type: 'complex-event',
        payload: {
          user: { id: 'user-1', name: 'Alice' },
          metadata: { tags: ['important', 'urgent'] },
        },
        source: 'minion-xyz',
        timestamp: 5555555555,
      });
    });
  });

  describe('resume and fresh start workflow', () => {
    const WorkflowEvent = defineEvent<{ value: number }>('workflow-event');

    it('supports checking for existing events before starting', async () => {
      const persister = new MockEventPersister();

      // Fresh start - no events exist
      const existsBefore = await Effect.runPromise(persister.exists());
      expect(existsBefore).toBe(false);

      // Add some events
      const event: TypedEvent<typeof WorkflowEvent> = {
        value: 42,
        __type: 'workflow-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      await Effect.runPromise(persister.append(event));

      // Now events exist - can resume
      const existsAfter = await Effect.runPromise(persister.exists());
      expect(existsAfter).toBe(true);
    });

    it('supports count-based progress tracking', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof WorkflowEvent> = {
        value: 42,
        __type: 'workflow-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      // Track progress through event count
      expect(await Effect.runPromise(persister.count())).toBe(0);

      await Effect.runPromise(persister.append(event));
      expect(await Effect.runPromise(persister.count())).toBe(1);

      await Effect.runPromise(persister.append(event));
      expect(await Effect.runPromise(persister.count())).toBe(2);

      await Effect.runPromise(persister.append(event));
      expect(await Effect.runPromise(persister.count())).toBe(3);
    });

    it('supports fresh start with clear', async () => {
      const persister = new MockEventPersister();

      const event: TypedEvent<typeof WorkflowEvent> = {
        value: 42,
        __type: 'workflow-event',
        __source: 'mission',
        __timestamp: 1000,
      };

      // Add some events
      await Effect.runPromise(persister.append(event));
      await Effect.runPromise(persister.append(event));

      // Verify events exist
      expect(await Effect.runPromise(persister.exists())).toBe(true);
      expect(await Effect.runPromise(persister.count())).toBe(2);

      // Clear for fresh start
      await Effect.runPromise(persister.clear());

      // Verify fresh state
      expect(await Effect.runPromise(persister.exists())).toBe(false);
      expect(await Effect.runPromise(persister.count())).toBe(0);
      expect(await Effect.runPromise(persister.load())).toEqual([]);
    });
  });
});
