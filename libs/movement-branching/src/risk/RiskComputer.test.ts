import { describe, it, expect, beforeEach } from 'vitest';
import { RiskComputer, RiskCode } from './RiskComputer.js';
import { ToolTracker } from './ToolTracker.js';

describe('RiskComputer', () => {
  let tracker: ToolTracker;

  beforeEach(() => {
    tracker = new ToolTracker();
  });

  describe('documentation only changes', () => {
    it('assigns provable (.) risk for docs only', () => {
      tracker.recordTool('Edit', { file: 'README.md' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['README.md'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
      expect(risk.reason).toContain('Documentation only');
    });

    it('assigns provable (.) for multiple doc files', () => {
      tracker.recordTool('Edit', { file: 'README.md' });
      tracker.recordTool('Edit', { file: 'docs/guide.md' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['README.md', 'docs/guide.md'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
    });
  });

  describe('plan document only changes', () => {
    it('assigns provable (.) risk for a plan-only change with no coverage flags', () => {
      tracker.recordTool('Edit', { file: '.meta/plans/some-plan.md' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['.meta/plans/some-plan.md'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
      expect(risk.reason).toContain('Plan document only');
    });

    it('assigns provable (.) for a mix of plan and docs files', () => {
      tracker.recordTool('Edit', { file: '.meta/plans/some-plan.md' });
      tracker.recordTool('Edit', { file: 'README.md' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['.meta/plans/some-plan.md', 'README.md'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
    });
  });

  describe('test only changes', () => {
    it('assigns provable (.) risk for test only', () => {
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
      expect(risk.reason).toContain('Test changes only');
    });

    it('assigns provable (.) for test and docs combined', () => {
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });
      tracker.recordTool('Edit', { file: 'README.md' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.test.ts', 'README.md'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
    });
  });

  describe('code changes without tests', () => {
    it('assigns risky (@) risk for no test coverage', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Risky);
      expect(risk.reason).toContain('No test coverage');
    });
  });

  describe('code changes with tests', () => {
    it('assigns thorough (^) for comprehensive coverage with passing tests', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Thorough);
      expect(risk.reason).toContain('Comprehensive test coverage');
    });

    it('assigns covered (!) for partial coverage with passing tests', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/utils.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts', 'src/utils.ts'],
        existingTestFiles: ['src/app.test.ts'], // Only app.ts has tests
        testsRan: true,
        testsPassed: true,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Covered);
      expect(risk.reason).toContain('Partial test coverage');
    });

    it('assigns risky (@) when tests fail', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Risky);
      expect(risk.reason).toContain('Tests did not pass');
    });

    it('assigns risky (@) when tests exist but did not run', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Risky);
      expect(risk.reason).toContain('Tests did not run');
    });
  });

  describe('added tests counting as coverage', () => {
    it('counts added tests as coverage for the commit', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Write', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
        addedTestFiles: ['src/app.test.ts'],
        isComprehensive: true,
      });
      const risk = computer.computeRisk();

      // Added tests DO count as coverage
      expect(risk.code).toBe(RiskCode.Thorough);
    });
  });

  describe('changed tests not counting as coverage', () => {
    it('does not count changed tests as new coverage', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
        changedTestFiles: ['src/app.test.ts'], // Modified existing test
      });
      const risk = computer.computeRisk();

      // Changed tests don't provide comprehensive coverage guarantee
      // Still covered if tests pass
      expect(risk.code).toBe(RiskCode.Covered);
    });
  });

  describe('manual risk factors', () => {
    it('allows adding manual risk factors', () => {
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
      });

      // Automated risk would be provable (.)
      computer.addRiskFactor(RiskCode.Covered, 'Breaking API change', 'Changed auth token format');

      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Covered); // Manual factor overrides
      expect(risk.automated.code).toBe(RiskCode.Provable);
      expect(risk.manualFactors).toHaveLength(1);
      expect(risk.manualFactors[0].reason).toBe('Breaking API change');
    });

    it('takes maximum risk from multiple factors', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });

      // Automated: thorough (^)
      computer.addRiskFactor(RiskCode.Covered, 'Some concern');
      computer.addRiskFactor(RiskCode.Risky, 'Major breaking change');

      const risk = computer.computeRisk();

      // Risky is the maximum
      expect(risk.code).toBe(RiskCode.Risky);
      expect(risk.manualFactors).toHaveLength(2);
    });

    it('includes all manual factors in the assessment', () => {
      const computer = new RiskComputer({
        tracker,
        changedFiles: ['README.md'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });

      computer.addRiskFactor(RiskCode.Covered, 'First concern', 'Details 1');
      computer.addRiskFactor(RiskCode.Thorough, 'Second concern', 'Details 2');

      const risk = computer.computeRisk();

      expect(risk.manualFactors).toHaveLength(2);
      expect(risk.manualFactors[0].details).toBe('Details 1');
      expect(risk.manualFactors[1].details).toBe('Details 2');
    });
  });

  describe('suggestions for lower risk', () => {
    it('suggests adding tests when none exist', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.suggestions).toContain('Add tests for src/app.ts');
    });

    it('suggests running tests when tests exist but did not run', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.suggestions).toContain('Run existing tests to verify changes');
    });

    it('suggests fixing tests when tests fail', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.suggestions).toContain('Fix failing tests before committing');
    });

    it('suggests adding tests for uncovered files when coverage is partial', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/utils.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts', 'src/utils.ts'],
        existingTestFiles: ['src/app.test.ts'], // Only app.ts has tests
        testsRan: true,
        testsPassed: true,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Covered);
      expect(risk.suggestions).toContain('Add tests for src/utils.ts to reach comprehensive coverage');
    });

    it('suggests adding new tests when only existing tests were changed', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.ts', 'src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
        changedTestFiles: ['src/app.test.ts'],
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Covered);
      expect(risk.suggestions).toContain(
        'Add new tests (not just edit existing ones) covering the adjacent invariants, then pass isComprehensive: true',
      );
    });
  });

  describe('read-only tools', () => {
    it('ignores read-only tool usage for risk', () => {
      tracker.recordTool('Read', { file: 'src/config.ts' });
      tracker.recordTool('Glob', { pattern: '**/*.ts' });
      tracker.recordTool('Grep', { pattern: 'TODO' });
      tracker.recordTool('Edit', { file: 'src/app.test.ts' });

      const computer = new RiskComputer({
        tracker,
        changedFiles: ['src/app.test.ts'],
        existingTestFiles: ['src/app.test.ts'],
        testsRan: true,
        testsPassed: true,
      });
      const risk = computer.computeRisk();

      // Still provable despite read-only tools
      expect(risk.code).toBe(RiskCode.Provable);
    });
  });

  describe('risk code ordering', () => {
    it('orders risk codes correctly', () => {
      const computer = new RiskComputer({
        tracker,
        changedFiles: [],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });

      // Test internal maxRiskCode logic through manual factors
      computer.addRiskFactor(RiskCode.Thorough, 'Factor 1');
      computer.addRiskFactor(RiskCode.Provable, 'Factor 2');
      computer.addRiskFactor(RiskCode.Covered, 'Factor 3');

      const risk = computer.computeRisk();

      // Covered (!) > Thorough (^) > Provable (.)
      expect(risk.code).toBe(RiskCode.Covered);
    });
  });

  describe('no changes', () => {
    it('returns provable for no changes', () => {
      const computer = new RiskComputer({
        tracker,
        changedFiles: [],
        existingTestFiles: [],
        testsRan: false,
        testsPassed: false,
      });
      const risk = computer.computeRisk();

      expect(risk.code).toBe(RiskCode.Provable);
      expect(risk.reason).toContain('No changes');
    });
  });
});
