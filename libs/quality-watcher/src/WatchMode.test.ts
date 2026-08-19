import { describe, it, expect } from 'vitest';
import type { WatchMode } from './WatchMode.js';

describe('WatchMode', () => {
  describe('early-return mode', () => {
    it('should represent early return behavior', () => {
      const mode: WatchMode = 'early-return';

      expect(mode).toBe('early-return');
    });

    it('should be assignable to WatchMode type', () => {
      const mode: WatchMode = 'early-return';

      // TypeScript compile-time check
      expect(typeof mode).toBe('string');
    });
  });

  describe('full-details mode', () => {
    it('should represent full details behavior', () => {
      const mode: WatchMode = 'full-details';

      expect(mode).toBe('full-details');
    });

    it('should be assignable to WatchMode type', () => {
      const mode: WatchMode = 'full-details';

      // TypeScript compile-time check
      expect(typeof mode).toBe('string');
    });
  });

  describe('type usage', () => {
    it('should work in function parameters', () => {
      function configureWatcher(mode: WatchMode): string {
        if (mode === 'early-return') {
          return 'Will return as soon as 3 failures found or any tool fails';
        } else {
          return 'Will wait for all signals to complete';
        }
      }

      expect(configureWatcher('early-return')).toBe('Will return as soon as 3 failures found or any tool fails');
      expect(configureWatcher('full-details')).toBe('Will wait for all signals to complete');
    });

    it('should work in switch statements', () => {
      function describeBehavior(mode: WatchMode): string {
        switch (mode) {
          case 'early-return':
            return 'fast feedback mode';
          case 'full-details':
            return 'comprehensive results mode';
          default: {
            // Exhaustiveness check
            const _exhaustive: never = mode;
            return _exhaustive;
          }
        }
      }

      expect(describeBehavior('early-return')).toBe('fast feedback mode');
      expect(describeBehavior('full-details')).toBe('comprehensive results mode');
    });

    it('should work in configuration objects', () => {
      interface WatcherConfig {
        wingName: string;
        mode: WatchMode;
      }

      const earlyReturnConfig: WatcherConfig = {
        wingName: 'my-wing',
        mode: 'early-return',
      };

      const fullDetailsConfig: WatcherConfig = {
        wingName: 'my-wing',
        mode: 'full-details',
      };

      expect(earlyReturnConfig.mode).toBe('early-return');
      expect(fullDetailsConfig.mode).toBe('full-details');
    });

    it('should support default mode pattern', () => {
      function getMode(requestedMode?: WatchMode): WatchMode {
        return requestedMode ?? 'early-return';
      }

      expect(getMode()).toBe('early-return');
      expect(getMode('full-details')).toBe('full-details');
      expect(getMode('early-return')).toBe('early-return');
    });
  });
});
