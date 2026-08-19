import { describe, it, expect, vi } from 'vitest';
import { Effect, Scope, Exit, Schema, Cause } from 'effect';
import { EventBus, Src, defineEvent, defineChildEvent, WellKnownEvents, type PayloadOf } from '@minions/events';
import { EventBusTestHelper } from '../test-utils/EventBusTestHelper';

describe('EventBus', () => {
  describe('on() - subscribe to events', () => {
    it('receives events emitted via emit()', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ message: string }>('test-event');

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

      await helper.emitAndWait(TestEvent, { message: 'hello' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'hello',
          __type: 'test-event',
          __source: 'mission',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('receives events emitted via emitFrom()', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

      await helper.emitFromAndWait(TestEvent, { value: 42 }, 'minion-123');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 42,
          __type: 'test',
          __source: 'minion-123',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('handler receives fully typed event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TaskComplete = defineEvent<{ taskId: string; result: string }>(
        'task-complete'
      );

      const handler = vi.fn((event) => {
        // TypeScript autocomplete should work for these fields
        expect(event.taskId).toBe('task-1');
        expect(event.result).toBe('success');
        expect(event.__type).toBe('task-complete');
        expect(event.__source).toBe('mission');
        expect(event.__timestamp).toBeGreaterThan(0);
      });

      const unsubscribe = await helper.subscribeAndWait(TaskComplete, handler);

      await helper.emitAndWait(TaskComplete, { taskId: 'task-1', result: 'success' });

      expect(handler).toHaveBeenCalledOnce();

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('returns unsubscribe function', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

      await helper.emitAndWait(TestEvent, { value: 1 });

      expect(handler).toHaveBeenCalledOnce();

      await helper.unsubscribeAndWait(unsubscribe);

      bus.emit(TestEvent, { value: 2 });

      // Give time to verify no second call
      await helper.wait(10);

      expect(handler).toHaveBeenCalledOnce(); // Still only called once
    });

    it('multiple handlers can subscribe to same event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = bus.on(TestEvent, handler1);
      const unsub2 = await helper.subscribeAndWait(TestEvent, handler2);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();

      unsub1();
      await helper.unsubscribeAndWait(unsub2);
    });

    it('handlers for different events do not interfere', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const Event1 = defineEvent<{ a: string }>('event-1');
      const Event2 = defineEvent<{ b: number }>('event-2');

      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = bus.on(Event1, handler1);
      const unsub2 = await helper.subscribeAndWait(Event2, handler2);

      await helper.emitAndWait(Event1, { a: 'test' });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();

      await helper.emitAndWait(Event2, { b: 42 });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();

      unsub1();
      await helper.unsubscribeAndWait(unsub2);
    });
  });

  describe('once() - await single event', () => {
    it('resolves with the first matching event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const promise = helper.onceAndWait(TestEvent);
      await helper.wait();

      bus.emit(TestEvent, { value: 42 });

      const event = await promise;

      expect(event.value).toBe(42);
      expect(event.__type).toBe('test');
      expect(event.__source).toBe('mission');
    });

    it('resolves only once even if more events are emitted', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const promise = helper.onceAndWait(TestEvent);
      await helper.wait();

      bus.emit(TestEvent, { value: 1 });
      bus.emit(TestEvent, { value: 2 });

      const event = await promise;

      expect(event.value).toBe(1); // First event
    });
  });

  describe('Source filtering', () => {
    it('only receives events from the specified source', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const minion1 = { id: 'minion-1' };

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler, { from: minion1 });

      bus.emitFrom(TestEvent, { value: 1 }, 'minion-1');
      bus.emitFrom(TestEvent, { value: 2 }, 'minion-2');
      await helper.emitAndWait(TestEvent, { value: 3 });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ value: 1, __source: 'minion-1' })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('Src.AnyMinion receives events from any minion but not mission or external', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler, { from: Src.AnyMinion });

      bus.emitFrom(TestEvent, { value: 1 }, 'minion-1');
      bus.emitFrom(TestEvent, { value: 2 }, 'minion-2');
      bus.emit(TestEvent, { value: 3 }); // from mission
      await helper.emitFromAndWait(TestEvent, { value: 4 }, 'external:test');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ value: 1, __source: 'minion-1' })
      );
      expect(handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ value: 2, __source: 'minion-2' })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('Condition filtering', () => {
    it('only receives events matching the condition', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test');

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(TestEvent, handler, {
        condition: (event) => event.value > 10,
      });

      bus.emit(TestEvent, { value: 5 });
      bus.emit(TestEvent, { value: 15 });
      bus.emit(TestEvent, { value: 8 });
      await helper.emitAndWait(TestEvent, { value: 20 });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ value: 15 })
      );
      expect(handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ value: 20 })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('Hierarchical Events (Parent-Child)', () => {
    it('parent listener receives child event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler);

      await helper.emitAndWait(ChildEvent, { id: 'test', detail: 'extra' });

      expect(parentHandler).toHaveBeenCalledOnce();
      expect(parentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test',
          detail: 'extra',
          __type: 'child', // Type is the child type
          __source: 'mission',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('parent listener receives both parent and child events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler);

      bus.emit(ParentEvent, { id: 'parent-event' });
      await helper.emitAndWait(ChildEvent, { id: 'child-event', detail: 'extra' });

      expect(parentHandler).toHaveBeenCalledTimes(2);
      expect(parentHandler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 'parent-event',
          __type: 'parent',
        })
      );
      expect(parentHandler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: 'child-event',
          detail: 'extra',
          __type: 'child',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('child listener does not receive parent events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const childHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ChildEvent, childHandler);

      await helper.emitAndWait(ParentEvent, { id: 'parent-event' });

      expect(childHandler).not.toHaveBeenCalled();

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('parent listener receives multiple child events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const Child1 = defineChildEvent<typeof ParentEvent, { id: string; type1: string }>(
        ParentEvent,
        'child-1'
      );
      const Child2 = defineChildEvent<typeof ParentEvent, { id: string; type2: number }>(
        ParentEvent,
        'child-2'
      );

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler);

      bus.emit(Child1, { id: 'test1', type1: 'value1' });
      await helper.emitAndWait(Child2, { id: 'test2', type2: 42 });

      expect(parentHandler).toHaveBeenCalledTimes(2);
      expect(parentHandler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 'test1',
          type1: 'value1',
          __type: 'child-1',
        })
      );
      expect(parentHandler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: 'test2',
          type2: 42,
          __type: 'child-2',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('child listener only receives its specific child type', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const Child1 = defineChildEvent<typeof ParentEvent, { id: string; type1: string }>(
        ParentEvent,
        'child-1'
      );
      const Child2 = defineChildEvent<typeof ParentEvent, { id: string; type2: number }>(
        ParentEvent,
        'child-2'
      );

      const child1Handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(Child1, child1Handler);

      bus.emit(Child1, { id: 'test1', type1: 'value1' });
      await helper.emitAndWait(Child2, { id: 'test2', type2: 42 });

      expect(child1Handler).toHaveBeenCalledOnce();
      expect(child1Handler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test1',
          type1: 'value1',
          __type: 'child-1',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('sibling child listeners do not interfere', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const Child1 = defineChildEvent<typeof ParentEvent, { id: string; type1: string }>(
        ParentEvent,
        'child-1'
      );
      const Child2 = defineChildEvent<typeof ParentEvent, { id: string; type2: number }>(
        ParentEvent,
        'child-2'
      );

      const child1Handler = vi.fn();
      const child2Handler = vi.fn();

      const unsub1 = bus.on(Child1, child1Handler);
      const unsub2 = await helper.subscribeAndWait(Child2, child2Handler);

      bus.emit(Child1, { id: 'test1', type1: 'value1' });
      await helper.emitAndWait(Child2, { id: 'test2', type2: 42 });

      expect(child1Handler).toHaveBeenCalledOnce();
      expect(child2Handler).toHaveBeenCalledOnce();

      expect(child1Handler).toHaveBeenCalledWith(
        expect.objectContaining({ __type: 'child-1' })
      );
      expect(child2Handler).toHaveBeenCalledWith(
        expect.objectContaining({ __type: 'child-2' })
      );

      unsub1();
      await helper.unsubscribeAndWait(unsub2);
    });

    it('parent listener with source filter receives matching child events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const minion1 = { id: 'minion-1' };

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler, { from: minion1 });

      bus.emitFrom(ChildEvent, { id: 'test1', detail: 'detail1' }, 'minion-1');
      await helper.emitFromAndWait(ChildEvent, { id: 'test2', detail: 'detail2' }, 'minion-2');

      expect(parentHandler).toHaveBeenCalledOnce();
      expect(parentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test1',
          __source: 'minion-1',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('parent listener with Src.AnyMinion receives child events from any minion', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler, { from: Src.AnyMinion });

      bus.emitFrom(ChildEvent, { id: 'test1', detail: 'detail1' }, 'minion-1');
      bus.emitFrom(ChildEvent, { id: 'test2', detail: 'detail2' }, 'minion-2');
      bus.emit(ChildEvent, { id: 'test3', detail: 'detail3' }); // from mission

      // Give the handler time to process the events
      await helper.wait(10);

      expect(parentHandler).toHaveBeenCalledTimes(2);
      expect(parentHandler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'test1', __source: 'minion-1' })
      );
      expect(parentHandler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'test2', __source: 'minion-2' })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('parent listener with condition filter receives matching child events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string; value: number }>('parent');
      const ChildEvent = defineChildEvent<
        typeof ParentEvent,
        { id: string; value: number; detail: string }
      >(ParentEvent, 'child');

      const parentHandler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(ParentEvent, parentHandler, {
        condition: (event) => event.value > 10,
      });

      bus.emit(ChildEvent, { id: 'test1', value: 5, detail: 'low' });
      await helper.emitAndWait(ChildEvent, { id: 'test2', value: 15, detail: 'high' });

      expect(parentHandler).toHaveBeenCalledOnce();
      expect(parentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test2',
          value: 15,
          detail: 'high',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('parent once() resolves with child event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const promise = helper.onceAndWait(ParentEvent);
      await helper.wait();

      bus.emit(ChildEvent, { id: 'test', detail: 'extra' });

      const event = await promise;

      expect(event.id).toBe('test');
      expect(event.__type).toBe('child');
    });

    it('child once() does not resolve with parent event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const ParentEvent = defineEvent<{ id: string }>('parent');
      const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
        ParentEvent,
        'child'
      );

      const promise = helper.onceAndWait(ChildEvent);
      await helper.wait();

      bus.emit(ParentEvent, { id: 'parent-event' });
      bus.emit(ChildEvent, { id: 'child-event', detail: 'extra' });

      const event = await promise;

      expect(event.id).toBe('child-event');
      expect(event.__type).toBe('child');
    });
  });

  describe('Multi-Level Event Hierarchies', () => {
    it('grandparent listener receives grandchild events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      interface GrandparentPayload {
        id: string;
      }

      interface ParentPayload extends GrandparentPayload {
        category: string;
      }

      interface ChildPayload extends ParentPayload {
        detail: string;
      }

      const Grandparent = defineEvent<GrandparentPayload>('grandparent');
      const Parent = defineChildEvent<typeof Grandparent, ParentPayload>(
        Grandparent,
        'parent'
      );
      const Child = defineChildEvent<typeof Parent, ChildPayload>(Parent, 'child');

      const grandparentHandler = vi.fn();
      const parentHandler = vi.fn();
      const childHandler = vi.fn();

      const unsub1 = bus.on(Grandparent, grandparentHandler);
      const unsub2 = bus.on(Parent, parentHandler);
      const unsub3 = await helper.subscribeAndWait(Child, childHandler);

      await helper.emitAndWait(Child, { id: 'test', category: 'cat1', detail: 'extra' });

      // Grandparent receives grandchild event
      expect(grandparentHandler).toHaveBeenCalledOnce();
      expect(grandparentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test',
          category: 'cat1',
          detail: 'extra',
          __type: 'child',
        })
      );

      // Parent receives child event
      expect(parentHandler).toHaveBeenCalledOnce();
      expect(parentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test',
          category: 'cat1',
          detail: 'extra',
          __type: 'child',
        })
      );

      // Child receives child event
      expect(childHandler).toHaveBeenCalledOnce();
      expect(childHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test',
          category: 'cat1',
          detail: 'extra',
          __type: 'child',
        })
      );

      unsub1();
      unsub2();
      await helper.unsubscribeAndWait(unsub3);
    });

    it('grandparent receives all descendants but children receive only their level', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      interface GrandparentPayload {
        id: string;
      }

      interface ParentPayload extends GrandparentPayload {
        category: string;
      }

      interface ChildPayload extends ParentPayload {
        detail: string;
      }

      const Grandparent = defineEvent<GrandparentPayload>('grandparent');
      const Parent = defineChildEvent<typeof Grandparent, ParentPayload>(
        Grandparent,
        'parent'
      );
      const Child = defineChildEvent<typeof Parent, ChildPayload>(Parent, 'child');

      const grandparentHandler = vi.fn();
      const parentHandler = vi.fn();
      const childHandler = vi.fn();

      const unsub1 = bus.on(Grandparent, grandparentHandler);
      const unsub2 = bus.on(Parent, parentHandler);
      const unsub3 = await helper.subscribeAndWait(Child, childHandler);

      // Emit grandparent event
      await helper.emitAndWait(Grandparent, { id: 'g1' });

      expect(grandparentHandler).toHaveBeenCalledTimes(1);
      expect(parentHandler).not.toHaveBeenCalled();
      expect(childHandler).not.toHaveBeenCalled();

      // Emit parent event
      await helper.emitAndWait(Parent, { id: 'p1', category: 'cat' });

      expect(grandparentHandler).toHaveBeenCalledTimes(2);
      expect(parentHandler).toHaveBeenCalledTimes(1);
      expect(childHandler).not.toHaveBeenCalled();

      // Emit child event
      await helper.emitAndWait(Child, { id: 'c1', category: 'cat', detail: 'detail' });

      expect(grandparentHandler).toHaveBeenCalledTimes(3);
      expect(parentHandler).toHaveBeenCalledTimes(2);
      expect(childHandler).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
      await helper.unsubscribeAndWait(unsub3);
    });

    it('root listener receives events from all levels in four-level hierarchy', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      const Level0 = defineEvent<{ id: string }>('level-0');
      const Level1 = defineChildEvent<typeof Level0, { id: string; l1: string }>(
        Level0,
        'level-1'
      );
      const Level2 = defineChildEvent<typeof Level1, { id: string; l1: string; l2: string }>(
        Level1,
        'level-2'
      );
      const Level3 = defineChildEvent<
        typeof Level2,
        { id: string; l1: string; l2: string; l3: string }
      >(Level2, 'level-3');

      const rootHandler = vi.fn();

      const unsub = await helper.subscribeAndWait(Level0, rootHandler);

      bus.emit(Level0, { id: 'e0' });
      bus.emit(Level1, { id: 'e1', l1: 'v1' });
      bus.emit(Level2, { id: 'e2', l1: 'v1', l2: 'v2' });
      await helper.emitAndWait(Level3, { id: 'e3', l1: 'v1', l2: 'v2', l3: 'v3' });

      expect(rootHandler).toHaveBeenCalledTimes(4);

      expect(rootHandler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'e0', __type: 'level-0' })
      );
      expect(rootHandler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'e1', l1: 'v1', __type: 'level-1' })
      );
      expect(rootHandler).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ id: 'e2', l1: 'v1', l2: 'v2', __type: 'level-2' })
      );
      expect(rootHandler).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          id: 'e3',
          l1: 'v1',
          l2: 'v2',
          l3: 'v3',
          __type: 'level-3',
        })
      );

      await helper.unsubscribeAndWait(unsub);
    });

    it('middle level listener receives events from descendants only', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      const Level0 = defineEvent<{ id: string }>('level-0');
      const Level1 = defineChildEvent<typeof Level0, { id: string; l1: string }>(
        Level0,
        'level-1'
      );
      const Level2 = defineChildEvent<typeof Level1, { id: string; l1: string; l2: string }>(
        Level1,
        'level-2'
      );
      const Level3 = defineChildEvent<
        typeof Level2,
        { id: string; l1: string; l2: string; l3: string }
      >(Level2, 'level-3');

      const level1Handler = vi.fn();

      const unsub = await helper.subscribeAndWait(Level1, level1Handler);

      bus.emit(Level0, { id: 'e0' });
      bus.emit(Level1, { id: 'e1', l1: 'v1' });
      bus.emit(Level2, { id: 'e2', l1: 'v1', l2: 'v2' });
      await helper.emitAndWait(Level3, { id: 'e3', l1: 'v1', l2: 'v2', l3: 'v3' });

      // Level1 handler should receive Level1, Level2, and Level3, but not Level0
      expect(level1Handler).toHaveBeenCalledTimes(3);

      expect(level1Handler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'e1', l1: 'v1', __type: 'level-1' })
      );
      expect(level1Handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'e2', l1: 'v1', l2: 'v2', __type: 'level-2' })
      );
      expect(level1Handler).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          id: 'e3',
          l1: 'v1',
          l2: 'v2',
          l3: 'v3',
          __type: 'level-3',
        })
      );

      await helper.unsubscribeAndWait(unsub);
    });

    it('grandparent listener with source filter receives matching grandchild events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      const Grandparent = defineEvent<{ id: string }>('grandparent');
      const Parent = defineChildEvent<typeof Grandparent, { id: string; category: string }>(
        Grandparent,
        'parent'
      );
      const Child = defineChildEvent<
        typeof Parent,
        { id: string; category: string; detail: string }
      >(Parent, 'child');

      const minion1 = { id: 'minion-1' };

      const grandparentHandler = vi.fn();
      const unsub = await helper.subscribeAndWait(Grandparent, grandparentHandler, { from: minion1 });

      bus.emitFrom(Child, { id: 'c1', category: 'cat', detail: 'detail' }, 'minion-1');
      await helper.emitFromAndWait(Child, { id: 'c2', category: 'cat', detail: 'detail' }, 'minion-2');

      expect(grandparentHandler).toHaveBeenCalledOnce();
      expect(grandparentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'c1',
          __source: 'minion-1',
        })
      );

      await helper.unsubscribeAndWait(unsub);
    });

    it('grandparent listener with condition filter receives matching grandchild events', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      const Grandparent = defineEvent<{ id: string; value: number }>('grandparent');
      const Parent = defineChildEvent<
        typeof Grandparent,
        { id: string; value: number; category: string }
      >(Grandparent, 'parent');
      const Child = defineChildEvent<
        typeof Parent,
        { id: string; value: number; category: string; detail: string }
      >(Parent, 'child');

      const grandparentHandler = vi.fn();
      const unsub = await helper.subscribeAndWait(Grandparent, grandparentHandler, {
        condition: (event) => event.value > 10,
      });

      bus.emit(Child, { id: 'c1', value: 5, category: 'cat', detail: 'low' });
      await helper.emitAndWait(Child, { id: 'c2', value: 15, category: 'cat', detail: 'high' });

      expect(grandparentHandler).toHaveBeenCalledOnce();
      expect(grandparentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'c2',
          value: 15,
        })
      );

      await helper.unsubscribeAndWait(unsub);
    });

    it('grandparent once() resolves with grandchild event', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);

      const Grandparent = defineEvent<{ id: string }>('grandparent');
      const Parent = defineChildEvent<typeof Grandparent, { id: string; category: string }>(
        Grandparent,
        'parent'
      );
      const Child = defineChildEvent<
        typeof Parent,
        { id: string; category: string; detail: string }
      >(Parent, 'child');

      const promise = helper.onceAndWait(Grandparent);
      await helper.wait();

      bus.emit(Child, { id: 'test', category: 'cat', detail: 'extra' });

      const event = await promise;

      expect(event.id).toBe('test');
      expect(event.__type).toBe('child');
    });
  });

  describe('Scope-based listener lifecycle', () => {
    describe('Scope tracking', () => {
      it('registers listener with scope', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        // Create a scope for testing
        const scope = await Effect.runPromise(Scope.make());

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(TestEvent, handler, { scope });

        const listeners = bus.getActiveListeners();
        expect(listeners).toHaveLength(1);
        expect(listeners[0].hasScope).toBe(true);

        await helper.unsubscribeAndWait(unsubscribe);

        // Close the scope to clean up
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      });

      it('registers listener without scope', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

        const listeners = bus.getActiveListeners();
        expect(listeners).toHaveLength(1);
        expect(listeners[0].hasScope).toBe(false);

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('tracks multiple listeners with different scopes', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope1 = await Effect.runPromise(Scope.make());
        const scope2 = await Effect.runPromise(Scope.make());

        const unsub1 = await helper.subscribeAndWait(TestEvent, vi.fn(), { scope: scope1 });
        const unsub2 = await helper.subscribeAndWait(TestEvent, vi.fn(), { scope: scope2 });
        const unsub3 = await helper.subscribeAndWait(TestEvent, vi.fn()); // No scope

        const listeners = bus.getActiveListeners();
        expect(listeners).toHaveLength(3);
        expect(listeners.filter(l => l.hasScope === true)).toHaveLength(2);
        expect(listeners.filter(l => l.hasScope === false)).toHaveLength(1);

        unsub1();
        unsub2();
        await helper.unsubscribeAndWait(unsub3);

        // Close the scopes
        await Effect.runPromise(Scope.close(scope1, Exit.succeed(undefined)));
        await Effect.runPromise(Scope.close(scope2, Exit.succeed(undefined)));
      });
    });

    describe('Automatic cleanup', () => {
      it('cleans up all listeners in a specific scope', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope1 = await Effect.runPromise(Scope.make());
        const scope2 = await Effect.runPromise(Scope.make());

        const handler1 = vi.fn();
        const handler2 = vi.fn();
        const handler3 = vi.fn();

        bus.on(TestEvent, handler1, { scope: scope1 });
        const unsub2 = bus.on(TestEvent, handler2, { scope: scope2 });
        const unsub3 = bus.on(TestEvent, handler3); // No scope

        // Wait for subscriptions to be ready
        await helper.wait(10);

        expect(bus.getActiveListeners()).toHaveLength(3);

        // Close scope1 - should clean up listeners in that scope
        await Effect.runPromise(Scope.close(scope1, Exit.succeed(undefined)));
        await helper.wait(10); // Give time for cleanup

        const remainingListeners = bus.getActiveListeners();
        expect(remainingListeners).toHaveLength(2);
        expect(remainingListeners.filter(l => l.hasScope === true)).toHaveLength(1);
        expect(remainingListeners.filter(l => l.hasScope === false)).toHaveLength(1);

        unsub2();
        await helper.unsubscribeAndWait(unsub3);

        // Close scope2
        await Effect.runPromise(Scope.close(scope2, Exit.succeed(undefined)));
      });

      it('cleaned up listeners do not receive events', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope = await Effect.runPromise(Scope.make());

        const handler1 = vi.fn();
        const handler2 = vi.fn();

        bus.on(TestEvent, handler1, { scope });
        const unsub2 = bus.on(TestEvent, handler2); // No scope

        // Wait for subscriptions to be ready
        await helper.wait(10);

        // Emit before cleanup
        await helper.emitAndWait(TestEvent, { value: 1 });

        expect(handler1).toHaveBeenCalledOnce();
        expect(handler2).toHaveBeenCalledOnce();

        // Close scope - should clean up handler1
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await helper.wait(10); // Give time for cleanup

        // Emit after cleanup
        await helper.emitAndWait(TestEvent, { value: 2 });

        expect(handler1).toHaveBeenCalledOnce(); // Still only called once
        expect(handler2).toHaveBeenCalledTimes(2); // Called twice

        await helper.unsubscribeAndWait(unsub2);
      });

      it('cleans up multiple listeners from the same scope', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const Event1 = defineEvent<{ value: number }>('event-1');
        const Event2 = defineEvent<{ value: number }>('event-2');

        const scope = await Effect.runPromise(Scope.make());

        const handler1 = vi.fn();
        const handler2 = vi.fn();
        const handler3 = vi.fn();

        bus.on(Event1, handler1, { scope });
        bus.on(Event2, handler2, { scope });
        const unsub3 = bus.on(Event1, handler3); // No scope

        // Wait for subscriptions to be ready
        await helper.wait(10);

        expect(bus.getActiveListeners()).toHaveLength(3);

        // Close scope - should clean up handler1 and handler2
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await helper.wait(10); // Give time for cleanup

        const remainingListeners = bus.getActiveListeners();
        expect(remainingListeners).toHaveLength(1);
        expect(remainingListeners[0].hasScope).toBe(false);

        await helper.unsubscribeAndWait(unsub3);
      });
    });

    describe('getActiveListeners()', () => {
      it('returns empty array when no listeners', () => {
        const bus = new EventBus();
        // Note: helper is used in other tests but not in this basic test
        expect(bus.getActiveListeners()).toEqual([]);
      });

      it('returns listener information', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test-event');

        const scope = await Effect.runPromise(Scope.make());

        const before = Date.now();
        const unsubscribe = bus.on(TestEvent, vi.fn(), { scope });
        const after = Date.now();

        // Wait for subscriptions to be ready
        await helper.wait(10);

        const listeners = bus.getActiveListeners();
        expect(listeners).toHaveLength(1);
        expect(listeners[0].id).toMatch(/^listener-\d+$/);
        expect(listeners[0].eventType).toBe('test-event');
        expect(listeners[0].hasScope).toBe(true);
        expect(listeners[0].createdAt).toBeGreaterThanOrEqual(before);
        expect(listeners[0].createdAt).toBeLessThanOrEqual(after);

        await helper.unsubscribeAndWait(unsubscribe);

        // Close scope
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      });

      it('returns multiple listeners', async () => {
        const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
        const Event1 = defineEvent<{ value: number }>('event-1');
        const Event2 = defineEvent<{ value: number }>('event-2');

        const unsub1 = bus.on(Event1, vi.fn());
        const unsub2 = bus.on(Event2, vi.fn());
        const unsub3 = bus.on(Event1, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        const listeners = bus.getActiveListeners();
        expect(listeners).toHaveLength(3);
        expect(listeners.filter(l => l.eventType === 'event-1')).toHaveLength(2);
        expect(listeners.filter(l => l.eventType === 'event-2')).toHaveLength(1);

        unsub1();
        unsub2();
        await helper.unsubscribeAndWait(unsub3);
      });

      it('does not include unsubscribed listeners', async () => {
        const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const unsub1 = bus.on(TestEvent, vi.fn());
        const unsub2 = bus.on(TestEvent, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        expect(bus.getActiveListeners()).toHaveLength(2);

        await helper.unsubscribeAndWait(unsub1);

        expect(bus.getActiveListeners()).toHaveLength(1);

        await helper.unsubscribeAndWait(unsub2);

        expect(bus.getActiveListeners()).toHaveLength(0);
      });
    });

    describe('Long-lived listener flagging', () => {
      it('flags listeners that exceed threshold', async () => {
        const thresholdMs = 100;
        const bus = new EventBus(thresholdMs);
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const unsubscribe = bus.on(TestEvent, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        // Check immediately - should not be long-lived
        let listeners = bus.getActiveListeners();
        expect(listeners[0].isLongLived).toBe(false);

        // Wait for threshold to pass
        await helper.wait(thresholdMs + 50);

        // Check again - should be long-lived
        listeners = bus.getActiveListeners();
        expect(listeners[0].isLongLived).toBe(true);

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('does not flag listeners within threshold', async () => {
        const thresholdMs = 1000;
        const bus = new EventBus(thresholdMs);
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const unsubscribe = bus.on(TestEvent, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        // Check immediately
        const listeners = bus.getActiveListeners();
        expect(listeners[0].isLongLived).toBe(false);

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('uses default threshold when not specified', async () => {
        const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const unsubscribe = bus.on(TestEvent, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        // Check immediately - should not be long-lived with default 5-minute threshold
        const listeners = bus.getActiveListeners();
        expect(listeners[0].isLongLived).toBe(false);

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('tracks creation time correctly', async () => {
        const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const before = Date.now();
        const unsubscribe = bus.on(TestEvent, vi.fn());
        const after = Date.now();

        // Wait for subscriptions to be ready
        await helper.wait(10);

        const listeners = bus.getActiveListeners();
        expect(listeners[0].createdAt).toBeGreaterThanOrEqual(before);
        expect(listeners[0].createdAt).toBeLessThanOrEqual(after);

        await helper.unsubscribeAndWait(unsubscribe);
      });
    });

    describe('Integration with existing features', () => {
      it('scope tracking works with source filtering', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope = await Effect.runPromise(Scope.make());
        const minion = { id: 'minion-1' };

        const handler = vi.fn();
        bus.on(TestEvent, handler, { from: minion, scope });

        // Wait for subscriptions to be ready
        await helper.wait(10);

        await helper.emitFromAndWait(TestEvent, { value: 1 }, 'minion-1');

        expect(handler).toHaveBeenCalledOnce();

        await helper.emitFromAndWait(TestEvent, { value: 2 }, 'minion-2');

        expect(handler).toHaveBeenCalledOnce(); // Not called for wrong source

        // Close scope
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await helper.wait(10);

        await helper.emitFromAndWait(TestEvent, { value: 3 }, 'minion-1');

        expect(handler).toHaveBeenCalledOnce(); // Not called after cleanup
      });

      it('scope tracking works with condition filtering', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope = await Effect.runPromise(Scope.make());

        const handler = vi.fn();
        bus.on(TestEvent, handler, {
          condition: (event) => event.value > 10,
          scope,
        });

        // Wait for subscriptions to be ready
        await helper.wait(10);

        await helper.emitAndWait(TestEvent, { value: 5 });

        expect(handler).not.toHaveBeenCalled();

        await helper.emitAndWait(TestEvent, { value: 15 });

        expect(handler).toHaveBeenCalledOnce();

        // Close scope
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await helper.wait(10);

        await helper.emitAndWait(TestEvent, { value: 20 });

        expect(handler).toHaveBeenCalledOnce(); // Not called after cleanup
      });

      it('scope tracking works with once()', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope = await Effect.runPromise(Scope.make());

        const promise = helper.onceAndWait(TestEvent, { scope });
        await helper.wait();

        // Listener should be registered
        expect(bus.getActiveListeners()).toHaveLength(1);
        expect(bus.getActiveListeners()[0].hasScope).toBe(true);

        bus.emit(TestEvent, { value: 42 });

        const event = await promise;
        expect(event.value).toBe(42);

        // Listener should be automatically cleaned up after resolving
        // Give time for cleanup
        await helper.wait(10);
        expect(bus.getActiveListeners()).toHaveLength(0);

        // Close scope
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      });

      it('cleanup during once() before event', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const scope = await Effect.runPromise(Scope.make());

        const promise = bus.once(TestEvent, { scope });

        // Catch the promise rejection early to avoid unhandled rejection warning
        promise.catch(() => {
          // Expected to be rejected when scope is closed
        });

        // Close scope before event is emitted
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
        await helper.wait(10);

        // Event should not resolve the promise
        bus.emit(TestEvent, { value: 42 });

        // Wait a bit to ensure promise doesn't resolve
        await helper.wait(50);

        // Listener should have been removed
        expect(bus.getActiveListeners()).toHaveLength(0);
      });

      it('tracks unique IDs for listeners', async () => {
        const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ value: number }>('test');

        const unsub1 = bus.on(TestEvent, vi.fn());
        const unsub2 = bus.on(TestEvent, vi.fn());
        const unsub3 = bus.on(TestEvent, vi.fn());

        // Wait for subscriptions to be ready
        await helper.wait(10);

        const listeners = bus.getActiveListeners();
        const ids = listeners.map(l => l.id);

        // All IDs should be unique
        expect(new Set(ids).size).toBe(3);

        unsub1();
        unsub2();
        await helper.unsubscribeAndWait(unsub3);
      });
    });
  });

  describe('Schema Validation', () => {
    describe('Events with schemas', () => {
      it('emits events with valid payloads when schema is provided', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ name: string; count: number }>(
          'test-event',
          Schema.Struct({
            name: Schema.String,
            count: Schema.Number,
          })
        );

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

        await helper.emitAndWait(TestEvent, { name: 'test', count: 42 });

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'test',
            count: 42,
            __type: 'test-event',
          })
        );

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('throws ParseError when emit() receives invalid payload', () => {
        const bus = new EventBus();
        const TestEvent = defineEvent<{ name: string; count: number }>(
          'test-event',
          Schema.Struct({
            name: Schema.String,
            count: Schema.Number,
          })
        );

        expect(() => {
          bus.emit(TestEvent, { name: 'test', count: 'not-a-number' } as unknown as PayloadOf<typeof TestEvent>);
        }).toThrow();
      });

      it('fails with ParseError when emitEffect() receives invalid payload', async () => {
        const bus = new EventBus();
        const TestEvent = defineEvent<{ name: string; count: number }>(
          'test-event',
          Schema.Struct({
            name: Schema.String,
            count: Schema.Number,
          })
        );

        const effect = bus.emitEffect(TestEvent, { name: 'test', count: 'not-a-number' } as unknown as PayloadOf<typeof TestEvent>);
        const exit = await Effect.runPromiseExit(effect);

        expect(Exit.isFailure(exit)).toBe(true);
      });

      it('throws ParseError when emitFrom() receives invalid payload', () => {
        const bus = new EventBus();
        const TestEvent = defineEvent<{ value: string }>(
          'test-event',
          Schema.Struct({
            value: Schema.String,
          })
        );

        expect(() => {
          bus.emitFrom(TestEvent, { value: 123 } as unknown as PayloadOf<typeof TestEvent>, 'test-source');
        }).toThrow();
      });

      it('fails with ParseError when emitFromEffect() receives invalid payload', async () => {
        const bus = new EventBus();
        const TestEvent = defineEvent<{ value: string }>(
          'test-event',
          Schema.Struct({
            value: Schema.String,
          })
        );

        const effect = bus.emitFromEffect(TestEvent, { value: 123 } as unknown as PayloadOf<typeof TestEvent>, 'test-source');
        const exit = await Effect.runPromiseExit(effect);

        expect(Exit.isFailure(exit)).toBe(true);
      });

      it('emits events without validation when schema is not provided', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{ anything: unknown }>('test-event');

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

        await helper.emitAndWait(TestEvent, { anything: 'any-value' });

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            anything: 'any-value',
            __type: 'test-event',
          })
        );

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('validates complex nested schemas', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);
        const TestEvent = defineEvent<{
          user: { id: string; name: string };
          tags: readonly string[];
        }>(
          'test-event',
          Schema.Struct({
            user: Schema.Struct({
              id: Schema.String,
              name: Schema.String,
            }),
            tags: Schema.Array(Schema.String),
          })
        );

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);

        await helper.emitAndWait(TestEvent, {
          user: { id: 'user-1', name: 'Alice' },
          tags: ['tag1', 'tag2'],
        });

        expect(handler).toHaveBeenCalledOnce();

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('provides descriptive error message for validation failures', async () => {
        const bus = new EventBus();
        const TestEvent = defineEvent<{ age: number }>(
          'test-event',
          Schema.Struct({
            age: Schema.Number,
          })
        );

        const effect = bus.emitEffect(TestEvent, { age: 'not-a-number' } as unknown as PayloadOf<typeof TestEvent>);
        const exit = await Effect.runPromiseExit(effect);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause;
          expect(error).toBeDefined();
        }
      });
    });

    describe('Child events with schemas', () => {
      it('validates child event payloads when schema is provided', async () => {
        const bus = new EventBus();
        const helper = new EventBusTestHelper(bus);

        const ParentEvent = defineEvent<{ id: string }>(
          'parent',
          Schema.Struct({ id: Schema.String })
        );

        const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
          ParentEvent,
          'child',
          Schema.Struct({
            id: Schema.String,
            detail: Schema.String,
          })
        );

        const handler = vi.fn();
        const unsubscribe = await helper.subscribeAndWait(ChildEvent, handler);

        await helper.emitAndWait(ChildEvent, { id: '123', detail: 'test' });

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            id: '123',
            detail: 'test',
            __type: 'child',
          })
        );

        await helper.unsubscribeAndWait(unsubscribe);
      });

      it('throws ParseError for invalid child event payload', () => {
        const bus = new EventBus();

        const ParentEvent = defineEvent<{ id: string }>(
          'parent',
          Schema.Struct({ id: Schema.String })
        );

        const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; count: number }>(
          ParentEvent,
          'child',
          Schema.Struct({
            id: Schema.String,
            count: Schema.Number,
          })
        );

        expect(() => {
          bus.emit(ChildEvent, { id: '123', count: 'not-a-number' } as unknown as PayloadOf<typeof ChildEvent>);
        }).toThrow();
      });
    });
  });

  describe('HandlerError - error handling with Effect Cause', () => {
    it('emits HandlerError when a handler throws', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      const errorHandler = vi.fn();
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      // Handler that throws an error
      const failingHandler = vi.fn(() => {
        throw new Error('Handler failed!');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      // Emit an event that will trigger the failing handler
      await helper.emitAndWait(TestEvent, { value: 42 });

      // The failing handler should have been called
      expect(failingHandler).toHaveBeenCalledOnce();

      // HandlerError should have been emitted
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          __type: 'handler-error',
          eventType: 'test-event',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('includes Effect Cause with error details', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      let capturedCause: Cause.Cause<unknown> | undefined;
      const errorHandler = vi.fn((event: { cause: Cause.Cause<unknown> }) => {
        capturedCause = event.cause;
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      const testError = new Error('Test error with stack');
      const failingHandler = vi.fn(() => {
        throw testError;
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(capturedCause).toBeDefined();
      if (!capturedCause) throw new Error('expected capturedCause to be set');

      // Verify the cause contains the original error
      const failures = Cause.failures(capturedCause);
      expect(Array.from(failures)).toHaveLength(1);
      expect(Array.from(failures)[0]).toBe(testError);

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('Cause.pretty() produces readable error output', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      let prettyOutput: string | undefined;
      const errorHandler = vi.fn((event: { cause: Cause.Cause<unknown> }) => {
        prettyOutput = Cause.pretty(event.cause);
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      const failingHandler = vi.fn(() => {
        throw new Error('Descriptive error message');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(prettyOutput).toBeDefined();
      expect(prettyOutput).toContain('Descriptive error message');

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('includes handler identity in HandlerError', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      let capturedHandlerId: string | undefined;
      const errorHandler = vi.fn((event: { handlerId: string }) => {
        capturedHandlerId = event.handlerId;
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      const failingHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(capturedHandlerId).toBeDefined();
      expect(capturedHandlerId).toMatch(/^listener-\d+$/);

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('includes original event in HandlerError', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number; label: string }>('test-event');

      let capturedOriginalEvent: unknown;
      const errorHandler = vi.fn((event: { originalEvent: unknown }) => {
        capturedOriginalEvent = event.originalEvent;
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      const failingHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42, label: 'test-label' });

      expect(capturedOriginalEvent).toBeDefined();
      expect(capturedOriginalEvent).toEqual(
        expect.objectContaining({
          value: 42,
          label: 'test-label',
          __type: 'test-event',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('error isolation: one failing handler does not stop others', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      const successHandler1 = vi.fn();
      const failingHandler = vi.fn(() => {
        throw new Error('Handler failed!');
      });
      const successHandler2 = vi.fn();

      // Subscribe handlers in order
      const unsub1 = await helper.subscribeAndWait(TestEvent, successHandler1);
      const unsub2 = await helper.subscribeAndWait(TestEvent, failingHandler);
      const unsub3 = await helper.subscribeAndWait(TestEvent, successHandler2);

      // Emit event
      await helper.emitAndWait(TestEvent, { value: 42 });

      // All handlers should have been called
      expect(successHandler1).toHaveBeenCalledOnce();
      expect(failingHandler).toHaveBeenCalledOnce();
      expect(successHandler2).toHaveBeenCalledOnce();

      await helper.unsubscribeAndWait(unsub1);
      await helper.unsubscribeAndWait(unsub2);
      await helper.unsubscribeAndWait(unsub3);
    });

    it('infinite loop prevention: HandlerError handler errors do not emit HandlerError', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      // Capture console.error calls
      // oxlint-disable-next-line no-empty-function
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let errorCount = 0;
      // First HandlerError handler that throws
      const failingErrorHandler = vi.fn(() => {
        errorCount++;
        throw new Error('HandlerError handler also failed!');
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        failingErrorHandler
      );

      // Original handler that throws
      const failingHandler = vi.fn(() => {
        throw new Error('Original handler error');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      // Emit event
      await helper.emitAndWait(TestEvent, { value: 42 });

      // The HandlerError handler should have been called once (for the original error)
      // but not again (infinite loop prevention)
      expect(errorCount).toBe(1);

      // Console.error should have been called for the HandlerError handler failure
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('HandlerError handler');
      expect(consoleSpy.mock.calls[0][0]).toContain('prevent infinite loop');

      consoleSpy.mockRestore();
      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('captures non-Error thrown values', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      let capturedCause: Cause.Cause<unknown> | undefined;
      const errorHandler = vi.fn((event: { cause: Cause.Cause<unknown> }) => {
        capturedCause = event.cause;
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      // Handler that throws a string instead of Error
      const failingHandler = vi.fn(() => {
        throw 'string error message';
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(capturedCause).toBeDefined();
      if (!capturedCause) throw new Error('expected capturedCause to be set');

      // Verify the cause contains the thrown string
      const failures = Cause.failures(capturedCause);
      expect(Array.from(failures)).toHaveLength(1);
      expect(Array.from(failures)[0]).toBe('string error message');

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });

    it('HandlerError is emitted from event-bus source', async () => {
      const bus = new EventBus();
      const helper = new EventBusTestHelper(bus);
      const TestEvent = defineEvent<{ value: number }>('test-event');

      let capturedSource: string | undefined;
      const errorHandler = vi.fn((event: { __source: string }) => {
        capturedSource = event.__source;
      });
      const errorUnsubscribe = await helper.subscribeAndWait(
        WellKnownEvents.HandlerError,
        errorHandler
      );

      const failingHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const unsubscribe = await helper.subscribeAndWait(TestEvent, failingHandler);

      await helper.emitAndWait(TestEvent, { value: 42 });

      expect(capturedSource).toBe('event-bus');

      await helper.unsubscribeAndWait(unsubscribe);
      await helper.unsubscribeAndWait(errorUnsubscribe);
    });
  });
});
