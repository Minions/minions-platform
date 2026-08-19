import type { Worktree } from '@minions/file-store';
import * as path from 'path';
import {
  RiskComputer,
  RiskCode,
  RiskAssessment,
  ManualRiskFactor,
} from '../risk/RiskComputer.js';
import { ToolTracker } from '../risk/ToolTracker.js';

/**
 * Options for risk assessment
 */
export interface AssessRiskOptions {
  /** Whether tests were run */
  testsRan: boolean;
  /** Whether tests passed */
  testsPassed: boolean;
  /** Whether the test coverage is comprehensive */
  isComprehensive?: boolean;
  /** Manual risk factors to include */
  manualRiskFactors?: ManualRiskFactor[];
}

/**
 * Result of a risk assessment
 */
export interface AssessRiskResult extends RiskAssessment {
  /** Files that were modified since last commit */
  modifiedFiles: string[];
}

/**
 * Assesses risk of current changes before committing.
 *
 * Uses the RiskComputer to analyze tool usage, file changes, and test coverage
 * to determine the risk level of committing the current changes.
 *
 * Note: This tool relies on ToolTracker for knowing which files were modified.
 * It assumes all file modifications happen through tracked tools.
 */
export class AssessRisk {
  constructor(
    private readonly worktree: Worktree,
    private readonly tracker: ToolTracker
  ) {}

  /**
   * Assess the risk of the current changes
   */
  async assess(options: AssessRiskOptions): Promise<AssessRiskResult> {
    // Get changed files from tracker
    const changedFiles = this.tracker.getEditedFiles();

    // Find existing test files for the changed files
    const existingTestFiles = await this.findExistingTestFiles(changedFiles);

    // Separate added vs changed test files (all tracked files are considered new for simplicity)
    const { addedTestFiles, changedTestFiles } = this.categorizeTestFiles(changedFiles);

    // Create risk computer with current state
    const computer = new RiskComputer({
      tracker: this.tracker,
      changedFiles,
      existingTestFiles,
      testsRan: options.testsRan,
      testsPassed: options.testsPassed,
      isComprehensive: options.isComprehensive,
      addedTestFiles,
      changedTestFiles,
    });

    // Add any manual risk factors
    if (options.manualRiskFactors) {
      for (const factor of options.manualRiskFactors) {
        computer.addRiskFactor(factor.code, factor.reason, factor.details);
      }
    }

    // Compute risk
    const assessment = computer.computeRisk();

    return {
      ...assessment,
      modifiedFiles: changedFiles,
    };
  }

  /**
   * Find test files that exist for the changed files
   */
  private async findExistingTestFiles(changedFiles: string[]): Promise<string[]> {
    const testFiles: string[] = [];

    for (const file of changedFiles) {
      // Skip if already a test file
      if (this.isTestFile(file)) {
        if (await this.fileExists(file)) {
          testFiles.push(file);
        }
        continue;
      }

      // Look for corresponding test files
      const possibleTestFiles = this.getPossibleTestFiles(file);
      for (const testFile of possibleTestFiles) {
        if (await this.fileExists(testFile)) {
          testFiles.push(testFile);
        }
      }
    }

    return [...new Set(testFiles)];
  }

  /**
   * Categorize test files into added vs changed.
   * Since we don't track git history, we treat all test files in the
   * changed list as "added" (conservative assumption).
   */
  private categorizeTestFiles(changedFiles: string[]): {
    addedTestFiles: string[];
    changedTestFiles: string[];
  } {
    const addedTestFiles: string[] = [];
    const changedTestFiles: string[] = [];

    for (const file of changedFiles) {
      if (this.isTestFile(file)) {
        // Without git history, assume all test file changes are additions
        // This is conservative - added tests count toward comprehensive coverage
        addedTestFiles.push(file);
      }
    }

    return { addedTestFiles, changedTestFiles };
  }

  /**
   * Check if a file is a test file
   */
  private isTestFile(file: string): boolean {
    return (
      file.includes('.test.') ||
      file.includes('.spec.') ||
      file.includes('__tests__') ||
      file.includes('test/') ||
      file.includes('tests/')
    );
  }

  /**
   * Get possible test file paths for a source file
   */
  private getPossibleTestFiles(file: string): string[] {
    const dir = path.dirname(file);
    const base = file.replace(/\.(ts|js|tsx|jsx)$/, '');
    const ext = file.match(/\.(ts|js|tsx|jsx)$/)?.[0] || '.ts';

    return [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      path.join(dir, '__tests__', path.basename(file)),
    ];
  }

  /**
   * Check if a file exists in the worktree
   */
  private async fileExists(filePath: string): Promise<boolean> {
    // Use glob for simpler existence check
    const matches = await this.worktree.glob(filePath);
    return matches.length > 0;
  }
}

export { RiskCode };
