/**
 * Unit coverage for `clearBlockedObjectFiles` — the recovery step for
 * git's "unable to write file .../objects/xx/yyyy...: Permission denied"
 * error on Windows (a stray read-only loose object left by an earlier
 * failed attempt blocks every later write of that same content-addressed
 * object). See the doc comment in GitOperations.ts for the full mechanism.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { clearBlockedObjectFiles, isTransientWriteError, resolveContentionKey, GitCoordinationState } from "./GitOperations.js";
import { DiskSandbox } from "./DiskSandbox.js";
import { rmRetry, useRealGitTimeout } from "../../../__tests__/disk-test-helpers.js";

useRealGitTimeout();

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rmRetry(tmpDir);
    tmpDir = "";
  }
});

function writeStrayObject(objectPath: string, content: string): void {
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, content, { flag: "wx" });
  chmodSync(objectPath, 0o444);
}

function gitErrorMessage(objectPath: string): string {
  return (
    `Git command failed: git commit --allow-empty-message -F -\n` +
    `error: unable to write file ${objectPath}: Permission denied\n` +
    `error: Error building trees\n` +
    `error: could not commit staged changes.\n`
  );
}

describe("clearBlockedObjectFiles", () => {
  it("clears a read-only stray object file named in the error and reports it cleared", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-object-"));
    const objectPath = join(tmpDir, "objects", "89", "b6d6d414b201bb9569bb59ba3254fba83d3c94");
    writeStrayObject(objectPath, "stray loose object content");

    const cleared = await clearBlockedObjectFiles(gitErrorMessage(objectPath.replace(/\\/g, "/")));

    expect(cleared).toBe(true);
    expect(existsSync(objectPath)).toBe(false);
  });

  it("returns false and does not throw when the named object file doesn't exist", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-object-"));
    const objectPath = join(tmpDir, "objects", "08", "0ba88e419b7e538d36f35b745145d62663935b");

    const cleared = await clearBlockedObjectFiles(gitErrorMessage(objectPath.replace(/\\/g, "/")));

    expect(cleared).toBe(false);
  });

  it("returns false for an error message with no object-write failure in it", async () => {
    const cleared = await clearBlockedObjectFiles("error: some unrelated git failure\n");
    expect(cleared).toBe(false);
  });

  it("clears every blocked object when the error names more than one", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-object-"));
    const first = join(tmpDir, "objects", "89", "b6d6d414b201bb9569bb59ba3254fba83d3c94");
    const second = join(tmpDir, "objects", "08", "0ba88e419b7e538d36f35b745145d62663935b");
    writeStrayObject(first, "one");
    writeStrayObject(second, "two");
    const message =
      gitErrorMessage(first.replace(/\\/g, "/")) + gitErrorMessage(second.replace(/\\/g, "/"));

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("ignores a path that merely mentions 'objects' but isn't shaped like a loose object path", async () => {
    const cleared = await clearBlockedObjectFiles(
      gitErrorMessage("/some/repo/objects/README.md")
    );
    expect(cleared).toBe(false);
  });

  it("clears a stray object file named as the destination of a 'differ in contents' collision error", async () => {
    // This is the genuinely-corrupt-object case (a truncated/partial copy left at the
    // content-addressed path by Windows' non-atomic MOVEFILE_COPY_ALLOWED rename fallback,
    // per docs/design/movement-trunk-safety-redesign.md §6) — distinct from the read-only-
    // valid-duplicate case above. git's check_collision() reports it as "files 'X' and 'Y'
    // differ in contents", never "permission denied", so it needs its own match.
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-object-"));
    const objectPath = join(tmpDir, "objects", "89", "b6d6d414b201bb9569bb59ba3254fba83d3c94");
    writeStrayObject(objectPath, "truncated garbage content");
    const tmpObjPath = join(tmpDir, "objects", "tmp_obj_ab12cd");
    const message =
      `Git command failed: git commit --allow-empty-message -F -\n` +
      `error: files '${tmpObjPath.replace(/\\/g, "/")}' and '${objectPath.replace(/\\/g, "/")}' differ in contents\n`;

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(true);
    expect(existsSync(objectPath)).toBe(false);
  });

  it("does not clear the source side of a 'differ in contents' error, only the object-shaped destination", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-object-"));
    const objectPath = join(tmpDir, "objects", "89", "b6d6d414b201bb9569bb59ba3254fba83d3c94");
    writeStrayObject(objectPath, "truncated garbage content");
    const message =
      `error: files 'not-an-object-path.tmp' and '${objectPath.replace(/\\/g, "/")}' differ in contents\n`;

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(true);
    expect(existsSync(objectPath)).toBe(false);
  });

  it("clears a stale ref lockfile named in a 'cannot lock ref' error — verified against real git's own message for this exact scenario", async () => {
    // Reproduced directly against real git: `git branch -f <name> <target>`
    // against a repo with a pre-existing `refs/heads/<name>.lock` fails with
    // exactly this message shape, unconditionally, until the file is gone.
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-lock-"));
    const lockPath = join(tmpDir, "refs", "heads", "main.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "");
    const message =
      `Git command failed: git branch -f main origin/main\n` +
      `fatal: cannot lock ref 'refs/heads/main': Unable to create '${lockPath.replace(/\\/g, "/")}': File exists.\n\n` +
      `Another git process seems to be running in this repository, or the lock file may be stale\n`;

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clears a stale index.lock the same way", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-lock-"));
    const lockPath = join(tmpDir, "index.lock");
    writeFileSync(lockPath, "");
    const message = `fatal: Unable to create '${lockPath.replace(/\\/g, "/")}': File exists.\n`;

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("returns false and does not throw when the named lock file doesn't exist", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-blocked-lock-"));
    const lockPath = join(tmpDir, "refs", "heads", "main.lock");
    const message = `fatal: cannot lock ref 'refs/heads/main': Unable to create '${lockPath.replace(/\\/g, "/")}': File exists.\n`;

    const cleared = await clearBlockedObjectFiles(message);

    expect(cleared).toBe(false);
  });
});

describe("isTransientWriteError", () => {
  it("is true for the existing permission-denied / build-tree failure text", () => {
    expect(isTransientWriteError("error: unable to write file /r/objects/89/xyz: Permission denied")).toBe(true);
    expect(isTransientWriteError("error: Error building trees")).toBe(true);
  });

  it("is true for a 'differ in contents' collision error (the corrupt-object case)", () => {
    expect(isTransientWriteError("error: files 'a' and 'b' differ in contents")).toBe(true);
  });

  it("is true for check_collision's 'unable to open' error", () => {
    expect(isTransientWriteError("error: unable to open /r/objects/89/xyz")).toBe(true);
  });

  it("is true for a stale ref lockfile error", () => {
    expect(
      isTransientWriteError(
        "fatal: cannot lock ref 'refs/heads/main': Unable to create '/r/refs/heads/main.lock': File exists."
      )
    ).toBe(true);
  });

  it("is true for a stale index.lock error even without the 'cannot lock ref' prefix", () => {
    expect(isTransientWriteError("fatal: Unable to create '/r/.git/index.lock': File exists.")).toBe(true);
  });

  it("is false for an unrelated git failure", () => {
    expect(isTransientWriteError("error: pathspec 'foo' did not match any file(s) known to git")).toBe(false);
  });
});

describe("resolveContentionKey", () => {
  it("resolves two linked worktrees of the same bare repo to the same key", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-contention-key-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const first = await repo.createWorktree(sandbox.root, "first-wt", "main");
    await first.createFile("seed.txt", "seed");
    await first.commitAll("seed commit");
    await repo.createBranchIfMissing("other-branch", "main");
    const second = await repo.createWorktree(sandbox.root, "second-wt", "other-branch");

    const firstKey = await resolveContentionKey(first.path);
    const secondKey = await resolveContentionKey(second.path);

    expect(resolve(firstKey)).toBe(resolve(secondKey));
    expect(firstKey).not.toBe(first.path);
  });

  it("resolves a bare repo (no linked-worktree .git file) to its own path", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-contention-key-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");

    const key = await resolveContentionKey(repo.path);

    expect(resolve(key)).toBe(resolve(repo.path));
  });

  it("resolves a plain, non-repo directory to its own path", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-contention-key-"));

    const key = await resolveContentionKey(tmpDir);

    expect(key).toBe(tmpDir);
  });
});

describe("GitCoordinationState.cachedFetch", () => {
  it("coalesces concurrent calls into a single underlying fetch", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    // Both calls are issued before either has a chance to run its
    // continuation past the shared contention-key lookup, so the second
    // must see the first's fetch already in flight and join it rather than
    // starting its own.
    const first = coordination.cachedFetch("/fake/repo", doFetch, false);
    const second = coordination.cachedFetch("/fake/repo", doFetch, false);
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it("serves a cached success without calling doFetch again inside the freshness window", async () => {
    const coordination = new GitCoordinationState();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      let calls = 0;
      const doFetch = async () => {
        calls++;
      };

      await coordination.cachedFetch("/fake/repo", doFetch, false);
      nowSpy.mockReturnValue(1_000_000 + 60_000); // 1 minute later — inside the 2-minute TTL
      await coordination.cachedFetch("/fake/repo", doFetch, false);

      expect(calls).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("calls doFetch again once the cached result has expired", async () => {
    const coordination = new GitCoordinationState();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      let calls = 0;
      const doFetch = async () => {
        calls++;
      };

      await coordination.cachedFetch("/fake/repo", doFetch, false);
      nowSpy.mockReturnValue(2_000_000 + 3 * 60_000); // 3 minutes later — past the 2-minute TTL
      await coordination.cachedFetch("/fake/repo", doFetch, false);

      expect(calls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("force bypasses a still-fresh cached result", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    await coordination.cachedFetch("/fake/repo", doFetch, false);
    await coordination.cachedFetch("/fake/repo", doFetch, true);

    expect(calls).toBe(2);
  });

  it("a failed forced fetch invalidates the cache so the next call retries instead of trusting stale success", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const succeed = async () => {
      calls++;
    };
    const fail = async () => {
      calls++;
      throw new Error("offline");
    };

    await coordination.cachedFetch("/fake/repo", succeed, false);
    await expect(coordination.cachedFetch("/fake/repo", fail, true)).rejects.toThrow("offline");
    await coordination.cachedFetch("/fake/repo", succeed, false); // should NOT be served from cache

    expect(calls).toBe(3);
  });

  it("two different GitCoordinationState instances never share cache/coalescing state", async () => {
    const a = new GitCoordinationState();
    const b = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    await a.cachedFetch("/fake/repo", doFetch, false);
    await b.cachedFetch("/fake/repo", doFetch, false);

    expect(calls).toBe(2);
  });
});

describe("GitCoordinationState.fetchRefSinceGeneration", () => {
  it("starts at generation 0 and never fetches to answer refGeneration", async () => {
    const coordination = new GitCoordinationState();
    await expect(coordination.refGeneration("/fake/repo", "main")).resolves.toBe(0);
  });

  it("runs a real fetch and advances the generation when asked for newer than what's known", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    const generation = await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch);

    expect(calls).toBe(1);
    expect(generation).toBe(1);
    await expect(coordination.refGeneration("/fake/repo", "main")).resolves.toBe(1);
  });

  it("returns immediately, with no fetch, when the cache already knows about something newer", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch); // generation -> 1
    const generation = await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch); // still asking for "newer than 0"

    expect(calls).toBe(1);
    expect(generation).toBe(1);
  });

  it("coalesces concurrent same-generation callers into a single underlying fetch", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    // Both issued before either can observe the other's in-flight fetch —
    // the design doc §3.4 case: a burst of N callers losing a race in the
    // same window produces at most one or two real fetches, not N.
    const first = coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch);
    const second = coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch);
    const [firstGen, secondGen] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(firstGen).toBe(1);
    expect(secondGen).toBe(1);
  });

  it("keeps fetches scoped per-ref — a different ref's cache is untouched", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch);
    await expect(coordination.refGeneration("/fake/repo", "plan")).resolves.toBe(0);
    await coordination.fetchRefSinceGeneration("/fake/repo", "plan", 0, doFetch);

    expect(calls).toBe(2);
  });

  it("a caller who already saw a newer generation than what just completed joins the still-fresher wait, not a stale one", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const doFetch = async () => {
      calls++;
    };

    await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, doFetch); // generation -> 1
    await coordination.fetchRefSinceGeneration("/fake/repo", "main", 1, doFetch); // generation -> 2

    expect(calls).toBe(2);
    await expect(coordination.refGeneration("/fake/repo", "main")).resolves.toBe(2);
  });

  it("does not advance the generation on a failed fetch, so the next caller retries instead of trusting a phantom success", async () => {
    const coordination = new GitCoordinationState();
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("offline");
    };
    const succeed = async () => {
      calls++;
    };

    await expect(coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, fail)).rejects.toThrow("offline");
    await expect(coordination.refGeneration("/fake/repo", "main")).resolves.toBe(0);

    const generation = await coordination.fetchRefSinceGeneration("/fake/repo", "main", 0, succeed);
    expect(generation).toBe(1);
    expect(calls).toBe(2);
  });
});

describe("commitAll — cross-worktree parallelism", () => {
  it("lets two different worktrees of the same bare repo commit concurrently without corrupting either", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-parallel-commit-"));
    const sandbox = new DiskSandbox(tmpDir);
    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const first = await repo.createWorktree(sandbox.root, "first-wt", "main");
    await first.createFile("seed.txt", "seed");
    const seedHash = await first.commitAll("seed commit");
    await repo.createBranchIfMissing("second-branch", "main");
    const second = await repo.createWorktree(sandbox.root, "second-wt", "second-branch");

    // Each worktree commits its own sequence of changes one at a time (as a
    // real caller would — `commitAll` always commits the *entire* working
    // tree, so firing concurrent commits within one worktree races on
    // content regardless of any locking; that's a `commitAll`-is-all-or-
    // nothing property, not something this test is about). The two
    // worktrees' sequences run concurrently *with each other*, so their
    // add/commit pairs genuinely overlap in time.
    const firstCommits: string[] = [];
    const runFirst = (async () => {
      for (let i = 0; i < 5; i++) {
        await first.createFile(`first-${i}.txt`, `first ${i}`);
        firstCommits.push(await first.commitAll(`first commit ${i}`));
      }
    })();
    const secondCommits: string[] = [];
    const runSecond = (async () => {
      for (let i = 0; i < 5; i++) {
        await second.createFile(`second-${i}.txt`, `second ${i}`);
        secondCommits.push(await second.commitAll(`second commit ${i}`));
      }
    })();

    await Promise.all([runFirst, runSecond]);

    // Every commit hash is distinct and non-empty — no lost update, no two
    // commits colliding on the same hash, no cross-worktree interleaving
    // corrupting either branch's history.
    const allHashes = [...firstCommits, ...secondCommits];
    expect(new Set(allHashes).size).toBe(allHashes.length);
    expect(allHashes.every((h) => /^[0-9a-f]{40}$/.test(h))).toBe(true);

    const firstLog = await first.log(seedHash, "main");
    expect(firstLog.length).toBe(5);
    const secondLog = await second.log(seedHash, "second-branch");
    expect(secondLog.length).toBe(5);

    // HEAD of each branch is one of that worktree's own commits — no
    // cross-worktree write clobbered the other's branch pointer.
    expect(firstCommits).toContain(await repo.resolveLocalRef("main"));
    expect(secondCommits).toContain(await repo.resolveLocalRef("second-branch"));
  });
});

describe("DiskSandbox — injected GitCoordinationState", () => {
  it("threads an explicitly-constructed GitCoordinationState down through every worktree/bare-repo it creates, instead of the module-level default", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-operations-injected-coordination-"));
    const coordination = new GitCoordinationState();
    const worktreeSpy = vi.spyOn(coordination, "withWorktreeSerialization");
    const fetchSpy = vi.spyOn(coordination, "cachedFetch");

    const sandbox = new DiskSandbox(tmpDir, coordination);
    expect(sandbox.gitCoordination).toBe(coordination);

    const repo = await sandbox.initBare(sandbox.root, "repo.git");
    const worktree = await repo.createWorktree(sandbox.root, "wt", "main");
    await worktree.createFile("a.txt", "a");
    await worktree.commitAll("first commit");

    // The commit went through the INJECTED instance's per-worktree gate, not
    // some other (e.g. default) instance's — proves the constructor param
    // actually reaches the object that does the git work, not just that a
    // field got set.
    expect(worktreeSpy).toHaveBeenCalledWith(worktree.path, expect.any(Function));

    // No real remote is configured, so the fetch itself fails — only the
    // cache/coalescing call into OUR injected instance matters here.
    await worktree.fetch().catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
