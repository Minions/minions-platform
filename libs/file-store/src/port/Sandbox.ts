/**
 * Sandbox Entry Point
 *
 * The Sandbox provides raw filesystem + git operations with typed directory objects.
 * This is Layer 1 of the two-layer design - a raw sandbox without lair-specific structure.
 *
 * Design principles:
 * - Object-first navigation: Navigate via objects, not string paths
 * - Pattern matching: Use match() and is() methods, not null checks
 * - Minimal git operations: High-level operations suitable for in-memory simulation
 */

import type { Directory, BareRepository, ReadOnlyClone, CloneAuth } from "./types.js";

/**
 * The Sandbox is the entry point for all filesystem and git operations.
 *
 * It provides:
 * - A root directory for navigating the filesystem
 * - Git operations for cloning and initializing repositories
 *
 * Two adapters implement this interface:
 * - InMemorySandbox: Simulated filesystem and git for fast testing
 * - DiskSandbox: Real filesystem and git operations
 */
export interface Sandbox {
  /**
   * The root directory of the sandbox.
   * All filesystem operations start from here.
   */
  readonly root: Directory;

  /**
   * Clones a git repository as a bare repository.
   * Use this for repositories where you'll work via worktrees.
   *
   * @param url - Git repository URL to clone from
   * @param into - Directory to clone into
   * @param name - Name for the bare repository directory
   * @param auth - Optional authentication credentials for private repos
   * @returns The created bare repository
   */
  cloneBare(
    url: string,
    into: Directory,
    name: string,
    auth?: CloneAuth
  ): Promise<BareRepository>;

  /**
   * Clones a git repository as a read-only clone.
   * Use this for reference/read-only access to a repository.
   *
   * @param url - Git repository URL to clone from
   * @param into - Directory to clone into
   * @param name - Name for the clone directory
   * @param branch - Optional branch to checkout (defaults to default branch)
   * @param auth - Optional authentication credentials for private repos
   * @returns The created read-only clone
   */
  cloneReadOnly(
    url: string,
    into: Directory,
    name: string,
    branch?: string,
    auth?: CloneAuth
  ): Promise<ReadOnlyClone>;

  /**
   * Initializes a new bare git repository.
   * Use this for local-only repositories without a remote.
   *
   * @param into - Directory to create the repository in
   * @param name - Name for the bare repository directory
   * @returns The created bare repository
   */
  initBare(into: Directory, name: string): Promise<BareRepository>;
}
