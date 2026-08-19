/**
 * Disk-specific tests for bare repository discovery and clone behavior.
 *
 * These tests verify behaviors that are specific to the disk implementation:
 * 1. Discovering existing bare repos reads the remote URL from git config
 * 2. Cloning bare repos configures the fetch refspec for remote tracking
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import type { BareRepository } from "../../src/port/types.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

// Real disk/git-backed: every test shells out to git. Needs more headroom
// than the package's fast default.
useRealGitTimeout();

/**
 * Shared source-repo templates, built once for the whole file rather than
 * per test. `cloneBare()` only ever creates local tracking heads for the
 * remote's default branch and `plan/main` (see GitOperations.cloneBare) — so
 * every other branch on these templates stays remote-tracking-only and is
 * safe to reuse across tests that assert different things about the clone
 * result. Templates are read-only from every test's perspective (clone and
 * fetch never write back into the source), so no per-test copy is needed —
 * only clone/normalize *destinations* need per-test isolation, and those
 * already live in the per-test tmpDir.
 */
let templatesRoot: string;
/** main (1 commit) + plan/main + feature-x + diverged. */
let richSource: string;
/** main (1 commit) + feature-y (no plan/main). */
let plainSource: string;

function makeBareWithBranches(root: string, name: string, branches: string[]): string {
  const repoPath = join(root, name);
  mkdirSync(repoPath);
  execSync("git init --bare -q", { cwd: repoPath });

  const work = join(root, `${name}-work`);
  execSync(`git clone -q "${repoPath}" "${work}"`, { cwd: root });
  execSync("git checkout -b main -q", { cwd: work });
  execSync('git commit --allow-empty -q -m "Initial commit"', { cwd: work });
  execSync("git push -q -u origin main", { cwd: work });

  for (const branch of branches) {
    execSync(`git checkout -b "${branch}" -q`, { cwd: work });
    execSync(`git commit --allow-empty -q -m "${branch} commit"`, { cwd: work });
    execSync(`git push -q -u origin "${branch}"`, { cwd: work });
  }

  return repoPath;
}

beforeAll(() => {
  templatesRoot = mkdtempSync(join(tmpdir(), "bare-repo-templates-"));
  richSource = makeBareWithBranches(templatesRoot, "rich-source.git", ["feature-x", "plan/main", "diverged"]);
  plainSource = makeBareWithBranches(templatesRoot, "plain-source.git", ["feature-y"]);
});

afterAll(async () => {
  if (templatesRoot) {
    await rmRetry(templatesRoot);
  }
});

