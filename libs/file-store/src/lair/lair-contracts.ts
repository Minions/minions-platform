/**
 * Contract Tests for Lair implementations
 *
 * These tests define the expected behavior of Lair implementations.
 * Both InMemoryLair and DiskLair must pass all these tests.
 *
 * Usage:
 * ```typescript
 * import { runLairContractTests } from '@minions/file-store';
 *
 * runLairContractTests('InMemory', () => createInMemoryLair());
 * runLairContractTests('Disk', () => createDiskLair('/tmp/test'), cleanup);
 * ```
 */

import type { Lair } from "./Lair.js";
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
 * Runs the complete contract test suite for a Lair implementation.
 *
 * @param name - Name for the test suite (e.g., 'InMemory', 'Disk')
 * @param createLair - Factory function to create a fresh lair instance
 * @param cleanup - Optional cleanup function called after each test
 */
export function runLairContractTests(
  name: string,
  createLair: () => Lair | Promise<Lair>,
  cleanup?: () => void | Promise<void>
): void {
  // Access vitest globals - these are injected when running under vitest
  // This avoids importing vitest at module level which crashes production code
  const g = globalThis as unknown as TestGlobals;
  const describe = g.describe;
  const it = g.it;
  const expect = g.expect;
  const beforeEach = g.beforeEach;
  const afterEach = g.afterEach;

  describe(`${name} Lair contract`, () => {
    let lair: Lair;

    beforeEach(async () => {
      lair = await createLair();
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
    });

    // ========================================
    // Lair Basic Properties
    // ========================================

    describe("Lair basic properties", () => {
      it("has a sandbox", () => {
        expect(lair.sandbox).toBeDefined();
        expect(lair.sandbox.root).toBeDefined();
      });

      it("has a name", () => {
        expect(typeof lair.name).toBe("string");
        expect(lair.name.length).toBeGreaterThan(0);
      });

      it("has a root directory", () => {
        expect(lair.root).toBeDefined();
        expect(lair.root.kind).toBe("directory");
      });
    });

    // ========================================
    // Work Repository Operations
    // ========================================

    describe("Work repository operations", () => {
      it("workRepo() returns exists:false for missing repo", async () => {
        const result = await lair.workRepo("nonexistent");
        expect(result.exists).toBe(false);
        if (!result.exists) {
          expect(result.name).toBe("nonexistent");
        }
      });

      it("addWorkRepo() adds a work repository", async () => {
        // Note: In tests, we'll use initBare through the sandbox instead of cloneBare
        // which requires network access. Implementations should support this pattern.
        const workDir = await ensureDirectory(lair.root, "work");
        await lair.sandbox.initBare(workDir, "test-repo.git");

        const result = await lair.workRepo("test-repo");
        expect(result.exists).toBe(true);
        if (result.exists) {
          expect(result.repo.name).toBe("test-repo.git");
        }
      });

      it("workRepos() lists all work repositories", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        await lair.sandbox.initBare(workDir, "repo-a.git");
        await lair.sandbox.initBare(workDir, "repo-b.git");

        const repos = await lair.workRepos();
        expect(repos.length).toBe(2);

        const names = repos.map((r) => r.name);
        expect(names).toContain("repo-a.git");
        expect(names).toContain("repo-b.git");
      });
    });

    // ========================================
    // Private Repository Operations
    // ========================================

    describe("Private repository operations", () => {
      it("privateRepo() returns exists:false when not initialized", async () => {
        const result = await lair.privateRepo("local");
        expect(result.exists).toBe(false);
        if (!result.exists) {
          expect(result.scope).toBe("local");
        }
      });

      it("initPrivateRepo() creates a private repository", async () => {
        const repo = await lair.initPrivateRepo("local");
        expect(repo.kind).toBe("bare-repository");
        expect(repo.url).toBeNull(); // Local-only, no remote

        const result = await lair.privateRepo("local");
        expect(result.exists).toBe(true);
      });

      it("supports both local and global scopes", async () => {
        await lair.initPrivateRepo("local");
        await lair.initPrivateRepo("global");

        const localResult = await lair.privateRepo("local");
        const globalResult = await lair.privateRepo("global");

        expect(localResult.exists).toBe(true);
        expect(globalResult.exists).toBe(true);
      });
    });

    // ========================================
    // Wing Operations
    // ========================================

    describe("Wing operations", () => {
      it("wing() returns exists:false for missing wing", async () => {
        const result = await lair.wing("nonexistent");
        expect(result.exists).toBe(false);
        if (!result.exists) {
          expect(result.name).toBe("nonexistent");
        }
      });

      it("createWing() creates a wing with work/local", async () => {
        // First set up a work repo
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        // Create initial commit so we can create a worktree
        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const wing = await lair.createWing("workshop-00", {
          workLocal: { repo: "main-repo", branch: "main" },
        });

        expect(wing.name).toBe("workshop-00");
        expect(wing.lair).toBe(lair);

        const workLocalResult = await wing.workLocal();
        expect(workLocalResult.exists).toBe(true);
        if (workLocalResult.exists) {
          expect(workLocalResult.worktree.branch).toBe("main");
        }
      });

      it("createWing() creates wing with private worktrees when configured", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        // Initialize private repos first
        const privateLocalRepo = await lair.initPrivateRepo("local");
        const privateTempLocal = await privateLocalRepo.createWorktree(
          lair.root,
          "_temp_local",
          "main"
        );
        await privateTempLocal.createFile("README.md", "# Private Local");
        await privateTempLocal.commitAll("Initial commit");
        await privateLocalRepo.removeWorktree(privateTempLocal);

        const privateGlobalRepo = await lair.initPrivateRepo("global");
        const privateTempGlobal = await privateGlobalRepo.createWorktree(
          lair.root,
          "_temp_global",
          "main"
        );
        await privateTempGlobal.createFile("README.md", "# Private Global");
        await privateTempGlobal.commitAll("Initial commit");
        await privateGlobalRepo.removeWorktree(privateTempGlobal);

        const wing = await lair.createWing("workshop-00", {
          workLocal: { repo: "main-repo", branch: "main" },
          privateLocal: { branch: "l/test-lair/w/workshop-00/local" },
          privateGlobal: { branch: "l/test-lair/w/workshop-00/global" },
        });

        const privateLocalResult = await wing.privateLocal();
        const privateGlobalResult = await wing.privateGlobal();

        expect(privateLocalResult.exists).toBe(true);
        expect(privateGlobalResult.exists).toBe(true);
        if (privateLocalResult.exists) {
          expect(privateLocalResult.worktree.kind).toBe("worktree");
        }
        if (privateGlobalResult.exists) {
          expect(privateGlobalResult.worktree.kind).toBe("worktree");
        }
      });

      it("wings() lists all wings", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        // Create a second branch for the second wing
        // (git doesn't allow multiple worktrees on the same branch)
        await tempWorktree.switchBranch("feature-b");
        await repo.removeWorktree(tempWorktree);

        await lair.createWing("wing-a", {
          workLocal: { repo: "main-repo", branch: "main" },
        });
        await lair.createWing("wing-b", {
          workLocal: { repo: "main-repo", branch: "feature-b" },
        });

        const wings = await lair.wings();
        expect(wings.length).toBe(2);

        const names = wings.map((w) => w.name);
        expect(names).toContain("wing-a");
        expect(names).toContain("wing-b");
      });

      it("deleteWing() removes a wing", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        await lair.createWing("to-delete", {
          workLocal: { repo: "main-repo", branch: "main" },
        });

        await lair.deleteWing("to-delete");

        const result = await lair.wing("to-delete");
        expect(result.exists).toBe(false);
      });

      it("deleteWing() genuinely releases every worktree, not just the wing directory", async () => {
        // Real proof the underlying worktrees are gone (git allows exactly
        // one worktree per branch): re-checking out the SAME branches
        // elsewhere only succeeds if deleteWing() actually released them.
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");
        const tempWorktree = await repo.createWorktree(lair.root, "_temp", "main");
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const privateLocalRepo = await lair.initPrivateRepo("local");
        const privateGlobalRepo = await lair.initPrivateRepo("global");

        const extraRepoResult = await lair.workRepo("main-repo");
        if (!extraRepoResult.exists) throw new Error("expected main-repo");

        const wing = await lair.createWing("to-fully-delete", {
          workLocal: { repo: "main-repo", branch: "main" },
          privateLocal: { branch: "l/test-lair/w/to-fully-delete/local" },
          privateGlobal: { branch: "l/test-lair/w/to-fully-delete/global" },
          extraWork: { extra: { repo: "main-repo", branch: "extra-branch" } },
        });

        // Sanity: branches are genuinely checked out (each worktree occupies
        // its branch — git refuses a second worktree on the same branch).
        await expect(repo.createWorktree(lair.root, "_probe", "main")).rejects.toThrow();

        await lair.deleteWing("to-fully-delete");

        // Now the same branches must be checkable-out again, elsewhere —
        // proof `discardWorkAreas()` actually called `removeWorktree`, not
        // just that the wing's own directory tree was deleted out from under
        // still-registered worktrees.
        const reclaimedLocal = await repo.createWorktree(lair.root, "_reclaimed_local", "main");
        expect(reclaimedLocal.branch).toBe("main");
        await repo.removeWorktree(reclaimedLocal);

        const reclaimedExtra = await repo.createWorktree(lair.root, "_reclaimed_extra", "extra-branch");
        expect(reclaimedExtra.branch).toBe("extra-branch");
        await repo.removeWorktree(reclaimedExtra);

        const reclaimedPrivateLocal = await privateLocalRepo.createWorktree(
          lair.root,
          "_reclaimed_private_local",
          "l/test-lair/w/to-fully-delete/local",
        );
        expect(reclaimedPrivateLocal.branch).toBe("l/test-lair/w/to-fully-delete/local");
        await privateLocalRepo.removeWorktree(reclaimedPrivateLocal);

        const reclaimedPrivateGlobal = await privateGlobalRepo.createWorktree(
          lair.root,
          "_reclaimed_private_global",
          "l/test-lair/w/to-fully-delete/global",
        );
        expect(reclaimedPrivateGlobal.branch).toBe("l/test-lair/w/to-fully-delete/global");
        await privateGlobalRepo.removeWorktree(reclaimedPrivateGlobal);

        void wing; // constructed only to be torn down by deleteWing() above
      });
    });

    // ========================================
    // Wing Work Areas
    // ========================================

    describe("Wing work areas", () => {
      it("workLocal() provides worktree access", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const wing = await lair.createWing("workshop", {
          workLocal: { repo: "main-repo", branch: "main" },
        });

        const result = await wing.workLocal();
        expect(result.exists).toBe(true);
        if (result.exists) {
          // Can create files in the worktree
          await result.worktree.createFile("test.txt", "content");
          expect(await result.worktree.isDirty()).toBe(true);
        }
      });

      it("workGlobal() returns exists:false when not configured", async () => {
        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const wing = await lair.createWing("workshop", {
          workLocal: { repo: "main-repo", branch: "main" },
          // No workGlobal configured
        });

        const result = await wing.workGlobal();
        expect(result.exists).toBe(false);
      });
    });

    // ========================================
    // Wing Junction Links
    // ========================================

    describe("Wing junction links", () => {
      it("info() returns junction to lair info directory", async () => {
        // Set up info directory
        await ensureDirectory(lair.root, "info");

        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const wing = await lair.createWing("workshop", {
          workLocal: { repo: "main-repo", branch: "main" },
        });

        await wing.setupInfoLink();
        const info = await wing.info();

        expect(info.kind).toBe("junction");
      });

      it("closet() returns junction to lair closet directory", async () => {
        // Ensure closet exists
        await lair.closet();

        const workDir = await ensureDirectory(lair.root, "work");
        const repo = await lair.sandbox.initBare(workDir, "main-repo.git");

        const tempWorktree = await repo.createWorktree(
          lair.root,
          "_temp",
          "main"
        );
        await tempWorktree.createFile("README.md", "# Initial");
        await tempWorktree.commitAll("Initial commit");
        await repo.removeWorktree(tempWorktree);

        const wing = await lair.createWing("workshop", {
          workLocal: { repo: "main-repo", branch: "main" },
        });

        await wing.setupClosetLink();
        const closet = await wing.closet();

        expect(closet.kind).toBe("junction");
      });
    });

    // ========================================
    // Closet Operations
    // ========================================

    describe("Closet operations", () => {
      it("closet() creates and returns closet directory", async () => {
        const closet = await lair.closet();
        expect(closet.kind).toBe("directory");
        expect(await closet.exists()).toBe(true);
      });

      it("closet() is idempotent", async () => {
        const closet1 = await lair.closet();
        await closet1.createFile("shared.txt", "data");

        const closet2 = await lair.closet();
        const children = await closet2.children();

        expect(children.length).toBe(1);
        expect(children[0].name).toBe("shared.txt");
      });
    });

    // ========================================
    // Cabinet Operations
    // ========================================

    describe("Cabinet operations", () => {
      it("cabinet() creates and returns cabinet directory", async () => {
        const cabinet = await lair.cabinet();
        expect(cabinet.kind).toBe("directory");
        expect(await cabinet.exists()).toBe(true);
      });

      it("cabinet() is idempotent and distinct from closet()", async () => {
        const cabinet1 = await lair.cabinet();
        await cabinet1.createFile("session.json", "{}");

        const cabinet2 = await lair.cabinet();
        const children = await cabinet2.children();

        expect(children.length).toBe(1);
        expect(children[0].name).toBe("session.json");

        const closet = await lair.closet();
        expect(closet.path).not.toBe(cabinet1.path);
      });
    });
  });
}

// ========================================
// Helper Functions
// ========================================

import type { Directory } from "../port/types.js";

/**
 * Ensures a directory exists, creating it if necessary.
 */
async function ensureDirectory(
  parent: Directory,
  name: string
): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.is("directory")) {
    return result.node as Directory;
  }
  return parent.createDirectory(name);
}
