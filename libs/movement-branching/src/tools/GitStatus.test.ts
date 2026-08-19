import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemorySandbox,
  createInMemoryWorkAreaFactories,
  createWorkArea,
  type Sandbox,
  type Worktree,
} from '@minions/file-store';
import { GitStatus } from './GitStatus.js';
import { ToolTracker } from '../risk/ToolTracker.js';

describe('GitStatus', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let toolTracker: ToolTracker;
  let gitStatus: GitStatus;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');

    // Create initial commit
    await worktree.createFile('README.md', '# Test');
    await worktree.commitAll('initial');

    toolTracker = new ToolTracker();
    gitStatus = new GitStatus(worktree, toolTracker);
  });

  describe('branch info', () => {
    it('returns current branch name', async () => {
      const status = await gitStatus.getStatus();
      expect(status.branch).toBe('main');
    });

    it('returns branch name after switch', async () => {
      await worktree.switchBranch('feature');
      const status = await gitStatus.getStatus();
      expect(status.branch).toBe('feature');
    });
  });

  describe('dirty state', () => {
    it('reports clean when no changes', async () => {
      const status = await gitStatus.getStatus();
      expect(status.isDirty).toBe(false);
    });

    it('reports dirty when files are modified', async () => {
      const readmeResult = await worktree.child('README.md');
      if (readmeResult.found && readmeResult.node.kind === 'file') {
        await readmeResult.node.write('# Updated');
      }

      const status = await gitStatus.getStatus();
      expect(status.isDirty).toBe(true);
    });

    it('reports dirty when new files are added', async () => {
      await worktree.createFile('new.txt', 'content');

      const status = await gitStatus.getStatus();
      expect(status.isDirty).toBe(true);
    });
  });

  describe('modified files tracking', () => {
    it('returns empty list when no edits recorded', async () => {
      const status = await gitStatus.getStatus();
      expect(status.modifiedFiles).toHaveLength(0);
    });

    it('returns edited files from tool tracker', async () => {
      toolTracker.recordTool('Edit', { file: 'README.md' });
      toolTracker.recordTool('Write', { file: 'new.txt' });

      const status = await gitStatus.getStatus();
      expect(status.modifiedFiles).toContain('README.md');
      expect(status.modifiedFiles).toContain('new.txt');
    });

    it('deduplicates multiple edits to same file', async () => {
      toolTracker.recordTool('Edit', { file: 'README.md' });
      toolTracker.recordTool('Edit', { file: 'README.md' });
      toolTracker.recordTool('Edit', { file: 'README.md' });

      const status = await gitStatus.getStatus();
      expect(status.modifiedFiles.filter(f => f === 'README.md')).toHaveLength(1);
    });
  });

  describe('workArea-backed status (CheckedOutMovement)', () => {
    // GitStatus's optional `workArea` constructor param: when present,
    // branch/isDirty route through WorkArea.activeMovement()'s
    // CheckedOutMovement (`.branch`/`.isDirty()`) instead of calling
    // `Worktree.currentBranch()`/`.isDirty()` directly. Proven by asserting
    // `WorkArea.activeMovement()` itself gets called (the delegation), not by
    // asserting the raw `Worktree` calls are never reached at all —
    // `CheckedOutMovement.branch`/`.isDirty()`'s OWN implementation
    // legitimately still resolves through the raw worktree underneath;
    // `GitStatus` itself just never calls it directly.
    it('resolves branch and isDirty by delegating to the CheckedOutMovement handle', async () => {
      const workArea = createWorkArea(worktree.repository, worktree, createInMemoryWorkAreaFactories());
      const activeMovementSpy = vi.spyOn(workArea, 'activeMovement');
      const withWorkArea = new GitStatus(worktree, toolTracker, workArea);

      const status = await withWorkArea.getStatus();

      expect(status.branch).toBe('main');
      expect(status.isDirty).toBe(false);
      expect(activeMovementSpy).toHaveBeenCalledTimes(1);
    });

    it('still reports dirty state correctly when workArea-backed', async () => {
      const workArea = createWorkArea(worktree.repository, worktree, createInMemoryWorkAreaFactories());
      await worktree.createFile('new.txt', 'content');
      const withWorkArea = new GitStatus(worktree, toolTracker, workArea);

      const status = await withWorkArea.getStatus();

      expect(status.isDirty).toBe(true);
    });

    it('falls back to the raw Worktree calls when no workArea is supplied', async () => {
      const currentBranchSpy = vi.spyOn(worktree, 'currentBranch');
      const isDirtySpy = vi.spyOn(worktree, 'isDirty');

      await gitStatus.getStatus();

      expect(currentBranchSpy).toHaveBeenCalled();
      expect(isDirtySpy).toHaveBeenCalled();
    });
  });
});
