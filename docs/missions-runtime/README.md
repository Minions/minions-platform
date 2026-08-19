# Missions Runtime

Documentation for the Operations & Cells runtime architecture.

## Quick Links

| Document | Description |
|----------|-------------|
| [Overview](./overview.md) | The espionage metaphor, core concepts, and key principles |
| [Object Model](./object-model.md) | Type definitions for Operations, Cells, Dead Drops, etc. |
| [Execution](./execution.md) | How operations run, dead drop flow, minion lifecycle |
| [Examples](./examples.md) | Code examples for common patterns |
| [Migration](./migration.md) | Migration path from current implementation |

## Architecture Summary

The system is modeled after an espionage thriller like Mission Impossible:

- **Operations** run with a **Cell** (team of Minions)
- **Minions** are agentic clients (Claude Code, Open Code, etc.) with identity = history
- **Dead Drops** route **Secret Messages** between agents asynchronously
- **Briefings** (TypeScript or markdown) define what an agent does next
- **Workbenches** provide shared world knowledge without tool calls
- **Costumes** package capabilities (operations, missions, disguises, gadgets)

Nothing returns. Everything is event-based via dead drops.

## Key Principles

1. **Minions are Agentic Clients** - Not LLM wrappers; Claude Code etc. handle LLM internally
2. **Dead Drops, Not Phone Calls** - Async message passing, nothing returns
3. **Identity = History** - Disguise is costume; history is identity
4. **Sharing via Workbench/Filesystem** - Never share history between minions
5. **Cell Members vs Freelancers** - Named roles vs spawned-for-message minions
6. **Operation Plans Define Routing** - Declarative dead drop → assignment tables
7. **Built-in Lifecycle** - init, continue, operation-done, debrief
8. **Costumes are Packages** - Can depend on other costumes, import across them
