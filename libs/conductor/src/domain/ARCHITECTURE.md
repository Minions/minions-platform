# Conductor Domain Architecture

## Overview

The Conductor domain defines the core abstractions and types for mission orchestration. This document clarifies the architectural boundaries and design decisions for this domain.

## Domain Boundary

The conductor domain is responsible for:
- **Mission orchestration**: Defining how missions execute, communicate, and coordinate
- **Event-based coordination**: Providing event bus infrastructure for typed, bidirectional communication
- **Shared context management**: Maintaining workbench for knowledge sharing across minions
- **Costume integration**: Loading and applying costume definitions to minion execution

The conductor domain **depends on**:
- `@minions/domain-types`: Shared types (IMinion, MinionSpec, MinionMessage, MinionClient)
- `@minions/costumes`: Costume definitions and configuration
- `@minions/file-store`: File system abstractions (via Workbench)
- `effect`: Functional effect system for composition and error handling

The conductor domain **does not depend on**:
- `@minions/hatchery`: Hatchery is an implementation detail used by adapters, not by the domain core

## Workbench: Port/Adapter Design

### Design Decision: Workbench Stays in Conductor Domain

**Decision**: Workbench (IWorkbench interface + Workbench implementation) remains in `conductor/domain` rather than being extracted to a separate package.

**Rationale**:
1. **Tight coupling to mission execution context**: Workbench is fundamentally about sharing knowledge during mission execution. It's a mission-scoped concept, not a general-purpose abstraction.

2. **File-aware abstraction**: Workbench abstracts over file operations for mission purposes. It uses `@minions/file-store` types, but this is acceptable because Workbench IS a file-aware abstraction layer for missions.

3. **No circular dependencies**: Workbench doesn't depend on hatchery, and hatchery doesn't depend on Workbench. The dependency graph is clean: missions use workbenches, minions receive workbench contents, but there's no cycle.

4. **Extraction would create artificial boundaries**: Moving Workbench to a separate package would add complexity without architectural benefit. It would require defining a new boundary, versioning, and dependency management for a type that's intrinsically part of mission orchestration.

### Port/Adapter Relationship

**IWorkbench** is the port (interface):
- Defines the contract for shared knowledge storage
- Returns Effects for all operations (composition, error handling, resource management)
- Accepts/returns DTOs as data: FileKnowledge, ProjectFact (plain objects, serializable)

**Workbench** is the adapter (implementation):
- Default in-memory implementation of IWorkbench
- Could be swapped with alternative implementations (persistent storage, distributed cache, etc.)
- Implementation detail hidden behind the interface

This follows hexagonal architecture:
```
Mission (domain) -> IWorkbench (port) -> Workbench (adapter)
```

Missions depend on the IWorkbench interface, not the concrete Workbench implementation. Tests can provide alternative implementations.

### File-Store Type Reference

**Decision**: Workbench methods accepting `File` from `@minions/file-store` is acceptable.

**Rationale**:
1. **Workbench IS file-aware**: The entire purpose of Workbench is to manage file knowledge during missions. File operations are core to its abstraction.

2. **File is a port, not an implementation**: The `File` type from `@minions/file-store` is itself an interface/abstraction, not a concrete implementation. Workbench accepting `File` is one port depending on another port.

3. **Convenience for callers**: Allowing direct `File` parameters prevents callers from having to read files themselves just to pass strings. The abstraction level is appropriate.

4. **Overloaded addFile signature**: The method supports multiple input types:
   - `addFile(path: string, content: string)` - Direct path and content
   - `addFile(path: string, contentPromise: Promise<string>)` - Async content loading
   - `addFile(file: File)` - Direct file-store integration

   This flexibility lets callers use the most convenient form for their context.

## Domain Types and DTOs

### FileKnowledge (DTO)
- Path, content, metadata about a file
- Plain object, serializable
- Can be transmitted to minions as synthetic gadget history

### ProjectFact (DTO)
- Category, fact text, confidence, discoverer
- Plain object, serializable
- Represents discovered knowledge about the project

### FileChangeEvent (DTO)
- Path and content for change notifications
- Plain object, used with Effect Streams and legacy callbacks

These are Data Transfer Objects that cross domain boundaries. They're defined in the domain because they're part of the Workbench contract.

## Effect-Based Port Pattern

The conductor domain follows the Effect-based port pattern across all its ports (IWorkbench, IMinion via domain-types, EventBus).

### Core Principle: Effects for Operations, DTOs for Data

