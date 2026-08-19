import { describe, it, expect } from 'vitest';
import { SignalType, type SignalState } from './SignalState.js';

describe('SignalType', () => {
  it('should define all signal types', () => {
    expect(SignalType.Tests).toBe('tests');
    expect(SignalType.Types).toBe('types');
    expect(SignalType.Build).toBe('build');
    expect(SignalType.OxLint).toBe('oxlint');
    expect(SignalType.CustomLint).toBe('customLint');
  });
});

describe('SignalState', () => {
  describe('pass state', () => {
    it('should represent a passing signal with timestamp', () => {
      const timestamp = new Date();
      const passState: SignalState = {
        state: 'pass',
        timestamp,
      };

      expect(passState.state).toBe('pass');
      expect(passState.timestamp).toBe(timestamp);
    });

    it('should not include failures field', () => {
      const passState: SignalState = {
        state: 'pass',
        timestamp: new Date(),
      };

      // TypeScript compile-time check: failures should not exist
      expect('failures' in passState).toBe(false);
    });
  });

  describe('fail state', () => {
    it('should represent a failed signal with timestamp and failures', () => {
      const timestamp = new Date();
      const failures = [
        'Error: Test failed\n  at test.ts:10',
        'Error: Another test failed\n  at test.ts:20',
      ];
      const failState: SignalState = {
        state: 'fail',
        timestamp,
        failures,
      };

      expect(failState.state).toBe('fail');
      expect(failState.timestamp).toBe(timestamp);
      expect(failState.failures).toEqual(failures);
    });

    it('should include failures array with raw tool output', () => {
      const rawOutput = 'FAIL src/example.test.ts\n  × Example test\n    Expected 1 but got 2\n      at Object.<anonymous> (src/example.test.ts:5:15)';
      const failState: SignalState = {
        state: 'fail',
        timestamp: new Date(),
        failures: [rawOutput],
      };

      expect(failState.failures).toHaveLength(1);
      expect(failState.failures[0]).toBe(rawOutput);
    });
  });

  describe('running state', () => {
    it('should represent a running signal with timestamp and partial failures', () => {
      const timestamp = new Date();
      const failures = ['Error: First test failed'];
      const runningState: SignalState = {
        state: 'running',
        timestamp,
        failures,
      };

      expect(runningState.state).toBe('running');
      expect(runningState.timestamp).toBe(timestamp);
      expect(runningState.failures).toEqual(failures);
    });

    it('should support empty failures array when no errors found yet', () => {
      const runningState: SignalState = {
        state: 'running',
        timestamp: new Date(),
        failures: [],
      };

      expect(runningState.state).toBe('running');
      expect(runningState.failures).toEqual([]);
    });
  });

  describe('pending state', () => {
    it('should represent a pending signal with timestamp', () => {
      const timestamp = new Date();
      const pendingState: SignalState = {
        state: 'pending',
        timestamp,
      };

      expect(pendingState.state).toBe('pending');
      expect(pendingState.timestamp).toBe(timestamp);
    });

    it('should not include failures field', () => {
      const pendingState: SignalState = {
        state: 'pending',
        timestamp: new Date(),
      };

      // TypeScript compile-time check: failures should not exist
      expect('failures' in pendingState).toBe(false);
    });
  });

  describe('discriminated union type narrowing', () => {
    it('should narrow to fail state when state is fail', () => {
      const signal: SignalState = {
        state: 'fail',
        timestamp: new Date(),
        failures: ['error 1', 'error 2'],
      };

      if (signal.state === 'fail') {
        // TypeScript should allow accessing failures
        expect(signal.failures).toHaveLength(2);
        expect(signal.failures[0]).toBe('error 1');
      } else {
        throw new Error('Expected fail state');
      }
    });

    it('should narrow to running state when state is running', () => {
      const signal: SignalState = {
        state: 'running',
        timestamp: new Date(),
        failures: ['partial error'],
      };

      if (signal.state === 'running') {
        // TypeScript should allow accessing failures
        expect(signal.failures).toHaveLength(1);
        expect(signal.failures[0]).toBe('partial error');
      } else {
        throw new Error('Expected running state');
      }
    });

    it('should narrow to pass state when state is pass', () => {
      const signal: SignalState = {
        state: 'pass',
        timestamp: new Date(),
      };

      if (signal.state === 'pass') {
        // TypeScript should NOT allow accessing failures
        // @ts-expect-error - failures should not exist on pass state
        const shouldNotExist = signal.failures;
        expect(shouldNotExist).toBeUndefined();
      } else {
        throw new Error('Expected pass state');
      }
    });

    it('should narrow to pending state when state is pending', () => {
      const signal: SignalState = {
        state: 'pending',
        timestamp: new Date(),
      };

      if (signal.state === 'pending') {
        // TypeScript should NOT allow accessing failures
        // @ts-expect-error - failures should not exist on pending state
        const shouldNotExist = signal.failures;
        expect(shouldNotExist).toBeUndefined();
      } else {
        throw new Error('Expected pending state');
      }
    });

    it('should handle all states in switch statement', () => {
      const states: SignalState[] = [
        { state: 'pass', timestamp: new Date() },
        { state: 'fail', timestamp: new Date(), failures: ['error'] },
        { state: 'running', timestamp: new Date(), failures: [] },
        { state: 'pending', timestamp: new Date() },
      ];

      const results = states.map((signal) => {
        switch (signal.state) {
          case 'pass':
            return 'passing';
          case 'fail':
            return `failed with ${signal.failures.length} errors`;
          case 'running':
            return `running with ${signal.failures.length} errors so far`;
          case 'pending':
            return 'pending';
          case 'stale':
            return 'stale';
          default: {
            // Exhaustiveness check
            const _exhaustive: never = signal;
            return _exhaustive;
          }
        }
      });

      expect(results).toEqual([
        'passing',
        'failed with 1 errors',
        'running with 0 errors so far',
        'pending',
      ]);
    });
  });

  describe('failures field presence', () => {
    it('should only include failures on fail state', () => {
      const failState: SignalState = {
        state: 'fail',
        timestamp: new Date(),
        failures: ['error'],
      };

      expect('failures' in failState).toBe(true);
      expect(failState.failures).toBeDefined();
    });

    it('should only include failures on running state', () => {
      const runningState: SignalState = {
        state: 'running',
        timestamp: new Date(),
        failures: ['error'],
      };

      expect('failures' in runningState).toBe(true);
      expect(runningState.failures).toBeDefined();
    });

    it('should not include failures on pass state', () => {
      const passState: SignalState = {
        state: 'pass',
        timestamp: new Date(),
      };

      expect('failures' in passState).toBe(false);
    });

    it('should not include failures on pending state', () => {
      const pendingState: SignalState = {
        state: 'pending',
        timestamp: new Date(),
      };

      expect('failures' in pendingState).toBe(false);
    });
  });
});
