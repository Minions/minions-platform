# Migration

## Current State

The current implementation uses a procedural mission model:

### Current Mission Interface

```typescript
// libs/conductor/src/domain/Mission.ts
interface Mission<TArgs> {
  name: string;
  description: string;
  args: MissionArgsSchema;
  run(ctx: MissionContext, args: TArgs): Promise<void>;
}
```

### Current Mission Context

```typescript
// libs/conductor/src/domain/MissionContext.ts
interface MissionContext {
  readonly wing: string;
  readonly lair: string;
  readonly missionRunId: string;
  readonly events: IEventBus;
  readonly isCancelled: boolean;

  emit(type: string, data?: Record<string, unknown>): void;
  spawn(options?: SpawnOptions): Promise<IMinion>;
  ask(options: AskOptions): Promise<string>;
  createWorkbench(): IWorkbench;
  getWing(): Promise<Wing>;
  loadCostume(name: string): Effect.Effect<Costume, LoadError>;
}
```

### Current Mission Service

```typescript
// apps/cabinet/src/missions/MissionService.ts
class MissionService {
  async start(wing: Wing, costume: string, missionName: string, args): Promise<...>
  getEvents(missionRunId: string): {...} | null
  cancel(missionRunId: string, reason?: string): boolean
}
```

## Target State

The target uses an operation-based model with cells and dead drops:

### Target: Operation Plan

```typescript
interface OperationPlan<TParams, TCell extends string, TDeadDrops extends string> {
  readonly name: string;
  readonly params: Schema.Schema<TParams>;
  readonly cell: CellDefinition<TCell>;
  readonly deadDrops: DeadDrops<TCell, TDeadDrops>;
}
```

### Target: Briefing Context

```typescript
interface BriefingContext<TMessageParams = unknown> {
  readonly lair: Lair;
  readonly wing: Wing;
  readonly closet: Closet;
  readonly workbench: Workbench;
  readonly operation: OperationContext;
  readonly currentMessage: SecretMessage<TMessageParams>;
  readonly minion: MinionInfo;
  readonly cell: CellInfo;

  leave(message: SecretMessage, target?: MessageTarget): Effect.Effect<void, LeaveError>;
  gadget<TGadget extends Gadget>(gadget: TGadget, params: GadgetParams<TGadget>): Effect.Effect<GadgetResult<TGadget>, GadgetError>;
}
```

## Migration Steps

### Step 1: Add Operation Infrastructure

Create the core operation types and runtime:

```typescript
// libs/operations/src/OperationPlan.ts
export interface OperationPlan<...> { ... }
export function operationPlan<TParams>(name: string) { ... }

// libs/operations/src/OperationRunner.ts
export class OperationRunner {
  start(plan: OperationPlan, params, cellAssignments?): Effect<Operation>;
  resume(operationId: string): Effect<Operation>;
}
```

**Files to create:**
- `libs/operations/` - New library for operation runtime
- `libs/operations/src/OperationPlan.ts` - Type definitions
- `libs/operations/src/OperationRunner.ts` - Execution runtime
- `libs/operations/src/BriefingContext.ts` - Context for briefings
- `libs/operations/src/Cell.ts` - Cell management
- `libs/operations/src/DeadDropDispatcher.ts` - Message routing

### Step 2: Add Dead Drop Routing

Implement the dead drop message system:

```typescript
// libs/operations/src/DeadDropDispatcher.ts
export class DeadDropDispatcher<TDeadDrops extends string> {
  leave<K extends TDeadDrops>(deadDrop: K, params, target?): Effect<void>;
}

// libs/operations/src/MessageRouter.ts
export class MessageRouter {
  route(message: SecretMessage): Effect<void>;  // Routes to appropriate handler
}
```

**Key implementation details:**
- Messages are queued, not synchronous
- Each message lookup is based on operation plan's dead drops
- Assignment resolution creates or finds the target minion
- Briefing execution is async

### Step 3: Refactor Minion Lifecycle

Update minion management:

**From:**
- Minions spawned via `ctx.spawn()`
- Minions killed via `minion.kill()`
- Minions are free agents

**To:**
- Minions created via operation cell or as freelancers
- Minions terminated when no roots (not in cell, no pending replies)
- Minions debriefed before termination

```typescript
// libs/hatchery/src/Minion.ts
interface Minion {
  clone(): Effect<Minion>;
  reconfigure(disguise: Disguise): Effect<void>;
  debrief(): Effect<DebriefRecord>;
  terminate(): Effect<void>;
}
```

