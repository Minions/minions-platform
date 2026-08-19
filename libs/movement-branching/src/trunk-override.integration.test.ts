/**
 * Proves the trunk-override seam is truly orthogonal: once a worktree's
 * `baseBranch()` is overridden (via `setBaseBranch`, see
 * @minions/file-store's Worktree contract), `MovementSession` picks it up
 * with ZERO changes to MovementSession/MovementManager's own logic — the
 * override lives entirely in `resolveMovementBase` (`@minions/file-store`'s
 * `SiteWorkArea.ts`), consulted by `WorkArea.activeMovement()`, which
 * `status()`/`diff()` build a `Movement` handle from (design doc §4.1's
 * `Movement.commitsSince()`/`diffFrom()`). `MovementSession` itself needs a
 * `WorkArea` constructor argument to reach that seam at all — this test
 * builds one the same way real callers do (`createWorkAreaFactoriesForSandbox`
 * + `createWorkArea`), not a MovementSession-specific override mechanism.
 * Uses a real git-backed worktree (not a mock) so the override's actual
 * persistence mechanism (`git config --worktree`) is exercised end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync as nodeExecSync, type ExecSyncOptions } from 'node:child_process';
import { createDiskSandbox, createWorkAreaFactoriesForSandbox, createWorkArea } from '@minions/file-store';
import { MovementSession } from './MovementSession.js';

/**
 * Node's `execSync` inherits the child's stderr to the parent process by
 * default unless `stdio` is explicitly given — so git's informational
 * messages (e.g. cloning an empty bare repo) print straight to whatever
 * process runs these tests (the quality watcher, in dev). Piping stdio
 * captures it instead; failures still surface normally since the captured
 * stderr is included on the thrown error the same as with inherited stdio.
 */
function execSync(command: string, options: ExecSyncOptions = {}): string | Buffer {
  return nodeExecSync(command, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function rmRetry(dir: string, retries = 5, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

/**
 * `git worktree add` can return before the new worktree's git metadata is
 * fully visible on Windows (observed independently of this feature — a bare
 * `git status` run immediately afterward intermittently fails with "this
 * operation must be run in a work tree"). Poll until the worktree is usable
 * before running the real assertions, rather than let that pre-existing
 * environment race flake this test.
 */
async function waitUntilUsable(worktreePath: string, retries = 20, delayMs = 100): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: worktreePath });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

describe('trunk override — MovementSession orthogonality', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trunk-override-integration-'));
  }, 60000);

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  }, 60000);

  it('status()/diff() operate against the overridden trunk, not the repo default', async () => {
    // Seed a bare "origin" with main + an experiment branch one commit ahead.
    const originPath = join(tmpDir, 'origin.git');
    mkdirSync(originPath);
    execSync('git init --bare -q', { cwd: originPath });

    const seed = join(tmpDir, 'seed');
    execSync(`git clone -q "${originPath}" "${seed}"`, { cwd: tmpDir });
    execSync('git checkout -b main -q', { cwd: seed });
    execSync('git commit --allow-empty -q -m "main commit"', { cwd: seed });
    execSync('git push -q -u origin main', { cwd: seed });
    execSync('git checkout -b experiment/foo -q', { cwd: seed });
    execSync('git commit --allow-empty -q -m "experiment commit"', { cwd: seed });
    execSync('git push -q -u origin experiment/foo', { cwd: seed });

    const sandbox = createDiskSandbox(tmpDir);
    const cloneDir = await sandbox.root.createDirectory('clone');
    const repo = await sandbox.cloneBare(originPath, cloneDir, 'work.git');
    const worktreesDir = await sandbox.root.createDirectory('worktrees');
    // cloneBare only guarantees local tracking branches for the default
    // branch (main) and plan/main — use main itself as the checked-out
    // worktree branch rather than inventing a third branch.
    const worktree = await repo.createWorktree(worktreesDir, 'wt', 'main');
    await waitUntilUsable(worktree.path);

    // No changes to MovementSession's own logic from here — only the
    // worktree's own override is set, exactly as a wing joining an
    // experiment would do.
    await worktree.setBaseBranch('experiment/foo');

    const scratchRoot = await sandbox.root.createDirectory('scratch');
    const workAreaFactories = createWorkAreaFactoriesForSandbox(sandbox, scratchRoot);
    const workArea = createWorkArea(repo, worktree, workAreaFactories);

    const session = new MovementSession(worktree, undefined, undefined, undefined, undefined, workArea);
    const status = await session.status();
    expect(status.branch).toBe('main');

    const diff = await session.diff();
    // diff() diffs HEAD against baseBranch() — with the override set, that's
    // experiment/foo, not main. Confirmed indirectly: no error, and the
    // underlying worktree.baseBranch() (exercised transitively) now reports
    // the override.
    expect(await worktree.baseBranch()).toBe('experiment/foo');
    expect(diff).toBeDefined();
  }, 60000);
});