Ports in the conductor domain follow a consistent pattern:
- **Port methods return Effects** for operation lifecycle (composition, error handling, resource management)
- **Data crossing boundaries uses DTOs** (plain objects, serializable, forward-compatible)

This pattern clarifies the distinction between:
- **Operations** (how you invoke behavior) → Effects or Streams
- **Data** (what you pass/receive) → DTOs

### IWorkbench Interface: Effect-Based Port Example

```typescript
interface IWorkbench {
  // Properties: collections of DTOs
  readonly files: ReadonlyMap<string, FileKnowledge>;
  readonly facts: ReadonlyArray<ProjectFact>;

  // Operations: return Effects for composition and error handling
  addFile(path: string, content: string, category?: string): Effect.Effect<void, FileError, never>;
  addFile(path: string, contentPromise: Promise<string>, category?: string): Effect.Effect<void, FileError, never>;
  addFile(file: File): Effect.Effect<void, FileError, never>;

  refreshFile(path: string): Effect.Effect<void, FileError, never>;
  writeFile(path: string, content: string): Effect.Effect<void, FileError, never>;

  addFact(
    category: string,
    fact: string,
    confidence: 'confirmed' | 'inferred',
    discoveredBy?: string
  ): void;

  // Stream: returns Stream for continuous data
  fileChanges(): Stream.Stream<FileChangeEvent, never, never>;

  // Synchronous operations: use callbacks (legacy) or prefer fileChanges() stream
  onFileChange(listener: (event: FileChangeEvent) => void): void;
}
```

**Key observations**:
1. **Operations return Effects**: `addFile()`, `refreshFile()`, `writeFile()` return Effects for composition
2. **Data parameters are DTOs**: `path: string`, `content: string`, `file: File`, `fact: string` are plain values
3. **Data properties are DTOs**: `files` is a Map of FileKnowledge DTOs, `facts` is an array of ProjectFact DTOs
4. **Stream for reactive data**: `fileChanges()` returns Effect.Stream for continuous file change events

### When to Use Effects vs Streams

**Use Effect when**:
- Single operation that completes (add, refresh, write)
- Operation can fail with typed errors (FileError)
- Operation needs composition with other Effects
- Operation requires resource management

**Use Stream when**:
- Continuous data over time (file changes, events)
- Multiple values emitted (not just one result)
- Backpressure handling needed
- Integration with Effect ecosystem (Stream.merge, Stream.filter, etc.)

**Use synchronous callbacks when**:
- Legacy compatibility (prefer Streams for new code)
- Simple fire-and-forget notifications

### DTOs: Data Transfer Objects

All data crossing port boundaries uses DTOs:

```typescript
// FileKnowledge: Plain object representing a file
interface FileKnowledge {
  path: string;
  content: string;
  category: string;
  addedAt: number;  // timestamp
}

// ProjectFact: Plain object representing discovered knowledge
interface ProjectFact {
  category: string;
  fact: string;
  confidence: number;
  discoverer: string;
  discoveredAt: number;  // timestamp
}

// FileChangeEvent: Plain object for file change notifications
interface FileChangeEvent {
  path: string;
  content: string;
}
```

**DTO characteristics**:
- **Plain objects**: No methods, only data
- **Serializable**: Can be JSON.stringify'd
- **Forward-compatible**: New fields can be added without breaking old code
- **No Effect runtime needed**: Data is just data

### Why This Pattern Matters

**Clarity**: It's immediately clear what's an operation (Effect/Stream) vs what's data (DTO)

**Composability**: Effects compose naturally with other Effects in mission orchestration:
```typescript
const setupWorkbench = Effect.gen(function* () {
  yield* workbench.addFile('src/index.ts', sourceCode);
  yield* workbench.addFile('README.md', readme);
  workbench.addFact('structure', 'TypeScript project', 'confirmed');
  return workbench;
});
```

**Error handling**: Effects provide typed error handling, DTOs don't throw:
```typescript
const result = await Effect.runPromise(
  workbench.addFile('/invalid/path', 'content')
    .pipe(Effect.catchAll(error => Effect.succeed(undefined)))
);
```

**Testing**: DTOs are easy to construct, Effects are easy to test with Effect.runPromise:
```typescript
const knowledge: FileKnowledge = {
  path: 'test.ts',
  content: 'test',
  category: 'test',
  addedAt: Date.now()
};
```

