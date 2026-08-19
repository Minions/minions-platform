# Execution

## Operation Startup

When an operation is started (via Cabinet API or from another operation):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Operation Start Flow                                │
│                                                                              │
│  Input: wingName, costume, operation, params, cellAssignments?               │
│                                                                              │
│  1. Resolve Wing                                                             │
│     ├── lair.getWing(wingName)                                              │
│     └── → Wing object                                                        │
│                                                                              │
│  2. Build Closet                                                             │
│     ├── wingCloset = WingCloset(wing.closet)                                │
│     ├── lairCloset = LairCloset(lair.closet)                                │
│     └── closet = CompositeCloset(wingCloset, lairCloset)                    │
│                                                                              │
│  3. Load Operation Plan                                                      │
│     ├── closet.loadOperation(costume, operation)                            │
│     └── → OperationPlan                                                      │
│                                                                              │
│  4. Create Cell                                                              │
│     ├── For each role in plan.cell:                                         │
│     │   ├── If cellAssignment provided: use specified minion                │
│     │   └── Else: create new-recruit minion                                 │
│     └── → Cell with all roles filled                                        │
│                                                                              │
│  5. Create Operation Instance                                                │
│     ├── operation = { id, plan, params, cell, deadDrops }                   │
│     └── Register with runtime                                                │
│                                                                              │
│  6. Leave Initial Messages                                                   │
│     ├── If first run: leave 'init' message                                  │
│     │   └── init sets up initial state in wing filesystem                   │
│     └── Always: leave 'continue' message                                    │
│         └── continue reads state, decides what to do next                   │
│                                                                              │
│  7. Return Operation Handle                                                  │
│     └── { operationId, status: 'running' }                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Init vs Continue Semantics:**

- `init` runs only on first start, not on resume. It sets up initial state.
- `continue` always runs. It reads state and decides what to do next.
- Every step that affects next action updates state in the wing filesystem.
- On pause or crash, resume creates a new operation instance with fresh minions, skips init, starts with continue.
- Continue re-orients from filesystem state and resumes work.

## Dead Drop Flow

The core execution model is message-based:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Dead Drop Message Flow                              │
│                                                                              │
│  1. Message Arrives at Dead Drop                                             │
│     ├── deadDrop: 'developStory'                                            │
│     ├── params: { story: 'story-01' }                                       │
│     └── sender: <Minion instance>                │
│                                                                              │
│  2. Look Up Response in Operation Plan                                       │
│     ├── plan.deadDrops['developStory']                                      │
│     └── → Response { params, assignment }                                    │
│                                                                              │
│  3. Resolve Assignment                                                       │
│                                                                              │
│     If TacticalAssignment:                                                   │
│     ├── Resolve minion spec:                                                │
│     │   ├── 'existing' + role → cell[role]                                  │
│     │   ├── 'existing' + sender → lookup sender minion                      │
│     │   ├── 'clone-of' + role → cell[role].clone()                          │
│     │   ├── 'clone-of' + sender → sender.clone()                            │
│     │   └── 'new-recruit' → createMinion()                                  │
│     ├── Apply disguise to minion                                            │
│     └── Execute briefing                                                     │
│                                                                              │
│     If OperationalAssignment:                                                │
│     ├── Create nested operation                                             │
│     ├── Fill cell roles per cellAssignments                                 │
│     ├── If StartsWith.Init, then leave 'init' to nested operation                                    │
│     └── Leave 'Continue' to nested operation                                    │
│                                                                              │
│  4. Briefing Executes                                                        │
│     ├── Minion runs briefing (TypeScript or markdown)                       │
│     ├── May leave more messages                                             │
│     ├── May use gadgets                                                     │
│     └── Eventually completes                                                 │
│                                                                              │
│  5. Minion Becomes Free                                                      │
│     ├── If cell member: stays assigned to role                              │
│     ├── If freelancer with pending sent event: waits                             │
│     └── If freelancer with no roots: terminates                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Briefing Execution

