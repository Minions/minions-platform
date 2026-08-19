# Object Model

## Type Definitions

### Operation Plan

```typescript
import { Effect } from 'effect';
import * as Schema from '@effect/schema/Schema';

// The static definition of an operation
interface OperationPlan<
  TParams,
  TCell extends string,
  TDeadDrops extends string
> {
  readonly name: string;
  readonly params: Schema.Schema<TParams>;
  readonly cell: CellDefinition<TCell>;
  readonly deadDrops: DeadDrops<TCell, TDeadDrops>;
}

// Cell definition: named roles (empty slots filled at runtime)
// The plan only defines role names. The invoker specifies which minions
// fill specific roles; all others are filled with new recruits.
type CellDefinition<TRole extends string> = ReadonlyArray<TRole>;

// Dead drops: dead drop name → response mapping
type DeadDrops<TCell extends string, TDeadDrop extends string> = {
  readonly [K in TDeadDrop]: Response<TCell, unknown>;
};

// Response to a secret message
interface Response<TCell extends string, TMessageParams> {
  readonly params: Schema.Schema<TMessageParams>;
  readonly assignment: Assignment<TCell, TMessageParams>;
}

// Who handles the message
type MinionSpec<TCell extends string> =
  | { readonly type: 'new-recruit' }
  | { readonly type: 'clone-of'; readonly source: CellRole<TCell> | 'sender' | RecipientOf }
  | { readonly type: 'existing'; readonly ref: CellRole<TCell> | 'sender' | RecipientOf };

type CellRole<TCell extends string> = { readonly role: TCell };
type RecipientOf = { readonly recipientOf: SecretMessage };  // Actual message instance, not a ref

// Assignment: tactical (single minion) or operational (nested operation)
type Assignment<TCell extends string, TMessageParams> =
  | TacticalAssignment<TCell, TMessageParams>
  | OperationalAssignment<TCell>;

interface TacticalAssignment<TCell extends string, TMessageParams> {
  readonly type: 'tactical';
  readonly minion: MinionSpec<TCell>;
  readonly disguise: Disguise;
  readonly briefing: Briefing<TMessageParams>;
}

interface OperationalAssignment<TCell extends string> {
  readonly type: 'operational';
  readonly operation: OperationPlan<unknown, string, string>;
  readonly mode: 'init' | 'resume';
  readonly cellAssignments: ReadonlyArray<CellAssignment<TCell>>;
  readonly initialMessages: ReadonlyArray<SecretMessage>;
}

interface CellAssignment<TCell extends string> {
  readonly role: string;  // Role in target operation
  readonly minion: MinionSpec<TCell>;
}

// Briefing: TypeScript function or markdown file
type Briefing<TMessageParams> =
  | ((ctx: BriefingContext<TMessageParams>) => Effect.Effect<void, BriefingError>)
  | MarkdownFile;

type MarkdownFile = string & { readonly _brand: 'MarkdownFile' };
```

### Running Operation

```typescript
// Live operation instance
interface Operation<TParams, TCell extends string, TDeadDrops extends string> {
  readonly id: string;
  readonly plan: OperationPlan<TParams, TCell, TDeadDrops>;
  readonly params: TParams;
  readonly cell: Cell<TCell>;
  readonly deadDrops: DeadDropDispatcher<TDeadDrops>;
}

// Live cell with actual minions
interface Cell<TRole extends string> {
  readonly [K in TRole]: Minion;
}

// Leaves secret messages at appropriate dead drops
interface DeadDropDispatcher<TDeadDrops extends string> {
  leave<K extends TDeadDrops>(
    deadDrop: K,
    params: DeadDropParams<K>,
    target?: MessageTarget
  ): Effect.Effect<void, DeadDropError>;
}
```

### Briefing Context

```typescript
interface BriefingContext<TMessageParams = unknown> {
  // Location
  readonly lair: Lair;
  readonly wing: Wing;
  readonly closet: Closet;

  // Shared world knowledge
  readonly workbench: Workbench;

  // Current operation
  readonly operation: OperationContext;

  // The secret message that triggered this assignment
  readonly currentMessage: SecretMessage<TMessageParams>;

  // This minion
  readonly minion: MinionInfo;

  // Cell awareness
  readonly cell: CellInfo;

  // Leave a secret message at a dead drop
  leave(message: SecretMessage, target?: MessageTarget): Effect.Effect<void, LeaveError>;

  // Gadget execution (blocking request/response)
  gadget<TGadget extends Gadget>(
    gadget: TGadget,
    params: GadgetParams<TGadget>
  ): Effect.Effect<GadgetResult<TGadget>, GadgetError>;
}

interface OperationContext<TParams = unknown, TDeadDrops extends string = string> {
  readonly params: TParams;
  readonly deadDrops: DeadDropFactory<TDeadDrops>;  // Type-safe message constructors
  fail(reason: string): Effect.Effect<never, OperationFailed>;
  done(status?: 'success' | 'failure'): Effect.Effect<void, never>;
}

// Where to leave a secret message (uses direct object references, not ID refs)
type MessageTarget =
  | { readonly target: 'cell' }                              // Current cell (default) - operation plan routes
  | { readonly target: 'sender' }                            // Whoever sent the message we're responding to
  | { readonly target: 'other-cell'; readonly cell: Operation }     // A different running operation
  | { readonly target: 'recipient-of'; readonly message: SecretMessage }  // Whoever handled a specific message
  | { readonly target: 'minion'; readonly minion: Minion }          // Specific minion

interface MinionInfo {
  readonly id: string;
  readonly workbench: Workbench;
  setWorkbench(wb: Workbench): Effect.Effect<void, never>;
}

interface CellInfo {
  readonly operationId: string;
  readonly roles: ReadonlyArray<string>;
  getMinion(role: string): Minion | undefined;
}
```

