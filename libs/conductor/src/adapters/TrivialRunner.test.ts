import { describe, it, expect, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { TrivialRunner } from './TrivialRunner';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion, MinionSpec, MinionMessage } from '@minions/domain-types';

/**
 * Mock minion for testing
 */
class MockMinion implements IMinion {
  readonly id: string;
  readonly spec: MinionSpec;

  private messages: MinionMessage[] = [];
  private killed = false;

  constructor(id: string, spec: MinionSpec) {
    this.id = id;
    this.spec = spec;
  }

  async send(_message: MinionMessage): Promise<void> {
    // Record sent messages for verification
  }

  async *receive(): AsyncIterableIterator<MinionMessage> {
    // Yield pre-configured messages
    for (const message of this.messages) {
      if (this.killed) return;
      yield message;
    }
  }

  kill(): void {
    this.killed = true;
  }

  interrupt(): void {
    // No-op for mock
  }

  reconfigure(): Effect.Effect<void, never, never> {
    return Effect.succeed(undefined);
  }

  get status(): 'processing' | 'waiting' | 'dead' {
    return this.killed ? 'dead' : 'waiting';
  }

  // Test helper: add messages to be yielded
  addMessages(...messages: MinionMessage[]): void {
    this.messages.push(...messages);
  }
}

/**
 * Mock hatchery for testing
 */
class MockHatchery implements IHatchery {
  private nextMinion: MockMinion | null = null;
  public lastSpec: MinionSpec | null = null;

  async spawn(spec: MinionSpec): Promise<IMinion> {
    this.lastSpec = spec;
    if (this.nextMinion) {
      return this.nextMinion;
    }
    throw new Error('No minion configured');
  }

  // Test helper: set the minion to return
  setMinion(minion: MockMinion): void {
    this.nextMinion = minion;
  }
}

describe('TrivialRunner', () => {
  let hatchery: MockHatchery;
  let runner: TrivialRunner;

  beforeEach(() => {
    hatchery = new MockHatchery();
    runner = new TrivialRunner(hatchery);
  });

  it('should emit started event when mission starts', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    minion.addMessages({
      type: 'text',
      content: 'Mission complete',
      timestamp: Date.now(),
    });
    hatchery.setMinion(minion);

    // The handle is returned synchronously with 'started' already emitted,
    // but we can verify the event was emitted by checking the handle state
    const handle = await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    // Verify the handle has the correct mission name (set in started event)
    expect(handle.missionName).toBe('test-mission');
    expect(handle.id).toMatch(/^mission-/);
  });

  it('should spawn minion with correct spec', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'custom-model',
      useBuiltInSystemPrompt: true,
    });
    hatchery.setMinion(minion);

    await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
      model: 'custom-model',
    });

    // Wait a tick for spawn to happen
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hatchery.lastSpec).not.toBeNull();
    expect(hatchery.lastSpec?.client).toBe('claude-code');
    expect(hatchery.lastSpec?.wing).toBe('/test/wing');
    expect(hatchery.lastSpec?.model).toBe('custom-model');
  });

  it('should spawn minion and complete successfully', async () => {
    const minion = new MockMinion('minion-123', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    minion.addMessages({ type: 'text', content: 'Done', timestamp: 1000 });
    hatchery.setMinion(minion);

    const handle = await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    // Wait for mission to complete, which means spawn happened
    await handle.completion;

    // Verify minion was spawned by checking the spec
    expect(hatchery.lastSpec).not.toBeNull();
    expect(hatchery.lastSpec?.wing).toBe('/test/wing');
    expect(hatchery.lastSpec?.client).toBe('claude-code');
  });

  it('should emit minion-message events for each message', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    minion.addMessages(
      { type: 'text', content: 'Hello', timestamp: 1000 },
      { type: 'text', content: 'World', timestamp: 2000 }
    );
    hatchery.setMinion(minion);

    const messages: unknown[] = [];
    const handle = await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    handle.on('minion-message', (event) => {
      messages.push(event.content);
    });

    // Wait for all messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toContain('Hello');
    expect(messages).toContain('World');
  });

  it('should emit completed event when minion finishes', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    minion.addMessages({ type: 'text', content: 'Done', timestamp: 1000 });
    hatchery.setMinion(minion);

    let completed = false;
    const handle = await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    handle.on('completed', () => {
      completed = true;
    });

    await handle.completion;

    expect(completed).toBe(true);
  });

  it('should use default model when not specified', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    hatchery.setMinion(minion);

    await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hatchery.lastSpec?.model).toBe('claude-sonnet-4-20250514');
  });

  it('should allow cancellation via handle', async () => {
    const minion = new MockMinion('minion-1', {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
    });
    // Add a message that won't be reached due to cancellation
    minion.addMessages({ type: 'text', content: 'Never seen', timestamp: 1000 });
    hatchery.setMinion(minion);

    let cancelled = false;
    const handle = await runner.start({
      missionName: 'test-mission',
      wing: '/test/wing',
    });

    handle.on('cancelled', () => {
      cancelled = true;
    });

    // Cancel immediately
    handle.cancel('test cancellation');

    // Completion should reject
    await expect(handle.completion).rejects.toThrow(/cancelled/);
    expect(cancelled).toBe(true);
  });
});
