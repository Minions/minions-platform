/**
 * Lair Layer Type Definitions
 *
 * Result types and configuration for the Lair overlay layer.
 * These types support the Lair and Wing interfaces.
 */

import type { BareRepository, ReadOnlyClone, Worktree, Directory, Junction } from "../port/types.js";

// ============================================
// Lair Result Types
// ============================================

/**
 * Result of looking up a work repository in the lair.
 * Work repositories are bare repositories used for worktrees.
 */
export type WorkRepoResult =
  | { exists: true; repo: BareRepository }
  | { exists: false; name: string };

/**
 * Result of looking up an info repository in the lair.
 * Info repositories are read-only clones for reference.
 */
export type InfoRepoResult =
  | { exists: true; clone: ReadOnlyClone }
  | { exists: false; name: string };

/**
 * Result of looking up a private repository in the lair.
 * Private repositories are bare repositories without remotes.
 */
export type PrivateRepoResult =
  | { exists: true; repo: BareRepository }
  | { exists: false; scope: "local" | "global" };

/**
 * Result of looking up a wing in the lair.
 */
export type WingResult =
  | { exists: true; wing: Wing }
  | { exists: false; name: string };

// ============================================
// Wing Result Types
// ============================================

/**
 * Result of looking up a worktree area in a wing.
 */
export type WorktreeResult =
  | { exists: true; worktree: Worktree }
  | { exists: false };

/**
 * Result of looking up a named extra work directory in a wing.
 *
 * Three backing structures are possible:
 * - `worktree`: a full git worktree at wing/work/<name> (no subdir)
 * - `junction`: an OS junction/symlink at wing/work/<name> pointing into an
 *   existing worktree's subdirectory (same-repo subdir mapping)
 * - `junction-worktree`: a junction at wing/work/<name> backed by a hidden
 *   sparse-checkout worktree at wing/.work-src/<name> (different-repo subdir)
 *
 * `path` is always the visible path at wing/work/<name> that agents navigate.
 */
export type NamedWorkResult =
  | { exists: false }
  | { exists: true; kind: 'worktree'; path: string; worktree: Worktree }
  | { exists: true; kind: 'junction'; path: string; junction: Junction }
  | { exists: true; kind: 'junction-worktree'; path: string; junction: Junction; worktree: Worktree };

/**
 * Result of looking up a directory area in a wing.
 */
export type DirectoryResult =
  | { exists: true; directory: Directory }
  | { exists: false };

// ============================================
// Configuration Types
// ============================================

/**
 * A named extra work directory configuration.
 */
export interface ExtraWorkEntry {
  /** Repository name (without .git suffix) in lair/work/ */
  repo: string;
  /** Branch to check out */
  branch: string;
  /**
   * Optional subdirectory within the worktree to treat as the entry point.
   * The full worktree is still created at wing/work/<name>; this is metadata
   * indicating which subdirectory is the relevant working root for agents.
   */
  subdir?: string;
}

/**
 * Configuration for creating a new wing.
 */
export interface WingConfig {
  /**
   * Optional description for the wing.
   */
  description?: string;

  /**
   * Work local configuration (required).
   * Specifies which repository and branch to use for work/local worktree.
   */
  workLocal: {
    repo: string;
    branch: string;
  };

  /**
   * Work global configuration (optional).
   * If provided, creates a work/global worktree from the specified repo/branch.
   */
  workGlobal?: {
    repo: string;
    branch: string;
  };

  /**
   * Additional named work directories (optional).
   * Each entry creates a worktree at wing/work/<name>.
   * Keys are directory names (must be unique and not "local" or "global").
   */
  extraWork?: Record<string, ExtraWorkEntry>;

  /**
   * Private local configuration (optional).
   * If provided, creates a private/local worktree from the lair's private/local repo.
   * The branch is typically `l/{lairName}/w/{wingName}/local`.
   */
  privateLocal?: {
    branch: string;
  };

  /**
   * Private global configuration (optional).
   * If provided, creates a private/global worktree from the lair's private/global repo.
   * The branch is typically `l/{lairName}/w/{wingName}/global`.
   */
  privateGlobal?: {
    branch: string;
  };

  /**
   * Whether to set up the info junction linking to the lair's info directory.
   */
  infoLink?: boolean;

  /**
   * Whether to set up the closet junction linking to the lair's closet directory.
   */
  closetLink?: boolean;
}

// Forward declaration for circular reference
import type { Wing } from "./Wing.js";
