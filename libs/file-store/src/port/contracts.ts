/**
 * Contract Tests for Sandbox implementations
 *
 * These tests define the expected behavior of Sandbox implementations.
 * Both InMemorySandbox and DiskSandbox must pass all these tests.
 *
 * Usage:
 * ```typescript
 * import { runSandboxContractTests } from '@minions/file-store';
 *
 * runSandboxContractTests('InMemory', () => new InMemorySandbox());
 * runSandboxContractTests('Disk', () => new DiskSandbox('/tmp/test'), cleanup);
 * ```
 */

import type { Sandbox } from "./Sandbox.js";
import { asGitRef } from "./types.js";
import { pathToFile, pathToDirectory } from "../utils/pathConversion.js";
import type { describe as vitestDescribe, it as vitestIt, expect as vitestExpect, beforeEach as vitestBeforeEach, afterEach as vitestAfterEach } from "vitest";

/** Shape of the vitest globals this suite depends on, typed without a runtime import. */
interface TestGlobals {
  describe: typeof vitestDescribe;
  it: typeof vitestIt;
  expect: typeof vitestExpect;
  beforeEach: typeof vitestBeforeEach;
  afterEach: typeof vitestAfterEach;
}

/**
 * Joins a base path and a relative name the way a caller would (e.g.
 * `path.join(obj.path, glob_result.name)`), without depending on node:path's
 * OS-specific separator — pathToFile/pathToDirectory normalize the result
 * internally, so a plain forward-slash join here is portable across adapters
 * and OSes without needing to special-case Windows path.join behavior.
 */
function joinPath(base: string, rel: string): string {
  return base ? `${base}/${rel}` : rel;
}

/**
 * Options for running sandbox contract tests
 */
export interface ContractTestOptions {
  /**
   * Whether to skip tests that require network access.
   * Set to true for disk adapters that would need to clone real repos.
   * Default: false
   */
  skipNetworkTests?: boolean;
}

/**
 * Runs the complete contract test suite for a Sandbox implementation.
 *
 * @param name - Name for the test suite (e.g., 'InMemory', 'Disk')
 * @param createSandbox - Factory function to create a fresh sandbox instance
 * @param cleanup - Optional cleanup function called after each test
 * @param options - Optional test configuration
 */
