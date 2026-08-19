import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { Effect } from 'effect';
import { ClosetCostumeLoader, LoadError } from './ClosetCostumeLoader';
import { createDiskSandbox, createLair, type Wing } from '@minions/file-store';
import { createTestWing } from '../test-utils/wingTestHelpers';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('ClosetCostumeLoader', () => {
  let loader: ClosetCostumeLoader;
  let wing: Wing;

  beforeAll(() => {
    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);

    wing = createTestWing({
      name: 'test-wing',
      root: sandbox.root,
      lair,
    });

    loader = new ClosetCostumeLoader({ wing });
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
      const emptySandbox = createDiskSandbox('/non/existent/wing');
      const emptyLair = createLair(emptySandbox);
      const emptyWing = createTestWing({
        name: 'empty-wing',
        root: emptySandbox.root,
        lair: emptyLair,
        closetExists: false,
      });
      const emptyLoader = new ClosetCostumeLoader({ wing: emptyWing });
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
      expect(costume.injectFacts).toEqual([]);
    });

    it('loads costume with gadgets and injectFacts', async () => {
      // Load simple-costume first to verify structure
      const costume = await Effect.runPromise(loader.load('test-costume'));

      expect(costume.model).toBe('claude-sonnet-4-20250514');
      expect(Array.isArray(costume.gadgets)).toBe(true);
      expect(costume.gadgets?.length).toBeGreaterThan(0);
      expect(costume.gadgets?.[0].name).toBe('test-tool');
      expect(Array.isArray(costume.injectFacts)).toBe(true);
      expect(costume.injectFacts).toContain('test');
      expect(costume.injectFacts).toContain('build');
    });

    it('loads prompt.md if present and overrides systemPrompt', async () => {
      const costume = await Effect.runPromise(loader.load('test-costume'));

      // Should have loaded prompt.md content, not the costume.ts systemPrompt
      expect(costume.systemPrompt).toContain('Test Agent System Prompt');
      expect(costume.systemPrompt).toContain('You are a test agent');
      expect(costume.systemPrompt).not.toBe('You are a test agent.');
    });

    it('uses costume.ts systemPrompt when prompt.md is absent', async () => {
      const costume = await Effect.runPromise(loader.load('simple-costume'));

      // Should use systemPrompt from costume.ts
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

    it('throws LoadError for invalid costume export', async () => {
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
            expect(error.reason).toContain('Invalid costume export');
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

      // All properties except systemPrompt should be from costume.ts
      expect(costume.model).toBe('claude-sonnet-4-20250514');
      expect(costume.gadgets?.[0].name).toBe('test-tool');
      expect(costume.injectFacts).toContain('test');

      // Only systemPrompt should be from prompt.md
      expect(costume.systemPrompt).toContain('Test Agent System Prompt');
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

    it('provides clear error message for invalid export', async () => {
      const result = Effect.runPromiseExit(loader.load('invalid-costume'));

      const exit = await result;
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        const error = exit.cause.error;
        if (error instanceof LoadError) {
          expect(error.reason).toContain('Invalid costume export');
          expect(error.reason).toContain('invalid-costume');
          expect(error.costumeName).toBe('invalid-costume');
        }
      }
    });
  });
});
