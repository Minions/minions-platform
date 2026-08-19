# Platform Specifications - Hatchery Domain

This file tracks progress across all platform specs. Each spec represents a complete vertical slice from domain through adapters.

**Notation**:
- `[ ]` - Not started
- `[~]` - In progress
- `[x]` - Done

---

## Progress Summary

### Phase 1: Foundation - Brainless Minions (8 specs) ✅ COMPLETE
- [x] S1.1: MinionSpec Domain Type
- [x] S1.2: MinionMessage Domain Type
- [x] S1.3: Port Interfaces
- [x] S1.4: ISpawnEventEmitter Interface
- [x] S1.5: Hatchery Contract Tests (Vertical Slices)
- [x] S1.6: Minion Contract Tests (Vertical Slices)
- [x] S1.7: BrainlessMinion with Dual Co-routine
- [x] S1.8: ZombieHatchery with Spawn Events

### Phase 2: Communication (4 specs) ✅ COMPLETE
- [x] S2.1: Enhanced Message Buffering
- [x] S2.2: Async Iterator with Proper Termination
- [x] S2.3: Message Type Filtering
- [x] S2.4: Backpressure Handling

### Phase 3: Claude Code Client (5 specs)
- [ ] S3.1: ClaudeCodeClient Process Spawning
- [ ] S3.2: STDIO Stream Communication
- [ ] S3.3: District Context Integration
- [ ] S3.4: Error Handling and Recovery
- [ ] S3.5: ProductionHatchery with Claude Code Support

### Phase 4: Anthropic Agentic Client (4 specs)
- [ ] S4.1: AnthropicAgenticClient with SDK Integration
- [ ] S4.2: Streaming Response Handling
- [ ] S4.3: Model Selection
- [ ] S4.4: Tool Provisioning

### Phase 5: Additional Clients (4 specs)
- [ ] S5.1: Investigate OpenCode Integration Approach
- [ ] S5.2: Implement OpenCodeClient
- [ ] S5.3: Investigate CodePuppy Integration Approach
- [ ] S5.4: Implement CodePuppyClient

### Phase 6: Advanced Features (4 specs)
- [ ] S6.1: System Prompt Control
- [ ] S6.2: Tool Provisioning Enhancement
- [ ] S6.3: Metadata Handling
- [ ] S6.4: Configuration Validation

### Phase 7: Integration & Documentation (3 specs)
- [ ] S7.1: Public API Design and Barrel Exports
- [ ] S7.2: Usage Examples and Documentation
- [ ] S7.3: Integration Testing Suite

**Total**: 32 specs (30 original + 2 contract test specs)

---

## Detailed Spec Status

## Phase 1: Foundation - Brainless Minions

### Spec S1.1: MinionSpec Domain Type

**Status**: [x] ✅ Done
**Feature**: Core Domain
**Dependencies**: None
**Files**:
- `src/domain/MinionSpec.ts`
- `specs/domain/minion-spec.spec.ts`

**Tests**:
- [x] Can create spec with required fields
- [x] Validates client type
- [x] Accepts optional fields
- [x] Defaults useBuiltInSystemPrompt to true

**Implementation Notes**:
- Created MinionSpec interface with all required and optional fields
- Defined MinionClient type with all 5 client types
- Defined Tool interface for MCP-style tool definitions
- All 4 tests passing
- Commit: 97b7256

---

### Spec S1.2: MinionMessage Domain Type

**Status**: [x] ✅ Done
**Feature**: Core Domain
**Dependencies**: None
**Files**:
- `src/domain/MinionMessage.ts`
- `specs/domain/minion-message.spec.ts`

**Tests**:
- [x] Can create user message
- [x] Can create assistant message
- [x] Can create tool-use message
- [x] Can create tool-result message
- [x] Can create system message
- [x] Accepts optional metadata

**Implementation Notes**:
- Created MinionMessage interface with type, content, timestamp, and optional metadata
- Defined MessageType union with all 5 message types
- Content field typed as `any` to support different structures per message type
- All 6 tests passing
- Commit: 18bdba0

---

### Spec S1.3: Port Interfaces

**Status**: [x] ✅ Done
**Feature**: Port Layer
**Dependencies**: S1.1, S1.2
**Files**:
- `src/ports/IHatchery.ts`
- `src/ports/IMinion.ts`
- `src/ports/IMinionClient.ts`
- `src/ports/index.ts` (barrel export)
- `src/domain/index.ts` (barrel export)
- `specs/ports/interfaces.spec.ts`

**Tests**:
- [x] IHatchery can be implemented
- [x] IMinion has required properties
- [x] IMinion status is valid value
- [x] IMinionClient can be implemented

