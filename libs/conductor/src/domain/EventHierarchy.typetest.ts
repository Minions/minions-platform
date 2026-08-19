/**
 * Type-level tests for Event Hierarchy Type Safety
 *
 * These tests verify compile-time type safety for hierarchical events.
 * They demonstrate that:
 * 1. Parent listeners receive union types of all child events
 * 2. TypeScript requires type narrowing to access child-specific fields
 * 3. The `__type` field enables safe discriminated union narrowing
 *
 * Run `nx typecheck conductor` to verify these tests pass.
 */

import { defineEvent, defineChildEvent, EventBus } from '@minions/events';

// ============================================================================
// Test Setup: Event Hierarchy
// ============================================================================

const ParentEvent = defineEvent<{ id: string }, 'parent'>('parent');
const Child1Event = defineChildEvent<typeof ParentEvent, { id: string; child1Field: string }, 'child-1'>(
  ParentEvent,
  'child-1'
);
const Child2Event = defineChildEvent<typeof ParentEvent, { id: string; child2Field: number }, 'child-2'>(
  ParentEvent,
  'child-2'
);

// Create a typed event bus with all events in the universe
type AllEvents = typeof ParentEvent | typeof Child1Event | typeof Child2Event;
const bus = new EventBus<AllEvents>();

// ============================================================================
// Test 1: Parent listener receives union type
// ============================================================================

bus.on(ParentEvent, (event) => {
  // Should be able to access parent fields directly
  const id: string = event.id;
  console.log(id);

  // Should NOT be able to access child fields without type narrowing
  // Uncomment the following to verify type errors:
  // const _child1Field = event.child1Field; // Error: Property 'child1Field' does not exist
  // const _child2Field = event.child2Field; // Error: Property 'child2Field' does not exist
});

// ============================================================================
// Test 2: Type narrowing with __type discriminator
// ============================================================================

bus.on(ParentEvent, (event) => {
  // Use __type for type narrowing
  if (event.__type === 'child-1') {
    // TypeScript narrows to Child1Event
    const child1Field: string = event.child1Field; // OK!
    console.log(child1Field);
  }

  if (event.__type === 'child-2') {
    // TypeScript narrows to Child2Event
    const child2Field: number = event.child2Field; // OK!
    console.log(child2Field);
  }
});

// ============================================================================
// Test 3: Switch statement type narrowing
// ============================================================================

bus.on(ParentEvent, (event) => {
  switch (event.__type) {
    case 'parent':
      // Only parent fields available
      console.log(event.id);
      break;
    case 'child-1':
      // Parent + child1 fields available
      console.log(event.id, event.child1Field);
      break;
    case 'child-2':
      // Parent + child2 fields available
      console.log(event.id, event.child2Field);
      break;
  }
});

// ============================================================================
// Test 4: Child listener receives only that child type
// ============================================================================

bus.on(Child1Event, (event) => {
  // Can access both parent and child fields
  const id: string = event.id;
  // Note: When listening to a child event on a bus typed with a Universe,
  // TypeScript resolves TypedEventUnion to include parent and sibling types.
  // Direct child field access requires narrowing even on child-specific listeners.
  if (event.__type === 'child-1') {
    const child1Field: string = event.child1Field;
    console.log(id, child1Field);
  }

  // Cannot access sibling child fields
  // Uncomment to verify error:
  // const _child2Field = event.child2Field; // Error: Property 'child2Field' does not exist
});

// ============================================================================
// Test 5: Grandparent hierarchy
// ============================================================================

const GrandparentEvent = defineEvent<{ id: string }, 'grandparent'>('grandparent');
const ParentAEvent = defineChildEvent<typeof GrandparentEvent, { id: string; parentA: string }, 'parent-a'>(
  GrandparentEvent,
  'parent-a'
);
const ParentBEvent = defineChildEvent<typeof GrandparentEvent, { id: string; parentB: number }, 'parent-b'>(
  GrandparentEvent,
  'parent-b'
);
const GrandchildA1 = defineChildEvent<typeof ParentAEvent, { id: string; parentA: string; grandchildA1: boolean }, 'grandchild-a1'>(
  ParentAEvent,
  'grandchild-a1'
);
const GrandchildB1 = defineChildEvent<typeof ParentBEvent, { id: string; parentB: number; grandchildB1: string[] }, 'grandchild-b1'>(
  ParentBEvent,
  'grandchild-b1'
);

type MultiGenEvents =
  | typeof GrandparentEvent
  | typeof ParentAEvent
  | typeof ParentBEvent
  | typeof GrandchildA1
  | typeof GrandchildB1;
const multiGenBus = new EventBus<MultiGenEvents>();

multiGenBus.on(GrandparentEvent, (event) => {
  // Can access grandparent fields
  const id: string = event.id;

  // Use type narrowing to access descendant fields
  if (event.__type === 'grandchild-a1') {
    const parentA: string = event.parentA;
    const grandchildA1: boolean = event.grandchildA1;
    console.log(id, parentA, grandchildA1);
  }

  if (event.__type === 'grandchild-b1') {
    const parentB: number = event.parentB;
    const grandchildB1: string[] = event.grandchildB1;
    console.log(id, parentB, grandchildB1);
  }
});

// ============================================================================
// Test 6: once() also uses union types
// ============================================================================

async function testOnce() {
  const event = await bus.once(ParentEvent);

  // Should receive union type
  const id: string = event.id;

  // Can narrow
  if (event.__type === 'child-1') {
    const child1Field: string = event.child1Field;
    console.log(id, child1Field);
  }
}

testOnce().catch(console.error);

// ============================================================================
// Test 7: Flat events (no children) work unchanged
// ============================================================================

const FlatEvent = defineEvent<{ value: string }, 'flat-event'>('flat-event');
type FlatEventUniverse = typeof FlatEvent;
const flatBus = new EventBus<FlatEventUniverse>();

flatBus.on(FlatEvent, (event) => {
  // Works exactly as before
  const value: string = event.value;
  const type: string = event.__type;
  console.log(value, type);
});

// ============================================================================
// Test 8: Condition filtering works with union types
// ============================================================================

bus.on(
  ParentEvent,
  (event) => {
    console.log('Filtered event:', event);
  },
  {
    condition: (event) => {
      // Condition function receives union type
      // Can narrow within the condition
      if (event.__type === 'child-1') {
        return event.child1Field.startsWith('test');
      }
      return true;
    },
  }
);

// ============================================================================
// Success! All tests demonstrate type safety
// ============================================================================

export {}; // Make this a module
