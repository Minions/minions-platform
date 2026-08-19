import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@minions/events';
import { BrainlessMinion, MinionEvents } from '@minions/hatchery';

function createMinionWithTurnCompletion(
  bus: EventBus,
  _name = 'test-minion'
): BrainlessMinion {
  return new BrainlessMinion(
    {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'test-model',
      useBuiltInSystemPrompt: false,
    },
    undefined,
    {
      onTurnComplete: (minionId) => {
        bus.emitFrom(MinionEvents.TurnComplete, { minionId }, minionId);
      },
    }
  );
}

describe('Turn Completion Event Detection', () => {
  describe('TurnComplete event emission', () => {
    it('emits TurnComplete when minion triggers turn completion', async () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on(MinionEvents.TurnComplete, handler);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const minion = createMinionWithTurnCompletion(bus);

      // Manually trigger turn completion
      minion.completeTurn();

      // Give the handler time to process the event
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          minionId: minion.id,
          __type: 'turn-complete',
          __source: minion.id,
        })
      );

      minion.kill();
    });

    it('includes minionId in payload', async () => {
      const bus = new EventBus();

      const minion = createMinionWithTurnCompletion(bus);

      const promise = bus.once(MinionEvents.TurnComplete);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      minion.completeTurn();

      const event = await promise;

      expect(event.minionId).toBe(minion.id);

      minion.kill();
    });

    it('event is tagged with minion as source', async () => {
      const bus = new EventBus();

      const minion = createMinionWithTurnCompletion(bus);

      const promise = bus.once(MinionEvents.TurnComplete);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      minion.completeTurn();

      const event = await promise;

      expect(event.__source).toBe(minion.id);

      minion.kill();
    });

    it('missions can await turn completion from specific minion', async () => {
      const bus = new EventBus();

      const minion1 = createMinionWithTurnCompletion(bus, 'minion-1');
      const minion2 = createMinionWithTurnCompletion(bus, 'minion-2');

      // Await turn completion from specific minion using source filter
      const promise = bus.once(MinionEvents.TurnComplete, { from: minion1 });

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // Trigger completion from minion2 first (should be ignored)
      minion2.completeTurn();

      // Trigger completion from minion1 (should resolve promise)
      minion1.completeTurn();

      const event = await promise;

      expect(event.minionId).toBe(minion1.id);
      expect(event.__source).toBe(minion1.id);

      minion1.kill();
      minion2.kill();
    });
  });

  describe('Turn completion via /turn-complete command', () => {
    it('triggers turn completion when minion receives /turn-complete command', async () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on(MinionEvents.TurnComplete, handler);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const minion = createMinionWithTurnCompletion(bus);

      // Send /turn-complete command to minion
      await minion.send({ type: 'user', content: '/turn-complete', timestamp: Date.now() });

      // Give the back-side co-routine time to process
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          minionId: minion.id,
        })
      );

      minion.kill();
    });
  });

  describe('Tool use does NOT emit TurnComplete', () => {
    it('tool_use message type does not trigger TurnComplete', async () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on(MinionEvents.TurnComplete, handler);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const minion = createMinionWithTurnCompletion(bus);

      // Send command that triggers tool use
      await minion.send({
        type: 'user',
        content: '/use tool Write with {"file":"test.txt","content":"hello"}',
        timestamp: Date.now(),
      });

      // Give time for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Receive the tool_use message to verify it was created
      const messages = [];
      for await (const msg of minion.receive({ type: 'tool_use' })) {
        messages.push(msg);
        break; // Just get the first one
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_use');

      // But turn completion should NOT have been triggered
      expect(handler).not.toHaveBeenCalled();

      minion.kill();
    });

    it('only /turn-complete command triggers turn completion', async () => {
      const bus = new EventBus();
      const handler = vi.fn();

      bus.on(MinionEvents.TurnComplete, handler);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const minion = createMinionWithTurnCompletion(bus);

      // Send various commands that don't trigger turn completion
      await minion.send({ type: 'user', content: '/echo hello', timestamp: Date.now() });
      await minion.send({ type: 'user', content: '/status working', timestamp: Date.now() });
      await minion.send({ type: 'user', content: '/think about it', timestamp: Date.now() });

      // Give time for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Turn completion should not have been triggered
      expect(handler).not.toHaveBeenCalled();

      // Now send /turn-complete
      await minion.send({ type: 'user', content: '/turn-complete', timestamp: Date.now() });

      // Give time for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now turn completion SHOULD be triggered
      expect(handler).toHaveBeenCalledOnce();

      minion.kill();
    });
  });

  describe('Event fires in both streaming and non-streaming modes', () => {
    it('works with manual trigger (simulates non-streaming)', async () => {
      const bus = new EventBus();

      const minion = createMinionWithTurnCompletion(bus);

      const promise = bus.once(MinionEvents.TurnComplete);

      // Give the stream consumer time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      // Manual trigger simulates non-streaming API response with stop_reason: "end_turn"
      minion.completeTurn();

      const event = await promise;

      expect(event.minionId).toBe(minion.id);

      minion.kill();
    });

    it('works with command trigger (simulates streaming)', async () => {
      const bus = new EventBus();

      const minion = createMinionWithTurnCompletion(bus);

      const promise = bus.once(MinionEvents.TurnComplete);

      // Command trigger simulates streaming message_stop event
      await minion.send({ type: 'user', content: '/turn-complete', timestamp: Date.now() });

      const event = await promise;

      expect(event.minionId).toBe(minion.id);

      minion.kill();
    });
  });
});