**Serialization**: DTOs can be transmitted to minions as synthetic gadget history:
```typescript
// Workbench files are serialized and sent to minion
const syntheticHistory = Array.from(workbench.files.values())
  .map(file => ({
    tool: 'Read',
    input: { file_path: file.path },
    result: file.content
  }));
```

### Examples in Practice

**Adding files to workbench** (mission orchestration):
```typescript
const mission: Mission = {
  name: 'analyze-codebase',
  run: async (context: MissionContext) => {
    const workbench = context.workbench;

    // Operations return Effects - compose them
    await Effect.runPromise(
      Effect.gen(function* () {
        // Add multiple files
        yield* workbench.addFile('src/index.ts', indexSource);
        yield* workbench.addFile('package.json', pkgJson);

        // Add facts about the project (synchronous operations)
        workbench.addFact('build', 'Uses pnpm for package management', 'confirmed');
        workbench.addFact('test', 'Uses vitest for testing', 'inferred');
      })
    );

    // Access DTOs from workbench
    const files = workbench.files;  // Map<string, FileKnowledge>
    const facts = workbench.facts;  // Array<ProjectFact>

    // Spawn minion with workbench knowledge
    const minion = await context.spawn({
      client: 'claude-code',
      wing: context.wing,
      model: 'claude-sonnet-4-5',
      costume: analyzerCostume
    });

    return { analyzed: files.size, facts: facts.length };
  }
};
```

**Subscribing to file changes** (reactive workbench updates):
```typescript
// Using Stream (preferred)
const subscription = workbench.fileChanges()
  .pipe(
    Stream.filter(event => event.path.endsWith('.ts')),
    Stream.tap(event => console.log('TS file changed:', event.path))
  );

await Effect.runPromise(
  Stream.runDrain(subscription)
);

// Using callback (legacy)
workbench.onFileChange(event => {
  console.log('File changed:', event.path);
});
```

### Contrast: "Object-Based API" vs "Effect-Based API"

This terminology caused confusion during the architecture review. Here's the clarification:

**Not "Object-Based API"**: This sounds like methods return objects, which is too vague

**Not "Effect-Based API"**: This sounds like everything is an Effect, which is false (DTOs are not Effects)

**Correct: "Effect-Based Port Pattern"**:
- Ports are interfaces (IWorkbench, IMinion)
- Port methods return Effects for operations
- Port data parameters/returns are DTOs (plain objects)
- Streams for continuous data

The pattern is about **when to use Effects** (operations) and **when to use DTOs** (data).

### Pattern Consistency Across Conductor Ports

**IWorkbench** (this domain):
- Operations: `addFile()`, `refreshFile()`, `writeFile()` return Effects
- Data: FileKnowledge, ProjectFact are DTOs
- Stream: `fileChanges()` returns Stream

**IMinion** (from domain-types):
- Operations: `reconfigure()` returns Effect, `send()` returns Promise
- Data: MinionMessage, MinionSpec, Costume are DTOs
- Stream: `receive()` returns AsyncIterableIterator (could be Stream)

**EventBus** (domain infrastructure):
- Operations: `emit()` returns Effect
- Data: Event payloads are DTOs (validated with Effect Schema)
- Stream: `subscribe()` returns Stream

This consistency makes the conductor domain predictable and composable.

## Testing Strategy

### No Hatchery Dependencies

The Workbench and conductor domain must have zero dependencies on `@minions/hatchery`. This is verified by:

1. **Dependency graph**: `package.json` shows hatchery as a peerDependency (used by conductor consumers, not conductor itself)
2. **Import checks**: No domain files import from `@minions/hatchery`
3. **Test verification**: Automated test confirms no hatchery imports in domain files

The only hatchery reference in domain is a test file (`TurnCompletion.test.ts`) that imports a test helper. This is acceptable - test code can import from hatchery for test purposes.

### Test Boundaries

Domain tests should:
- Test against interfaces (IWorkbench) not implementations
- Use Effect.runPromise for async operations
- Avoid mocks where possible (prefer real implementations or test doubles)
- Focus on behavior, not implementation details

## Mission Orchestration: Port/Adapter Design

### Design Decision: Mission Orchestration Boundaries

**Core domain types** (in `conductor/domain`):
- **Mission**: Mission definition interface with typed arguments schema
- **MissionContext**: Context passed to mission run() functions
- **MissionHandle**: Handle for subscribing to mission events and awaiting completion
- **EventBus**: Mission-scoped event bus for typed, bidirectional communication

