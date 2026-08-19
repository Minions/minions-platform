import { describe, it, expect } from "vitest";
import { createInMemorySandbox, simulateRemote, createLair } from "../../src/index.js";

describe("Worktree trunk override (in-memory)", () => {
  const REPO_URL = "https://example.com/CodeWarp/suite.git";

  async function makeBareRepo() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, "remote-seed", "main");
    await remoteMain.createFile("README.md", "v1");
    await remoteMain.commitAll("seed");

    const bareRepo = await lair.addWorkRepo("local", REPO_URL);
    await bareRepo.fetch();
    await bareRepo.updateBranch("main", "origin/main");
    return { sandbox, bareRepo };
  }

  it("baseBranch() reports 'main' when no override is set", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    const workDir = await sandbox.root.createDirectory("work");
    const wt = await bareRepo.createWorktree(workDir, "plain", "main");
    expect(await wt.baseBranch()).toBe("main");
  });

  it("setBaseBranch() persists an override that baseBranch() then reports", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    const workDir = await sandbox.root.createDirectory("work");
    const wt = await bareRepo.createWorktree(workDir, "overridden", "main");
    await wt.setBaseBranch("experiment/foo");
    expect(await wt.baseBranch()).toBe("experiment/foo");
  });

  it("setBaseBranch(null) clears the override, reverting to 'main'", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    const workDir = await sandbox.root.createDirectory("work");
    const wt = await bareRepo.createWorktree(workDir, "cleared", "main");
    await wt.setBaseBranch("experiment/foo");
    expect(await wt.baseBranch()).toBe("experiment/foo");
    await wt.setBaseBranch(null);
    expect(await wt.baseBranch()).toBe("main");
  });

  it("scopes the override to a single worktree instance", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    // Two worktrees must be on different branches — real git (and this
    // simulation) refuses to check the same branch out in two worktrees
    // at once, same as production usage (a wing's trunk vs its own WIP branch).
    await bareRepo.updateBranch("other", "main");
    const workDir = await sandbox.root.createDirectory("work");
    const wtA = await bareRepo.createWorktree(workDir, "wt-a", "main");
    const wtB = await bareRepo.createWorktree(workDir, "wt-b", "other");

    await wtA.setBaseBranch("experiment/foo");

    expect(await wtA.baseBranch()).toBe("experiment/foo");
    expect(await wtB.baseBranch()).toBe("main");
  });
});
