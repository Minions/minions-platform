/**
 * Lair Wing Implementation
 *
 * A single Wing class that works with any Sandbox implementation.
 * This replaces both DiskWing and InMemoryWing, which were identical
 * since all storage-specific behavior is in the Sandbox types.
 */

import { join } from "path";
import type { Directory, DirectoryLike, Junction, Worktree, BareRepository, File } from "../port/types.js";
import type { Lair } from "./Lair.js";
import type { Wing } from "./Wing.js";
import type { WorktreeResult, NamedWorkResult } from "./lair-types.js";
import type { WingName, RepoAlias } from "./brandedIds.js";
import { asWingName, asRepoAlias } from "./brandedIds.js";
import type { WorkArea, Scratchpad } from "./work-area-types.js";
import type { WorkAreaFactories } from "./SiteWorkArea.js";
import { createWorkArea, createScratchpad } from "./SiteWorkArea.js";

/**
 * Implementation of the Wing interface.
 *
 * Works with any Lair and underlying Sandbox.
 * All storage-specific behavior is delegated to the Sandbox types.
 */
export class LairWing implements Wing {
  readonly name: WingName;
  readonly root: Directory;
  readonly lair: Lair;

  private _workLocal: Worktree | null = null;
  private _workGlobal: Worktree | null = null;
  private _privateLocal: Worktree | null = null;
  private _privateGlobal: Worktree | null = null;
  private _infoJunction: Junction | null = null;
  private _closet: DirectoryLike | null = null;
  private _namedWork = new Map<string, Extract<NamedWorkResult, { exists: true }>>();

  constructor(
    name: string,
    root: Directory,
    lair: Lair,
    private readonly workAreaFactories?: WorkAreaFactories,
  ) {
    this.name = asWingName(name);
    this.root = root;
    this.lair = lair;
  }

  // ========================================
  // Work Areas
  // ========================================

  async workLocal(): Promise<WorktreeResult> {
    if (this._workLocal) {
      return { exists: true, worktree: this._workLocal };
    }

    const workResult = await this.root.child("work");
    if (!workResult.found) {
      return { exists: false };
    }

    const workDir = workResult.node;
    if (!workDir.is("directory")) {
      return { exists: false };
    }

    const workDirTyped = workDir as Directory;
    const localResult = await workDirTyped.child("local");
    if (!localResult.found) {
      return { exists: false };
    }

    if (localResult.node.is("worktree")) {
      this._workLocal = localResult.node as Worktree;
      return { exists: true, worktree: this._workLocal };
    }

    return { exists: false };
  }

  async workGlobal(): Promise<WorktreeResult> {
    if (this._workGlobal) {
      return { exists: true, worktree: this._workGlobal };
    }

    const workResult = await this.root.child("work");
    if (!workResult.found) {
      return { exists: false };
    }

    const workDir = workResult.node;
    if (!workDir.is("directory")) {
      return { exists: false };
    }

    const workDirTyped = workDir as Directory;
    const globalResult = await workDirTyped.child("global");
    if (!globalResult.found) {
      return { exists: false };
    }

    if (globalResult.node.is("worktree")) {
      this._workGlobal = globalResult.node as Worktree;
      return { exists: true, worktree: this._workGlobal };
    }

    return { exists: false };
  }

  // ========================================
  // Private Areas (Worktrees)
  // ========================================

  async privateLocal(): Promise<WorktreeResult> {
    if (this._privateLocal) {
      return { exists: true, worktree: this._privateLocal };
    }

    const privateResult = await this.root.child("private");
    if (!privateResult.found) {
      return { exists: false };
    }

    const privateDir = privateResult.node;
    if (!privateDir.is("directory")) {
      return { exists: false };
    }

    const privateDirTyped = privateDir as Directory;
    const localResult = await privateDirTyped.child("local");
    if (!localResult.found) {
      return { exists: false };
    }

    if (localResult.node.is("worktree")) {
      this._privateLocal = localResult.node as Worktree;
      return { exists: true, worktree: this._privateLocal };
    }

    return { exists: false };
  }

