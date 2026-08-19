import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MinionManager } from './MinionManager.js';
import { MinionStatus, MinionExecutor } from './types.js';
import type { ProductionHatchery } from '@minions/hatchery';
import { EventEmitter } from 'events';

// Mock HatcheryMinionAdapter at top level
vi.mock('./HatcheryMinionAdapter.js', () => {
  const { EventEmitter: MockEventEmitter } = require('events');

  class MockHatcheryMinionAdapter extends MockEventEmitter {
    private messageCapture: { getAllInteractions: () => never[]; getInteraction: () => null };

    constructor(_hatcheryMinion: unknown, messageCapture?: unknown) {
      super();
      this.messageCapture = (messageCapture ?? {
        getAllInteractions: () => [],
        getInteraction: () => null
      }) as { getAllInteractions: () => never[]; getInteraction: () => null };
    }

    async start() {
      // Simulate successful start
    }

    async sendMessage(_message: string) {
      // Mock implementation - no action needed
    }

    stop() {
      // Mock implementation - no action needed
    }

    isRunning() {
      return true;
    }

    getMessageCapture() {
      return this.messageCapture;
    }
  }

  return { HatcheryMinionAdapter: MockHatcheryMinionAdapter };
});

// Import after mocks are set up
import {
  spawnMinion,
  listMinions,
  getMinionHistory,
  getMinionInteractions,
  getMinionInteractionDetail,
  killMinion
} from './MinionService.js';

// Mock ProductionHatchery
class MockProductionHatchery {
  async spawn() {
    return new MockHatcheryMinion();
  }
}

// Mock HatcheryMinion
class MockHatcheryMinion extends EventEmitter {
  async start() {
    // Mock implementation - no action needed
  }
  async sendMessage() {
    // Mock implementation - no action needed
  }
  stop() {
    // Mock implementation - no action needed
  }
}

