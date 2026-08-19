import { describe, it, expect } from "vitest";
import { createInMemorySandbox, simulateRemote, createLair } from "../../src/index.js";

describe("commitAll targets the worktree's own branch", () => {
  const REPO_URL = "https://example.com/CodeWarp/suite.git";

  it("commits made via a plan/main worktree advance plan/main, not the shared current branch", async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, "remote-seed", "main");
    await remoteMain.createFile("README.md", "v1");
    await remoteMain.commitAll("seed");

    const bareRepo = await lair.addWorkRepo("local", REPO_URL);
    await bareRepo.fetch();
    await bareRepo.updateBranch("main", "origin/main");
    const workDir = await lair.root.createDirectory("work-here");
    await bareRepo.updateBranch("plan/main", "main");
    const planWorktree = await bareRepo.createWorktree(workDir, "on-plan", "plan/main");
    expect((planWorktree as unknown as { branch: string }).branch).toBe("plan/main");

    await planWorktree.createFile("claim.md", "claimed");
    await planWorktree.commitAll("commit on plan/main");

    const pending = await planWorktree.log("main", "plan/main");
    expect(pending.map((c) => c.subject)).toEqual(["commit on plan/main"]);
  });
});
