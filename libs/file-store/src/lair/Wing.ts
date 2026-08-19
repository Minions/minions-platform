/**
 * Wing Interface
 *
 * A Wing is an organized workspace within a Lair. It provides structured
 * access to work areas (worktrees), private areas, and linked references.
 *
 * Design principles:
 * - Object-first navigation with result types (no nulls)
 * - Clear separation between work (git-tracked) and private (untracked) areas
 * - Junction links to shared lair resources (info, closet)
 */

import type { Directory, DirectoryLike, Junction, Worktree, BareRepository, File } from "../port/types.js";
import type { Lair } from "./Lair.js";
import type { WorktreeResult, NamedWorkResult } from "./lair-types.js";
import type { WingName, RepoAlias } from "./brandedIds.js";
import type { WorkArea, Scratchpad } from "./work-area-types.js";

/**
 * A Wing is an organized workspace for a specific task or project.
 *
 * Wing directory structure:
 * ```
 * <wing-name>/
 * ├── .wing.toml          # Wing configuration
 * ├── CLAUDE.md           # AI instructions for this wing
 * ├── work/
 * │   ├── local/          # Primary worktree (git-tracked)
 * │   └── global/         # Optional shared worktree
 * ├── private/
 * │   ├── local/          # Wing-specific scratch space
 * │   └── global/         # Shared private data
 * ├── info -> ../info     # Junction to lair info
 * └── closet -> ../closet # Junction to lair closet
 * ```
 */
export interface Wing {
  /**
   * The name of this wing.
   */
  readonly name: WingName;

  /**
   * The root directory of this wing.
   */
  readonly root: Directory;

  /**
   * The lair this wing belongs to.
   */
  readonly lair: Lair;

  // ========================================
  // Work Areas (Worktrees)
  // ========================================

  /**
   * Gets the work/local worktree.
   * This is the primary work area for the wing.
   *
   * @returns WorktreeResult indicating if the worktree exists
   */
  workLocal(): Promise<WorktreeResult>;

  /**
   * Gets the work/global worktree.
   * This is an optional shared work area.
   *
   * @returns WorktreeResult indicating if the worktree exists
   */
  workGlobal(): Promise<WorktreeResult>;

  // ========================================
  // Private Areas (Worktrees from private bare repos)
  // ========================================

  /**
   * Gets the private/local worktree.
   * Use for wing-specific scratch space, caches, or temporary files.
   * This is a worktree from the lair's private/local bare repository.
   *
   * @returns WorktreeResult indicating if the worktree exists
   */
  privateLocal(): Promise<WorktreeResult>;

  /**
   * Gets the private/global worktree.
   * Use for data shared across multiple wings or lairs.
   * This is a worktree from the lair's private/global bare repository.
   *
   * @returns WorktreeResult indicating if the worktree exists
   */
  privateGlobal(): Promise<WorktreeResult>;

  // ========================================
  // Linked Areas (Junctions)
  // ========================================

  /**
   * Gets the info junction.
   * This links to the lair's info directory for read-only references.
   *
   * @returns The info junction
   * @throws If the junction doesn't exist (call setupInfoLink first)
   */
  info(): Promise<Junction>;

  /**
   * Gets the closet directory (or junction).
   * This provides access to the lair's closet directory for shared resources.
   * When a proper closet junction exists, returns it. Otherwise falls back to
   * the lair's closet directly so new wings work without setup steps.
   *
   * @returns The closet as a DirectoryLike (may be a Junction or Directory)
   */
  closet(): Promise<DirectoryLike>;

  // ========================================
  // Setup Operations
  // ========================================

  /**
   * Sets up the work/local worktree from a repository.
   *
   * @param repo - The bare repository to create the worktree from
   * @param branch - The branch to checkout
   * @returns The created worktree
   */
  setupWorkLocal(repo: BareRepository, branch: string): Promise<Worktree>;

  /**
   * Sets up the work/global worktree from a repository.
   *
   * @param repo - The bare repository to create the worktree from
   * @param branch - The branch to checkout
   * @returns The created worktree
   */
  setupWorkGlobal(repo: BareRepository, branch: string): Promise<Worktree>;

