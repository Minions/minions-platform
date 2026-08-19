import { ToolTracker } from './ToolTracker.js';
import { TestCoverage } from './TestCoverage.js';
import { ChangeAnalyzer } from './ChangeAnalyzer.js';

/**
 * Risk codes from Arlo's Commit Notation v2
 */
export enum RiskCode {
  /** Provable: Static transformation, no behavior change possible */
  Provable = '.',
  /** Thorough: Verified by comprehensive tests covering change and invariants */
  Thorough = '^',
  /** Covered: Verified by tests that cover the change */
  Covered = '!',
  /** Risky: No verification */
  Risky = '@',
}

/**
 * A manually added risk factor
 */
export interface ManualRiskFactor {
  code: RiskCode;
  reason: string;
  details?: string;
}

/**
 * Automated risk assessment result
 */
export interface AutomatedRisk {
  code: RiskCode;
  reason: string;
}

/**
 * Complete risk assessment result
 */
export interface RiskAssessment {
  /** Final risk code (maximum of automated and manual) */
  code: RiskCode;
  /** Explanation of the final risk */
  reason: string;
  /** Automated risk assessment */
  automated: AutomatedRisk;
  /** Manually added risk factors */
  manualFactors: ManualRiskFactor[];
  /** Suggestions for achieving lower risk */
  suggestions: string[];
}

/**
 * Input for risk computation
 */
export interface RiskComputerInput {
  /** Tool tracker with recorded tool usage */
  tracker: ToolTracker;
  /** Files changed in this commit */
  changedFiles: string[];
  /** Test files that exist in the project */
  existingTestFiles: string[];
  /** Whether tests were run */
  testsRan: boolean;
  /** Whether tests passed */
  testsPassed: boolean;
  /** Override to mark coverage as comprehensive */
  isComprehensive?: boolean;
  /** Test files that were added (new) in this commit */
  addedTestFiles?: string[];
  /** Test files that were modified (existing) in this commit */
  changedTestFiles?: string[];
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
 * Computes risk codes based on tool usage, test coverage, and file changes.
 *
 * RiskComputer implements the risk rules from Arlo's Commit Notation v2:
 * - Documentation only → Provable (.)
 * - Test only → Provable (.)
 * - Comprehensive test coverage with passing tests → Thorough (^)
 * - Partial test coverage with passing tests → Covered (!)
 * - No test coverage or failing tests → Risky (@)
 */
export class RiskComputer {
  private readonly changedFiles: string[];
  private readonly existingTestFiles: string[];
  private readonly testsRan: boolean;
  private readonly testsPassed: boolean;
  private readonly isComprehensiveOverride?: boolean;
  private readonly addedTestFiles: string[];
  private readonly changedTestFiles: string[];
  private readonly manualRiskFactors: ManualRiskFactor[] = [];

  private readonly testCoverage: TestCoverage;
  private readonly changeAnalyzer: ChangeAnalyzer;
  private lastCoverage?: ReturnType<TestCoverage['analyze']>;

  constructor(input: RiskComputerInput) {
    this.changedFiles = input.changedFiles;
    this.existingTestFiles = input.existingTestFiles;
    this.testsRan = input.testsRan;
    this.testsPassed = input.testsPassed;
    this.isComprehensiveOverride = input.isComprehensive;
    this.addedTestFiles = input.addedTestFiles || [];
    this.changedTestFiles = input.changedTestFiles || [];

    this.testCoverage = new TestCoverage();
    this.changeAnalyzer = new ChangeAnalyzer();
  }

  /**
   * Add a manual risk factor that overrides automated assessment
   */
  addRiskFactor(code: RiskCode, reason: string, details?: string): void {
    this.manualRiskFactors.push({ code, reason, details });
  }

  /**
   * Compute the risk assessment
   */
  computeRisk(): RiskAssessment {
    const automated = this.computeAutomatedRisk();
    const suggestions = this.computeSuggestions(automated);

    // Combine automated risk with manual factors
    const allRiskCodes = [
      automated.code,
      ...this.manualRiskFactors.map((f) => f.code),
    ];

    const finalCode = this.maxRiskCode(allRiskCodes);

    // The reason shown to the caller is always the automated assessment's own
    // reason — never a trace of *why* a manual factor escalated the code (e.g.
    // "Manual: Tool log analysis"), since that's reasoning about the
    // assessment, not guidance the caller can act on. The escalation is still
    // visible in the code itself (e.g. "@" instead of "!").
    return {
      code: finalCode,
      reason: automated.reason,
      automated,
      manualFactors: this.manualRiskFactors,
      suggestions,
    };
  }