### Workbench

```typescript
interface Workbench {
  // Content
  getFile(path: string): Option.Option<string>;
  setFile(path: string, content: string): Effect.Effect<void, never>;
  getFacts(): ReadonlyArray<string>;
  addFact(fact: string): Effect.Effect<void, never>;
  getOperationHistory(): ReadonlyArray<OperationRecord>;
  recordOperation(op: OperationRecord): Effect.Effect<void, never>;

  // Cloning
  clone(): Effect.Effect<Workbench, never>;
}

interface OperationRecord {
  readonly operationId: string;
  readonly planName: string;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly status: 'running' | 'completed' | 'failed';
  readonly summary?: string;
}
```

### Minion

```typescript
interface Minion {
  readonly id: string;
  readonly status: MinionStatus;
  readonly disguise: Disguise;
  readonly history: MessageHistory;
  readonly workbench: Workbench;

  // Reconfigure (change disguise, same identity)
  reconfigure(disguise: Disguise): Effect.Effect<void, never>;

  // Clone (new identity, copies history)
  clone(): Effect.Effect<Minion, never>;

  // Lifecycle
  debrief(): Effect.Effect<DebriefRecord, never>;
  terminate(): Effect.Effect<void, never>;
}

type MinionStatus =
  | 'idle'           // Not currently executing
  | 'executing'      // Running a briefing
  | 'blocked'        // Waiting for gadget response
  | 'terminated';    // No longer active


// DebriefRecord: Full telemetry for debugging and system improvement.
// Written to <wing-root>/private/telemetry/<minionId>.json on termination.
// Contains raw data only - summary/aggregate fields are computed by analysis tools.
interface DebriefRecord {
  readonly minionId: string;
  readonly operationId: string;
  readonly createdAt: Date;
  readonly terminatedAt: Date;
  readonly finalStatus: 'completed' | 'failed' | 'terminated';

  // Full history of all briefings executed
  readonly briefings: ReadonlyArray<BriefingRecord>;

  // All messages sent and received
  readonly messages: ReadonlyArray<MessageRecord>;

  // All gadget invocations with full request/response
  readonly gadgetCalls: ReadonlyArray<GadgetCallRecord>;

  // Full agentic client logs (Claude Code project logging, etc.)
  readonly clientLogs: ReadonlyArray<ClientLogEntry>;

  // Complete conversation history for non-deterministic briefings
  readonly conversationHistory: ReadonlyArray<ConversationTurn>;
}

interface BriefingRecord {
  readonly briefingName: string;
  readonly type: 'deterministic' | 'non-deterministic';
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly triggeredBy: SecretMessage;
}

interface MessageRecord {
  readonly direction: 'sent' | 'received';
  readonly deadDrop: string;
  readonly params: unknown;
  readonly timestamp: Date;
}

interface GadgetCallRecord {
  readonly gadget: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

interface ClientLogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  readonly timestamp: Date;
}

interface ConversationTurn {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly toolCalls?: ReadonlyArray<unknown>;
  readonly timestamp: Date;
}
```

### Secret Message

```typescript
// SecretMessage is ephemeral - not serialized, not persisted.
// Use object references directly, not ID-based refs.
interface SecretMessage<TParams = unknown> {
  readonly deadDrop: string;
  readonly params: TParams;
  readonly sender: Minion;                    // Direct object reference
  readonly target: MessageTarget;
  // For request/response: hold the request message instance directly
  readonly replyTo?: SecretMessage;           // The message we're replying to (if any)
}
```

### Disguise

```typescript
interface Disguise {
  readonly name: string;
  readonly model: ModelId;
  readonly systemPrompt: string;
  readonly gadgets: ReadonlyArray<GadgetRef>;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

// Use "latest" aliases to automatically get new models as they're released.
type ModelId =
  | 'claude-sonnet-latest'
  | 'claude-opus-latest'
  | string;  // Or specific version if pinning is needed

// All gadgets come from costumes. Built-ins are in the ':built-in' costume.
// To mission authors: use ':built-in/read_file' or just { costume: ':built-in', name: 'read_file' }
// To agentic clients: built-ins appear with their regular names (e.g., 'read_file')
type GadgetRef = { costume: string; name: string };
```

