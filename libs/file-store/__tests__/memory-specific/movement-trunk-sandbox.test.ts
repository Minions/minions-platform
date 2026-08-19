import { describe, it, expect } from "vitest";
import {
  createInMemorySandbox,
  createInMemoryTrunk,
  createInMemoryCheckedOutMovement,
} from "../../src/index.js";
import type { BareRepository, Directory, Trunk, DerivedTrunk, CheckedOutMovement, Worktree } from "../../src/index.js";
import { asGitRef } from "../../src/index.js";
import type { InMemoryBareRepository } from "../../src/adapters/memory/InMemoryBareRepository.js";

/**
 * Proves the invariants design doc §4.1 calls out for the Sandbox-layer
 * types (`Movement`, `CheckedOutMovement`, `Trunk`, `DerivedTrunk`,
 * `Mirror`) against the InMemory adapter:
 *
 *  - CAS publish (§2 invariant A)
 *  - fast-forward-only realignment never destroys anything
 *  - `Movement.state()` derivation (undefined / in-progress / integrated)
 *  - movement history staying merge-commit-free
 *  - `Trunk`/`DerivedTrunk` never getting checked out
 */

async function makeRepo(): Promise<{ sandboxRoot: Directory; repo: BareRepository; trunk: Trunk }> {
  const sandbox = createInMemorySandbox();
  const repo = await sandbox.initBare(sandbox.root, "repo");
  // Seed `main` with an initial commit so it's a resolvable ref — mirrors a
  // freshly-initialized real repo's first commit. The seeding worktree is
  // removed immediately after: InMemory (like real git) refuses two
  // worktrees checked out on the same branch at once, and nothing under
  // test should ever find a worktree sitting on `main` that it didn't
  // create itself.
  const seed = await repo.createWorktree(sandbox.root, "seed", "main");
  await seed.createFile("README.md", "hello");
  await seed.commitAll("initial commit");
  await repo.removeWorktree(seed);

  const trunk = createInMemoryTrunk(repo, "main", "tools");
  return { sandboxRoot: sandbox.root, repo, trunk };
}

/**
 * Writes directly to `main` outside of any Movement/Mirror machinery —
 * simulates "some other actor advanced the shared branch" — then cleans up
 * its own worktree so `main` is free for the next thing under test to check
 * out (mirrors InMemory's one-worktree-per-branch rule, same as real git).
 */
async function commitDirectlyToMain(
  sandboxRoot: Directory,
  repo: BareRepository,
  worktreeName: string,
  fileName: string,
  message: string,
): Promise<string> {
  const wt = await repo.createWorktree(sandboxRoot, worktreeName, "main");
  await wt.createFile(fileName, "x");
  const hash = await wt.commitAll(message);
  await repo.removeWorktree(wt);
  return hash;
}

