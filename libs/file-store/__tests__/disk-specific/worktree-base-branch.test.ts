/**
 * Disk-specific tests for the per-worktree trunk override
 * (Worktree.setBaseBranch / baseBranch).
 *
 * Verifies the override is scoped to a single linked worktree (via
 * `git config --worktree`) rather than leaking to the whole repository —
 * the property that lets one wing track an experiment branch while every
 * other wing on the same bare repo keeps tracking the real default branch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import type { Worktree } from "../../src/port/types.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

// Real disk/git-backed: shells out to git for every operation. Needs more
// headroom than the package's fast default, and — per the surrounding
// suites in this directory — real git on this environment can be slow, so
// this is generous on top of the helper's own 30s default.
useRealGitTimeout(60000);

/** Built once for the whole file (read-only from every test's perspective) — see bare-repo-discovery.test.ts for the same pattern and rationale. */
let templatesRoot: string;
let source: string;

beforeAll(() => {
  templatesRoot = mkdtempSync(join(tmpdir(), "trunk-override-templates-"));
  const repoPath = join(templatesRoot, "source.git");
  mkdirSync(repoPath);
  execSync("git init --bare -q", { cwd: repoPath });

  const work = join(templatesRoot, "source-work");
  execSync(`git clone -q "${repoPath}" "${work}"`, { cwd: templatesRoot });
  execSync("git checkout -b main -q", { cwd: work });
  execSync('git commit --allow-empty -q -m "Initial commit"', { cwd: work });
  execSync("git push -q -u origin main", { cwd: work });
  execSync("git checkout -b experiment/foo -q", { cwd: work });
  execSync('git commit --allow-empty -q -m "Experiment commit"', { cwd: work });
  execSync("git push -q -u origin experiment/foo", { cwd: work });

  source = repoPath;
}, 60000);

afterAll(async () => {
  if (templatesRoot) await rmRetry(templatesRoot);
}, 60000);

describe("Worktree trunk override (disk)", () => {
  let tmpDir: string;
  let sandbox: DiskSandbox;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trunk-override-test-"));
    sandbox = new DiskSandbox(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) await rmRetry(tmpDir);
  });

  async function makeWorktree(name: string, branch: string): Promise<Worktree> {
    const cloneDir = await sandbox.root.createDirectory("clones");
    const repo = await sandbox.cloneBare(source, cloneDir, `${name}.git`);
    const worktreesDir = await sandbox.root.createDirectory("worktrees");
    return repo.createWorktree(worktreesDir, name, branch);
  }

  it("baseBranch() reports the remote default when no override is set", async () => {
    const wt = await makeWorktree("plain", "main");
    expect(await wt.baseBranch()).toBe("main");
  });

  it("setBaseBranch() persists an override that baseBranch() then reports", async () => {
    const wt = await makeWorktree("overridden", "main");
    await wt.setBaseBranch("experiment/foo");
    expect(await wt.baseBranch()).toBe("experiment/foo");
  });

  it("setBaseBranch(null) clears the override, reverting to the remote default", async () => {
    const wt = await makeWorktree("cleared", "main");
    await wt.setBaseBranch("experiment/foo");
    expect(await wt.baseBranch()).toBe("experiment/foo");
    await wt.setBaseBranch(null);
    expect(await wt.baseBranch()).toBe("main");
  });

  it("setBaseBranch(null) is a safe no-op when no override was ever set", async () => {
    const wt = await makeWorktree("never-overridden", "main");
    await wt.setBaseBranch(null);
    expect(await wt.baseBranch()).toBe("main");
  });

  it("does not break isDirty()/git status after setting an override", async () => {
    const wt = await makeWorktree("dirty-check", "main");
    await wt.setBaseBranch("experiment/foo");
    expect(await wt.isDirty()).toBe(false);
  });

  it("does not break isDirty()/git status in a sibling worktree of the same repo", async () => {
    // Regression: enabling extensions.worktreeConfig (needed the first time
    // any worktree calls setBaseBranch) is a repo-wide setting. Without
    // migrating every existing linked worktree's core.bare override, a
    // completely unrelated worktree on the same bare repo — e.g. another
    // wing that never touched trunk overrides — would start failing "this
    // operation must be run in a work tree" on its very next git status.
    const cloneDir = await sandbox.root.createDirectory("clones");
    const repo = await sandbox.cloneBare(source, cloneDir, "sibling-blast-radius.git");
    const worktreesDir = await sandbox.root.createDirectory("worktrees");
    const wtA = await repo.createWorktree(worktreesDir, "blast-a", "main");
    const wtB = await repo.createWorktree(worktreesDir, "blast-b", "experiment/foo");

    await wtA.setBaseBranch("experiment/foo"); // first call on this repo — enables extensions.worktreeConfig

    expect(await wtB.isDirty()).toBe(false); // wtB never called setBaseBranch, must still work
  });

  it("scopes the override to a single worktree, not the whole repository", async () => {
    const cloneDir = await sandbox.root.createDirectory("clones");
    const repo = await sandbox.cloneBare(source, cloneDir, "shared.git");
    const worktreesDir = await sandbox.root.createDirectory("worktrees");
    const wtA = await repo.createWorktree(worktreesDir, "wt-a", "main");
    const wtB = await repo.createWorktree(worktreesDir, "wt-b", "experiment/foo");

    await wtA.setBaseBranch("experiment/foo");

    expect(await wtA.baseBranch()).toBe("experiment/foo");
    expect(await wtB.baseBranch()).toBe("main"); // unaffected — no override set on this worktree
  });
});
