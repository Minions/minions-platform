/**
 * Regression test: `clearMovementBase` must clear BOTH the repo-level
 * `movement.<branch>.base` mechanism AND the `--worktree`-scoped
 * `minions.trunk-branch` mechanism, because `resolveMovementBase`'s fallback
 * chain reads the worktree-scoped key whenever the repo-level one is absent
 * — clearing only the repo-level key silently "resurrects" a stale
 * worktree-scoped value on the next read.
 *
 * Uses a real git-backed worktree (not the InMemory adapter, and not a mock)
 * so the actual persistence mechanisms (`git config` vs. `git config
 * --worktree`) are exercised end to end. See
 * `trunk-override.integration.test.ts` (`@minions/movement-branching`) for
 * the sibling test this borrows its real-git setup pattern from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync as nodeExecSync, type ExecSyncOptions } from 'node:child_process';
import { createDiskSandbox } from '../index.js';
import { resolveMovementBase, clearMovementBase } from './SiteWorkArea.js';

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

/** See `trunk-override.integration.test.ts`'s identical helper's doc comment
 *  for why this polling is needed on Windows. */
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

describe('clearMovementBase — real git', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clear-movement-base-integration-'));
  }, 60000);

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  }, 60000);

  it('clears an already-provisioned wing\'s worktree-scoped override, not just the repo-level one on top of it', async () => {
    // Seed a bare "origin" with main + two experiment branches.
    const originPath = join(tmpDir, 'origin.git');
    mkdirSync(originPath);
    execSync('git init --bare -q', { cwd: originPath });

    const seed = join(tmpDir, 'seed');
    execSync(`git clone -q "${originPath}" "${seed}"`, { cwd: tmpDir });
    execSync('git checkout -b main -q', { cwd: seed });
    execSync('git commit --allow-empty -q -m "main commit"', { cwd: seed });
    execSync('git push -q -u origin main', { cwd: seed });
    execSync('git checkout -b experiment/exp1/a -q', { cwd: seed });
    execSync('git commit --allow-empty -q -m "exp1/a commit"', { cwd: seed });
    execSync('git push -q -u origin experiment/exp1/a', { cwd: seed });
    execSync('git checkout -b experiment/exp2/b -q', { cwd: seed });
    execSync('git commit --allow-empty -q -m "exp2/b commit"', { cwd: seed });
    execSync('git push -q -u origin experiment/exp2/b', { cwd: seed });

    const sandbox = createDiskSandbox(tmpDir);
    const cloneDir = await sandbox.root.createDirectory('clone');
    const repo = await sandbox.cloneBare(originPath, cloneDir, 'work.git');
    const worktreesDir = await sandbox.root.createDirectory('worktrees');
    const worktree = await repo.createWorktree(worktreesDir, 'wt', 'main');
    await waitUntilUsable(worktree.path);

    // Step 1: simulate an already-provisioned wing whose override was only
    // ever recorded via the `--worktree`-scoped mechanism.
    await worktree.setBaseBranch('experiment/exp1/a');
    expect(await resolveMovementBase(repo, worktree)).toBe('experiment/exp1/a');

    // Step 2: simulate `beginNewActiveMovement` retargeting — it writes the
    // repo-level mechanism on top, without ever clearing the
    // `--worktree`-scoped one (see `SiteWorkArea.ts`'s
    // `beginNewActiveMovement` doc comment).
    await repo.setMovementBase('main', 'experiment/exp2/b');
    expect(await resolveMovementBase(repo, worktree)).toBe('experiment/exp2/b');

    // Step 3: clear. A subsequent read must land on the sane remote-default
    // ("main"), NOT resurrect the stale worktree-scoped value
    // ("experiment/exp1/a") that a clear touching only the repo-level key
    // would leave behind.
    await clearMovementBase(worktree);

    expect(await resolveMovementBase(repo, worktree)).toBe('main');
    // Confirm both underlying mechanisms are actually gone, not just that
    // the fallback chain happens to skip over a residual value.
    expect(await repo.getMovementBase('main')).toBeNull();
    expect(await worktree.baseBranch()).toBe('main');
  }, 60000);
});