describe("Disk bare repository discovery", () => {
  let tmpDir: string;
  let sandbox: DiskSandbox;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bare-repo-test-"));
    sandbox = new DiskSandbox(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await rmRetry(tmpDir);
    }
  });

  describe("Remote URL discovery", () => {
    it("child() reads remote URL from bare repo config", async () => {
      // Manually create a bare repo with a remote configured
      const repoPath = join(tmpDir, "test.git");
      mkdirSync(repoPath);
      execSync("git init --bare -q", { cwd: repoPath });

      // Configure a remote origin
      execSync('git config remote.origin.url "https://github.com/test/repo.git"', {
        cwd: repoPath,
      });

      // Discover the repo through the sandbox
      const result = await sandbox.root.child("test.git");
      expect(result.found).toBe(true);
      if (result.found && result.node.is("bare-repository")) {
        expect((result.node as BareRepository).url).toBe("https://github.com/test/repo.git");
      } else {
        throw new Error("Expected bare-repository");
      }
    });

    it("child() returns null URL when no remote configured", async () => {
      // Create a bare repo without a remote
      const repoPath = join(tmpDir, "local.git");
      mkdirSync(repoPath);
      execSync("git init --bare -q", { cwd: repoPath });

      const result = await sandbox.root.child("local.git");
      expect(result.found).toBe(true);
      if (result.found && result.node.is("bare-repository")) {
        expect((result.node as BareRepository).url).toBeNull();
      } else {
        throw new Error("Expected bare-repository");
      }
    });

    it("children() reads remote URL from all bare repos", async () => {
      // Create two bare repos with different remotes
      const repo1Path = join(tmpDir, "repo1.git");
      const repo2Path = join(tmpDir, "repo2.git");

      mkdirSync(repo1Path);
      execSync("git init --bare -q", { cwd: repo1Path });
      execSync('git config remote.origin.url "https://github.com/org/repo1.git"', {
        cwd: repo1Path,
      });

      mkdirSync(repo2Path);
      execSync("git init --bare -q", { cwd: repo2Path });
      execSync('git config remote.origin.url "https://github.com/org/repo2.git"', {
        cwd: repo2Path,
      });

      const children = await sandbox.root.children();
      const bareRepos = children.filter((c) => c.is("bare-repository"));

      expect(bareRepos.length).toBe(2);

      const repo1 = bareRepos.find((r) => r.name === "repo1.git");
      const repo2 = bareRepos.find((r) => r.name === "repo2.git");

      expect(repo1).toBeDefined();
      expect(repo2).toBeDefined();

      // Access url property via type guard and cast
      if (repo1 && repo1.is("bare-repository") && repo2 && repo2.is("bare-repository")) {
        expect((repo1 as BareRepository).url).toBe("https://github.com/org/repo1.git");
        expect((repo2 as BareRepository).url).toBe("https://github.com/org/repo2.git");
      } else {
        throw new Error("Expected bare-repository");
      }
    });
  });

  describe("Fetch refspec configuration", () => {
    it("initBare() does not configure fetch refspec (no remote)", async () => {
      const repo = await sandbox.initBare(sandbox.root, "test.git");

      // Read the config file
      const configPath = join(repo.path, "config");
      const { readFileSync } = await import("fs");
      const config = readFileSync(configPath, "utf-8");

      // Should not have fetch refspec since there's no remote
      expect(config).not.toContain("fetch = ");
    });

    it("cloneBare() configures fetch refspec for remote tracking", async () => {
      // Now clone bare using the sandbox
      const cloneDir = await sandbox.root.createDirectory("clones");
      const repo = await sandbox.cloneBare(plainSource, cloneDir, "cloned.git");

      // Read the config file
      const configPath = join(repo.path, "config");
      const { readFileSync } = await import("fs");
      const config = readFileSync(configPath, "utf-8");

      // Should have fetch refspec configured
      expect(config).toContain("fetch = +refs/heads/*:refs/remotes/origin/*");
    });

    it("cloneBare() creates only the default local branch, tracking origin", async () => {
      const cloneDir = await sandbox.root.createDirectory("multi-clones");
      const repo = await sandbox.cloneBare(richSource, cloneDir, "cloned.git");

      // Only the branches the system uses get local heads — the default and
      // plan/main — not one per remote branch (feature-x stays remote-only).
      const localBranches = await repo.branches();
      expect(localBranches.sort()).toEqual(["_bare-head", "main", "plan/main"]);

      // The default branch tracks origin (has upstream config).
      expect(execSync("git config branch.main.remote", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("origin");
      expect(execSync("git config branch.main.merge", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("refs/heads/main");

      // plan/main also tracks its origin counterpart.
      expect(execSync('git config "branch.plan/main.remote"', { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("origin");
      expect(execSync('git config "branch.plan/main.merge"', { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("refs/heads/plan/main");

      // HEAD points at the untracked anchor branch, not at `main` itself —
      // so `main` never permanently occupies the bare repo's own checkout slot.
      expect(execSync("git symbolic-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("refs/heads/_bare-head");

      // All remote branches are present as remote-tracking refs.
      const remoteRefs = execSync(
        'git for-each-ref --format="%(refname:short)" refs/remotes/origin',
        { cwd: repo.path, encoding: "utf-8" }
      );
      expect(remoteRefs).toContain("origin/feature-x");
      expect(remoteRefs).toContain("origin/plan/main");
    });
  });

  describe("normalizeLocalBranches (legacy clone --bare cleanup)", () => {
    it("prunes stale mirror branches, keeps base/plan-main with tracking, and keeps local work", async () => {
      // Simulate legacy provisioning: a raw bare clone creates a non-tracking
      // local head per remote branch and no remote-tracking refs.
      const legacyPath = join(tmpDir, "legacy.git");
      execSync(`git clone -q --bare "${richSource}" "${legacyPath}"`, { cwd: tmpDir });

      // A purely-local branch with no origin counterpart must be preserved.
      execSync("git branch orphan-local main", { cwd: legacyPath });

      // Give the local 'diverged' branch a commit origin doesn't have, so it is
      // ahead of origin/diverged and must be preserved.
      const divWt = join(tmpDir, "diverged-wt");
      execSync(`git worktree add "${divWt}" diverged`, { cwd: legacyPath });
      writeFileSync(join(divWt, "local-only.txt"), "x");
      execSync("git add .", { cwd: divWt });
      execSync('git commit -q -m "local-only work"', { cwd: divWt });
      execSync(`git worktree remove "${divWt}" --force`, { cwd: legacyPath });

      // Sanity: the legacy clone has a local head per branch and no tracking refs.
      const before = execSync('git branch --format="%(refname:short)"', { cwd: legacyPath, encoding: "utf-8" });
      expect(before).toContain("feature-x");

      // Discover the bare repo through the sandbox and normalize it.
      const children = await sandbox.root.children();
      const repoNode = children.find((c) => c.name === "legacy.git");
      if (!repoNode || !repoNode.is("bare-repository")) {
        throw new Error("Expected to discover legacy.git as a bare repository");
      }
      const repo = repoNode as BareRepository;

      const deleted = await repo.normalizeLocalBranches();

      // The stale mirror (equal to origin) is pruned and reported.
      expect(deleted).toContain("feature-x");

      const local = (await repo.branches()).sort();
      expect(local).not.toContain("feature-x");
      // Kept: base, plan/main convention, the no-mirror branch, local work,
      // and the anchor branch normalizeLocalBranches heals HEAD onto.
      expect(local).toEqual(["_bare-head", "diverged", "main", "orphan-local", "plan/main"]);

      // Base and plan/main now track origin.
      expect(execSync("git config branch.main.remote", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("origin");
      expect(execSync('git config "branch.plan/main.remote"', { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("origin");
    });

    it("creates local main tracking origin/main when the base branch is missing entirely", async () => {
      // Simulate a lair provisioned before the tracking-branch step existed:
      // an empty bare repo with only the fetch refspec/remote configured, no
      // local branches at all — not even a non-tracking `main`.
      const strandedPath = join(tmpDir, "stranded.git");
      mkdirSync(strandedPath);
      execSync("git init --bare -q", { cwd: strandedPath });
      execSync(`git -C "${strandedPath}" remote add origin "${plainSource}"`);

      const beforeRepo = await sandbox.root.child("stranded.git");
      expect(beforeRepo.found).toBe(true);
      const repoNode = beforeRepo.found ? beforeRepo.node : undefined;
      if (!repoNode || !repoNode.is("bare-repository")) {
        throw new Error("Expected to discover stranded.git as a bare repository");
      }
      const repo = repoNode as BareRepository;

      // Sanity: no local branches exist yet.
      expect(await repo.branches()).toEqual([]);

      const deleted = await repo.normalizeLocalBranches();
      expect(deleted).toEqual([]);

      expect((await repo.branches()).sort()).toEqual(["_bare-head", "main"]);
      expect(execSync("git config branch.main.remote", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("origin");
      expect(execSync('git config "branch.main.merge"', { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("refs/heads/main");
      expect(execSync("git symbolic-ref HEAD", { cwd: repo.path, encoding: "utf-8" }).trim()).toBe("refs/heads/_bare-head");
    });

    it("is a no-op on a repo cloned the new (tracking) way", async () => {
      const cloneDir = await sandbox.root.createDirectory("clean-clones");
      const repo = await sandbox.cloneBare(plainSource, cloneDir, "clean.git");

      const deleted = await repo.normalizeLocalBranches();
      expect(deleted).toEqual([]);
      expect((await repo.branches()).sort()).toEqual(["_bare-head", "main"]);
    });
  });
});
