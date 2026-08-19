import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { AssessRisk } from './AssessRisk.js';
import { ToolTracker } from '../risk/ToolTracker.js';
import { RiskCode } from '../risk/RiskComputer.js';

describe('AssessRisk', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let tracker: ToolTracker;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');

    // Create initial commit
    await worktree.createFile('README.md', '# Test');
    await worktree.commitAll('initial');

    tracker = new ToolTracker();
  });

  describe('documentation only changes', () => {
    it('returns provable risk for docs-only changes', async () => {
      // Modify only docs
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      tracker.recordTool('Edit', { file: 'README.md' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.code).toBe(RiskCode.Provable);
      expect(result.reason).toContain('Documentation only');
    });
  });

  describe('test only changes', () => {
    it('returns provable risk for test-only changes', async () => {
      // Create src directory and test file
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Write', { file: 'src/app.test.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: true,
        testsPassed: true,
      });

      expect(result.code).toBe(RiskCode.Provable);
      expect(result.reason).toContain('Test changes only');
    });
  });

  describe('code without tests', () => {
    it('returns risky when code modified without tests', async () => {
      // Create src directory and code file
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      tracker.recordTool('Write', { file: 'src/app.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.code).toBe(RiskCode.Risky);
      expect(result.reason).toContain('No test coverage');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('suggests adding tests for uncovered files', async () => {
      await worktree.createFile('src/utils.ts', 'export const x = 1');
      tracker.recordTool('Write', { file: 'src/utils.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.suggestions).toContain('Add tests for src/utils.ts');
    });
  });

  describe('code with passing tests', () => {
    it('returns thorough when comprehensive tests pass', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Write', { file: 'src/app.test.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });

      expect(result.code).toBe(RiskCode.Thorough);
      expect(result.reason).toContain('Comprehensive test coverage');
    });

    it('returns covered when partial tests pass (some files uncovered)', async () => {
      // app.ts has a test file
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      // utils.ts does NOT have a test file
      await worktree.createFile('src/utils.ts', 'export const x = 1');
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Write', { file: 'src/utils.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: true,
        testsPassed: true,
      });

      expect(result.code).toBe(RiskCode.Covered);
      expect(result.reason).toContain('Partial test coverage');
    });
  });

  describe('code with failing tests', () => {
    it('returns risky when tests fail', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: true,
        testsPassed: false,
      });

      expect(result.code).toBe(RiskCode.Risky);
      expect(result.reason).toContain('Tests did not pass');
    });

    it('suggests fixing failing tests', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: true,
        testsPassed: false,
      });

      expect(result.suggestions).toContain('Fix failing tests before committing');
    });
  });

  describe('tests exist but not run', () => {
    it('returns risky when tests exist but did not run', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.code).toBe(RiskCode.Risky);
      expect(result.reason).toContain('Tests did not run');
    });

    it('suggests running tests', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.suggestions).toContain('Run existing tests to verify changes');
    });
  });

  describe('modified files list', () => {
    it('includes modified files in result', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/utils.ts', 'export const x = 1');
      tracker.recordTool('Write', { file: 'src/app.ts' });
      tracker.recordTool('Write', { file: 'src/utils.ts' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.modifiedFiles).toContain('src/app.ts');
      expect(result.modifiedFiles).toContain('src/utils.ts');
    });
  });

  describe('no changes', () => {
    it('returns provable with no modified files', async () => {
      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
      });

      expect(result.code).toBe(RiskCode.Provable);
      expect(result.modifiedFiles).toEqual([]);
    });
  });

  describe('with manual risk factors', () => {
    it('includes manual risk factors passed to assessment', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      tracker.recordTool('Edit', { file: 'README.md' });

      const assessor = new AssessRisk(worktree, tracker);
      const result = await assessor.assess({
        testsRan: false,
        testsPassed: false,
        manualRiskFactors: [{ code: RiskCode.Risky, reason: 'Breaking change to API' }],
      });

      // Automated would be provable (.), but manual factor escalates to risky
      expect(result.code).toBe(RiskCode.Risky);
      expect(result.automated.code).toBe(RiskCode.Provable);
      expect(result.manualFactors).toHaveLength(1);
      expect(result.manualFactors[0].reason).toBe('Breaking change to API');
    });
  });
});