  async privateGlobal(): Promise<WorktreeResult> {
    if (this._privateGlobal) {
      return { exists: true, worktree: this._privateGlobal };
    }

    const privateResult = await this.root.child("private");
    if (!privateResult.found) {
      return { exists: false };
    }

    const privateDir = privateResult.node;
    if (!privateDir.is("directory")) {
      return { exists: false };
    }

    const privateDirTyped = privateDir as Directory;
    const globalResult = await privateDirTyped.child("global");
    if (!globalResult.found) {
      return { exists: false };
    }

    if (globalResult.node.is("worktree")) {
      this._privateGlobal = globalResult.node as Worktree;
      return { exists: true, worktree: this._privateGlobal };
    }

    return { exists: false };
  }

  // ========================================
  // Junction Links
  // ========================================

  async info(): Promise<Junction> {
    if (this._infoJunction) {
      return this._infoJunction;
    }

    const infoResult = await this.root.child("info");
    if (!infoResult.found) {
      throw new Error("info junction not found - call setupInfoLink first");
    }

    if (!infoResult.node.is("junction")) {
      throw new Error("info is not a junction");
    }

    this._infoJunction = infoResult.node as Junction;
    return this._infoJunction;
  }

  async closet(): Promise<DirectoryLike> {
    if (this._closet) {
      return this._closet;
    }

    const closetResult = await this.root.child("closet");
    if (closetResult.found && closetResult.node.is("junction")) {
      // Proper junction setup (production/installed wing)
      this._closet = closetResult.node as Junction;
      return this._closet;
    }

    // Wing closet is a plain directory or missing (e.g. fresh worktree without setup).
    // Fall back to the lair's own closet so costumes are still discoverable.
    this._closet = await this.lair.closet();
    return this._closet;
  }

  // ========================================
  // Setup Operations
  // ========================================

  async setupWorkLocal(repo: BareRepository, branch: string): Promise<Worktree> {
    const workDir = await this.ensureDirectory("work");
    const worktree = await repo.createWorktree(workDir, "local", branch);
    this._workLocal = worktree;
    return worktree;
  }

  async setupWorkGlobal(repo: BareRepository, branch: string): Promise<Worktree> {
    const workDir = await this.ensureDirectory("work");
    const worktree = await repo.createWorktree(workDir, "global", branch);
    this._workGlobal = worktree;
    return worktree;
  }

  // ========================================
  // Named Extra Work Directories
  // ========================================

  async workNamed(name: string): Promise<NamedWorkResult> {
    const cached = this._namedWork.get(name);
    if (cached !== undefined) return cached;

    const workResult = await this.root.child("work");
    if (!workResult.found || !workResult.node.is("directory")) return { exists: false };

    const workDir = workResult.node as Directory;
    const namedResult = await workDir.child(name);
    if (!namedResult.found) return { exists: false };

    const node = namedResult.node;

    if (node.is("worktree")) {
      const worktree = node as Worktree;
      const result = { exists: true as const, kind: "worktree" as const, path: worktree.path, worktree };
      this._namedWork.set(name, result);
      return result;
    }

    if (node.is("junction")) {
      const junction = node as Junction;
      // Check for a hidden sparse-checkout worktree at wing/.work-src/<name>
      const workSrcResult = await this.root.child(".work-src");
      if (workSrcResult.found && workSrcResult.node.is("directory")) {
        const workSrcDir = workSrcResult.node as Directory;
        const hiddenWtResult = await workSrcDir.child(name);
        if (hiddenWtResult.found && hiddenWtResult.node.is("worktree")) {
          const worktree = hiddenWtResult.node as Worktree;
          const result = { exists: true as const, kind: "junction-worktree" as const, path: junction.path, junction, worktree };
          this._namedWork.set(name, result);
          return result;
        }
      }
      const result = { exists: true as const, kind: "junction" as const, path: junction.path, junction };
      this._namedWork.set(name, result);
      return result;
    }

    return { exists: false };
  }

  async namedWorkNames(): Promise<RepoAlias[]> {
    const workResult = await this.root.child("work");
    if (!workResult.found || !workResult.node.is("directory")) return [];

    const workDir = workResult.node as Directory;
    const children = await workDir.children();
    const reserved = new Set(["local", "global"]);

    return children
      .filter(child => !reserved.has(child.name) && (child.is("worktree") || child.is("junction")))
      .map(child => asRepoAlias(child.name));
  }

