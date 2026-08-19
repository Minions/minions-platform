import { describe, it, expect } from "vitest";
import { createInMemorySandbox, simulateRemote, createLair } from "../../src/index.js";

describe("Worktree rebase-continue primitives (in-memory)", () => {
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

  it("hasInProgressRebase() is false with no rebase underway", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    const workDir = await sandbox.root.createDirectory("work");
    const wt = await bareRepo.createWorktree(workDir, "clean", "main");
    expect(await wt.hasInProgressRebase()).toBe(false);
  });

  it("continueRebase() is a safe no-op success when no rebase is in progress", async () => {
    const { sandbox, bareRepo } = await makeBareRepo();
    const workDir = await sandbox.root.createDirectory("work");
    const wt = await bareRepo.createWorktree(workDir, "clean2", "main");
    const result = await wt.continueRebase();
    expect(result.status).toBe("success");
  });
});
