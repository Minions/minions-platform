import { describe, it, expect } from 'vitest';
import { SignalType } from './SignalState.js';
import {
  type QualityStatus,
  calculateOverallState,
  applyWarningPolicy,
  simplifyForReporting,
  allPendingQualityStatus,
  type OverallState,
} from './QualityStatus.js';

describe('QualityStatus', () => {
  describe('type structure', () => {
    it('should contain state for all signal types', () => {
      const timestamp = new Date();
      const status: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt: new Date(),
        isPartial: false,
      };

      expect(status[SignalType.Tests]).toBeDefined();
      expect(status[SignalType.Types]).toBeDefined();
      expect(status[SignalType.OxLint]).toBeDefined();
      expect(status[SignalType.CustomLint]).toBeDefined();
      expect(status[SignalType.Build]).toBeDefined();
    });

    it('should include aggregatedAt timestamp', () => {
      const timestamp = new Date();
      const aggregatedAt = new Date(timestamp.getTime() + 1000);
      const status: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt,
        isPartial: false,
      };

      expect(status.aggregatedAt).toBe(aggregatedAt);
    });

    it('should include isPartial flag', () => {
      const timestamp = new Date();
      const status: QualityStatus = {
        [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt: new Date(),
        isPartial: true,
      };

      expect(status.isPartial).toBe(true);
    });

    it('should support partial results with running signals', () => {
      const timestamp = new Date();
      const status: QualityStatus = {
        [SignalType.Tests]: {
          state: 'running',
          timestamp,
          failures: ['Test failure 1'],
        },
        [SignalType.Types]: { state: 'pending', timestamp },
        [SignalType.Build]: { state: 'pending', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: {
          state: 'fail',
          timestamp,
          failures: ['Lint error 1', 'Lint error 2'],
        },
        aggregatedAt: new Date(),
        isPartial: true,
      };

      expect(status.isPartial).toBe(true);
      expect(status[SignalType.Tests].state).toBe('running');
      expect(status[SignalType.CustomLint].state).toBe('fail');
    });
  });

  describe('allPendingQualityStatus', () => {
    it('reports every signal as pending at the given time', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const status = allPendingQualityStatus(now);

      for (const signal of Object.values(SignalType)) {
        expect(status[signal]).toEqual({ state: 'pending', timestamp: now });
      }
      expect(status.aggregatedAt).toBe(now);
      expect(status.isPartial).toBe(true);
    });
  });

  describe('calculateOverallState', () => {
    describe('pass state', () => {
      it('should return pass when all signals are pass', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pass', timestamp },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('pass');
      });

      it('should not return pass if any signal is not pass', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pass', timestamp },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).not.toBe('pass');
      });
    });

    describe('fail state', () => {
      it('should return fail if any signal is fail', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: {
            state: 'fail',
            timestamp,
            failures: ['Test failed'],
          },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
      });

      it('should return fail if multiple signals are fail', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: {
            state: 'fail',
            timestamp,
            failures: ['Test failed'],
          },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: {
            state: 'fail',
            timestamp,
            failures: ['Lint error'],
          },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
      });

      it('should prioritize fail over running', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: {
            state: 'fail',
            timestamp,
            failures: ['Type error'],
          },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
      });

      it('should prioritize fail over pending', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pending', timestamp },
          [SignalType.Types]: {
            state: 'fail',
            timestamp,
            failures: ['Type error'],
          },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
      });
    });

    describe('running state', () => {
      it('should return running if any signal is running and none are fail', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });

      it('should return running if multiple signals are running', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: { state: 'running', timestamp, failures: [] },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });

      it('should return running when signals are running with partial failures', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: {
            state: 'running',
            timestamp,
            failures: ['Partial failure'],
          },
          [SignalType.Types]: { state: 'pending', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });

      it('should prioritize running over pending', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: { state: 'pending', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });

      it('should prioritize running over pass', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pass', timestamp },
          [SignalType.Types]: { state: 'running', timestamp, failures: [] },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });
    });

    describe('pending state', () => {
      it('should return pending when all signals are pending', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pending', timestamp },
          [SignalType.Types]: { state: 'pending', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('pending');
      });

      it('should return pending for mix of pass and pending (default fallthrough)', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'pending', timestamp },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pending', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        // Falls through to pending as the default when no higher priority state
        expect(result).toBe('pending');
      });
    });

    describe('priority order', () => {
      it('should follow priority: fail > running > pass > pending', () => {
        const timestamp = new Date();

        // All states present - fail should win
        const allStates: QualityStatus = {
          [SignalType.Tests]: {
            state: 'fail',
            timestamp,
            failures: ['error'],
          },
          [SignalType.Types]: { state: 'running', timestamp, failures: [] },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };
        expect(calculateOverallState(allStates)).toBe('fail');

        // No fail - running should win
        const noFail: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: true,
        };
        expect(calculateOverallState(noFail)).toBe('running');

        // No fail or running - pass only if all pass
        const allPass: QualityStatus = {
          [SignalType.Tests]: { state: 'pass', timestamp },
          [SignalType.Types]: { state: 'pass', timestamp },
          [SignalType.Build]: { state: 'pass', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };
        expect(calculateOverallState(allPass)).toBe('pass');

        // Mix of pass and pending - pending wins
        const mixPassPending: QualityStatus = {
          [SignalType.Tests]: { state: 'pass', timestamp },
          [SignalType.Types]: { state: 'pending', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'pass', timestamp },
          aggregatedAt: new Date(),
          isPartial: false,
        };
        expect(calculateOverallState(mixPassPending)).toBe('pending');
      });
    });

    describe('mixed scenarios', () => {
      it('should handle early return scenario with partial results', () => {
        const timestamp = new Date();
        // Custom-lint found 3 errors quickly, tests found 1 error but still
        // running, types and build haven't finished
        const status: QualityStatus = {
          [SignalType.Tests]: {
            state: 'running',
            timestamp,
            failures: ['Test failure 1'],
          },
          [SignalType.Types]: { state: 'pending', timestamp },
          [SignalType.Build]: { state: 'pending', timestamp },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: {
            state: 'fail',
            timestamp,
            failures: ['Lint error 1', 'Lint error 2', 'Lint error 3'],
          },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
        expect(status.isPartial).toBe(true);
      });

      it('should handle all signals running scenario', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: { state: 'running', timestamp, failures: [] },
          [SignalType.Types]: { state: 'running', timestamp, failures: [] },
          [SignalType.Build]: { state: 'running', timestamp, failures: [] },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: { state: 'running', timestamp, failures: [] },
          aggregatedAt: new Date(),
          isPartial: true,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('running');
      });

      it('should handle all signals failing scenario', () => {
        const timestamp = new Date();
        const status: QualityStatus = {
          [SignalType.Tests]: {
            state: 'fail',
            timestamp,
            failures: ['Test error'],
          },
          [SignalType.Types]: {
            state: 'fail',
            timestamp,
            failures: ['Type error'],
          },
          [SignalType.Build]: {
            state: 'fail',
            timestamp,
            failures: ['Build error'],
          },
          [SignalType.OxLint]: { state: 'pass', timestamp },
          [SignalType.CustomLint]: {
            state: 'fail',
            timestamp,
            failures: ['Lint error'],
          },
          aggregatedAt: new Date(),
          isPartial: false,
        };

        const result = calculateOverallState(status);

        expect(result).toBe('fail');
      });
    });
  });

  describe('OverallState type', () => {
    it('should accept all valid overall states', () => {
      const states: OverallState[] = ['pass', 'fail', 'running', 'pending'];

      expect(states).toHaveLength(4);
      expect(states).toContain('pass');
      expect(states).toContain('fail');
      expect(states).toContain('running');
      expect(states).toContain('pending');
    });
  });

  describe('applyWarningPolicy', () => {
    function statusWithTestsWarnings(warnings: string[]): QualityStatus {
      const timestamp = new Date();
      return {
        [SignalType.Tests]: { state: 'pass', timestamp, warnings },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt: new Date(),
        isPartial: false,
      };
    }

    it('promotes a passing signal with warnings to fail by default (treatWarningsAsWarnings omitted)', () => {
      const status = statusWithTestsWarnings(['"punycode" module is deprecated']);

      const result = applyWarningPolicy(status, false);

      expect(result[SignalType.Tests].state).toBe('fail');
      if (result[SignalType.Tests].state === 'fail') {
        expect(result[SignalType.Tests].failures).toEqual(['[warning treated as error] "punycode" module is deprecated']);
      }
      expect(result[SignalType.Tests].warnings).toEqual(['"punycode" module is deprecated']);
      // Untouched signals are unaffected.
      expect(result[SignalType.Types].state).toBe('pass');
    });

    it('leaves a passing signal with warnings as pass when treatWarningsAsWarnings is true', () => {
      const status = statusWithTestsWarnings(['"punycode" module is deprecated']);

      const result = applyWarningPolicy(status, true);

      expect(result[SignalType.Tests].state).toBe('pass');
      expect(result[SignalType.Tests].warnings).toEqual(['"punycode" module is deprecated']);
    });

    it('leaves a signal with no warnings untouched either way', () => {
      const status = statusWithTestsWarnings([]);

      expect(applyWarningPolicy(status, false)[SignalType.Tests].state).toBe('pass');
      expect(applyWarningPolicy(status, true)[SignalType.Tests].state).toBe('pass');
    });

    it('does not promote an already-failing signal — its own failures are reported as-is, warnings appended for visibility', () => {
      const timestamp = new Date();
      const status = statusWithTestsWarnings([]);
      status[SignalType.Tests] = { state: 'fail', timestamp, failures: ['a real test failure'], warnings: ['a deprecation notice'] };

      const result = applyWarningPolicy(status, false);

      expect(result[SignalType.Tests].state).toBe('fail');
      if (result[SignalType.Tests].state === 'fail') {
        expect(result[SignalType.Tests].failures).toEqual(['a real test failure']);
      }
    });

    it('does not promote running/pending signals even if they carry partial warnings', () => {
      const timestamp = new Date();
      const status = statusWithTestsWarnings([]);
      status[SignalType.Tests] = { state: 'running', timestamp, failures: [], warnings: ['a deprecation notice'] };

      const result = applyWarningPolicy(status, false);

      expect(result[SignalType.Tests].state).toBe('running');
    });
  });

  describe('calculateOverallState with stale signals', () => {
    function allPassStatus(): QualityStatus {
      const timestamp = new Date();
      return {
        [SignalType.Tests]: { state: 'pass', timestamp },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt: new Date(),
        isPartial: false,
      };
    }

    it('reports "stale" when a signal is stale and nothing is failing', () => {
      const status = allPassStatus();
      status[SignalType.CustomLint] = {
        state: 'stale',
        timestamp: new Date(),
        staleSince: new Date(Date.now() - 60_000),
        message: 'customLint signal is currently broken',
      };

      expect(calculateOverallState(status)).toBe('stale');
    });

    it('still reports "fail" when another signal is genuinely failing, even alongside a stale one', () => {
      const status = allPassStatus();
      status[SignalType.CustomLint] = {
        state: 'stale',
        timestamp: new Date(),
        staleSince: new Date(Date.now() - 60_000),
        message: 'customLint signal is currently broken',
      };
      status[SignalType.Tests] = { state: 'fail', timestamp: new Date(), failures: ['a real test failure'] };

      expect(calculateOverallState(status)).toBe('fail');
    });
  });

  describe('simplifyForReporting', () => {
    it('collapses pending into running, with an empty failures array', () => {
      const timestamp = new Date();
      const status = allPassStatusWith(SignalType.Tests, { state: 'pending', timestamp });

      const result = simplifyForReporting(status);

      expect(result[SignalType.Tests]).toEqual({ state: 'running', timestamp, failures: [] });
    });

    it('preserves warnings when collapsing pending into running', () => {
      const timestamp = new Date();
      const status = allPassStatusWith(SignalType.Tests, { state: 'pending', timestamp, warnings: ['a notice'] });

      const result = simplifyForReporting(status);

      expect(result[SignalType.Tests]).toEqual({ state: 'running', timestamp, failures: [], warnings: ['a notice'] });
    });

    it('leaves pass, fail, running, and stale signals unchanged', () => {
      const timestamp = new Date();
      const status: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp },
        [SignalType.Types]: { state: 'fail', timestamp, failures: ['boom'] },
        [SignalType.Build]: { state: 'running', timestamp, failures: [] },
        [SignalType.OxLint]: { state: 'stale', timestamp, staleSince: timestamp, message: 'oxlint is stuck' },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        aggregatedAt: new Date(),
        isPartial: false,
      };

      const result = simplifyForReporting(status);

      expect(result).toEqual(status);
    });

    function allPassStatusWith(signalType: SignalType, override: QualityStatus[SignalType]): QualityStatus {
      const timestamp = new Date();
      return {
        [SignalType.Tests]: { state: 'pass', timestamp },
        [SignalType.Types]: { state: 'pass', timestamp },
        [SignalType.Build]: { state: 'pass', timestamp },
        [SignalType.OxLint]: { state: 'pass', timestamp },
        [SignalType.CustomLint]: { state: 'pass', timestamp },
        [signalType]: override,
        aggregatedAt: new Date(),
        isPartial: false,
      };
    }
  });
});
