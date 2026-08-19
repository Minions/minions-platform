import { describe, it, expect } from "vitest";
import {
  createInMemorySandbox,
  createInMemoryWorkAreaFactories,
  createWorkArea,
  createScratchpad,
  createLair,
} from "../../src/index.js";
import type { BareRepository, Directory, Worktree } from "../../src/index.js";

/**
 * Proves the design doc §4.2 (end of section) `WorkArea`/`Scratchpad`
 * invariants against the InMemory adapter:
 *
 *  - `WorkArea.activeMovement()` returns a `CheckedOutMovement` for whatever
 *    branch is currently checked out, with `base` resolved from the
 *    worktree's own `baseBranch()` (falling back to the repo's root trunk
 *    when no override has ever been set)
 *  - `WorkArea.beginNewActiveMovement()` creates+checks-out a new branch,
 *    persists the base it used (`setBaseBranch`) so a later
 *    `activeMovement()` call reconstructs the SAME base, and honors the
 *    `opts.base`/`opts.from` resolution rules
 *  - `Scratchpad.commit()`/`reset()` — no base, no merge, ephemeral
 *  - `Wing.workAreaLocal()`/`scratchpad()` wire the above through
 *    `createLair(sandbox, workAreaFactories)`
 */

async function makeRepoWithBranch(branch = "main"): Promise<{ sandboxRoot: Directory; repo: BareRepository }> {
  const sandbox = createInMemorySandbox();
  const repo = await sandbox.initBare(sandbox.root, "repo");
  const seed = await repo.createWorktree(sandbox.root, "seed", branch);
  await seed.createFile("README.md", "hello");
  await seed.commitAll("initial commit");
  await repo.removeWorktree(seed);
  return { sandboxRoot: sandbox.root, repo };
}

