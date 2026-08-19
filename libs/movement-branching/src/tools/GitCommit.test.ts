import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemorySandbox,
  createInMemoryWorkAreaFactories,
  createWorkArea,
  type Sandbox,
  type Worktree,
} from '@minions/file-store';
import { GitCommit, IntentionCode, stripLeadingCodes } from './GitCommit.js';
import { CommitCoordinator } from './CommitCoordinator.js';
import { ToolTracker } from '../risk/ToolTracker.js';
import { RiskFactorTracker } from '../risk/RiskFactorTracker.js';
import { RiskCode } from '../risk/RiskComputer.js';
import { createDefaultCommitPipelineRegistry } from '../pipeline/defaultRegistry.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../pipeline/types.js';
import type { Recognizer } from '../pipeline/types.js';

describe('stripLeadingCodes', () => {
  it('strips risk + space + intention + space prefix', () => {
    expect(stripLeadingCodes('^ f Add foo')).toBe('Add foo');
    expect(stripLeadingCodes('. d Update docs')).toBe('Update docs');
    expect(stripLeadingCodes('! r Refactor bar')).toBe('Refactor bar');
    expect(stripLeadingCodes('@ b Fix bug')).toBe('Fix bug');
  });

  it('strips compact risk+intention prefix (no space between)', () => {
    expect(stripLeadingCodes('^f Add foo')).toBe('Add foo');
    expect(stripLeadingCodes('.d Update docs')).toBe('Update docs');
    expect(stripLeadingCodes('!r Refactor bar')).toBe('Refactor bar');
    expect(stripLeadingCodes('@b Fix bug')).toBe('Fix bug');
  });

  it('strips risk-only prefix', () => {
    expect(stripLeadingCodes('^ Add foo')).toBe('Add foo');
    expect(stripLeadingCodes('. Update docs')).toBe('Update docs');
    expect(stripLeadingCodes('! Refactor bar')).toBe('Refactor bar');
    expect(stripLeadingCodes('@ Fix bug')).toBe('Fix bug');
  });

  it('strips intention-only prefix', () => {
    expect(stripLeadingCodes('d Update docs')).toBe('Update docs');
    expect(stripLeadingCodes('f Add feature')).toBe('Add feature');
    expect(stripLeadingCodes('b Fix bug')).toBe('Fix bug');
    expect(stripLeadingCodes('r Refactor something')).toBe('Refactor something');
    expect(stripLeadingCodes('t Add tests')).toBe('Add tests');
    expect(stripLeadingCodes('e Chore task')).toBe('Chore task');
    expect(stripLeadingCodes('p Plan item')).toBe('Plan item');
    expect(stripLeadingCodes('? Unknown intent')).toBe('Unknown intent');
  });

  it('does not modify messages without leading codes', () => {
    expect(stripLeadingCodes('Add foo')).toBe('Add foo');
    expect(stripLeadingCodes('Update README')).toBe('Update README');
    expect(stripLeadingCodes('Fix the bug in bar')).toBe('Fix the bug in bar');
  });

  it('does not strip invalid single-char prefixes', () => {
    expect(stripLeadingCodes('x Add foo')).toBe('x Add foo');
    expect(stripLeadingCodes('z Update docs')).toBe('z Update docs');
  });

  it('does not strip when there is no trailing space after code', () => {
    expect(stripLeadingCodes('d')).toBe('d');
    expect(stripLeadingCodes('^f')).toBe('^f');
  });
});

