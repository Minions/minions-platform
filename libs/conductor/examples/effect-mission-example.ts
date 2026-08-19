/**
 * Example Effect-based Mission
 *
 * Demonstrates how to write missions using the defineMission helper.
 * This is a reference implementation showing the new Mission<A> type.
 */

import { Effect } from 'effect';
import { defineMission, type Mission } from '../src/domain/MissionEffect';

/**
 * Simple mission that demonstrates defineMission syntax
 */
export const simpleEffectMission: Mission<void> = defineMission(function* (ctx) {
  // Emit progress event
  yield* ctx.emit('progress', { message: 'Starting work' });

  // Create a workbench for shared knowledge
  yield* ctx.createWorkbench();

  // Emit completion
  yield* ctx.emit('completed', { summary: 'Mission completed successfully' });
});

/**
 * Mission that spawns a minion and coordinates work
 */
export const minionCoordinationMission: Mission<void> = defineMission(function* (ctx) {
  yield* ctx.emit('progress', { message: 'Spawning developer minion' });

  // Spawn a minion - returns Effect<IMinion, SpawnError, never>
  const developer = yield* ctx.spawn({
    client: 'claude-code',
    name: 'developer',
  });

  yield* ctx.emit('progress', {
    message: `Developer ${developer.id} spawned successfully`,
  });

  // Await turn completion via the event bus
  // (Event bus integration shown in tests)

  yield* ctx.emit('completed', { summary: 'Coordination complete' });
});

/**
 * Mission that demonstrates error handling with Effect
 */
export const errorHandlingMission: Mission<void> = defineMission(function* (ctx) {
  // Attempt to spawn - handle errors with Effect.either
  const spawnResult = yield* Effect.either(
    ctx.spawn({ client: 'claude-code' })
  );

  if (spawnResult._tag === 'Left') {
    // Handle spawn error
    yield* ctx.emit('progress', {
      message: `Spawn failed: ${spawnResult.left.reason}`,
    });
    yield* ctx.emit('failed', { error: 'Could not spawn minion' });
    return;
  }

  const minion = spawnResult.right;

  yield* ctx.emit('completed', {
    summary: `Successfully spawned ${minion.id}`,
  });
});

/**
 * Mission that demonstrates asking human questions
 */
export const humanInteractionMission: Mission<void> = defineMission(function* (ctx) {
  yield* ctx.emit('progress', { message: 'Asking human for approval' });

  // Ask a human question - returns Effect<string, AskError, never>
  const answer = yield* ctx.ask({
    question: 'Should we proceed with the refactoring?',
    content: { type: 'markdown', content: 'Please review and decide.' },
    options: [
      { value: 'yes', label: 'Yes, proceed' },
      { value: 'no', label: 'No, cancel' },
      { value: 'review', label: 'Review changes first' },
    ],
    optionsMode: 'exclusive',
  });

  yield* ctx.emit('progress', { message: `Human answered: ${answer}` });

  if (answer.toLowerCase().includes('yes')) {
    yield* ctx.emit('completed', { summary: 'Approved, continuing' });
  } else {
    yield* ctx.emit('cancelled', { reason: 'Human cancelled operation' });
  }
});

/**
 * Mission that demonstrates cancellation checking
 */
export const cancellationAwareMission: Mission<void> = defineMission(function* (ctx) {
  // Check if cancelled before doing expensive work
  const isCancelled = yield* ctx.checkCancelled();
  if (isCancelled) {
    yield* ctx.emit('cancelled', { reason: 'Already cancelled' });
    return;
  }

  yield* ctx.emit('progress', { message: 'Doing work...' });

  // Simulate some work
  yield* Effect.sleep('100 millis');

  // Check again after work
  const stillCancelled = yield* ctx.checkCancelled();
  if (stillCancelled) {
    yield* ctx.emit('cancelled', { reason: 'Cancelled during execution' });
    return;
  }

  yield* ctx.emit('completed', { summary: 'Work completed' });
});