### Deterministic Briefing (TypeScript)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Deterministic Briefing Execution                          │
│                                                                              │
│  1. Create BriefingContext                                                   │
│     ctx = {                                                                  │
│       lair, wing, closet,                                                    │
│       workbench: minion.workbench,                                           │
│       operation: { params, deadDrops, done, fail },                          │
│       currentMessage,                                                        │
│       minion: { id, workbench, setWorkbench },                              │
│       cell: { operationId, roles, getMinion },                              │
│       leave: (msg, target?) => ...,                                          │
│       gadget: (gadget, params) => ...,                                       │
│     }                                                                        │
│                                                                              │
│  2. Call briefing function                                                   │
│     await Effect.runPromise(briefing(ctx))                                  │
│                                                                              │
│  3. Handle Effects                                                           │
│     ├── leave() → Queue message for delivery                                │
│     ├── gadget() → Execute gadget, block until response                     │
│     ├── operation.done() → Signal operation complete                        │
│     └── operation.fail() → Signal operation failed                          │
│                                                                              │
│  4. Briefing Complete                                                        │
│     └── Minion becomes free (or waits for reply)                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Non-Deterministic Briefing (Markdown)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Non-Deterministic Briefing Execution                         │
│                                                                              │
│  1. Initialize Agentic Client                                                │
│     ├── Apply disguise (model, system prompt, temperature, etc.)            │
│     ├── Load history (prior deterministic and non-deterministic messages)   │
│     └── Attach workbench context (document nodes or similar)                │
│                                                                              │
│  2. Load and Render Briefing                                                 │
│     ├── content = fs.readFile(briefing)                                     │
│     └── Render template variables from currentMessage.params                 │
│                                                                              │
│  3. Send to Agentic Client                                                   │
│     ├── Minion is Claude Code / Open Code / etc.                            │
│     └── minion.send(renderedContent)                                        │
│                                                                              │
│  4. Agentic Client Runs                                                      │
│     ├── LLM generates response                                              │
│     ├── May use gadgets (tools)                                             │
│     ├── May leave messages via dead drops gadget                            │
│     └── Continues until done                                                 │
│                                                                              │
│  5. Completion Detection                                                     │
│     ├── Client signals done (special tool call)                             │
│     ├── Or: No more tool calls in response                                  │
│     └── Or: Max turns reached                                               │
│                                                                              │
│  6. Memory Retention                                                         │
│     ├── Session memory retained while Minion lives                          │
│     ├── Supports /resume or /fork with additional context                   │
│     └── More deterministic messages can be injected before resuming         │
│                                                                              │
│  7. Briefing Complete                                                        │
│     └── Minion becomes free (or waits for reply)                            │
│                                                                              │
│  On Minion Termination:                                                      │
│     ├── Full telemetry recorded to wing filesystem                          │
│     └── Agentic client session can be cleaned up                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Minion Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Minion Lifecycle                                    │
│                                                                              │
│  Creation:                                                                   │
│  ┌──────────┐      ┌──────────┐                                             │
│  │ new      │      │ clone    │                                             │
│  │ recruit  │      │          │                                             │
│  └────┬─────┘      └────┬─────┘                                             │
│       │                 │                                                    │
│       │ Empty history   │ Copied history                                    │
│       │                 │                                                    │
│       └────────┬────────┘                                                   │
│                │                                                             │
│                ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          MINION (idle)                                   ││
│  │                                                                          ││
│  │  Identity = History (immutable across disguise changes)                  ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                │                                                             │
│                │ Assignment arrives                                          │
│                ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        MINION (executing)                                ││
│  │                                                                          ││
│  │  - Running briefing                                                      ││
│  │  - May use gadgets (becomes 'blocked' during gadget calls)              ││
│  │  - May leave messages                                                    ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                │                                                             │
│                │ Briefing complete                                           │
│                ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          Check Roots                                     ││
│  │                                                                          ││
│  │  Is minion rooted?                                                       ││
│  │  ├── In cell role? → Stay alive, return to idle                         ││
│  │  ├── Target of pending reply? → Stay alive, wait                        ││
│  │  └── No roots? → Proceed to debrief                                     ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                │                                                             │
│                │ No roots                                                    │
│                ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                            Debrief                                       ││
│  │                                                                          ││
│  │  - Gather telemetry                                                      ││
│  │  - Record briefings executed, messages left, gadgets used, all history, etc               ││
│  │  - Store for system improvement                                          ││
│  │                                                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                │                                                             │
│                ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          MINION (terminated)                             ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Operation Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Operation Lifecycle                                   │
│                                                                              │
│  init                                                                        │
│    │                                                                         │
│    │ Set up initial state                                                    │
│    ▼                                                                         │
│  continue ◄────────────────────────┐                                        │
│    │                               │                                         │
│    │ Main work loop                │                                         │
│    │ - Leave messages              │                                         │
│    │ - Spawn freelancers           │ Loop until done                        │
│    │ - Nested operations           │                                         │
│    │                               │                                         │
│    ├───────────────────────────────┘                                        │
│    │                                                                         │
│    │ operation.done() called                                                 │
│    ▼                                                                         │
│  operation-done                                                              │
│    │                                                                         │
│    │ Cleanup, notify parent                                                  │
│    ▼                                                                         │
│  debrief                                                                     │
│    │                                                                         │
│    │ Gather learnings from all cell members                                  │
│    ▼                                                                         │
│  Cell deconstruction                                                         │
│    │                                                                         │
│    │ Terminate all minions                                                   │
│    └── Operation complete                                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Pause and Resume

