# Events Domain Architecture

The events package (`@minions/events`) is a hexagonal domain providing the event declaration system and event bus for the minions system.

## Hexagonal Architecture

This package follows hexagonal (ports and adapters) architecture:

```
                    ┌─────────────────────────────┐
                    │      Events Domain          │
                    │                             │
                    │  ┌─────────────────────┐    │
                    │  │    Core (Domain)    │    │
                    │  │                     │    │
                    │  │  EventDeclaration   │    │
                    │  │  IEventBus          │    │
                    │  │  EventBusEvents     │    │
                    │  │  Src constants      │    │
                    │  └─────────────────────┘    │
                    │            │                │
                    │  ┌─────────────────────┐    │
                    │  │   Implementation    │    │
                    │  │                     │    │
                    │  │  EventBus           │    │
                    │  │  (Effect PubSub)    │    │
                    │  └─────────────────────┘    │
                    │                             │
                    └─────────────────────────────┘
                                 │
              Uses Effect APIs (port to infrastructure)
```

## Domain Responsibilities

The events domain owns:

1. **Event Declaration System** - Type-safe event definition with Schema validation
2. **Event Bus Interface** - `IEventBus` port for pub/sub messaging
3. **Event Bus Implementation** - `EventBus` adapter built on Effect's PubSub
4. **Source Filtering** - `Src.AnyMinion`, `Src.Any` wildcards for subscription filtering
5. **Infrastructure Events** - `EventBusEvents.HandlerError` for error observability

## Domain Boundaries

### What This Domain Owns

- Event declaration types and helpers (`defineEvent`, `defineChildEvent`)
- Event bus interface and implementation
- Source filtering constants
- Handler error infrastructure event

### What Other Domains Own

Each domain defines its own events:

- **Hatchery domain** (`@minions/hatchery`): `MinionEvents` (TurnComplete, GadgetUse, StatusChange, Died)
- **Conductor domain** (`@minions/conductor`): `MissionEvents` (MissionStarted, MissionCompleted, etc.)

This follows the principle that **each domain owns its data and events**.

## Dependencies

This domain has minimal dependencies:

```
@minions/events
    └── effect (infrastructure)
```

The events domain depends **only** on Effect for its infrastructure needs (PubSub, Stream, Scope, Schema). It has **no dependencies** on other minions packages.

## Recommended Integration Pattern

Other domains should integrate with events using ports and adapters:

```typescript
// In your domain's port definition
import type { IEventBus } from '@minions/events';

interface IMyDomainContext {
  events: IEventBus;  // Port: receives the event bus instance
}

// In your domain's event definitions
import { defineEvent } from '@minions/events';
import { Schema } from 'effect';

export const MyDomainEvents = {
  SomethingHappened: defineEvent<{ id: string }>(
    'something-happened',
    Schema.Struct({ id: Schema.String })
  ),
};

// Usage in domain code
function handleSomething(ctx: IMyDomainContext) {
  ctx.events.emit(MyDomainEvents.SomethingHappened, { id: '123' });
}
```

This pattern ensures:
- Domains receive the event bus instance through their context
- Domains define their own events (domain ownership)
- The events package provides the infrastructure without coupling

## Testing

The events domain can be tested in isolation:

```typescript
import { EventBus, defineEvent, Src } from '@minions/events';

describe('EventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new EventBus();
    const TestEvent = defineEvent<{ value: number }>('test');

    const received: number[] = [];
    bus.on(TestEvent, (e) => received.push(e.value));

    bus.emit(TestEvent, { value: 42 });

    expect(received).toEqual([42]);
  });
});
```

Other domains test their event usage through their own adapters, providing a real or mock event bus.

## Key Design Decisions

1. **Effect PubSub** - Uses Effect's PubSub primitive for reliable, typed pub/sub
2. **Schema Validation** - Events with schemas are validated at emit time
3. **Source Tracking** - All events tagged with source for filtering
4. **Hierarchical Events** - Child events can be defined that inherit parent subscriptions
5. **Handler Error Isolation** - Failing handlers don't prevent other handlers from running
