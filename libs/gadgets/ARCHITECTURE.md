# @minions/gadgets Architecture

## Purpose

The `@minions/gadgets` package defines the domain types for executable gadgets - tools with mission context that can be injected into minions at spawn time. This package establishes the clean architectural boundary between conductor (which creates gadgets with context) and hatchery (which executes gadgets without knowing about context).

## Core Concepts

### What is a Gadget?

A **gadget** is an executable tool with mission context. It combines:
1. **Tool definition** - metadata describing what the tool is and what it accepts (MCP-compatible)
2. **Executable implementation** - an Effect-based function that captures mission context in a closure

Gadgets differ from costume tools:
- **Costume tools** (`Tool[]` in Costume) - type definitions only, no implementation
- **Executable gadgets** (`ExecutableGadget[]`) - runtime closures with mission context

### Architectural Boundaries

```
┌─────────────────┐
│   @minions/     │  ← Domain types only
│    gadgets      │  ← Depends only on Effect
└────────┬────────┘
         │
         │ defines ExecutableGadget interface
         │
    ┌────┴───────────────────────────┐
    ↓                                ↓
┌─────────────────┐         ┌───────────────┐
│   conductor     │         │   hatchery    │
│   (creates)     │         │   (executes)  │
└─────────────────┘         └───────────────┘
```

### Key Design Decisions

#### 1. Effect-Based, No Error Channel

```typescript
execute: (input: unknown) => Effect<ToolResult, never, never>
```

Gadgets return `Effect<ToolResult, never, never>`:
- **Success path**: `{ success: true, result: unknown }`
- **Failure path**: `{ success: false, error: string }`

Errors are captured in the ToolResult, not thrown, making them visible to the AI model for retry logic.

#### 2. Synchronous Execution Model

Gadget execution is synchronous from the hatchery's perspective:
1. Hatchery receives tool call from AI
2. Hatchery calls `gadget.execute(input)`
3. Hatchery runs the Effect immediately
4. Hatchery returns ToolResult to AI

This works well for fast operations like event emission. Long-running gadgets may require rethinking.

#### 3. Context via Closures

Gadgets capture mission context (costume, event bus, minion ID) in closures:

```typescript
const createEmitEventGadget = (
  costume: Costume,
  eventBus: IEventBus,
  minionId: string
): ExecutableGadget => ({
  tool: { name: 'emit_event', ... },
  execute: (input) => Effect.gen(function* () {
    // Has access to costume, eventBus, minionId via closure
    const event = yield* validateAgainstCostume(input, costume);
    yield* eventBus.emitFrom(event, minionId);
    return { success: true, result: 'Event emitted' };
  })
});
```

Hatchery never sees the context - it's encapsulated in the gadget.

#### 4. Factory Pattern

Gadget creation uses the factory pattern:

```typescript
type GadgetFactory<TContext> = (context: TContext) => ExecutableGadget[]
```

This separates:
- **Conductor concerns**: What context to provide (costume, event bus)
- **Gadget implementations**: How to use that context

## Dependencies

### This Package Depends On
- `effect` - Effect system for functional composition

### This Package Does NOT Depend On
- `@minions/conductor` - gadget implementations live there
- `@minions/hatchery` - gadget execution lives there
- `@minions/domain-types` - kept separate to avoid circular dependencies
- `@minions/costumes` - costume is just one type of context

This minimal dependency footprint ensures clean architectural boundaries.

## Usage Patterns

### Creating Gadgets (Conductor)

```typescript
import { ExecutableGadget, ToolResult } from '@minions/gadgets';
import { Effect } from 'effect';

export const createEventGadgets = (
  costume: Costume,
  eventBus: IEventBus,
  minionId: string
): ExecutableGadget[] => [
  {
    tool: {
      name: 'get_event_schema',
      description: 'Get the JSON schema for an event type',
      input_schema: {
        type: 'object',
        properties: {
          eventType: { type: 'string' }
        },
        required: ['eventType']
      }
    },
    execute: (input) => Effect.gen(function* () {
      // Implementation uses costume via closure
      const schema = getEventSchemaInfo(input.eventType, costume);
      if (!schema) {
        return { success: false, error: 'Event type not found' };
      }
      return { success: true, result: schema };
    })
  },
  // ... more gadgets
];
```

### Executing Gadgets (Hatchery)