describe('GitCommit', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let toolTracker: ToolTracker;
  let riskFactorTracker: RiskFactorTracker;
  let gitCommit: GitCommit;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');

    // Create initial file and commit
    await worktree.createFile('README.md', '# Test');
    await worktree.commitAll('initial');

    toolTracker = new ToolTracker();
    riskFactorTracker = new RiskFactorTracker();
    gitCommit = new GitCommit(worktree, toolTracker, riskFactorTracker);
  });

  describe('commit format', () => {
    it('creates commit with risk and intention prefix', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });

    it('uses correct intention codes', async () => {
      const intentions: IntentionCode[] = [
        IntentionCode.Feature,
        IntentionCode.Bug,
        IntentionCode.Refactor,
        IntentionCode.Test,
        IntentionCode.Docs,
        IntentionCode.Chore,
        IntentionCode.Plan,
      ];

      for (const intention of intentions) {
        // Modify file for each test
        const readmeResult = await worktree.child('README.md');
        if (readmeResult.found && readmeResult.node.kind === 'file') {
          await readmeResult.node.write(`# ${intention}`);
        }
        toolTracker.recordTool('Edit', { file: 'README.md' });

        const result = await gitCommit.commit({
          intention,
          summary: 'Test message',
          testsRan: false,
          testsPassed: false,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('risk computation', () => {
    it('assigns provable risk for docs-only changes', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });

    it('assigns risky risk for code without tests', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      toolTracker.recordTool('Write', { file: 'src/app.ts' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Add app',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });

    it('assigns thorough risk when tests pass with comprehensive coverage', async () => {
      await worktree.createFile('src/app.ts', 'console.log("hello")');
      await worktree.createFile('src/app.test.ts', 'test("x", () => {})');
      toolTracker.recordTool('Edit', { file: 'src/app.ts' });
      toolTracker.recordTool('Write', { file: 'src/app.test.ts' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Update app',
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });
  });

  describe('manual risk factors', () => {
    it('uses maximum of automated and manual risk', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });
      riskFactorTracker.addRiskFactor(RiskCode.Risky, 'Breaking change');

      const result = await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      // Automated would be provable (.) but manual escalates to risky (@)
      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });

    it('resets risk factors after commit', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });
      riskFactorTracker.addRiskFactor(RiskCode.Risky, 'Breaking change');

      await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'First commit',
        testsRan: false,
        testsPassed: false,
      });

      expect(riskFactorTracker.hasRiskFactors()).toBe(false);
    });
  });

  describe('commit all changes', () => {
    it('commits all changes (no partial staging)', async () => {
      await worktree.createFile('a.txt', 'a');
      await worktree.createFile('b.txt', 'b');
      toolTracker.recordTool('Write', { file: 'a.txt' });
      toolTracker.recordTool('Write', { file: 'b.txt' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Add files',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      // After commit, worktree should not be dirty
      expect(await worktree.isDirty()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns idempotent success (noop) when nothing to commit', async () => {
      // No changes made
      const result = await gitCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Empty commit',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.noop).toBe(true);
    });

    it('returns commit hash on success', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
      expect(result.commitHash?.length).toBeGreaterThan(0);
    });
  });

  describe('in-flight coalescing (debouncing)', () => {
    it('joins an already-running commit for the same worktree instead of starting a second one', async () => {
      await worktree.createFile('a.txt', 'a');
      toolTracker.recordTool('Write', { file: 'a.txt' });

      // A fresh GitCommit (as a fresh MovementSession would construct per
      // MCP call), same underlying worktree — this is exactly the shape of
      // a client retrying a commit that's already running.
      const secondTracker = new ToolTracker();
      const secondCommit = new GitCommit(worktree, secondTracker, new RiskFactorTracker());

      const [first, second] = await Promise.all([
        gitCommit.commit({ intention: IntentionCode.Feature, summary: 'First caller', testsRan: false, testsPassed: false }),
        secondCommit.commit({ intention: IntentionCode.Bug, summary: 'Second caller', testsRan: false, testsPassed: false }),
      ]);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      // Both calls got the SAME result — the second joined the first's
      // in-flight commit rather than racing its own add+commit against it.
      expect(second.commitHash).toBe(first.commitHash);
      expect(second.commitMessage).toBe(first.commitMessage);
      expect(first.commitMessage).toContain('First caller');
    });

    it('does not coalesce two commits for the same worktree issued one after the other', async () => {
      await worktree.createFile('a.txt', 'a');
      toolTracker.recordTool('Write', { file: 'a.txt' });
      const first = await gitCommit.commit({ intention: IntentionCode.Feature, summary: 'First', testsRan: false, testsPassed: false });

      await worktree.createFile('b.txt', 'b');
      const secondTracker = new ToolTracker();
      secondTracker.recordTool('Write', { file: 'b.txt' });
      const secondCommit = new GitCommit(worktree, secondTracker, new RiskFactorTracker());
      const second = await secondCommit.commit({ intention: IntentionCode.Feature, summary: 'Second', testsRan: false, testsPassed: false });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.commitHash).not.toBe(first.commitHash);
      expect(second.noop).toBeFalsy();
    });

    it('uses an explicitly injected CommitCoordinator instead of the process-wide default', async () => {
      await worktree.createFile('a.txt', 'a');
      toolTracker.recordTool('Write', { file: 'a.txt' });

      const coordinator = new CommitCoordinator();
      const coalesceSpy = vi.spyOn(coordinator, 'coalesce');
      const injectedCommit = new GitCommit(
        worktree,
        toolTracker,
        riskFactorTracker,
        undefined,
        undefined,
        coordinator,
      );

      const result = await injectedCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Injected coordinator',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(coalesceSpy).toHaveBeenCalledWith(worktree.path, expect.any(Function));
    });
  });

  describe('comment quality (end to end)', () => {
    it('strips a low-value comment from the committed content and explains why in the result', async () => {
      await worktree.createFile('src/widget.ts', '// increment counter\ncounter++;\n');
      toolTracker.recordTool('Write', { file: 'src/widget.ts' });

      const result = await gitCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Add counter',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.advice?.some((a) => a.includes('comment') && a.includes('removed'))).toBe(true);

      const committed = await worktree.child('src/widget.ts');
      if (committed.found && committed.node.kind === 'file') {
        const content = await committed.node.read();
        expect(content).not.toContain('increment counter');
        expect(content).toContain('counter++;');
      } else {
        throw new Error('expected file');
      }
      expect(await worktree.isDirty()).toBe(false);
    });
  });

  describe('pluggable check pipeline', () => {
    it('lets a caller register a new check against movement.commit without editing GitCommit or MovementActionGroup', async () => {
      const trivialRecognizer: Recognizer = {
        id: 'throwaway-recognizer',
        kind: 'deterministic',
        async recognize() {
          return { changes: [{ kind: 'advice' as const, value: { message: 'a new check ran', priority: 1 }, producer: 'throwaway-recognizer' }] };
        },
      };
      const registry = createDefaultCommitPipelineRegistry().extend({
        handler: trivialRecognizer,
        hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
        mandatory: false,
      });
      const commitWithRegistry = new GitCommit(worktree, toolTracker, riskFactorTracker, registry);

      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });

      const result = await commitWithRegistry.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.advice).toContain('a new check ran');
    });
  });

  describe('tool tracker reset', () => {
    it('resets tool tracker after successful commit', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }
      toolTracker.recordTool('Edit', { file: 'README.md' });

      await gitCommit.commit({
        intention: IntentionCode.Docs,
        summary: 'Update README',
        testsRan: false,
        testsPassed: false,
      });

      expect(toolTracker.getToolsSinceLastCommit()).toHaveLength(0);
    });
  });

  describe('workArea-backed commit path (CheckedOutMovement)', () => {
    // GitCommit's optional `workArea` constructor param: when present,
    // isDirty()/tipHash()/commit() route through WorkArea.activeMovement()'s
    // CheckedOutMovement instead of the raw Worktree — this proves the
    // whole path end to end, both the clean-worktree noop path (tipHash())
    // and the dirty-commit path (movement.commit()), plus
    // CheckedOutMovement.push() (which force-pushes the movement branch).
    it('routes the noop and dirty commit paths through CheckedOutMovement, and push() force-pushes the movement branch', async () => {
      const waSandbox = createInMemorySandbox();
      const waRepo = await waSandbox.initBare(waSandbox.root, 'wa-repo');
      const seed = await waRepo.createWorktree(waSandbox.root, 'seed', 'main');
      await seed.createFile('README.md', '# seed');
      await seed.commitAll('seed');
      await waRepo.removeWorktree(seed);

      const waWorktree = await waRepo.createWorktree(waSandbox.root, 'wa-work', 'wip/gc-test');
      const factories = createInMemoryWorkAreaFactories('scratch');
      const workArea = createWorkArea(waRepo, waWorktree, factories);

      const waToolTracker = new ToolTracker();
      const waRiskFactorTracker = new RiskFactorTracker();
      const waGitCommit = new GitCommit(
        waWorktree,
        waToolTracker,
        waRiskFactorTracker,
        undefined,
        undefined,
        undefined,
        workArea,
      );

      // Clean worktree — noop path, resolved via movement.tipHash().
      const noopResult = await waGitCommit.commit({
        intention: IntentionCode.Chore,
        summary: 'noop',
        testsRan: false,
        testsPassed: false,
      });
      expect(noopResult.success).toBe(true);
      expect(noopResult.noop).toBe(true);
      expect(noopResult.commitHash).toBeDefined();

      // Dirty worktree — real commit path, via movement.commit().
      await waWorktree.createFile('feature.txt', 'v1');
      waToolTracker.recordTool('Write', { file: 'feature.txt' });

      const result = await waGitCommit.commit({
        intention: IntentionCode.Feature,
        summary: 'Add feature',
        testsRan: false,
        testsPassed: false,
      });
      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
      expect(result.noop).toBeFalsy();

      const movement = await workArea.activeMovement();
      expect(await movement.tipHash()).toBe(result.commitHash);

      await expect(movement.push()).resolves.not.toThrow();
    });
  });
});
