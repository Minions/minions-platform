import { describe, it, expect } from 'vitest';
import { isCostume } from '../src/Costume';
import type { Costume } from '../src/Costume';

describe('isCostume', () => {
  describe('valid costumes', () => {
    it('returns true for a complete valid costume', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a test agent',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for costume with gadgets', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [
          { name: 'Read', description: 'Read files', input_schema: {} },
          { name: 'Write', description: 'Write files', input_schema: {} },
        ],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for costume with injectFacts', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: ['build', 'test', 'package-manager'],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for costume with all arrays populated', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Full costume',
        gadgets: [{ name: 'tool', description: 'desc' }],
        skills: [{ name: 'skill' }],
        events: [],
        injectFacts: ['build'],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for minimal costume (only required fields)', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for partial costume with model and systemPrompt', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test prompt',
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for partial costume with model and gadgets', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        gadgets: [{ name: 'Read', description: 'Read files' }],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for partial costume with model and injectFacts', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        injectFacts: ['build', 'test'],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for partial costume with model, gadgets, and events', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        gadgets: [{ name: 'Write', description: 'Write files' }],
        events: [],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('returns true for costume without tools (optional)', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        gadgets: [],
      };

      expect(isCostume(costume)).toBe(true);
    });
  });

  describe('invalid costumes', () => {
    it('returns false for null', () => {
      expect(isCostume(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isCostume(undefined)).toBe(false);
    });

    it('returns false for non-object values', () => {
      expect(isCostume('string')).toBe(false);
      expect(isCostume(123)).toBe(false);
      expect(isCostume(true)).toBe(false);
      expect(isCostume([])).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(isCostume({})).toBe(false);
    });

    it('returns false when model is missing', () => {
      const invalid = {
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns false when model is not a string', () => {
      const invalid = {
        model: 123,
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true when systemPrompt is missing (optional field)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(valid)).toBe(true);
    });

    it('returns false when systemPrompt is not a string', () => {
      const invalid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 123,
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true when gadgets is missing (optional field)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(valid)).toBe(true);
    });

    it('returns false when gadgets is not an array', () => {
      const invalid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: 'not an array',
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true when skills is missing (optional field)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(valid)).toBe(true);
    });

    it('returns false when skills is not an array', () => {
      const invalid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: 'not an array',
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true when events is missing (optional field)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        injectFacts: [],
      };

      expect(isCostume(valid)).toBe(true);
    });

    it('returns false when events is not an array', () => {
      const invalid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: 'not an array',
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true when injectFacts is missing (optional field)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
      };

      expect(isCostume(valid)).toBe(true);
    });

    it('returns false when injectFacts is not an array', () => {
      const invalid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: 'not an array',
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('returns true for object with extra properties (extra properties allowed)', () => {
      const valid = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        // Missing injectFacts is OK (optional)
        extraProperty: 'extra',
      };

      expect(isCostume(valid)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('rejects costume with empty string model', () => {
      const invalid = {
        model: '',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(invalid)).toBe(false);
    });

    it('accepts costume with empty string systemPrompt', () => {
      const costume: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: '',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
      };

      expect(isCostume(costume)).toBe(true);
    });

    it('allows extra properties beyond required fields', () => {
      const costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Test',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: [],
        extraProperty: 'this is allowed',
      };

      // isCostume checks for required fields, doesn't reject extra properties
      expect(isCostume(costume)).toBe(true);
    });
  });
});
