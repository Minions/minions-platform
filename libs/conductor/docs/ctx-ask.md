# ctx.ask() Documentation

## Overview

`ctx.ask()` enables missions to ask human questions and block until an answer is provided. This is used for decisions that require human judgment or approval.

## API Signature

```typescript
ctx.ask(options: AskOptions): Effect.Effect<string, AskError, never>
```

### AskOptions

```typescript
interface AskOptions {
  /** Question to ask the human */
  question: string;

  /** Optional context to help the human understand */
  context?: string;

  /** Suggested answers (human can still provide free-form response) */
  suggestions?: string[];

  /** Timeout in milliseconds (default: wait indefinitely) */
  timeout?: number;
}
```

### Return Type

Returns an Effect that:
- **Success**: Produces the human's answer as a string
- **Failure**: Fails with `AskError` if the question times out, is cancelled, or encounters an error
- **Requirements**: None (no dependencies required)

### AskError

```typescript
class AskError extends Data.TaggedError('AskError')<{
  question: string;  // The question that was asked
  reason: string;    // Why the ask failed (e.g., "Question timeout", "Question was cancelled")
}>
```

## How It Works

### Internal Flow

1. **Mission calls ctx.ask()**: The Effect is created with the question options
2. **IQuestionBridge routes the question**: The bridge implementation determines how to present the question
3. **Question is presented to human**: Via MCP (Cabinet), CLI, or test harness
4. **Mission blocks**: The Effect suspends until an answer is provided
5. **Answer is returned**: The Effect resumes with the human's answer string

### Bridge Implementations

| Bridge | When Used | How Questions Appear |
|--------|-----------|---------------------|
| **CabinetQuestionBridge** | Production (Cabinet) | Questions appear in Cabinet's question queue, accessible via MCP tools |
| **CLIQuestionBridge** | CLI usage | Questions appear as prompts in the terminal |
| **TestQuestionBridge** | Testing | Pre-programmed answers are returned immediately |

### CabinetQuestionBridge Details

The production implementation used by Cabinet:

```typescript
class CabinetQuestionBridge implements IQuestionBridge {
  async ask(options: AskOptions, missionRunId: string, wingName: string): Promise<string> {
    // 1. Add question to Cabinet's QuestionQueue
    const question = queue.add({
      minionId: missionRunId,
      wingName,
      content: options.question,
      context: options.context ?? '',
    });

    // 2. Poll the queue until answered or cancelled
    while (true) {
      const current = queue.get(question.id);

      if (current.status === 'answered') {
        return current.answer;
      }

      if (current.status === 'cancelled') {
        throw new Error('Question was cancelled');
      }

      // Wait before polling again
      await sleep(pollInterval);
    }
  }

  cancel(missionRunId: string): void {
    // Cancel any pending question for this mission
    const questionId = this.pendingQuestions.get(missionRunId);
    if (questionId) {
      queue.cancel(questionId);
    }
  }
}
```

**Key behaviors:**
- Questions are added to a global QuestionQueue
- The bridge polls the queue until the question is answered or cancelled
- Default timeout is 30 minutes (configurable)
- Timeout can be overridden via `AskOptions.timeout`
- Questions can be cancelled via `bridge.cancel(missionRunId)`

### EffectMissionRunner Integration

The EffectMissionRunner wires ctx.ask() to the bridge:

```typescript
class MissionContextImpl implements MissionContextService {
  ask(options: AskOptions): Effect.Effect<string, AskError, never> {
    return Effect.tryPromise({
      try: async () => {
        return await this.questionBridge.ask(options, this.missionRunId, this.wing);
      },
      catch: (error) =>
        new AskError({
          question: options.question,
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
  }
}
```

**Key behaviors:**
- The question bridge's promise is wrapped in an Effect
- Any errors are caught and converted to AskError
- The mission run ID and wing name are passed to the bridge for tracking

## Usage Examples

### Basic Question

```typescript
const answer = yield* ctx.ask({
  question: 'Should we proceed with the deployment?'
});

if (answer.toLowerCase().includes('yes')) {
  yield* ctx.emit('progress', { message: 'Proceeding with deployment' });
} else {
  yield* ctx.emit('cancelled', { reason: 'User cancelled deployment' });
}
```

### Question with Context and Suggestions

