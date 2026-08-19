import { describe, it, expect } from 'vitest';
import { TestCoverage } from './TestCoverage.js';

describe('TestCoverage', () => {
  describe('finding test files', () => {
    it('finds .test.ts file for source file', () => {
      const coverage = new TestCoverage();

      const testFile = coverage.findTestFile('src/utils/helper.ts');

      expect(testFile).toBe('src/utils/helper.test.ts');
    });

    it('finds .spec.ts file pattern', () => {
      const coverage = new TestCoverage();

      const testFile = coverage.findTestFile('src/utils/helper.ts', {
        testPattern: 'spec',
      });

      expect(testFile).toBe('src/utils/helper.spec.ts');
    });

    it('finds test file in __tests__ directory', () => {
      const coverage = new TestCoverage();

      const testFile = coverage.findTestFile('src/utils/helper.ts', {
        testDir: '__tests__',
      });

      expect(testFile).toBe('src/utils/__tests__/helper.test.ts');
    });

    it('returns null for test files (no tests for tests)', () => {
      const coverage = new TestCoverage();

      const testFile = coverage.findTestFile('src/utils/helper.test.ts');

      expect(testFile).toBeNull();
    });

    it('returns null for spec files', () => {
      const coverage = new TestCoverage();

      const testFile = coverage.findTestFile('src/utils/helper.spec.ts');

      expect(testFile).toBeNull();
    });
  });

  describe('detecting test files', () => {
    it('identifies .test.ts files', () => {
      const coverage = new TestCoverage();

      expect(coverage.isTestFile('src/app.test.ts')).toBe(true);
      expect(coverage.isTestFile('src/utils/helper.test.ts')).toBe(true);
    });

    it('identifies .spec.ts files', () => {
      const coverage = new TestCoverage();

      expect(coverage.isTestFile('src/app.spec.ts')).toBe(true);
      expect(coverage.isTestFile('src/utils/helper.spec.ts')).toBe(true);
    });

    it('identifies files in __tests__ directories', () => {
      const coverage = new TestCoverage();

      expect(coverage.isTestFile('src/__tests__/app.ts')).toBe(true);
      expect(coverage.isTestFile('__tests__/integration/workflow.ts')).toBe(true);
    });

    it('does not identify regular source files as tests', () => {
      const coverage = new TestCoverage();

      expect(coverage.isTestFile('src/app.ts')).toBe(false);
      expect(coverage.isTestFile('src/utils/helper.ts')).toBe(false);
    });

    it('handles .js files', () => {
      const coverage = new TestCoverage();

      expect(coverage.isTestFile('src/app.test.js')).toBe(true);
      expect(coverage.isTestFile('src/app.spec.js')).toBe(true);
      expect(coverage.isTestFile('src/app.js')).toBe(false);
    });
  });

  describe('analyzing coverage for changes', () => {
    it('reports no coverage when source file has no test', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });

      expect(result.hasTests).toBe(false);
      expect(result.isComprehensive).toBe(false);
      expect(result.isPartial).toBe(false);
    });

    it('reports partial coverage when test exists but did not run', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: false,
        testsPassed: false,
      });

      expect(result.hasTests).toBe(true);
      expect(result.isComprehensive).toBe(false);
      expect(result.isPartial).toBe(false);
      expect(result.testsPass).toBe(false);
    });

    it('reports partial coverage when some files covered and tests passed', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts', 'src/utils.ts'],
        existingTestFiles: ['src/app.test.ts'], // Only app.ts has tests, utils.ts does not
        testsRan: true,
        testsPassed: true,
      });

      expect(result.hasTests).toBe(true);
      expect(result.isPartial).toBe(true);
      expect(result.isComprehensive).toBe(false);
      expect(result.testsPass).toBe(true);
      expect(result.filesCovered).toEqual(['src/app.ts']);
      expect(result.filesUncovered).toEqual(['src/utils.ts']);
    });

    it('reports comprehensive coverage when all files have tests and tests passed', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts', 'src/utils.ts'],
        existingTestFiles: ['src/app.test.ts', 'src/utils.test.ts'],
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });

      expect(result.hasTests).toBe(true);
      expect(result.isComprehensive).toBe(true);
      expect(result.testsPass).toBe(true);
    });

    it('reports tests failed when tests did not pass', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: false,
      });

      expect(result.testsPass).toBe(false);
    });

    it('reports coverage per file', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts', 'src/utils.ts', 'src/config.ts'],
        existingTestFiles: ['src/app.test.ts', 'src/utils.test.ts'],
        testsRan: true,
        testsPassed: true,
      });

      expect(result.filesCovered).toEqual(['src/app.ts', 'src/utils.ts']);
      expect(result.filesUncovered).toEqual(['src/config.ts']);
    });

    it('ignores test files in changed files for coverage analysis', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyze({
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
      });

      // Only src/app.ts counts as a changed source file
      expect(result.filesCovered).toEqual(['src/app.ts']);
    });
  });

  describe('matching source to test files', () => {
    it('matches source file to test file by name', () => {
      const coverage = new TestCoverage();

      const match = coverage.matchTestFile('src/app.ts', [
        'src/app.test.ts',
        'src/utils.test.ts',
      ]);

      expect(match).toBe('src/app.test.ts');
    });

    it('returns null when no matching test file', () => {
      const coverage = new TestCoverage();

      const match = coverage.matchTestFile('src/config.ts', [
        'src/app.test.ts',
        'src/utils.test.ts',
      ]);

      expect(match).toBeNull();
    });

    it('matches spec files', () => {
      const coverage = new TestCoverage();

      const match = coverage.matchTestFile('src/app.ts', [
        'src/app.spec.ts',
      ]);

      expect(match).toBe('src/app.spec.ts');
    });

    it('matches __tests__ directory files', () => {
      const coverage = new TestCoverage();

      const match = coverage.matchTestFile('src/utils/helper.ts', [
        'src/utils/__tests__/helper.test.ts',
      ]);

      expect(match).toBe('src/utils/__tests__/helper.test.ts');
    });
  });

  describe('added vs changed tests', () => {
    it('identifies added tests (new test files)', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyzeTestChanges({
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        previousTestFiles: [],
        currentTestFiles: ['src/app.test.ts'],
      });

      expect(result.addedTests).toEqual(['src/app.test.ts']);
      expect(result.changedTests).toEqual([]);
    });

    it('identifies changed tests (existing test files modified)', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyzeTestChanges({
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        previousTestFiles: ['src/app.test.ts'],
        currentTestFiles: ['src/app.test.ts'],
      });

      expect(result.addedTests).toEqual([]);
      expect(result.changedTests).toEqual(['src/app.test.ts']);
    });

    it('handles mix of added and changed tests', () => {
      const coverage = new TestCoverage();

      const result = coverage.analyzeTestChanges({
        changedFiles: ['src/app.test.ts', 'src/utils.test.ts'],
        previousTestFiles: ['src/app.test.ts'],
        currentTestFiles: ['src/app.test.ts', 'src/utils.test.ts'],
      });

      expect(result.addedTests).toEqual(['src/utils.test.ts']);
      expect(result.changedTests).toEqual(['src/app.test.ts']);
    });
  });
});
