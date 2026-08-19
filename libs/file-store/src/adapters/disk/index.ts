/**
 * Disk Adapter
 *
 * Provides a factory function to create disk-based sandboxes.
 */

import type { Sandbox } from "../../port/Sandbox.js";
import type { BareRepository, Trunk, CheckedOutMovement, Directory } from "../../port/types.js";
import { DiskSandbox } from "./DiskSandbox.js";
import type { GitCoordinationState } from "./GitOperations.js";
import { createDiskTrunk as createDiskTrunkImpl } from "./DiskTrunk.js";
import { createDiskCheckedOutMovement as createDiskCheckedOutMovementImpl } from "./DiskMovement.js";
import type { WorkAreaFactories } from "../../lair/SiteWorkArea.js";

/**
 * Creates a disk-based sandbox rooted at the given path.
 *
 * All operations are performed on the real filesystem.
 *
 * @param rootPath - Absolute path to the sandbox root directory
 * @param gitCoordination - Optional shared git write-serialization/fetch-cache
 *   state (see `GitCoordinationState`). A long-lived host process (the
 *   cabinet) that wants its own explicit, inspectable instance — rather than
 *   every sandbox implicitly sharing one hidden module-level default —
 *   passes one here; omit to use the default.
 */
export function createDiskSandbox(rootPath: string, gitCoordination?: GitCoordinationState): Sandbox {
  return new DiskSandbox(rootPath, gitCoordination);
}

/**
 * Constructs a disk-based `Trunk` for `branch` in `repo` — see
 * docs/design/movement-trunk-safety-redesign.md §4.1. `repo` must be one
 * obtained from a disk `Sandbox` (e.g. `sandbox.initBare(...)` /
 * `sandbox.cloneBare(...)`).
 *
 * @param scratchRoot - Real filesystem directory worktrees created for this
 *   trunk's movements/mirrors/scratch work are nested under.
 */
export function createDiskTrunk(repo: BareRepository, branch: string, scratchRoot: Directory): Trunk {
  return createDiskTrunkImpl(repo, branch, scratchRoot);
}

/**
 * Constructs a disk-based `CheckedOutMovement`: ensures `branch` exists
 * (created off `base.branch` if missing) and gets-or-creates a real worktree
 * checked out on it. `base` must be a `Trunk` obtained from
 * `createDiskTrunk()`.
 */
export function createDiskCheckedOutMovement(
  base: Trunk,
  branch: string,
  scratchRoot: Directory,
): Promise<CheckedOutMovement> {
  return createDiskCheckedOutMovementImpl(base, branch, scratchRoot);
}

/**
 * Constructs the disk-adapter-specific `WorkAreaFactories` a `WorkArea`
 * needs (`lair/work-area-types.ts` — design doc §4.2, end of section):
 * constructing a `Trunk` and constructing a `CheckedOutMovement`, both
 * pre-bound to `scratchRoot` the same way `createDiskTrunk`/
 * `createDiskCheckedOutMovement` already are individually.
 */
export function createDiskWorkAreaFactories(scratchRoot: Directory): WorkAreaFactories {
  return {
    createTrunk: (repo, branch) => createDiskTrunkImpl(repo, branch, scratchRoot),
    createCheckedOutMovement: (base, branch) => createDiskCheckedOutMovementImpl(base, branch, scratchRoot),
  };
}
