import { describe, it, expect } from 'vitest';
import {
  defineEvent,
  defineChildEvent,
  getParentEventType,
  isChildEvent,
  getEventSchemaInfo,
  type PayloadOf,
  type TypedEvent,
} from './EventDeclaration';
import { MinionEvents } from '@minions/hatchery';
import { Schema, JSONSchema } from 'effect';

describe('EventDeclaration', () => {
  describe('defineEvent', () => {
    it('creates an event declaration with explicit payload type', () => {
      const TaskComplete = defineEvent<{ taskId: string; result: string }>(
        'task-complete'
      );

      expect(TaskComplete.type).toBe('task-complete');
      expect(TaskComplete.payload).toBeUndefined();
    });

    it('creates an event declaration with void payload', () => {
      const SimpleEvent = defineEvent<void>('simple');

      expect(SimpleEvent.type).toBe('simple');
      expect(SimpleEvent.payload).toBeUndefined();
    });

    it('creates an event declaration with complex payload type', () => {
      interface ComplexPayload {
        id: string;
        data: {
          items: string[];
          count: number;
        };
        metadata?: Record<string, unknown>;
      }

      const ComplexEvent = defineEvent<ComplexPayload>('complex');

      expect(ComplexEvent.type).toBe('complex');
      expect(ComplexEvent.payload).toBeUndefined();
    });

    it('creates distinct event declarations for different types', () => {
      const Event1 = defineEvent<{ value: string }>('event-1');
      const Event2 = defineEvent<{ value: number }>('event-2');

      expect(Event1.type).not.toBe(Event2.type);
      expect(Event1).not.toBe(Event2);
    });
  });

  describe('PayloadOf', () => {
    it('extracts the payload type from an EventDeclaration', () => {
      const _TestEvent = defineEvent<{ id: string; count: number }>('test');

      // TypeScript compile-time check
      type Payload = PayloadOf<typeof _TestEvent>;

      // Runtime check that the type exists
      const payload: Payload = { id: 'test', count: 42 };
      expect(payload.id).toBe('test');
      expect(payload.count).toBe(42);
    });

    it('extracts void payload type', () => {
      const _VoidEvent = defineEvent<void>('void');

      type Payload = PayloadOf<typeof _VoidEvent>;

      // void payload should be assignable to void
      const payload: Payload = undefined as void;
      expect(payload).toBeUndefined();
    });
  });

  describe('TypedEvent', () => {
    it('includes payload fields and metadata fields', () => {
      const _TestEvent = defineEvent<{ taskId: string; result: string }>(
        'test-event'
      );

      // TypeScript compile-time check
      type Event = TypedEvent<typeof _TestEvent>;

      // Runtime check that the type structure is correct
      const event: Event = {
        taskId: 'task-1',
        result: 'success',
        __type: 'test-event',
        __source: 'minion-123',
        __timestamp: Date.now(),
      };

      expect(event.taskId).toBe('task-1');
      expect(event.result).toBe('success');
      expect(event.__type).toBe('test-event');
      expect(event.__source).toBe('minion-123');
      expect(event.__timestamp).toBeGreaterThan(0);
    });
  });

  describe('MinionEvents', () => {
    describe('TurnComplete', () => {
      it('has correct event type', () => {
        expect(MinionEvents.TurnComplete.type).toBe('turn-complete');
      });

      it('has correct payload type shape', () => {
        type Payload = PayloadOf<typeof MinionEvents.TurnComplete>;

        const payload: Payload = { minionId: 'minion-123' };
        expect(payload.minionId).toBe('minion-123');
      });
    });

    describe('GadgetUse', () => {
      it('has correct event type', () => {
        expect(MinionEvents.GadgetUse.type).toBe('gadget-use');
      });

      it('has correct payload type shape', () => {
        type Payload = PayloadOf<typeof MinionEvents.GadgetUse>;

        const payload: Payload = {
          minionId: 'minion-123',
          gadgetName: 'Read',
          input: { path: '/test/file.ts' },
          result: 'file contents',
        };

        expect(payload.minionId).toBe('minion-123');
        expect(payload.gadgetName).toBe('Read');
        expect(payload.input).toEqual({ path: '/test/file.ts' });
        expect(payload.result).toBe('file contents');
      });
    });

    describe('StatusChange', () => {
      it('has correct event type', () => {
        expect(MinionEvents.StatusChange.type).toBe('status-change');
      });

      it('has correct payload type shape', () => {
        type Payload = PayloadOf<typeof MinionEvents.StatusChange>;

        const payload: Payload = {
          minionId: 'minion-123',
          oldStatus: 'waiting',
          newStatus: 'processing',
        };

        expect(payload.minionId).toBe('minion-123');
        expect(payload.oldStatus).toBe('waiting');
        expect(payload.newStatus).toBe('processing');
      });
    });

    describe('Died', () => {
      it('has correct event type', () => {
        expect(MinionEvents.Died.type).toBe('died');
      });

      it('has correct payload type shape', () => {
        type Payload = PayloadOf<typeof MinionEvents.Died>;

        const payload: Payload = {
          minionId: 'minion-123',
          reason: 'Task completed successfully',
        };

        expect(payload.minionId).toBe('minion-123');
        expect(payload.reason).toBe('Task completed successfully');
      });
    });

    it('all well-known events are const objects', () => {
      // Verify they can be used in const contexts
      const events = MinionEvents;

      expect(events.TurnComplete).toBeDefined();
      expect(events.GadgetUse).toBeDefined();
      expect(events.StatusChange).toBeDefined();
      expect(events.Died).toBeDefined();
    });
  });

  describe('User-defined events', () => {
    it('work identically to well-known events', () => {
      const MyEvents = {
        TaskComplete: defineEvent<{ taskId: string; result: string }>(
          'task-complete'
        ),
        Blocked: defineEvent<{ reason: string }>('blocked'),
      } as const;

      expect(MyEvents.TaskComplete.type).toBe('task-complete');
      expect(MyEvents.Blocked.type).toBe('blocked');

      // Type checking works the same way
      type TaskPayload = PayloadOf<typeof MyEvents.TaskComplete>;
      type BlockedPayload = PayloadOf<typeof MyEvents.Blocked>;

      const taskPayload: TaskPayload = { taskId: 'task-1', result: 'done' };
      const blockedPayload: BlockedPayload = { reason: 'waiting for input' };

      expect(taskPayload.taskId).toBe('task-1');
      expect(blockedPayload.reason).toBe('waiting for input');
    });

    it('can be organized in const objects for discoverability', () => {
      const DeveloperEvents = {
        ImplementationComplete: defineEvent<{ filesChanged: string[] }>(
          'implementation-complete'
        ),
        NeedsClarification: defineEvent<{ question: string }>(
          'needs-clarification'
        ),
        TestsPass: defineEvent<{ testCount: number }>('tests-pass'),
      } as const;

      const CriticEvents = {
        ReviewComplete: defineEvent<{ issues: string[] }>('review-complete'),
        ApprovalGranted: defineEvent<void>('approval-granted'),
      } as const;

      expect(DeveloperEvents.ImplementationComplete.type).toBe(
        'implementation-complete'
      );
      expect(DeveloperEvents.NeedsClarification.type).toBe(
        'needs-clarification'
      );
      expect(DeveloperEvents.TestsPass.type).toBe('tests-pass');

      expect(CriticEvents.ReviewComplete.type).toBe('review-complete');
      expect(CriticEvents.ApprovalGranted.type).toBe('approval-granted');
    });
  });

  describe('Type inference', () => {
    it('TypeScript autocomplete works on event payloads', () => {
      const TestEvent = defineEvent<{ id: string; data: { count: number } }>(
        'test'
      );

      // This would be used in a handler like:
      // ctx.events.on(TestEvent, (event) => { ... })

      // Simulate handler signature
      type Handler = (event: TypedEvent<typeof TestEvent>) => void;

      const handler: Handler = (event) => {
        // TypeScript should autocomplete these fields
        const id: string = event.id;
        const count: number = event.data.count;
        const type: string = event.__type;
        const source: string = event.__source;
        const timestamp: number = event.__timestamp;

        expect(id).toBeDefined();
        expect(count).toBeDefined();
        expect(type).toBeDefined();
        expect(source).toBeDefined();
        expect(timestamp).toBeDefined();
      };

      // Verify the handler can be called
      handler({
        id: 'test-id',
        data: { count: 42 },
        __type: 'test',
        __source: 'test-source',
        __timestamp: Date.now(),
      });
    });

    it('prevents incorrect payload usage at compile time', () => {
      const StrictEvent = defineEvent<{ id: string; count: number }>(
        'strict'
      );

      type Handler = (event: TypedEvent<typeof StrictEvent>) => void;

      const handler: Handler = (event) => {
        // These should work
        const id: string = event.id;
        const count: number = event.count;

        // These would be compile errors if uncommented:
        // const wrong: number = event.id;  // Type error
        // const missing = event.nonexistent;  // Type error

        expect(id).toBeDefined();
        expect(count).toBeDefined();
      };

      handler({
        id: 'test',
        count: 42,
        __type: 'strict',
        __source: 'test',
        __timestamp: Date.now(),
      });
    });
  });

  describe('Child Events', () => {
    describe('defineChildEvent', () => {
      it('creates a child event declaration with parent relationship', () => {
        const ParentEvent = defineEvent<{ id: string }>('parent');
        const ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
          ParentEvent,
          'child'
        );

        expect(ChildEvent.type).toBe('child');
        expect(ChildEvent.payload).toBeUndefined();
        expect(getParentEventType('child')).toBe('parent');
      });

      it('child payload extends parent payload', () => {
        const ParentEvent = defineEvent<{ minionId: string; gadgetName: string }>('gadget-use');
        const _ChildEvent = defineChildEvent<
          typeof ParentEvent,
          { minionId: string; gadgetName: string; filePath: string; content: string }
        >(ParentEvent, 'write-gadget-use');

        // TypeScript compile-time check
        type ParentPayload = PayloadOf<typeof ParentEvent>;
        type ChildPayload = PayloadOf<typeof _ChildEvent>;

        // Child payload should have all parent fields plus child-specific fields
        const childPayload: ChildPayload = {
          minionId: 'minion-1',
          gadgetName: 'Write',
          filePath: '/test/file.ts',
          content: 'content',
        };

        // Child payload should be assignable to parent payload type (because it extends it)
        const parentPayload: ParentPayload = childPayload;

        expect(childPayload.minionId).toBe('minion-1');
        expect(childPayload.gadgetName).toBe('Write');
        expect(childPayload.filePath).toBe('/test/file.ts');
        expect(parentPayload.minionId).toBe('minion-1');
      });

      it('registers multiple child events for the same parent', () => {
        const ParentEvent = defineEvent<{ id: string }>('parent');
        const Child1 = defineChildEvent<typeof ParentEvent, { id: string; type1: string }>(
          ParentEvent,
          'child-1'
        );
        const Child2 = defineChildEvent<typeof ParentEvent, { id: string; type2: number }>(
          ParentEvent,
          'child-2'
        );

        expect(getParentEventType('child-1')).toBe('parent');
        expect(getParentEventType('child-2')).toBe('parent');
        expect(Child1.type).not.toBe(Child2.type);
      });

      it('creates distinct child event declarations', () => {
        const ParentEvent = defineEvent<{ value: string }>('parent');
        const Child1 = defineChildEvent<typeof ParentEvent, { value: string; extra1: string }>(
          ParentEvent,
          'child-1'
        );
        const Child2 = defineChildEvent<typeof ParentEvent, { value: string; extra2: number }>(
          ParentEvent,
          'child-2'
        );

        expect(Child1.type).not.toBe(Child2.type);
        expect(Child1).not.toBe(Child2);
      });
    });

    describe('getParentEventType', () => {
      it('returns parent type for child events', () => {
        const ParentEvent = defineEvent<{ id: string }>('parent-event');
        // Creating child event registers it in the parent-child map
        defineChildEvent<typeof ParentEvent, { id: string; extra: string }>(
          ParentEvent,
          'child-event'
        );

        expect(getParentEventType('child-event')).toBe('parent-event');
      });

      it('returns undefined for flat events', () => {
        // Creating a flat event to test against
        defineEvent<{ value: number }>('flat-event');

        expect(getParentEventType('flat-event')).toBeUndefined();
      });

      it('returns undefined for non-existent events', () => {
        expect(getParentEventType('non-existent')).toBeUndefined();
      });
    });

    describe('isChildEvent', () => {
      it('returns true for child events', () => {
        const ParentEvent = defineEvent<{ id: string }>('parent');
        // Creating child event registers it in the parent-child map
        defineChildEvent<typeof ParentEvent, { id: string; extra: string }>(
          ParentEvent,
          'child'
        );

        expect(isChildEvent('child')).toBe(true);
      });

      it('returns false for flat events', () => {
        // Creating a flat event to test against
        defineEvent<{ value: number }>('flat');

        expect(isChildEvent('flat')).toBe(false);
      });

      it('returns false for non-existent events', () => {
        expect(isChildEvent('non-existent')).toBe(false);
      });
    });

    describe('Type safety with child events', () => {
      it('child payload type includes parent fields', () => {
        interface ParentPayload {
          minionId: string;
          gadgetName: string;
        }

        interface ChildPayload extends ParentPayload {
          filePath: string;
          content: string;
        }

        const ParentEvent = defineEvent<ParentPayload>('gadget-use');
        const _ChildEvent = defineChildEvent<typeof ParentEvent, ChildPayload>(
          ParentEvent,
          'write-gadget-use'
        );

        // TypeScript compile-time check
        type ExtractedChildPayload = PayloadOf<typeof _ChildEvent>;

        const payload: ExtractedChildPayload = {
          minionId: 'minion-1',
          gadgetName: 'Write',
          filePath: '/test/file.ts',
          content: 'content',
        };

        expect(payload.minionId).toBe('minion-1');
        expect(payload.gadgetName).toBe('Write');
        expect(payload.filePath).toBe('/test/file.ts');
        expect(payload.content).toBe('content');
      });

      it('child events work with TypedEvent', () => {
        const ParentEvent = defineEvent<{ id: string }>('parent');
        const _ChildEvent = defineChildEvent<typeof ParentEvent, { id: string; detail: string }>(
          ParentEvent,
          'child'
        );

        type ChildTypedEvent = TypedEvent<typeof _ChildEvent>;

        const event: ChildTypedEvent = {
          id: 'test-id',
          detail: 'test-detail',
          __type: 'child',
          __source: 'minion-1',
          __timestamp: Date.now(),
        };

        expect(event.id).toBe('test-id');
        expect(event.detail).toBe('test-detail');
        expect(event.__type).toBe('child');
      });
    });
  });

  describe('getEventSchemaInfo', () => {
    it('returns undefined for events without schemas', () => {
      const EventWithoutSchema = defineEvent<{ value: string }>('test-event');

      const schemaInfo = getEventSchemaInfo(EventWithoutSchema);

      expect(schemaInfo).toBeUndefined();
    });

    it('returns JSON Schema for events with schemas', () => {
      const EventWithSchema = defineEvent<{ name: string; count: number }>(
        'test-event',
        Schema.Struct({
          name: Schema.String,
          count: Schema.Number,
        })
      );

      const schemaInfo = getEventSchemaInfo(EventWithSchema);

      expect(schemaInfo).toBeDefined();
      expect(schemaInfo).toHaveProperty('type');
      expect(schemaInfo).toHaveProperty('properties');
    });

    it('returns detailed JSON Schema with field types', () => {
      const EventWithSchema = defineEvent<{ id: string; active: boolean }>(
        'test-event',
        Schema.Struct({
          id: Schema.String,
          active: Schema.Boolean,
        })
      );

      const schemaInfo = getEventSchemaInfo(EventWithSchema) as JSONSchema.JsonSchema7Object;

      expect(schemaInfo.type).toBe('object');
      expect(schemaInfo.properties).toHaveProperty('id');
      expect(schemaInfo.properties).toHaveProperty('active');
      expect(schemaInfo.properties.id).toMatchObject({ type: 'string' });
      expect(schemaInfo.properties.active).toMatchObject({ type: 'boolean' });
    });

    it('works with nested schemas', () => {
      const EventWithNestedSchema = defineEvent<{
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

      const schemaInfo = getEventSchemaInfo(EventWithNestedSchema) as JSONSchema.JsonSchema7Object;

      expect(schemaInfo.properties.user).toMatchObject({ type: 'object' });
      const userProperties = (schemaInfo.properties.user as JSONSchema.JsonSchema7Object).properties;
      expect(userProperties).toHaveProperty('id');
      expect(userProperties).toHaveProperty('name');
      expect(schemaInfo.properties.tags).toMatchObject({ type: 'array' });
    });

    it('works with MinionEvents', () => {
      const schemaInfo = getEventSchemaInfo(MinionEvents.TurnComplete) as JSONSchema.JsonSchema7Object;

      expect(schemaInfo).toBeDefined();
      expect(schemaInfo.type).toBe('object');
      expect(schemaInfo.properties).toHaveProperty('minionId');
      expect(schemaInfo.properties.minionId).toMatchObject({ type: 'string' });
    });

    it('handles StatusChange literals correctly', () => {
      const schemaInfo = getEventSchemaInfo(MinionEvents.StatusChange) as JSONSchema.JsonSchema7Object;

      expect(schemaInfo).toBeDefined();
      expect(schemaInfo.properties).toHaveProperty('oldStatus');
      expect(schemaInfo.properties).toHaveProperty('newStatus');
    });
  });
});
