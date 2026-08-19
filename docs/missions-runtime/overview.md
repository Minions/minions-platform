# Overview

## The Espionage Metaphor

The system is modeled after an espionage thriller like Mission Impossible:

| Concept | Espionage Analog | Description |
|---------|------------------|-------------|
| **Operation** | The mission | A running instance with goal, team, and coordination |
| **Operation Plan** | Operation Plan document | The recorded program that can be instantiated |
| **Cell** | The team | A set of agents that know each other, work independently, coordinate via messages |
| **Minion** | An agent | An individual with identity (history), can wear disguises, takes assignments |
| **Disguise** | Cover identity | System prompt + model + gadgets - can be changed at any time |
| **Briefing** | Mission Briefing | What the agent does next (TypeScript or markdown) |
| **Dead Drop** | Dead drop location | Where secret messages are left; the routing table |
| **Secret Message** | The message left at a dead drop | Data payload passed between agents |
| **Workbench** | *(no parallel)* | Shared world context that doesn't require tool calls |
| **Wing filesystem** | The world | Persistent shared state - the reality agents operate in |
| **Costume** | Equipment package | A package of capabilities that can depend on other costumes |
| **Quartermaster** | Package registry | Distributes the installer and all costumes |

## Key Principles

### 1. Minions are Agentic Clients, Not LLM Calls

Minions ARE instances of agentic coding clients (Claude Code, Open Code, Codex, etc.). They are not thin wrappers around LLM calls. The agentic client handles the LLM interaction internally.

**Implication**: No `ctx.askLLM()` or `ctx.runLLMLoop()`. If deterministic code needs LLM help, it leaves a secret message that routes to a Minion with a non-deterministic briefing.

### 2. Dead Drops, Not Phone Calls

Nothing "returns". Missions leave secret messages at dead drops. Other things pick them up and respond. The system is fundamentally asynchronous and parallel - like coroutines or promises.

**Example flow** (shows async nature):
```
Dead drop receives "story-ready" message
  → Operation Plan routes to clone of Developer role
  → Developer Minion gets assignment (briefing + disguise as coder)
  → Developer works a while
  → Developer leaves "needs-technical-review" message
  → Developer works a while
  → Developer leaves "needs-grounding" message (target: sender)
  → Developer stops mission, becoming free
  → Runtime sees Developer is target of pending reply, so does not terminate it

Asynchronously, dead drop receives "needs-technical-review" message
  → Operation Plan routes to clone of sender
  → Cloned Minion gets assignment (briefing + disguise as technical reviewer)
  → Reviewer works, leaves "review-complete" message
  → ...

Dead drop receives "grounding-answered" message (routed to original sender)
  → Developer resumes work with grounding answer
  → Developer leaves "story-complete" message
```

Key insight: Minions leave secret messages and either become free or wait for a reply. The most common patterns for staying rooted are:
- **Reply-to-sender**: Leave a message which has not yet finished executing. Recipient or someone else may send a message targeting that message's sender.
- **Cell membership**: Remain assigned to a cell role (current cell or cell for a new operation)

### 3. Identity = History (and Nothing Else)

**History IS identity.** Disguise (system prompt, model, gadgets) is costume - changeable at any time. A Minion is defined solely by what it remembers.

**Implication**: When you change a Minion's disguise, it's still the same Minion. When you clone a Minion, you create a new identity that starts with the same memories but diverges from there.

### 4. Sharing via Workbench and Filesystem Only

Minions NEVER share history. They share information via:
- **Workbench**: In-memory knowledge of the world (avoids tool calls for repeated reads)
- **Wing filesystem**: Persistent shared state - the world itself

**Implication**: If Minion A reads a file and Minion B needs that info, either:
- Put it in the workbench (Minion B reads from workbench)
- Minion B reads the file again
- Clone Minion A after it read the file (Minion B starts knowing it)

**Concurrency**: Minions executing in the same wing operate in the same world and can see each other's effects. If isolation is needed, run Minions in different wings and manage visibility using git.

### 5. Cell Members vs Freelancers

Minions are always part of a team, but come in two kinds:

**Cell Members**: Full members assigned to named roles. They survive as long as the operation continues.

**Freelancers**: Brought in to do a particular tactical mission and respond to any follow-up messages. Terminated when no longer needed. Freelancers are often clones of cell members, but not always.

**Cell structure**:
- Named **roles** (e.g., "developer", "reviewer", "orchestrator") filled by cell members

**Not part of cell**:
- **Freelancers** spawned for specific messages (clones, new-recruits)
- **Dead drops** part of the Operation Plan, not the cell
- **Coordination** happens through dead drop routing, not direct calls

### 6. Operation Plan Defines Dead Drop Routing

The **Operation Plan** is a declarative routing table defined with a fluent, type-safe builder:

```typescript
import { initSlice, pickNextStep, handleStoryComplete } from '@this-costume/tactical-missions';
import { developStory } from '@this-costume/operations';

export const developSlice = operationPlan<{planDir: Directory, slice: string}>("Develop a vertical slice")
    .forCell<'planner' | 'organizer' | 'developer'>()
    .withDeadDrops({
        init: response<{}>(mission(initSlice, cell => cell.organizer)),
        continue: response<{}>(mission(pickNextStep, cell => cell.organizer)),
        developStory: response<{story: string}>(operation(
            developStory,
            StartWith.Init,
            cell => ({ cell: { developer: cell.developer.clone() } })
        )),
        storyComplete: response<{storyIndex: number}>(mission(
            handleStoryComplete, cell => cell.organizer)),
    });
```

Dead drop names are derived from the field names. No string duplication.

### 7. Tactical vs Operational Assignments

**Tactical Assignment**: Single Minion does a task.
- Minion spec (who: role, clone, new-recruit, sender, recipient-of-message)
- Disguise (system prompt + model + gadgets)
- Briefing (TypeScript function or markdown file)

**Operational Assignment**: Spawn a nested Operation.
- Operation Plan (which plan)
- Init or Resume
- Cell assignments (which Minions fill which roles)
- Initial messages (after Continue)

### 8. Built-in Lifecycle: Init, Continue, Debrief

Every Operation Plan responds to four mandatory dead drops:

| Dead Drop | When | Purpose |
|-----------|------|---------|
| **init** | Operation starts fresh | Set up initial state |
| **continue** | After init, or on resume | Main work loop |
| **operation-done** | Anyone signals completion | Triggers cleanup |
| **debrief** | After done, before deconstruction | Gather learnings |

**Pause/Resume is built in**: If an Operation has no work to do (blocked on human input, out of tokens, exploring alternatives), it pauses. Resume = recreate cell + send Continue.

**Operations should be resumable**: Design so the cell can be entirely killed at any time, and a new cell can form and successfully carry on the operation. Minion memory is an optimization, not a requirement. State lives in the wing filesystem.

### 9. Minion Lifecycle with Debrief

```
create (new-recruit or clone)
  → assignment → assignment → ...
  → debrief
  → terminate
```

**Termination rules**:
- All Minions get debriefed before termination
- Minions are terminated when they have no roots:
  - Not in a cell role
  - Not target of a pending reply
  - Not known by another Minion

**Debriefs become telemetry** for system improvement.

### 10. Deterministic Missions are Coordinators

Deterministic missions (TypeScript) are designed to be the top-level or bottom-level of the system:

**Top-level**: Figure out what needs to happen and leave secret messages to route work to non-deterministic missions. Prepare workbenches, params, etc.

**Bottom-level**: Just get stuff done. Often implemented as gadgets rather than missions.

Deterministic code uses low-cost, local computation to decide what messages need to be left next and to minimize re-work between non-deterministic missions.

If deterministic code needs LLM intelligence, it can:
1. Leave a secret message that routes to a non-deterministic briefing
2. Use a gadget that makes a single LLM call (not in v1, probably not ever)

There is no "run an agentic loop from deterministic code" - that's what operations are for.

### 11. Costumes and Dependencies

**Costumes are packages** that can depend on other costumes (like pnpm projects):

```
closet/
  dev-and-check/
    package.json              # Dependencies on other costumes
    operations/
      orchestrate.ts          # Operation Plan
      develop-story.ts        # Nested Operation Plan
    disguises/
      developer.md            # System prompt + model + gadgets
      reviewer.md
    tactical-missions/
      implement-story.md      # Non-deterministic briefing (markdown)
      review-story.ts         # Deterministic briefing (TypeScript)
    gadgets/
      run-tests.ts            # Custom gadget
```

**Imports**:
- From another costume: `import { foo } from '@costumes/other-costume/tactical-missions'`
- From this costume: `import { bar } from '@this-costume/operations'`

**Ecosystem costumes** are pre-defined and always loaded:
- **Dead drops costume**: Message sending gadgets (`leave_message`, `get_dead_drop_schema`)
- Additional system gadgets may be factored into costumes

**Agentic system tools** (Claude Code's native tools) are mapped to the gadget system, allowing disguises to enable/disable or replace them.

**Disguises have full control** over available tools via their gadget requisition. They can reference gadgets from any costume in their dependency tree.

**Closet resolution**: Wing closet overrides lair closet. `closet.listCostumes()` shows `source: 'wing' | 'lair'` for visibility.

### 12. Cabinet Runs an Operation

The Cabinet itself runs an operation with a cell. This operation:
- Handles throne room requests (via MCP API)
- Can respond to secret messages by launching provided operations
- Creates nested operation cells as normal

**Tactical missions are always part of some operation.** When a tactical mission runs, it has the minion defined by the operation that spawned it.

**Two kinds of tools**:
- **Cabinet MCP API**: For throne room use (external API)
- **Gadgets**: For in-system use (costumes, not MCP - though a costume can include gadgets that happen to be implemented by MCP, e.g., to an existing MCP provider)
