/**
 * Lair Implementation
 *
 * A single Lair class that works with any Sandbox implementation.
 * This replaces both DiskLair and InMemoryLair, which were identical
 * since all storage-specific behavior is in the Sandbox.
 */

import type { Sandbox } from "../port/Sandbox.js";
import type { Directory, BareRepository, ReadOnlyClone, CloneAuth } from "../port/types.js";
import type { Lair } from "./Lair.js";
import type { Wing } from "./Wing.js";
import type {
  WorkRepoResult,
  InfoRepoResult,
  PrivateRepoResult,
  WingResult,
  WingConfig,
} from "./lair-types.js";
import { LairWing } from "./LairWing.js";
import { asRepoAlias } from "./brandedIds.js";
import type { WorkAreaFactories } from "./SiteWorkArea.js";

/**
 * Implementation of the Lair interface.
 *
 * Works with any Sandbox (InMemorySandbox, DiskSandbox, etc.).
 * All storage-specific behavior is delegated to the Sandbox.
 */
export class LairImpl implements Lair {
  readonly sandbox: Sandbox;
  readonly name: string;
  readonly root: Directory;

  private _wings: Map<string, LairWing> = new Map();

  /**
   * Optional (design doc §4.2's `WorkArea`/`Scratchpad` accessors): when
   * supplied, every `Wing` this lair hands back can build the
   * `WorkArea`/`Scratchpad`-returning accessors
   * (`workAreaLocal`/`workAreaGlobal`/`workAreaNamed`/`privateWorkAreaGlobal`)
   * — see `Wing.ts`'s doc comment on why those exist alongside the
   * `Worktree`-returning surface rather than replacing it. Omitting this
   * (every existing call site does, today) leaves those accessors throwing a
   * clear error when called, but changes nothing else.
   */
  constructor(sandbox: Sandbox, workAreaFactories?: WorkAreaFactories) {
    this.sandbox = sandbox;
    this.name = sandbox.root.name;
    this.root = sandbox.root;
    this.workAreaFactories = workAreaFactories;
  }

  private readonly workAreaFactories?: WorkAreaFactories;

  // ========================================
  // Work Repositories
  // ========================================

  async workRepo(name: string): Promise<WorkRepoResult> {
    const workDirResult = await this.root.child("work");
    if (!workDirResult.found) {
      return { exists: false, name };
    }

    const workDir = workDirResult.node;
    if (!workDir.is("directory")) {
      return { exists: false, name };
    }

    const workDirTyped = workDir as Directory;
    const repoResult = await workDirTyped.child(`${name}.git`);
    if (!repoResult.found) {
      return { exists: false, name };
    }

    if (repoResult.node.is("bare-repository")) {
      return { exists: true, repo: repoResult.node as BareRepository };
    }

    return { exists: false, name };
  }

  async workRepos(): Promise<BareRepository[]> {
    const workDirResult = await this.root.child("work");
    if (!workDirResult.found) {
      return [];
    }

    const workDir = workDirResult.node;
    if (!workDir.is("directory")) {
      return [];
    }

    const workDirTyped = workDir as Directory;
    const children = await workDirTyped.children();
    const repos: BareRepository[] = [];

    for (const child of children) {
      if (child.is("bare-repository")) {
        repos.push(child as BareRepository);
      }
    }

    return repos;
  }

  async addWorkRepo(name: string, url: string, auth?: CloneAuth): Promise<BareRepository> {
    const workDir = await this.ensureDirectory("work");
    return this.sandbox.cloneBare(url, workDir, `${name}.git`, auth);
  }

  // ========================================
  // Info Repositories
  // ========================================

  async infoRepo(name: string): Promise<InfoRepoResult> {
    const infoDirResult = await this.root.child("info");
    if (!infoDirResult.found) {
      return { exists: false, name };
    }

    const infoDir = infoDirResult.node;
    if (!infoDir.is("directory")) {
      return { exists: false, name };
    }

    const infoDirTyped = infoDir as Directory;
    const cloneResult = await infoDirTyped.child(name);
    if (!cloneResult.found) {
      return { exists: false, name };
    }

    if (cloneResult.node.is("read-only-clone")) {
      return { exists: true, clone: cloneResult.node as ReadOnlyClone };
    }

    return { exists: false, name };
  }