**Adapter implementations** (in `conductor/adapters`):
- **DefaultMissionRunner**: Adapter that executes missions with lifecycle management
- **DefaultMissionContext**: Implementation of MissionContext interface
- **EffectMissionRunner**: Alternative Effect-based mission runner

### Mission Orchestration Boundary

The mission orchestration domain is responsible for:
- Defining mission structure and lifecycle (Mission interface)
- Providing execution context for missions (MissionContext)
- Event-based coordination between missions and minions (EventBus)
- Managing mission state and cancellation (MissionHandle)

**Correct dependencies**:
1. **MissionContext depends on IMinion port** (from `@minions/domain-types`): This is correct. MissionContext provides spawn() which returns IMinion. This is a port-to-port dependency, not a dependency on hatchery internals.

2. **EventBus is part of orchestration domain**: EventBus is fundamental to how missions coordinate. It's not a separate domain or adapter - it's core domain infrastructure. Events flow between minions, missions, and external processes through this single bus.

3. **DefaultMissionRunner is an adapter**: The runner implements the IMissionRunner port. It depends on IHatchery (from `@minions/hatchery`) and orchestrates mission execution, but the domain types (Mission, MissionContext) don't know about hatchery internals.

### Port Dependencies

MissionContext interface depends only on ports, never implementations:
```typescript
// MissionContext imports (conductor/domain/MissionContext.ts)
import type { IMinion } from '@minions/domain-types';  // Port dependency ✓
import type { IEventBus } from './EventBus';            // Domain infrastructure ✓
import type { IWorkbench } from './Workbench';          // Port dependency ✓
```

The spawn() method signature:
```typescript
spawn(options?: SpawnOptions): Promise<IMinion>;
```

This returns IMinion (port from domain-types), not a concrete minion implementation. The adapter (DefaultMissionContext) handles the actual spawning via IHatchery.

### Why EventBus is NOT a Separate Adapter

**Decision**: EventBus is part of the conductor domain, not separated as a port/adapter.

**Rationale**:
1. **Fundamental to orchestration**: EventBus defines HOW missions coordinate. It's not swappable infrastructure - it's the coordination mechanism itself.

2. **Effect-based implementation is the abstraction**: EventBus uses Effect's PubSub and Stream as its foundation. These provide the composition, backpressure, and resource safety we need. There's no need for another layer.

3. **Type-safe event declarations**: EventBus works with EventDeclaration types that define event hierarchies and payloads. This type system IS the domain model for coordination.

4. **Missions depend on event patterns, not implementations**: Missions use the EventBus interface (subscribe, emit), which is stable. The internal implementation (PubSub, Stream) is an implementation detail.

### Hexagonal Architecture Flow

```
Mission (domain script)
  ↓ uses
MissionContext (port) → IMinion (port in domain-types)
                      → IWorkbench (port in conductor/domain)
                      → EventBus (domain infrastructure)
  ↓ implemented by
DefaultMissionContext (adapter)
  ↓ uses
IHatchery (port in hatchery) → HatcheryImplementation (adapter in hatchery)
```

The key boundary: conductor domain orchestrates via ports (IMinion, IWorkbench), never directly depending on hatchery implementation details.

## Related Documentation

- **Story 1**: Domain-types extraction (resolved circular dependency between conductor and hatchery)
- **Story 2**: Workbench domain boundaries (IWorkbench port/adapter design)
- **Story 3**: Minion domain core boundaries (IMinion, MinionSpec in domain-types)
- **Story 4**: Mission orchestration boundaries (Mission, MissionContext, EventBus) - this section
- **Story 6**: Effect-based port pattern documentation (applies to all conductor ports)

## Summary

- **Workbench stays in conductor/domain**: It's tightly coupled to mission execution and extracting it would create artificial boundaries
- **IWorkbench is the port, Workbench is the adapter**: Follows hexagonal architecture
- **Mission orchestration core (Mission, MissionContext, MissionHandle, EventBus) in domain**: These define what orchestration is
- **DefaultMissionRunner in adapters**: Adapter that implements orchestration using hatchery
- **MissionContext depends on IMinion port from domain-types**: Port-to-port dependency, not implementation dependency
- **EventBus is domain infrastructure, not a separate adapter**: Fundamental coordination mechanism
- **File-store type references are acceptable**: Workbench IS file-aware, File is a port
- **Domain boundary is clean**: No hatchery dependencies in domain code
- **Effect-based operations, DTO-based data**: Consistent pattern across all conductor ports