Operations are designed to be resumable:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Pause/Resume                                      │
│                                                                              │
│  Pause Triggers:                                                             │
│  ├── Blocked on human input (ask gadget)                                    │
│  ├── Out of tokens/budget                                                   │
│  ├── Exploring alternatives                                                 │
│  ├── Crash                                                 │
│  └── External interrupt                                                     │
│                                                                              │
│  Pause Process:                                                              │
│  1. State is in wing filesystem (plans, progress, etc.)                     │
│  2. Kill all minions (they're ephemeral)                                    │
│  3. Store operation ID and minimal context                                  │
│                                                                              │
│  Resume Process:                                                             │
│  1. Load operation plan from closet                                         │
│  2. Recreate cell (new minions, fresh history)                              │
│  3. Leave 'continue' message                                                │
│  4. Deterministic briefing reads state from filesystem                      │
│  5. Decides what to do next                                                 │
│                                                                              │
│  Key Principle:                                                              │
│  Operations should NOT depend on minion memory for correctness.             │
│  Minion memory is an optimization (context accumulation).                   │
│  All essential state lives in the wing filesystem.                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Gadget Execution

Gadgets provide blocking request/response semantics within the async model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Gadget Execution                                    │
│                                                                              │
│  1. Briefing calls ctx.gadget(AskHuman, { question: '...' })                │
│                                                                              │
│  2. Internally:                                                              │
│     ├── Leave request message with correlationId                            │
│     ├── Register minion as recipient for response                           │
│     ├── Minion status → 'blocked'                                           │
│     └── Briefing suspends                                                    │
│                                                                              │
│  3. Gadget handler processes request                                         │
│     ├── (For AskHuman: waits for human input)                               │
│     └── Leaves response message targeting correlationId recipient           │
│                                                                              │
│  4. Response arrives:                                                        │
│     ├── Routed to waiting minion                                            │
│     ├── Minion status → 'executing'                                         │
│     └── Briefing resumes with result                                        │
│                                                                              │
│  This is transparent to the briefing code:                                   │
│  const answer = yield* ctx.gadget(AskHuman, { question: 'Proceed?' });      │
│  // answer is the human's response                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Concurrency Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Concurrency Model                                   │
│                                                                              │
│  Within a Cell:                                                              │
│  ├── Multiple minions execute concurrently                                  │
│  ├── Each has own history (no sharing)                                      │
│  ├── Share world via wing filesystem                                        │
│  └── Coordinate via dead drops                                              │
│                                                                              │
│  Example: Parallel Development                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  orchestrator leaves "developStory" for story-01                     │   │
│  │  orchestrator leaves "developStory" for story-02                     │   │
│  │  orchestrator leaves "developStory" for story-03                     │   │
│  │                                                                       │   │
│  │  Three developer clones spawn and work concurrently                  │   │
│  │  Each may leave "needsReview" at different times                     │   │
│  │  Reviews also run concurrently                                       │   │
│  │                                                                       │   │
│  │  orchestrator receives "storyComplete" messages as they finish       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  Isolation:                                                                  │
│  ├── Same wing: Minions see each other's filesystem changes                │
│  ├── Different wings: Full isolation via git                               │
│  └── Use wings for experiments, rollback, parallel exploration             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```
