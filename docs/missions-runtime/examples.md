# Examples

## Example 1: Operation Plan

A complete operation plan for developing a vertical slice:

```typescript
// costumes/dev-and-check/operations/develop_slice.ts
import { Effect } from 'effect';
import { operationPlan, response, mission, operation, StartWith } from '@minions/operations';
import { type Directory } from '@minions/file-system';
import { developStory } from '@this-costume/operations';
import { initSlice, pickNextStep, handleStoryComplete } from '@this-costume/tactical-missions';

export const developSlice = operationPlan<{ planDir: Directory; slice: string }>(
  "Develop a vertical slice"
)
  .forCell<'planner' | 'organizer' | 'developer'>()
  .withDeadDrops({
    init: response<{}>(
      mission(initSlice, cell => cell.organizer)
    ),
    continue: response<{}>(
      mission(pickNextStep, cell => cell.organizer)
    ),
    developStory: response<{ story: string }>(
      operation(developStory, StartWith.Init, cell => ({
        cell: { developer: cell.developer.clone() }
      }))
    ),
    storyComplete: response<{ storyIndex: number }>(
      mission(handleStoryComplete, cell => cell.organizer)
    ),
  });
```

## Example 2: Deterministic Briefing

A TypeScript briefing that coordinates work:

```typescript
// costumes/dev-and-check/tactical-missions/orchestrate.ts
import { Effect } from 'effect';
import type { BriefingContext } from '@minions/operations';

export const pickNextStep = (
  ctx: BriefingContext<{}>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    // Read state from filesystem
    const sliceDir = ctx.operation.params.planDir.child(ctx.operation.params.slice);
    const state = yield* readStateFile(sliceDir);

    if (state.phase === 'planning') {
      // Leave message at dead drop - operation plan determines routing
      yield* ctx.leave(ctx.operation.deadDrops.needsPlanning({ sliceName: state.sliceName }));
    } else if (state.phase === 'development') {
      yield* ctx.leave(ctx.operation.deadDrops.developStory({ story: state.currentStory }));
    }
    // Briefing complete - minion becomes free
  });

export const handleStoryComplete = (
  ctx: BriefingContext<{ storyIndex: number }>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    const nextIndex = ctx.currentMessage.params.storyIndex + 1;
    yield* updateState(ctx, { storyIndex: nextIndex });

    if (nextIndex >= totalStories) {
      yield* ctx.operation.done('success');
    } else {
      yield* ctx.leave(ctx.operation.deadDrops.continue({}));
    }
  });

// Helper to read state file
const readStateFile = (dir: Directory) =>
  Effect.gen(function* () {
    const stateFile = dir.child('state.json');
    if (!(yield* stateFile.exists())) {
      return { phase: 'init', storyIndex: 0 };
    }
    const content = yield* stateFile.readText();
    return JSON.parse(content) as SliceState;
  });
```

## Example 3: Gadget Usage

Using gadgets for blocking operations:

```typescript
// Asking a human (blocks until answer)
const answer = yield* ctx.gadget(AskHuman, {
  question: 'Should we proceed with this approach?',
  options: ['Yes', 'No', 'Modify']
});

// Running a shell command
const result = yield* ctx.gadget(RunShell, {
  command: 'pnpm test',
  timeout: 60000
});

// Reading a file (blocking version, vs workbench which is immediate)
const content = yield* ctx.gadget(ReadFile, { path: 'src/index.ts' });
```

Gadgets fit the dead drop model internally:
- Leaves a request message
- Registers the minion as recipient for the response
- Pauses the briefing (minion becomes blocked)
- Waits for response message
- Returns the result

## Example 4: Workbench Cloning

A pattern for isolating story-specific context:

```
1. Create base developer Minion (reads slice plan, understands rules)
2. Create workbench with PRD, architecture overview, common patterns
3. Associate workbench with developer

When starting a new story:
4. Clone the developer → "story-developer"
5. Clone the workbench → "story-workbench"
6. Associate story-workbench with story-developer
7. story-developer loads story plan into its history
8. Clone story-developer → "ready-developer"

Now:
- "ready-developer" has clean starting point for story work
- "story-developer" can continue, accumulating development context
- Technical reviewers can clone from either:
  - "ready-developer" for fresh perspective
  - "story-developer" for full context of what was tried
- All use "story-workbench" - seeing discoveries from this story only
```

In code:

```typescript
export const initStoryDevelopment = (
  ctx: BriefingContext<{ story: string }>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    // Clone workbench for story-specific context
    const storyWorkbench = yield* ctx.workbench.clone();

    // Add story-specific facts
    yield* storyWorkbench.addFact(`Working on story: ${ctx.currentMessage.params.story}`);

    // Update minion's workbench
    yield* ctx.minion.setWorkbench(storyWorkbench);

    // Continue with story-specific context
    yield* ctx.leave(ctx.operation.deadDrops.storyReady({}));
  });
```

## Example 5: Non-Deterministic Briefing (Markdown)

A markdown briefing for LLM-driven work:

```markdown
<!-- costumes/dev-and-check/tactical-missions/implement-story.md -->

# Implement Story

You are implementing story {{story}} for slice {{slice}}.

## Context

The story plan is at: {{planPath}}

## Your Task

1. Read the story plan to understand requirements
2. Implement the feature following the architecture
3. Write tests for your implementation
4. Run the test suite to verify
5. When complete, use the `leave_message` tool to signal completion:
   ```
   leave_message({ deadDrop: 'storyComplete', params: { storyIndex: {{storyIndex}} } })
   ```

## Guidelines

- Follow existing patterns in the codebase
- Keep changes focused on the story requirements
- If you encounter blockers, use `leave_message` with `needsGrounding`
```

## Example 6: Nested Operations

Spawning a nested operation from within a parent:

```typescript
// In the operation plan
developStory: response<{ story: string }>(
  operation(developStory, StartWith.Init, cell => ({
    cell: { developer: cell.developer.clone() }
  }))
),

// The nested operation runs with:
// - Its own cell (with developer role filled by clone of parent's developer)
// - Its own dead drop dispatcher
// - Parent waits for 'operation-done' message from nested operation
```

## Example 7: Reply-to-Sender Pattern

Routing a response back to whoever sent the current message:

**Key semantics:** `target: 'sender'` routes to the minion that sent the message
currently being processed. The responder chooses to notify the sender - the
original requester cannot "pull" responses to itself.

```typescript
// Developer leaves a message requesting grounding (no special target)
export const requestGrounding = (
  ctx: BriefingContext<{}>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    // Leave message at dead drop - operation plan determines handler
    yield* ctx.leave(
      ctx.operation.deadDrops.needsGrounding({ question: 'What architecture?' })
    );
    // Minion stays alive if it's a cell member or has other pending work
  });

// Grounding provider handles the request and replies to sender
export const provideGrounding = (
  ctx: BriefingContext<{ question: string }>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    // Determine the answer (maybe ask human, consult docs, etc.)
    const answer = yield* ctx.gadget(AskHuman, {
      question: ctx.currentMessage.params.question
    });

    // Reply back to whoever asked the question
    yield* ctx.leave(
      ctx.operation.deadDrops.groundingProvided({ answer }),
      { target: 'sender' }  // Routes to the minion that sent 'needsGrounding'
    );
  });

// Original requester's handler for the answer
export const handleGroundingProvided = (
  ctx: BriefingContext<{ answer: string }>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    yield* ctx.workbench.addFact(`Architecture decision: ${ctx.currentMessage.params.answer}`);

    // Continue work
    yield* ctx.leave(ctx.operation.deadDrops.continue({}));
  });
```

## Example 8: Parallel Work

Multiple minions working concurrently:

```typescript
export const startParallelStories = (
  ctx: BriefingContext<{ stories: string[] }>
): Effect.Effect<void, BriefingError> =>
  Effect.gen(function* () {
    // Leave multiple messages - each spawns a freelancer
    for (const story of ctx.currentMessage.params.stories) {
      yield* ctx.leave(ctx.operation.deadDrops.developStory({ story }));
    }
    // All messages are queued and processed concurrently
    // Responses arrive as each completes
  });
```

## Example 9: Costume Structure

A complete costume package:

```
closet/
  dev-and-check/
    package.json                    # { "dependencies": { "@costumes/core": "^1.0.0" } }

    operations/
      develop-slice.ts              # Main operation plan
      develop-story.ts              # Nested operation for single story

    tactical-missions/
      init-slice.ts                 # Deterministic: Set up slice state
      pick-next-step.ts             # Deterministic: Decide what to do
      implement-story.md            # Non-deterministic: LLM implements
      review-story.md               # Non-deterministic: LLM reviews

    disguises/
      developer.md                  # System prompt + model + gadgets
      reviewer.md
      orchestrator.md

    gadgets/
      run-tests.ts                  # Custom gadget: Run test suite
      check-types.ts                # Custom gadget: TypeScript check
```

Imports within the costume:

```typescript
// From this costume
import { developStory } from '@this-costume/operations';
import { initSlice } from '@this-costume/tactical-missions';

// From dependent costume
import { ReadFile, WriteFile } from '@costumes/core/gadgets';
```
