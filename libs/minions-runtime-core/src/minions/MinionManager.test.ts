import { describe, it, expect, beforeEach } from 'vitest';
import { MinionManager } from './MinionManager.js';
import { MinionStatus } from './types.js';

describe('MinionManager', () => {
  let manager: MinionManager;

  beforeEach(() => {
    manager = new MinionManager();
  });

  describe('create', () => {
    it('creates a new minion with claude-code client', () => {
      const minion = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      expect(minion.id).toBeTruthy();
      expect(minion.client).toBe('claude-code');
      expect(minion.status).toBe(MinionStatus.Idle);
      expect(minion.wingName).toBe('test-wing');
      expect(minion.messageHistory).toEqual([]);
      expect(minion.created).toBeGreaterThan(0);
    });

    it('creates a new minion with agent prompt', () => {
      const minion = manager.create({
        client: 'anthropic-agentic',
        wingName: 'test-wing',
        agentPrompt: 'You are a helpful assistant.'
      });

      expect(minion.client).toBe('anthropic-agentic');
      expect(minion.agentPrompt).toBe('You are a helpful assistant.');
    });

    it('generates unique IDs for each minion', () => {
      const minion1 = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const minion2 = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      expect(minion1.id).not.toBe(minion2.id);
    });

    it('adds minion to internal registry', () => {
      const minion = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const retrieved = manager.get(minion.id);
      expect(retrieved).toEqual(minion);
    });
  });

  describe('get', () => {
    it('retrieves minion by ID', () => {
      const minion = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const retrieved = manager.get(minion.id);
      expect(retrieved).toEqual(minion);
    });

    it('returns undefined for non-existent minion', () => {
      const retrieved = manager.get('non-existent-id');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('list', () => {
    it('lists all minions when no filter provided', () => {
      const minion1 = manager.create({
        client: 'claude-code',
        wingName: 'wing-1'
      });

      const minion2 = manager.create({
        client: 'anthropic-agentic',
        wingName: 'wing-2'
      });

      const all = manager.list();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(minion1);
      expect(all).toContainEqual(minion2);
    });

    it('filters minions by wing', () => {
      manager.create({
        client: 'claude-code',
        wingName: 'wing-1'
      });

      const minion2 = manager.create({
        client: 'anthropic-agentic',
        wingName: 'wing-2'
      });

      const filtered = manager.list({ wingName: 'wing-2' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toEqual(minion2);
    });

    it('returns empty array when no minions exist', () => {
      const all = manager.list();
      expect(all).toEqual([]);
    });

    it('returns empty array when no minions match filter', () => {
      manager.create({
        client: 'claude-code',
        wingName: 'wing-1'
      });

      const filtered = manager.list({ wingName: 'non-existent' });
      expect(filtered).toEqual([]);
    });
  });

  describe('remove', () => {
    it('removes minion from registry', () => {
      const minion = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      manager.remove(minion.id);

      const retrieved = manager.get(minion.id);
      expect(retrieved).toBeUndefined();
    });

    it('does not throw when removing non-existent minion', () => {
      expect(() => manager.remove('non-existent-id')).not.toThrow();
    });

    it('only removes specified minion', () => {
      const minion1 = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      const minion2 = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      manager.remove(minion1.id);

      expect(manager.get(minion1.id)).toBeUndefined();
      expect(manager.get(minion2.id)).toEqual(minion2);
    });
  });

  describe('updateStatus', () => {
    it('updates minion status', () => {
      const minion = manager.create({
        client: 'claude-code',
        wingName: 'test-wing'
      });

      manager.updateStatus(minion.id, MinionStatus.Working);

      const updated = manager.get(minion.id);
      expect(updated?.status).toBe(MinionStatus.Working);
    });

    it('does not throw when updating non-existent minion', () => {
      expect(() =>
        manager.updateStatus('non-existent-id', MinionStatus.Dead)
      ).not.toThrow();
    });
  });
});