/** Same as `commitDirectlyToMain`, but against an arbitrary branch — used to simulate a genuinely independent actor advancing a DERIVED trunk's branch directly. */
async function commitDirectlyToBranch(
  sandboxRoot: Directory,
  repo: BareRepository,
  branch: string,
  worktreeName: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> {
  const wt = await repo.createWorktree(sandboxRoot, worktreeName, branch);
  await wt.createFile(fileName, content);
  const hash = await wt.commitAll(message);
  await repo.removeWorktree(wt);
  return hash;
}

describe("Movement/Trunk sandbox layer (in-memory)", () => {
  describe("Movement.state()", () => {
    it("is 'undefined' when the branch doesn't exist locally", async () => {
      const { trunk } = await makeRepo();
      const movement = trunk.movement("wip/never-created");
      expect(await movement.state()).toBe("undefined");
    });

    it("is 'in-progress' once the branch exists and has diverged from base", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "diverge" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.state()).toBe("in-progress");
    });

    it("is 'integrated' when the branch never diverged from base", async () => {
      const { repo, trunk } = await makeRepo();
      await repo.createBranchIfMissing("wip/same-as-base", "main");
      const movement = trunk.movement("wip/same-as-base");
      expect(await movement.state()).toBe("integrated");
    });

    it("is 'integrated' after a clean merge, even though base has since moved further", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const movement = trunk.movement("wip/feature");
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "content");
      await checkedOut.commit({ message: "add feature" });

      expect(await movement.state()).toBe("in-progress");
      const mergeResult = await checkedOut.merge({});
      expect(mergeResult.status).toBe("success");
      expect(await movement.state()).toBe("integrated");

      await commitDirectlyToMain(sandboxRoot, repo, "other", "unrelated.txt", "unrelated change");

      expect(await movement.state()).toBe("integrated");
    });
  });

  describe("Movement.readFileAtRef() — read-only, base-independent (design doc §4.1)", () => {
    it("reads a file's content as it existed at a specific ref, without touching any worktree", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("feature.txt", "v2");
      await checkedOut.commit({ message: "update feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.readFileAtRef(asGitRef(firstHash.hash), "feature.txt")).toBe("v1");
      expect(await movement.readFileAtRef(asGitRef("wip/feature"), "feature.txt")).toBe("v2");
    });

    it("returns null when the file didn't exist at that ref", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.readFileAtRef(asGitRef("wip/feature"), "nonexistent.txt")).toBeNull();
    });

    it("works against a plain Movement handle with no checkout ever created for it", async () => {
      const { trunk } = await makeRepo();
      const movement = trunk.movement("main");
      expect(await movement.readFileAtRef(asGitRef("main"), "README.md")).toBe("hello");
    });
  });

  describe("Movement.tipHash() — read-only, base-independent (design doc §4.1)", () => {
    it("resolves to the branch's current commit sha", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.tipHash()).toBe(firstHash.hash);
    });

    it("returns null when the branch doesn't exist locally yet", async () => {
      const { trunk } = await makeRepo();
      const movement = trunk.movement("wip/never-created");
      expect(await movement.tipHash()).toBeNull();
    });

    it("works against a plain Movement handle with no checkout ever created for it", async () => {
      const { repo, trunk } = await makeRepo();
      const movement = trunk.movement("main");
      expect(await movement.tipHash()).toBe(await repo.resolveLocalRef("main"));
    });
  });

  describe("Movement.changedFiles() — read-only, base-independent (design doc §4.1)", () => {
    it("lists paths changed since base, defaulting both refs", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("other.txt", "v1");
      await checkedOut.commit({ message: "add other.txt" });

      const movement = trunk.movement("wip/feature");
      expect((await movement.changedFiles()).sort()).toEqual(["feature.txt", "other.txt"]);
    });

    it("accepts explicit from/to refs", async () => {
      const { trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("other.txt", "v1");
      await checkedOut.commit({ message: "add other.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.changedFiles(asGitRef(firstHash.hash), asGitRef("wip/feature"))).toEqual(["other.txt"]);
    });

    it("returns an empty array when nothing has diverged from base", async () => {
      const { repo, trunk } = await makeRepo();
      await repo.createBranchIfMissing("wip/same-as-base", "main");
      const movement = trunk.movement("wip/same-as-base");
      expect(await movement.changedFiles()).toEqual([]);
    });
  });

  describe("CheckedOutMovement.merge() — CAS publish", () => {
    it("lands a flattened commit on base and reports the new commit hash", async () => {
      const { repo, trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature" });

      const baseTipBefore = await repo.resolveLocalRef("main");
      const result = await checkedOut.merge({ message: "land feature" });

      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("unreachable");
      const baseTipAfter = await repo.resolveLocalRef("main");
      expect(baseTipAfter).toBe(result.commit);
      expect(baseTipAfter).not.toBe(baseTipBefore);
    });

    it("retries and still lands cleanly when base advances between read and publish (lost-race CAS)", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/racer", "movements");
      await checkedOut.files.createFile("racer.txt", "v1");
      await checkedOut.commit({ message: "racer commit" });

      // Simulate another actor advancing `main` concurrently, after the
      // movement diverged but before this merge() call runs.
      await commitDirectlyToMain(sandboxRoot, repo, "interloper", "interloper.txt", "interloping change");

      const result = await checkedOut.merge({});
      expect(result.status).toBe("success");

      // The interloping commit is still present on `main` — the race was
      // resolved by rebasing/retrying, not by discarding the other write.
      const finalMainWt = await repo.createWorktree(sandboxRoot, "final-check", "main");
      expect(await finalMainWt.child("interloper.txt")).toMatchObject({ found: true });
      expect(await finalMainWt.child("racer.txt")).toMatchObject({ found: true });
    });

    it("returns 'already-up-to-date' when the movement never diverged", async () => {
      const { repo, trunk } = await makeRepo();
      await repo.createBranchIfMissing("wip/noop", "main");
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/noop", "movements");
      const result = await checkedOut.merge({});
      expect(result.status).toBe("already-up-to-date");
    });
  });

  describe("movement history stays merge-commit-free", () => {
    it("landing a multi-commit movement produces exactly one new commit on base", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/multi", "movements");
      await checkedOut.files.createFile("a.txt", "1");
      await checkedOut.commit({ message: "first" });
      await checkedOut.files.createFile("b.txt", "2");
      await checkedOut.commit({ message: "second" });
      await checkedOut.files.createFile("c.txt", "3");
      await checkedOut.commit({ message: "third" });

      const baseTipBefore = await repo.resolveLocalRef("main");
      const movement = trunk.movement("wip/multi");
      expect(await movement.commitsSince()).toHaveLength(3);

      const result = await checkedOut.merge({ message: "land multi" });
      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("unreachable");

      // Exactly one new commit landed on base, regardless of how many
      // commits the movement itself had — that's the "flatten" contract.
      const logWt = await repo.createWorktree(sandboxRoot, "log-check", "main");
      const landedLog = await logWt.log(baseTipBefore ?? "", "main");
      expect(landedLog).toHaveLength(1);
      expect(landedLog[0]?.hash).toBe(result.commit);
    });
  });

  describe("Trunk/DerivedTrunk are never checked out", () => {
    it("no worktree is ever checked out on the trunk's own branch across mirror/movement/merge/derive activity", async () => {
      const { repo, trunk } = await makeRepo();

      const mirror = trunk.mirror("plan");
      await mirror.apply(async (view) => {
        await view.createFile("plan.md", "hello");
      });

      const checkedOut = await createInMemoryCheckedOutMovement(trunk, "wip/feature", "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature" });
      await checkedOut.merge({});

      const derived = trunk.derive("__exp/e1/main");
      const resolveIn = await createInMemoryCheckedOutMovement(trunk, "wip/resolver", "movements");
      await derived.advance(resolveIn);

      const worktrees = await repo.worktrees();
      expect(worktrees.length).toBeGreaterThan(0); // sanity: activity actually happened
      for (const wt of worktrees) {
        expect(wt.branch).not.toBe(trunk.branch);
        expect(wt.branch).not.toBe(derived.branch);
      }
    });
  });

  describe("Mirror.apply() — CAS publish + fast-forward-only realignment", () => {
    it("commits a change and reports the new commit hash", async () => {
      const { trunk } = await makeRepo();
      const mirror = trunk.mirror("plan");

      const { committed, commitHash, result } = await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan");
        return "wrote plan";
      });

      expect(committed).toBe(true);
      expect(commitHash).toBeDefined();
      expect(result).toBe("wrote plan");
    });

    it("reports committed:false and does not publish when the transform makes no change", async () => {
      const { repo, trunk } = await makeRepo();
      const mirror = trunk.mirror("plan");
      await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan");
      });
      const tipBefore = await repo.resolveLocalRef("main");

      const { committed, commitHash } = await mirror.apply(async () => "no-op");

      expect(committed).toBe(false);
      expect(commitHash).toBeUndefined();
      expect(await repo.resolveLocalRef("main")).toBe(tipBefore);
    });

    it("retries against the fresh tip and never destroys a concurrent trunk advance (fast-forward-only realignment)", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const mirror = trunk.mirror("plan");

      // Prime the mirror's worktree so its next apply() call has to re-sync.
      await mirror.apply(async (view) => {
        await view.createFile("seed.txt", "seed");
      });

      // Someone else advances `main` directly (simulating a concurrent
      // movement merge) between two Mirror.apply() calls.
      const tipAfterConcurrentWrite = await commitDirectlyToMain(
        sandboxRoot,
        repo,
        "concurrent-main-writer",
        "concurrent.txt",
        "concurrent change",
      );

      const { committed } = await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan v2");
      });
      expect(committed).toBe(true);

      // The concurrent write is still present — Mirror.apply()'s CAS loop
      // rebased onto it rather than clobbering it.
      const checkWt = await repo.createWorktree(sandboxRoot, "post-check", "main");
      const tipNow = await repo.resolveLocalRef("main");
      expect(tipNow).not.toBe(tipAfterConcurrentWrite);
      const log = await checkWt.log("", "main");
      const hashes = log.map((c) => c.hash);
      expect(hashes).toContain(tipAfterConcurrentWrite);
    });

    it(
      "two apply() attempts sharing the SAME mirror worktree concurrently each land their OWN change in its OWN commit " +
        "— no cross-contamination from one attempt's uncommitted writes bleeding into the other's commit " +
        "(whole-attempt exclusivity per worktree, not just per-git-command; parallels the disk-specific suite's real-git version)",
      async () => {
        const { repo, trunk } = await makeRepo();
        // Two SEPARATE Mirror handles for the SAME mirror branch — `Trunk.mirror()`
        // is not cached (design doc §4.1) — the exact shape two concurrent MCP
        // tool calls (or, post plan/conductor consolidation, a plan-shaped and a
        // conductor-shaped `apply()`) produce: different objects, same
        // underlying mirror worktree.
        const mirrorA = trunk.mirror("plan");
        const mirrorB = trunk.mirror("plan");

        const [resultA, resultB] = await Promise.all([
          mirrorA.apply(async (view) => {
            await view.createFile("from-a.txt", "a");
          }),
          mirrorB.apply(async (view) => {
            await view.createFile("from-b.txt", "b");
          }),
        ]);

        expect(resultA.committed).toBe(true);
        expect(resultB.committed).toBe(true);
        expect(resultA.commitHash).toBeDefined();
        expect(resultB.commitHash).toBeDefined();
        expect(resultA.commitHash).not.toBe(resultB.commitHash);

        const git = (repo as InMemoryBareRepository).getGit();
        const commitA = git.getCommit(resultA.commitHash as string);
        const commitB = git.getCommit(resultB.commitHash as string);
        expect(commitA).toBeDefined();
        expect(commitB).toBeDefined();
        // Each landed commit changes ONLY the file its own transform wrote —
        // never both. Without whole-attempt exclusivity, an interleaved
        // reset/write/commit sequence can bundle both attempts' files into
        // whichever commit happens to finalize second.
        expect(git.changedFiles(commitA?.parents[0] ?? "", resultA.commitHash as string)).toEqual(["from-a.txt"]);
        expect(git.changedFiles(commitB?.parents[0] ?? "", resultB.commitHash as string)).toEqual(["from-b.txt"]);
      },
    );
  });

  describe("Mirror subtree narrowing (design doc §7's 'Switchyard's conductor subtree' open item)", () => {
    it("a Mirror constructed with a subtree only sees/writes files under that subtree (simulated cone-mode sparse checkout)", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();

      // "other-dir/outside.txt" is deliberately NOT top-level — cone mode
      // always keeps top-level files/dirs visible regardless of the
      // configured cone (see InMemoryWorktree's isFileVisibleInCone), so a
      // real exclusion test needs nested content.
      const seed = await repo.createWorktree(sandboxRoot, "seed-subtree", "main");
      await seed.createFile(".meta/plan/existing.md", "pre-existing plan content");
      await seed.createFile("other-dir/outside.txt", "not part of the plan subtree");
      await seed.commitAll("seed plan + non-plan content");
      await repo.removeWorktree(seed);

      // The sparse checkout does NOT remap paths (matching
      // libs/planner/src/PlanActionGroup.ts's own convention for
      // originPlanPath): the subtree is still a real subdirectory of the
      // mirror's worktree root, just the only one actually visible (besides
      // top-level files, per cone mode).
      const mirror = trunk.mirror("plan", ".meta/plan");
      const { committed } = await mirror.apply(async (view) => {
        await view.createFile(".meta/plan/new.md", "written through the mirror");
      });
      expect(committed).toBe(true);

      // The mirror's own view exposes the subtree's content at its real
      // subtree-relative path, and never the excluded sibling directory.
      expect(await mirror.files.child(".meta")).toMatchObject({ found: true });
      expect(await mirror.files.child("other-dir")).toMatchObject({ found: false });

      // Published content on `main` still has BOTH the subtree write and
      // the pre-existing outside content — narrowing the worktree's
      // visibility must never narrow what actually gets published.
      const checkWt = await repo.createWorktree(sandboxRoot, "post-check-subtree", "main");
      expect(await checkWt.child("other-dir")).toMatchObject({ found: true });
      expect(await checkWt.child(".meta")).toMatchObject({ found: true });
    });
  });

  describe("DerivedTrunk.beginAdvance() / AdvanceAttempt (design doc §4.4)", () => {
    /**
     * `SimulatedGit`'s `rebase()` conflict signal is a GLOBAL toggle
     * (`setSimulatedRebaseConflict`), not real content-diffing — tests below
     * flip it on/off around the specific call they want to force a conflict
     * (or clear one) for, mirroring how `CheckedOutMovement.start()`/
     * `resolveConflict()`'s own doc comment says this simulation is meant to
     * be driven.
     */
    function git(repo: BareRepository): ReturnType<InMemoryBareRepository["getGit"]> {
      return (repo as InMemoryBareRepository).getGit();
    }

    /**
     * Builds the `CheckedOutMovement` `beginAdvance()` borrows as `resolveIn`
     * — standing in for "some wing's own worktree", entirely unrelated to
     * the experiment/derived-trunk under test, the way a real caller
     * (`MovementManager.promote()`) always has ITS OWN wing's active
     * movement on hand. Always built off the root `trunk` (never the
     * derived trunk being advanced) so it's obviously a pre-existing,
     * independent worktree, not something `beginAdvance()` itself
     * provisions.
     */
    async function makeResolver(trunk: Trunk, name: string): Promise<CheckedOutMovement> {
      return createInMemoryCheckedOutMovement(trunk, `wip/resolver-${name}`, "movements");
    }

    async function makeDerivedWithFeature(
      trunk: Trunk,
      expName: string,
    ): Promise<{ derived: DerivedTrunk }> {
      const derived = trunk.derive(`__exp/${expName}/main`) as DerivedTrunk;
      const checkedOut = await createInMemoryCheckedOutMovement(derived, `wip/on-${expName}`, "movements");
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature" });
      const mergeResult = await checkedOut.merge({});
      expect(mergeResult.status).toBe("success");
      return { derived };
    }

    it("resolves a (simulated) conflict and publishes — the trunk itself is never checked out at any point, and resolveIn's worktree is restored afterward", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im1");
      // Advance the parent too, so there's something real for advance() to
      // replay onto (not just a no-op).
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im1", "main-progress.txt", "main moves");

      const resolver = await makeResolver(trunk, "im1");
      const resolverWorktree = resolver.files as Worktree;
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-im1");
      const worktreesBaseline = (await repo.worktrees()).length;

      git(repo).setSimulatedRebaseConflict(true, "simulated conflict", ["conflict.txt"]);
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("conflict");
      expect(attempt.conflictedFiles).toEqual(["conflict.txt"]);
      // `beginAdvance()` borrowed `resolver`'s existing worktree — no new
      // worktree was created.
      expect(attempt.files).toBe(resolver.files);
      expect((await repo.worktrees()).length).toBe(worktreesBaseline);
      for (const wt of await repo.worktrees()) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      git(repo).setSimulatedRebaseConflict(false);
      const resolved = await attempt.continueResolving();
      expect(resolved.status).toBe("ready");
      for (const wt of await repo.worktrees()) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      const result = await resolved.publish();
      expect(result.status).toBe("ok");
      for (const wt of await repo.worktrees()) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      const newTip = await repo.resolveLocalRef(derived.branch);
      expect(newTip).not.toBeNull();
      const checkWt = await repo.createWorktree(sandboxRoot, "check-im1", derived.branch);
      expect(await checkWt.child("feature.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("main-progress.txt")).toMatchObject({ found: true });
      await repo.removeWorktree(checkWt);
      // publish() restored resolver's own worktree to its original branch —
      // no leftover worktree, no worktree count change.
      expect((await repo.worktrees()).length).toBe(worktreesBaseline);
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-im1");
    });

    it("publish() recomputes and succeeds cleanly when the parent moves further (unrelated change) after resolution", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im2");
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im2", "main-progress.txt", "main moves");

      const resolver = await makeResolver(trunk, "im2");
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("ready"); // no conflict configured

      const newerMainTip = await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im2-2", "unrelated.txt", "main moves again");

      const result = await attempt.publish();
      expect(result.status).toBe("ok");

      const checkWt = await repo.createWorktree(sandboxRoot, "check-im2", derived.branch);
      expect(await checkWt.child("feature.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("unrelated.txt")).toMatchObject({ found: true });
      await repo.removeWorktree(checkWt);
      expect(await repo.resolveLocalRef("main")).toBe(newerMainTip);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-im2");
    });

    it("publish() returns to status 'conflict' (not failing outright) when the parent's further movement reopens a conflict, and a second resolution round lands cleanly", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im3");
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im3", "main-progress.txt", "main moves");

      const resolver = await makeResolver(trunk, "im3");
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("ready");

      // Parent moves again; this time simulate the recompute hitting a real
      // conflict.
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im3-2", "again.txt", "main moves again");
      git(repo).setSimulatedRebaseConflict(true, "reopened conflict", ["reopened.txt"]);

      const publishResult = await attempt.publish();
      expect(publishResult.status).toBe("conflict");
      // The SAME AdvanceAttempt object reflects the reopened conflict.
      expect(attempt.status).toBe("conflict");
      expect(attempt.conflictedFiles).toEqual(["reopened.txt"]);

      git(repo).setSimulatedRebaseConflict(false);
      const resolvedAgain = await attempt.continueResolving();
      expect(resolvedAgain.status).toBe("ready");
      const finalResult = await resolvedAgain.publish();
      expect(finalResult.status).toBe("ok");

      const checkWt = await repo.createWorktree(sandboxRoot, "check-im3", derived.branch);
      expect(await checkWt.child("again.txt")).toMatchObject({ found: true });
      await repo.removeWorktree(checkWt);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-im3");
    });

    it("publish() extends the replay range and lands cleanly when the derived trunk ITSELF gains a new commit before ever publishing", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im4");

      const resolver = await makeResolver(trunk, "im4");
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("ready");

      // A genuinely separate actor lands a new commit directly on the
      // derived trunk's OWN branch, mid-attempt.
      await commitDirectlyToBranch(sandboxRoot, repo, derived.branch, "interloper-im4", "interloper.txt", "x", "interloper change mid-attempt");

      const result = await attempt.publish();
      expect(result.status).toBe("ok");

      const checkWt = await repo.createWorktree(sandboxRoot, "check-im4", derived.branch);
      expect(await checkWt.child("feature.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("interloper.txt")).toMatchObject({ found: true });
      await repo.removeWorktree(checkWt);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-im4");
    });

    it("publish() correctly reopens a conflict (never silently drops content) when the trunk's new commit's recompute hits one", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im5");

      const resolver = await makeResolver(trunk, "im5");
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("ready");

      await commitDirectlyToBranch(sandboxRoot, repo, derived.branch, "interloper-im5", "interloper.txt", "x", "interloper change mid-attempt");
      git(repo).setSimulatedRebaseConflict(true, "reopened via trunk move", ["trunk-conflict.txt"]);

      const result = await attempt.publish();
      expect(result.status).toBe("conflict");
      expect(attempt.status).toBe("conflict");
      expect(attempt.conflictedFiles).toEqual(["trunk-conflict.txt"]);

      git(repo).setSimulatedRebaseConflict(false);
      const resolvedAgain = await attempt.continueResolving();
      expect(resolvedAgain.status).toBe("ready");
      const finalResult = await resolvedAgain.publish();
      expect(finalResult.status).toBe("ok");

      const checkWt = await repo.createWorktree(sandboxRoot, "check-im5", derived.branch);
      expect(await checkWt.child("interloper.txt")).toMatchObject({ found: true });
      await repo.removeWorktree(checkWt);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-im5");
    });

    it("abandon() genuinely leaves the derived trunk untouched, creates no worktree of its own, and restores resolveIn's worktree even mid-conflict", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im6");
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im6", "main-progress.txt", "main moves");

      const tipBefore = await repo.resolveLocalRef(derived.branch);
      const resolver = await makeResolver(trunk, "im6");
      const resolverWorktree = resolver.files as Worktree;
      const worktreesBefore = (await repo.worktrees()).length;

      git(repo).setSimulatedRebaseConflict(true, "conflict", ["conflict.txt"]);
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("conflict");
      git(repo).setSimulatedRebaseConflict(false);

      await attempt.abandon();

      expect(await repo.resolveLocalRef(derived.branch)).toBe(tipBefore);
      expect((await repo.worktrees()).length).toBe(worktreesBefore);
      // abandon() cleared the in-progress rebase and checked resolver's
      // worktree back out onto its original branch.
      expect(await resolverWorktree.hasInProgressRebase()).toBe(false);
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-im6");

      await expect(attempt.continueResolving()).rejects.toThrow();
      await expect(attempt.publish()).rejects.toThrow();
      await expect(attempt.abandon()).resolves.toBeUndefined();
    });

    it("rejects upfront when resolveIn's worktree is dirty — no branch switch attempted, no scratch branch created, derived trunk untouched (finding #14)", async () => {
      const { sandboxRoot, repo, trunk } = await makeRepo();
      const { derived } = await makeDerivedWithFeature(trunk, "im7");
      await commitDirectlyToMain(sandboxRoot, repo, "main-advance-im7", "main-progress.txt", "main moves");

      const tipBefore = await repo.resolveLocalRef(derived.branch);
      const resolver = await makeResolver(trunk, "im7");
      const resolverWorktree = resolver.files as Worktree;
      const originalBranch = await resolverWorktree.currentBranch();
      const worktreesBefore = (await repo.worktrees()).length;

      await resolverWorktree.createFile("uncommitted.txt", "not yet committed");
      expect(await resolver.isDirty()).toBe(true);

      await expect(derived.beginAdvance(resolver)).rejects.toThrow(
        /uncommitted changes.*commit or discard/,
      );

      expect(await resolverWorktree.currentBranch()).toBe(originalBranch);
      expect(await resolverWorktree.hasInProgressRebase()).toBe(false);
      expect(await resolver.isDirty()).toBe(true);
      expect((await repo.worktrees()).length).toBe(worktreesBefore);
      expect(await repo.resolveLocalRef(derived.branch)).toBe(tipBefore);
    });
  });
});