describe("WorkArea/Scratchpad (in-memory)", () => {
  describe("WorkArea.activeMovement()", () => {
    it("returns a CheckedOutMovement for the worktree's currently checked-out branch, base defaulting to the repo's root trunk", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local", "wip/local");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      expect(am.branch).toBe("wip/local");
      expect(am.base.branch).toBe("main");
    });

    it("landing a movement through activeMovement() publishes onto the repo's root trunk", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local", "wip/local2");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      await am.files.createFile("feature.txt", "v1");
      await am.commit({ message: "add feature" });
      const mergeResult = await am.merge({});
      expect(mergeResult.status).toBe("success");

      const mainWorktree = await repo.createWorktree(sandboxRoot, "check-main", "main");
      const featureResult = await mainWorktree.child("feature.txt");
      expect(featureResult.found).toBe(true);
    });

    it("push() force-pushes the movement's own branch without throwing (design doc §4.3 — MovementSession.commit()'s replacement for Worktree.forcePush())", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local3", "wip/pushme");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);

      const am = await workArea.activeMovement();
      await am.files.createFile("feature.txt", "v1");
      await am.commit({ message: "add feature" });

      await expect(am.push()).resolves.not.toThrow();
    });
  });

  describe("WorkArea.beginNewActiveMovement()", () => {
    it("creates and checks out a new branch off the given base, and a later activeMovement() reconstructs the SAME base", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local", "wip/original");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);
      const rootTrunk = factories.createTrunk(repo, "main");

      const started = await workArea.beginNewActiveMovement("wip/fresh", { base: rootTrunk });
      expect(started.branch).toBe("wip/fresh");
      expect(started.base.branch).toBe("main");
      expect(await worktree.currentBranch()).toBe("wip/fresh");

      // A later, independently-reconstructed activeMovement() call must
      // resolve the SAME base — proves the base was persisted (via
      // Worktree.setBaseBranch()), not just returned once and forgotten.
      const again = await workArea.activeMovement();
      expect(again.branch).toBe("wip/fresh");
      expect(again.base.branch).toBe("main");
    });

    it("branching off a Movement inherits that movement's OWN base, not the movement's branch", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local", "wip/parent");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);
      const rootTrunk = factories.createTrunk(repo, "main");

      const parentMovement = await workArea.beginNewActiveMovement("wip/parent-movement", { base: rootTrunk });
      await parentMovement.files.createFile("parent.txt", "content");
      await parentMovement.commit({ message: "parent work" });

      const child = await workArea.beginNewActiveMovement("wip/child-movement", { from: parentMovement });
      // Inherits `parentMovement.base` (main), NOT `parentMovement.branch`
      // (`wip/parent-movement`) — design doc §4.2's explicit rule.
      expect(child.base.branch).toBe("main");
      expect(child.branch).toBe("wip/child-movement");
      // But the new branch is seeded from the parent movement's CONTENT
      // (its branch tip), so the file it committed is present.
      const parentFileResult = await child.files.child("parent.txt");
      expect(parentFileResult.found).toBe(true);
    });

    it("throws when opts.base is omitted and opts.from is a bare CommitRef (or omitted entirely)", async () => {
      const { repo, sandboxRoot } = await makeRepoWithBranch("main");
      const worktree = await repo.createWorktree(sandboxRoot, "work-local", "wip/orig2");
      const factories = createInMemoryWorkAreaFactories("scratch");
      const workArea = createWorkArea(repo, worktree, factories);

      await expect(workArea.beginNewActiveMovement("wip/no-base")).rejects.toThrow(/opts\.base.*is required/);

      const mainTip = await repo.resolveLocalRef("main");
      if (mainTip === null) throw new Error("expected main to have a tip");
      await expect(workArea.beginNewActiveMovement("wip/no-base2", { from: mainTip as never })).rejects.toThrow(
        /opts\.base.*is required/,
      );
    });
  });

  describe("Scratchpad", () => {
    async function makeScratchpad(): Promise<{ repo: BareRepository; worktree: Worktree }> {
      const { repo, sandboxRoot } = await makeRepoWithBranch("scratch");
      const worktree = await repo.createWorktree(sandboxRoot, "private-local", "scratch");
      return { repo, worktree };
    }

    it("commit() checkpoints whatever is currently in files", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("note.txt", "hello");
      const hash = await scratchpad.commit("checkpoint");
      expect(typeof hash).toBe("string");
      expect(await repo.resolveLocalRef("scratch")).toBe(hash);
    });

    it("reset() discards all content, leaving the working tree empty", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("note.txt", "hello");
      await scratchpad.commit("checkpoint");
      const tipBeforeReset = await repo.resolveLocalRef("scratch");

      await scratchpad.reset();

      const children = await scratchpad.files.children();
      expect(children).toEqual([]);
      const tipAfterReset = await repo.resolveLocalRef("scratch");
      expect(tipAfterReset).not.toBe(tipBeforeReset);

      const readmeResult = await scratchpad.files.child("README.md");
      expect(readmeResult.found).toBe(false);
    });

    it("reset() on an already-empty scratchpad doesn't throw", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(sandbox.root, "empty-repo");
      const worktree = await repo.createWorktree(sandbox.root, "private-local", "scratch");
      const scratchpad = createScratchpad(repo, worktree);

      await expect(scratchpad.reset()).resolves.not.toThrow();
    });

    it("branch()/checkout() create and switch to a real local branch, with commits landing on whichever one is checked out", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("note.txt", "on scratch");
      const scratchTip = await scratchpad.commit("checkpoint on scratch");

      await scratchpad.branch("side-quest");
      expect(await worktree.currentBranch()).toBe("scratch"); // branch() alone doesn't switch
      await scratchpad.checkout("side-quest");
      expect(await worktree.currentBranch()).toBe("side-quest");

      // The new branch was created at "scratch"'s tip, so the file committed
      // there is visible immediately after switching.
      const noteResult = await scratchpad.files.child("note.txt");
      expect(noteResult.found).toBe(true);

      await scratchpad.files.createFile("side.txt", "only on side-quest");
      const sideTip = await scratchpad.commit("checkpoint on side-quest");
      expect(sideTip).not.toBe(scratchTip);

      // "scratch" itself is untouched by work done on "side-quest".
      await scratchpad.checkout("scratch");
      expect(await repo.resolveLocalRef("scratch")).toBe(scratchTip);
      const sideFileOnScratch = await scratchpad.files.child("side.txt");
      expect(sideFileOnScratch.found).toBe(false);
    });

    it("branch() with an explicit `from` seeds the new branch there, not from the current checkout", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("v1.txt", "v1");
      const v1 = await scratchpad.commit("v1");
      await scratchpad.files.createFile("v2.txt", "v2");
      await scratchpad.commit("v2");

      // Branch off the v1 commit specifically, even though "scratch" has since moved on.
      await scratchpad.branch("from-v1", { from: v1 });
      await scratchpad.checkout("from-v1");

      const v1File = await scratchpad.files.child("v1.txt");
      expect(v1File.found).toBe(true);
      const v2File = await scratchpad.files.child("v2.txt");
      expect(v2File.found).toBe(false);
    });

    it("checkout() switches between two branches created ahead of time via branch(), each with its own independent content", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("base.txt", "shared ancestor content");
      const baseTip = await scratchpad.commit("base checkpoint");

      await scratchpad.branch("branch-a", { from: baseTip });
      await scratchpad.branch("branch-b", { from: baseTip });

      await scratchpad.checkout("branch-a");
      expect(await worktree.currentBranch()).toBe("branch-a");
      await scratchpad.files.createFile("a-only.txt", "a");
      await scratchpad.commit("a work");

      await scratchpad.checkout("branch-b");
      expect(await worktree.currentBranch()).toBe("branch-b");
      const aFileOnB = await scratchpad.files.child("a-only.txt");
      expect(aFileOnB.found).toBe(false);
      const baseFileOnB = await scratchpad.files.child("base.txt");
      expect(baseFileOnB.found).toBe(true);

      await scratchpad.checkout("branch-a");
      const aFileAgain = await scratchpad.files.child("a-only.txt");
      expect(aFileAgain.found).toBe(true);
    });

    it("backtrack() hard-resets the current branch to an earlier commit, and later commits become unreachable", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await scratchpad.files.createFile("keep.txt", "kept");
      const goodTip = await scratchpad.commit("good checkpoint");

      await scratchpad.files.createFile("oops.txt", "mistake");
      const badTip = await scratchpad.commit("bad checkpoint");
      expect(badTip).not.toBe(goodTip);

      await scratchpad.backtrack(goodTip);

      expect(await repo.resolveLocalRef("scratch")).toBe(goodTip);
      const oopsFile = await scratchpad.files.child("oops.txt");
      expect(oopsFile.found).toBe(false);
      const keepFile = await scratchpad.files.child("keep.txt");
      expect(keepFile.found).toBe(true);

      // A real discard, not just a moved pointer: with nothing else in this
      // repo referencing it, the discarded commit is no longer reachable
      // from any branch this repo exposes.
      const branches = await repo.branches();
      for (const branchName of branches) {
        const tip = await repo.resolveLocalRef(branchName);
        expect(tip).not.toBe(badTip);
      }
    });

    it("checkout() throws on a branch that doesn't exist yet, rather than silently creating it", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      await expect(scratchpad.checkout("never-created")).rejects.toThrow(/doesn't exist/);
      // Confirm it genuinely wasn't created as a side effect of the failed attempt.
      expect(await repo.resolveLocalRef("never-created")).toBeNull();
      expect(await worktree.currentBranch()).toBe("scratch");
    });

    it("has no push/fetch/pull surface — local-only by construction, not just by convention", async () => {
      const { repo, worktree } = await makeScratchpad();
      const scratchpad = createScratchpad(repo, worktree);

      expect((scratchpad as unknown as Record<string, unknown>)["push"]).toBeUndefined();
      expect((scratchpad as unknown as Record<string, unknown>)["fetch"]).toBeUndefined();
      expect((scratchpad as unknown as Record<string, unknown>)["pull"]).toBeUndefined();
      expect((scratchpad as unknown as Record<string, unknown>)["pushBranch"]).toBeUndefined();

      // And even the underlying repo — reachable only via `.files`' raw
      // Worktree escape hatch, never via Scratchpad's own surface — has
      // nothing configured to push to.
      expect(repo.url).toBeNull();
    });
  });

  describe("Wing wiring (createLair with workAreaFactories)", () => {
    it("workAreaLocal()/scratchpad() work once workAreaFactories is supplied to createLair()", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(await sandbox.root.createDirectory("work"), "local.git");
      const seed = await repo.createWorktree(sandbox.root, "seed", "main");
      await seed.createFile("README.md", "hello");
      await seed.commitAll("initial commit");
      await repo.removeWorktree(seed);

      await sandbox.initBare(await sandbox.root.createDirectory("private"), "local");

      const factories = createInMemoryWorkAreaFactories("scratch");
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
    });

    it("workAreaLocal() throws a clear error when the wing was constructed WITHOUT workAreaFactories", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(await sandbox.root.createDirectory("work"), "local.git");
      const seed = await repo.createWorktree(sandbox.root, "seed", "main");
      await seed.createFile("README.md", "hello");
      await seed.commitAll("initial commit");
      await repo.removeWorktree(seed);

      const lair = createLair(sandbox); // no workAreaFactories
      const wing = await lair.createWing("test-wing-2", {
        workLocal: { repo: "local", branch: "wip/wing-local2" },
      });

      await expect(wing.workAreaLocal()).rejects.toThrow(/WorkAreaFactories/);
      // scratchpad() needs no factories — but this wing has no private/local set up.
      await expect(wing.scratchpad()).rejects.toThrow(/private\/local/);
    });

    it("workAreaLocalIfExists() returns undefined (not a throw) when work/local isn't set up", async () => {
      const sandbox = createInMemorySandbox();
      const factories = createInMemoryWorkAreaFactories("scratch");
      const lair = createLair(sandbox, factories);
      // No workLocal in the config at all — mirrors a wing with no repo checkout.
      const wing = await lair.createWing("test-wing-3", {
        workLocal: { repo: "nonexistent-repo", branch: "wip/never-created" },
      });

      await expect(wing.workAreaLocalIfExists()).resolves.toBeUndefined();
      // The throwing sibling reports the same absence as a real error.
      await expect(wing.workAreaLocal()).rejects.toThrow(/work\/local/);
    });

    it("workAreaLocalIfExists() returns a real WorkArea once work/local IS set up", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(await sandbox.root.createDirectory("work"), "local.git");
      const seed = await repo.createWorktree(sandbox.root, "seed", "main");
      await seed.createFile("README.md", "hello");
      await seed.commitAll("initial commit");
      await repo.removeWorktree(seed);

      const factories = createInMemoryWorkAreaFactories("scratch");
      const lair = createLair(sandbox, factories);
      const wing = await lair.createWing("test-wing-4", {
        workLocal: { repo: "local", branch: "wip/wing-local4" },
      });

      const workArea = await wing.workAreaLocalIfExists();
      if (!workArea) throw new Error("expected a WorkArea");
      const am = await workArea.activeMovement();
      expect(am.branch).toBe("wip/wing-local4");
    });
  });

  describe("Wing.namedWorkPath()", () => {
    it("returns undefined for a name that doesn't exist", async () => {
      const sandbox = createInMemorySandbox();
      const factories = createInMemoryWorkAreaFactories("scratch");
      const lair = createLair(sandbox, factories);
      const wing = await lair.createWing("test-wing-5", {
        workLocal: { repo: "nonexistent-repo", branch: "wip/never" },
      });

      await expect(wing.namedWorkPath("nope" as never)).resolves.toBeUndefined();
    });

    it("returns the raw path for a real named worktree entry (no subdir — full worktree kind)", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(await sandbox.root.createDirectory("work"), "local.git");
      const seed = await repo.createWorktree(sandbox.root, "seed", "main");
      await seed.createFile("README.md", "hello");
      await seed.commitAll("initial commit");
      await repo.removeWorktree(seed);

      const factories = createInMemoryWorkAreaFactories("scratch");
      const lair = createLair(sandbox, factories);
      const wing = await lair.createWing("test-wing-6", {
        workLocal: { repo: "local", branch: "wip/wing-local6" },
        extraWork: { extra: { repo: "local", branch: "wip/extra6" } },
      });

      const path = await wing.namedWorkPath("extra" as never);
      expect(typeof path).toBe("string");
      const named = await wing.workNamed("extra" as never);
      expect(named.exists && named.path).toBe(path);
    });

    it("returns the raw path for a plain-junction named entry — the one case workAreaNamed() can never build a WorkArea for", async () => {
      const sandbox = createInMemorySandbox();
      const repo = await sandbox.initBare(await sandbox.root.createDirectory("work"), "local.git");
      const seed = await repo.createWorktree(sandbox.root, "seed", "main");
      await seed.createFile("README.md", "hello");
      await seed.createDirectory("sub");
      await seed.commitAll("initial commit");
      await repo.removeWorktree(seed);

      const factories = createInMemoryWorkAreaFactories("scratch");
      const lair = createLair(sandbox, factories);
      // Same repo checked out at work/local AND as a same-repo subdir junction
      // at work/sub — LairWing.addWorkNamed's "Case 1 (same-repo)" branch,
      // which produces a plain `junction` (no worktree of its own).
      const wing = await lair.createWing("test-wing-7", {
        workLocal: { repo: "local", branch: "wip/wing-local7" },
        extraWork: { sub: { repo: "local", branch: "wip/wing-local7", subdir: "sub" } },
      });

      const named = await wing.workNamed("sub" as never);
      expect(named.exists && named.kind).toBe("junction");

      // workAreaNamed() collapses this case to undefined — no repo to attach
      // a Trunk/Movement to.
      await expect(wing.workAreaNamed("sub" as never)).resolves.toBeUndefined();

      // namedWorkPath() still reports the real path.
      const path = await wing.namedWorkPath("sub" as never);
      expect(typeof path).toBe("string");
      expect(named.exists && named.path).toBe(path);
    });
  });
});