  async addWorkNamed(repo: BareRepository, name: string, branch: string, subdir?: string): Promise<Worktree> {
    const workDir = await this.ensureDirectory("work");

    if (!subdir) {
      // No subdir: full git worktree at wing/work/<name>
      const worktree = await repo.createWorktree(workDir, name, branch);
      this._namedWork.set(name, { exists: true as const, kind: "worktree" as const, path: worktree.path, worktree });
      return worktree;
    }

    // Subdir: check if the repo is already checked out somewhere in this wing
    const existingWorktree = await this.findExistingWorktreeForRepo(repo);

    if (existingWorktree) {
      // Case 1 (same-repo): junction at wing/work/<name> → existing worktree/<subdir>
      const target = { path: join(existingWorktree.path, subdir) } as unknown as DirectoryLike;
      const junction = await workDir.createJunction(name, target);
      this._namedWork.set(name, { exists: true as const, kind: "junction" as const, path: junction.path, junction });
      return existingWorktree;
    } else {
      // Case 2 (different-repo): sparse-checkout worktree at wing/.work-src/<name>
      // plus junction at wing/work/<name> → wing/.work-src/<name>/<subdir>
      const workSrcDir = await this.ensureDirectory(".work-src");
      const hiddenWorktree = await repo.createSparseWorktree(workSrcDir, name, branch, subdir);
      const target = { path: join(hiddenWorktree.path, subdir) } as unknown as DirectoryLike;
      const junction = await workDir.createJunction(name, target);
      this._namedWork.set(name, { exists: true as const, kind: "junction-worktree" as const, path: junction.path, junction, worktree: hiddenWorktree });
      return hiddenWorktree;
    }
  }

  async removeWorkNamed(name: string): Promise<void> {
    const result = await this.workNamed(name);
    if (!result.exists) return;

    switch (result.kind) {
      case "worktree":
        await result.worktree.repository.removeWorktree(result.worktree);
        break;
      case "junction":
        await result.junction.unlink();
        break;
      case "junction-worktree":
        await result.junction.unlink();
        await result.worktree.repository.removeWorktree(result.worktree);
        break;
    }

    this._namedWork.delete(name);
  }

  // ========================================
  // Private Helpers
  // ========================================

  /**
   * Finds the first worktree in this wing that belongs to the given repo.
   * Used by addWorkNamed to detect the same-repo subdir case.
   */
  private async findExistingWorktreeForRepo(repo: BareRepository): Promise<Worktree | null> {
    const localResult = await this.workLocal();
    if (localResult.exists && localResult.worktree.repository.path === repo.path) {
      return localResult.worktree;
    }

    const globalResult = await this.workGlobal();
    if (globalResult.exists && globalResult.worktree.repository.path === repo.path) {
      return globalResult.worktree;
    }

    // Check named worktrees (only worktree and junction-worktree kinds have a git repo)
    const names = await this.namedWorkNames();
    for (const n of names) {
      const namedResult = await this.workNamed(n);
      if (namedResult.exists && namedResult.kind !== "junction" && namedResult.worktree.repository.path === repo.path) {
        return namedResult.worktree;
      }
    }

    return null;
  }

  async setupPrivateLocal(repo: BareRepository, branch: string): Promise<Worktree> {
    const privateDir = await this.ensureDirectory("private");
    const worktree = await repo.createWorktree(privateDir, "local", branch);
    this._privateLocal = worktree;
    return worktree;
  }

  async setupPrivateGlobal(repo: BareRepository, branch: string): Promise<Worktree> {
    const privateDir = await this.ensureDirectory("private");
    const worktree = await repo.createWorktree(privateDir, "global", branch);
    this._privateGlobal = worktree;
    return worktree;
  }

  // ========================================
  // Configuration
  // ========================================

  async claudeMd(): Promise<File> {
    const result = await this.root.child("CLAUDE.md");
    if (result.found && result.node.is("file")) {
      return result.node as File;
    }
    return this.root.createFile("CLAUDE.md", "");
  }

  async setupInfoLink(): Promise<Junction> {
    const infoResult = await this.lair.root.child("info");
    if (!infoResult.found) {
      throw new Error("Lair info directory not found");
    }

    const infoDir = infoResult.node;
    if (!infoDir.is("directory")) {
      throw new Error("Lair info is not a directory");
    }

    const junction = await this.root.createJunction("info", infoDir as Directory);
    this._infoJunction = junction;
    return junction;
  }