**Implementation Notes**:
- Created IHatchery interface with spawn() method
- Created IMinion interface with lifecycle, communication, and event methods
- Defined MinionStatus type: starting, running, stopped, error
- Created IMinionClient interface for client abstraction
- Added barrel exports for domain and ports layers
- All 4 tests passing
- Commit: 5c886c7

---

### Spec S1.4: ISpawnEventEmitter Interface

**Status**: [x] ✅ Done
**Feature**: Port Layer
**Dependencies**: S1.3
**Files**:
- `src/ports/ISpawnEventEmitter.ts`
- `src/ports/index.ts` (updated barrel export)
- `specs/ports/spawn-event-emitter.spec.ts`

**Tests**:
- [x] Can be implemented
- [x] Type-checks spawn event handler

**Implementation Notes**:
- Created ISpawnEventEmitter interface for test observability
- on() method subscribes to 'spawn' events with (minion, spec) handler
- off() method unsubscribes from events
- Enables tests to intercept and configure spawned minions
- All 2 tests passing
- Commit: b11c196

---

### Spec S1.5: Hatchery Contract Tests

**Status**: [x] ✅ Done
**Feature**: Contract Testing (Vertical Slices)
**Dependencies**: S1.3, S1.4
**Files**:
- `specs/contracts/hatchery-contract.spec.ts` (parameterized contract tests)
- `specs/contracts/hatchery-contract-structure.spec.ts` (structure verification)

**Tests**:
- [x] SLICE 1: Can spawn minions from spec
- [x] SLICE 2: Spawns multiple minions independently
- [x] SLICE 3: Spawned minions have correct initial state

**Implementation Notes**:
- Created testHatcheryContract() parameterized test function
- Accepts: name, createHatchery factory, isProduction boolean
- Helper function createTestSpec() for spec creation
- Defines 3 vertical slices that all hatcheries must satisfy
- Structure verified with 2 passing tests
- Will be applied to ZombieHatchery in S1.8 and ProductionHatchery in Phase 3
- Commit: 02c7f6f

**CRITICAL**: These contract tests will be reused in Phase 3 for ProductionHatchery.

---

### Spec S1.6: Minion Contract Tests

**Status**: [x] ✅ Done
**Feature**: Contract Testing (Vertical Slices)
**Dependencies**: S1.3
**Files**:
- `specs/contracts/minion-contract.spec.ts` (parameterized contract tests)
- `specs/contracts/minion-contract-structure.spec.ts` (structure verification)

**Tests**:
- [x] SLICE 1: Implements IMinion interface
- [x] SLICE 2: Transitions through lifecycle states
- [x] SLICE 3: Emits status-change events
- [x] SLICE 4: Supports bidirectional communication

**Implementation Notes**:
- Created testMinionContract() parameterized test function
- Accepts: name, createMinion factory
- Defines 4 vertical slices that all minions must satisfy
- SLICE 4 (communication) has implementation-specific behavior
- Structure verified with 2 passing tests
- Will be applied to BrainlessMinion in S1.7 and RealMinion in Phase 3
- Commit: f49f6cb

**CRITICAL**: These contract tests will be reused for RealMinion in Phase 3.

---

### Spec S1.7: BrainlessMinion with Dual Co-routine

**Status**: [x] ✅ Done
**Feature**: Test Adapter
**Dependencies**: S1.1, S1.2, S1.3, S1.6
**Files**:
- `src/adapters/minions/BrainlessMinion.ts` (implementation)
- `specs/adapters/brainless-minion.spec.ts` (tests)

**Tests**:
- [x] Implements IMinion interface (contract test)
- [x] Transitions through lifecycle states (contract test)
- [x] Emits status-change events (contract test)
- [x] Supports bidirectional communication (contract test)
- [x] Supports production send and test receive (specific test)
- [x] Supports test send and production receive (specific test)
- [x] Supports bidirectional communication (specific test)
- [x] Buffers messages when not consuming (specific test)

**Implementation Notes**:
- Implements IMinion interface with dual co-routine pattern
- Two message queues: prodToTestQueue and testToProdQueue
- Production side: send() and receive()
- Test side: testSend() and testReceive()
- Lifecycle management with status transitions (stopped → starting → running)
- Event emission using eventemitter3
- Message buffering in queues
- All 11 tests passing (4 contract + 7 specific)
- Commit: 8767529

---

### Spec S1.8: ZombieHatchery with Spawn Events

**Status**: [x] ✅ Done
**Feature**: Test Adapter
**Dependencies**: S1.5, S1.7
**Files**:
- `src/adapters/hatcheries/ZombieHatchery.ts` (implementation)
- `specs/adapters/zombie-hatchery.spec.ts` (tests)

