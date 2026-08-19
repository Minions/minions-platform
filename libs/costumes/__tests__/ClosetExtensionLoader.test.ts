/**
 * Tests for ClosetExtensionLoader
 *
 * Parallel to ClosetGadgetLoader tests - verifies discovery and loading of
 * costume-declared CostumeExtensions (action groups + gadgets) from a fixed
 * `extensions.ts`/`extensions.js` entry point at each costume's root.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { ClosetExtensionLoader } from '../src/ClosetExtensionLoader';
import { createDiskSandbox, createLair, createTestWing } from '@minions/file-store';

const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('ClosetExtensionLoader', () => {
  let loader: ClosetExtensionLoader;

  beforeAll(() => {
    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);
    const wing = createTestWing({
      name: 'test-wing',
      root: sandbox.root,
      lair,
      closetExists: true,
    });
    loader = new ClosetExtensionLoader({ wing });
  });

  describe('constructor', () => {
    it('accepts Wing via dependency injection', () => {
      const sandbox = createDiskSandbox(TEST_WING_ROOT);
      const lair = createLair(sandbox);
      const wing = createTestWing({
        name: 'test-wing',
        root: sandbox.root,
        lair,
        closetExists: true,
      });
      const customLoader = new ClosetExtensionLoader({ wing });
      expect(customLoader).toBeDefined();
    });

    it('throws when neither wing nor closetDir is provided', () => {
      expect(() => new ClosetExtensionLoader({})).toThrow(
        'ClosetExtensionLoader requires either wing or closetDir'
      );
    });
  });

  describe('discover', () => {
    it('finds costumes with an extensions entry point', async () => {
      const infos = await loader.discover();
      const costumes = infos.map(i => i.costume);
      expect(costumes).toContain('test-costume');
    });

    it('excludes costumes without an extensions entry point', async () => {
      const infos = await loader.discover();
      const costumes = infos.map(i => i.costume);
      expect(costumes).not.toContain('simple-costume');
    });

    it('returns empty array for non-existent closet', async () => {
      const sandbox = createDiskSandbox('/non/existent/wing');
      const lair = createLair(sandbox);
      const wing = createTestWing({
        name: 'empty-wing',
        root: sandbox.root,
        lair,
        closetExists: false,
      });
      const emptyLoader = new ClosetExtensionLoader({ wing });
      const result = await emptyLoader.discover();
      expect(result).toEqual([]);
    });
  });

  describe('load', () => {
    it('loads a valid extensions module', async () => {
      const loaded = await loader.load('test-costume');

      expect(loaded.costumeName).toBe('test-costume');
      expect(loaded.extensions.actionGroups).toHaveLength(1);
      expect(loaded.extensions.actionGroups?.[0]?.def.name).toBe('test_extension_group');
      expect(loaded.extensions.actionGroups?.[0]?.endpoints).toEqual(['henchery']);
    });

    it('throws for non-existent costume', async () => {
      await expect(loader.load('non-existent')).rejects.toThrow('Costume not found');
    });

    it('throws for a costume without an extensions entry point', async () => {
      await expect(loader.load('simple-costume')).rejects.toThrow('Extensions not found');
    });

    it('throws for a malformed extensions export', async () => {
      await expect(loader.load('invalid-costume')).rejects.toThrow('Invalid extensions shape');
    });
  });

  describe('loadAll', () => {
    it('loads extensions across all costumes that declare them', async () => {
      const loaded = await loader.loadAll();
      const names = loaded.map(l => l.costumeName);
      expect(names).toContain('test-costume');
    });

    it('skips costumes whose extensions fail to load', async () => {
      const loaded = await loader.loadAll();
      const bad = loaded.filter(l => l.costumeName === 'invalid-costume');
      expect(bad).toEqual([]);
    });
  });

  describe('exists', () => {
    it('returns true for a costume with an extensions entry point', async () => {
      expect(await loader.exists('test-costume')).toBe(true);
    });

    it('returns false for a costume without an extensions entry point', async () => {
      expect(await loader.exists('simple-costume')).toBe(false);
    });

    it('returns false for a non-existent costume', async () => {
      expect(await loader.exists('non-existent')).toBe(false);
    });
  });
});
