# Hatchery Architecture

## Purpose

The `@minions/hatchery` package provides the infrastructure for spawning and managing AI minions. Hatchery defines "how we spawn a minion" through adapters that integrate with various AI client types.

## Role in the Architecture

Hatchery is the **infrastructure adapter layer** for the minions system:

```
@minions/domain-types (shared contract - what a minion is)
        ↑
        │ implements
        │
@minions/hatchery (infrastructure - how we spawn one)
        │
        ├─ Ports (interfaces for extension)
        │   ├─ IHatchery
        │   └─ IMinionClient
        │
        └─ Adapters (implementations)
            ├─ Hatcheries
            │   ├─ ProductionHatchery
            │   └─ ZombieHatchery (test fake)
            │
            ├─ Clients
            │   ├─ ClaudeCodeClient
            │   ├─ OpenCodeClient
            │   └─ (more to come)
            │
            └─ Minions
                ├─ RealMinion (wraps IMinionClient)
                └─ BrainlessMinion (test fake)
```

## Hexagonal Architecture

Hatchery follows hexagonal (ports & adapters) architecture:

### Domain Layer (from @minions/domain-types)

```typescript
// IMinion - The core port interface
interface IMinion {
  send(message: MinionMessage): Promise<void>;
  receive(): AsyncIterableIterator<MinionMessage>;
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never>;
  kill(): void;
  interrupt(): void;
}

// MinionSpec - Declarative spawn specification
interface MinionSpec {
  client: MinionClient;
  wing: string;
  model: string;
  costume?: Costume;
  // ... other properties
}
```

**Key insight**: These types are in `@minions/domain-types`, not hatchery. Hatchery implements them.

### Port Layer (in hatchery/src/ports)

```typescript
// IHatchery - Port for spawning minions
interface IHatchery {
  spawn(spec: MinionSpec): Promise<IMinion>;
}

// IMinionClient - Port for AI client adapters
interface IMinionClient {
  start(spec: MinionSpec): Promise<void>;
  send(message: MinionMessage): Promise<void>;
  receive(): AsyncIterableIterator<MinionMessage>;
  stop(): Promise<void>;
  interrupt(): void;
}
```

**Key characteristics**:
- IHatchery abstracts spawn strategy
- IMinionClient abstracts AI client communication
- Both use types from domain-types (IMinion, MinionSpec, MinionMessage)

### Adapter Layer (in hatchery/src/adapters)

#### Hatchery Adapters

**ProductionHatchery** (`adapters/hatcheries/ProductionHatchery.ts`)
- Spawns real minions for production use
- Creates IMinionClient based on spec.client
- Wraps client in RealMinion adapter

**ZombieHatchery** (`adapters/hatcheries/ZombieHatchery.ts`)
- Test fake for testing mission coordination
- Spawns BrainlessMinion instances
- Emits 'spawn' events for test observability

#### Client Adapters

**ClaudeCodeClient** (`adapters/clients/ClaudeCodeClient.ts`)
- Spawns `claude` CLI process
- Communicates via stream-json protocol
- Implements bidirectional message streaming

**OpenCodeClient** (`adapters/clients/OpenCodeClient.ts`)
- Spawns OpenCode CLI process
- Similar stream-json protocol
- Alternative AI client implementation

**More clients to come**:
- AnthropicAgenticClient (direct SDK)
- CodePuppyClient
- Others as needed

#### Minion Adapters

**RealMinion** (`adapters/minions/RealMinion.ts`)
- Wraps IMinionClient with IMinion interface
- Manages minion lifecycle (status, kill, interrupt)
- Coordinates send/receive with underlying client
- Implements costume reconfiguration

**BrainlessMinion** (`adapters/minions/BrainlessMinion.ts`)
- Test fake with dual co-routines
- No actual AI client involved
- Enables deterministic testing

## Domain Boundaries

### What Hatchery Defines

Hatchery defines:
- **How to spawn a minion**: IHatchery port, ProductionHatchery adapter
- **How to integrate with AI clients**: IMinionClient port, client adapters
- **Lifecycle management**: Start, stop, status tracking
- **Adapter implementations**: RealMinion, BrainlessMinion

