import { describe, it, expect, beforeEach } from 'vitest';
import { RiskFactorTracker } from './RiskFactorTracker.js';
import { RiskCode } from './RiskComputer.js';

describe('RiskFactorTracker', () => {
  let tracker: RiskFactorTracker;

  beforeEach(() => {
    tracker = new RiskFactorTracker();
  });

  describe('adding risk factors', () => {
    it('starts with no risk factors', () => {
      expect(tracker.getRiskFactors()).toEqual([]);
    });

    it('adds a risk factor', () => {
      tracker.addRiskFactor(RiskCode.Risky, 'Breaking API change');

      const factors = tracker.getRiskFactors();
      expect(factors).toHaveLength(1);
      expect(factors[0].code).toBe(RiskCode.Risky);
      expect(factors[0].reason).toBe('Breaking API change');
    });

    it('adds a risk factor with details', () => {
      tracker.addRiskFactor(RiskCode.Covered, 'Partial coverage', 'Missing edge case tests');

      const factors = tracker.getRiskFactors();
      expect(factors).toHaveLength(1);
      expect(factors[0].details).toBe('Missing edge case tests');
    });

    it('accumulates multiple risk factors', () => {
      tracker.addRiskFactor(RiskCode.Thorough, 'First concern');
      tracker.addRiskFactor(RiskCode.Covered, 'Second concern');
      tracker.addRiskFactor(RiskCode.Risky, 'Third concern');

      expect(tracker.getRiskFactors()).toHaveLength(3);
    });
  });

  describe('getting maximum risk code', () => {
    it('returns null when no factors', () => {
      expect(tracker.getMaxRiskCode()).toBeNull();
    });

    it('returns the only risk code when single factor', () => {
      tracker.addRiskFactor(RiskCode.Covered, 'Concern');
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Covered);
    });

    it('returns maximum risk code from multiple factors', () => {
      tracker.addRiskFactor(RiskCode.Thorough, 'Low risk');
      tracker.addRiskFactor(RiskCode.Risky, 'High risk');
      tracker.addRiskFactor(RiskCode.Covered, 'Medium risk');

      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Risky);
    });

    it('correctly orders all risk codes', () => {
      // Provable is lowest risk
      tracker.addRiskFactor(RiskCode.Provable, 'Factor');
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Provable);

      // Thorough is higher
      tracker.addRiskFactor(RiskCode.Thorough, 'Factor');
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Thorough);

      // Covered is higher still
      tracker.addRiskFactor(RiskCode.Covered, 'Factor');
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Covered);

      // Risky is highest
      tracker.addRiskFactor(RiskCode.Risky, 'Factor');
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Risky);
    });
  });

  describe('resetting factors', () => {
    it('clears all factors after reset', () => {
      tracker.addRiskFactor(RiskCode.Risky, 'Concern');
      tracker.addRiskFactor(RiskCode.Covered, 'Another concern');

      tracker.reset();

      expect(tracker.getRiskFactors()).toEqual([]);
      expect(tracker.getMaxRiskCode()).toBeNull();
    });
  });

  describe('checking if has factors', () => {
    it('returns false when no factors', () => {
      expect(tracker.hasRiskFactors()).toBe(false);
    });

    it('returns true when factors exist', () => {
      tracker.addRiskFactor(RiskCode.Thorough, 'Something');
      expect(tracker.hasRiskFactors()).toBe(true);
    });

    it('returns false after reset', () => {
      tracker.addRiskFactor(RiskCode.Thorough, 'Something');
      tracker.reset();
      expect(tracker.hasRiskFactors()).toBe(false);
    });
  });

  describe('state persistence', () => {
    it('exports state for persistence', () => {
      tracker.addRiskFactor(RiskCode.Risky, 'Breaking change', 'API v2 incompatible');
      tracker.addRiskFactor(RiskCode.Covered, 'Partial tests');

      const state = tracker.exportState();

      expect(state.factors).toHaveLength(2);
      expect(state.factors[0].code).toBe(RiskCode.Risky);
      expect(state.factors[0].reason).toBe('Breaking change');
      expect(state.factors[0].details).toBe('API v2 incompatible');
    });

    it('imports state from persistence', () => {
      const state = {
        factors: [
          { code: RiskCode.Risky, reason: 'Restored factor', details: 'From save', timestamp: 1000 },
        ],
      };

      tracker.importState(state);

      expect(tracker.getRiskFactors()).toHaveLength(1);
      expect(tracker.getMaxRiskCode()).toBe(RiskCode.Risky);
    });

    it('clears existing factors when importing', () => {
      tracker.addRiskFactor(RiskCode.Covered, 'Existing');

      tracker.importState({ factors: [] });

      expect(tracker.hasRiskFactors()).toBe(false);
    });
  });

  describe('timestamps', () => {
    it('records timestamp when adding factor', () => {
      const before = Date.now();
      tracker.addRiskFactor(RiskCode.Risky, 'Breaking change');
      const after = Date.now();

      const factors = tracker.getRiskFactors();
      expect(factors[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(factors[0].timestamp).toBeLessThanOrEqual(after);
    });
  });
});
