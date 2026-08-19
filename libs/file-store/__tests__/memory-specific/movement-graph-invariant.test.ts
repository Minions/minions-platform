import { describe, it, expect } from "vitest";
import { createInMemorySandbox, createInMemoryTrunk, createInMemoryCheckedOutMovement } from "../../src/index.js";
import type { Directory, Trunk } from "../../src/index.js";
import type { InMemoryBareRepository } from "../../src/adapters/memory/InMemoryBareRepository.js";
import type { SimulatedGit } from "../../src/adapters/memory/SimulatedGit.js";

/**
 * Proves `CheckedOutMovement.merge()` never squashes: after any combination of
 * movements/commits/merges, `main`'s history must read as a chain of
 * genuine two-parent merge commits, each with its movement's whole
 * incremental history intact and reachable as a linear side branch that
 * terminates exactly at the prior merge commit. This is the exact shape a
 * "collapse side branches" UI depends on — and the exact shape a
 * `commit-tree`-flattened landing commit (the historical bug this file
 * guards against) silently destroys.
 */

/**
 * Rules-based assertion: walks `tip`'s first-parent spine back to the root
 * and checks every node against the invariant. Throws a descriptive `Error`
 * naming the specific rule violated and the offending commit, plus a
 * rendering of the graph reachable from `tip`, on failure.
 */
function assertMovementGraph(git: SimulatedGit, tip: string): void {
  const fail = (rule: string, detail: string): never => {
    throw new Error(
      `Movement graph invariant violated: ${rule}\n${detail}\n\nGraph reachable from ${shortHash(tip)}:\n${formatGraph(git, tip)}`,
    );
  };

  const spine: { hash: string; parents: string[] }[] = [];
  let node: string | null = tip;
  while (node) {
    const commit = git.getCommit(node);
    if (!commit) return fail("spine walk reached an unknown commit", `commit ${shortHash(node)} not found in the repo`);
    spine.push({ hash: node, parents: commit.parents });
    node = commit.parents[0] ?? null;
  }

  const anyMerge = spine.some((n) => n.parents.length === 2);
  if (!anyMerge) {
    // Nothing has ever landed on this trunk yet — a purely linear chain
    // back to the root is the correct, valid shape for that state.
    return;
  }

  for (const { hash, parents } of spine) {
    if (parents.length === 0) continue; // the root — always the valid terminal case
    if (parents.length > 2) {
      fail(
        "a spine commit has more than two parents",
        `commit ${shortHash(hash)} has ${parents.length} parents (${parents.map(shortHash).join(", ")}) — only plain (1-parent) and merge (2-parent) commits are valid`,
      );
    }
    if (parents.length === 1) {
      fail(
        "a non-merge commit sits directly on main's spine after merges have already begun",
        `commit ${shortHash(hash)} has exactly one parent, but at least one merge commit exists further back in this history — once movements start landing, EVERY commit on main from the first merge onward must itself be a merge commit (this is exactly what an un-published/discarded real merge — i.e. a squashed landing commit — looks like)`,
      );
    }
    // parents.length === 2: a merge commit. First parent is guaranteed by
    // construction to be the next spine entry (the walk followed
    // parents[0]) — only the second parent (the side branch) needs
    // independent validation.
    const [firstParent, sideBranchTip] = parents;
    validateSideBranch(git, sideBranchTip, firstParent, hash, fail);
  }
}

/** Walks a merge commit's second parent back via strictly single-parent links until it reaches `joinAt` (the merge's first parent). */
function validateSideBranch(
  git: SimulatedGit,
  start: string,
  joinAt: string,
  mergeCommit: string,
  fail: (rule: string, detail: string) => never,
): void {
  const visited = new Set<string>();
  let node = start;
  while (node !== joinAt) {
    if (visited.has(node)) {
      fail(
        "a side branch contains a cycle",
        `the side branch of merge commit ${shortHash(mergeCommit)} revisits commit ${shortHash(node)} without ever reaching the merge's first parent ${shortHash(joinAt)}`,
      );
    }
    visited.add(node);
    const commit = git.getCommit(node);
    if (!commit) {
      return fail(
        "a side branch runs into an unknown commit",
        `the side branch of merge commit ${shortHash(mergeCommit)} references missing commit ${shortHash(node)}`,
      );
    }
    if (commit.parents.length !== 1) {
      fail(
        "a side branch commit is not strictly linear",
        `commit ${shortHash(node)} in the side branch of merge commit ${shortHash(mergeCommit)} has ${commit.parents.length} parent(s) (expected exactly 1) — side branches must be a linear chain of commits back to the merge's first parent, with no nested merges`,
      );
    }
    node = commit.parents[0];
  }
}

