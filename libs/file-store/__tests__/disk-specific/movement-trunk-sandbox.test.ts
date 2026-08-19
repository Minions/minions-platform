/**
 * Proves the invariants design doc §4.1 calls out for the Sandbox-layer
 * types (`Movement`, `CheckedOutMovement`, `Trunk`, `DerivedTrunk`,
 * `Mirror`), on the Disk adapter, against REAL git —
 * specifically three things that don't port safely from the InMemory adapter
 * unmodified:
 *
 *  - `merge()` publishes `Worktree.merge()`'s own genuine two-parent `--no-ff`
 *    result unaltered (never rebuilt/flattened via `commit-tree` — squashing
 *    would discard every movement's incremental history from `main`, see
 *    design doc §4.1 and `DiskMovement.ts`'s own header comment) — proven
 *    here by inspecting the ACTUAL parent count of the landed commit on the
 *    real origin via `git rev-list --parents`, not just checking a status
 *    field.
 *  - `Movement.state()`'s "integrated" derivation must use real
 *    `git merge-base --is-ancestor`, not the InMemory adapter's
 *    `log("", base)` sentinel trick (which doesn't mean anything against
 *    real git's `..` range semantics).
 *  - the actual publish step must be a direct push to origin
 *    (`git push origin <sha>:refs/heads/<branch>`), never a local-only CAS —
 *    proven here by asserting against a SEPARATE real clone of the same
 *    origin (`originRef`, reading straight from the origin bare repo's own
 *    refs), not just the repo under test's own local cache.
 *
 * This is a Disk-specific test file, not an extension of
 * `port/contracts.ts`'s shared-contract-test pattern — `contracts.ts`
 * parameterizes tests over a `createSandbox()` factory and exercises the
 * `Sandbox`/`BareRepository`/`Worktree` surface (see its own
 * `describe(`${name} Sandbox contract`)` wrapper). The Sandbox-layer types
 * (`Trunk`/`DerivedTrunk`/etc.) aren't constructed via
 * `Sandbox`/`BareRepository` at all — each adapter has its own factory
 * (`createInMemoryTrunk`/`createDiskTrunk`) — so
 * there's no shared "build a Trunk generically" hook for `contracts.ts` to
 * parameterize over yet (adding one is possible, but every test below
 * ALSO needs adapter-specific setup: InMemory's `simulateRemote`, vs. a
 * real second clone + real origin here — the genuinely shared assertions
 * are a small subset, most of the value in each suite is proving the
 * *mechanism* is safe on that specific backend). The `memory-specific`
 * suite (`movement-trunk-sandbox.test.ts`) covers the InMemory adapter with
 * a parallel structure; this file is real-git-specific where it matters
 * (parent-count/ancestor/origin-ref assertions a simulation can't
 * meaningfully stand in for).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import type { DiskBareRepository } from "../../src/adapters/disk/DiskBareRepository.js";
import { createDiskTrunk, createDiskCheckedOutMovement } from "../../src/adapters/disk/index.js";
import type { BareRepository, Directory, Trunk, DerivedTrunk, CheckedOutMovement, Worktree } from "../../src/index.js";
import { asGitRef } from "../../src/index.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

useRealGitTimeout();

function originRef(originPath: string, ref: string): string {
  return execSync(`git rev-parse --verify -q "refs/heads/${ref}"`, {
    cwd: originPath,
    encoding: "utf-8",
  }).trim();
}

/** Like `originRef`, but returns `null` instead of throwing when `ref` doesn't exist on origin. */
function originRefOrNull(originPath: string, ref: string): string | null {
  try {
    return originRef(originPath, ref);
  } catch {
    return null;
  }
}

/** Number of parents the commit at `hash` has, read directly from origin's own object store. */
function originParentCount(originPath: string, hash: string): number {
  const line = execSync(`git rev-list --parents -n 1 ${hash}`, {
    cwd: originPath,
    encoding: "utf-8",
  }).trim();
  const tokens = line.split(/\s+/);
  return tokens.length - 1; // first token is the commit itself
}

/** Same as `originParentCount`, but against a repo's own (not-yet-pushed) local object store. */
function localParentCount(repo: BareRepository, hash: string): number {
  const line = execSync(`git rev-list --parents -n 1 ${hash}`, {
    cwd: (repo as DiskBareRepository).path,
    encoding: "utf-8",
  }).trim();
  const tokens = line.split(/\s+/);
  return tokens.length - 1;
}

/** The set of file paths a commit actually changed relative to its (single) parent, read straight from origin's own object store. */
function originCommitFiles(originPath: string, hash: string): string[] {
  const out = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
    cwd: originPath,
    encoding: "utf-8",
  }).trim();
  return out.length === 0 ? [] : out.split("\n");
}

