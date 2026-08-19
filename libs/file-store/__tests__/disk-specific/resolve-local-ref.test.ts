/**
 * Disk-specific tests for `BareRepository.resolveLocalRef()`. `Mirror`,
 * `Movement`, and `Trunk` all call this on every CAS attempt (comparing a
 * branch's current tip before publishing) and retry loop, so it reads loose
 * and packed refs directly off disk rather than spawning a `git` process —
 * a subprocess per read would be needless overhead at that call frequency.
 * The shared contract suite (`port/contracts.ts`) covers the cross-adapter
 * behavior; this file covers disk-only concerns: the packed-refs fallback,
 * and that no `git` process is ever spawned to answer the read.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import { useRealGitTimeout, rmRetry, execSync } from "../disk-test-helpers.js";

const execFileSpy = vi.fn();
const spawnSpy = vi.fn();
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();

  const execFileWrapper = ((...args: Parameters<typeof actual.execFile>) => {
    execFileSpy(...args);
    return actual.execFile(...args);
  }) as typeof actual.execFile;
  // Preserve execFile's custom util.promisify behavior (resolves with
  // {stdout, stderr} instead of just the first callback arg) — GitOperations
  // relies on promisify(execFile) having this shape.
  (execFileWrapper as unknown as Record<symbol, unknown>)[promisify.custom] =
    (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom];

  const spawnWrapper = ((...args: Parameters<typeof actual.spawn>) => {
    spawnSpy(...args);
    return actual.spawn(...args);
  }) as typeof actual.spawn;

  return { ...actual, execFile: execFileWrapper, spawn: spawnWrapper };
});

useRealGitTimeout();

let tmpDir: string;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmpDir) {
    await rmRetry(tmpDir);
  }
});

describe("DiskBareRepository.resolveLocalRef (disk-specific)", () => {
  it("resolves a branch packed via `git pack-refs` (no loose ref file left)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-local-ref-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const worktree = await repo.createWorktree(sandbox.root, "work", "main");
    await worktree.createFile("README.md", "# Test");
    const hash = await worktree.commitAll("Initial commit");

    execSync("git pack-refs --all", { cwd: repo.path });

    expect(await repo.resolveLocalRef("main")).toBe(hash);
  });

  it("resolves a remote-tracking ref (origin/main) via packed-refs", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-local-ref-"));
    const sourcePath = join(tmpDir, "source.git");
    execSync(`git init --bare -q "${sourcePath}"`);
    const sourceWork = join(tmpDir, "source-work");
    execSync(`git clone -q "${sourcePath}" "${sourceWork}"`);
    execSync("git checkout -b main -q", { cwd: sourceWork });
    execSync('git commit --allow-empty -q -m "Initial commit"', { cwd: sourceWork });
    execSync("git push -q -u origin main", { cwd: sourceWork });
    const hash = execSync("git rev-parse HEAD", { cwd: sourceWork, encoding: "utf-8" }).trim();

    const sandbox = new DiskSandbox(tmpDir);
    const cloneDir = await sandbox.root.createDirectory("clones");
    const repo = await sandbox.cloneBare(sourcePath, cloneDir, "cloned.git");

    execSync("git pack-refs --all", { cwd: repo.path });

    expect(await repo.resolveLocalRef("origin/main")).toBe(hash);
  });

  it("returns null for a ref that exists as neither a loose nor a packed ref", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-local-ref-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");

    expect(await repo.resolveLocalRef("nonexistent")).toBeNull();
  });

  it("never spawns a git process", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-local-ref-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const worktree = await repo.createWorktree(sandbox.root, "work", "main");
    await worktree.createFile("README.md", "# Test");
    await worktree.commitAll("Initial commit");
    execSync("git pack-refs --all", { cwd: repo.path });

    execFileSpy.mockClear();
    spawnSpy.mockClear();

    await repo.resolveLocalRef("main");
    await repo.resolveLocalRef("nonexistent");

    expect(execFileSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
