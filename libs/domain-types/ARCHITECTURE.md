# Domain Types Architecture

## Purpose

The `@minions/domain-types` package provides the shared domain types that define "what a minion is" in the minions ecosystem. This package exists to break the circular peer dependency that would otherwise exist between `@minions/conductor` and `@minions/hatchery`.

## Role in the Architecture

Domain-types is the **shared contract** between different parts of the minions system:

```
@minions/domain-types (shared contract)
        ↑               ↑
        │               │
        │               │
@minions/conductor  @minions/hatchery
(orchestrates)      (spawns)
```

**Without domain-types**, we would have a circular dependency:
- Conductor needs IMinion to orchestrate minions
- Hatchery needs to create IMinion implementations
- Conductor needs Hatchery to spawn minions
- Result: conductor ↔ hatchery circular dependency ❌

**With domain-types**, the dependency flow is clean:
- Domain-types defines the contract (IMinion, MinionSpec, MinionMessage)
- Both conductor and hatchery depend on domain-types
- No circular dependency ✓

## Core Types

### IMinion Interface

The core abstraction for bidirectional async communication with AI agents.

```typescript
interface IMinion {
  readonly id: string;
  readonly spec: MinionSpec;
  readonly costume?: Costume;

  send(message: MinionMessage): Promise<void>;
  receive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage>;
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never>;

  readonly status: 'processing' | 'waiting' | 'dead';
  kill(): void;
  interrupt(): void;
}
```

**Key characteristics**:
- Returns Effects for operations (reconfigure)
- Uses DTOs for data (MinionMessage)
- Provides co-routine abstraction (send/receive)

### MinionSpec

Declarative specification for creating a minion.

```typescript
interface MinionSpec {
  client: MinionClient;
  wing: string;
  model: string;
  useBuiltInSystemPrompt: boolean;
  agentPrompt?: string;
  tools?: Tool[];
  name?: string;
  metadata?: Record<string, any>;
  costume?: Costume;
}
```

**Dependency on Costume**: MinionSpec imports `Costume` from `@minions/costumes`. This is acceptable because:
- Costume is a shared domain type (like domain-types)
- Both conductor and hatchery already depend on costumes
- Costume defines minion configuration, which is part of the spawn specification

### MinionMessage

Union type for all message types in bidirectional communication.

```typescript
type MinionMessage =
  | UserMessage
  | TextMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | ErrorMessage
  | StatusMessage;
```

**Key characteristics**:
- DTOs (plain objects, serializable)
- No translation performed (raw AI client communication)
- Forward-compatible (new message types can be added)

## Domain Boundaries

### What Domain-Types Defines

Domain-types defines:
- **What a minion is**: IMinion interface
- **How to specify a minion**: MinionSpec
- **How to communicate with a minion**: MinionMessage types

