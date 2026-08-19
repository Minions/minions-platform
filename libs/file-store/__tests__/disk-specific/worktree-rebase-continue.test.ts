/**
 * Disk-specific tests for the rebase-continue primitives
 * (Worktree.hasInProgressRebase / continueRebase) used by
 * MovementManager.promote()/start()/merge() in @minions/movement-branching.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import type { Worktree } from "../../src/port/types.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

useRealGitTimeout(60000);

let templatesRoot: string;
let source: string;

beforeAll(() => {
  templatesRoot = mkdtempSync(join(tmpdir(), "rebase-continue-templates-"));
  const repoPath = join(templatesRoot, "source.git");
  mkdirSync(repoPath);
  execSync("git init --bare -q", { cwd: repoPath });

  const work = join(templatesRoot, "source-work");
  execSync(`git clone -q "${repoPath}" "${work}"`, { cwd: templatesRoot });
  execSync("git checkout -b main -q", { cwd: work });
  writeFileSync(join(work, "shared.txt"), "base\n");
  execSync("git add shared.txt", { cwd: work });
  execSync('git commit -q -m "base"', { cwd: work });
  execSync("git push -q -u origin main", { cwd: work });

  // A trunk branch that conflictingly edits the same line main also edits.
  execSync("git checkout -b experiment/foo -q", { cwd: work });
  writeFileSync(join(work, "shared.txt"), "trunk change\n");
  execSync("git add shared.txt", { cwd: work });
  execSync('git commit -q -m "trunk edits shared.txt"', { cwd: work });
  execSync("git push -q -u origin experiment/foo", { cwd: work });

  execSync("git checkout main -q", { cwd: work });
  writeFileSync(join(work, "shared.txt"), "main change\n");
  execSync("git add shared.txt", { cwd: work });
  execSync('git commit -q -m "main edits shared.txt"', { cwd: work });
  execSync("git push -q -u origin main", { cwd: work });

  source = repoPath;
}, 60000);

afterAll(async () => {
  if (templatesRoot) await rmRetry(templatesRoot);
}, 60000);

describe("Worktree rebase-continue primitives (disk)", () => {
  let tmpDir: string;
  let sandbox: DiskSandbox;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rebase-continue-test-"));
    sandbox = new DiskSandbox(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  });

  async function makeWorktree(name: string, branch: string): Promise<Worktree> {
    const cloneDir = await sandbox.root.createDirectory("clones");
    const repo = await sandbox.cloneBare(source, cloneDir, `${name}.git`);
    // cloneBare only creates a local tracking branch for the remote's default
    // branch (main) — any other branch exists only as refs/remotes/origin/*.
    // Without a local branch, worktreeAdd's "branch doesn't exist locally"
    // fallback would create a brand new branch at HEAD instead of checking
    // out the real remote branch — so create the tracking branch explicitly.
    if (branch !== "main") {
      await repo.updateBranch(branch, `origin/${branch}`);
    }
    const worktreesDir = await sandbox.root.createDirectory("worktrees");
    return repo.createWorktree(worktreesDir, name, branch);
  }

  it("hasInProgressRebase() is false with no rebase underway", async () => {
    const wt = await makeWorktree("clean", "experiment/foo");
    expect(await wt.hasInProgressRebase()).toBe(false);
  });

  it("rebase() onto a conflicting branch leaves a detectable in-progress rebase with conflicted files", async () => {
    const wt = await makeWorktree("conflicted", "experiment/foo");
    const result = await wt.rebase("origin/main");
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictedFiles).toContain("shared.txt");
    }
    expect(await wt.hasInProgressRebase()).toBe(true);
  });

  it("continueRebase() stages the fix and completes the rebase, clearing in-progress state", async () => {
    const wt = await makeWorktree("resolved", "experiment/foo");
    const conflict = await wt.rebase("origin/main");
    expect(conflict.status).toBe("conflict");

    // Simulate the agent fixing the conflicted file in place — no git commands.
    const fileResult = await wt.child("shared.txt");
    expect(fileResult.found).toBe(true);
    if (fileResult.found && fileResult.node.kind === "file") {
      await fileResult.node.write("resolved content\n");
    }

    const result = await wt.continueRebase();
    expect(result.status).toBe("success");
    expect(await wt.hasInProgressRebase()).toBe(false);

    const fileAfter = await wt.child("shared.txt");
    expect(fileAfter.found).toBe(true);
    if (fileAfter.found && fileAfter.node.kind === "file") {
      expect(await fileAfter.node.read()).toBe("resolved content\n");
    }
  });

  it("continueRebase() succeeds when the conflict resolution makes the commit's patch empty", async () => {
    // Resolving the conflict by picking the *target* branch's content makes
    // this commit's patch a no-op once rebased onto that target — git calls
    // this an "empty cherry-pick" and, without --empty=keep, halts the
    // rebase again instead of finishing, indistinguishable from an
    // unresolved conflict via hasInProgressRebase()/git status alone.
    const wt = await makeWorktree("empty-after-resolve", "experiment/foo");
    const conflict = await wt.rebase("origin/main");
    expect(conflict.status).toBe("conflict");

    const fileResult = await wt.child("shared.txt");
    expect(fileResult.found).toBe(true);
    if (fileResult.found && fileResult.node.kind === "file") {
      await fileResult.node.write("main change\n");
    }

    const result = await wt.continueRebase();
    expect(result.status).toBe("success");
    expect(await wt.hasInProgressRebase()).toBe(false);
  });
});
