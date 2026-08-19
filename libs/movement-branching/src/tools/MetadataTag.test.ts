import { describe, it, expect } from 'vitest';
import { MetadataTrailers, MinionMetadata } from './MetadataTag.js';

describe('MetadataTrailers', () => {
  const trailers = new MetadataTrailers();

  describe('formatTrailers', () => {
    it('formats required fields', () => {
      const metadata: MinionMetadata = {
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
      };

      const result = trailers.formatTrailers(metadata);

      expect(result).toBe(
        'Minion-Client: claude-code\nMinion-Model: claude-opus-4-5'
      );
    });

    it('includes optional activeCommand', () => {
      const metadata: MinionMetadata = {
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
        activeCommand: '/implement-feature',
      };

      const result = trailers.formatTrailers(metadata);

      expect(result).toContain('Minion-Command: /implement-feature');
    });

    it('includes optional disguise', () => {
      const metadata: MinionMetadata = {
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
        disguise: 'senior-engineer',
      };

      const result = trailers.formatTrailers(metadata);

      expect(result).toContain('Minion-Disguise: senior-engineer');
    });

    it('includes all fields when present', () => {
      const metadata: MinionMetadata = {
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
        activeCommand: '/fix-bug',
        disguise: 'code-reviewer',
      };

      const result = trailers.formatTrailers(metadata);

      expect(result).toBe(
        'Minion-Client: claude-code\n' +
        'Minion-Model: claude-opus-4-5\n' +
        'Minion-Command: /fix-bug\n' +
        'Minion-Disguise: code-reviewer'
      );
    });
  });

  describe('parseTrailers', () => {
    it('parses trailers from commit message', () => {
      const message = `feat: Add new feature

This is the body.

Minion-Client: claude-code
Minion-Model: claude-opus-4-5`;

      const result = trailers.parseTrailers(message);

      expect(result).toEqual({
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
      });
    });

    it('parses all metadata fields', () => {
      const message = `fix: Fix bug

Minion-Client: custom-client
Minion-Model: claude-3-haiku
Minion-Command: /debug
Minion-Disguise: debugger`;

      const result = trailers.parseTrailers(message);

      expect(result).toEqual({
        clientType: 'custom-client',
        model: 'claude-3-haiku',
        activeCommand: '/debug',
        disguise: 'debugger',
      });
    });

    it('returns null when required fields are missing', () => {
      const message = `feat: Add feature

Minion-Client: claude-code`;

      const result = trailers.parseTrailers(message);

      expect(result).toBeNull();
    });

    it('returns null for messages without trailers', () => {
      const message = 'feat: Simple commit message';

      const result = trailers.parseTrailers(message);

      expect(result).toBeNull();
    });

    it('returns null for messages with non-minion trailers', () => {
      const message = `feat: Add feature

Co-Authored-By: Someone <email@example.com>
Signed-off-by: Another <other@example.com>`;

      const result = trailers.parseTrailers(message);

      expect(result).toBeNull();
    });

    it('handles messages with mixed trailers', () => {
      const message = `feat: Add feature

Co-Authored-By: Someone <email@example.com>
Minion-Client: claude-code
Minion-Model: claude-opus-4-5
Signed-off-by: Another <other@example.com>`;

      const result = trailers.parseTrailers(message);

      expect(result).toEqual({
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
      });
    });
  });

  describe('hasMetadata', () => {
    it('returns true when metadata is present', () => {
      const message = `feat: Add feature

Minion-Client: claude-code
Minion-Model: claude-opus-4-5`;

      expect(trailers.hasMetadata(message)).toBe(true);
    });

    it('returns false when metadata is missing', () => {
      const message = 'feat: Simple commit';

      expect(trailers.hasMetadata(message)).toBe(false);
    });
  });

  describe('roundtrip', () => {
    it('can parse what it formats', () => {
      const original: MinionMetadata = {
        clientType: 'claude-code',
        model: 'claude-opus-4-5',
        activeCommand: '/implement',
        disguise: 'architect',
      };

      const formatted = trailers.formatTrailers(original);
      const message = `feat: Add feature\n\n${formatted}`;
      const parsed = trailers.parseTrailers(message);

      expect(parsed).toEqual(original);
    });
  });
});
