/**
 * Proves the design doc §4.2 (end of section) `WorkArea`/`Scratchpad`
 * invariants against the Disk adapter and REAL git:
 *
 *  - `WorkArea.activeMovement()`/`beginNewActiveMovement()` reuse the SAME
 *    real worktree a wing's `work/local` already has set up (real git
 *    refuses a second worktree checked out on the same branch), rather than
 *    creating a redundant second worktree elsewhere
 *  - `beginNewActiveMovement()` persists the base it used
 *    (`Worktree.setBaseBranch()`) so a later `activeMovement()` call
 *    reconstructs the SAME base
 *  - `Scratchpad.reset()` really does build a genuinely PARENTLESS commit on
 *    real git (`git rev-list --parents`), not just an empty working tree
 *    with old history still attached
 *  - `Wing.workAreaLocal()`/`scratchpad()` wire the above through
 *    `createLair(sandbox, workAreaFactories)`
 *
 * See `__tests__/memory-specific/work-area.test.ts` for the parallel
 * InMemory suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import { createDiskWorkAreaFactories } from "../../src/adapters/disk/index.js";
import { createWorkArea, createScratchpad } from "../../src/lair/SiteWorkArea.js";
import { createLair } from "../../src/lair/LairImpl.js";
import type { BareRepository, Directory } from "../../src/index.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

useRealGitTimeout();

function originRef(originPath: string, ref: string): string | null {
  try {
    return execSync(`git rev-parse --verify -q "refs/heads/${ref}"`, {
      cwd: originPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function parentCount(repoPath: string, hash: string): number {
  const line = execSync(`git rev-list --parents -n 1 ${hash}`, { cwd: repoPath, encoding: "utf-8" }).trim();
  return line.split(" ").length - 1;
}

describe("WorkArea/Scratchpad (disk)", () => {
  let tmpDir: string;
  let sandbox: DiskSandbox;
  let originPath: string;
  let repo: BareRepository;
  let scratchRoot: Directory;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "disk-work-area-"));
    sandbox = new DiskSandbox(tmpDir);
    originPath = join(tmpDir, "origin.git");
    mkdirSync(originPath);
    execSync("git init --bare -q", { cwd: originPath });

    repo = await sandbox.cloneBare(originPath, sandbox.root, "clone.git");

    const seed = await repo.createWorktree(sandbox.root, "seed-wt", "seed");
    await seed.createFile("README.md", "hello");
    const firstHash = await seed.commitAll("initial commit");
    await repo.updateBranch("main", firstHash);
    await repo.pushBranch("main");

    scratchRoot = await sandbox.root.createDirectory("scratch");
  });

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  });

  describe("WorkArea.activeMovement()", () => {
    it("returns a CheckedOutMovement for the worktree's currently checked-out branch, base defaulting to the root trunk", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/local");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      expect(am.branch).toBe("wip/local");
      expect(am.base.branch).toBe("main");
    });

    it("landing a movement through activeMovement() publishes onto real origin's main", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local2");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/local2");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      await am.files.createFile("feature.txt", "v1");
      await am.commit({ message: "add feature" });
      const mergeResult = await am.merge({});
      expect(mergeResult.status).toBe("success");

      expect(originRef(originPath, "main")).not.toBeNull();
      const mainCheckDir = await sandbox.root.createDirectory("check-main");
      const mainWorktree = await repo.createWorktree(mainCheckDir, "checkout", "main");
      const featureResult = await mainWorktree.child("feature.txt");
      expect(featureResult.found).toBe(true);
    });

    it("push() force-pushes the movement's own branch to real origin without throwing (design doc §4.3 — MovementSession.commit()'s replacement for Worktree.forcePush())", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local-push");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/pushme");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      await am.files.createFile("feature.txt", "v1");
      await am.commit({ message: "add feature" });

      await am.push();
      expect(originRef(originPath, "wip/pushme")).not.toBeNull();
    });
  });

  describe("WorkArea.beginNewActiveMovement()", () => {
    it("creates and checks out a new branch off the given base IN THE SAME real worktree, and a later activeMovement() reconstructs the SAME base", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local3");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/original");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);
      const rootTrunk = factories.createTrunk(repo, "main");

      const started = await workArea.beginNewActiveMovement("wip/fresh", { base: rootTrunk });
      expect(started.branch).toBe("wip/fresh");
      expect(started.base.branch).toBe("main");
      expect(await worktree.currentBranch()).toBe("wip/fresh");

      // Real git allows exactly one worktree per branch — this only works if
      // beginNewActiveMovement() switched the EXISTING worktree in place,
      // rather than trying to create a second one.
      const again = await workArea.activeMovement();
      expect(again.branch).toBe("wip/fresh");
      expect(again.base.branch).toBe("main");
    });

    it("branching off a Movement inherits that movement's OWN base, not the movement's branch", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local4");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/parent");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);
      const rootTrunk = factories.createTrunk(repo, "main");

      const parentMovement = await workArea.beginNewActiveMovement("wip/parent-movement", { base: rootTrunk });
      await parentMovement.files.createFile("parent.txt", "content");
      await parentMovement.commit({ message: "parent work" });

      const child = await workArea.beginNewActiveMovement("wip/child-movement", { from: parentMovement });
      expect(child.base.branch).toBe("main");
      expect(child.branch).toBe("wip/child-movement");
      const parentFileResult = await child.files.child("parent.txt");
      expect(parentFileResult.found).toBe(true);
    });

    it("throws when opts.base is omitted and opts.from is a bare CommitRef (or omitted entirely)", async () => {
      const workLocalDir = await sandbox.root.createDirectory("work-local5");
      const worktree = await repo.createWorktree(workLocalDir, "checkout", "wip/orig2");
      const factories = createDiskWorkAreaFactories(scratchRoot);
      const workArea = createWorkArea(repo, worktree, factories);

      await expect(workArea.beginNewActiveMovement("wip/no-base")).rejects.toThrow(/opts\.base.*is required/);
    });
  });

  describe("Scratchpad", () => {
    it("reset() builds a genuinely PARENTLESS commit on real git, not just an empty working tree", async () => {
      const privateDir = await sandbox.root.createDirectory("private-local");
      const privateOriginPath = join(tmpDir, "private-origin.git");
      mkdirSync(privateOriginPath);
      execSync("git init --bare -q", { cwd: privateOriginPath });
      const privateRepo = await sandbox.cloneBare(privateOriginPath, sandbox.root, "private-clone.git");
      const worktree = await privateRepo.createWorktree(privateDir, "checkout", "scratch");
      await worktree.createFile("note.txt", "hello");
      const firstHash = await worktree.commitAll("first checkpoint");
      expect(parentCount(worktree.path, firstHash)).toBe(0); // the repo's very first commit is already parentless

      await worktree.createFile("second.txt", "more");
      const secondHash = await worktree.commitAll("second checkpoint");
      expect(parentCount(worktree.path, secondHash)).toBe(1); // has a real parent now

      const scratchpad = createScratchpad(privateRepo, worktree);
      await scratchpad.reset();

      const childrenAfter = await scratchpad.files.children();
      expect(childrenAfter).toEqual([]);
      const tipAfterReset = await privateRepo.resolveLocalRef("scratch");
      expect(tipAfterReset).not.toBeNull();
      expect(tipAfterReset).not.toBe(secondHash);
      // The whole point of reset(): the new tip has NO parent, so the prior
      // (real) commit history is unreachable from the branch tip.
      expect(parentCount(worktree.path, tipAfterReset as string)).toBe(0);
    });

    it("branch()/checkout()/backtrack() are real git operations, and the backing repo has no remote to push to", async () => {
      // Matches production's REAL shape (WingCreation.integration.ts): a
      // private/local bare repo created via initBare(), never cloned from
      // any origin — "local-only, nothing to push to" by construction, not
      // just by Scratchpad's own interface omitting push().
      const privateDir = await sandbox.root.createDirectory("private-local2");
      const privateRepo = await sandbox.initBare(await sandbox.root.createDirectory("private-bare"), "local");
      const worktree = await privateRepo.createWorktree(privateDir, "checkout", "scratch");
      expect(privateRepo.url).toBeNull();

      const scratchpad = createScratchpad(privateRepo, worktree);

      await scratchpad.files.createFile("keep.txt", "kept");
      const goodTip = await scratchpad.commit("good checkpoint");

      await scratchpad.branch("side-quest");
      await scratchpad.checkout("side-quest");
      expect(await worktree.currentBranch()).toBe("side-quest");
      await scratchpad.files.createFile("side.txt", "only on side-quest");
      await scratchpad.commit("side work");

      await scratchpad.checkout("scratch");
      const sideFileOnScratch = await scratchpad.files.child("side.txt");
      expect(sideFileOnScratch.found).toBe(false);

      await scratchpad.files.createFile("oops.txt", "mistake");
      const badTip = await scratchpad.commit("bad checkpoint");

      await scratchpad.backtrack(goodTip);
      expect(await privateRepo.resolveLocalRef("scratch")).toBe(goodTip);
      const oopsFile = await scratchpad.files.child("oops.txt");
      expect(oopsFile.found).toBe(false);

      // Real discard: `git cat-file` still finds the loose object (nothing
      // ran gc yet), but no branch this repo exposes reaches it anymore.
      expect(() => execSync(`git cat-file -e ${badTip}`, { cwd: worktree.path })).not.toThrow();
      for (const branchName of await privateRepo.branches()) {
        expect(await privateRepo.resolveLocalRef(branchName)).not.toBe(badTip);
      }

      // No remote configured at all — a raw push attempt (only reachable by
      // casting through `.files`' documented Worktree escape hatch, never
      // through Scratchpad's own surface) fails for lack of anywhere to push.
      await expect(worktree.push()).rejects.toThrow();
    });
  });

  describe("Wing wiring (createLair with workAreaFactories)", () => {
    it("checkout() throws on a branch that doesn't exist yet, rather than silently creating it (real git)", async () => {
      const privateDir = await sandbox.root.createDirectory("private-local3");
      const privateRepo = await sandbox.initBare(await sandbox.root.createDirectory("private-bare2"), "local");
      const worktree = await privateRepo.createWorktree(privateDir, "checkout", "scratch");
      const scratchpad = createScratchpad(privateRepo, worktree);

      await expect(scratchpad.checkout("never-created")).rejects.toThrow(/doesn't exist/);
      expect(await privateRepo.resolveLocalRef("never-created")).toBeNull();
      expect(await worktree.currentBranch()).toBe("scratch");
    });

    it("workAreaLocal()/scratchpad() work once workAreaFactories is supplied to createLair()", async () => {
      const workDir = await sandbox.root.createDirectory("work");
      const localRepo = await sandbox.cloneBare(originPath, workDir, "local.git");

      const privateDir = await sandbox.root.createDirectory("private");
      const privateOriginPath = join(tmpDir, "private-origin2.git");
      mkdirSync(privateOriginPath);
      execSync("git init --bare -q", { cwd: privateOriginPath });
      await sandbox.cloneBare(privateOriginPath, privateDir, "local");

      const factories = createDiskWorkAreaFactories(scratchRoot);
      const lair = createLair(sandbox, factories);
      const wing = await lair.createWing("test-wing", {
        workLocal: { repo: "local", branch: "wip/wing-local" },
        privateLocal: { branch: "scratch-branch" },
      });

      const workArea = await wing.workAreaLocal();
      const am = await workArea.activeMovement();
      expect(am.branch).toBe("wip/wing-local");
      expect(am.base.branch).toBe("main");

      const scratchpad = await wing.scratchpad();
      await scratchpad.files.createFile("x.txt", "y");
      const hash = await scratchpad.commit("checkpoint");
      expect(typeof hash).toBe("string");
      void localRepo;
    });

    it("workAreaLocal() throws a clear error when the wing was constructed WITHOUT workAreaFactories", async () => {
      const workDir = await sandbox.root.createDirectory("work");
      await sandbox.cloneBare(originPath, workDir, "local.git");

      const lair = createLair(sandbox); // no workAreaFactories
      const wing = await lair.createWing("test-wing-2", {
        workLocal: { repo: "local", branch: "wip/wing-local2" },
      });

      await expect(wing.workAreaLocal()).rejects.toThrow(/WorkAreaFactories/);
      await expect(wing.scratchpad()).rejects.toThrow(/private\/local/);
    });
  });
});