```typescript
import { ExecutableGadget, ToolResult } from '@minions/gadgets';
import { Effect } from 'effect';

class RealMinion {
  constructor(
    private spec: MinionSpec,
    private executableGadgets: ExecutableGadget[] = []
  ) {}

  async executeGadget(toolName: string, input: unknown): Promise<ToolResult> {
    const gadget = this.executableGadgets.find(g => g.tool.name === toolName);
    if (!gadget) {
      return { success: false, error: `Gadget ${toolName} not found` };
    }

    // Run the Effect and return the ToolResult
    return await Effect.runPromise(gadget.execute(input));
  }
}
```

### Auto-Injection at Spawn (Conductor)

```typescript
// In DefaultMissionContext.spawn()
const spec: ExtendedMinionSpec = buildSpecFromCostume(costume);

if (costume.events && costume.events.length > 0) {
  // Create executable gadgets with mission context
  const eventGadgets = createEventGadgets(costume, this.eventBus, minionId);

  // Add tool definitions to spec (AI sees these)
  spec.tools = [...(spec.tools || []), ...eventGadgets.map(g => g.tool)];

  // Store executable implementations (hatchery uses these)
  spec.executableGadgets = eventGadgets;
}

await this.hatchery.spawn(spec);
```

## Design Tradeoffs

### Gadget-Conductor Coupling
**Tradeoff**: Gadget implementations require conductor dependencies (EventBus, Costume), but live in conductor's adapters layer.

**Why**: The `@minions/gadgets` package provides the clean boundary with pure interfaces. Implementations needing conductor concerns naturally live in conductor.

**Alternative Considered**: Create separate `@minions/gadgets-impl` package. Rejected because it adds unnecessary indirection without meaningful separation.

### Synchronous Execution
**Tradeoff**: Gadget execution blocks until the Effect completes.

**Why**: Simple and sufficient for fast operations like event emission. Clear control flow.

**Future**: If long-running gadgets are needed, we can add async support without breaking the interface:
```typescript
execute: (input: unknown) => Effect<ToolResult | AsyncHandle, never, never>
```

### String Errors
**Tradeoff**: ToolResult uses `error: string` instead of structured error types.

**Why**: Simple and sufficient. AI models work well with descriptive error strings.

**Future**: Can expand to structured errors if needed:
```typescript
type ToolResult =
  | { success: true; result: unknown }
  | { success: false; error: string; errorCode?: string; details?: unknown }
```

## Future Evolution

### Event-Driven Gadgets
If gadgets need to emit events themselves (not just respond to tool calls), we can add:
```typescript
interface EventEmittingGadget extends ExecutableGadget {
  onEvent?: (event: TypedEvent<any>) => Effect<void, never, never>;
}
```

### Stateful Gadgets
If gadgets need to maintain state across calls:
```typescript
interface StatefulGadget<TState> extends ExecutableGadget {
  state: TState;
  onStateChange?: (oldState: TState, newState: TState) => Effect<void, never, never>;
}
```

### Streaming Results
If gadgets need to stream results incrementally:
```typescript
execute: (input: unknown) => Stream<ToolResultChunk, never, never>
```

All of these can be added without breaking the core ExecutableGadget interface.

## Testing

### Unit Testing Gadgets

```typescript
import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';

describe('emit_event gadget', () => {
  it('returns success for valid event', async () => {
    const gadget = createEmitEventGadget(costume, mockEventBus, 'minion-1');

    const result = await Effect.runPromise(
      gadget.execute({ eventType: 'task-complete', payload: { taskId: '123' } })
    );

    expect(result).toEqual({ success: true, result: 'Event emitted' });
  });

  it('returns error for invalid event type', async () => {
    const gadget = createEmitEventGadget(costume, mockEventBus, 'minion-1');

    const result = await Effect.runPromise(
      gadget.execute({ eventType: 'unknown', payload: {} })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Event type not found');
  });
});
```

### Integration Testing with Minions

```typescript
describe('event gadget integration', () => {
  it('minion can emit event via gadget', async () => {
    const mission = await conductor.createMission(costumeWithEvents);
    const minion = await mission.spawn();

    // Simulate minion calling gadget
    await minion.send('/use tool emit_event with {"eventType": "progress", "payload": {...}}');

    // Verify event appears on mission bus
    const events = await mission.events.waitFor('progress', { timeout: 1000 });
    expect(events).toHaveLength(1);
  });
});
```

## Summary

The `@minions/gadgets` package establishes the architectural boundary for executable tools with mission context:

1. **Clean separation**: Domain types only, no implementations
2. **Minimal dependencies**: Effect only, no conductor/hatchery coupling
3. **Context via closures**: Hatchery executes, never sees context
4. **Effect-based**: Composable, testable, functional
5. **Error as data**: ToolResult makes errors visible to AI

This foundation supports current event gadgets and future gadget types without architectural changes.
