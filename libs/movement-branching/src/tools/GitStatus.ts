import type { Worktree, WorkArea } from '@minions/file-store';
import { ToolTracker } from '../risk/ToolTracker.js';

/**
 * Result of a git status query
 */
export interface GitStatusResult {
  /** Current branch name */
  branch: string;
  /** Files that have been modified (from tool tracking) */
  modifiedFiles: string[];
  /** Whether the working directory has uncommitted changes */
  isDirty: boolean;
}

/**
 * Queries git status for a worktree.
 *
 * Provides information about the current branch and whether there are
 * uncommitted changes. Modified files are tracked via the ToolTracker.
 *
 * Note: This tool assumes all file modifications happen through tracked
 * tools. It does not query git for untracked files.
 */
export class GitStatus {
  constructor(
    private readonly worktree: Worktree,
    private readonly toolTracker: ToolTracker,
    /**
     * The design doc §4.1 `WorkArea` for `worktree`, mirroring `GitCommit`'s
     * identical optional-`workArea` constructor param. When present,
     * `getStatus()` resolves the current branch/dirty state via
     * `WorkArea.activeMovement()`'s `CheckedOutMovement` (`.branch`/
     * `.isDirty()`) instead of the raw `Worktree.currentBranch()`/`.isDirty()`
     * calls — `activeMovement()` works for ANY currently-checked-out branch,
     * not just movement-shaped ones (see `SiteWorkArea.activeMovement()`), so
     * this is a safe substitution regardless of what's checked out. Optional,
     * not required, for the same reason `GitCommit`'s is: not every legitimate
     * caller has a wing-shaped `WorkArea` to give it. Falls back to the raw
     * calls unchanged when absent.
     */
    private readonly workArea?: WorkArea,
  ) {}

  /**
   * Get the current git status
   */
  async getStatus(): Promise<GitStatusResult> {
    const movement = this.workArea ? await this.workArea.activeMovement() : undefined;
    const branch = movement ? movement.branch : await this.worktree.currentBranch();
    const isDirty = movement ? await movement.isDirty() : await this.worktree.isDirty();
    const modifiedFiles = this.toolTracker.getEditedFiles();

    return {
      branch,
      modifiedFiles,
      isDirty,
    };
  }
}
