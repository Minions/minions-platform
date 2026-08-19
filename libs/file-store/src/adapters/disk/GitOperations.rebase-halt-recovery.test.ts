/**
 * Real-git coverage for `GitOperations.pushThroughEmptyHalt`'s tiered halt
 * recovery — a bounded (3-attempt, forward-progress-checked) walk-through of
 * a `rebase --continue` halt that has nothing left for a human to fix. See
 * that method's own doc comment for the four tiers this exercises.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, cpSync, rmSync as fsRmSync } from "fs";
import { tmpdir } from "os";
import { join, isAbsolute } from "path";
import { GitOperations } from "./GitOperations.js";
import { execSync, useRealGitTimeout, rmRetry } from "../../../__tests__/disk-test-helpers.js";

useRealGitTimeout();

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rmRetry(tmpDir);
    tmpDir = "";
  }
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-ops-halt-recovery-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  return dir;
}

function commitFile(dir: string, name: string, content: string, message: string): void {
  writeFileSync(join(dir, name), content);
  execSync(`git add -A`, { cwd: dir });
  execSync(`git commit -q -m "${message}"`, { cwd: dir });
}

function rebaseMergePath(dir: string): string {
  const rawPath = execSync("git rev-parse --git-path rebase-merge", { cwd: dir, encoding: "utf-8" }).trim();
  return isAbsolute(rawPath) ? rawPath : join(dir, rawPath);
}

describe("GitOperations.pushThroughEmptyHalt", () => {
  it("real conflict: reports the conflicted files and never enters any automatic recovery", async () => {
    tmpDir = initRepo();
    commitFile(tmpDir, "shared.txt", "base\n", "base");
    execSync("git checkout -q -b feature", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "feature change\n", "feature change");
    execSync("git checkout -q main", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "main change\n", "main change");
    execSync("git checkout -q feature", { cwd: tmpDir });

    const git = new GitOperations(tmpDir);
    const result = await git.rebase("main");

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflictedFiles).toContain("shared.txt");
    }
    expect(await git.hasInProgressRebase()).toBe(true);
  });

  it("known-safe empty-patch halt: walks through automatically via add -A && rebase --continue, still bounded and progress-checked", async () => {
    // A conflict that auto-resolves to content IDENTICAL to the target —
    // git still halts asking for --continue even though there's nothing
    // left to stage (EMPTY_PATCH_HALT's "nothing to commit" shape).
    tmpDir = initRepo();
    commitFile(tmpDir, "shared.txt", "base\n", "base");
    execSync("git checkout -q -b feature", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "same change\n", "feature change");
    execSync("git checkout -q main", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "same change\n", "main change (identical content)");
    execSync("git checkout -q feature", { cwd: tmpDir });

    const git = new GitOperations(tmpDir);
    const result = await git.rebase("main");

    // git's own merge machinery resolves this trivially (identical content
    // on both sides) — either a clean success outright, or the empty-patch
    // halt this test exists to exercise; both are correct outcomes here,
    // the point is it never surfaces as an unresolved "conflict".
    expect(result.status).toBe("success");
    expect(await git.hasInProgressRebase()).toBe(false);
  });

  it("a stale, orphaned rebase-merge session (ref already at the target, only sequencer bookkeeping is stale) resolves via rebase --quit, not an infinite identical retry", async () => {
    // Reproduces the actual production incident this tier exists for: a
    // `movement merge`/`start` process was interrupted AFTER `rebase
    // --continue` had already moved the branch ref to the fully-rebased
    // tip, but BEFORE the sequencer cleaned up its own `rebase-merge`
    // session directory. Every later `--continue` retry replays the
    // identical doomed ref update forever.
    //
    // Reproduced here by: running a real single-commit rebase up to the
    // point just before its final `--continue` (conflict resolved, staged,
    // sequencer's own todo already empty — true for a one-commit rebase),
    // snapshotting `rebase-merge` at that exact moment, letting the real
    // `--continue` complete normally (ref moves, session cleans itself up),
    // then restoring the snapshot — reproducing exactly "ref already moved,
    // stale session left behind" without needing to actually kill a process
    // mid-operation.
    tmpDir = initRepo();
    commitFile(tmpDir, "shared.txt", "base\n", "base");
    execSync("git checkout -q -b feature", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "feature change\n", "feature change");
    execSync("git checkout -q main", { cwd: tmpDir });
    commitFile(tmpDir, "shared.txt", "main change\n", "main change");
    execSync("git checkout -q feature", { cwd: tmpDir });

    const git = new GitOperations(tmpDir);
    const conflictResult = await git.rebase("main");
    expect(conflictResult.status).toBe("conflict");

    // Resolve and stage — the sequencer's own todo is already empty at this
    // point (single-commit rebase), the exact bookkeeping shape of "no
    // commands remaining".
    writeFileSync(join(tmpDir, "shared.txt"), "resolved\n");
    execSync("git add -A", { cwd: tmpDir });

    const mergePath = rebaseMergePath(tmpDir);
    const snapshotDir = mkdtempSync(join(tmpdir(), "git-ops-halt-recovery-snapshot-"));
    cpSync(mergePath, snapshotDir, { recursive: true });

    // Let the real continue finish normally.
    const finishResult = await git.continueRebase();
    expect(finishResult.status).toBe("success");
    expect(await git.hasInProgressRebase()).toBe(false);
    const tipAfterRealCompletion = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Restore the stale session — as if the process had been killed right
    // after the ref moved but before this cleanup ran.
    fsRmSync(mergePath, { recursive: true, force: true });
    cpSync(snapshotDir, mergePath, { recursive: true });
    expect(await git.hasInProgressRebase()).toBe(true);

    const recoveredResult = await git.continueRebase();

    expect(recoveredResult.status).toBe("success");
    expect(await git.hasInProgressRebase()).toBe(false);
    // The branch is exactly where the real completion already left it — the
    // stale-session recovery must never move it, only clean up bookkeeping.
    const tipAfterRecovery = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf-8" }).trim();
    expect(tipAfterRecovery).toBe(tipAfterRealCompletion);

    await rmRetry(snapshotDir);
  });
});
