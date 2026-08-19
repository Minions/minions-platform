/**
 * In-Memory Sandbox Adapter
 *
 * Provides a factory function to create in-memory sandboxes.
 */

import type { Sandbox } from "../../port/Sandbox.js";
import type { BareRepository, Trunk, CheckedOutMovement } from "../../port/types.js";
import { InMemorySandbox } from "./InMemorySandbox.js";
import { InMemoryBareRepository } from "./InMemoryBareRepository.js";
import { createInMemoryTrunk as createInMemoryTrunkImpl } from "./InMemoryTrunk.js";
import { createInMemoryCheckedOutMovement as createInMemoryCheckedOutMovementImpl } from "./InMemoryMovement.js";
import type { WorkAreaFactories } from "../../lair/SiteWorkArea.js";

/**
 * Creates an in-memory sandbox for testing.
 *
 * All data is stored in Map/Set data structures, making this
 * implementation fast and isolated - perfect for testing.
 */
export function createInMemorySandbox(): Sandbox {
  return new InMemorySandbox();
}

/**
 * Registers (or returns the already-registered) simulated "origin" for
 * `url` within an in-memory `sandbox` — a full bare repository tests can
 * create worktrees on and commit to directly. Any `cloneBare(url, ...)` for
 * the same URL (including via `Lair.addWorkRepo`) seeds its remote-tracking
 * refs from this remote's state at clone time; `fetch()` re-syncs later
 * commits, and `pushBranch()` publishes back to it. Lets tests exercise
 * behavior that depends on origin having state a local clone doesn't (yet,
 * or no longer) have, without real network or a second physical sandbox.
 *
 * `sandbox` must be one created by `createInMemorySandbox()` — throws
 * otherwise.
 */
export function simulateRemote(sandbox: Sandbox, url: string): BareRepository {
  if (!(sandbox instanceof InMemorySandbox)) {
    throw new Error("simulateRemote() only works with an in-memory sandbox (createInMemorySandbox())");
  }
  return sandbox.simulateRemote(url);
}

/**
 * Constructs an in-memory `Trunk` for `branch` in `repo` — see
 * docs/design/movement-trunk-safety-redesign.md §4.1. `repo` must be one
 * obtained from an in-memory `Sandbox` (e.g. `sandbox.initBare(...)` /
 * `sandbox.cloneBare(...)`) — throws otherwise.
 *
 * @param scratchRootPath - Storage path prefix worktrees created for this
 *   trunk's movements/mirrors/tools are nested under. Defaults to the
 *   sandbox root (`""`); pass a dedicated subdirectory to keep them out of
 *   the way of test assertions that walk the whole tree.
 */
export function createInMemoryTrunk(repo: BareRepository, branch: string, scratchRootPath = ""): Trunk {
  if (!(repo instanceof InMemoryBareRepository)) {
    throw new Error("createInMemoryTrunk() only works with an in-memory BareRepository");
  }
  return createInMemoryTrunkImpl(repo, branch, scratchRootPath);
}

/**
 * Constructs an in-memory `CheckedOutMovement`: ensures `branch` exists
 * (created off `base.branch` if missing) and gets-or-creates a real worktree
 * checked out on it. `base` must be a `Trunk` obtained from
 * `createInMemoryTrunk()`.
 */
export function createInMemoryCheckedOutMovement(
  base: Trunk,
  branch: string,
  scratchRootPath = "",
): Promise<CheckedOutMovement> {
  if (!(base.repo instanceof InMemoryBareRepository)) {
    throw new Error("createInMemoryCheckedOutMovement() only works with an in-memory Trunk");
  }
  return createInMemoryCheckedOutMovementImpl(base, branch, scratchRootPath);
}

/**
 * Constructs the in-memory-adapter-specific `WorkAreaFactories` a `WorkArea`
 * needs (`lair/work-area-types.ts` — design doc §4.2, end of section):
 * constructing a `Trunk` and constructing a `CheckedOutMovement`, both
 * pre-bound to `scratchRootPath` the same way `createInMemoryTrunk`/
 * `createInMemoryCheckedOutMovement` already are individually.
 */
export function createInMemoryWorkAreaFactories(scratchRootPath = ""): WorkAreaFactories {
  return {
    createTrunk: (repo, branch) => createInMemoryTrunk(repo, branch, scratchRootPath),
    createCheckedOutMovement: (base, branch) => createInMemoryCheckedOutMovement(base, branch, scratchRootPath),
  };
}
