import { RiskCode, ManualRiskFactor } from './RiskComputer.js';

/**
 * A tracked risk factor with timestamp
 */
export interface TrackedRiskFactor extends ManualRiskFactor {
  timestamp: number;
}

/**
 * Serializable state for persistence
 */
export interface RiskFactorTrackerState {
  factors: TrackedRiskFactor[];
}

/**
 * Risk code ordering (higher number = higher risk)
 */
const RISK_ORDER: Record<RiskCode, number> = {
  [RiskCode.Provable]: 0,
  [RiskCode.Thorough]: 1,
  [RiskCode.Covered]: 2,
  [RiskCode.Risky]: 3,
};

/**
 * Tracks manually added risk factors.
 *
 * Risk factors allow AI agents to explicitly mark commits as risky
 * when they know something the automated risk computation doesn't.
 * For example, a breaking API change that looks safe because it has
 * tests should be marked as risky.
 *
 * Risk factors accumulate until a commit is made, then they are reset.
 * The maximum risk code from all factors is used as the minimum risk
 * for the commit.
 */
export class RiskFactorTracker {
  private factors: TrackedRiskFactor[] = [];

  /**
   * Add a manual risk factor
   * @param code - Risk code (can only increase risk, never decrease)
   * @param reason - Brief explanation of the risk
   * @param details - Optional detailed explanation
   */
  addRiskFactor(code: RiskCode, reason: string, details?: string): void {
    this.factors.push({
      code,
      reason,
      details,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all accumulated risk factors
   */
  getRiskFactors(): readonly TrackedRiskFactor[] {
    return this.factors;
  }

  /**
   * Get the maximum (highest) risk code from all factors
   * Returns null if no factors have been added
   */
  getMaxRiskCode(): RiskCode | null {
    if (this.factors.length === 0) {
      return null;
    }

    return this.factors.reduce<RiskCode>((max, factor) =>
      RISK_ORDER[factor.code] > RISK_ORDER[max] ? factor.code : max,
      this.factors[0].code
    );
  }

  /**
   * Check if any risk factors have been added
   */
  hasRiskFactors(): boolean {
    return this.factors.length > 0;
  }

  /**
   * Reset all accumulated factors (call after commit)
   */
  reset(): void {
    this.factors = [];
  }

  /**
   * Export state for persistence
   */
  exportState(): RiskFactorTrackerState {
    return {
      factors: [...this.factors],
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: RiskFactorTrackerState): void {
    this.factors = [...state.factors];
  }
}