  async infoRepos(): Promise<ReadOnlyClone[]> {
    const infoDirResult = await this.root.child("info");
    if (!infoDirResult.found) {
      return [];
    }

    const infoDir = infoDirResult.node;
    if (!infoDir.is("directory")) {
      return [];
    }

    const infoDirTyped = infoDir as Directory;
    const children = await infoDirTyped.children();
    const clones: ReadOnlyClone[] = [];

    for (const child of children) {
      if (child.is("read-only-clone")) {
        clones.push(child as ReadOnlyClone);
      }
    }

    return clones;
  }

  async addInfoRepo(name: string, url: string, auth?: CloneAuth, branch?: string): Promise<ReadOnlyClone> {
    const infoDir = await this.ensureDirectory("info");
    return this.sandbox.cloneReadOnly(url, infoDir, name, branch, auth);
  }

  // ========================================
  // Private Repositories
  // ========================================

  async privateRepo(scope: "local" | "global"): Promise<PrivateRepoResult> {
    const privateDirResult = await this.root.child("private");
    if (!privateDirResult.found) {
      return { exists: false, scope };
    }

    const privateDir = privateDirResult.node;
    if (!privateDir.is("directory")) {
      return { exists: false, scope };
    }

    const privateDirTyped = privateDir as Directory;
    // Private repos use bare name (local, global) not .git suffix
    const repoName = scope;
    const repoResult = await privateDirTyped.child(repoName);
    if (!repoResult.found) {
      return { exists: false, scope };
    }

    if (repoResult.node.is("bare-repository")) {
      return { exists: true, repo: repoResult.node as BareRepository };
    }

    return { exists: false, scope };
  }

  async initPrivateRepo(scope: "local" | "global"): Promise<BareRepository> {
    const privateDir = await this.ensureDirectory("private");
    // Private repos use bare name (local, global) not .git suffix
    const repoName = scope;
    return this.sandbox.initBare(privateDir, repoName);
  }

  // ========================================
  // Wings
  // ========================================

  async wing(name: string): Promise<WingResult> {
    const cached = this._wings.get(name);
    if (cached) {
      return { exists: true, wing: cached };
    }

    const wingsDirResult = await this.root.child("wings");
    if (!wingsDirResult.found) {
      return { exists: false, name };
    }

    const wingsDir = wingsDirResult.node;
    if (!wingsDir.is("directory")) {
      return { exists: false, name };
    }

    const wingsDirTyped = wingsDir as Directory;
    const wingResult = await wingsDirTyped.child(name);
    if (!wingResult.found) {
      return { exists: false, name };
    }

    if (wingResult.node.is("directory")) {
      const wing = new LairWing(name, wingResult.node as Directory, this, this.workAreaFactories);
      this._wings.set(name, wing);
      return { exists: true, wing };
    }

    return { exists: false, name };
  }

  async wings(): Promise<Wing[]> {
    const wingsDirResult = await this.root.child("wings");
    if (!wingsDirResult.found) {
      return [];
    }

    const wingsDir = wingsDirResult.node;
    if (!wingsDir.is("directory")) {
      return [];
    }

    const wingsDirTyped = wingsDir as Directory;
    const children = await wingsDirTyped.children();
    const wings: Wing[] = [];

    for (const child of children) {
      if (child.is("directory")) {
        const name = child.name;
        let wing = this._wings.get(name);
        if (!wing) {
          wing = new LairWing(name, child as Directory, this, this.workAreaFactories);
          this._wings.set(name, wing);
        }
        wings.push(wing);
      }
    }

    return wings;
  }

  async createWing(name: string, config: WingConfig): Promise<Wing> {
    const wingsDir = await this.ensureDirectory("wings");
    const wingDir = await wingsDir.createDirectory(name);

    const wing = new LairWing(name, wingDir, this, this.workAreaFactories);
    this._wings.set(name, wing);

    // Setup work/local (required)
    const workRepoResult = await this.workRepo(config.workLocal.repo);
    if (workRepoResult.exists) {
      await wing.setupWorkLocal(workRepoResult.repo, config.workLocal.branch);
    }

    // Setup work/global (optional)
    if (config.workGlobal) {
      const globalRepoResult = await this.workRepo(config.workGlobal.repo);
      if (globalRepoResult.exists) {
        await wing.setupWorkGlobal(globalRepoResult.repo, config.workGlobal.branch);
      }
    }

    // Setup private/local worktree (optional)
    if (config.privateLocal) {
      const privateLocalResult = await this.privateRepo("local");
      if (privateLocalResult.exists) {
        await wing.setupPrivateLocal(privateLocalResult.repo, config.privateLocal.branch);
      }
    }

    // Setup private/global worktree (optional)
    if (config.privateGlobal) {
      const privateGlobalResult = await this.privateRepo("global");
      if (privateGlobalResult.exists) {
        await wing.setupPrivateGlobal(privateGlobalResult.repo, config.privateGlobal.branch);
      }
    }

    // Setup extra named work directories (optional)
    if (config.extraWork) {
      for (const [name, entry] of Object.entries(config.extraWork)) {
        const repoResult = await this.workRepo(entry.repo);
        if (repoResult.exists) {
          await wing.addWorkNamed(repoResult.repo, asRepoAlias(name), entry.branch, entry.subdir);
        }
      }
    }

    // Setup info junction (optional)
    if (config.infoLink) {
      await wing.setupInfoLink();
    }

    // Setup closet junction (optional)
    if (config.closetLink) {
      await wing.setupClosetLink();
    }

    return wing;
  }

