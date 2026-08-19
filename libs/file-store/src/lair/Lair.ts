/**
 * Lair Interface
 *
 * The Lair is the top-level overlay that provides structure for managing
 * repositories, wings, and shared resources within a sandbox.
 *
 * Design principles:
 * - Built on top of Sandbox (Layer 1)
 * - Object-first navigation with result types (no nulls)
 * - Supports both work repos (for worktrees) and info repos (read-only)
 * - Wings are the primary unit of work organization
 */

import type { Sandbox } from "../port/Sandbox.js";
import type { Directory, BareRepository, ReadOnlyClone, CloneAuth } from "../port/types.js";
import type {
  WorkRepoResult,
  InfoRepoResult,
  PrivateRepoResult,
  WingResult,
  WingConfig,
} from "./lair-types.js";
import type { Wing } from "./Wing.js";

/**
 * The Lair is the top-level container for organizing work.
 *
 * It provides:
 * - Work repositories: Bare repositories for creating worktrees
 * - Info repositories: Read-only clones for reference
 * - Private repositories: Local-only bare repositories
 * - Wings: Organized workspaces with worktrees and private areas
 * - Closet: Shared resources directory
 *
 * Lair directory structure:
 * ```
 * <lair-root>/
 * ├── .lair.toml         # Lair configuration
 * ├── work/              # Work repository storage
 * │   ├── repo-a.git/    # Bare repository
 * │   └── repo-b.git/    # Bare repository
 * ├── info/              # Info repository storage
 * │   ├── docs/          # Read-only clone
 * │   └── reference/     # Read-only clone
 * ├── private/           # Private repository storage
 * │   ├── local.git/     # Local-only bare repo
 * │   └── global.git/    # Global private bare repo
 * ├── wings/             # Wing workspaces
 * │   ├── workshop-00/   # A wing
 * │   └── workshop-01/   # Another wing
 * ├── closet/            # Shared resources
 * └── cabinet/           # Cabinet-owned worktrees, not owned by any wing
 *     ├── plan/           # plan/main sparse-checkout worktree
 *     └── docs/           # doc-viewer session worktrees
 * ```
 */
export interface Lair {
  /**
   * The underlying sandbox providing raw filesystem + git operations.
   */
  readonly sandbox: Sandbox;

  /**
   * The name of this lair (from .lair.toml or directory name).
   */
  readonly name: string;

  /**
   * The root directory of the lair.
   */
  readonly root: Directory;

  // ========================================
  // Work Repositories (Bare, for Worktrees)
  // ========================================

  /**
   * Looks up a work repository by name.
   * Work repositories are bare repositories used to create worktrees.
   *
   * @param name - Repository name (without .git suffix)
   * @returns WorkRepoResult indicating if the repo exists
   */
  workRepo(name: string): Promise<WorkRepoResult>;

  /**
   * Lists all work repositories in the lair.
   *
   * @returns Array of bare repositories
   */
  workRepos(): Promise<BareRepository[]>;

  /**
   * Adds a work repository by cloning from a remote URL.
   *
   * @param name - Repository name (without .git suffix)
   * @param url - Git URL to clone from
   * @param auth - Optional authentication credentials for private repos
   * @returns The created bare repository
   */
  addWorkRepo(name: string, url: string, auth?: CloneAuth): Promise<BareRepository>;

  // ========================================
  // Info Repositories (Read-Only Clones)
  // ========================================

  /**
   * Looks up an info repository by name.
   * Info repositories are read-only clones for reference.
   *
   * @param name - Repository name
   * @returns InfoRepoResult indicating if the clone exists
   */
  infoRepo(name: string): Promise<InfoRepoResult>;

  /**
   * Lists all info repositories in the lair.
   *
   * @returns Array of read-only clones
   */
  infoRepos(): Promise<ReadOnlyClone[]>;

  /**
   * Adds an info repository by cloning from a remote URL.
   *
   * @param name - Repository name
   * @param url - Git URL to clone from
   * @param auth - Optional authentication credentials for private repos
   * @param branch - Optional branch to checkout (defaults to default branch)
   * @returns The created read-only clone
   */
  addInfoRepo(name: string, url: string, auth?: CloneAuth, branch?: string): Promise<ReadOnlyClone>;

  // ========================================
  // Private Repositories (Bare, Local-Only)
  // ========================================

  /**
   * Looks up a private repository.
   * Private repositories are local-only bare repositories without remotes.
   *
   * @param scope - "local" for per-lair, "global" for shared across lairs
   * @returns PrivateRepoResult indicating if the repo exists
   */
  privateRepo(scope: "local" | "global"): Promise<PrivateRepoResult>;

  /**
   * Initializes a private repository.
   *
   * @param scope - "local" for per-lair, "global" for shared across lairs
   * @returns The created bare repository
   */
  initPrivateRepo(scope: "local" | "global"): Promise<BareRepository>;

  // ========================================
  // Wings
  // ========================================

  /**
   * Looks up a wing by name.
   *
   * @param name - Wing name
   * @returns WingResult indicating if the wing exists
   */
  wing(name: string): Promise<WingResult>;

  /**
   * Lists all wings in the lair.
   *
   * @returns Array of wings
   */
  wings(): Promise<Wing[]>;

  /**
   * Creates a new wing with the specified configuration.
   *
   * @param name - Wing name
   * @param config - Wing configuration specifying repos, branches, and options
   * @returns The created wing
   */
  createWing(name: string, config: WingConfig): Promise<Wing>;

  /**
   * Deletes a wing and all its contents.
   *
   * @param name - Wing name to delete
   */
  deleteWing(name: string): Promise<void>;

  // ========================================
  // Closet (Shared Resources)
  // ========================================

  /**
   * Gets the closet directory for shared resources.
   * Creates the directory if it doesn't exist.
   *
   * @returns The closet directory
   */
  closet(): Promise<Directory>;

  // ========================================
  // Cabinet (Cabinet-Owned Worktrees)
  // ========================================

  /**
   * Gets the cabinet directory — the home for git worktrees that Cabinet
   * itself owns and manages, as opposed to worktrees owned by a wing.
   * Creates the directory if it doesn't exist.
   *
   * Callers create their own subdirectory per tool/experience beneath this
   * (e.g. `cabinet/plan/`, `cabinet/docs/sessions/<repo>/<branch>/`) using
   * the returned Directory as the `into` argument to
   * `BareRepository.createWorktree`/`createSparseWorktree`.
   *
   * @returns The cabinet directory
   */
  cabinet(): Promise<Directory>;
}
