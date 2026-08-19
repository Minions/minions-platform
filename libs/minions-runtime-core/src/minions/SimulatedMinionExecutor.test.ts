import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimulatedMinionExecutor } from './SimulatedMinionExecutor';
import { ContentBlock } from './events';

describe('SimulatedMinionExecutor', () => {
  let executor: SimulatedMinionExecutor;

  beforeEach(() => {
    executor = new SimulatedMinionExecutor();
  });

  describe('event emission', () => {
    it('emits events in correct order with granular control', async () => {
      const events: string[] = [];

      executor.on('turn_started', () => events.push('turn_started'));
      executor.on('content', () => events.push('content'));
      executor.on('turn_ended', () => events.push('turn_ended'));

      await executor.start();
      executor.sendMessage('Hello');

      // Simulate partial response
      await executor.respondWith({
        type: 'message',
        content: 'Hi!',
        role: 'assistant',
      });

      expect(events).toEqual(['turn_started', 'content']);

      // Simulate more content in same turn
      await executor.respondWith({
        type: 'message',
        content: 'again',
        role: 'assistant',
      });

      expect(events).toEqual(['turn_started', 'content', 'content']);

      // Explicitly finish turn
      await executor.finishTurn();

      expect(events).toEqual([
        'turn_started',
        'content',
        'content',
        'turn_ended',
      ]);
    });

    it('can emit multiple blocks in single respondWith call', async () => {
      const blocks: ContentBlock[] = [];

      executor.on('content', (block) => blocks.push(block));

      await executor.start();
      executor.sendMessage('Test');

      await executor.respondWith(
        { type: 'reasoning', content: 'Thinking...' },
        { type: 'message', content: 'Response', role: 'assistant' }
      );

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('reasoning');
      expect(blocks[1].type).toBe('message');
    });
  });

  describe('turn lifecycle', () => {
    it('enforces turn lifecycle', async () => {
      await executor.start();

      // Cannot respondWith before sendMessage
      await expect(
        executor.respondWith({
          type: 'message',
          content: 'Hi!',
          role: 'assistant',
        })
      ).rejects.toThrow('No turn active');

      executor.sendMessage('Hello');

      // Cannot send another message before finishing turn
      expect(() => executor.sendMessage('Another')).toThrow(
        'Turn already in progress'
      );

      await executor.respondWith({
        type: 'message',
        content: 'Response',
        role: 'assistant',
      });
      await executor.finishTurn();

      // Now can send next message
      executor.sendMessage('Second message');
      await executor.finishTurn(); // Finish without content is OK
    });

    it('requires session to be started before sending messages', () => {
      expect(() => executor.sendMessage('Hello')).toThrow(
        'Session not active'
      );
    });

    it('allows multiple turns in sequence', async () => {
      await executor.start();
      const events: string[] = [];

      executor.on('turn_started', () => events.push('turn_started'));
      executor.on('turn_ended', () => events.push('turn_ended'));

      // First turn
      executor.sendMessage('First message');
      await executor.respondWith({
        type: 'message',
        content: 'Response 1',
        role: 'assistant',
      });
      await executor.finishTurn();

      // Second turn
      executor.sendMessage('Second message');
      await executor.respondWith({
        type: 'message',
        content: 'Response 2',
        role: 'assistant',
      });
      await executor.finishTurn();

      expect(events).toEqual([
        'turn_started',
        'turn_ended',
        'turn_started',
        'turn_ended',
      ]);
    });
  });

  describe('error handling', () => {
    it('emits error event without ending session', async () => {
      await executor.start();

      const errors: Error[] = [];
      executor.on('error', (e) => errors.push(e));

      executor.sendMessage('Hello');
      executor.emitError(new Error('Simulated network error'));

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Simulated network error');
      expect(executor.isRunning()).toBe(true); // Session still active
    });

    it('can continue after error', async () => {
      await executor.start();

      // Add error listener to prevent unhandled error
      const errors: Error[] = [];
      executor.on('error', (e) => errors.push(e));

      executor.sendMessage('First');
      executor.emitError(new Error('Test error'));
      await executor.finishTurn();

      expect(errors).toHaveLength(1);

      // Should still be able to send another message
      executor.sendMessage('Second');
      await executor.finishTurn();

      expect(executor.isRunning()).toBe(true);
    });
  });

  describe('session lifecycle', () => {
    it('tracks session state correctly', async () => {
      expect(executor.isRunning()).toBe(false);

      await executor.start();
      expect(executor.isRunning()).toBe(true);

      executor.stop();
      expect(executor.isRunning()).toBe(false);
    });

    it('emits session_ended on stop', async () => {
      await executor.start();

      const sessionEndedEvents: Array<{
        code?: number;
        signal?: string;
      }> = [];
      executor.on('session_ended', (code, signal) =>
        sessionEndedEvents.push({ code, signal })
      );

      executor.stop();

      expect(sessionEndedEvents).toHaveLength(1);
      expect(executor.isRunning()).toBe(false);
    });

    it('can stop during active turn', async () => {
      await executor.start();
      executor.sendMessage('Hello');
      await executor.respondWith({
        type: 'message',
        content: 'Hi',
        role: 'assistant',
      });

      // Stop without finishing turn
      executor.stop();

      expect(executor.isRunning()).toBe(false);
    });
  });

  describe('timing control', () => {
    it('works with fake timers', async () => {
      vi.useFakeTimers();

      await executor.start();
      const events: string[] = [];

      executor.on('content', () => events.push('content'));

      executor.sendMessage('Hello');

      // Simulate delayed response
      setTimeout(async () => {
        await executor.respondWith({
          type: 'message',
          content: 'Hi!',
          role: 'assistant',
        });
      }, 1000);

      // Nothing received yet
      expect(events).toHaveLength(0);

      // Advance time
      await vi.advanceTimersByTimeAsync(1000);

      // Response received
      expect(events).toHaveLength(1);

      vi.useRealTimers();
    });
  });
});
