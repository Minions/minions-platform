/**
 * Tests for IQualityWatcher interface
 *
 * Verifies that the interface can be mocked for testing and demonstrates
 * usage patterns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IQualityWatcher } from './IQualityWatcher.js';
import { MockQualityWatcher } from './index.js';
import { SignalType } from './SignalState.js';
import type { QualityStatus } from './QualityStatus.js';

describe('IQualityWatcher', () => {
  describe('interface mocking', () => {
    let watcher: IQualityWatcher;

    beforeEach(() => {
      watcher = new MockQualityWatcher('test-wing');
    });

    it('can be mocked with MockQualityWatcher', () => {
      expect(watcher).toBeDefined();
      expect(watcher.wingName).toBe('test-wing');
    });

    it('has wingName property', () => {
      expect(watcher.wingName).toBe('test-wing');
    });

    it('has start() method that returns Promise', async () => {
      const result = watcher.start();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('has stop() method that returns Promise', async () => {
      await watcher.start();
      const result = watcher.stop();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('has getStatus() method that returns QualityStatus', () => {
      const status = watcher.getStatus();
      expect(status).toBeDefined();
      expect(status).toHaveProperty(SignalType.Tests);
      expect(status).toHaveProperty(SignalType.Types);
      expect(status).toHaveProperty(SignalType.OxLint);
      expect(status).toHaveProperty(SignalType.CustomLint);
      expect(status).toHaveProperty(SignalType.Build);
      expect(status).toHaveProperty('aggregatedAt');
      expect(status).toHaveProperty('isPartial');
    });

    it('has isRunning() method that returns boolean', () => {
      const result = watcher.isRunning();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('MockQualityWatcher behavior', () => {
    let watcher: MockQualityWatcher;

    beforeEach(() => {
      watcher = new MockQualityWatcher('test-wing');
    });

    it('starts in not-running state', () => {
      expect(watcher.isRunning()).toBe(false);
    });

    it('becomes running after start()', async () => {
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('stops running after stop()', async () => {
      await watcher.start();
      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('throws if started when already running', async () => {
      await watcher.start();
      await expect(watcher.start()).rejects.toThrow('already running');
    });

    it('returns initial status with all signals passing', () => {
      const status = watcher.getStatus();
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('pass');
      expect(status.isPartial).toBe(false);
    });

    it('allows setting custom status via test helper', () => {
      const customStatus: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp: new Date() },
        [SignalType.Types]: { state: 'pass', timestamp: new Date() },
        [SignalType.Build]: { state: 'pass', timestamp: new Date() },
        [SignalType.OxLint]: { state: 'pass', timestamp: new Date()  },
        [SignalType.CustomLint]: { state: 'pass', timestamp: new Date()  },
        aggregatedAt: new Date(),
        isPartial: false,
      };

      watcher.setStatus(customStatus);
      const status = watcher.getStatus();
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status.isPartial).toBe(false);
    });

    it('getStatus() returns immediately without waiting', () => {
      // Demonstrate that getStatus is synchronous
      const start = Date.now();
      const status = watcher.getStatus();
      const duration = Date.now() - start;

      expect(status).toBeDefined();
      expect(duration).toBeLessThan(10); // Should be nearly instant
    });
  });

  describe('usage patterns', () => {
    it('demonstrates typical lifecycle', async () => {
      const watcher = new MockQualityWatcher('my-wing');

      // Start the watcher
      expect(watcher.isRunning()).toBe(false);
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);

      // Get current status (synchronous)
      const status = watcher.getStatus();
      expect(status).toBeDefined();

      // Stop the watcher
      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('demonstrates polling pattern for status updates', async () => {
      const watcher = new MockQualityWatcher('my-wing');
      await watcher.start();

      // Initial status is all-passing (mock defaults)
      const status1 = watcher.getStatus();
      expect(status1.isPartial).toBe(false);

      // Simulate updating status to demonstrate polling
      const completedStatus: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp: new Date() },
        [SignalType.Types]: { state: 'pass', timestamp: new Date() },
        [SignalType.Build]: { state: 'pass', timestamp: new Date() },
        [SignalType.OxLint]: { state: 'pass', timestamp: new Date()  },
        [SignalType.CustomLint]: { state: 'pass', timestamp: new Date()  },
        aggregatedAt: new Date(),
        isPartial: false,
      };
      watcher.setStatus(completedStatus);

      const status2 = watcher.getStatus();
      expect(status2.isPartial).toBe(false);

      await watcher.stop();
    });

    it('demonstrates handling partial results', async () => {
      const watcher = new MockQualityWatcher('my-wing');
      await watcher.start();

      // Set partial status (some signals complete, others running)
      const partialStatus: QualityStatus = {
        [SignalType.Tests]: { state: 'pass', timestamp: new Date() },
        [SignalType.Types]: { state: 'running', timestamp: new Date(), failures: [] },
        [SignalType.Build]: { state: 'pending', timestamp: new Date() },
        [SignalType.OxLint]: { state: 'pass', timestamp: new Date()  },
        [SignalType.CustomLint]: { state: 'pass', timestamp: new Date()  },
        aggregatedAt: new Date(),
        isPartial: true,
      };
      watcher.setStatus(partialStatus);

      const status = watcher.getStatus();
      expect(status.isPartial).toBe(true);
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('running');

      await watcher.stop();
    });
  });
});
