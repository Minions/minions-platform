# Hatchery Domain

> **Status**: 🚧 Under Development (Phase 1)

Hexagonal architecture library for creating, managing, and communicating with AI minions.

## What is Hatchery?

The Hatchery domain provides a clean abstraction for spawning and communicating with AI agents (minions) across multiple client types:

- **Claude Code** - Anthropic's CLI tool
- **Anthropic Agentic** - Direct SDK integration
- **OpenCode** - Alternative AI code assistant
- **CodePuppy** - Another AI assistant
- **Brainless** - Test fake for testing

## Architecture

Follows hexagonal (ports & adapters) architecture:

```
┌─────────────────────────────────────┐
│         Domain Layer                │
│   - MinionSpec                      │
│   - MinionMessage                   │
└─────────────────────────────────────┘
                 │
                 │ uses
                 ▼
┌─────────────────────────────────────┐
│          Port Layer                 │
│   - IHatchery                       │
│   - IMinion                         │
│   - IMinionClient                   │
└─────────────────────────────────────┘
                 │
                 │ implemented by
                 ▼
┌─────────────────────────────────────┐
│         Adapter Layer               │
│   Hatcheries:                       │
│     - ProductionHatchery            │
│     - ZombieHatchery (test fake)    │
│                                     │
│   Clients:                          │
│     - ClaudeCodeClient              │
│     - AnthropicAgenticClient        │
│     - OpenCodeClient                │
│     - CodePuppyClient               │
│     - BrainlessClient (test fake)   │
└─────────────────────────────────────┘
```

## Usage

```typescript
import { ProductionHatchery, type MinionSpec } from '@domains/hatchery';

const hatchery = new ProductionHatchery();

const spec: MinionSpec = {
  client: 'claude-code',
  wing: '/path/to/wing',
  model: 'claude-sonnet-4-20250514',
  useBuiltInSystemPrompt: true
};

const minion = await hatchery.spawn(spec);

await minion.start();
await minion.send({ type: 'user', content: 'Do something' });

for await (const message of minion.receive()) {
  console.log('Minion said:', message);
}

await minion.stop();
```

## Testing

```bash
# Run all tests
pnpm test

# Run in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage

# Run with UI
pnpm test:ui
```

## Key Features

- ✅ Hexagonal architecture with clean boundaries
- ✅ Contract testing for vertical slices
- ✅ Test fakes (ZombieHatchery, BrainlessMinion) for mission testing
- ✅ Bidirectional async communication (co-routines)
- ✅ Support for multiple AI client types
- ✅ Spawn event notifications for observability

## License

MIT