describe('MinionService', () => {
  let minionManager: MinionManager;
  let hatchery: MockProductionHatchery;

  beforeEach(() => {
    minionManager = new MinionManager();
    hatchery = new MockProductionHatchery();
  });

  describe('spawnMinion', () => {
    it('spawns a minion and returns minion info', async () => {
      const result = await spawnMinion(
        minionManager,
        hatchery as unknown as ProductionHatchery,
        'claude-code',
        'test-wing',
        '/test/lair'
      );

      expect(result).toHaveProperty('minionId');
      expect(result.client).toBe('claude-code');
      expect(result.status).toBe(MinionStatus.Idle);
    });

    it('creates minion in manager with correct properties', async () => {
      const result = await spawnMinion(
        minionManager,
        hatchery as unknown as ProductionHatchery,
        'anthropic-agentic',
        'test-wing',
        '/test/lair',
        'Custom prompt'
      );

      const minion = minionManager.get(result.minionId);
      expect(minion).toBeDefined();
      expect(minion?.client).toBe('anthropic-agentic');
      expect(minion?.wingName).toBe('test-wing');
      expect(minion?.agentPrompt).toBe('Custom prompt');
    });

    it('throws error when minionManager not initialized', async () => {
      await expect(
        spawnMinion(
          null as unknown as MinionManager,
          hatchery as unknown as ProductionHatchery,
          'claude-code',
          'test-wing'
        )
      ).rejects.toThrow('Minion manager or hatchery not initialized');
    });

    it('throws error when hatchery not initialized', async () => {
      await expect(
        spawnMinion(
          minionManager,
          null as unknown as ProductionHatchery,
          'claude-code',
          'test-wing'
        )
      ).rejects.toThrow('Minion manager or hatchery not initialized');
    });
  });

  describe('listMinions', () => {
    it('lists all minions when no filter provided', () => {
      // Create test minions
      minionManager.create({
        client: 'claude-code',
        wingName: 'wing-1'
      });
      minionManager.create({
        client: 'anthropic-agentic',
        wingName: 'wing-2'
      });

      const result = listMinions(minionManager);

      expect(result.minions).toHaveLength(2);
      expect(result.minions[0]).toHaveProperty('id');
      expect(result.minions[0]).toHaveProperty('client');
      expect(result.minions[0]).toHaveProperty('status');
      expect(result.minions[0]).toHaveProperty('wingName');
      expect(result.minions[0]).toHaveProperty('createdAt');
    });

    it('filters minions by wingName', () => {
      minionManager.create({
        client: 'claude-code',
        wingName: 'wing-1'
      });
      minionManager.create({
        client: 'anthropic-agentic',
        wingName: 'wing-2'
      });

      const result = listMinions(minionManager, 'wing-1');

      expect(result.minions).toHaveLength(1);
      expect(result.minions[0].wingName).toBe('wing-1');
    });

    it('returns empty array when no minions exist', () => {
      const result = listMinions(minionManager);

      expect(result.minions).toHaveLength(0);
    });

    it('throws error when minionManager not initialized', () => {
      expect(() => listMinions(null as unknown as MinionManager)).toThrow('Minion manager not initialized');
    });
  });

  describe('getMinionHistory', () => {
    it('returns message history for a minion', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      // Add some messages to history
      minion.messageHistory.push({
        role: 'user',
        content: 'Hello',
        timestamp: Date.now()
      });
      minion.messageHistory.push({
        role: 'assistant',
        content: 'Hi there',
        timestamp: Date.now()
      });

      const result = getMinionHistory(minionManager, minion.id);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toBe('Hi there');
    });

    it('throws error when minionId not provided', () => {
      expect(() => getMinionHistory(minionManager, '')).toThrow('Minion ID is required');
    });

    it('throws error when minion not found', () => {
      expect(() => getMinionHistory(minionManager, 'nonexistent-id')).toThrow(
        'Minion not found: nonexistent-id'
      );
    });

    it('throws error when minionManager not initialized', () => {
      expect(() => getMinionHistory(null as unknown as MinionManager, 'some-id')).toThrow(
        'Minion manager not initialized'
      );
    });
  });

  describe('getMinionInteractions', () => {
    it('returns interactions for a minion', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      // Mock executor with message capture
      const mockCapture = {
        getAllInteractions: () => [
          {
            id: 'interaction-1',
            timestamp: Date.now(),
            userPrompt: 'Test prompt',
            status: 'completed',
            responseBlocks: [{ type: 'text', text: 'Response' }]
          }
        ],
        getInteraction: () => null
      };

      minion.executor = {
        getMessageCapture: () => mockCapture
      } as unknown as MinionExecutor;

      const result = getMinionInteractions(minionManager, minion.id);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].id).toBe('interaction-1');
      expect(result.interactions[0].promptSummary).toBe('Test prompt');
      expect(result.interactions[0].status).toBe('completed');
      expect(result.interactions[0].blockCount).toBe(1);
    });

    it('truncates long prompts in summary', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const longPrompt = 'a'.repeat(150);
      const mockCapture = {
        getAllInteractions: () => [
          {
            id: 'interaction-1',
            timestamp: Date.now(),
            userPrompt: longPrompt,
            status: 'completed',
            responseBlocks: []
          }
        ],
        getInteraction: () => null
      };

      minion.executor = {
        getMessageCapture: () => mockCapture
      } as unknown as MinionExecutor;

      const result = getMinionInteractions(minionManager, minion.id);

      expect(result.interactions[0].promptSummary.length).toBeLessThanOrEqual(103); // 100 + '...'
      expect(result.interactions[0].promptSummary).toContain('...');
    });

    it('returns empty interactions when minion has no executor (falls back to minion.messageCapture)', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const result = getMinionInteractions(minionManager, minion.id);
      expect(result.interactions).toEqual([]);
    });

    it('throws error when minionId not provided', () => {
      expect(() => getMinionInteractions(minionManager, '')).toThrow('Minion ID is required');
    });

    it('throws error when minion not found', () => {
      expect(() => getMinionInteractions(minionManager, 'nonexistent-id')).toThrow(
        'Minion not found: nonexistent-id'
      );
    });
  });

  describe('getMinionInteractionDetail', () => {
    it('returns full interaction details', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const mockInteraction = {
        id: 'interaction-1',
        timestamp: Date.now(),
        userPrompt: 'Test prompt',
        fullRequest: { model: 'claude-sonnet-4', messages: [] },
        responseBlocks: [{ type: 'text', text: 'Response' }],
        status: 'completed',
        error: undefined
      };

      const mockCapture = {
        getAllInteractions: () => [],
        getInteraction: (id: string) => (id === 'interaction-1' ? mockInteraction : null)
      };

      minion.executor = {
        getMessageCapture: () => mockCapture
      } as unknown as MinionExecutor;

      const result = getMinionInteractionDetail(minionManager, minion.id, 'interaction-1');

      expect(result.id).toBe('interaction-1');
      expect(result.userPrompt).toBe('Test prompt');
      expect(result.fullRequest).toEqual({ model: 'claude-sonnet-4', messages: [] });
      expect(result.responseBlocks).toHaveLength(1);
      expect(result.status).toBe('completed');
    });

    it('throws error when interaction not found', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const mockCapture = {
        getAllInteractions: () => [],
        getInteraction: () => null
      };

      minion.executor = {
        getMessageCapture: () => mockCapture
      } as unknown as MinionExecutor;

      expect(() =>
        getMinionInteractionDetail(minionManager, minion.id, 'nonexistent-interaction')
      ).toThrow('Interaction not found: nonexistent-interaction');
    });

    it('throws error when minionId or interactionId not provided', () => {
      expect(() => getMinionInteractionDetail(minionManager, '', 'interaction-1')).toThrow(
        'Minion ID and interaction ID are required'
      );
      expect(() => getMinionInteractionDetail(minionManager, 'minion-1', '')).toThrow(
        'Minion ID and interaction ID are required'
      );
    });

    it('throws error when minion not found', () => {
      expect(() =>
        getMinionInteractionDetail(minionManager, 'nonexistent-id', 'interaction-1')
      ).toThrow('Minion not found: nonexistent-id');
    });

    it('throws interaction not found when minion has no executor (falls back to empty messageCapture)', () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      expect(() => getMinionInteractionDetail(minionManager, minion.id, 'interaction-1')).toThrow(
        'Interaction not found: interaction-1'
      );
    });
  });

  describe('killMinion', () => {
    it('kills a minion and returns result without dump when no lairRoot', async () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const result = await killMinion(minionManager, minion.id);

      expect(result.message).toContain('killed');
      expect(result.message).toContain('No dump created');
      expect(result.dumpPath).toBeUndefined();
      expect(minionManager.get(minion.id)).toBeUndefined();
    });

    it('updates minion status to Dead before removing', async () => {
      const minion = minionManager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const originalUpdateStatus = minionManager.updateStatus.bind(minionManager);
      let statusUpdated = false;
      minionManager.updateStatus = (id: string, status: MinionStatus) => {
        if (status === MinionStatus.Dead) {
          statusUpdated = true;
        }
        originalUpdateStatus(id, status);
      };

      await killMinion(minionManager, minion.id);

      expect(statusUpdated).toBe(true);
    });

    it('throws error when minionId not provided', async () => {
      await expect(killMinion(minionManager, '')).rejects.toThrow('Minion ID is required');
    });

    it('throws error when minion not found', async () => {
      await expect(killMinion(minionManager, 'nonexistent-id')).rejects.toThrow(
        'Minion not found: nonexistent-id'
      );
    });

    it('throws error when minionManager not initialized', async () => {
      await expect(killMinion(null as unknown as MinionManager, 'some-id')).rejects.toThrow(
        'Minion manager not initialized'
      );
    });
  });
});