### Costume

**Note:** The Costume interface may be internal-only. Costume designers import
specific resources (`@this-costume/operations`, etc.) - they don't need to
interact with a Costume object directly. This interface may be eliminated from
the public API if it's only used internally by the closet loader.

```typescript
// Internal: Used by closet loader for dependency resolution and discovery.
// May not be exposed to costume designers.
interface Costume {
  readonly name: string;
  readonly source: 'wing' | 'lair';
  readonly dependencies: ReadonlyArray<string>;
  readonly operations: ReadonlyArray<OperationInfo>;
  readonly tacticalMissions: ReadonlyArray<TacticalMissionInfo>;
  readonly disguises: ReadonlyArray<DisguiseInfo>;
  readonly gadgets: ReadonlyArray<GadgetInfo>;
}

interface OperationInfo {
  readonly name: string;
  readonly description?: string;
  readonly params: unknown;  // JSON Schema
}

interface TacticalMissionInfo {
  readonly name: string;
  readonly description?: string;
  readonly type: 'deterministic' | 'non-deterministic';
}

interface DisguiseInfo {
  readonly name: string;
  readonly model: string;
}

interface GadgetInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;  // JSON Schema
}
```

### Closet

**Note:** The Closet interface is primarily used internally by the conductor
to load costumes and resolve dependencies. Costume designers typically don't
interact with it directly - they import resources using `@this-costume/*` paths.
The public API surface for costume designers should be minimal.

```typescript
// Internal: Used by conductor to load costume resources.
// Costume designers use import paths, not this interface directly.
interface Closet {
  // Load specific resources (main internal use)
  loadOperation<TParams, TCell extends string, TDeadDrops extends string>(
    costume: string,
    name: string
  ): Effect.Effect<OperationPlan<TParams, TCell, TDeadDrops>, LoadError>;

  loadTacticalMission<TParams>(
    costume: string,
    name: string
  ): Effect.Effect<Briefing<TParams>, LoadError>;

  loadDisguise(
    costume: string,
    name: string
  ): Effect.Effect<Disguise, LoadError>;

  loadGadget<TIn, TOut>(
    costume: string,
    name: string
  ): Effect.Effect<Gadget<TIn, TOut>, LoadError>;
}
```

## Relationships

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OPERATION                                       │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         OPERATION PLAN                                 │  │
│  │  (fluent builder, type-safe, dead drop names derived from fields)     │  │
│  │                                                                        │  │
│  │  Cell: { orchestrator, developer, reviewer }                          │  │
│  │                                                                        │  │
│  │  Dead Drops:                                                           │  │
│  │    init         → orchestrator: initSlice.ts                          │  │
│  │    continue     → orchestrator: pickNextStep.ts                       │  │
│  │    developStory → developer.clone(): implement-story.md               │  │
│  │    reviewDone   → orchestrator: handleReview.ts                       │  │
│  │    debrief      → orchestrator: gatherLearnings.ts                    │  │
│  │                                                                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                              CELL                                    │    │
│  │                                                                      │    │
│  │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │    │
│  │   │ orchestrator │  │  developer   │  │   reviewer   │              │    │
│  │   │ (cell member)│  │ (cell member)│  │ (cell member)│              │    │
│  │   │  History A   │  │  History B   │  │  History C   │              │    │
│  │   │  Workbench X │  │  Workbench Y │  │  Workbench Y │              │    │
│  │   └──────────────┘  └──────────────┘  └──────────────┘              │    │
│  │                                                                      │    │
│  │   Freelancers (spawned for specific messages, terminated when done): │    │
│  │   ┌──────────────┐  ┌──────────────┐                                │    │
│  │   │ dev clone #1 │  │ dev clone #2 │                                │    │
│  │   │ (freelancer) │  │ (freelancer) │                                │    │
│  │   └──────────────┘  └──────────────┘                                │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Closet Resolution

```
loadOperation("dev-and-check", "orchestrate")
         │
         ▼
┌─────────────────────────────────┐
│   Check Wing Closet First       │
│   wing/closet/dev-and-check     │
│   /operations/orchestrate.ts    │
└──────────────┬──────────────────┘
               │
               │ Not found?
               ▼
┌─────────────────────────────────┐
│   Check Lair Closet             │
│   lair/closet/dev-and-check     │
│   /operations/orchestrate.ts    │
└──────────────┬──────────────────┘
               │
               │ Not found?
               ▼
┌─────────────────────────────────┐
│   CostumeNotFoundError          │
│   "Operation not found:         │
│    dev-and-check/orchestrate    │
│    in wing or lair closet"      │
└─────────────────────────────────┘
```

Wing closet takes precedence, allowing:
- **Debug installs**: Override lair version for development
- **Wing-specific customization**: Each wing can have its own variants
- **Shared defaults**: Common costumes in lair closet