  /**
   * Compute automated risk based on tool usage and test coverage
   */
  private computeAutomatedRisk(): AutomatedRisk {
    // No changes = provable
    if (this.changedFiles.length === 0) {
      return { code: RiskCode.Provable, reason: 'No changes' };
    }

    // Documentation only = provable
    if (this.changeAnalyzer.isDocsOnly(this.changedFiles)) {
      return { code: RiskCode.Provable, reason: 'Documentation only' };
    }

    // Plan documents (or plan + docs) = provable — non-executable prose, no test coverage applies
    if (this.changeAnalyzer.isDocsOrPlanOnly(this.changedFiles)) {
      return { code: RiskCode.Provable, reason: 'Plan document only' };
    }

    // Test only (or test + docs) = provable
    if (this.changeAnalyzer.isProvable(this.changedFiles)) {
      return { code: RiskCode.Provable, reason: 'Test changes only' };
    }

    // Has code changes - check test coverage
    const coverage = this.testCoverage.analyze({
      changedFiles: this.changedFiles,
      existingTestFiles: this.existingTestFiles,
      testsRan: this.testsRan,
      testsPassed: this.testsPassed,
      isComprehensive: this.isComprehensiveOverride,
    });
    this.lastCoverage = coverage;

    // No tests at all = risky
    if (!coverage.hasTests) {
      return { code: RiskCode.Risky, reason: 'No test coverage' };
    }

    // Tests exist but didn't run = risky
    if (!this.testsRan) {
      return { code: RiskCode.Risky, reason: 'Tests did not run' };
    }

    // Tests failed = risky
    if (!this.testsPassed) {
      return { code: RiskCode.Risky, reason: 'Tests did not pass' };
    }

    // Check if this is comprehensive coverage
    // Added tests DO count toward comprehensive coverage
    // Changed tests do NOT provide the same guarantee
    const hasAddedTests = this.addedTestFiles.length > 0;
    const onlyChangedTests = this.changedTestFiles.length > 0 && !hasAddedTests;

    if (coverage.isComprehensive && !onlyChangedTests) {
      return { code: RiskCode.Thorough, reason: 'Comprehensive test coverage' };
    }

    // Partial coverage with passing tests
    return { code: RiskCode.Covered, reason: 'Partial test coverage' };
  }

  /**
   * Compute suggestions for achieving lower risk
   */
  private computeSuggestions(automated: AutomatedRisk): string[] {
    const suggestions: string[] = [];

    if (automated.code === RiskCode.Risky) {
      // Get uncovered files
      const analysis = this.changeAnalyzer.analyze(this.changedFiles);

      if (automated.reason === 'No test coverage') {
        for (const file of analysis.codeFiles) {
          suggestions.push(`Add tests for ${file}`);
        }
      } else if (automated.reason === 'Tests did not run') {
        suggestions.push('Run existing tests to verify changes');
      } else if (automated.reason === 'Tests did not pass') {
        suggestions.push('Fix failing tests before committing');
      }
    }

    if (automated.code === RiskCode.Covered && this.lastCoverage) {
      if (this.lastCoverage.filesUncovered.length > 0) {
        for (const file of this.lastCoverage.filesUncovered) {
          suggestions.push(`Add tests for ${file} to reach comprehensive coverage`);
        }
      } else {
        suggestions.push(
          'Add new tests (not just edit existing ones) covering the adjacent invariants, then pass isComprehensive: true',
        );
      }
    }

    return suggestions;
  }

  /**
   * Get the maximum (highest) risk code from a list
   */
  private maxRiskCode(codes: RiskCode[]): RiskCode {
    return codes.reduce((max, code) =>
      RISK_ORDER[code] > RISK_ORDER[max] ? code : max
    );
  }

}