Hatchery does NOT define:
- What a minion is (that's in domain-types)
- How to orchestrate minions (that's in conductor)
- Mission execution logic (that's in conductor)

### Dependencies

**Hatchery depends on**:
- `@minions/domain-types`: For IMinion, MinionSpec, MinionMessage
- `@minions/costumes`: For Costume type (minion configuration)
- `effect`: For Effect-based operations

**Hatchery does NOT depend on**:
- `@minions/conductor`: Would create circular dependency
- Any business logic packages

### Who Depends on Hatchery

**Packages that depend on hatchery**:
- `@minions/conductor`: Uses IHatchery to spawn minions for missions
- Test suites: Use ZombieHatchery and BrainlessMinion for testing

## Key Design Patterns

### Adapter Pattern

Hatchery uses the adapter pattern to integrate diverse AI clients:

```typescript
// Client-specific implementation
class ClaudeCodeClient implements IMinionClient {
  async start(spec: MinionSpec): Promise<void> {
    // Spawn claude CLI process
    // Parse stream-json output
    // Handle bidirectional communication
  }
}

// Generic wrapper
class RealMinion implements IMinion {
  constructor(private client: IMinionClient) {}

  send(message: MinionMessage): Promise<void> {
    return this.client.send(message);
  }

  receive(): AsyncIterableIterator<MinionMessage> {
    return this.client.receive();
  }
}
```

**Benefits**:
- Client-specific logic isolated in adapters
- RealMinion provides consistent IMinion interface
- Easy to add new client types

### Factory Pattern

ProductionHatchery uses factory pattern to create appropriate clients:

```typescript
class ProductionHatchery implements IHatchery {
  async spawn(spec: MinionSpec): Promise<IMinion> {
    const client = this.createClient(spec.client);
    await client.start(spec);
    return new RealMinion(client, spec);
  }

  private createClient(type: MinionClient): IMinionClient {
    switch (type) {
      case 'claude-code': return new ClaudeCodeClient();
      case 'opencode': return new OpenCodeClient();
      // ... more clients
    }
  }
}
```

### Test Fake Pattern

ZombieHatchery and BrainlessMinion provide test fakes:

```typescript
// Test fake hatchery
class ZombieHatchery implements IHatchery {
  async spawn(spec: MinionSpec): Promise<IMinion> {
    const minion = new BrainlessMinion(spec);
    this.emit('spawn', minion, spec); // Observability
    return minion;
  }
}

// Test fake minion with dual co-routines
class BrainlessMinion implements IMinion {
  // Front-side: production code API
  async send(message: MinionMessage): Promise<void> { /* ... */ }
  receive(): AsyncIterableIterator<MinionMessage> { /* ... */ }

  // Back-side: test control API
  sendFromBackside(message: MinionMessage): void { /* ... */ }
  receiveFromBackside(): AsyncIterableIterator<MinionMessage> { /* ... */ }
}
```

**Benefits**:
- Deterministic testing without real AI clients
- Test control via back-side API
- Fast, reliable tests

## Effect-Based Port Pattern

Hatchery implements the Effect-based port pattern established in domain-types and used throughout the minions architecture.

### Core Principle: Effects for Operations, DTOs for Data

Hatchery's ports follow a consistent pattern:
- **Port methods return Effects** for operation lifecycle (composition, error handling, resource management)
- **Data crossing boundaries uses DTOs** (plain objects, serializable, forward-compatible)

This pattern clarifies the distinction between:
- **Operations** (how you invoke behavior) → Effects or Promises
- **Data** (what you pass/receive) → DTOs

### IHatchery Port: Effect-Based Example

```typescript
interface IHatchery {
  // Operation: spawning returns Effect (though currently Promise for compatibility)
  spawn(spec: MinionSpec): Promise<IMinion>;

  // Data parameter: spec is DTO (plain object)
  // Return value: IMinion port interface
}
```

**Note**: `spawn()` currently returns Promise rather than Effect for backwards compatibility. Future versions may return `Effect.Effect<IMinion, SpawnError, never>` for better composition.

### IMinionClient Port: Operations and Data

```typescript
interface IMinionClient {
  // Operations: lifecycle management
  start(spec: MinionSpec): Promise<void>;
  stop(): Promise<void>;
  interrupt(): void;

  // Operations: communication
  send(message: MinionMessage): Promise<void>;
  receive(): AsyncIterableIterator<MinionMessage>;

  // Data parameters: spec and message are DTOs
}
```

**Key observations**:
1. **Operations use Promises**: Simple async operations (start, stop, send)
2. **Data parameters are DTOs**: `spec: MinionSpec`, `message: MinionMessage` are plain objects
3. **Stream for continuous data**: `receive()` returns AsyncIterableIterator (could be Effect.Stream)

### IMinion Port: Effect-Based Reconfiguration

```typescript
interface IMinion {
  // Properties: plain values and DTOs
  readonly id: string;
  readonly spec: MinionSpec;
  readonly costume?: Costume;
  readonly status: 'processing' | 'waiting' | 'dead';

  // Operations: Effect for complex operation
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never>;

  // Operations: Promise for simple operations
  send(message: MinionMessage): Promise<void>;

  // Stream: continuous data
  receive(): AsyncIterableIterator<MinionMessage>;

  // Fire-and-forget: void operations
  kill(): void;
  interrupt(): void;
}
```

**Why reconfigure returns Effect**:
- Complex validation (model must match, costume must be valid)
- Multiple error types (ReconfigureError with different reasons)
- Composition with other Effects in mission orchestration
- Clear error handling semantics

**Why send/receive use Promises/AsyncIterableIterator**:
- Simple operations, Promise is sufficient
- Integration with existing client implementations
- AsyncIterableIterator is standard for reactive streams

### DTOs in Hatchery

All data crossing port boundaries uses DTOs:

```typescript
// MinionSpec: Plain object for spawning
interface MinionSpec {
  client: MinionClient;
  wing: string;
  model: string;
  useBuiltInSystemPrompt: boolean;
  agentPrompt?: string;
  costume?: Costume;
  // ... all plain, serializable fields
}

// MinionMessage: Union of plain object types
type MinionMessage =
  | UserMessage
  | TextMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | ErrorMessage
  | StatusMessage;

// Costume: Plain object for configuration (from @minions/costumes)
interface Costume {
  model: string;
  systemPrompt?: string;
  gadgets?: Tool[];
  skills?: Skill[];
  events?: CostumeEvent[];
  injectFacts?: string[];
}
```

**DTO characteristics**:
- **Plain objects**: No methods, only data
- **Serializable**: Can be JSON.stringify'd
- **Forward-compatible**: New fields can be added without breaking old code
- **No Effect runtime needed**: Data is just data

### When to Use Effects vs Promises

**Use Effect when**:
- Operation has multiple error types to distinguish (ReconfigureError with variants)
- Operation needs composition with other Effects
- Operation requires resource management (acquire/release)
- Operation has complex error handling needs

**Use Promise when**:
- Simple async operation with single error type
- Operation integrates with existing Promise-based code
- Complexity of Effect is not justified

**Use void when**:
- Fire-and-forget operations (kill, interrupt)
- No result needed
- Error handling is not critical

### Examples in Practice

**Spawning a minion** (using IHatchery):
```typescript
// Operation: spawn
const hatchery = new ProductionHatchery();
const minion = await hatchery.spawn({
  client: 'claude-code',
  wing: '/path/to/wing',
  model: 'claude-sonnet-4-5',
  costume: developerCostume  // DTO
});

// minion is IMinion port interface
console.log(minion.id);         // plain value
console.log(minion.spec);       // DTO
console.log(minion.costume);    // DTO or undefined
```

**Reconfiguring a minion** (using IMinion with Effect):
```typescript
// Operation returns Effect, data is DTO
const reconfigureEffect: Effect.Effect<void, ReconfigureError, never> =
  minion.reconfigure(newCostume);  // newCostume is DTO

// Run the Effect
await Effect.runPromise(reconfigureEffect);

// Or handle errors explicitly
const result = await Effect.runPromise(
  reconfigureEffect.pipe(
    Effect.catchTag('ReconfigureError', error => {
      console.error('Reconfiguration failed:', error.reason);
      return Effect.void;
    })
  )
);
```

**Communicating with a minion** (using IMinion with Promises):
```typescript
// Send is simple Promise operation
await minion.send({ role: 'user', content: 'Hello' });

// Receive is AsyncIterableIterator stream
for await (const message of minion.receive()) {
  if (message.role === 'assistant' && 'content' in message) {
    console.log(message.content);  // message is DTO
  }
}
```

### Pattern Consistency

Hatchery follows the same pattern as other domains:

**domain-types** (shared):
- IMinion: `reconfigure()` returns Effect, DTOs for data

**conductor** (orchestration):
- IWorkbench: `addFile()`, `writeFile()` return Effects, DTOs for data
- EventBus: `emit()` returns Effect, event payloads are DTOs

**hatchery** (infrastructure):
- IHatchery: `spawn()` returns Promise (could be Effect), DTOs for data
- IMinionClient: operations return Promises, DTOs for data
- RealMinion: implements IMinion with Effect-based reconfigure

This consistency makes the architecture predictable across domains.

### Why This Pattern Matters

**Clarity**: Immediately clear what's an operation (Effect/Promise) vs data (DTO)

**Composability**: Effects compose naturally in mission orchestration:
```typescript
const setupMinion = Effect.gen(function* () {
  const minion = yield* Effect.promise(() => hatchery.spawn(spec));
  yield* minion.reconfigure(costume);
  return minion;
});
```

**Error handling**: Effects provide typed error handling:
```typescript
const result = await Effect.runPromise(
  minion.reconfigure(costume).pipe(
    Effect.catchTag('ModelMismatch', () => Effect.succeed(undefined)),
    Effect.catchTag('InvalidCostume', error => {
      console.error(error.message);
      return Effect.fail(error);
    })
  )
);
```

**Testing**: DTOs are easy to construct, Effects are easy to test:
```typescript
// Easy to construct test data
const testSpec: MinionSpec = {
  client: 'claude-code',
  wing: '/test',
  model: 'claude-sonnet-4-5',
  useBuiltInSystemPrompt: true
};

// Easy to test Effects
const result = await Effect.runPromise(minion.reconfigure(testCostume));
```

**Serialization**: DTOs cross process boundaries (spawn via CLI):
```typescript
// MinionSpec is serialized when spawning claude CLI
const args = [
  'code',
  '--model', spec.model,
  '--workspace', spec.wing,
  // ... spec is JSON-serializable
];
```

## Testing Strategy

### Unit Tests

Test individual adapters in isolation:
- ClaudeCodeClient tests verify stream-json parsing
- RealMinion tests verify IMinion implementation
- ProductionHatchery tests verify factory logic

### Contract Tests

Verify adapters conform to port interfaces:
- All IHatchery implementations pass same test suite
- All IMinionClient implementations pass same test suite
- All IMinion implementations pass same test suite

### Integration Tests

Test real client integration:
- Spawn actual claude process
- Verify bidirectional communication
- Test lifecycle (start, send, receive, stop)

### Fake Tests

Test using ZombieHatchery and BrainlessMinion:
- Fast, deterministic
- No external dependencies
- Full coverage of edge cases

## Minion Parity Principle

The minion parity principle ensures that all IMinion interface members are verified via contract tests, preventing BrainlessMinion from accumulating features that regular minion implementations don't support.

### Core Principle

**All changes to BrainlessMinion MUST be TDDed, and those tests MUST be part of the contract test suite, ensuring that all Minion implementations remain in sync.**

This principle is enforced through the parity verification test in `specs/contracts/minion-parity.spec.ts`.

### Full Parity Achievement

**Status**: As of 2026-01-17, full minion parity has been achieved across ALL minion implementations.

- **BrainlessMinion**: 16/16 contract tests passing
- **RealMinion**: 16/16 contract tests passing
- **Parity Verification**: All IMinion interface members covered by contract tests

Both implementations now pass identical contract tests, ensuring behavioral consistency across test fakes and production minions. This guarantees that any code written against the IMinion interface will work with either implementation.

### How It Works

1. **IMinion Interface Members**: All members of the IMinion interface are listed in `IMINION_INTERFACE_MEMBERS` constant
2. **Contract Coverage**: All tested members are listed in `CONTRACT_TESTED_MEMBERS` constant
3. **Parity Verification**: The parity test fails if any IMinion members are not covered by contract tests
4. **BrainlessMinion Constraints**: BrainlessMinion must not exceed the IMinion contract (test-only members are explicitly acknowledged)

### Adding New IMinion Members

When you add a new member to the IMinion interface:

1. Add it to `IMINION_INTERFACE_MEMBERS` in `minion-parity.spec.ts`
2. Add contract tests in `minion-contract.ts`
3. Update `CONTRACT_TESTED_MEMBERS` in `minion-parity.spec.ts`
4. Implement it in all minion implementations (RealMinion, BrainlessMinion)
5. Verify all implementations pass the contract tests

### BrainlessMinion-Specific Features

BrainlessMinion has test-only features that are NOT part of IMinion:

- **Test-side co-routine**: `testSend()`, `testReceive()`
- **Test-only state inspection**: `isAlive()`, `wasInterrupted()`, `getExecutableGadgets()`
- **Test-only actions**: `completeTurn()`
- **Constructor options**: `backSideCoRoutine`, `maxBufferSize`, `onTurnComplete`, `onStatusChange`, `executableGadgets`

These are explicitly listed in `BRAINLESS_ONLY_MEMBERS` and verified to not be part of IMinion.

### Adding BrainlessMinion Tests

When adding tests to `brainless-minion.spec.ts`:

1. **If testing IMinion behavior**:
   - Add the contract test in `minion-contract.ts`
   - Remove the test from `brainless-minion.spec.ts` (don't duplicate)

2. **If testing BrainlessMinion-specific behavior** (test helper features):
   - Add to `ACKNOWLEDGED_BRAINLESS_TESTS` with a comment explaining why

The parity test will fail if you add tests that look like IMinion behavior but aren't acknowledged or moved to contract tests.

### Benefits

- **Consistency**: All minion implementations support the same IMinion interface
- **Completeness**: All IMinion members have contract tests
- **Prevention**: BrainlessMinion can't drift beyond the IMinion contract
- **Documentation**: Clear distinction between IMinion behavior and test-helper features

## Costume Integration

Hatchery integrates with `@minions/costumes` for minion configuration:

```typescript
// MinionSpec includes costume
interface MinionSpec {
  costume?: Costume;
  // ... other properties
}

// RealMinion supports reconfiguration
class RealMinion implements IMinion {
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never> {
    // Validate model hasn't changed
    // Update costume configuration
    // Reconfigure underlying client
  }
}
```

**Key decisions**:
- Costume is in MinionSpec (declarative spawn)
- Reconfigure is in IMinion (runtime updates)
- Costume is shared domain (both conductor and hatchery use it)

## File Organization

```
hatchery/
├── src/
│   ├── ports/               # Port interfaces
│   │   ├── IHatchery.ts
│   │   ├── IMinion.ts       # Re-exported from domain-types
│   │   └── IMinionClient.ts
│   │
│   ├── adapters/            # Adapter implementations
│   │   ├── hatcheries/
│   │   │   ├── ProductionHatchery.ts
│   │   │   └── ZombieHatchery.ts
│   │   │
│   │   ├── clients/
│   │   │   ├── ClaudeCodeClient.ts
│   │   │   └── OpenCodeClient.ts
│   │   │
│   │   └── minions/
│   │       ├── RealMinion.ts
│   │       └── BrainlessMinion.ts
│   │
│   └── utils/               # Shared utilities
│       └── parseJsonSafely.ts
│
├── __tests__/               # Test suites
│   ├── unit/
│   ├── contract/
│   └── integration/
│
└── ARCHITECTURE.md          # This file
```

## Design Decisions

### Why Separate IHatchery and IMinionClient?

**Alternative considered**: IHatchery spawns and manages minions directly
**Decision**: Separate IHatchery (spawning) from IMinionClient (communication)
**Rationale**:
- IHatchery abstracts spawn strategy
- IMinionClient abstracts client communication
- Clear separation of concerns
- Easier to test each independently

### Why RealMinion Wrapper?

**Alternative considered**: Return IMinionClient directly from spawn
**Decision**: Wrap IMinionClient in RealMinion adapter
**Rationale**:
- RealMinion provides IMinion interface (from domain-types)
- Manages lifecycle state (status, alive/dead)
- Coordinates send/receive with client
- Single place for cross-cutting concerns

### Why Test Fakes Instead of Mocks?

**Alternative considered**: Use jest.mock() for IMinionClient
**Decision**: Provide ZombieHatchery and BrainlessMinion fakes
**Rationale**:
- Fakes are first-class implementations, not test doubles
- Dual co-routine pattern enables deterministic testing
- Reusable across test suites
- No mocking framework coupling

### Why Allow Costume Dependency?

**Alternative considered**: Hatchery doesn't know about costumes
**Decision**: MinionSpec includes optional Costume field
**Rationale**:
- Costume IS part of spawn specification
- Both conductor and hatchery need costume awareness
- Costume is shared domain (like domain-types)
- Enables costume-based spawning and reconfiguration

## Future Considerations

### Adding New Client Types

To add a new AI client:

1. Create adapter in `adapters/clients/NewClient.ts`
2. Implement IMinionClient interface
3. Add client type to MinionClient enum (in domain-types)
4. Add factory case in ProductionHatchery
5. Add contract tests
6. Add integration tests

### Protocol Abstraction

If clients use different protocols:
- Extract protocol adapters (stream-json, REST, WebSocket)
- Compose client from protocol + client logic
- Reuse protocol adapters across clients

### Resource Management

Future considerations:
- Process pool for reusing client processes
- Resource limits (max minions, memory, CPU)
- Graceful shutdown handling

### Observability

Future enhancements:
- Spawn event emitter (like ZombieHatchery)
- Lifecycle event tracking
- Metrics collection (spawn time, message latency)

## Related Documentation

- `@minions/domain-types/ARCHITECTURE.md` - Shared domain types
- `@minions/conductor/ARCHITECTURE.md` - Mission orchestration
- `@minions/costumes/README.md` - Costume configuration system
