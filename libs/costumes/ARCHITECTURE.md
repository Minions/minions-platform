# Costumes Architecture

## Purpose

The `@minions/costumes` package defines the Costume system for configuring AI minions. A Costume specifies everything about how a minion operates: AI configuration, available capabilities, event definitions, and workbench fact injection preferences.

## Role in the Architecture

Costumes is a **shared domain package** that defines minion configuration:

```
@minions/costumes (shared domain - minion configuration)
        ↑               ↑
        │               │
        │               │
@minions/conductor  @minions/hatchery
(orchestrates)      (spawns)
```

**Why both packages depend on costumes**:
- Conductor needs Costume to reconfigure minions during orchestration
- Hatchery needs Costume to configure minions at spawn time
- Costume is the shared language for "how a minion should be configured"

**This is NOT a circular dependency**:
- Costumes depends on nothing (except Effect)
- Both conductor and hatchery depend on costumes
- Dependency flow is unidirectional: costumes ← conductor, costumes ← hatchery ✓

## Core Concepts

### Costume Definition

A Costume is a declarative specification that defines:

```typescript
interface Costume {
  model: string;              // AI model to use
  systemPrompt?: string;      // System prompt for the minion
  gadgets?: Tool[];           // MCP tools available
  skills?: Skill[];           // Claude Code skills available
  events?: CostumeEvent[];    // Events minion can emit
  injectFacts?: string[];     // Workbench fact categories to inject
}
```

**Key characteristics**:
- Declarative (data, not behavior)
- Serializable (plain objects)
- Forward-compatible (optional fields)
- Validated at runtime (isCostume type guard)

### Closet-Based Discovery

Costumes are stored in the closet and discovered dynamically:

```
<wingRoot>/closet/
  └── developer-costume/
      ├── costume.ts     (exports: export const costume: Costume)
      ├── prompt.md      (optional, loaded as systemPrompt)
      └── src/
          └── missions/  (mission implementations)
```

**ClosetCostumeLoader**:
- Discovers costumes by scanning closet directories
- Loads costume.ts files via dynamic import
- Merges prompt.md if present
- Validates loaded costumes with isCostume()

### Gadgets and Skills

