import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { ClosetMissionLoader } from './ClosetMissionLoader';
import { createDiskSandbox, createLair, type Wing } from '@minions/file-store';
import { createTestWing } from '../test-utils/wingTestHelpers';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('ClosetMissionLoader', () => {
  let loader: ClosetMissionLoader;
  let wing: Wing;

  beforeAll(async () => {
    // Create a sandbox and lair to get a Wing object
    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);

    // Create test wing using helper
    wing = createTestWing({
      name: 'test-wing',
      root: sandbox.root,
      lair,
    });

    loader = new ClosetMissionLoader({ wing });
  });

  describe('discover', () => {
    it('finds missions in closet directory', async () => {
      const missions = await loader.discover();

      // Should find the simple mission in test-costume
      expect(missions.length).toBeGreaterThan(0);

      const simple = missions.find(
        (m) => m.costume === 'test-costume' && m.name === 'simple'
      );
      expect(simple).toBeDefined();
      expect(simple?.isLegacy).toBe(false);
    });

    it('returns empty array for non-existent closet', async () => {
      // Create a wing with no closet directory
      const sandbox = createDiskSandbox('/non/existent/wing');
      const lair = createLair(sandbox);
      const emptyWing = createTestWing({
        name: 'empty-wing',
        root: sandbox.root,
        lair,
        closetExists: false,
      });

      const emptyLoader = new ClosetMissionLoader({ wing: emptyWing });
      const missions = await emptyLoader.discover();
      expect(missions).toEqual([]);
    });
  });

  describe('discoverByCostume', () => {
    it('finds missions for specific costume', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      expect(missions.length).toBeGreaterThan(0);
      expect(missions.every((m) => m.costume === 'test-costume')).toBe(true);
    });

    it('excludes test files', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const testFiles = missions.filter((m) => m.name.includes('.test'));
      expect(testFiles).toHaveLength(0);
    });

    it('returns empty array for costume without missions', async () => {
      const missions = await loader.discoverByCostume('non-existent-costume');
      expect(missions).toEqual([]);
    });

    it('discovers non-deterministic markdown missions', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const nonDeterministic = missions.find((m) => m.name === 'legacy-test');
      expect(nonDeterministic).toBeDefined();
      expect(nonDeterministic?.isLegacy).toBe(true);
    });

    it('discovers both deterministic and non-deterministic missions', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const deterministic = missions.filter((m) => !m.isLegacy);
      const nonDeterministic = missions.filter((m) => m.isLegacy);

      expect(deterministic.length).toBeGreaterThan(0);
      expect(nonDeterministic.length).toBeGreaterThan(0);
    });

    it('discovers compiled JavaScript missions as deterministic', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const compiled = missions.find((m) => m.name === 'compiled-test');
      expect(compiled).toBeDefined();
      expect(compiled?.isLegacy).toBe(false);
    });

    it('ignores .js.map files', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const mapFiles = missions.filter((m) => m.name.includes('.map') || m.name.includes('js.map'));
      expect(mapFiles).toHaveLength(0);
    });

    it('excludes utility files that do not export a mission from discovery', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const helper = missions.find((m) => m.name === 'helper-utility');
      expect(helper).toBeUndefined();
    });

    it('returns both deterministic and non-deterministic missions with the same name', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const dualFormat = missions.filter((m) => m.name === 'dual-format');
      expect(dualFormat).toHaveLength(2);

      const deterministic = dualFormat.find((m) => !m.isLegacy);
      const nonDeterministic = dualFormat.find((m) => m.isLegacy);
      expect(deterministic).toBeDefined();
      expect(nonDeterministic).toBeDefined();
    });
  });

  describe('exists', () => {
    it('returns true for existing TypeScript mission', async () => {
      const exists = await loader.exists('test-costume', 'simple');
      expect(exists).toBe(true);
    });

    it('returns true for existing non-deterministic markdown mission', async () => {
      const exists = await loader.exists('test-costume', 'legacy-test');
      expect(exists).toBe(true);
    });

    it('returns false for non-existent mission', async () => {
      const exists = await loader.exists('test-costume', 'non-existent');
      expect(exists).toBe(false);
    });

    it('returns false for non-existent costume', async () => {
      const exists = await loader.exists('non-existent', 'simple');
      expect(exists).toBe(false);
    });

    it('returns true for existing compiled JavaScript mission', async () => {
      const exists = await loader.exists('test-costume', 'compiled-test');
      expect(exists).toBe(true);
    });
  });

  describe('load', () => {
    it('loads a valid TypeScript mission', async () => {
      const loaded = await loader.load('test-costume', 'simple');

      expect(loaded.costume).toBe('test-costume');
      expect(loaded.mission.name).toBe('simple');
      expect(loaded.mission.description).toBeDefined();
      expect(loaded.mission.args).toBeDefined();
      expect(typeof loaded.mission.run).toBe('function');
      expect(loaded.isLegacy).toBe(false);
    });

    it('loads a non-deterministic markdown mission', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      expect(loaded.costume).toBe('test-costume');
      expect(loaded.mission.name).toBe('legacy-test-mission');
      expect(loaded.mission.description).toBe('Test legacy markdown mission loading.');
      expect(loaded.isLegacy).toBe(true);
    });

    it('extracts args schema from non-deterministic mission', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      expect(loaded.mission.args.type).toBe('object');
      expect(loaded.mission.args.properties['target-dir']).toEqual({
        type: 'string',
        description: 'Directory to process',
      });
      expect(loaded.mission.args.properties['output-file']).toEqual({
        type: 'string',
        description: 'Output file path',
      });
      expect(loaded.mission.args.required).toEqual(['target-dir', 'output-file']);
    });

    it('non-deterministic mission run function is callable', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      // run should be a function
      expect(typeof loaded.mission.run).toBe('function');
    });

    it('throws for non-existent mission', async () => {
      await expect(
        loader.load('test-costume', 'non-existent')
      ).rejects.toThrow('Mission not found');
    });

    it('prefers TypeScript over markdown when both exist', async () => {
      // simple.ts exists as TypeScript, so it should load as non-legacy
      const loaded = await loader.load('test-costume', 'simple');
      expect(loaded.isLegacy).toBe(false);
    });

    it('loads a compiled JavaScript mission', async () => {
      const loaded = await loader.load('test-costume', 'compiled-test');

      expect(loaded.costume).toBe('test-costume');
      expect(loaded.mission.name).toBe('compiled-test');
      expect(loaded.mission.description).toBeDefined();
      expect(loaded.mission.args).toBeDefined();
      expect(typeof loaded.mission.run).toBe('function');
      expect(loaded.isLegacy).toBe(false);
    });

    it('prefers .js over .md when both exist for same name', async () => {
      const loaded = await loader.load('test-costume', 'dual-format');

      expect(loaded.isLegacy).toBe(false);
      expect(loaded.mission.name).toBe('dual-format');
    });
  });
});