describe("Movement/Trunk sandbox layer (disk)", () => {
  let tmpDir: string;
  let sandbox: DiskSandbox;
  let originPath: string;
  let repo: BareRepository;
  let trunk: Trunk;
  let scratchRoot: Directory;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "disk-movement-trunk-"));
    sandbox = new DiskSandbox(tmpDir);
    originPath = join(tmpDir, "origin.git");
    mkdirSync(originPath);
    execSync("git init --bare -q", { cwd: originPath });

    repo = await sandbox.cloneBare(originPath, sandbox.root, "clone.git");

    // Seed `main` with an initial commit and push it to the real origin —
    // mirrors a freshly-initialized real repo's first commit.
    const seed = await repo.createWorktree(sandbox.root, "seed-wt", "seed");
    await seed.createFile("README.md", "hello");
    const firstHash = await seed.commitAll("initial commit");
    await repo.updateBranch("main", firstHash);
    await repo.pushBranch("main");

    scratchRoot = await sandbox.root.createDirectory("scratch");
    trunk = createDiskTrunk(repo, "main", scratchRoot);
  });

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  });

  /**
   * Clones the SAME origin a second time and pushes a commit directly to
   * `main` from it — a genuinely independent actor, not anything `repo`
   * (the repo under test) did itself. Simulates "someone else's movement
   * merged concurrently" the way it actually happens: a different clone,
   * pushing to the same real origin.
   */
  async function pushFromInterloper(fileName: string, message: string): Promise<string> {
    const interloper = await sandbox.cloneBare(originPath, sandbox.root, `interloper-${fileName}.git`);
    const wt = await interloper.createWorktree(sandbox.root, `interloper-wt-${fileName}`, "main");
    await wt.createFile(fileName, "x");
    const hash = await wt.commitAll(message);
    await interloper.pushBranch("main");
    return hash;
  }

  /**
   * Builds the `CheckedOutMovement` `advance()`/`beginAdvance()` require as
   * `resolveIn` — standing in for "some wing's own worktree", entirely
   * unrelated to the experiment/derived-trunk under test, the way a real
   * caller (`MovementManager.promote()`) always has ITS OWN wing's active
   * movement on hand. Always built off the root `trunk` (never the derived
   * trunk being advanced) so it's obviously a pre-existing, independent
   * worktree, not something `advance()`/`beginAdvance()` itself provisions.
   */
  async function makeResolver(name: string): Promise<CheckedOutMovement> {
    return createDiskCheckedOutMovement(trunk, `wip/resolver-${name}`, scratchRoot);
  }

  describe("Movement.state()", () => {
    it("is 'undefined' when the branch doesn't exist locally", async () => {
      const movement = trunk.movement("wip/never-created");
      expect(await movement.state()).toBe("undefined");
    });

    it("is 'in-progress' once the branch exists and has diverged from base", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "diverge" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.state()).toBe("in-progress");
    });

    it("is 'integrated' when the branch never diverged from base", async () => {
      await repo.createBranchIfMissing("wip/same-as-base", "main");
      const movement = trunk.movement("wip/same-as-base");
      expect(await movement.state()).toBe("integrated");
    });

    it(
      "is 'integrated' after a clean merge (real merge-base --is-ancestor), even though base has since moved further",
      async () => {
        const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
        await checkedOut.files.createFile("feature.txt", "content");
        await checkedOut.commit({ message: "add feature" });

        const movement = trunk.movement("wip/feature");
        expect(await movement.state()).toBe("in-progress");
        const mergeResult = await checkedOut.merge({});
        expect(mergeResult.status).toBe("success");
        expect(await movement.state()).toBe("integrated");

        await pushFromInterloper("unrelated.txt", "unrelated change");
        // Local cache doesn't know about the interloper's push yet — state()
        // must still correctly report "integrated" via real ancestry, not
        // break because base "moved" underneath it.
        expect(await movement.state()).toBe("integrated");
      },
    );
  });

  describe("Movement.readFileAtRef() — read-only, base-independent (design doc §4.1)", () => {
    it("reads a file's content as it existed at a specific ref, without touching any worktree", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("feature.txt", "v2");
      await checkedOut.commit({ message: "update feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.readFileAtRef(asGitRef(firstHash.hash), "feature.txt")).toBe("v1");
      expect(await movement.readFileAtRef(asGitRef("wip/feature"), "feature.txt")).toBe("v2");
    });

    it("returns null when the file didn't exist at that ref", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.readFileAtRef(asGitRef("wip/feature"), "nonexistent.txt")).toBeNull();
    });

    it("works against a plain Movement handle with no checkout ever created for it", async () => {
      const movement = trunk.movement("main");
      expect(await movement.readFileAtRef(asGitRef("main"), "README.md")).toBe("hello");
    });
  });

  describe("Movement.tipHash() — read-only, base-independent (design doc §4.1)", () => {
    it("resolves to the branch's current commit sha", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.tipHash()).toBe(firstHash.hash);
    });

    it("returns null when the branch doesn't exist locally yet", async () => {
      const movement = trunk.movement("wip/never-created");
      expect(await movement.tipHash()).toBeNull();
    });

    it("works against a plain Movement handle with no checkout ever created for it", async () => {
      const movement = trunk.movement("main");
      expect(await movement.tipHash()).toBe(originRef(originPath, "main"));
    });
  });

  describe("Movement.changedFiles() — read-only, base-independent (design doc §4.1)", () => {
    it("lists paths changed since base, defaulting both refs", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("other.txt", "v1");
      await checkedOut.commit({ message: "add other.txt" });

      const movement = trunk.movement("wip/feature");
      expect((await movement.changedFiles()).sort()).toEqual(["feature.txt", "other.txt"]);
    });

    it("accepts explicit from/to refs", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      const firstHash = await checkedOut.commit({ message: "add feature.txt" });
      await checkedOut.files.createFile("other.txt", "v1");
      await checkedOut.commit({ message: "add other.txt" });

      const movement = trunk.movement("wip/feature");
      expect(await movement.changedFiles(asGitRef(firstHash.hash), asGitRef("wip/feature"))).toEqual(["other.txt"]);
    });

    it("returns an empty array when nothing has diverged from base", async () => {
      await repo.createBranchIfMissing("wip/same-as-base", "main");
      const movement = trunk.movement("wip/same-as-base");
      expect(await movement.changedFiles()).toEqual([]);
    });
  });

  describe("Movement.merge() — real push-based CAS publish", () => {
    it("lands a real TWO-PARENT merge commit directly on origin (not just the local cache)", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature" });

      const baseTipBefore = originRef(originPath, "main");
      const result = await checkedOut.merge({ message: "land feature" });

      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("unreachable");

      // The published commit is on ORIGIN itself, read independently of the
      // repo under test's own local cache (finding #4).
      const originTipAfter = originRef(originPath, "main");
      expect(originTipAfter).toBe(result.commit);
      expect(originTipAfter).not.toBe(baseTipBefore);

      // The published commit has exactly TWO parents — main's prior tip and
      // the movement's own tip — never flattened to one. main's history must
      // read as a chain of merge commits with each movement's incremental
      // history intact and reachable as a side branch.
      expect(originParentCount(originPath, result.commit)).toBe(2);
    });

    it("retries and still lands cleanly when a real concurrent push to origin wins the race first", async () => {
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/racer", scratchRoot);
      await checkedOut.files.createFile("racer.txt", "v1");
      await checkedOut.commit({ message: "racer commit" });

      // A genuinely independent clone pushes to the real origin first — the
      // repo under test's local cache of `main` is now stale, and its first
      // push attempt WILL be rejected by origin's real fast-forward check.
      const interloperHash = await pushFromInterloper("interloper.txt", "interloping change");

      const result = await checkedOut.merge({});
      expect(result.status).toBe("success");

      // Both commits are present on origin — the lost race was resolved by
      // fetching + re-merging onto the new tip, not by discarding the
      // interloper's already-published commit.
      const checkWt = await repo.createWorktree(sandbox.root, "post-check", "main");
      await checkWt.fetch(true);
      await checkWt.resetTo("origin/main");
      expect(await checkWt.child("interloper.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("racer.txt")).toMatchObject({ found: true });
      void interloperHash;
    });

    it("returns 'already-up-to-date' when the movement never diverged", async () => {
      await repo.createBranchIfMissing("wip/noop", "main");
      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/noop", scratchRoot);
      const result = await checkedOut.merge({});
      expect(result.status).toBe("already-up-to-date");
    });

    /**
     * Regression test: concurrent `CheckedOutMovement.merge()` calls on the
     * SAME trunk for DIFFERENT movements (each reusing its OWN already
     * checked-out worktree via a detached-HEAD checkout — see
     * `DiskCheckedOutMovementImpl.merge()`'s own doc comment) must not crash
     * or corrupt each other, even though both target the same base branch.
     * This is exactly the multi-wing-concurrent-merge scenario design doc
     * §2's invariants exist to make safe — not a hypothetical edge case.
     */
    it("two movements merging onto the SAME trunk concurrently both land cleanly (no crash, no lost commit)", async () => {
      const a = await createDiskCheckedOutMovement(trunk, "wip/concurrent-a", scratchRoot);
      await a.files.createFile("a.txt", "a");
      await a.commit({ message: "add a" });

      const b = await createDiskCheckedOutMovement(trunk, "wip/concurrent-b", scratchRoot);
      await b.files.createFile("b.txt", "b");
      await b.commit({ message: "add b" });

      const [resultA, resultB] = await Promise.all([
        a.merge({ message: "land a" }),
        b.merge({ message: "land b" }),
      ]);

      expect(resultA.status).toBe("success");
      expect(resultB.status).toBe("success");

      // Both movements' content actually made it to real origin — neither
      // was silently dropped by the other's win.
      const checkWt = await repo.createWorktree(sandbox.root, "concurrent-check", "main");
      await checkWt.fetch(true);
      await checkWt.resetTo("origin/main");
      expect(await checkWt.child("a.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("b.txt")).toMatchObject({ found: true });

      // Both landing commits are still genuine two-parent merge commits — the
      // concurrency fix must not have caused either one to collapse to a
      // single parent while serializing/deconflicting concurrent access.
      if (resultA.status === "success") {
        expect(originParentCount(originPath, resultA.commit)).toBe(2);
      }
      if (resultB.status === "success") {
        expect(originParentCount(originPath, resultB.commit)).toBe(2);
      }
    });

  });

  describe("Trunk/DerivedTrunk are never checked out", () => {
    it("no worktree is ever checked out on the trunk's own branch across mirror/movement/merge/derive activity", async () => {
      const mirror = trunk.mirror("plan");
      await mirror.apply(async (view) => {
        await view.createFile("plan.md", "hello");
      });

      const checkedOut = await createDiskCheckedOutMovement(trunk, "wip/feature", scratchRoot);
      await checkedOut.files.createFile("feature.txt", "v1");
      await checkedOut.commit({ message: "add feature" });
      await checkedOut.merge({});

      const derived = trunk.derive("__exp/e1/main");
      await derived.advance(await makeResolver("never-checked-out"));

      const worktrees = await repo.worktrees();
      expect(worktrees.length).toBeGreaterThan(0); // sanity: activity actually happened
      for (const wt of worktrees) {
        expect(wt.branch).not.toBe(trunk.branch);
        expect(wt.branch).not.toBe(derived.branch);
      }
    });
  });

  describe("Mirror.apply() — real push-based CAS publish", () => {
    it("commits a change and publishes it directly to origin", async () => {
      const mirror = trunk.mirror("plan");

      const originTipBefore = originRef(originPath, "main");
      const { committed, commitHash, result } = await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan");
        return "wrote plan";
      });

      expect(committed).toBe(true);
      expect(commitHash).toBeDefined();
      expect(result).toBe("wrote plan");
      expect(originRef(originPath, "main")).toBe(commitHash);
      expect(originRef(originPath, "main")).not.toBe(originTipBefore);
    });

    it("reports committed:false and does not publish when the transform makes no change", async () => {
      const mirror = trunk.mirror("plan");
      await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan");
      });
      const tipBefore = originRef(originPath, "main");

      const { committed, commitHash } = await mirror.apply(async () => "no-op");

      expect(committed).toBe(false);
      expect(commitHash).toBeUndefined();
      expect(originRef(originPath, "main")).toBe(tipBefore);
    });

    it("retries against the fresh origin tip when a real concurrent push wins the race first", async () => {
      const mirror = trunk.mirror("plan");
      await mirror.apply(async (view) => {
        await view.createFile("seed.txt", "seed");
      });

      const interloperHash = await pushFromInterloper("concurrent.txt", "concurrent change");

      const { committed } = await mirror.apply(async (view) => {
        await view.createFile("plan.md", "# Plan v2");
      });
      expect(committed).toBe(true);

      // The interloper's commit is still present on origin — Mirror.apply()'s
      // CAS loop rebased its own change onto it rather than clobbering it.
      const checkWt = await repo.createWorktree(sandbox.root, "post-check", "main");
      await checkWt.fetch(true);
      await checkWt.resetTo("origin/main");
      expect(await checkWt.child("concurrent.txt")).toMatchObject({ found: true });
      expect(await checkWt.child("plan.md")).toMatchObject({ found: true });
      expect(originParentCount(originPath, originRef(originPath, "main"))).toBe(1);
      void interloperHash;
    });

    it(
      "two apply() attempts sharing the SAME mirror worktree concurrently each land their OWN change in its OWN commit " +
        "— no cross-contamination from one attempt's uncommitted writes bleeding into the other's commit " +
        "(whole-attempt exclusivity per worktree, not just per-git-command)",
      async () => {
        // Two SEPARATE Mirror handles for the SAME mirror branch — `Trunk.mirror()`
        // is not cached (design doc §4.1), so this is exactly the shape two
        // concurrent MCP tool calls (or, post-consolidation, a plan-shaped and a
        // conductor-shaped `apply()`) produce: different objects, same underlying
        // worktree directory on disk.
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
        // Two genuinely distinct commits — one attempt's writes must not have
        // been silently folded into the other's commit (which would make the
        // two commit hashes collapse to the same value, or leave one attempt
        // reporting `committed: false` because the other attempt's concurrent
        // `git add -A` already swept up its uncommitted file).
        expect(resultA.commitHash).not.toBe(resultB.commitHash);

        // Each landed commit changes ONLY the file its own transform wrote —
        // never both. Without whole-attempt exclusivity, an interleaved
        // reset/write/commitAll sequence can bundle both attempts' files into
        // whichever commit happens to run `git add -A` second.
        expect(originCommitFiles(originPath, resultA.commitHash as string)).toEqual(["from-a.txt"]);
        expect(originCommitFiles(originPath, resultB.commitHash as string)).toEqual(["from-b.txt"]);

        // Both files are present on origin's final tip either way.
        const checkWt = await repo.createWorktree(sandbox.root, "concurrent-apply-check", "main");
        await checkWt.fetch(true);
        await checkWt.resetTo("origin/main");
        expect(await checkWt.child("from-a.txt")).toMatchObject({ found: true });
        expect(await checkWt.child("from-b.txt")).toMatchObject({ found: true });
      },
    );
  });

  describe("Mirror subtree narrowing (design doc §7's 'Switchyard's conductor subtree' open item)", () => {
    it("a Mirror constructed with a subtree only sees/writes files under that subtree, via a real sparse checkout", async () => {
      // Seed the trunk with content both inside and outside the subtree
      // BEFORE the mirror is ever created, so this proves real sparse
      // checkout narrowing (files outside the cone never land on disk at
      // all), not just "the transform only wrote inside the subtree".
      // "outside.txt" deliberately lives in a NON-top-level directory —
      // cone-mode sparse-checkout always keeps top-level files visible
      // regardless of the configured cone (see the shared contract test,
      // port/contracts.ts's "createSparseWorktree() checks out only the
      // cone, plus top-level files"), so a real exclusion test needs content
      // nested under a sibling directory, not a bare top-level file.
      const seedWt = await createDiskCheckedOutMovement(trunk, "wip/seed", scratchRoot);
      await seedWt.files.createFile(join(".meta", "plan", "existing.md"), "pre-existing plan content");
      await seedWt.files.createFile(join("other-dir", "outside.txt"), "not part of the plan subtree");
      await seedWt.commit({ message: "seed plan + non-plan content" });
      await seedWt.merge({});

      // The sparse checkout does NOT remap paths (matching
      // libs/planner/src/PlanActionGroup.ts's own convention for
      // originPlanPath): the subtree is still a real subdirectory of the
      // mirror's worktree root, just the only one actually checked out
      // (besides top-level files, per cone mode).
      const mirror = trunk.mirror("plan", ".meta/plan");
      const { committed } = await mirror.apply(async (view) => {
        await view.createFile(join(".meta", "plan", "new.md"), "written through the mirror");
      });
      expect(committed).toBe(true);

      // The mirror's own view exposes the subtree's content at its real
      // subtree-relative path, and never the excluded sibling directory.
      expect(await mirror.files.child(".meta")).toMatchObject({ found: true });
      expect(await mirror.files.child("other-dir")).toMatchObject({ found: false });

      // The REAL on-disk worktree behind the mirror never checked out
      // `other-dir/outside.txt` at all (a real `git sparse-checkout`, not
      // just a filtered view) — the defining difference from a full-tree
      // checkout.
      const worktrees = await repo.worktrees();
      const mirrorWt = worktrees.find((wt) => wt.branch === "plan");
      expect(mirrorWt).toBeDefined();
      const fs = await import("fs");
      expect(fs.existsSync(join((mirrorWt as Worktree).path, "other-dir"))).toBe(false);
      expect(fs.existsSync(join((mirrorWt as Worktree).path, ".meta", "plan", "new.md"))).toBe(true);
      expect(fs.existsSync(join((mirrorWt as Worktree).path, ".meta", "plan", "existing.md"))).toBe(true);

      // And the published content on origin still has BOTH the subtree
      // write and the pre-existing outside content — narrowing the
      // worktree must never narrow what actually gets published.
      const checkWt = await repo.createWorktree(sandbox.root, "post-check-subtree", "main");
      await checkWt.fetch(true);
      await checkWt.resetTo("origin/main");
      expect(fs.existsSync(join(checkWt.path, "other-dir", "outside.txt"))).toBe(true);
      expect(fs.existsSync(join(checkWt.path, ".meta", "plan", "new.md"))).toBe(true);
    });

    it(
      "many concurrent read-only accesses through SEPARATE Mirror handles for the SAME not-yet-existing " +
        "worktree all succeed — a regression test for a real race this codebase hit: `Trunk.mirror()` builds " +
        "a fresh Mirror per call (design doc §4.1), so N concurrent plan reads (e.g. one get-subtree per plan " +
        "root, all firing in parallel — see PlanActionGroup.ts's findItemSubtree) each independently tried to " +
        "find-or-create the mirror worktree; on a cold worktree, every one of them raced `git worktree add` " +
        "for the same branch, which git rejects for every racer but the first ('branch is already used by " +
        "worktree at ...'). Concurrent creation must be coalesced, not merely made cheap.",
      async () => {
        const mirrors = Array.from({ length: 8 }, () => trunk.mirror("plan", ".meta/plan"));

        const results = await Promise.all(mirrors.map((m) => m.files.child(".meta")));

        // Every concurrent accessor got a real (if initially empty) worktree —
        // none threw, and every one agrees on the child lookup's result.
        for (const r of results) expect(r).toMatchObject({ found: false });

        // Exactly ONE worktree was actually created for this branch, not one
        // per racer (and not zero, from a lost race leaving nothing behind).
        const worktrees = await repo.worktrees();
        expect(worktrees.filter((wt) => wt.branch === "plan")).toHaveLength(1);
      },
    );

    it(
      "concurrent read-only access through separate Mirror handles for the SAME subtree does not re-narrow " +
        "redundantly, but a genuinely different subtree on the SAME worktree still narrows correctly " +
        "(plan vs. conductor sharing one mirror worktree, design doc's resolveConductorMirror)",
      async () => {
        const seedWt = await createDiskCheckedOutMovement(trunk, "wip/seed2", scratchRoot);
        await seedWt.files.createFile(join(".meta", "plan", "p.md"), "plan content");
        await seedWt.files.createFile(join(".meta", "conductor", "c.md"), "conductor content");
        await seedWt.commit({ message: "seed plan + conductor content" });
        await seedWt.merge({});

        const fs = await import("fs");
        const fileExists = async (worktree: Worktree, ...parts: string[]) => {
          await worktree.child(".meta"); // force lazy worktree resolution
          return fs.existsSync(join(worktree.path, ...parts));
        };

        const planMirrors = Array.from({ length: 4 }, () => trunk.mirror("plan", ".meta/plan"));
        const planResults = await Promise.all(planMirrors.map((m) => fileExists(m.files as Worktree, ".meta", "plan", "p.md")));
        for (const found of planResults) expect(found).toBe(true);

        // Same underlying worktree, narrowed to a different subtree — must
        // actually re-narrow (not skip based on a stale "already narrowed"
        // cache keyed only by worktree, ignoring which subtree it was for).
        const conductorMirror = trunk.mirror("plan", ".meta/conductor");
        expect(await fileExists(conductorMirror.files as Worktree, ".meta", "conductor", "c.md")).toBe(true);

        // And narrowing back to plan afterward still works too.
        const planAgain = trunk.mirror("plan", ".meta/plan");
        expect(await fileExists(planAgain.files as Worktree, ".meta", "plan", "p.md")).toBe(true);
      },
    );
  });

  describe("DerivedTrunk.advance() — real merge-preserving replay (design doc §4.4)", () => {
    it("is a no-op ('ok') when the derived trunk's tip already equals the parent's tip", async () => {
      const derived = trunk.derive("__exp/e1/main");
      const result = await derived.advance(await makeResolver("noop"));
      expect(result.status).toBe("ok");
    });

    it("publishes a not-yet-pushed derived trunk to origin even when it's already content-caught-up with parent (no replay needed)", async () => {
      const derived = trunk.derive("__exp/e2/main");
      // Diverge the derived trunk from its parent, but only LOCALLY — never
      // pushed. This is what a variation looks like mid-experiment before
      // its first ever advance()/promotion.
      const derivedCheckedOut = await createDiskCheckedOutMovement(derived, "wip/on-derived", scratchRoot);
      await derivedCheckedOut.files.createFile("exp.txt", "v1");
      await derivedCheckedOut.commit({ message: "exp change" });
      await derivedCheckedOut.discard();
      const bareGit = (repo as DiskBareRepository).getGit();
      const derivedTip = await bareGit.commitTree("wip/on-derived", [derived.branch], "land onto derived trunk");
      await repo.updateBranch(derived.branch, derivedTip);
      expect(originRefOrNull(originPath, derived.branch)).toBeNull(); // sanity: nothing published yet

      const result = await derived.advance(await makeResolver("catchup"));
      expect(result.status).toBe("ok");
      // Invariant A: origin actually has it now, not just the local cache.
      expect(originRef(originPath, derived.branch)).toBe(derivedTip);
    });

    it("preserves a real merge commit already in the derived trunk's history while re-parenting it onto a moved parent tip", async () => {
      const derived = trunk.derive("__exp/e3/main");
      // Publish the (still-empty) derived branch first so its later history
      // exists in the SAME clone `advance()`'s replay worktree operates
      // against (no need to push intermediate history to origin — advance()
      // only needs the objects reachable locally in this repo).
      await derived.advance(await makeResolver("seed-e3"));
      const bareGit = (repo as DiskBareRepository).getGit();
      const oldParentTip = await repo.resolveLocalRef(derived.branch);
      if (oldParentTip === null) throw new Error("expected derived trunk to have a tip");

      // Build a genuine two-parent merge commit directly on the derived
      // trunk's branch via commit-tree (bypassing `Movement.merge()`'s
      // single-parent flatten, which this codebase's implementation applies
      // uniformly to every trunk it targets, root or derived — so under
      // NORMAL usage today a derived trunk's history never actually
      // accumulates a real multi-parent commit from movements landing on
      // it. Building one directly here proves the REPLAY MECHANISM itself
      // (rebase --rebase-merges) genuinely preserves a merge commit's shape
      // if one exists, matching design doc §4.4's literal contract,
      // independent of whether today's Movement.merge() happens to produce
      // one in practice.)
      const sideHash = await bareGit.commitTree(derived.branch, [derived.branch], "side commit");
      const mergeHash = await bareGit.commitTree(derived.branch, [derived.branch, sideHash], "merge side into derived");
      await repo.updateBranch(derived.branch, mergeHash);
      // Sanity check against the CLONE's own object store (`repo.path`), not
      // origin — `mergeHash` hasn't been pushed anywhere yet at this point.
      expect(localParentCount(repo, mergeHash)).toBe(2);

      // Advance the PARENT (main) further, so advance() must do a real
      // replay (not just a fast-forward catch-up). Checked out on a
      // THROWAWAY branch, never `main` itself — a `Trunk`'s own branch is
      // never checked out anywhere in this design; landing the content onto
      // `main` is done via `updateBranch`, matching this file's own
      // `beforeEach` setup pattern (the "seed" branch).
      const mainWt = await repo.createWorktree(scratchRoot, "main-advance-wt", "main-advance-scratch");
      await mainWt.createFile("main-progress.txt", "v2");
      const newMainTip = await mainWt.commitAll("main moves forward");
      await repo.updateBranch("main", newMainTip);
      await repo.pushBranch("main");

      const result = await derived.advance(await makeResolver("e3"));
      expect(result.status).toBe("ok");

      // `originRef` throws if the ref doesn't resolve, so a successful call
      // already proves it's present — `newTip` is a real, non-null sha.
      const newTip = originRef(originPath, derived.branch);
      expect(newTip).not.toBe(mergeHash); // genuinely re-parented, not the same commit
      // The merge commit's SHAPE survived the replay: still 2 parents.
      expect(originParentCount(originPath, newTip)).toBe(2);
      // And it's now reachable from the NEW parent tip (real re-parenting).
      expect(await bareGit.mergeBaseIsAncestor(newMainTip, newTip)).toBe(true);
      // The old parent tip this trunk WAS based on is no longer a strict
      // requirement for reachability — the trunk is now ahead of the
      // original divergence point via the new mainline.
      expect(await bareGit.mergeBaseIsAncestor(oldParentTip, newTip)).toBe(true);
    });

    it("fails clean on a real content conflict — trunk never touched, no partial/resumable state left behind", async () => {
      const derived = trunk.derive("__exp/e4/main");

      // Diverge the derived trunk: modify shared.txt.
      const derivedCheckedOut = await createDiskCheckedOutMovement(derived, "wip/on-derived-conflict", scratchRoot);
      await derivedCheckedOut.files.createFile("shared.txt", "derived version");
      await derivedCheckedOut.commit({ message: "derived changes shared.txt" });
      const mergeResult = await derivedCheckedOut.merge({});
      expect(mergeResult.status).toBe("success");
      const derivedTipBefore = originRef(originPath, derived.branch);
      expect(derivedTipBefore).not.toBeNull();

      // Advance the PARENT with a CONFLICTING change to the same file.
      const mainWt = await repo.createWorktree(scratchRoot, "main-conflict-wt", "main-conflict-scratch");
      await mainWt.createFile("shared.txt", "main version — conflicts");
      const newMainTip = await mainWt.commitAll("main changes shared.txt differently");
      await repo.updateBranch("main", newMainTip);
      await repo.pushBranch("main");

      const resolveIn = await makeResolver("e4-conflict");
      const worktreesBefore = (await repo.worktrees()).length;
      const result = await derived.advance(resolveIn);
      expect(result.status).toBe("conflict");
      if (result.status === "conflict") {
        expect(result.message).toMatch(/conflict/i);
      }

      // Nothing was published — origin's derived branch is exactly where it
      // was before this failed advance() attempt.
      expect(originRef(originPath, derived.branch)).toBe(derivedTipBefore);
      // The trunk itself was NEVER checked out, even mid-failure.
      const worktrees = await repo.worktrees();
      for (const wt of worktrees) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }
      // The scratch worktree used for the failed attempt was cleaned up —
      // no leftover worktree count growth from this failed attempt.
      expect(worktrees.length).toBe(worktreesBefore);
    });

    it(
      "recovers via internal fetch-and-retry when the derived trunk's OWN branch moved concurrently, unknown to this actor's local cache",
      async () => {
        // Regression test: a genuinely separate actor pushing directly to
        // the derived trunk's branch between this actor's snapshot and its
        // `advance()` call must not leave the caller stuck retrying against
        // a stale local cache. `advance()` fetches on a lost push-CAS race
        // (see `DiskDerivedTrunk.advance()`'s own doc comment), so ONE
        // `advance()` call fully recovers — internally fetching,
        // recomputing, and landing a result that includes BOTH the
        // interloper's change and the moved parent's change, not just
        // failing clean and leaving recovery to the caller.
        const derived = trunk.derive("__exp/e5/main");
        const bareGit = (repo as DiskBareRepository).getGit();
        const derivedCheckedOut = await createDiskCheckedOutMovement(derived, "wip/on-derived-race", scratchRoot);
        await derivedCheckedOut.files.createFile("feature.txt", "v1");
        await derivedCheckedOut.commit({ message: "add feature" });
        const mergeResult = await derivedCheckedOut.merge({});
        expect(mergeResult.status).toBe("success");

        // A genuinely independent actor pushes ANOTHER commit directly onto
        // the SAME derived trunk branch, from a separate clone — this
        // actor's (`repo`'s) local cache of `derived.branch` has no idea
        // this happened.
        const interloper = await sandbox.cloneBare(originPath, sandbox.root, "interloper-derived.git");
        // A fresh clone only gets a LOCAL branch for the default branch
        // (`main`) — `derived.branch` exists only as a remote-tracking ref
        // (`origin/<derived.branch>`) until explicitly created locally.
        // Without this, `createWorktree` below would silently create a
        // BRAND NEW local branch of the same name off HEAD (losing the
        // already-merged commit `Movement.merge()` published), not check
        // out the actual existing branch.
        await interloper.createBranchIfMissing(derived.branch, `origin/${derived.branch}`);
        const interloperWt = await interloper.createWorktree(sandbox.root, "interloper-derived-wt", derived.branch);
        await interloperWt.createFile("interloper.txt", "x");
        const interloperTip = await interloperWt.commitAll("interloper change on derived trunk");
        await interloper.pushBranch(derived.branch);

        // Advance the parent too, forcing a real replay (not just
        // catch-up), built against this actor's STALE knowledge of the
        // derived trunk.
        const mainWt = await repo.createWorktree(scratchRoot, "main-advance-wt2", "main-advance-scratch2");
        await mainWt.createFile("main-progress2.txt", "v2");
        const newMainTip = await mainWt.commitAll("main moves forward again");
        await repo.updateBranch("main", newMainTip);
        await repo.pushBranch("main");

        // A single call — no caller-side retry loop — must converge.
        const result = await derived.advance(await makeResolver("e5-race"));
        expect(result.status).toBe("ok");

        const newTip = originRef(originPath, derived.branch);
        // Genuinely re-derived, not the interloper's commit re-published
        // as-is (it had to be rebased onto the new parent tip too).
        expect(newTip).not.toBe(interloperTip);
        expect(newTip).not.toBe(newMainTip);
        // The result is reachable from the moved parent tip...
        expect(await bareGit.mergeBaseIsAncestor(newMainTip, newTip)).toBe(true);
        // ...and actually contains BOTH the interloper's change and the
        // original feature commit's content — a real recompute against
        // fresh state, not a blind retry that dropped the interloper's
        // work. Read the tree contents directly off origin.
        const lsTree = execSync(`git ls-tree -r --name-only ${newTip}`, { cwd: originPath, encoding: "utf-8" });
        expect(lsTree).toContain("interloper.txt");
        expect(lsTree).toContain("feature.txt");
        expect(lsTree).toContain("main-progress2.txt");

        // This actor's own local cache reflects the confirmed publish too.
        const localTip = await repo.resolveLocalRef(derived.branch);
        expect(localTip).toBe(newTip);
      },
      45000,
    );
  });

  describe("DerivedTrunk.beginAdvance() / AdvanceAttempt — real resumable rebase (design doc §4.4)", () => {
    // `makeResolver` is shared with the `advance()` describe block above.

    /**
     * Diverges a fresh derived trunk from `main` with a REAL, real-git content
     * conflict (both sides edit `shared.txt` differently) so `beginAdvance()`
     * has something genuine to leave resumable — mirrors the "fails clean on
     * a real content conflict" test's setup above, factored out since every
     * test below needs it.
     */
    async function setupDivergedDerivedWithConflict(expName: string): Promise<{ derived: DerivedTrunk }> {
      const derived = trunk.derive(`__exp/${expName}/main`);
      const derivedCheckedOut = await createDiskCheckedOutMovement(derived, `wip/on-${expName}`, scratchRoot);
      await derivedCheckedOut.files.createFile("shared.txt", "derived version");
      await derivedCheckedOut.commit({ message: "derived changes shared.txt" });
      const mergeResult = await derivedCheckedOut.merge({});
      expect(mergeResult.status).toBe("success");

      // Advance the PARENT with a CONFLICTING change to the same file.
      const mainWt = await repo.createWorktree(scratchRoot, `main-conflict-wt-${expName}`, `main-conflict-scratch-${expName}`);
      await mainWt.createFile("shared.txt", "main version — conflicts");
      const newMainTip = await mainWt.commitAll("main changes shared.txt differently");
      await repo.updateBranch("main", newMainTip);
      await repo.pushBranch("main");

      return { derived };
    }

    /**
     * Diverges a fresh derived trunk from `main` with NON-conflicting content
     * on both sides (`feature.txt` on the derived trunk, `main-progress.txt`
     * on the parent) — `beginAdvance()` on this returns `"ready"` immediately,
     * no conflict at all, so tests using this can isolate the "trunk itself
     * moved mid-attempt" scenario without it being entangled with resolving
     * an unrelated pre-existing conflict.
     */
    async function setupDerivedWithNonConflictingDivergence(expName: string): Promise<{ derived: DerivedTrunk }> {
      const derived = trunk.derive(`__exp/${expName}/main`);
      const derivedCheckedOut = await createDiskCheckedOutMovement(derived, `wip/on-${expName}`, scratchRoot);
      await derivedCheckedOut.files.createFile("feature.txt", "v1");
      await derivedCheckedOut.commit({ message: "add feature" });
      const mergeResult = await derivedCheckedOut.merge({});
      expect(mergeResult.status).toBe("success");

      const mainWt = await repo.createWorktree(scratchRoot, `main-unrelated-wt-${expName}`, `main-unrelated-scratch-${expName}`);
      await mainWt.createFile("main-progress.txt", "v1");
      const newMainTip = await mainWt.commitAll("main moves, unrelated to feature.txt");
      await repo.updateBranch("main", newMainTip);
      await repo.pushBranch("main");

      return { derived };
    }

    /** Pushes a new commit directly onto `branch` from a genuinely separate clone of the same origin. */
    async function pushDirectlyOntoBranch(branch: string, worktreeName: string, fileName: string, content: string, message: string): Promise<string> {
      const interloper = await sandbox.cloneBare(originPath, sandbox.root, `${worktreeName}.git`);
      // A fresh clone only gets a local branch for the default branch — this
      // one needs an explicit local branch tracking the existing remote ref,
      // otherwise `createWorktree` would silently create a brand-new local
      // branch off HEAD instead of checking out the real existing history.
      await interloper.createBranchIfMissing(branch, `origin/${branch}`);
      const wt = await interloper.createWorktree(sandbox.root, `${worktreeName}-wt`, branch);
      await wt.createFile(fileName, content);
      const hash = await wt.commitAll(message);
      await interloper.pushBranch(branch);
      return hash;
    }

    function fileContentAt(hash: string, path: string): string {
      return execSync(`git show ${hash}:${path}`, { cwd: originPath, encoding: "utf-8" }).trim();
    }

    it("resolves a real conflict and publishes — the trunk itself is NEVER checked out at any point, and resolveIn's worktree is restored afterward", async () => {
      const { derived } = await setupDivergedDerivedWithConflict("bg1");
      const derivedTipBefore = originRef(originPath, derived.branch);
      const resolver = await makeResolver("bg1");
      const resolverWorktree = resolver.files as Worktree;
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-bg1");
      const worktreesBaseline = (await repo.worktrees()).length;

      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("conflict");
      expect(attempt.conflictedFiles).toContain("shared.txt");
      // A worktree mid-rebase-conflict is checked out on a DETACHED HEAD, not
      // a branch — `repo.worktrees()`'s `git worktree list --porcelain`
      // parsing only reports entries with a real `branch` line (see
      // `GitOperations.worktreeList`), so the borrowed resolver worktree is
      // invisible to it right now. What's still assertable: no worktree the
      // listing DOES report is checked out on the trunk's own branch or
      // "main" — and `attempt.files` IS `resolver.files`, the same worktree
      // object the whole time, never a separate newly-provisioned one.
      expect(attempt.files).toBe(resolver.files);
      for (const wt of await repo.worktrees()) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      await attempt.files.createFile("shared.txt", "resolved value");
      const resolved = await attempt.continueResolving();
      expect(resolved.status).toBe("ready");
      expect(resolved.conflictedFiles).toEqual([]);
      // Now that the rebase completed, the borrowed worktree is checked out
      // on a real (throwaway) branch again — no NEW worktree was ever
      // created (`beginAdvance()` borrowed `resolver`'s existing one), so the
      // total count never moved from the baseline, still never the trunk's
      // own branch or "main".
      const worktreesAfterResolve = await repo.worktrees();
      expect(worktreesAfterResolve.length).toBe(worktreesBaseline);
      for (const wt of worktreesAfterResolve) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      const result = await resolved.publish();
      expect(result.status).toBe("ok");
      for (const wt of await repo.worktrees()) {
        expect(wt.branch).not.toBe(derived.branch);
        expect(wt.branch).not.toBe("main");
      }

      const newTip = originRef(originPath, derived.branch);
      expect(newTip).not.toBe(derivedTipBefore);
      expect(fileContentAt(newTip, "shared.txt")).toBe("resolved value");
      // publish() restored resolver's own worktree to its original branch —
      // no leftover worktree from this attempt, and the resolver is usable
      // again exactly as it was before beginAdvance() borrowed it.
      expect((await repo.worktrees()).length).toBe(worktreesBaseline);
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-bg1");
    });

    it("publish() recomputes and succeeds cleanly when the parent moves further (unrelated change) after resolution", async () => {
      const { derived } = await setupDivergedDerivedWithConflict("bg2");
      const resolver = await makeResolver("bg2");
      const attempt = await derived.beginAdvance(resolver);
      await attempt.files.createFile("shared.txt", "resolved value");
      const resolved = await attempt.continueResolving();
      expect(resolved.status).toBe("ready");

      const otherWt = await repo.createWorktree(scratchRoot, "main-more-wt-bg2", "main-more-scratch-bg2");
      await otherWt.createFile("unrelated2.txt", "v3");
      const newerMainTip = await otherWt.commitAll("main moves again, unrelated");
      await repo.updateBranch("main", newerMainTip);
      await repo.pushBranch("main");

      const result = await resolved.publish();
      expect(result.status).toBe("ok");

      const newTip = originRef(originPath, derived.branch);
      expect(fileContentAt(newTip, "shared.txt")).toBe("resolved value");
      const lsTree = execSync(`git ls-tree -r --name-only ${newTip}`, { cwd: originPath, encoding: "utf-8" });
      expect(lsTree).toContain("unrelated2.txt");
      const bareGit = (repo as DiskBareRepository).getGit();
      expect(await bareGit.mergeBaseIsAncestor(newerMainTip, newTip)).toBe(true);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-bg2");
    });

    it("publish() returns to status 'conflict' (not failing outright) when the parent's further movement reopens a real conflict, and a second resolution round lands cleanly", async () => {
      const { derived } = await setupDivergedDerivedWithConflict("bg3");
      const resolver = await makeResolver("bg3");
      const attempt = await derived.beginAdvance(resolver);
      await attempt.files.createFile("shared.txt", "resolved value 1");
      const resolved = await attempt.continueResolving();
      expect(resolved.status).toBe("ready");

      // Parent moves AGAIN, with another conflicting edit to the same file.
      const otherWt = await repo.createWorktree(scratchRoot, "main-conflict-wt-bg3-2", "main-conflict-scratch-bg3-2");
      await otherWt.createFile("shared.txt", "main version v2 — conflicts again");
      const newerMainTip = await otherWt.commitAll("main changes shared.txt again");
      await repo.updateBranch("main", newerMainTip);
      await repo.pushBranch("main");

      const publishResult = await resolved.publish();
      expect(publishResult.status).toBe("conflict");
      // The SAME AdvanceAttempt object reflects the reopened conflict.
      expect(resolved.status).toBe("conflict");
      expect(resolved.conflictedFiles).toContain("shared.txt");

      await resolved.files.createFile("shared.txt", "resolved value 2");
      const resolvedAgain = await resolved.continueResolving();
      expect(resolvedAgain.status).toBe("ready");
      const finalResult = await resolvedAgain.publish();
      expect(finalResult.status).toBe("ok");

      const newTip = originRef(originPath, derived.branch);
      expect(fileContentAt(newTip, "shared.txt")).toBe("resolved value 2");
      const bareGit = (repo as DiskBareRepository).getGit();
      expect(await bareGit.mergeBaseIsAncestor(newerMainTip, newTip)).toBe(true);
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-bg3");
    });

    it("publish() extends the replay range and lands cleanly when the derived trunk ITSELF gains a new, non-conflicting commit before ever publishing (unknown to this actor's local cache)", async () => {
      const { derived } = await setupDerivedWithNonConflictingDivergence("bg4");
      const resolver = await makeResolver("bg4");
      const attempt = await derived.beginAdvance(resolver);
      // Nothing conflicts yet — `beginAdvance()` itself lands "ready" with no
      // resolution needed, isolating the "trunk moved mid-attempt" scenario
      // from any unrelated pre-existing conflict.
      expect(attempt.status).toBe("ready");

      const interloperTip = await pushDirectlyOntoBranch(derived.branch, "interloper-bg4", "interloper-mid.txt", "x", "interloper change mid-attempt");

      const result = await attempt.publish();
      expect(result.status).toBe("ok");

      const newTip = originRef(originPath, derived.branch);
      const lsTree = execSync(`git ls-tree -r --name-only ${newTip}`, { cwd: originPath, encoding: "utf-8" });
      // All three sources of content made it through — the extend-and-retry
      // never silently dropped the interloper's new commit.
      expect(lsTree).toContain("feature.txt");
      expect(lsTree).toContain("interloper-mid.txt");
      expect(lsTree).toContain("main-progress.txt");
      void interloperTip;
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-bg4");
    });

    it("publish() correctly REOPENS a conflict (never silently drops content) when the trunk's new commit itself conflicts with the parent", async () => {
      const { derived } = await setupDerivedWithNonConflictingDivergence("bg5");
      const resolver = await makeResolver("bg5");
      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("ready");

      // The interloper's new commit touches the SAME file the parent's own
      // advance touched (`main-progress.txt`) — the trunk didn't have this
      // file at all before, so extending the replay range to include it
      // genuinely reopens a real conflict against the parent's version.
      await pushDirectlyOntoBranch(derived.branch, "interloper-bg5", "main-progress.txt", "interloper's own conflicting version", "interloper conflicting change");

      const result = await attempt.publish();
      expect(result.status).toBe("conflict");
      // The SAME AdvanceAttempt object reflects the reopened conflict.
      expect(attempt.status).toBe("conflict");
      expect(attempt.conflictedFiles).toContain("main-progress.txt");

      await attempt.files.createFile("main-progress.txt", "final resolved value");
      const resolvedAgain = await attempt.continueResolving();
      expect(resolvedAgain.status).toBe("ready");
      const finalResult = await resolvedAgain.publish();
      expect(finalResult.status).toBe("ok");

      const newTip = originRef(originPath, derived.branch);
      expect(fileContentAt(newTip, "main-progress.txt")).toBe("final resolved value");
      expect(fileContentAt(newTip, "feature.txt")).toBe("v1");
      expect(await (resolver.files as Worktree).currentBranch()).toBe("wip/resolver-bg5");
    });

    it("abandon() genuinely leaves the derived trunk untouched, releases no worktree of its own, and restores resolveIn's worktree even mid-conflict", async () => {
      const { derived } = await setupDivergedDerivedWithConflict("bg6");
      const tipBefore = originRef(originPath, derived.branch);
      const resolver = await makeResolver("bg6");
      const resolverWorktree = resolver.files as Worktree;
      const worktreesBefore = (await repo.worktrees()).length;

      const attempt = await derived.beginAdvance(resolver);
      expect(attempt.status).toBe("conflict");
      // The borrowed worktree is mid-rebase-conflict (detached HEAD), so it's
      // invisible to `repo.worktrees()`'s branch-based listing right now
      // (see the "NEVER checked out" test's comment for why) — abandon()
      // still restores it via the retained `Worktree` object directly, not
      // via this listing, so the checks below (after abandon) are the
      // meaningful assertions here.

      await attempt.abandon();

      expect(originRef(originPath, derived.branch)).toBe(tipBefore);
      expect((await repo.worktrees()).length).toBe(worktreesBefore);
      // abandon() aborted the in-progress rebase and checked resolver's
      // worktree back out onto its original branch — usable again exactly
      // as it was before beginAdvance() borrowed it.
      expect(await resolverWorktree.hasInProgressRebase()).toBe(false);
      expect(await resolverWorktree.currentBranch()).toBe("wip/resolver-bg6");
      expect(await resolverWorktree.isDirty()).toBe(false);

      await expect(attempt.continueResolving()).rejects.toThrow();
      await expect(attempt.publish()).rejects.toThrow();
      // abandon() itself is idempotent.
      await expect(attempt.abandon()).resolves.toBeUndefined();
    });

    it("rejects upfront when resolveIn's worktree is dirty — no branch switch attempted, no scratch branch created, derived trunk untouched (finding #14)", async () => {
      const { derived } = await setupDivergedDerivedWithConflict("bg7");
      const tipBefore = originRef(originPath, derived.branch);
      const resolver = await makeResolver("bg7");
      const resolverWorktree = resolver.files as Worktree;
      const originalBranch = await resolverWorktree.currentBranch();
      const worktreesBefore = (await repo.worktrees()).length;

      // Dirty the resolver's worktree with an uncommitted change BEFORE
      // beginAdvance() ever gets a chance to touch it.
      await resolverWorktree.createFile("uncommitted.txt", "not yet committed");
      expect(await resolver.isDirty()).toBe(true);

      await expect(derived.beginAdvance(resolver)).rejects.toThrow(
        /uncommitted changes.*commit or discard/,
      );

      // No worktree/branch mutation of any kind was attempted: resolver is
      // still on its original branch, still dirty with exactly the same
      // uncommitted content, no in-progress rebase, no new worktree, and the
      // derived trunk itself never moved.
      expect(await resolverWorktree.currentBranch()).toBe(originalBranch);
      expect(await resolverWorktree.hasInProgressRebase()).toBe(false);
      expect(await resolver.isDirty()).toBe(true);
      expect((await repo.worktrees()).length).toBe(worktreesBefore);
      expect(originRef(originPath, derived.branch)).toBe(tipBefore);
    });
  });
});