// Simulated hashes are already short (`commit-<8 hex digits>`) and — unlike
// real SHAs — share long common prefixes at low counter values, so this
// intentionally does NOT truncate (a truncated prefix would make distinct
// commits look identical in failure output).
function shortHash(hash: string): string {
  return hash;
}

/** Renders every commit reachable from `tip` (bounded, for readable failure output) as `hash [parent, parent] subject`. */
function formatGraph(git: SimulatedGit, tip: string, limit = 80): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && lines.length < limit) {
    const hash = stack.pop() as string;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const commit = git.getCommit(hash);
    if (!commit) {
      lines.push(`${shortHash(hash)} <missing>`);
      continue;
    }
    const parentList = commit.parents.length > 0 ? commit.parents.map(shortHash).join(", ") : "root";
    lines.push(`${shortHash(hash)} [${parentList}] ${commit.message.split("\n")[0]}`);
    stack.push(...commit.parents);
  }
  if (stack.length > 0) lines.push(`… (${stack.length}+ more commits omitted)`);
  return lines.join("\n");
}

async function makeRepo(): Promise<{ sandboxRoot: Directory; trunk: Trunk; git: SimulatedGit }> {
  const sandbox = createInMemorySandbox();
  const repo = await sandbox.initBare(sandbox.root, "repo");
  const seed = await repo.createWorktree(sandbox.root, "seed", "main");
  await seed.createFile("README.md", "hello");
  await seed.commitAll("initial commit");
  await repo.removeWorktree(seed);

  const trunk = createInMemoryTrunk(repo, "main", "tools");
  const git = (repo as InMemoryBareRepository).getGit();
  return { sandboxRoot: sandbox.root, trunk, git };
}