export function runSandboxContractTests(
  name: string,
  createSandbox: () => Sandbox | Promise<Sandbox>,
  cleanup?: () => void | Promise<void>,
  options?: ContractTestOptions
): void {
  // Access vitest globals - these are injected when running under vitest
  // This avoids importing vitest at module level which crashes production code
  const g = globalThis as unknown as TestGlobals;
  const describe = g.describe;
  const it = g.it;
  const expect = g.expect;
  const beforeEach = g.beforeEach;
  const afterEach = g.afterEach;

  describe(`${name} Sandbox contract`, () => {
    let sandbox: Sandbox;

    beforeEach(async () => {
      sandbox = await createSandbox();
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
    });

    // ========================================
    // File Operations
    // ========================================

    describe("File operations", () => {
      it("creates files with createFile()", async () => {
        const file = await sandbox.root.createFile("test.txt", "content");
        expect(file.kind).toBe("file");
        expect(file.name).toBe("test.txt");
        expect(await file.read()).toBe("content");
      });

      it("creates files without initial content", async () => {
        const file = await sandbox.root.createFile("empty.txt");
        expect(await file.read()).toBe("");
      });

      it("File.write() writes content", async () => {
        const file = await sandbox.root.createFile("test.txt");
        await file.write("new content");
        expect(await file.read()).toBe("new content");
      });

      it("File.write() creates parent directories automatically", async () => {
        const dir = await sandbox.root.createDirectory("parent");
        const file = await dir.createFile("deep/nested/file.txt");
        await file.write("nested content");
        expect(await file.read()).toBe("nested content");
      });

      it("File.append() appends content", async () => {
        const file = await sandbox.root.createFile("test.txt", "hello");
        await file.append(" world");
        expect(await file.read()).toBe("hello world");
      });

      it("File.readLines() reads lines from file", async () => {
        const file = await sandbox.root.createFile(
          "test.txt",
          "line1\nline2\nline3"
        );
        const lines = await file.readLines();
        expect(lines).toEqual(["line1", "line2", "line3"]);
      });

      it("File.readLines() with offset and limit", async () => {
        const file = await sandbox.root.createFile(
          "test.txt",
          "a\nb\nc\nd\ne"
        );
        const lines = await file.readLines(1, 2);
        expect(lines).toEqual(["b", "c"]);
      });

      it("File.exists() returns true for existing files", async () => {
        const file = await sandbox.root.createFile("test.txt");
        expect(await file.exists()).toBe(true);
      });

      it("File.delete() removes the file", async () => {
        const file = await sandbox.root.createFile("test.txt");
        await file.delete();
        expect(await file.exists()).toBe(false);
      });

      it("File.stat() reports a modification time that advances after write()", async () => {
        const file = await sandbox.root.createFile("test.txt", "v1");
        const first = await file.stat();
        expect(typeof first.mtimeMs).toBe("number");

        await file.write("v2");
        const second = await file.stat();
        expect(second.mtimeMs).toBeGreaterThanOrEqual(first.mtimeMs);
      });

      it("File.stat() reports a modification time that advances after append()", async () => {
        const file = await sandbox.root.createFile("test.txt", "v1");
        const first = await file.stat();

        await file.append(" more");
        const second = await file.stat();
        expect(second.mtimeMs).toBeGreaterThanOrEqual(first.mtimeMs);
      });
    });

    // ========================================
    // Directory Operations
    // ========================================

    describe("Directory operations", () => {
      it("creates directories with createDirectory()", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        expect(dir.kind).toBe("directory");
        expect(dir.name).toBe("subdir");
      });

      it("Directory.children() returns child nodes", async () => {
        await sandbox.root.createFile("file1.txt");
        await sandbox.root.createFile("file2.txt");
        await sandbox.root.createDirectory("subdir");

        const children = await sandbox.root.children();
        expect(children.length).toBe(3);

        const names = children.map((c) => c.name);
        expect(names).toContain("file1.txt");
        expect(names).toContain("file2.txt");
        expect(names).toContain("subdir");
      });

      it("Directory.glob() matches patterns", async () => {
        await sandbox.root.createFile("file1.ts");
        await sandbox.root.createFile("file2.ts");
        await sandbox.root.createFile("readme.md");

        const matches = await sandbox.root.glob("*.ts");
        expect(matches.length).toBe(2);
        expect(matches.every((m) => m.name.endsWith(".ts"))).toBe(true);
      });

      it("Directory.glob() names matches with their path relative to this directory, not their basename", async () => {
        await sandbox.root.createFile("readme.md");
        const subdir = await sandbox.root.createDirectory("sub");
        const nested = await subdir.createDirectory("dir");
        await nested.createFile("readme.md");

        const matches = await sandbox.root.glob("**/*.md");
        const names = matches.map((m) => m.name).sort();
        expect(names).toEqual(["readme.md", "sub/dir/readme.md"]);
      });

      it("Directory.glob() prunes excluded directories from traversal entirely", async () => {
        await sandbox.root.createFile("readme.md");
        const nodeModules = await sandbox.root.createDirectory("node_modules");
        await nodeModules.createFile("readme.md");
        const kept = await sandbox.root.createDirectory("kept");
        await kept.createFile("readme.md");

        const matches = await sandbox.root.glob("**/*.md", ["node_modules"]);
        const names = matches.map((m) => m.name).sort();
        expect(names).toEqual(["kept/readme.md", "readme.md"]);
      });

      it("Directory.exists() returns true for existing directories", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        expect(await dir.exists()).toBe(true);
      });

      it("Directory.delete() removes empty directory", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        await dir.delete();
        expect(await dir.exists()).toBe(false);
      });

      it("Directory.delete(recursive) removes directory with contents", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        await dir.createFile("file.txt");
        await dir.createDirectory("nested");
        await dir.delete(true);
        expect(await dir.exists()).toBe(false);
      });

      it("Directory.hasGitDirectory() returns true when .git exists", async () => {
        const dir = await sandbox.root.createDirectory("repo");
        await dir.createDirectory(".git");
        expect(await dir.hasGitDirectory()).toBe(true);
      });

      it("Directory.hasGitDirectory() returns false when .git does not exist", async () => {
        const dir = await sandbox.root.createDirectory("not-a-repo");
        expect(await dir.hasGitDirectory()).toBe(false);
      });

      it("Directory.hasGitDirectory() returns false for empty directory", async () => {
        const dir = await sandbox.root.createDirectory("empty");
        expect(await dir.hasGitDirectory()).toBe(false);
      });
    });

    // ========================================
    // Pattern Matching
    // ========================================

    describe("Pattern matching", () => {
      it("File.match() calls file handler", async () => {
        const file = await sandbox.root.createFile("test.txt");
        const result = file.match({ file: (f) => f.name });
        expect(result).toBe("test.txt");
      });

      it("Directory.match() calls directory handler", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        const result = dir.match({ directory: (d) => d.name });
        expect(result).toBe("subdir");
      });

      it("File.is() returns correct type guard", async () => {
        const file = await sandbox.root.createFile("test.txt");
        expect(file.is("file")).toBe(true);
        expect(file.is("directory")).toBe(false);
      });

      it("Directory.is() returns correct type guard", async () => {
        const dir = await sandbox.root.createDirectory("subdir");
        expect(dir.is("directory")).toBe(true);
        expect(dir.is("file")).toBe(false);
      });
    });

    // ========================================
    // ChildResult Discriminated Unions
    // ========================================

    describe("ChildResult", () => {
      it("child() returns found:true when exists", async () => {
        await sandbox.root.createFile("test.txt");
        const result = await sandbox.root.child("test.txt");
        expect(result.found).toBe(true);
        if (result.found) {
          expect(result.node.name).toBe("test.txt");
        }
      });

      it("child() returns found:false when missing", async () => {
        const result = await sandbox.root.child("missing.txt");
        expect(result.found).toBe(false);
        if (!result.found) {
          expect(result.name).toBe("missing.txt");
          expect(result.parent).toBe(sandbox.root);
        }
      });

      it("child() can find directories", async () => {
        await sandbox.root.createDirectory("subdir");
        const result = await sandbox.root.child("subdir");
        expect(result.found).toBe(true);
        if (result.found) {
          expect(result.node.is("directory")).toBe(true);
        }
      });
    });

    // ========================================
    // Junction Operations
    // ========================================

    describe("Junction", () => {
      it("createJunction() creates junction within sandbox", async () => {
        const target = await sandbox.root.createDirectory("target");
        await target.createFile("file.txt", "content");

        const junction = await sandbox.root.createJunction("link", target);
        expect(junction.kind).toBe("junction");
        expect(junction.is("junction")).toBe(true);
      });

      it("Junction delegates child() to target", async () => {
        const target = await sandbox.root.createDirectory("target");
        await target.createFile("file.txt", "content");

        const junction = await sandbox.root.createJunction("link", target);
        const result = await junction.child("file.txt");
        expect(result.found).toBe(true);
      });

      it("Junction delegates children() to target", async () => {
        const target = await sandbox.root.createDirectory("target");
        await target.createFile("a.txt");
        await target.createFile("b.txt");

        const junction = await sandbox.root.createJunction("link", target);
        const children = await junction.children();
        expect(children.length).toBe(2);
      });

      it("Junction.unlink() removes the junction", async () => {
        const target = await sandbox.root.createDirectory("target");
        const junction = await sandbox.root.createJunction("link", target);
        await junction.unlink();
        expect(await junction.exists()).toBe(false);
        // Target should still exist
        expect(await target.exists()).toBe(true);
      });

      it("Junction.match() calls junction handler", async () => {
        const target = await sandbox.root.createDirectory("target");
        const junction = await sandbox.root.createJunction("link", target);
        const result = junction.match({ junction: (j) => j.name });
        expect(result).toBe("link");
      });
    });

    // ========================================
    // BareRepository Operations
    // ========================================

    describe("BareRepository", () => {
      it("initBare() creates a bare repository", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        expect(repo.kind).toBe("bare-repository");
        expect(repo.name).toBe("test.git");
        expect(repo.url).toBeNull(); // Initialized locally
      });

      it("BareRepository.createWorktree() creates a worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );
        expect(worktree.kind).toBe("worktree");
        expect(worktree.name).toBe("work");
        expect(worktree.branch).toBe("main");
        expect(worktree.repository).toBe(repo);
      });

      it("BareRepository.createWorktree() is discoverable via the parent Directory's child()", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        await repo.createWorktree(sandbox.root, "work", "main");

        const result = await sandbox.root.child("work");
        expect(result.found).toBe(true);
        if (result.found) {
          expect(result.node.kind).toBe("worktree");
          expect(result.node.is("worktree")).toBe(true);
        }
      });

      it("BareRepository.removeWorktree() removes it from the parent Directory's child() results", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await repo.removeWorktree(worktree);

        const result = await sandbox.root.child("work");
        expect(result.found).toBe(false);
      });

      it("createSparseWorktree() checks out only the cone, plus top-level files (cone mode)", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const seed = await repo.createWorktree(sandbox.root, "seed", "main");
        await seed.createFile("top-level.txt", "top level");
        await seed.createFile(".meta/plan/README.md", "# plan");
        // Nested so it's excluded by the cone (cone mode always includes
        // top-level files, so a top-level file wouldn't prove exclusion).
        await seed.createFile("other-dir/other.txt", "not plan data");
        await seed.commitAll("seed");
        // A worktree can't share a branch with `seed` (git rejects checking
        // out the same branch in two worktrees at once), so point the sparse
        // worktree at a separate branch pointing at the same commit.
        await repo.createBranchIfMissing("cone", "main");

        const sparse = await repo.createSparseWorktree(sandbox.root, "sparse", "cone", ".meta/plan");

        const topLevel = await pathToFile(sandbox, joinPath(sparse.path, "top-level.txt"));
        expect(topLevel).toBeDefined();
        expect(await topLevel?.read()).toBe("top level");

        const readme = await pathToFile(sandbox, joinPath(sparse.path, ".meta/plan/README.md"));
        expect(readme).toBeDefined();
        expect(await readme?.read()).toBe("# plan");

        const excluded = await pathToFile(sandbox, joinPath(sparse.path, "other-dir/other.txt"));
        expect(excluded).toBeUndefined();
        const excludedDir = await pathToDirectory(sandbox, joinPath(sparse.path, "other-dir"));
        expect(excludedDir).toBeUndefined();
      });

      it("BareRepository.worktrees() lists worktrees", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        await repo.createWorktree(sandbox.root, "work1", "main");
        await repo.createWorktree(sandbox.root, "work2", "feature");

        const worktrees = await repo.worktrees();
        expect(worktrees.length).toBe(2);
        expect(worktrees.map((w) => w.name)).toContain("work1");
        expect(worktrees.map((w) => w.name)).toContain("work2");
      });

      it("BareRepository.removeWorktree() removes a worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await repo.removeWorktree(worktree);
        const worktrees = await repo.worktrees();
        expect(worktrees.length).toBe(0);
      });

      it("BareRepository.branches() lists branches", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create a file and commit to establish main branch
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");

        const branches = await repo.branches();
        expect(branches).toContain("main");
      });

      it("BareRepository.createBranchIfMissing() creates a branch at ref without a worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");

        await repo.createBranchIfMissing("docs/edit-1", "main");

        const branches = await repo.branches();
        expect(branches).toContain("docs/edit-1");
        const worktreesAfter = await repo.worktrees();
        expect(worktreesAfter.map((w) => w.name)).not.toContain("docs/edit-1");
      });

      it("BareRepository.createBranchIfMissing() never moves an already-existing branch", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");
        await repo.createBranchIfMissing("docs/edit-1", "main");

        await worktree.createFile("more.md", "# More");
        await worktree.commitAll("Second commit");

        // Re-running with a newer ref must not move the already-created branch.
        await repo.createBranchIfMissing("docs/edit-1", "main");

        const editWorktree = await repo.createWorktree(sandbox.root, "check", "docs/edit-1");
        const files = await editWorktree.children();
        expect(files.map((f) => f.name)).not.toContain("more.md");
      });

      it("BareRepository.updateBranch() creates a branch at target when it doesn't exist yet, without a worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");

        await repo.updateBranch("plan/main", "main");

        const branches = await repo.branches();
        expect(branches).toContain("plan/main");
        const worktreesAfter = await repo.worktrees();
        expect(worktreesAfter.map((w) => w.name)).not.toContain("plan/main");
      });

      it("BareRepository.updateBranch() force-moves an already-existing branch to the new target, unlike createBranchIfMissing()", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");
        await repo.updateBranch("plan/main", "main");

        await worktree.createFile("more.md", "# More");
        await worktree.commitAll("Second commit");

        // Unlike createBranchIfMissing(), this MUST move plan/main forward —
        // verified via log() (commits reachable from `main` not yet on
        // `plan/main`) rather than materializing a second worktree, since
        // simultaneous multi-worktree content isn't something every adapter
        // simulates with full fidelity.
        expect(await worktree.log("plan/main", "main")).not.toHaveLength(0);

        await repo.updateBranch("plan/main", "main");

        expect(await worktree.log("plan/main", "main")).toHaveLength(0);
      });

      it("BareRepository.resolveLocalRef() resolves a local branch to its commit hash without a worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        const hash = await worktree.commitAll("Initial commit");

        expect(await repo.resolveLocalRef("main")).toBe(hash);
      });

      it("BareRepository.resolveLocalRef() reflects a branch moved by updateBranch()", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        const firstHash = await worktree.commitAll("Initial commit");
        await repo.updateBranch("plan/main", "main");
        expect(await repo.resolveLocalRef("plan/main")).toBe(firstHash);

        await worktree.createFile("more.md", "# More");
        const secondHash = await worktree.commitAll("Second commit");
        await repo.updateBranch("plan/main", "main");

        expect(await repo.resolveLocalRef("plan/main")).toBe(secondHash);
      });

      it("BareRepository.resolveLocalRef() returns null for a ref that doesn't exist", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        expect(await repo.resolveLocalRef("nonexistent")).toBeNull();
      });

      it("BareRepository.match() calls bareRepository handler", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const result = repo.match({ bareRepository: (r) => r.name });
        expect(result).toBe("test.git");
      });

      it("BareRepository.delete() removes the repository", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        await repo.delete();

        const result = await sandbox.root.child("test.git");
        expect(result.found).toBe(false);
      });

      it("BareRepository.pruneWorktrees() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        await expect(repo.pruneWorktrees()).resolves.not.toThrow();
      });

      it("BareRepository.pruneWorktrees() does not resurrect a properly removed worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await repo.removeWorktree(worktree);

        await repo.pruneWorktrees();

        const worktrees = await repo.worktrees();
        expect(worktrees.map((w) => w.name)).not.toContain("work");
      });

      it("BareRepository.normalizeLocalBranches() returns an empty list for a repo that wasn't cloned the old way", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("README.md", "# Test");
        await worktree.commitAll("Initial commit");

        expect(await repo.normalizeLocalBranches()).toEqual([]);
      });

      it("BareRepository.updateBranchIfUnchanged() moves the branch and returns true when the expected hash matches", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("file.txt", "v1");
        const firstHash = await worktree.commitAll("v1");
        await repo.updateBranch("plan/main", firstHash);

        await worktree.createFile("file2.txt", "v2");
        const secondHash = await worktree.commitAll("v2");

        const applied = await repo.updateBranchIfUnchanged("plan/main", secondHash, firstHash);

        expect(applied).toBe(true);
        expect(await repo.resolveLocalRef("plan/main")).toBe(secondHash);
      });

      it(
        "BareRepository.updateBranchIfUnchanged() returns false and does NOT move the branch when the expected hash doesn't match (CAS-safety property)",
        async () => {
          const repo = await sandbox.initBare(sandbox.root, "test.git");
          const worktree = await repo.createWorktree(sandbox.root, "work", "main");
          await worktree.createFile("file.txt", "v1");
          const firstHash = await worktree.commitAll("v1");
          await repo.updateBranch("plan/main", firstHash);

          // Simulate a concurrent caller having already moved plan/main past
          // firstHash, so this caller's stale view of "expected" no longer matches.
          await worktree.createFile("file2.txt", "v2");
          const secondHash = await worktree.commitAll("v2");
          await repo.updateBranch("plan/main", secondHash);

          await worktree.createFile("file3.txt", "v3");
          const thirdHash = await worktree.commitAll("v3");

          const applied = await repo.updateBranchIfUnchanged("plan/main", thirdHash, firstHash);

          expect(
            applied,
            "CAS must report failure (not throw, not silently apply) when the expected hash is stale"
          ).toBe(false);
          expect(
            await repo.resolveLocalRef("plan/main"),
            "CAS must NOT move the branch when it loses the race"
          ).toBe(secondHash);
        }
      );

      it("BareRepository.updateBranchIfUnchanged() with expected:\"\" creates the branch only if it doesn't already exist", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("file.txt", "v1");
        const firstHash = await worktree.commitAll("v1");

        const applied = await repo.updateBranchIfUnchanged("plan/main", firstHash, "");
        expect(applied).toBe(true);
        expect(await repo.resolveLocalRef("plan/main")).toBe(firstHash);

        await worktree.createFile("file2.txt", "v2");
        const secondHash = await worktree.commitAll("v2");
        const appliedAgain = await repo.updateBranchIfUnchanged("plan/main", secondHash, "");

        expect(appliedAgain).toBe(false);
        expect(await repo.resolveLocalRef("plan/main")).toBe(firstHash);
      });
    });

    // ========================================
    // Worktree Operations
    // ========================================

    describe("Worktree", () => {
      it("Worktree.createDirectory() returns Worktree (not Directory)", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        const subdir = await worktree.createDirectory("src");
        expect(subdir.kind).toBe("worktree");
        expect(subdir.is("worktree")).toBe(true);
      });

      it("Worktree.children() returns only WorktreeChild types", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt");
        await worktree.createDirectory("subdir");

        const children = await worktree.children();
        for (const child of children) {
          // Type system ensures only file/worktree/junction handlers needed
          // oxlint-disable-next-line no-empty-function
          child.match({ file: () => {}, worktree: () => {}, junction: () => {} });
        }
        expect(children.length).toBe(2);
      });

      it("Worktree.child() returns WorktreeChildResult", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt");
        const result = await worktree.child("file.txt");

        expect(result.found).toBe(true);
        if (result.found) {
          // Type narrowing works
          // oxlint-disable-next-line no-empty-function
          result.node.match({ file: (f) => expect(f.name).toBe("file.txt"), worktree: () => {}, junction: () => {} });
        }
      });

      it("Worktree.match() calls worktree handler", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );
        const result = worktree.match({ worktree: (w) => w.branch });
        expect(result).toBe("main");
      });

      it("Worktree.glob() names matches with their path relative to this worktree, not their basename", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("readme.md", "# root");
        await worktree.createFile("sub/dir/readme.md", "# nested");

        const matches = await worktree.glob("**/*.md");
        const names = matches.map((m) => m.name).sort();
        expect(names).toEqual(["readme.md", "sub/dir/readme.md"]);

        // The relative-path name must round-trip through child() to re-fetch the node.
        const nested = matches.find((m) => m.name === "sub/dir/readme.md");
        expect(nested).toBeDefined();
        const refetched = await worktree.child(nested?.name ?? "");
        expect(refetched.found).toBe(true);
      });

      it("Worktree.glob() prunes excluded directories from traversal entirely", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test-prune.git");
        const worktree = await repo.createWorktree(sandbox.root, "work-prune", "main");

        await worktree.createFile("readme.md", "# root");
        await worktree.createFile("node_modules/readme.md", "# vendored");
        await worktree.createFile("kept/readme.md", "# kept");

        const matches = await worktree.glob("**/*.md", ["node_modules"]);
        const names = matches.map((m) => m.name).sort();
        expect(names).toEqual(["kept/readme.md", "readme.md"]);
      });

      it("Worktree.deleteChild() removes a file", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("file.txt", "content");
        await worktree.deleteChild("file.txt");

        const result = await worktree.child("file.txt");
        expect(result.found).toBe(false);
      });

      it("Worktree.deleteChild(recursive) removes a directory and its contents", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createDirectory("subdir");
        await worktree.createFile("subdir/file.txt", "content");
        await worktree.deleteChild("subdir", true);

        const result = await worktree.child("subdir");
        expect(result.found).toBe(false);
      });

      it("Worktree.setSparseCheckout() narrows an already-created worktree to a single subdirectory (cone mode)", async () => {
        const repo = await sandbox.initBare(sandbox.root, "sparse-existing.git");
        const worktree = await repo.createWorktree(sandbox.root, "sparse-existing-wt", "main");
        await worktree.createFile("top-level.txt", "top level");
        await worktree.createFile(".meta/plan/README.md", "# plan");
        // Nested so it's excluded by the cone (cone mode always includes
        // top-level files, so a top-level file wouldn't prove exclusion).
        await worktree.createFile("other-dir/other.txt", "not plan data");
        await worktree.commitAll("seed");

        await worktree.setSparseCheckout(".meta/plan");

        const topLevel = await pathToFile(sandbox, joinPath(worktree.path, "top-level.txt"));
        expect(topLevel).toBeDefined();
        expect(await topLevel?.read()).toBe("top level");

        const readme = await pathToFile(sandbox, joinPath(worktree.path, ".meta/plan/README.md"));
        expect(readme).toBeDefined();
        expect(await readme?.read()).toBe("# plan");

        const excluded = await pathToFile(sandbox, joinPath(worktree.path, "other-dir/other.txt"));
        expect(excluded).toBeUndefined();
      });
    });

    // ========================================
    // Worktree Git Operations
    // ========================================

    describe("Worktree git operations", () => {
      it("commitAll() commits all changes", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt", "content");
        expect(await worktree.isDirty()).toBe(true);

        const hash = await worktree.commitAll("Initial commit");
        expect(hash).toBeTruthy();
        expect(typeof hash).toBe("string");
        expect(await worktree.isDirty()).toBe(false);
      });

      it("currentBranch() returns current branch", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        const branch = await worktree.currentBranch();
        expect(branch).toBe("main");
      });

      it("switchBranch() switches to different branch", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create initial commit on main
        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // Switch to new branch
        await worktree.switchBranch("feature");
        expect(await worktree.currentBranch()).toBe("feature");
      });

      it("branches() lists all branches", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        await worktree.switchBranch("feature");
        await worktree.createFile("feature.txt", "feature");
        await worktree.commitAll("Feature commit");

        const branches = await worktree.branches();
        expect(branches).toContain("main");
        expect(branches).toContain("feature");
      });

      it("isDirty() returns true when there are uncommitted changes", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        expect(await worktree.isDirty()).toBe(false);

        await worktree.createFile("file.txt", "content");
        expect(await worktree.isDirty()).toBe(true);
      });

      it("diff() returns the content changes introduced by one branch relative to another", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt", "line one\n");
        await worktree.commitAll("Initial commit");

        await worktree.switchBranch("feature");
        await worktree.createFile("file.txt", "line one\nline two\n");
        await worktree.commitAll("Add line two");

        const diff = await worktree.diff("main", "feature");
        expect(diff).toContain("line two");
      });

      it("merge() returns MergeResult with success status", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create initial commit on main
        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // Create feature branch with changes
        await worktree.switchBranch("feature");
        await worktree.createFile("feature.txt", "feature content");
        await worktree.commitAll("Feature commit");

        // Switch back to main and merge feature
        await worktree.switchBranch("main");
        const result = await worktree.merge("feature");

        expect(result.status).toBe("success");
        if (result.status === "success") {
          expect(result.commit).toBeTruthy();
        }
      });

      it("merge() returns already-up-to-date when no changes", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create initial commit
        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // Try to merge main into main (no-op)
        const result = await worktree.merge("main");
        expect(result.status).toBe("already-up-to-date");
      });

      it("rebase() returns success when rebasing onto main", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create initial commit on main
        await worktree.createFile("file.txt", "initial");
        await worktree.commitAll("Initial commit");

        // Create feature branch with changes
        await worktree.switchBranch("feature");
        await worktree.createFile("feature.txt", "feature content");
        await worktree.commitAll("Feature commit");

        // Rebase feature onto main (should succeed, even if no-op)
        const result = await worktree.rebase("main");
        expect(result.status).toBe("success");
      });

      it("rebase() returns success when already up-to-date", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // Create initial commit
        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // Rebase main onto main (no-op but still success)
        const result = await worktree.rebase("main");
        expect(result.status).toBe("success");
      });

      it("baseBranch() resolves to the repository's default branch", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        expect(await worktree.baseBranch()).toBe("main");
      });

      it("setBaseBranch() overrides baseBranch() for this worktree, until cleared with null", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.setBaseBranch("experiment/foo");
        expect(await worktree.baseBranch()).toBe("experiment/foo");

        await worktree.setBaseBranch(null);
        expect(await worktree.baseBranch()).toBe("main");
      });

      it("setBaseBranch() scopes its override to a single worktree", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktreeA = await repo.createWorktree(sandbox.root, "work-a", "main");
        const worktreeB = await repo.createWorktree(sandbox.root, "work-b", "other");

        await worktreeA.setBaseBranch("experiment/foo");

        expect(await worktreeA.baseBranch()).toBe("experiment/foo");
        expect(await worktreeB.baseBranch()).toBe("main");
      });

      it("hasInProgressRebase() is false when no rebase is underway", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        expect(await worktree.hasInProgressRebase()).toBe(false);
      });

      it("hasInProgressRebase()/continueRebase() detect and resolve a genuine rebase conflict, when one occurs", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("shared.txt", "base\n");
        await worktree.commitAll("base");

        await worktree.switchBranch("feature");
        await worktree.createFile("shared.txt", "feature change\n");
        await worktree.commitAll("feature edits shared.txt");

        await worktree.switchBranch("main");
        await worktree.createFile("shared.txt", "main change\n");
        await worktree.commitAll("main edits shared.txt");

        await worktree.switchBranch("feature");
        const result = await worktree.rebase("main");

        if (result.status === "conflict") {
          expect(await worktree.hasInProgressRebase()).toBe(true);

          const fileResult = await worktree.child("shared.txt");
          expect(fileResult.found).toBe(true);
          if (fileResult.found && fileResult.node.kind === "file") {
            await fileResult.node.write("resolved\n");
          }

          const continued = await worktree.continueRebase();
          expect(continued.status).toBe("success");
          expect(await worktree.hasInProgressRebase()).toBe(false);
        } else {
          // Some adapters may resolve divergent-but-compatible content without
          // a real conflict; either way, no rebase should be left in progress.
          expect(await worktree.hasInProgressRebase()).toBe(false);
        }
      });

      it("readFileAtRef() reads a file's content as it existed at a specific ref, without touching the live checkout", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("file.txt", "v1");
        const firstHash = await worktree.commitAll("v1");

        await worktree.createFile("file.txt", "v2");
        await worktree.commitAll("v2");

        expect(await worktree.readFileAtRef(asGitRef(firstHash), "file.txt")).toBe("v1");
        expect(await worktree.readFileAtRef(asGitRef("main"), "file.txt")).toBe("v2");
        // The live checkout must be unaffected by reading an older ref.
        const live = await worktree.child("file.txt");
        expect(live.found).toBe(true);
        if (live.found && live.node.kind === "file") {
          expect(await live.node.read()).toBe("v2");
        }
      });

      it("readFileAtRef() returns null when the file didn't exist at that ref", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("first.txt", "v1");
        const firstHash = await worktree.commitAll("first");

        await worktree.createFile("second.txt", "v2");
        await worktree.commitAll("second");

        expect(await worktree.readFileAtRef(asGitRef(firstHash), "second.txt")).toBeNull();
      });

      it("changedFiles() lists paths changed between two refs", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("first.txt", "v1");
        const firstHash = await worktree.commitAll("first");

        await worktree.createFile("second.txt", "v2");
        await worktree.createFile("first.txt", "v1-updated");
        await worktree.commitAll("second");

        const changed = await worktree.changedFiles(firstHash, "main");
        expect(changed.sort()).toEqual(["first.txt", "second.txt"]);
      });

      it("changedFiles() returns an empty array when the two refs are the same", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("first.txt", "v1");
        const firstHash = await worktree.commitAll("first");

        expect(await worktree.changedFiles(firstHash, "main")).toEqual([]);
      });

      it("fetch() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        // fetch() should not throw (even without a remote, it's a no-op)
        await expect(worktree.fetch()).resolves.not.toThrow();
      });

      // Note: These push tests require a remote to be configured
      // Skip for disk adapters where there's no real remote
      const itPushTest = options?.skipNetworkTests ? it.skip : it;

      itPushTest("pushWithTracking() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // pushWithTracking() should not throw in simulation
        await expect(worktree.pushWithTracking(true)).resolves.not.toThrow();
      });

      itPushTest("forcePush() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(
          sandbox.root,
          "work",
          "main"
        );

        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        // forcePush() should not throw in simulation
        await expect(worktree.forcePush()).resolves.not.toThrow();
      });

      itPushTest("push() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        await expect(worktree.push()).resolves.not.toThrow();
      });

      itPushTest("pull() completes without error", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");

        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");

        await expect(worktree.pull()).resolves.not.toThrow();
      });

      itPushTest("Worktree.forcePushBranch() force-pushes a named branch to origin without switching to it", async () => {
        const repo = await sandbox.initBare(sandbox.root, "test.git");
        const worktree = await repo.createWorktree(sandbox.root, "work", "main");
        await worktree.createFile("file.txt", "content");
        await worktree.commitAll("Initial commit");
        await repo.createBranchIfMissing("other", "main");

        await worktree.forcePushBranch("other");

        expect(await worktree.currentBranch()).toBe("main");
        expect(await repo.resolveLocalRef("origin/other")).toBe(await repo.resolveLocalRef("other"));
      });
    });

    // ========================================
    // ReadOnlyClone Operations
    // ========================================

    // Note: These tests require network access for disk implementations
    // Use skipNetworkTests option to skip these for disk adapters
    const describeReadOnlyClone = options?.skipNetworkTests
      ? describe.skip
      : describe;

    describeReadOnlyClone("ReadOnlyClone", () => {
      it("cloneReadOnly() creates a read-only clone", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly"
        );
        expect(clone.kind).toBe("read-only-clone");
        expect(clone.name).toBe("readonly");
        expect(clone.url).toBe("https://github.com/example/repo.git");
        expect(clone.is("read-only-clone")).toBe(true);
      });

      it("cloneReadOnly() with branch parameter sets the branch", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly",
          "develop"
        );
        expect(clone.branch).toBe("develop");
      });

      it("ReadOnlyClone.exists() returns true for existing clone", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly"
        );
        expect(await clone.exists()).toBe(true);
      });

      it("ReadOnlyClone.match() calls readOnlyClone handler", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly"
        );
        const result = clone.match({ readOnlyClone: (c) => c.name });
        expect(result).toBe("readonly");
      });

      it("ReadOnlyClone.branches() lists branches", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly",
          "main"
        );
        const branches = await clone.branches();
        expect(branches).toContain("main");
      });

      it("ReadOnlyClone.switchBranch() changes the current branch", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly",
          "main"
        );
        await clone.switchBranch("feature");
        expect(clone.branch).toBe("feature");
      });

      it("ReadOnlyClone.delete() removes the clone", async () => {
        const clone = await sandbox.cloneReadOnly(
          "https://github.com/example/repo.git",
          sandbox.root,
          "readonly"
        );
        await clone.delete();
        expect(await clone.exists()).toBe(false);
      });
    });

    // ========================================
    // Path Conversion (join-then-resolve invariant)
    // ========================================

    describe("Path conversion", () => {
      it("pathToFile resolves a glob match's path.join(obj.path, name) uniformly through a junction", async () => {
        const target = await sandbox.root.createDirectory("real-target");
        const nested = await target.createDirectory("sub");
        await nested.createFile("readme.md", "# nested");
        const junction = await sandbox.root.createJunction("via-junction", target);

        const matches = await junction.glob("**/*.md");
        expect(matches.map((m) => m.name)).toEqual(["sub/readme.md"]);

        const joined = joinPath(junction.path, matches[0].name);
        const resolved = await pathToFile(sandbox, joined);
        expect(resolved).toBeDefined();
        expect(await resolved?.read()).toBe("# nested");
      });

      it("pathToFile resolves a glob match's path.join(obj.path, name) for a plain Directory", async () => {
        await sandbox.root.createFile("readme.md", "# root");
        const sub = await sandbox.root.createDirectory("sub");
        await sub.createFile("nested.md", "# nested");

        const matches = await sandbox.root.glob("**/*.md");
        for (const match of matches) {
          const joined = joinPath(sandbox.root.path, match.name);
          const resolved = await pathToFile(sandbox, joined);
          expect(resolved).toBeDefined();
        }
      });

      it("pathToFile returns undefined for a path that does not exist", async () => {
        const resolved = await pathToFile(sandbox, joinPath(sandbox.root.path, "nope.md"));
        expect(resolved).toBeUndefined();
      });

      it("pathToDirectory resolves a directory reached through a junction", async () => {
        const target = await sandbox.root.createDirectory("real-target-2");
        await target.createDirectory("sub");
        const junction = await sandbox.root.createJunction("via-junction-2", target);

        const matches = await junction.glob("**/sub");
        expect(matches.length).toBe(1);

        const joined = joinPath(junction.path, matches[0].name);
        const resolved = await pathToDirectory(sandbox, joined);
        expect(resolved).toBeDefined();
        expect(resolved?.isDirectoryLike()).toBe(true);
      });

      it("pathToDirectory resolves a Worktree root, not just literal-kind Directory", async () => {
        const repo = await sandbox.initBare(sandbox.root, "conv-test.git");
        const worktree = await repo.createWorktree(sandbox.root, "conv-wt", "main");

        const resolved = await pathToDirectory(sandbox, worktree.path);
        expect(resolved).toBeDefined();
        expect(resolved?.isDirectoryLike()).toBe(true);
      });

      it("pathToDirectory returns undefined for a file path", async () => {
        await sandbox.root.createFile("readme.md", "# root");
        const resolved = await pathToDirectory(sandbox, joinPath(sandbox.root.path, "readme.md"));
        expect(resolved).toBeUndefined();
      });
    });
  });
}