  /**
   * Gets a named extra work directory by name.
   * Named work dirs live at wing/work/<name> alongside the built-in local/global.
   * May be backed by a full worktree, an OS junction into an existing worktree's
   * subdir (same-repo case), or a junction over a hidden sparse-checkout worktree.
   *
   * @param name - The work directory name (not "local" or "global")
   * @returns NamedWorkResult describing the backing structure
   */
  workNamed(name: RepoAlias): Promise<NamedWorkResult>;

  /**
   * Lists all named extra work directory names (excludes "local" and "global").
   *
   * @returns Array of directory names
   */
  namedWorkNames(): Promise<RepoAlias[]>;

  /**
   * Creates a named extra work directory from a repository.
   *
   * Without `subdir`: creates a full git worktree at wing/work/<name>.
   *
   * With `subdir` and the repo is already checked out in this wing: creates an
   * OS junction at wing/work/<name> pointing into the existing worktree's subdir.
   *
   * With `subdir` and a fresh repo: creates a sparse-checkout worktree at
   * wing/.work-src/<name> (hidden) and an OS junction at wing/work/<name>
   * pointing to wing/.work-src/<name>/<subdir>.
   *
   * @param repo - The bare repository to create the worktree from
   * @param name - The directory name (must not be "local" or "global")
   * @param branch - The branch to checkout
   * @param subdir - Optional subdirectory within the repo to surface at wing/work/<name>
   * @returns The underlying worktree (for no-subdir and different-repo cases)
   */
  addWorkNamed(repo: BareRepository, name: RepoAlias, branch: string, subdir?: string): Promise<Worktree>;

  /**
   * Removes a named extra work directory.
   *
   * @param name - The directory name to remove
   */
  removeWorkNamed(name: RepoAlias): Promise<void>;

  /**
   * Sets up the private/local worktree from the lair's private/local repo.
   *
   * @param repo - The lair's private/local bare repository
   * @param branch - The branch to checkout (typically `l/{lairName}/w/{wingName}/local`)
   * @returns The created worktree
   */
  setupPrivateLocal(repo: BareRepository, branch: string): Promise<Worktree>;

  /**
   * Sets up the private/global worktree from the lair's private/global repo.
   *
   * @param repo - The lair's private/global bare repository
   * @param branch - The branch to checkout (typically `l/{lairName}/w/{wingName}/global`)
   * @returns The created worktree
   */
  setupPrivateGlobal(repo: BareRepository, branch: string): Promise<Worktree>;

  // ========================================
  // Configuration
  // ========================================

  /**
   * Gets the CLAUDE.md file for this wing.
   * Creates it if it doesn't exist.
   *
   * @returns The CLAUDE.md file
   */
  claudeMd(): Promise<File>;

  /**
   * Sets up the info junction linking to the lair's info directory.
   *
   * @returns The created junction
   */
  setupInfoLink(): Promise<Junction>;

  /**
   * Sets up the closet junction linking to the lair's closet directory.
   *
   * @returns The created junction
   */
  setupClosetLink(): Promise<Junction>;

  // ========================================
  // Movement-shaped accessors (design doc §4.2)
  // ========================================

  /**
   * **Not the design doc's literal `workLocal`/`workGlobal`/`workNamed`/
   * `privateGlobal`/`privateLocal` names.** Those names are already in use
   * above by the `Worktree`-returning surface — real callers across the
   * monorepo (`libs/movement-branching`, `libs/planner`, `apps/cabinet`, and
   * more) still depend on it, so these five accessors are named
   * `workAreaLocal`/etc. instead. They give the design doc §4.2 shape
   * (`WorkArea`/`Scratchpad`, movement-mediated instead of raw `Worktree`)
   * alongside the existing surface, without displacing it.
   *
   * All five throw a clear error if this wing was constructed without the
   * adapter-specific `WorkAreaFactories` needed to build a `Trunk`/
   * `CheckedOutMovement` (see `LairImpl`/`createLair`'s optional
   * `workAreaFactories` parameter) — a call site that doesn't pass one keeps
   * working exactly as before, simply unable to call these methods.
   * `scratchpad()` is the one exception: `Scratchpad` needs no `Trunk`, so it
   * works regardless.
   */

  /** The design doc §4.2 `WorkArea` shape of `workLocal()`. Throws if work/local isn't set up. */
  workAreaLocal(): Promise<WorkArea>;

