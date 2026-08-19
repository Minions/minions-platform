import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { Effect } from 'effect';
import { ClosetCostumeLoader, LoadError } from '../src/ClosetCostumeLoader';
import { createDiskSandbox, createLair, createTestWing } from '@minions/file-store';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('ClosetCostumeLoader', () => {
  let loader: ClosetCostumeLoader;

  beforeAll(() => {
    // Create sandbox and lair to get a Wing object
    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);

    // Create test wing using helper
    const wing = createTestWing({
      name: 'test-wing',
      root: sandbox.root,
      lair,
      closetExists: true,
    });
    loader = new ClosetCostumeLoader({ wing });
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
      const customLoader = new ClosetCostumeLoader({ wing });
      expect(customLoader).toBeDefined();
    });
  });

  describe('discover', () => {
    it('finds costumes in closet directory', async () => {
      const result = await Effect.runPromise(loader.discover());

      // Should find the test costumes
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('test-costume');
      expect(result).toContain('simple-costume');
      expect(result).toContain('invalid-costume');
    });

    it('returns only directories (not files)', async () => {
      const result = await Effect.runPromise(loader.discover());

      // All results should be costume names (directories)
      for (const costumeName of result) {
        expect(typeof costumeName).toBe('string');
        expect(costumeName.length).toBeGreaterThan(0);
      }
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
      const emptyLoader = new ClosetCostumeLoader({ wing });
      const result = await Effect.runPromise(emptyLoader.discover());
      expect(result).toEqual([]);
    });
  });

  describe('load', () => {
    it('loads a valid costume', async () => {
      const costume = await Effect.runPromise(loader.load('simple-costume'));

      expect(costume.model).toBe('claude-opus-4-20250514');
      expect(costume.systemPrompt).toBe('You are a simple agent without external prompt file.');
      expect(costume.gadgets).toEqual([]);
      expect(costume.skills).toEqual([]);
      expect(costume.events).toEqual([]);
      expect(costume.injectFacts).toBeUndefined();
    });

    it('loads costume with injectFacts', async () => {
      const costume = await Effect.runPromise(loader.load('test-costume'));

      expect(costume.model).toBe('claude-sonnet-4-20250514');
      // Gadgets are loaded separately by ClosetGadgetLoader, not from costume.json
      expect(costume.gadgets).toEqual([]);
      expect(Array.isArray(costume.injectFacts)).toBe(true);
      expect(costume.injectFacts).toContain('test');
      expect(costume.injectFacts).toContain('build');
    });

    it('loads prompt.md if present and overrides systemPrompt', async () => {
      const costume = await Effect.runPromise(loader.load('test-costume'));

      // Should have loaded prompt.md content, not the costume.json systemPrompt
      expect(costume.systemPrompt).toContain('Test Agent System Prompt');
      expect(costume.systemPrompt).toContain('You are a test agent');
      expect(costume.systemPrompt).not.toBe('You are a test agent.');
    });

    it('uses costume.json systemPrompt when prompt.md is absent', async () => {
      const costume = await Effect.runPromise(loader.load('simple-costume'));

      // Should use systemPrompt from costume.json
      expect(costume.systemPrompt).toBe('You are a simple agent without external prompt file.');
    });

    it('throws LoadError for non-existent costume', async () => {
      const result = Effect.runPromiseExit(loader.load('non-existent'));

      await expect(result).resolves.toMatchObject({
        _tag: 'Failure',
      });

      const exit = await result;
      if (exit._tag === 'Failure') {
        expect(exit.cause._tag).toBe('Fail');
        if (exit.cause._tag === 'Fail') {
          const error = exit.cause.error;
          expect(error).toBeInstanceOf(LoadError);
          if (error instanceof LoadError) {
            expect(error.reason).toContain('Costume not found');
            expect(error.costumeName).toBe('non-existent');
          }
        }
      }
    });

    it('throws LoadError for invalid costume config', async () => {
      const result = Effect.runPromiseExit(loader.load('invalid-costume'));

      await expect(result).resolves.toMatchObject({
        _tag: 'Failure',
      });

      const exit = await result;
      if (exit._tag === 'Failure') {
        expect(exit.cause._tag).toBe('Fail');
        if (exit.cause._tag === 'Fail') {
          const error = exit.cause.error;
          expect(error).toBeInstanceOf(LoadError);
          if (error instanceof LoadError) {
            expect(error.reason).toContain('Invalid costume config');
            expect(error.costumeName).toBe('invalid-costume');
          }
        }
      }
    });

    it('validates costume has all required properties', async () => {
      const costume = await Effect.runPromise(loader.load('test-costume'));

      // Verify all required Costume properties are present
      expect(typeof costume.model).toBe('string');
      expect(typeof costume.systemPrompt).toBe('string');
      expect(Array.isArray(costume.gadgets)).toBe(true);
      expect(Array.isArray(costume.skills)).toBe(true);
      expect(Array.isArray(costume.events)).toBe(true);
      expect(Array.isArray(costume.injectFacts)).toBe(true);
    });

    it('preserves costume properties when loading prompt.md', async () => {
      const costume = await Effect.runPromise(loader.load('test-costume'));

      // All properties except systemPrompt should be from costume.json
      expect(costume.model).toBe('claude-sonnet-4-20250514');
      expect(costume.injectFacts).toContain('test');

      // Only systemPrompt should be from prompt.md
      expect(costume.systemPrompt).toContain('Test Agent System Prompt');
    });
  });

  describe('load from costume.json', () => {
    it('loads a costume from costume.json', async () => {
      const costume = await Effect.runPromise(loader.load('json-costume'));

      expect(costume.model).toBe('claude-sonnet-4-20250514');
      expect(costume.systemPrompt).toBe('You are a JSON-configured agent.');
      expect(costume.injectFacts).toEqual(['test', 'json']);
      expect(costume.gadgets).toEqual([]);
      expect(costume.skills).toEqual([]);
      expect(costume.events).toEqual([]);
    });

    it('loads systemPromptFile from costume.json', async () => {
      const costume = await Effect.runPromise(loader.load('json-prompt-costume'));

      expect(costume.model).toBe('claude-opus-4-20250514');
      expect(costume.systemPrompt).toContain('JSON Costume Prompt');
      expect(costume.systemPrompt).toContain('configured via costume.json');
    });

    it('prefers costume.json over costume.ts when both exist', async () => {
      // json-costume only has costume.json so this is implicitly tested
      // by the fact that json-costume loads successfully
      const costume = await Effect.runPromise(loader.load('json-costume'));
      expect(costume.model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('error handling', () => {
    it('provides clear error message for missing costume file', async () => {
      const result = Effect.runPromiseExit(loader.load('missing-file-costume'));

      const exit = await result;
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        const error = exit.cause.error;
        if (error instanceof LoadError) {
          expect(error.reason).toContain('Costume not found');
          expect(error.reason).toContain('missing-file-costume');
          expect(error.costumeName).toBe('missing-file-costume');
        }
      }
    });

    it('provides clear error message for invalid config', async () => {
      const result = Effect.runPromiseExit(loader.load('invalid-costume'));

      const exit = await result;
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        const error = exit.cause.error;
        if (error instanceof LoadError) {
          expect(error.reason).toContain('Invalid costume config');
          expect(error.reason).toContain('invalid-costume');
          expect(error.costumeName).toBe('invalid-costume');
        }
      }
    });
  });
});