  async deleteWing(name: string): Promise<void> {
    // Get the wing to clean up worktrees. Delegated to `Wing.discardWorkAreas()`
    // (design doc §4.2) rather than reaching into
    // `wing.workLocal()`/`workGlobal()`/`removeWorkNamed()`/`privateLocal()`/
    // `privateGlobal()` directly — that raw-worktree-teardown knowledge lives
    // on `Wing` itself, next to the `setupWorkLocal`/etc. methods it mirrors,
    // not in this caller reaching around `Wing`'s own abstraction boundary.
    const wingResult = await this.wing(name);
    if (wingResult.exists) {
      await wingResult.wing.discardWorkAreas();
    }

    // Remove from cache
    this._wings.delete(name);

    // Delete the directory
    const wingsDirResult = await this.root.child("wings");
    if (wingsDirResult.found && wingsDirResult.node.is("directory")) {
      const wingsDir = wingsDirResult.node as Directory;
      const wingDirResult = await wingsDir.child(name);
      if (wingDirResult.found && wingDirResult.node.is("directory")) {
        await (wingDirResult.node as Directory).delete(true);
      }
    }

    // Prune stale worktree references from all known repos.
    // This handles cases where a worktree's .git file had a stale gitdir path
    // (e.g. a path from another OS/machine), so removeWorktree was skipped above.
    // After the wing directory is deleted, pruning clears any orphaned git metadata.
    const allWorkRepos = await this.workRepos();
    for (const repo of allWorkRepos) {
      try {
        await repo.pruneWorktrees();
      } catch {
        // Ignore prune failures — repo may be temporarily unavailable
      }
    }
    const [prunePrivateLocal, prunePrivateGlobal] = await Promise.all([
      this.privateRepo("local"),
      this.privateRepo("global"),
    ]);
    if (prunePrivateLocal.exists) {
      try {
        await prunePrivateLocal.repo.pruneWorktrees();
      } catch {
        // Ignore
      }
    }
    if (prunePrivateGlobal.exists) {
      try {
        await prunePrivateGlobal.repo.pruneWorktrees();
      } catch {
        // Ignore
      }
    }
  }

  // ========================================
  // Closet
  // ========================================

  async closet(): Promise<Directory> {
    return this.ensureDirectory("closet");
  }

  // ========================================
  // Cabinet
  // ========================================

  async cabinet(): Promise<Directory> {
    return this.ensureDirectory("cabinet");
  }

  // ========================================
  // Helpers
  // ========================================

  private async ensureDirectory(name: string): Promise<Directory> {
    const result = await this.root.child(name);
    if (result.found && result.node.is("directory")) {
      return result.node as Directory;
    }
    return this.root.createDirectory(name);
  }
}

/**
 * Creates a Lair from a Sandbox.
 *
 * This is the primary factory function. It works with any Sandbox implementation.
 * The lair name is derived from the sandbox root directory name.
 *
 * @param sandbox - The sandbox to use as the base (InMemorySandbox, DiskSandbox, etc.)
 * @param workAreaFactories - Optional (design doc §4.2): enables the
 *   `WorkArea`/`Scratchpad`-returning `Wing` accessors
 *   (`workAreaLocal`/`workAreaGlobal`/`workAreaNamed`/`privateWorkAreaGlobal`)
 *   — see `LairImpl`'s constructor doc comment. Typically
 *   `createDiskWorkAreaFactories(scratchRoot)` or
 *   `createInMemoryWorkAreaFactories(scratchRootPath?)`.
 * @returns A new Lair instance
 */
export function createLair(sandbox: Sandbox, workAreaFactories?: WorkAreaFactories): Lair {
  return new LairImpl(sandbox, workAreaFactories);
}
