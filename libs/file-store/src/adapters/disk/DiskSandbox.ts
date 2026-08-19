/**
 * Disk Sandbox Implementation
 *
 * The OO entry point for the disk-based file store.
 * Provides a Sandbox interface with real filesystem and git operations.
 */

import { join, basename } from "path";
import type { Sandbox } from "../../port/Sandbox.js";
import type {
  Directory,
  BareRepository,
  ReadOnlyClone,
  CloneAuth,
} from "../../port/types.js";
import { DiskDirectory } from "./DiskDirectory.js";
import { DiskBareRepository } from "./DiskBareRepository.js";
import { DiskReadOnlyClone } from "./DiskReadOnlyClone.js";
import { GitOperations, GitCoordinationState, defaultGitCoordinationState } from "./GitOperations.js";

/**
 * Disk-based implementation of the Sandbox interface.
 *
 * All operations are performed on the real filesystem.
 */
export class DiskSandbox implements Sandbox {
  readonly root: Directory;

  /**
   * Shared git write-serialization/fetch-cache state for every
   * `GitOperations` this sandbox (and everything it constructs —
   * `DiskBareRepository`, `DiskWorktree`, `DiskReadOnlyClone`) creates. A
   * long-lived host process (the cabinet) that wants its own explicit,
   * inspectable instance passes one in; otherwise every sandbox shares the
   * module-level default — see `GitCoordinationState`'s own doc.
   */
  readonly gitCoordination: GitCoordinationState;

  constructor(rootPath: string, gitCoordination: GitCoordinationState = defaultGitCoordinationState) {
    // Root directory name is the basename of the path
    const name = basename(rootPath) || "root";
    this.root = new DiskDirectory(name, rootPath, this);
    this.gitCoordination = gitCoordination;
  }

  async cloneBare(
    url: string,
    into: Directory,
    name: string,
    auth?: CloneAuth
  ): Promise<BareRepository> {
    const intoDir = into as DiskDirectory;
    const repoPath = join(intoDir.path, name);

    const git = new GitOperations(repoPath, this.gitCoordination);
    await git.cloneBare(url, auth);

    return new DiskBareRepository(name, repoPath, url, this);
  }

  async cloneReadOnly(
    url: string,
    into: Directory,
    name: string,
    branch?: string,
    auth?: CloneAuth
  ): Promise<ReadOnlyClone> {
    const intoDir = into as DiskDirectory;
    const clonePath = join(intoDir.path, name);

    const git = new GitOperations(clonePath, this.gitCoordination);
    const actualBranch = await git.cloneWithBranch(url, clonePath, branch, auth);

    return new DiskReadOnlyClone(name, clonePath, url, actualBranch, this);
  }

  async initBare(into: Directory, name: string): Promise<BareRepository> {
    const intoDir = into as DiskDirectory;
    const repoPath = join(intoDir.path, name);

    const git = new GitOperations(repoPath, this.gitCoordination);
    await git.init(true);

    return new DiskBareRepository(name, repoPath, null, this);
  }
}