Domain-types does NOT define:
- How to spawn a minion (that's hatchery's responsibility)
- How to orchestrate minions (that's conductor's responsibility)
- Specific client implementations (that's hatchery/adapters)

### Dependencies

**Domain-types depends on**:
- `effect`: For Effect-based operations and error handling
- `@minions/costumes`: For Costume type (shared domain)

**Domain-types does NOT depend on**:
- `@minions/conductor`: Would create circular dependency
- `@minions/hatchery`: Would create circular dependency
- Any infrastructure or adapter packages

### Who Depends on Domain-Types

**Packages that depend on domain-types**:
- `@minions/conductor`: Uses IMinion for orchestration
- `@minions/hatchery`: Implements IMinion in adapters
- Any package that works with minions

## Effect-Based Port Pattern

Domain-types demonstrates the Effect-based port pattern used throughout the minions architecture.

### Core Principle: Effects for Operations, DTOs for Data

Ports in the minions system follow a consistent pattern:
- **Port methods return Effects** for operation lifecycle (composition, error handling, resource management)
- **Data crossing boundaries uses DTOs** (plain objects, serializable, forward-compatible)

This pattern clarifies the distinction between:
- **Operations** (how you invoke behavior) → Effects
- **Data** (what you pass/receive) → DTOs

### IMinion Interface: Effect-Based Port Example

```typescript
interface IMinion {
  readonly id: string;                    // Property: plain value
  readonly spec: MinionSpec;              // Property: DTO
  readonly costume?: Costume;             // Property: DTO

  // Operation: returns Effect for composition and error handling
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never>;

  // Operation: returns Promise (simpler operations use Promises)
  send(message: MinionMessage): Promise<void>;

  // Stream: returns AsyncIterableIterator for reactive data
  receive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage>;

  readonly status: 'processing' | 'waiting' | 'dead';  // Property: plain value
  kill(): void;                           // Operation: void (fire and forget)
  interrupt(): void;                      // Operation: void (fire and forget)
}
```

**Key observations**:
1. **reconfigure returns Effect**: Complex operation needing error handling (ReconfigureError)
2. **send returns Promise**: Simple async operation, Promise is sufficient
3. **receive returns AsyncIterableIterator**: Continuous data stream (could also be Effect.Stream)
4. **Data parameters are DTOs**: `message: MinionMessage`, `costume: Costume` are plain objects

### When to Use Effects vs Promises

**Use Effect when**:
- Operation has multiple error types to distinguish
- Operation needs composition with other Effects
- Operation requires resource management (acquire/release)
- Operation has complex error handling needs

**Use Promise when**:
- Simple async operation with single error type
- Operation integrates with existing Promise-based code
- Complexity of Effect is not justified

**Use void when**:
- Fire-and-forget operations
- No result needed
- Error handling is not critical

### DTOs: Data Transfer Objects

All data crossing port boundaries uses DTOs:

```typescript
// MinionMessage: Union of plain object types
type MinionMessage =
  | UserMessage      // { role: 'user', content: string }
  | TextMessage      // { role: 'assistant', content: string }
  | ThinkingMessage  // { role: 'assistant', thinking: string }
  | ToolUseMessage   // { role: 'assistant', tool: string, input: any }
  | ToolResultMessage // { role: 'tool', result: any }
  | ErrorMessage     // { role: 'error', error: string }
  | StatusMessage;   // { role: 'status', status: string }

// MinionSpec: Plain object specification
interface MinionSpec {
  client: MinionClient;
  wing: string;
  model: string;
  costume?: Costume;
  // ... all plain, serializable fields
}
```

**DTO characteristics**:
- **Plain objects**: No methods, only data
- **Serializable**: Can be JSON.stringify'd
- **Forward-compatible**: New fields can be added without breaking old code
- **No Effect runtime needed**: Data is just data

### Why This Pattern Matters

**Clarity**: It's immediately clear what's an operation (Effect/Promise) vs what's data (DTO)

**Composability**: Effects compose naturally with other Effects in mission orchestration

**Error handling**: Effects provide typed error handling, DTOs don't throw

**Testing**: DTOs are easy to construct, Effects are easy to test with Effect.runPromise

**Serialization**: DTOs cross boundaries (network, process), Effects stay local

### Examples in Practice

**Spawning a minion** (using IHatchery port):
```typescript
// Operation returns Effect, data is DTO
const spawnEffect: Effect.Effect<IMinion, SpawnError, never> =
  hatchery.spawn(minionSpec);  // minionSpec is DTO

// Run the Effect to get the minion
const minion = await Effect.runPromise(spawnEffect);

// Send data (DTO) to minion
await minion.send({ role: 'user', content: 'Hello' });

// Receive data (DTO stream)
for await (const message of minion.receive()) {
  console.log(message);  // message is DTO
}
```

**Reconfiguring a minion**:
```typescript
// Operation returns Effect, data is DTO
const reconfigureEffect: Effect.Effect<void, ReconfigureError, never> =
  minion.reconfigure(newCostume);  // newCostume is DTO

// Compose with other Effects
const composedEffect = Effect.gen(function* () {
  yield* minion.reconfigure(newCostume);
  yield* workbench.addFact(category, fact);
  return 'done';
});

await Effect.runPromise(composedEffect);
```

### Contrast: "Object-Based API" vs "Effect-Based API"

This terminology caused confusion. Here's the clarification:

**Not "Object-Based API"**: This sounds like methods return objects, which is vague

**Not "Effect-Based API"**: This sounds like everything is an Effect, which is false

**Correct: "Effect-Based Port Pattern"**:
- Ports are interfaces (not implementations)
- Port methods return Effects for operations
- Port data parameters/returns are DTOs (plain objects)

The pattern is about **when to use Effects** (operations) and **when to use DTOs** (data).

## Testing Strategy

Domain-types includes tests that verify:
1. No imports from conductor or hatchery packages
2. Type definitions are correct and compile
3. DTOs are serializable (plain objects)

See `src/__tests__/domain-boundaries.test.ts` for boundary verification tests.

## Design Decisions

### Why a Separate Package?

**Alternative considered**: Keep types in hatchery or conductor
**Decision**: Extract to separate package
**Rationale**:
- Breaks circular dependency (critical)
- Makes dependency direction explicit
- Allows both packages to depend on shared contract
- Follows dependency inversion principle

### Why Minimal Package?

**Alternative considered**: Extract all shared types to domain-types
**Decision**: Only extract types that break circular dependency
**Rationale**:
- Keep package focused (IMinion, MinionSpec, MinionMessage only)
- Avoid creating a "dumping ground" for shared code
- Other shared types can live in their own packages (e.g., costumes)

### Why Allow Costume Dependency?

**Alternative considered**: Extract Costume to domain-types
**Decision**: MinionSpec imports Costume from @minions/costumes
**Rationale**:
- Costume is already a separate, well-isolated package
- Both conductor and hatchery already depend on costumes
- Costume is shared domain (like domain-types)
- No benefit to moving it into domain-types

## Future Considerations

### Potential Additions

If new types create circular dependencies, consider adding to domain-types:
- New minion-related interfaces
- New message types for communication
- New error types for minion operations

### What Should NOT Be Added

Do not add to domain-types:
- Implementation details (keep those in hatchery/adapters)
- Orchestration logic (keep in conductor)
- Infrastructure concerns (keep in respective packages)

### Package Growth

If domain-types grows beyond 10-15 types, consider splitting:
- `@minions/domain-types` (core interfaces)
- `@minions/minion-messages` (message DTOs)
- `@minions/minion-specs` (specification types)

For now, keep the package minimal and focused.