describe("Movement merge graph invariant (in-memory)", () => {
  it("passes for a freshly-initialized trunk with nothing merged yet", async () => {
    const { trunk, git } = await makeRepo();
    const tip = await trunk.movement("main").tipHash();
    assertMovementGraph(git, tip as string);
  });

  it("passes after a single movement with a single commit merges", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();
    const wt = await createInMemoryCheckedOutMovement(trunk, "wip/one", sandboxRoot.path);
    await wt.files.createFile("a.txt", "a");
    await wt.commit({ message: "add a" });

    const result = await wt.merge({ message: "land one" });
    expect(result.status).toBe("success");

    const tip = await trunk.movement("main").tipHash();
    assertMovementGraph(git, tip as string);
  });

  it("passes after a single movement with several commits merges (multi-commit side branch)", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();
    const wt = await createInMemoryCheckedOutMovement(trunk, "wip/many", sandboxRoot.path);
    await wt.files.createFile("a.txt", "a");
    await wt.commit({ message: "commit 1" });
    await wt.files.createFile("b.txt", "b");
    await wt.commit({ message: "commit 2" });
    await wt.files.createFile("c.txt", "c");
    await wt.commit({ message: "commit 3" });

    const result = await wt.merge({ message: "land many" });
    expect(result.status).toBe("success");

    const tip = await trunk.movement("main").tipHash();
    assertMovementGraph(git, tip as string);
  });

  it("passes after several movements merge one after another", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();

    for (const name of ["wip/first", "wip/second", "wip/third"]) {
      const wt = await createInMemoryCheckedOutMovement(trunk, name, sandboxRoot.path);
      await wt.files.createFile(`${name.split("/")[1]}.txt`, "content");
      await wt.commit({ message: `work on ${name}` });
      const result = await wt.merge({ message: `land ${name}` });
      expect(result.status).toBe("success");
    }

    const tip = await trunk.movement("main").tipHash();
    assertMovementGraph(git, tip as string);
  });

  it("passes when a movement is created before an earlier one lands, rebases onto the new tip, then merges (the real 'start then merge' workflow)", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();

    // Both movements branch from the SAME starting tip.
    const a = await createInMemoryCheckedOutMovement(trunk, "wip/race-a", sandboxRoot.path);
    await a.files.createFile("a.txt", "a");
    await a.commit({ message: "add a" });

    const b = await createInMemoryCheckedOutMovement(trunk, "wip/race-b", sandboxRoot.path);
    await b.files.createFile("b.txt", "b");
    await b.commit({ message: "add b" });
    await b.files.createFile("b2.txt", "b2");
    await b.commit({ message: "add b2" });

    // Land A first. B is still branched from the OLD tip at this point.
    const resultA = await a.merge({ message: "land a" });
    expect(resultA.status).toBe("success");

    // The real workflow (`MovementManager.mergeMovement`) always rebases the
    // movement's own checked-out worktree onto base's current tip
    // (`CheckedOutMovement.start()`) immediately before calling
    // `CheckedOutMovement.merge()` — this is what keeps the eventual merge
    // commit's side branch a strict linear descendant of the PRIOR merge
    // commit rather than a diamond back to some older common ancestor.
    const startResult = await b.start();
    expect(startResult.status).toBe("success");

    const resultB = await b.merge({ message: "land b" });
    expect(resultB.status).toBe("success");

    const tip = await trunk.movement("main").tipHash();
    assertMovementGraph(git, tip as string);
  });

  it("throws, naming the violated rule, when a squashed (single-parent) commit is appended directly on top of a real merge", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();

    const wt = await createInMemoryCheckedOutMovement(trunk, "wip/legit", sandboxRoot.path);
    await wt.files.createFile("a.txt", "a");
    await wt.commit({ message: "add a" });
    const result = await wt.merge({ message: "land legit" });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");

    // Directly construct an invalid state: a single-parent commit built on
    // top of the real merge commit (the shape a squashing merge
    // implementation would produce instead of a real merge commit), and
    // force `main` to it, bypassing `CheckedOutMovement.merge()` entirely —
    // proves `assertMovementGraph` itself catches this shape, rather than
    // relying on every real `merge()` call to already guarantee it.
    const squashed = git.commitTree(result.commit, [result.commit], "squashed landing commit");
    git.updateBranch("main", squashed);

    expect(() => assertMovementGraph(git, squashed)).toThrowError(
      /non-merge commit sits directly on main's spine/,
    );
  });

  it("throws, naming the violated rule, when a side branch contains a nested merge instead of being strictly linear", async () => {
    const { sandboxRoot, trunk, git } = await makeRepo();

    const wt = await createInMemoryCheckedOutMovement(trunk, "wip/base", sandboxRoot.path);
    await wt.files.createFile("a.txt", "a");
    await wt.commit({ message: "add a" });
    const baseResult = await wt.merge({ message: "land base" });
    expect(baseResult.status).toBe("success");
    if (baseResult.status !== "success") throw new Error("unreachable");

    // Hand-construct a merge commit whose second parent is itself a merge
    // commit (two parents) rather than a linear chain — an impossible shape
    // for `CheckedOutMovement.merge()` to ever legitimately produce, but
    // exactly what a broken future implementation might build.
    const rogueSideBranchTip = git.commitTree(baseResult.commit, [baseResult.commit, baseResult.commit], "rogue nested merge");
    const brokenMerge = git.commitTree(baseResult.commit, [baseResult.commit, rogueSideBranchTip], "broken merge with nested side-branch merge");
    git.updateBranch("main", brokenMerge);

    expect(() => assertMovementGraph(git, brokenMerge)).toThrowError(/side branch commit is not strictly linear/);
  });
});
