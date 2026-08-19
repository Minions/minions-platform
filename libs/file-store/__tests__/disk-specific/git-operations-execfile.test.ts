/**
 * Disk-specific tests locking in the `execFile`-based transport in
 * `GitOperations`. `execFile` passes args as an array straight to the `git`
 * process with no shell involved, so a value containing a single quote (a
 * character git ref names legally allow, and a valid filename character
 * since loose refs are stored as files) is never shell-special and never
 * misinterpreted.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import { useRealGitTimeout, rmRetry } from "../disk-test-helpers.js";

useRealGitTimeout();

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rmRetry(tmpDir);
  }
});

describe("GitOperations execFile transport (disk)", () => {
  it("creates and force-resets a branch whose name contains an embedded single quote", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-execfile-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const worktree = await repo.createWorktree(sandbox.root, "main-wt", "main");
    await worktree.createFile("seed.txt", "seed");
    await worktree.commitAll("seed commit");

    const weirdName = "weird'branch";
    await repo.createBranchIfMissing(weirdName, "main");
    expect(await repo.branches()).toContain(weirdName);

    await worktree.createFile("more.txt", "more");
    await worktree.commitAll("second commit");

    await repo.updateBranch(weirdName, "main");
    const wt = await repo.createWorktree(sandbox.root, "weird-wt", weirdName);
    const child = await wt.child("more.txt");
    expect(child.found).toBe(true);
  });

  it("commits and reads back a message containing shell metacharacters without shell interpretation", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-execfile-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const worktree = await repo.createWorktree(sandbox.root, "main-wt", "main");
    await worktree.createFile("seed.txt", "seed");
    const seedHash = await worktree.commitAll("seed commit");

    const message = "commit with `backticks` and $(parens) in message";
    await worktree.createFile("data.txt", "line one\nline two");
    await worktree.commitAll(message);

    const log = await worktree.log(seedHash, "HEAD");
    expect(log).toHaveLength(1);
    expect(log[0].subject).toBe(message);
  });
});
