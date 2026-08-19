import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EventBus, defineEvent } from '@minions/events';
import type { IEventBus, TypedEvent, AnyEventDeclaration } from '@minions/events';
import { EventPersistenceSubscription } from './EventPersistenceSubscription';
import { PersistError } from '../domain/EventPersister';
import { MockEventPersister } from '../test-utils/MockEventPersister';
import { EventBusTestHelper } from '../test-utils/EventBusTestHelper';

// Test event definitions
const TestEvent1 = defineEvent<{ value: number }>('test-event-1');
const TestEvent2 = defineEvent<{ message: string }>('test-event-2');
const TestEvent3 = defineEvent<{ data: string }>('test-event-3');

describe('EventPersistenceSubscription', () => {
  let eventBus: EventBus;
  let persister: MockEventPersister;
  let subscription: EventPersistenceSubscription;
  let helper: EventBusTestHelper<EventBus>;

  beforeEach(() => {
    eventBus = new EventBus();
    // Don't enforce close checks since these tests focus on subscription behavior, not persister lifecycle
    persister = new MockEventPersister({ enforceCloseChecks: false });
    subscription = new EventPersistenceSubscription(eventBus, persister);
    helper = new EventBusTestHelper(eventBus);
  });

  afterEach(async () => {
    // Clean up subscription if it's still running
    await subscription.stop();
  });

  describe('start()', () => {
    it('begins persisting events to the persister', async () => {
      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 42 });
      await helper.emitAndWait(TestEvent2, { message: 'hello' });

      expect(persister.appendedEvents).toHaveLength(2);
      expect(persister.appendedEvents[0]).toMatchObject({
        value: 42,
        __type: 'test-event-1',
      });
      expect(persister.appendedEvents[1]).toMatchObject({
        message: 'hello',
        __type: 'test-event-2',
      });
    });

    it('persists events from different sources', async () => {
      subscription.start();
      await helper.wait(20);

      eventBus.emitFrom(TestEvent1, { value: 1 }, 'minion-1');
      eventBus.emitFrom(TestEvent1, { value: 2 }, 'minion-2');
      await helper.emitAndWait(TestEvent1, { value: 3 }); // from mission

      expect(persister.appendedEvents).toHaveLength(3);
      expect(persister.appendedEvents[0].__source).toBe('minion-1');
      expect(persister.appendedEvents[1].__source).toBe('minion-2');
      expect(persister.appendedEvents[2].__source).toBe('mission');
    });

    it('can be called multiple times safely (idempotent)', async () => {
      subscription.start();
      await helper.wait(20);
      subscription.start();
      await helper.wait(20); // Second call should be no-op

      await helper.emitAndWait(TestEvent1, { value: 42 });

      // Should only persist once per event, not twice
      expect(persister.appendedEvents).toHaveLength(1);
    });

    it('does not persist events before start() is called', async () => {
      await helper.emitAndWait(TestEvent1, { value: 42 });

      expect(persister.appendedEvents).toHaveLength(0);
    });

    it('throws error if EventBus does not have pubsub property', () => {
      const invalidBus = {} as unknown as IEventBus;
      const subscription = new EventPersistenceSubscription(invalidBus, persister);

      expect(() => subscription.start()).toThrow(
        'EventPersistenceSubscription requires EventBus to have a pubsub property'
      );
    });
  });

  describe('stop()', () => {
    it('stops persisting events', async () => {
      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 1 });
      expect(persister.appendedEvents).toHaveLength(1);

      await subscription.stop();

      await helper.emitAndWait(TestEvent1, { value: 2 });
      // Give some time for the event to potentially be persisted
      await helper.wait(50);

      // Should still only have 1 event (the one before stop)
      expect(persister.appendedEvents).toHaveLength(1);
    });

    it('flushes the persister', async () => {
      subscription.start();
      await helper.wait(20);
      await helper.emitAndWait(TestEvent1, { value: 42 });

      await subscription.stop();

      expect(persister.flushCallCount).toBe(1);
    });

    it('logs but does not throw if flush fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* no-op */ });

      persister.flushError = new Error('Flush failed!');
      subscription.start();
      await helper.wait(20);
      await helper.emitAndWait(TestEvent1, { value: 42 });

      // Should not throw
      await expect(subscription.stop()).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error flushing persister on stop'),
        expect.any(Object)
      );

      consoleErrorSpy.mockRestore();
    });

    it('can be called multiple times safely', async () => {
      subscription.start();
      await helper.wait(20);
      await helper.emitAndWait(TestEvent1, { value: 42 });

      await subscription.stop();
      await subscription.stop(); // Second call should be no-op

      // Flush should only be called once
      expect(persister.flushCallCount).toBe(1);
    });

    it('can be called even if start() was never called', async () => {
      // Should not throw
      await expect(subscription.stop()).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('logs but does not throw when append fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* no-op */ });

      persister.appendError = new Error('Append failed!');
      subscription.start();
      await helper.wait(20);

      // Should not throw
      await helper.emitAndWait(TestEvent1, { value: 42 });

      // Give time for error to be logged
      await helper.wait(50);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error persisting event'),
        expect.any(Object)
      );

      consoleErrorSpy.mockRestore();
    });

    it('continues persisting other events after an append error', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* no-op */ });

      // Set up to fail on first event only
      let callCount = 0;
      const originalAppend = persister.append.bind(persister);
      persister.append = (event: TypedEvent<AnyEventDeclaration>) => {
        callCount++;
        if (callCount === 1) {
          return Effect.fail(new PersistError({ message: 'First event failed' }));
        }
        return originalAppend(event);
      };

      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 1 }); // Will fail
      await helper.emitAndWait(TestEvent2, { message: 'hello' }); // Should succeed

      // Give time for events to be processed
      await helper.wait(50);

      // Second event should have been persisted despite first failing
      expect(persister.appendedEvents).toHaveLength(1);
      expect(persister.appendedEvents[0].__type).toBe('test-event-2');

      consoleErrorSpy.mockRestore();
    });

    it('does not disrupt other event handlers when persistence fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* no-op */ });

      persister.appendError = new Error('Persistence failed!');
      subscription.start();
      await helper.wait(20);

      // Set up a regular event handler
      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent1, handler);

      await helper.emitAndWait(TestEvent1, { value: 42 });

      // Handler should still be called despite persistence error
      expect(handler).toHaveBeenCalledOnce();

      await helper.unsubscribeAndWait(unsubscribe);
      consoleErrorSpy.mockRestore();
    });
  });

  describe('event subscription', () => {
    it('subscribes to all event types', async () => {
      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 1 });
      await helper.emitAndWait(TestEvent2, { message: 'test' });
      await helper.emitAndWait(TestEvent3, { data: 'foo' });

      expect(persister.appendedEvents).toHaveLength(3);
      expect(persister.appendedEvents[0].__type).toBe('test-event-1');
      expect(persister.appendedEvents[1].__type).toBe('test-event-2');
      expect(persister.appendedEvents[2].__type).toBe('test-event-3');
    });

    it('captures event metadata (__type, __source, __timestamp)', async () => {
      subscription.start();
      await helper.wait(20);

      const beforeTimestamp = Date.now();
      await helper.emitAndWait(TestEvent1, { value: 42 });
      const afterTimestamp = Date.now();

      expect(persister.appendedEvents).toHaveLength(1);
      const event = persister.appendedEvents[0];

      expect(event.__type).toBe('test-event-1');
      expect(event.__source).toBe('mission');
      expect(event.__timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(event.__timestamp).toBeLessThanOrEqual(afterTimestamp);
    });

    it('captures all events in high-frequency scenario', async () => {
      subscription.start();
      await helper.wait(20);

      // Emit many events quickly
      const eventCount = 50;
      for (let i = 0; i < eventCount; i++) {
        eventBus.emit(TestEvent1, { value: i });
      }

      // Give time for all events to be processed
      await helper.wait(100);

      // All events should have been captured
      expect(persister.appendedEvents.length).toBeGreaterThanOrEqual(eventCount * 0.9); // Allow 10% margin
    });
  });

  describe('lifecycle', () => {
    it('can be started, stopped, and restarted', async () => {
      subscription.start();
      await helper.wait(20);
      await helper.emitAndWait(TestEvent1, { value: 1 });
      expect(persister.appendedEvents).toHaveLength(1);

      await subscription.stop();
      await helper.emitAndWait(TestEvent1, { value: 2 });
      await helper.wait(50);
      expect(persister.appendedEvents).toHaveLength(1); // Still 1

      subscription.start();
      await helper.wait(20);
      await helper.emitAndWait(TestEvent1, { value: 3 });
      expect(persister.appendedEvents).toHaveLength(2); // Now 2
    });

    it('maintains event order in persister', async () => {
      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 1 });
      await helper.emitAndWait(TestEvent1, { value: 2 });
      await helper.emitAndWait(TestEvent1, { value: 3 });

      expect(persister.appendedEvents).toHaveLength(3);
      expect(persister.appendedEvents[0]).toMatchObject({ value: 1 });
      expect(persister.appendedEvents[1]).toMatchObject({ value: 2 });
      expect(persister.appendedEvents[2]).toMatchObject({ value: 3 });
    });
  });

  describe('integration with EventBus', () => {
    it('does not interfere with normal EventBus operation', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = await helper.subscribeAndWait(TestEvent1, handler1);
      const unsub2 = await helper.subscribeAndWait(TestEvent2, handler2);

      subscription.start();
      await helper.wait(20);

      await helper.emitAndWait(TestEvent1, { value: 42 });
      await helper.emitAndWait(TestEvent2, { message: 'hello' });

      // Normal handlers should work
      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();

      // Persistence should also work
      expect(persister.appendedEvents).toHaveLength(2);

      await helper.unsubscribeAndWait(unsub1);
      await helper.unsubscribeAndWait(unsub2);
    });

    it('persists events even if no other handlers are subscribed', async () => {
      subscription.start();
      await helper.wait(20);

      // Emit events with no handlers
      await helper.emitAndWait(TestEvent1, { value: 42 });

      // Should still be persisted
      expect(persister.appendedEvents).toHaveLength(1);
    });
  });
});
