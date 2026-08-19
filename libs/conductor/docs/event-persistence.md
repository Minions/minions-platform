# Event Persistence Patterns

This guide explains when and how to enable event persistence for missions that need state reconstruction and resumption across session boundaries.

## Overview

Event persistence enables missions to:
- **Survive interruptions**: Resume from where they left off after crashes or user stops
- **Reconstruct state**: Rebuild mission state deterministically from the event log
- **Enable debugging**: Inspect the sequence of events that occurred during execution
- **Support long-running workflows**: Track progress across hours or days of execution

## When to Enable Persistence

**Enable persistence when**:
- The mission is long-running (minutes to hours)
- The mission coordinates multiple agents over time
- State needs to survive across session boundaries
- You need resumption after interruptions

**Skip persistence when**:
- The mission is short-lived (completes in seconds)
- State is trivially reconstructible
- The mission is idempotent and can re-run safely

## Architecture

Event persistence follows the hexagonal architecture pattern:

```
Mission Code (Domain)
       ↓ emits events to
    EventBus (Domain Infrastructure)
       ↓ subscribed by
EventPersistenceSubscription (Adapter)
       ↓ writes via
   IEventPersister (Port)
       ↓ implemented by
 FileEventPersister (Adapter)
       ↓ uses
      IFile (Port from file-store)
```

## Setup Pattern

### Step 1: Get File Access from MissionContext

```typescript
import type { MissionContext } from '@minions/conductor';

async function setupPersistence(ctx: MissionContext) {
  // Get the wing for file access
  const wing = await ctx.getWing();
  const workLocal = await wing.workLocal();

  if (!workLocal.exists) {
    throw new Error('Wing work/local directory not found');
  }

  // Navigate to your plan directory
  const plansDir = await workLocal.worktree.child('plans/my-mission');
  if (!plansDir.found) {
    // Create the directory if needed
    await workLocal.worktree.createDirectory('plans/my-mission');
  }

  // Create the event file
  const eventFile = await plansDir.node.createFile('events.jsonl', '');

  return eventFile;
}
```

### Step 2: Create the Persister and Subscription

```typescript
import { FileEventPersister, EventPersistenceSubscription } from '@minions/conductor';

async function initializePersistence(ctx: MissionContext) {
  const eventFile = await setupPersistence(ctx);

  // Create the file-based persister
  const persister = new FileEventPersister(eventFile);

  // Create the subscription that bridges EventBus to persister
  const subscription = new EventPersistenceSubscription(ctx.events, persister);

  // Start persisting events
  subscription.start();

  return { persister, subscription };
}
```

### Step 3: Clean Up on Mission Completion

```typescript
async function finalizePersistence(
  subscription: EventPersistenceSubscription
) {
  // Stop subscription and flush any remaining events
  await subscription.stop();
}
```

## Complete Mission Example

```typescript
import { Effect } from 'effect';
import type { Mission, MissionContext } from '@minions/conductor';
import {
  FileEventPersister,
  EventPersistenceSubscription,
  loadEvents,
  reconstructOrchestrationState,
  MissionEvents,
} from '@minions/conductor';

interface MyMissionArgs {
  planPath: string;
}

const myMission: Mission<MyMissionArgs> = {
  name: 'my-orchestrate-mission',
  args: {
    planPath: { type: 'string', description: 'Path to plan directory' },
  },

  async run(ctx: MissionContext, args: MyMissionArgs) {
    // === Setup Persistence ===
    const wing = await ctx.getWing();
    const workLocal = await wing.workLocal();

    if (!workLocal.exists) {
      throw new Error('Wing work/local not found');
    }

    const planDir = await workLocal.worktree.child(args.planPath);
    if (!planDir.found) {
      throw new Error(`Plan directory not found: ${args.planPath}`);
    }

    const eventFile = await planDir.node.createFile('events.jsonl', '');
    const persister = new FileEventPersister(eventFile);
    const subscription = new EventPersistenceSubscription(ctx.events, persister);

    // === Check for Resume ===
    const existingEvents = await Effect.runPromise(loadEvents(persister));

    if (existingEvents.length > 0) {
      // Reconstruct state from events using production function
      const state = reconstructOrchestrationState(existingEvents);
      ctx.emit('log', { message: `Resuming from ${state.completedStories.length} completed stories` });
    }

    // === Start Persisting New Events ===
    subscription.start();

    try {
      // Emit state transition events as you work
      ctx.events.emit(MissionEvents.PhaseChanged, {
        phase: 'development',
        previousPhase: 'planning',
      });

      // ... do mission work ...

      ctx.events.emit(MissionEvents.StoryStarted, {
        storyIndex: 1,
        title: 'First Story',
      });

      // ... more work ...

      ctx.events.emit(MissionEvents.StoryCompleted, {
        storyIndex: 1,
        status: 'success',
      });

    } finally {
      // === Always Clean Up ===
      await subscription.stop();
    }
  },
};
```

## File Path Convention

Store event files in the plan directory using the `.jsonl` extension:

```
plans/
  my-slice/
    slice.md           # Slice definition
    state.json         # Mutable state (optional)
    events.jsonl       # Persisted events
```

The `.jsonl` (JSON Lines) format stores one event per line, enabling:
- Easy append-only writes
- Streaming reads for large files
- Human-readable debugging
- Safe partial writes (malformed lines are skipped)

## Orchestration State Events

The conductor library provides built-in events for tracking orchestration state:

```typescript
import { MissionEvents } from '@minions/conductor';

// Phase transitions
ctx.events.emit(MissionEvents.PhaseChanged, {
  phase: 'development',      // 'planning' | 'development' | 'demo' | 'review'
  previousPhase: 'planning',
});

// Story lifecycle
ctx.events.emit(MissionEvents.StoryStarted, {
  storyIndex: 1,
  title: 'Define Event Serialization Format',
});

ctx.events.emit(MissionEvents.StoryCompleted, {
  storyIndex: 1,
  status: 'success',  // 'success' | 'blocked'
});

// Agent tracking
ctx.events.emit(MissionEvents.AgentSpawned, {
  agentType: 'developer',
  minionId: 'minion-abc-123',
});

// Human questions (for deterministic replay)
ctx.events.emit(MissionEvents.QuestionAsked, {
  questionId: 'q-123',
  question: 'Should we proceed?',
  context: 'Tests passed but coverage is below threshold',
  suggestions: ['Yes', 'No', 'Skip for now'],
});

ctx.events.emit(MissionEvents.QuestionAnswered, {
  questionId: 'q-123',
  answer: 'Yes',
});
```

## State Reconstruction Pattern

The key to resumption is deterministic state reconstruction. The conductor library provides `reconstructOrchestrationState()` for this:

```typescript
import { loadEvents, reconstructOrchestrationState } from '@minions/conductor';

// Load persisted events
const events = await Effect.runPromise(loadEvents(persister));

// Reconstruct orchestration state deterministically
const state = reconstructOrchestrationState(events);

// state contains:
// - currentPhase: 'planning' | 'development' | 'demo' | 'review' | null
// - completedStories: number[]
// - blockedStories: number[]
// - currentStory: number | null
// - spawnedAgents: Array<{ type: string; minionId: string }>

// Resume from the reconstructed state
if (state.currentStory !== null) {
  // Continue from incomplete story
} else if (state.currentPhase === 'development') {
  // Start next story
}
```

For incremental state tracking (as events arrive in real-time), use `applyEventToState()`:

```typescript
import { createInitialOrchestrationState, applyEventToState } from '@minions/conductor';

const state = createInitialOrchestrationState();

// Apply events as they arrive
ctx.events.on(MissionEvents.PhaseChanged, (event) => {
  applyEventToState(state, { type: event.type, payload: event.payload, source: 'mission', timestamp: Date.now() });
});
```

**Key principle**: Given the same sequence of events, reconstruction produces the same state. This enables reliable resumption.

## Error Handling

Event persistence is designed to be non-blocking:

- **Persistence errors are logged but don't throw**: Mission execution continues even if persistence fails
- **Malformed JSON lines are skipped on load**: Partial writes (from crashes) don't corrupt the entire log
- **Missing files are treated as empty**: Starting fresh is graceful

```typescript
// Errors in append() are caught and logged
ctx.events.emit(MissionEvents.PhaseChanged, { phase: 'development' });
// ^ If persistence fails, event still flows to other handlers

// Malformed lines on load are skipped with warning
const events = await Effect.runPromise(loadEvents(persister));
// ^ Returns valid events, logs warnings for any corrupt lines
```

## API Reference

### FileEventPersister

```typescript
import { FileEventPersister } from '@minions/conductor';
import type { File } from '@minions/file-store';

const persister = new FileEventPersister(file: File);

// Append event (immediate write, no buffering)
await Effect.runPromise(persister.append(event));

// Flush (no-op for unbuffered implementation)
await Effect.runPromise(persister.flush());

// Load all events
const events = await Effect.runPromise(persister.load());

// Check if events exist
const hasEvents = await Effect.runPromise(persister.exists());

// Get event count
const count = await Effect.runPromise(persister.count());

// Clear all events (for tests)
await Effect.runPromise(persister.clear());

// Close (no-op for file-based)
await Effect.runPromise(persister.close());
```

### EventPersistenceSubscription

```typescript
import { EventPersistenceSubscription } from '@minions/conductor';

const subscription = new EventPersistenceSubscription(eventBus, persister);

// Start persisting events
subscription.start();

// Stop and flush
await subscription.stop();
```

### loadEvents

```typescript
import { loadEvents } from '@minions/conductor';

// Load events in chronological order
const events = await Effect.runPromise(loadEvents(persister));
```

## See Also

- [ARCHITECTURE.md](../src/domain/ARCHITECTURE.md) - Conductor domain architecture
- [ctx-ask.md](./ctx-ask.md) - Human question API documentation
- [MissionEvents.ts](../src/domain/MissionEvents.ts) - Event definitions