  async setupClosetLink(): Promise<Junction> {
    const closet = await this.lair.closet();
    const junction = await this.root.createJunction("closet", closet);
    this._closet = junction;
    return junction;
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

  // ========================================
  // Movement-shaped accessors (design doc §4.2)
  // ========================================
  // See Wing.ts's doc comment on these five methods for why they exist
  // alongside the Worktree-returning surface above, rather than replacing
  // it.

  private requireWorkAreaFactories(): WorkAreaFactories {
    if (!this.workAreaFactories) {
      throw new Error(
        `Wing '${this.name}' was constructed without WorkAreaFactories — pass one to createLair()/LairImpl ` +
          `to use the design-doc-§4.2 WorkArea-returning accessors (workAreaLocal/workAreaGlobal/` +
          `workAreaNamed/privateWorkAreaGlobal). scratchpad() needs no factories and always works.`,
      );
    }
    return this.workAreaFactories;
  }

  async workAreaLocal(): Promise<WorkArea> {
    const workArea = await this.workAreaLocalIfExists();
    if (!workArea) {
      throw new Error(`Wing '${this.name}' has no work/local worktree set up — call setupWorkLocal first`);
    }
    return workArea;
  }

  async workAreaLocalIfExists(): Promise<WorkArea | undefined> {
    const result = await this.workLocal();
    if (!result.exists) return undefined;
    return createWorkArea(result.worktree.repository, result.worktree, this.requireWorkAreaFactories());
  }

  async workAreaGlobal(): Promise<WorkArea> {
    const result = await this.workGlobal();
    if (!result.exists) {
      throw new Error(`Wing '${this.name}' has no work/global worktree set up — call setupWorkGlobal first`);
    }
    return createWorkArea(result.worktree.repository, result.worktree, this.requireWorkAreaFactories());
  }

  async workAreaNamed(name: RepoAlias): Promise<WorkArea | undefined> {
    const result = await this.workNamed(name);
    if (!result.exists) return undefined;
    // Only "worktree"/"junction-worktree" have a real worktree (and thus a
    // repo) to attach a Trunk/Movement to — a plain "junction" doesn't.
    if (result.kind === "junction") return undefined;
    return createWorkArea(result.worktree.repository, result.worktree, this.requireWorkAreaFactories());
  }

  async namedWorkPath(name: RepoAlias): Promise<string | undefined> {
    const result = await this.workNamed(name);
    return result.exists ? result.path : undefined;
  }

  async privateWorkAreaGlobal(): Promise<WorkArea> {
    const result = await this.privateGlobal();
    if (!result.exists) {
      throw new Error(`Wing '${this.name}' has no private/global worktree set up — call setupPrivateGlobal first`);
    }
    return createWorkArea(result.worktree.repository, result.worktree, this.requireWorkAreaFactories());
  }

  async scratchpad(): Promise<Scratchpad> {
    const result = await this.privateLocal();
    if (!result.exists) {
      throw new Error(`Wing '${this.name}' has no private/local worktree set up — call setupPrivateLocal first`);
    }
    return createScratchpad(result.worktree.repository, result.worktree);
  }

  async discardWorkAreas(): Promise<void> {
    const workLocalResult = await this.workLocal();
    if (workLocalResult.exists) {
      await workLocalResult.worktree.repository.removeWorktree(workLocalResult.worktree);
      this._workLocal = null;
    }

    const workGlobalResult = await this.workGlobal();
    if (workGlobalResult.exists) {
      await workGlobalResult.worktree.repository.removeWorktree(workGlobalResult.worktree);
      this._workGlobal = null;
    }

    // Removes worktrees and/or junctions for every named extra work directory.
    const namedWorkNames = await this.namedWorkNames();
    for (const workName of namedWorkNames) {
      await this.removeWorkNamed(workName);
    }

    const privateLocalResult = await this.privateLocal();
    if (privateLocalResult.exists) {
      await privateLocalResult.worktree.repository.removeWorktree(privateLocalResult.worktree);
      this._privateLocal = null;
    }

    const privateGlobalResult = await this.privateGlobal();
    if (privateGlobalResult.exists) {
      await privateGlobalResult.worktree.repository.removeWorktree(privateGlobalResult.worktree);
      this._privateGlobal = null;
    }
  }
}
