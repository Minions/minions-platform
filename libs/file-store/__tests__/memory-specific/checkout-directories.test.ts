import { describe, it, expect } from "vitest";
import { createInMemorySandbox, simulateRemote, createLair } from "../../src/index.js";
import type { Worktree } from "../../src/port/types.js";

describe("directories materialized by checkout", () => {
  const REPO_URL = "https://example.com/CodeWarp/suite.git";

  it("children() lists a subdirectory that exists only through checkout-copied nested files", async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, "remote-seed", "main");
    await remoteMain.createFile(".meta/plan/r1/index.json", "{}");
    await remoteMain.commitAll("seed nested tree");

    const bareRepo = await lair.addWorkRepo("local", REPO_URL);
    await bareRepo.fetch();
    await bareRepo.updateBranch("main", "origin/main");
    const cabinetDir = await lair.cabinet();
    const planningDir = await cabinetDir.createDirectory("planning");
    const mirror = await bareRepo.createSparseWorktree(planningDir, "the-mirror", "main", ".meta/plan");

    const metaResult = await mirror.child(".meta");
    if (!metaResult.found) throw new Error("expected .meta");
    const planResult = await (metaResult.node as Worktree).child("plan");
    if (!planResult.found) throw new Error("expected .meta/plan");

    const names = (await (planResult.node as Worktree).children()).map((c) => c.name);
    expect(names).toContain("r1");
  });
});