```typescript
const answer = yield* ctx.ask({
  question: 'Which approach should we use for the refactoring?',
  context: 'We found 3 possible solutions:\n1. Extract method\n2. Inline class\n3. Replace with strategy pattern',
  suggestions: ['Extract method', 'Inline class', 'Strategy pattern']
});

yield* ctx.emit('progress', { message: `User chose: ${answer}` });
```

### Question with Timeout

```typescript
const answer = yield* ctx.ask({
  question: 'Approve this change?',
  timeout: 60000  // 1 minute
});
```

### Error Handling

```typescript
const result = yield* Effect.either(
  ctx.ask({ question: 'Continue?' })
);

if (result._tag === 'Left') {
  const error = result.left as AskError;
  yield* ctx.emit('log', {
    message: `Question failed: ${error.reason}`,
    question: error.question
  });
  return;
}

const answer = result.right;
yield* ctx.emit('progress', { message: `User answered: ${answer}` });
```

## Testing

### Using createTestContext

```typescript
const testContext = createTestContext({
  askHuman: async (options: AskOptions) => {
    // Return pre-programmed answers
    if (options.question.includes('Continue')) {
      return 'Yes';
    }
    return 'No';
  }
});

const mission: Mission<void> = defineMission(function* (ctx) {
  const answer = yield* ctx.ask({ question: 'Continue?' });
  expect(answer).toBe('Yes');
});

await runMission(mission, testContext);
```

### Testing Error Cases

```typescript
const testContext = createTestContext({
  askHuman: async (options: AskOptions) => {
    throw new Error('Question timeout');
  }
});

const mission: Mission<void> = defineMission(function* (ctx) {
  const result = yield* Effect.either(ctx.ask({ question: 'Test?' }));

  expect(result._tag).toBe('Left');
  if (result._tag === 'Left') {
    expect(result.left).toBeInstanceOf(AskError);
    expect(result.left.reason).toBe('Question timeout');
  }
});

await runMission(mission, testContext);
```

### Testing with No Ask Function

If no `askHuman` function is provided in the test context, ctx.ask() will fail with an AskError:

```typescript
const testContext = createTestContext({});

const mission: Mission<void> = defineMission(function* (ctx) {
  const result = yield* Effect.either(ctx.ask({ question: 'Test?' }));

  if (result._tag === 'Left') {
    expect(result.left.reason).toBe('No ask function provided in test context');
  }
});

await runMission(mission, testContext);
```

## Gaps vs PRD Requirements

Based on the PRD for making ctx.ask() deterministic, here are the current gaps:

### Current State

- **Non-deterministic**: Question answers are provided by humans at runtime, making missions non-reproducible
- **Bridge dependency**: Questions are routed through IQuestionBridge implementations (Cabinet, CLI, test)
- **Runtime-only answers**: No mechanism to record or replay answers
- **No event tracking**: Questions and answers are not emitted as events

### PRD Requirements (Future)

The PRD likely requires:

1. **Event recording**: ctx.ask() should emit events when questions are asked and answered
2. **Replay mode**: Missions should be able to run in replay mode using recorded answers
3. **Deterministic testing**: Tests should be able to provide a sequence of answers that is replayed consistently
4. **Answer persistence**: Question/answer pairs should be persisted for replay

### Example of What's Missing

Currently:
```typescript
// Question is asked but not tracked as an event
const answer = yield* ctx.ask({ question: 'Continue?' });
// Answer comes from human, no way to replay
```

Future (deterministic):
```typescript
// Question is emitted as an event
yield* ctx.emit('question', { question: 'Continue?', questionId: '123' });
// Answer is either from human (record mode) or from event log (replay mode)
const answer = yield* ctx.ask({ question: 'Continue?' });
// Answer is emitted as an event
yield* ctx.emit('answer', { questionId: '123', answer: 'Yes' });
```

## See Also

- [MissionContext.ts](../src/domain/MissionContext.ts) - Original interface definition
- [MissionEffect.ts](../src/domain/MissionEffect.ts) - Effect-based implementation
- [IQuestionBridge.ts](../src/ports/IQuestionBridge.ts) - Bridge port definition
- [CabinetQuestionBridge.ts](../../../apps/cabinet/src/missions/CabinetQuestionBridge.ts) - Production bridge
- [EffectMissionRunner.test.ts](../src/adapters/EffectMissionRunner.test.ts) - Test examples
