import * as path from 'path';

/**
 * Normalize path separators to forward slashes (cross-platform)
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Options for finding test files
 */
export interface FindTestFileOptions {
  /** Test file pattern: 'test' or 'spec' */
  testPattern?: 'test' | 'spec';
  /** Test directory name (e.g., '__tests__') */
  testDir?: string;
}

/**
 * Result of coverage analysis
 */
export interface TestCoverageResult {
  /** Whether any tests exist for the changed files */
  hasTests: boolean;
  /** Whether tests are comprehensive (all files covered, tests passed) */
  isComprehensive: boolean;
  /** Whether tests are partial (some coverage, tests passed) */
  isPartial: boolean;
  /** Whether tests ran and passed */
  testsPass: boolean;
  /** Files that have test coverage */
  filesCovered: string[];
  /** Files without test coverage */
  filesUncovered: string[];
}

/**
 * Input for coverage analysis
 */
export interface CoverageAnalysisInput {
  /** Files that were changed (source and test) */
  changedFiles: string[];
  /** Test files that exist in the project */
  existingTestFiles: string[];
  /** Whether tests were run */
  testsRan: boolean;
  /** Whether tests passed */
  testsPassed: boolean;
  /** Override to mark as comprehensive (e.g., based on coverage report) */
  isComprehensive?: boolean;
}

/**
 * Result of analyzing test changes
 */
export interface TestChangeAnalysis {
  /** Test files that are new (didn't exist before) */
  addedTests: string[];
  /** Test files that existed before and were modified */
  changedTests: string[];
}

/**
 * Input for test change analysis
 */
export interface TestChangeInput {
  /** Files that were changed in this commit */
  changedFiles: string[];
  /** Test files that existed before the changes */
  previousTestFiles: string[];
  /** Test files that exist after the changes */
  currentTestFiles: string[];
}

/**
 * Analyzes test coverage for changed files.
 *
 * TestCoverage helps determine whether changed source files have
 * corresponding test files and whether those tests have been run.
 * This information is used by the RiskComputer to determine risk levels.
 */
export class TestCoverage {
  /**
   * Common test file patterns
   */
  private readonly testPatterns = ['.test.', '.spec.'];
  private readonly testDirPattern = /__tests__/;

  /**
   * Find the expected test file path for a source file
   */
  findTestFile(
    sourceFile: string,
    options: FindTestFileOptions = {}
  ): string | null {
    // Don't find tests for test files
    if (this.isTestFile(sourceFile)) {
      return null;
    }

    const pattern = options.testPattern || 'test';
    const ext = path.extname(sourceFile);
    const baseName = path.basename(sourceFile, ext);
    const dir = path.dirname(sourceFile);

    if (options.testDir) {
      // Test in __tests__ directory
      return normalizePath(path.join(dir, options.testDir, `${baseName}.test${ext}`));
    }

    // Test file alongside source
    return normalizePath(path.join(dir, `${baseName}.${pattern}${ext}`));
  }

  /**
   * Check if a file is a test file
   */
  isTestFile(filePath: string): boolean {
    // Check for .test. or .spec. in filename
    for (const pattern of this.testPatterns) {
      if (filePath.includes(pattern)) {
        return true;
      }
    }

    // Check for __tests__ in path
    if (this.testDirPattern.test(filePath)) {
      return true;
    }

    return false;
  }

  /**
   * Analyze test coverage for a set of changes
   */
  analyze(input: CoverageAnalysisInput): TestCoverageResult {
    // Filter out test files from changed files
    const sourceFiles = input.changedFiles.filter((f) => !this.isTestFile(f));

    const filesCovered: string[] = [];
    const filesUncovered: string[] = [];

    for (const sourceFile of sourceFiles) {
      const testFile = this.matchTestFile(sourceFile, input.existingTestFiles);
      if (testFile) {
        filesCovered.push(sourceFile);
      } else {
        filesUncovered.push(sourceFile);
      }
    }

    const hasTests = filesCovered.length > 0;
    const allCovered = filesUncovered.length === 0 && hasTests;
    const testsPass = input.testsRan && input.testsPassed;

    // Comprehensive: all files covered, tests ran and passed, or explicitly marked
    const isComprehensive =
      input.isComprehensive === true ||
      (allCovered && testsPass);

    // Partial: some coverage and tests passed
    const isPartial = hasTests && testsPass && !isComprehensive;

    return {
      hasTests,
      isComprehensive,
      isPartial,
      testsPass,
      filesCovered,
      filesUncovered,
    };
  }

  /**
   * Match a source file to its test file in a list of test files
   */
  matchTestFile(sourceFile: string, testFiles: string[]): string | null {
    const ext = path.extname(sourceFile);
    const baseName = path.basename(sourceFile, ext);
    const dir = path.dirname(sourceFile);

    // Look for matching test file patterns
    for (const testFile of testFiles) {
      const testBaseName = path.basename(testFile);
      const testDir = path.dirname(testFile);

      // Check direct match: src/app.ts -> src/app.test.ts or src/app.spec.ts
      if (
        testBaseName === `${baseName}.test${ext}` ||
        testBaseName === `${baseName}.spec${ext}`
      ) {
        // Same directory or __tests__ subdirectory
        if (testDir === dir || testDir === path.join(dir, '__tests__')) {
          return testFile;
        }
      }

      // Check __tests__ directory match: src/utils/helper.ts -> src/utils/__tests__/helper.test.ts
      if (testDir.endsWith('__tests__')) {
        const parentDir = path.dirname(testDir);
        if (
          parentDir === dir &&
          (testBaseName === `${baseName}.test${ext}` ||
            testBaseName === `${baseName}.spec${ext}`)
        ) {
          return testFile;
        }
      }
    }

    return null;
  }

  /**
   * Analyze which tests were added vs changed in a commit
   */
  analyzeTestChanges(input: TestChangeInput): TestChangeAnalysis {
    const changedTestFiles = input.changedFiles.filter((f) => this.isTestFile(f));
    const previousSet = new Set(input.previousTestFiles);

    const addedTests: string[] = [];
    const changedTests: string[] = [];

    for (const testFile of changedTestFiles) {
      if (previousSet.has(testFile)) {
        changedTests.push(testFile);
      } else if (input.currentTestFiles.includes(testFile)) {
        addedTests.push(testFile);
      }
    }

    return { addedTests, changedTests };
  }
}