**Tests**:
- [x] Can spawn minions from spec (contract test)
- [x] Spawns multiple minions independently (contract test)
- [x] Spawned minions have correct initial state (contract test)
- [x] Implements IHatchery interface (specific test)
- [x] Implements ISpawnEventEmitter interface (specific test)
- [x] Spawns brainless minions (specific test)
- [x] Emits spawn event when minion created (specific test)
- [x] Emits spawn events for multiple minions (specific test)
- [x] Can remove spawn event listeners (specific test)

**Implementation Notes**:
- Implements IHatchery and ISpawnEventEmitter interfaces
- Creates BrainlessMinion instances
- Emits 'spawn' event after each minion creation
- Event handler receives (minion, spec) parameters
- Uses eventemitter3 for event management
- All 9 tests passing (3 contract + 6 specific)
- Commit: c82e5b7

---

## Phase 2: Communication

### Spec S2.1: Enhanced Message Buffering

**Status**: [x] ✅ Done
**Feature**: Communication
**Dependencies**: Phase 1 complete
**Files**:
- `specs/communication/s2.1-enhanced-buffering.spec.ts`

**Tests**:
- [x] Handles high-volume message buffering
- [x] Messages delivered in order

**Implementation Notes**:
- BrainlessMinion already supports buffering via message queues
- Verified no message loss with 1000+ messages
- All 2 tests passing

---

### Spec S2.2: Async Iterator with Proper Termination

**Status**: [x] ✅ Done
**Feature**: Communication
**Dependencies**: S2.1
**Files**:
- `specs/communication/s2.2-iterator-termination.spec.ts`

**Tests**:
- [x] Async iterator completes when minion dies
- [x] Buffered messages delivered before completion
- [x] Handles graceful shutdown with /exit
- [x] Multiple iterations work independently

**Implementation Notes**:
- BrainlessMinion's receive() properly terminates when killed
- Buffered messages drained before iterator completes
- All 4 tests passing

---

### Spec S2.3: Message Type Filtering

**Status**: [x] ✅ Done
**Feature**: Communication
**Dependencies**: S2.2
**Files**:
- `specs/communication/s2.3-message-filtering.spec.ts`

**Tests**:
- [x] Can filter by single message type
- [x] Can filter by multiple message types
- [x] Unfiltered receive() returns all messages
- [x] Filter works with async iteration

**Implementation Notes**:
- Added receive() method with optional type filter parameter
- Supports single type and multiple types via array
- All 4 tests passing

---

### Spec S2.4: Backpressure Handling

**Status**: [x] ✅ Done
**Feature**: Communication
**Dependencies**: S2.3
**Files**:
- `specs/communication/s2.4-backpressure.spec.ts`

**Tests**:
- [x] Configurable buffer limits
- [x] send() blocks when buffer full
- [x] send() unblocks when buffer drains

**Implementation Notes**:
- BrainlessMinion supports optional maxBufferSize parameter
- send() blocks (awaits) when buffer is full
- Implements backpressure to prevent memory overflow
- All 3 tests passing

---

## Phase 3: Claude Code Client

*(Phase 3 specs to be implemented...)*

---

## Implementation Workflow

1. **Choose Next Spec**:
   - Find first `[ ]` spec with all dependencies `[x]`
   - Mark as `[~]` in progress

2. **Implement**:
   - Follow test-first development
   - Update test checkboxes as you complete them
   - Add implementation notes

3. **Complete**:
   - Mark all tests `[x]`
   - Mark spec `[x]` done
   - Add commit hashes to implementation notes
   - Move to next spec

4. **Track Progress**:
   - Keep this file updated constantly
   - Commit changes to this file after each spec
   - Use this file to resume work after context loss

---

## Client Support Matrix

Track which features work with which clients:

```
┌─────────────────────┬───────────┬───────────┬──────────┬───────────┬───────────┐
│ Feature             │ Brainless │ Claude    │ Anthropic│ OpenCode  │ CodePuppy │
│                     │           │ Code      │          │           │           │
├─────────────────────┼───────────┼───────────┼──────────┼───────────┼───────────┤
│ Spawn/Stop          │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ Send/Receive        │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ Streaming           │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ District Context    │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ Model Selection     │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ System Prompts      │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ Custom Tools        │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
│ Metadata            │    [ ]    │    [ ]    │   [ ]    │    [ ]    │    [ ]    │
└─────────────────────┴───────────┴───────────┴──────────┴───────────┴───────────┘
```

---

## Notes

- This file is the single source of truth for implementation progress
- Update it constantly as you work
- Use it to communicate status to other implementors
- Commit changes frequently