**Gadgets**: MCP tools (low-level capabilities)
- Defined using Tool interface (simplified from hatchery's Tool)
- Examples: Read, Write, Bash, WebFetch

**Skills**: Claude Code skills (high-level capabilities)
- Placeholder type for now (detailed structure deferred)
- May combine multiple gadgets

### Events

**CostumeEvent**: Associates an EventDeclaration with guidance
```typescript
interface CostumeEvent {
  event: EventDeclaration<any, any, any>;  // Event with Effect Schema
  guidance: string;                         // When to emit
}
```

**EventDeclaration**: Effect-based event definition with payload validation
- Uses Effect Schema for runtime validation
- Type-safe event payload
- Guidance tells minion when to emit

### Workbench Fact Injection

**injectFacts**: Array of fact category strings
- Open-ended (not an enum)
- Examples: 'build', 'test', 'structure', 'package-manager'
- Workbench injects facts matching these categories at spawn time

## Domain Boundaries

### What Costumes Defines

Costumes defines:
- **What configuration a minion needs**: Costume interface
- **How to discover costumes**: ClosetCostumeLoader
- **How events are declared**: EventDeclaration, CostumeEvent
- **What capabilities exist**: Gadgets (tools), Skills

Costumes does NOT define:
- How to spawn a minion (that's hatchery's responsibility)
- How to orchestrate minions (that's conductor's responsibility)
- How to execute missions (that's conductor's responsibility)
- How to communicate with minions (that's domain-types' responsibility)

### Dependencies

**Costumes depends on**:
- `effect`: For Effect-based operations and error handling

**Costumes does NOT depend on**:
- `@minions/conductor`: Would create circular dependency
- `@minions/hatchery`: Would create circular dependency
- `@minions/domain-types`: Costumes is lower-level, domain-types imports Costume

### Who Depends on Costumes

**Packages that depend on costumes**:
- `@minions/domain-types`: MinionSpec includes optional costume field
- `@minions/conductor`: Reconfigures minions with costumes
- `@minions/hatchery`: Spawns minions with costumes
- Any package that works with minion configuration

**Dependency direction is clean**:
```
@minions/costumes
    ↑
    ├── @minions/domain-types
    │       ↑
    │       ├── @minions/conductor
    │       └── @minions/hatchery
    ├── @minions/conductor (direct)
    └── @minions/hatchery (direct)
```

This is acceptable because:
- Costumes is a shared domain (like domain-types)
- No circular dependencies exist
- Dependency flow is unidirectional

## Effect-Based API Pattern

Costumes follows the Effect-based port pattern used throughout the minions architecture.

### Core Principle: Effects for Operations, DTOs for Data

Costumes follows a consistent pattern:
- **Loader operations return Effects** for operation lifecycle (composition, error handling, resource management)
- **Costume definitions are DTOs** (plain objects, serializable, forward-compatible)

This pattern clarifies the distinction between:
- **Operations** (how you load/discover costumes) → Effects
- **Data** (costume definitions) → DTOs

### ClosetCostumeLoader: Effect-Based Operations

```typescript
class ClosetCostumeLoader {
  // Operations: return Effects for composition and error handling
  discover(): Effect.Effect<string[], LoadError, never>;
  load(costumeName: string): Effect.Effect<Costume, LoadError, never>;
}
```

**Key observations**:
1. **Operations return Effects**: `discover()` and `load()` return Effects for composition
2. **Operations can fail**: LoadError represents file system errors, parse errors, validation errors
3. **Operations are composable**: Can chain with Effect.gen and pipe

**Why Effects for loader operations?**
- **File system operations can fail**: Reading directories, importing modules, reading files
- **Clear error types**: LoadError with specific failure reasons (FileNotFound, ParseError, ValidationError)
- **Composable with other Effects**: Integrates with Effect-based mission orchestration
- **Resource management**: Proper handling of file handles and dynamic imports

### Costume: Plain Data (DTO)

```typescript
interface Costume {
  model: string;              // AI model identifier
  systemPrompt?: string;      // System prompt text
  gadgets?: Tool[];           // MCP tools available
  skills?: Skill[];           // Claude Code skills available
  events?: CostumeEvent[];    // Events minion can emit
  injectFacts?: string[];     // Workbench fact categories to inject
}
```

**Key characteristics**:
- **Plain object**: No methods, only data
- **Serializable**: Can be JSON.stringify'd (except EventDeclaration objects)
- **Forward-compatible**: New fields can be added without breaking old costumes
- **Validation is runtime**: `isCostume()` type guard validates structure
- **No Effect runtime needed**: Costume is just data

### DTOs vs Operations: Clear Separation

**Costume definitions are DTOs**:
```typescript
// This is data, not an operation
export const costume: Costume = {
  model: 'claude-sonnet-4-5',
  systemPrompt: 'You are a helpful developer assistant.',
  gadgets: [
    { name: 'Read', description: 'Read a file' },
    { name: 'Write', description: 'Write a file' }
  ],
  injectFacts: ['build', 'test', 'structure']
};
```

**Loading costumes is an operation**:
```typescript
// This is an operation that returns Effect
const loadEffect: Effect.Effect<Costume, LoadError, never> =
  loader.load('developer-costume');

// Run the Effect
const costume = await Effect.runPromise(loadEffect);
```

### When to Use Effects vs Plain Data

**Use Effect when**:
- Operation can fail (file system, network, validation)
- Operation needs composition with other Effects
- Operation requires resource management
- Operation has multiple error types to distinguish

**Use plain data (DTO) when**:
- Representing configuration or state
- Data needs to be serializable
- Data crosses boundaries (network, process, storage)
- Data should be forward-compatible

### Examples in Practice

**Discovering costumes** (using ClosetCostumeLoader):
```typescript
const loader = new ClosetCostumeLoader('/path/to/closet');

// Operation returns Effect
const discoverEffect = loader.discover();

// Run the Effect
const costumeNames = await Effect.runPromise(discoverEffect);
console.log('Found costumes:', costumeNames);  // Array of strings (DTOs)
```

**Loading a costume** (with error handling):
```typescript
// Operation returns Effect, data is DTO
const loadEffect = loader.load('developer-costume');

// Handle errors explicitly
const costume = await Effect.runPromise(
  loadEffect.pipe(
    Effect.catchTag('LoadError', error => {
      console.error('Failed to load costume:', error.reason);
      return Effect.succeed(defaultCostume);  // Fallback DTO
    })
  )
);

// costume is a DTO
console.log(costume.model);        // plain value
console.log(costume.systemPrompt); // plain value or undefined
console.log(costume.gadgets);      // array of DTOs or undefined
```

**Composing costume loading with mission setup**:
```typescript
const setupMission = Effect.gen(function* () {
  // Load costume (operation)
  const costume = yield* loader.load('developer-costume');

  // Spawn minion with costume (data)
  const minion = yield* Effect.promise(() =>
    hatchery.spawn({
      client: 'claude-code',
      wing: '/path/to/wing',
      model: costume.model,  // DTO field
      costume: costume       // DTO
    })
  );

  return minion;
});

await Effect.runPromise(setupMission);
```

### Pattern Consistency Across Domains

Costumes follows the same pattern as other domains:

**domain-types** (shared):
- IMinion: `reconfigure()` returns Effect, MinionSpec/MinionMessage are DTOs

**conductor** (orchestration):
- IWorkbench: `addFile()`, `writeFile()` return Effects, FileKnowledge/ProjectFact are DTOs

**hatchery** (infrastructure):
- IHatchery: `spawn()` returns Promise, MinionSpec/MinionMessage are DTOs
- RealMinion: `reconfigure()` returns Effect, Costume is DTO

**costumes** (configuration):
- ClosetCostumeLoader: `discover()`, `load()` return Effects, Costume is DTO

This consistency makes the architecture predictable across all domains.

### Why This Pattern Matters

**Clarity**: Immediately clear what's an operation (Effect) vs data (DTO)

**Composability**: Effects compose naturally in mission setup:
```typescript
const setupWithCostume = Effect.gen(function* () {
  const costume = yield* loader.load('developer-costume');
  yield* workbench.addFact('costume', `Using ${costume.model}`);
  const minion = yield* spawnMinion(costume);
  return minion;
});
```

**Error handling**: Effects provide typed error handling:
```typescript
const result = await Effect.runPromise(
  loader.load('developer-costume').pipe(
    Effect.catchTag('FileNotFound', () => Effect.succeed(defaultCostume)),
    Effect.catchTag('ValidationError', error => {
      console.error('Invalid costume:', error.message);
      return Effect.fail(error);
    })
  )
);
```

**Testing**: DTOs are easy to construct, Effects are easy to test:
```typescript
// Easy to construct test costume
const testCostume: Costume = {
  model: 'claude-sonnet-4-5',
  systemPrompt: 'Test prompt',
  gadgets: [],
  injectFacts: ['test']
};

// Easy to test Effect operations
const costume = await Effect.runPromise(loader.load('test-costume'));
expect(costume.model).toBe('claude-sonnet-4-5');
```

**Serialization**: Costumes can be stored and transmitted:
```typescript
// Costume is serializable (mostly - EventDeclaration needs special handling)
const costumeJson = JSON.stringify({
  model: costume.model,
  systemPrompt: costume.systemPrompt,
  injectFacts: costume.injectFacts
  // Note: gadgets, skills, events need special serialization
});
```

### Special Considerations: EventDeclaration

**EventDeclaration objects are not plain DTOs**:
```typescript
interface CostumeEvent {
  event: EventDeclaration<any, any, any>;  // Contains Effect Schema
  guidance: string;                         // Plain string (DTO)
}
```

**EventDeclaration contains Effect Schema**:
- Effect Schema is runtime validation logic (not plain data)
- EventDeclaration is not JSON-serializable
- This is acceptable because events are defined in code, not loaded from JSON

**Pattern still applies**:
- Loading a costume (operation) returns Effect
- Costume contains event declarations (validated objects)
- Event guidance is plain string (DTO)

### Migration Path: From Legacy to Effect-Based

If you have legacy code that doesn't use Effects:

```typescript
// Legacy: async/await with try/catch
try {
  const costumeNames = await loader.discoverLegacy();
  const costume = await loader.loadLegacy('developer-costume');
} catch (error) {
  console.error('Load failed:', error);
}

// Modern: Effect-based with typed errors
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const costumeNames = yield* loader.discover();
    const costume = yield* loader.load('developer-costume');
    return { costumeNames, costume };
  }).pipe(
    Effect.catchAll(error => {
      console.error('Load failed:', error);
      return Effect.succeed({ costumeNames: [], costume: defaultCostume });
    })
  )
);
```

**Benefits of migration**:
- Typed errors (LoadError instead of unknown)
- Composition via Effect.gen
- Clear separation of operations and data
- Better integration with Effect-based mission orchestration

## Testing Strategy

Costumes includes tests that verify:
1. **Isolation**: No imports from conductor or hatchery packages
2. **Loader functionality**: Discovery and loading work correctly
3. **Validation**: isCostume correctly validates Costume objects
4. **Edge cases**: Missing closet, invalid costumes, missing prompt.md

See `__tests__/domain-boundaries.test.ts` for boundary verification tests.

## Design Decisions

### Why a Separate Package?

**Alternative considered**: Keep Costume in hatchery or conductor
**Decision**: Extract to separate package
**Rationale**:
- Both conductor and hatchery need Costume
- Extracting avoids duplication and potential inconsistency
- Makes shared domain explicit
- Allows for clean dependency direction

### Why Closet-Based Discovery?

**Alternative considered**: Inline costume definitions
**Decision**: All costumes in closet, discovered dynamically
**Rationale**:
- Costumes are bundled with missions (co-location)
- Dynamic loading supports costume development workflow
- No inline costumes keeps configuration centralized
- Easier to manage costume lifecycle (install, uninstall)

### Why Simplified Tool Interface?

**Alternative considered**: Import Tool from hatchery
**Decision**: Define simplified Tool interface in costumes
**Rationale**:
- Avoids dependency on hatchery (maintains isolation)
- Tool is part of MCP standard (stable interface)
- Hatchery's full Tool type has additional fields not needed here
- If needed, can re-export hatchery's Tool and maintain compatibility

### Why Open-Ended injectFacts?

**Alternative considered**: Enum of fact categories
**Decision**: Array of strings (open-ended)
**Rationale**:
- Anyone can define custom fact categories
- No need to change costumes package to add new categories
- Workbench is extensible, injectFacts should be too
- Forward-compatible (new categories don't break old costumes)

## Future Considerations

### Potential Additions

If costume configuration needs grow, consider adding:
- Costume versioning (for compatibility)
- Costume inheritance (base costumes)
- Costume validation schemas (Effect Schema)
- Costume metadata (author, description, tags)

### What Should NOT Be Added

Do not add to costumes:
- Mission execution logic (keep in conductor)
- Spawning logic (keep in hatchery)
- Client implementations (keep in hatchery/adapters)
- Orchestration concerns (keep in conductor)

### Package Growth

If costumes grows significantly, consider splitting:
- `@minions/costumes` (core types and loading)
- `@minions/costume-events` (event system)
- `@minions/costume-skills` (skills integration)

For now, keep the package focused on core costume configuration.

## Integration Points

### With Domain-Types

**MinionSpec references Costume**:
```typescript
interface MinionSpec {
  // ... other fields
  costume?: Costume;
}
```

This is the primary integration point. When spawning a minion:
1. Provide a Costume in MinionSpec
2. Hatchery uses Costume to configure the minion
3. Conductor can reconfigure with a different Costume later

### With Conductor

**Conductor uses Costume for**:
- Reconfiguring minions (IMinion.reconfigure(costume))
- Loading costumes for mission context
- Injecting workbench facts based on injectFacts

### With Hatchery

**Hatchery uses Costume for**:
- Spawning minions with configuration
- Converting Costume to client-specific configuration
- Providing tools (gadgets) to minion

## Summary

The `@minions/costumes` package:
- ✓ Defines minion configuration (Costume interface)
- ✓ Provides closet-based discovery (ClosetCostumeLoader)
- ✓ Is depended upon by both conductor and hatchery
- ✓ Has no dependencies on conductor or hatchery (only Effect)
- ✓ Uses Effect for operations that can fail
- ✓ Maintains clean, unidirectional dependency flow

This architecture ensures that costume configuration is shared, consistent, and isolated from orchestration and spawning concerns.