### Step 4: Convert Costume Structure

Restructure costumes from missions to operations:

**From:**
```
closet/costume-name/
  missions/          # Mission definitions
  disguises/         # System prompts
  gadgets/           # Tools
```

**To:**
```
closet/costume-name/
  operations/        # Operation plans (new)
  tactical-missions/ # Briefings (renamed from missions)
  disguises/         # System prompts (unchanged)
  gadgets/           # Tools (unchanged)
```

Update `ClosetMissionLoader` → `ClosetLoader`:

```typescript
// libs/conductor/src/adapters/ClosetLoader.ts
export class ClosetLoader {
  loadOperation(costume: string, name: string): Effect<OperationPlan>;
  loadTacticalMission(costume: string, name: string): Effect<Briefing>;
  loadDisguise(costume: string, name: string): Effect<Disguise>;
  loadGadget(costume: string, name: string): Effect<Gadget>;
}
```

### Step 5: Migrate Existing Missions

Convert existing missions to the new model:

**Example: orchestrate mission**

**Before:**
```typescript
export const mission: Mission<Args> = {
  name: 'orchestrate',
  run: async (ctx, args) => {
    const state = await readState(ctx);
    if (state.phase === 'development') {
      const minion = await ctx.spawn({ costume: 'developer' });
      await minion.send('implement story');
      await minion.kill();
    }
  }
};
```

**After:**
```typescript
// operations/orchestrate.ts
export const orchestrate = operationPlan<{ planDir: Directory; slice: string }>(
  "Orchestrate development"
)
  .forCell<'orchestrator' | 'developer'>()
  .withDeadDrops({
    init: response<{}>(mission(initOrchestration, cell => cell.orchestrator)),
    continue: response<{}>(mission(pickNextStep, cell => cell.orchestrator)),
    developStory: response<{ story: string }>(mission(implementStory, cell => cell.developer.clone())),
  });

// tactical-missions/pick-next-step.ts
export const pickNextStep = (ctx: BriefingContext<{}>) =>
  Effect.gen(function* () {
    const state = yield* readState(ctx);
    if (state.phase === 'development') {
      yield* ctx.leave(ctx.operation.deadDrops.developStory({ story: state.currentStory }));
    }
  });
```

### Step 6: Update Cabinet API

Migrate Cabinet's MCP tools:

**From:**
- `mission_start` - Start a mission
- `mission_events` - Get mission events
- `mission_cancel` - Cancel a mission

**To:**
- `operation_start` - Start an operation
- `operation_status` - Get operation status
- `operation_pause` - Pause an operation
- `operation_resume` - Resume an operation
- `operation_cancel` - Cancel an operation

```typescript
// apps/cabinet/src/mcp/tools/operations.ts
export const operationStartTool = {
  name: 'operation_start',
  inputSchema: {
    wingName: { type: 'string' },
    costume: { type: 'string' },
    operation: { type: 'string' },
    params: { type: 'object' },
  },
  handler: async (input) => {
    const operation = await runner.start(plan, input.params);
    return { operationId: operation.id };
  }
};
```

## Compatibility Layer

For gradual migration, provide a compatibility layer:

```typescript
// libs/conductor/src/compat/MissionCompat.ts
export function wrapMissionAsOperation(mission: Mission): OperationPlan {
  // Creates a single-minion operation that runs the mission
  return operationPlan(mission.name)
    .forCell<'worker'>()
    .withDeadDrops({
      init: response<typeof mission.args>(
        mission(async (ctx) => {
          // Create legacy context
          const legacyCtx = createLegacyContext(ctx);
          await mission.run(legacyCtx, ctx.currentMessage.params);
        }, cell => cell.worker)
      ),
    });
}
```

This allows existing missions to run in the new infrastructure while being migrated.

## Migration Order

1. **Foundation**: Create `libs/operations/` with core types
2. **Runtime**: Implement OperationRunner, Cell, DeadDropDispatcher
3. **Closet**: Update ClosetLoader to support new structure
4. **Compat**: Add MissionCompat wrapper
5. **Cabinet**: Add new operation MCP tools alongside existing mission tools
6. **Costumes**: Migrate costumes one at a time
7. **Cleanup**: Remove legacy mission support

## Testing Strategy

Each step should be tested independently:

1. **Unit tests**: Operation plan construction, message routing
2. **Integration tests**: Full operation lifecycle with test minions
3. **Contract tests**: Cabinet API compatibility
4. **E2E tests**: Real operations with actual agentic clients
