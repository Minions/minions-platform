/**
 * Usage verification tests for Story 1: Event Declaration System
 *
 * These tests verify all acceptance criteria are met:
 * - defineEvent<PayloadType>(type) helper creates typed event declarations
 * - MinionEvents constants defined for TurnComplete, GadgetUse, StatusChange, Died
 * - User-defined event declarations work identically to domain events
 * - TypeScript autocomplete works on event payloads in handlers
 * - Event types are discoverable through constant objects
 */

import { describe, it, expect } from 'vitest';
import {
  defineEvent,
  type EventDeclaration,
  type TypedEvent,
  type PayloadOf,
} from './EventDeclaration';
import { MinionEvents } from '@minions/hatchery';

describe('Story 1: Event Declaration System - Acceptance Criteria', () => {
  it('AC1: defineEvent<PayloadType>(type) helper creates typed event declarations', () => {
    // Create a typed event declaration
    const MyEvent = defineEvent<{ taskId: string; result: string }>(
      'my-event'
    );

    // Verify it's a properly typed EventDeclaration
    expect(MyEvent.type).toBe('my-event');

    // Type checking works at compile time
    type Payload = PayloadOf<typeof MyEvent>;
    const payload: Payload = { taskId: 'task-1', result: 'success' };

    expect(payload.taskId).toBe('task-1');
    expect(payload.result).toBe('success');
  });

  it('AC2: MinionEvents constants defined for TurnComplete, GadgetUse, StatusChange, Died', () => {
    // All four well-known events are defined
    expect(MinionEvents.TurnComplete).toBeDefined();
    expect(MinionEvents.GadgetUse).toBeDefined();
    expect(MinionEvents.StatusChange).toBeDefined();
    expect(MinionEvents.Died).toBeDefined();

    // They have the correct types
    expect(MinionEvents.TurnComplete.type).toBe('turn-complete');
    expect(MinionEvents.GadgetUse.type).toBe('gadget-use');
    expect(MinionEvents.StatusChange.type).toBe('status-change');
    expect(MinionEvents.Died.type).toBe('died');

    // They have correct payload types
    type TurnPayload = PayloadOf<typeof MinionEvents.TurnComplete>;
    type GadgetPayload = PayloadOf<typeof MinionEvents.GadgetUse>;
    type StatusPayload = PayloadOf<typeof MinionEvents.StatusChange>;
    type DiedPayload = PayloadOf<typeof MinionEvents.Died>;

    const turnPayload: TurnPayload = { minionId: 'minion-1' };
    const gadgetPayload: GadgetPayload = {
      minionId: 'minion-1',
      gadgetName: 'Read',
      input: { path: 'file.ts' },
      result: 'contents',
    };
    const statusPayload: StatusPayload = {
      minionId: 'minion-1',
      oldStatus: 'waiting',
      newStatus: 'processing',
    };
    const diedPayload: DiedPayload = {
      minionId: 'minion-1',
      reason: 'completed',
    };

    expect(turnPayload.minionId).toBe('minion-1');
    expect(gadgetPayload.gadgetName).toBe('Read');
    expect(statusPayload.oldStatus).toBe('waiting');
    expect(diedPayload.reason).toBe('completed');
  });

  it('AC3: User-defined event declarations work identically to well-known events', () => {
    // Define user events using the same pattern
    const UserEvents = {
      TaskComplete: defineEvent<{ taskId: string; result: string }>(
        'task-complete'
      ),
      Blocked: defineEvent<{ reason: string }>('blocked'),
    } as const;

    // They work exactly like MinionEvents
    expect(UserEvents.TaskComplete.type).toBe('task-complete');
    expect(UserEvents.Blocked.type).toBe('blocked');

    // Type extraction works identically
    type TaskPayload = PayloadOf<typeof UserEvents.TaskComplete>;
    type BlockedPayload = PayloadOf<typeof UserEvents.Blocked>;

    const taskPayload: TaskPayload = { taskId: 'task-1', result: 'done' };
    const blockedPayload: BlockedPayload = { reason: 'waiting' };

    expect(taskPayload.taskId).toBe('task-1');
    expect(blockedPayload.reason).toBe('waiting');

    // Can be used in handlers the same way
    type TaskHandler = (event: TypedEvent<typeof UserEvents.TaskComplete>) => void;
    type TurnHandler = (event: TypedEvent<typeof MinionEvents.TurnComplete>) => void;

    const taskHandler: TaskHandler = (event) => {
      expect(event.taskId).toBeDefined();
      expect(event.result).toBeDefined();
    };

    const turnHandler: TurnHandler = (event) => {
      expect(event.minionId).toBeDefined();
    };

    // Verify handlers can be called
    taskHandler({
      taskId: 'task-1',
      result: 'done',
      __type: 'task-complete',
      __source: 'test',
      __timestamp: Date.now(),
    });

    turnHandler({
      minionId: 'minion-1',
      __type: 'turn-complete',
      __source: 'test',
      __timestamp: Date.now(),
    });
  });

  it('AC4: TypeScript autocomplete works on event payloads in handlers', () => {
    // Define a complex event
    const ComplexEvent = defineEvent<{
      id: string;
      data: {
        items: string[];
        count: number;
      };
      metadata?: Record<string, unknown>;
    }>('complex');

    // Handler type with full autocomplete
    type Handler = (event: TypedEvent<typeof ComplexEvent>) => void;

    const handler: Handler = (event) => {
      // All these fields autocomplete in TypeScript
      const id: string = event.id;
      const items: string[] = event.data.items;
      const count: number = event.data.count;
      const metadata: Record<string, unknown> | undefined = event.metadata;

      // Metadata fields also autocomplete
      const type: string = event.__type;
      const source: string = event.__source;
      const timestamp: number = event.__timestamp;

      expect(id).toBeDefined();
      expect(items).toBeDefined();
      expect(count).toBeDefined();
      expect(type).toBeDefined();
      expect(source).toBeDefined();
      expect(timestamp).toBeDefined();

      // Optional fields work correctly
      if (metadata) {
        expect(metadata).toBeDefined();
      }
    };

    // Verify handler works
    handler({
      id: 'test',
      data: { items: ['a', 'b'], count: 2 },
      metadata: { foo: 'bar' },
      __type: 'complex',
      __source: 'test',
      __timestamp: Date.now(),
    });
  });

  it('AC5: Event types are discoverable through constant objects', () => {
    // Well-known events are discoverable
    const wellKnown = MinionEvents;
    expect(wellKnown.TurnComplete).toBeDefined();
    expect(wellKnown.GadgetUse).toBeDefined();
    expect(wellKnown.StatusChange).toBeDefined();
    expect(wellKnown.Died).toBeDefined();

    // User-defined events are also discoverable
    const MyEvents = {
      EventA: defineEvent<{ value: string }>('event-a'),
      EventB: defineEvent<{ count: number }>('event-b'),
      EventC: defineEvent<void>('event-c'),
    } as const;

    expect(MyEvents.EventA).toBeDefined();
    expect(MyEvents.EventB).toBeDefined();
    expect(MyEvents.EventC).toBeDefined();

    // Can iterate over event definitions
    const eventTypes = Object.keys(MyEvents);
    expect(eventTypes).toContain('EventA');
    expect(eventTypes).toContain('EventB');
    expect(eventTypes).toContain('EventC');

    // Can access event declarations by name
    const eventA = MyEvents.EventA;
    expect(eventA.type).toBe('event-a');
  });

  it('Demonstrates full usage pattern matching PRD examples', () => {
    // Example from PRD: Define events
    const MyEvents = {
      TaskComplete: defineEvent<{ taskId: string; result: string }>(
        'task-complete'
      ),
      Blocked: defineEvent<{ reason: string; taskId: string }>('blocked'),
    } as const;

    // Example from PRD: Use events (fully typed)
    // This would be: ctx.events.on(MyEvents.TaskComplete, (event) => { ... })

    type Handler = (event: TypedEvent<typeof MyEvents.TaskComplete>) => void;

    const handler: Handler = (event) => {
      // From PRD: "event.taskId; // autocomplete works"
      const taskId: string = event.taskId;
      const result: string = event.result;

      expect(taskId).toBeDefined();
      expect(result).toBeDefined();
    };

    // Verify it works
    handler({
      taskId: 'task-1',
      result: 'success',
      __type: 'task-complete',
      __source: 'minion-1',
      __timestamp: Date.now(),
    });
  });

  it('Demonstrates identical syntax for well-known and user-defined events', () => {
    // From PRD: Usage is identical for both
    type WellKnownHandler = (
      event: TypedEvent<typeof MinionEvents.GadgetUse>
    ) => void;
    type UserHandler = (
      event: TypedEvent<
        EventDeclaration<{ taskId: string; result: string }>
      >
    ) => void;

    const wellKnownHandler: WellKnownHandler = (event) => {
      // From PRD: "event.gadgetName; // autocomplete works, fully typed"
      const gadgetName: string = event.gadgetName;
      expect(gadgetName).toBeDefined();
    };

    const userHandler: UserHandler = (event) => {
      // From PRD: "event.taskId; // autocomplete works, fully typed"
      const taskId: string = event.taskId;
      const result: string = event.result;
      expect(taskId).toBeDefined();
      expect(result).toBeDefined();
    };

    // Both work identically
    wellKnownHandler({
      minionId: 'minion-1',
      gadgetName: 'Read',
      input: { path: 'file.ts' },
      result: 'contents',
      __type: 'gadget-use',
      __source: 'minion-1',
      __timestamp: Date.now(),
    });

    userHandler({
      taskId: 'task-1',
      result: 'success',
      __type: 'task-complete',
      __source: 'minion-1',
      __timestamp: Date.now(),
    });
  });
});