  /**
   * Non-throwing sibling of `workAreaLocal()` — mirrors `workAreaNamed()`'s
   * own `WorkArea | undefined` shape instead of `workAreaLocal()`'s throwing
   * one. For callers that need to distinguish "this wing genuinely has no
   * work/local checkout" (`undefined`) from "something else went wrong"
   * (an actual thrown error) without paying for exception-based control
   * flow to make that distinction — e.g. `PlanActionGroup.ts`'s
   * `wingStillHasNode()`, which needs a real `false` for "wing has no repo
   * checkout — abandoned" that's semantically different from its own outer
   * catch's `true` ("couldn't check, be safe, don't prune"). A throwing
   * `workAreaLocal()` collapses those two distinct outcomes into one.
   */
  workAreaLocalIfExists(): Promise<WorkArea | undefined>;

  /** The design doc §4.2 `WorkArea` shape of `workGlobal()`. Throws if work/global isn't set up. */
  workAreaGlobal(): Promise<WorkArea>;

  /**
   * The design doc §4.2 `WorkArea` shape of `workNamed()`. Returns
   * `undefined` when the named work directory doesn't exist OR is a plain
   * junction with no worktree of its own to build a `WorkArea` around
   * (mirrors `workNamed()`'s own `{ exists: false }` case plus the
   * junction-only case, which has no repo to attach a `Trunk`/`Movement` to).
   */
  workAreaNamed(name: RepoAlias): Promise<WorkArea | undefined>;

  /**
   * Raw filesystem path for a named extra work directory, regardless of
   * backing kind (`worktree`/`junction`/`junction-worktree`) — `undefined`
   * when `name` doesn't exist. This is the design doc §4.2 growth point for
   * `MCPServer.ts`'s named-work-dir quality-watcher path scoping: that
   * caller needs a raw path, not a `Movement`/`Mirror`-shaped read, and hits
   * the one case `workAreaNamed()` can never cover — a plain `junction`
   * entry (a same-repo subdir mapping) has no `BareRepository` of its own to
   * attach a `Trunk`/`Movement` to, so no `WorkArea` can ever be built for
   * it, even though it has a perfectly real path on disk. For the
   * `worktree`/`junction-worktree` kinds, this returns the same path
   * `workAreaNamed(name)`'s `activeMovement().files.path` would (this is a
   * thin, path-only passthrough — it does not itself expose the raw
   * `Worktree`/`Junction` objects `workNamed()` does).
   */
  namedWorkPath(name: RepoAlias): Promise<string | undefined>;

  /** The design doc §4.2 `WorkArea` shape of `privateGlobal()`. Throws if private/global isn't set up. */
  privateWorkAreaGlobal(): Promise<WorkArea>;

  /** The design doc §4.2 `Scratchpad` shape of `privateLocal()`. Throws if private/local isn't set up. */
  scratchpad(): Promise<Scratchpad>;

  /**
   * Tears down every worktree this wing owns — work/local, work/global,
   * every named extra work directory, private/local, private/global — by
   * removing each one from its owning `BareRepository`
   * (`worktree.repository.removeWorktree(worktree)`/`removeWorkNamed`
   * internally). Idempotent per slot: a slot that was never set up is
   * silently skipped, same as every other accessor's `{ exists: false }`
   * handling elsewhere on this interface.
   *
   * This is the wing-lifecycle counterpart to `setupWorkLocal`/
   * `setupWorkGlobal`/`setupPrivateLocal`/`setupPrivateGlobal`/
   * `addWorkNamed` above — construction and teardown of the underlying
   * worktrees are both below the `WorkArea`/`Scratchpad` abstraction
   * (which assumes an already-existing worktree to layer `Movement`/`Mirror`
   * semantics onto), so neither belongs on that surface. It exists
   * specifically so callers that OWN a `Wing`'s full lifecycle (today, only
   * `LairImpl.deleteWing()`) don't need to reach through the raw-
   * `Worktree`-returning accessors (`workLocal()`/`workGlobal()`/
   * `privateLocal()`/`privateGlobal()`) themselves to tear it down — that
   * knowledge lives here, next to the setup methods it mirrors, not in a
   * caller reaching around this interface's own abstraction boundary.
   *
   * Does NOT delete this wing's own root directory or unregister it from
   * its `Lair` — purely the underlying git worktrees. Callers that want a
   * wing fully gone still need to do that separately (see
   * `LairImpl.deleteWing()`).
   */
  discardWorkAreas(): Promise<void>;
}
