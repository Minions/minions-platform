/**
 * OO Port Type Definitions
 *
 * Object-oriented type definitions for the FileStore port.
 * These replace the procedural path-based types with object-first navigation.
 *
 * Design principles:
 * - Object-first navigation: Navigate via objects, not string paths
 * - Pattern matching: Use match() and is() methods, not null checks
 * - Narrowed child types: Each container knows its valid child types
 * - No nulls: Use discriminated unions (ChildResult) instead
 */

// ============================================
// Forward Declarations (for circular refs)
// ============================================

// These are declared as interfaces to allow circular references
export interface File extends FileOperations, FileMatcher {}
export interface Directory extends DirectoryOperations, DirectoryMatcher {}
export interface Junction extends JunctionOperations, JunctionMatcher {}
export interface BareRepository
  extends BareRepositoryOperations,
    BareRepositoryMatcher {}
export interface Worktree extends WorktreeOperations, WorktreeMatcher {}
export interface ReadOnlyClone
  extends ReadOnlyCloneOperations,
    ReadOnlyCloneMatcher {}
export interface ReadOnlyDirectory
  extends ReadOnlyDirectoryOperations,
    ReadOnlyDirectoryMatcher {}

// ============================================
// Branded Identity Types
// ============================================

/**
 * A git ref — a commit sha or branch name — used to read content at a
 * point in history rather than the live worktree checkout (readFileAtRef,
 * and the docs session's recorded diff base). Nominal type: the string is
 * already trusted at the point it's minted (e.g. straight from an MCP
 * param or a prior commit/branch operation's own return value), so the
 * constructor does no validation beyond the brand. Compile-time only —
 * it's still a plain string on the wire; the brand exists to make it a
 * type error to pass an arbitrary string where a ref is expected.
 */
export type GitRef = string & { readonly __brand: "GitRef" };

/** The only legal way to produce a {@link GitRef}. */
export function asGitRef(raw: string): GitRef {
  return raw as GitRef;
}

// ============================================
// Node Type Unions
// ============================================

/**
 * All possible node types in the sandbox
 */
export type Node =
  | File
  | Directory
  | Junction
  | BareRepository
  | Worktree
  | ReadOnlyClone
  | ReadOnlyDirectory;

/**
 * Node kinds for pattern matching
 */
export type NodeKind =
  | "file"
  | "directory"
  | "junction"
  | "bare-repository"
  | "worktree"
  | "read-only-clone"
  | "read-only-directory";

/**
 * Nodes that can contain other nodes (directory-like containers)
 */
export type DirectoryLike =
  | Directory
  | Junction
  | Worktree
  | ReadOnlyClone
  | ReadOnlyDirectory;

/**
 * Common operations shared by all directory-like types
 */
export interface DirectoryLikeOperations {
  /**
   * Checks if this directory contains a .git subdirectory (is a git repository).
   * This method exists because children() intentionally filters out .git directories.
   */
  hasGitDirectory(): Promise<boolean>;
}

/**
 * Children of a plain Directory - can contain any node type
 */
export type DirectoryChild =
  | File
  | Directory
  | Junction
  | BareRepository
  | Worktree
  | ReadOnlyClone;

/**
 * Children of a Worktree - only git-tracked content
 * Directories within a worktree are also Worktree objects
 */
export type WorktreeChild = File | Worktree | Junction;

/**
 * Children of a ReadOnlyClone - only read-only content
 */
export type ReadOnlyChild = File | ReadOnlyDirectory;

// ============================================
// Result Types (No nulls)
// ============================================

/**
 * Result of looking up a child node.
 * Uses discriminated union instead of null.
 */
export type ChildResult<TChild> =
  | { found: true; node: TChild }
  | { found: false; name: string; parent: DirectoryLike };

/**
 * Result of looking up a child in a Directory
 */
export type DirectoryChildResult = ChildResult<DirectoryChild>;

/**
 * Result of looking up a child in a Worktree
 */
export type WorktreeChildResult = ChildResult<WorktreeChild>;

/**
 * Result of looking up a child in a ReadOnlyClone or ReadOnlyDirectory
 */
export type ReadOnlyChildResult = ChildResult<ReadOnlyChild>;

// ============================================
// Git Authentication Types
// ============================================

/**
 * Authentication credentials for cloning private repositories.
 *
 * For GitHub:
 * - Use `token` alone (username optional, defaults to 'oauth2')
 * - Example: { token: 'ghp_xxxx' }
 *
 * For Bitbucket:
 * - Use `username` + `token` (app password)
 * - Example: { username: 'myuser', token: 'xxxx' }
 *
 * For other Git hosts:
 * - Use `username` + `token` following the host's documentation
 */
export interface CloneAuth {
  /**
   * Username for authentication.
   * Required for Bitbucket. Optional for GitHub (defaults to 'oauth2').
   */
  username?: string;

  /**
   * Authentication token or app password.
   * - GitHub: Personal Access Token (PAT)
   * - Bitbucket: App Password
   */
  token: string;
}

// ============================================
// Git Result Types
// ============================================

/**
 * Result of a merge operation
 */
export type MergeResult =
  | { status: "success"; commit: string }
  | { status: "already-up-to-date" }
  | { status: "conflict"; conflictedFiles: string[] };

/**
 * Options for merge operations
 */
export interface MergeOptions {
  /** Custom merge commit message. If not provided, git default message is used. */
  message?: string;
}

/**
 * Result of a rebase operation.
 * On conflict, the rebase is left in progress so the caller can resolve and continue.
 */
export type RebaseResult =
  | { status: "success" }
  | { status: "conflict"; message: string; originalHead: string; conflictedFiles: string[] };

/**
 * Options for rebase operations
 */
export interface RebaseOptions {
  /**
   * If true, automatically stash uncommitted changes before rebasing and pop them after.
   * Equivalent to `git rebase --autostash`.
   * Allows rebasing even when the working tree is dirty.
   */
  autostash?: boolean;
}

/**
 * Information about a git commit
 */
export interface CommitInfo {
  /** Full commit hash */
  hash: string;
  /** First line of commit message */
  subject: string;
  /** Rest of commit message (after first line) */
  body: string;
  /** Author name */
  author: string;
  /** Author date in ISO format */
  date: string;
}

// ============================================
// File Interface
// ============================================

/**
 * Metadata about a file, returned by File.stat().
 */
export interface FileStat {
  /**
   * Modification time in milliseconds since the epoch.
   * For DiskFile, this is the real filesystem mtime. For InMemoryFile,
   * this is a fake clock that advances by 1000ms on every
   * write()/append()/create so tests can assert exact values without
   * depending on wall-clock timing (see InMemorySandbox.now()).
   */
  mtimeMs: number;
}

/**
 * File operations
 */
interface FileOperations {
  readonly kind: "file";
  readonly name: string;

  /**
   * The absolute filesystem path to this file.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * Files cannot have children, so this always returns { found: false }.
   * This allows uniform navigation code that doesn't need to check node type.
   */
  child(name: string): Promise<{ found: false; name: string }>;

  /**
   * Reads the entire file content
   */
  read(): Promise<string>;

  /**
   * Reads a subset of lines from the file
   * @param offset - Starting line (0-indexed)
   * @param limit - Number of lines to read
   */
  readLines(offset?: number, limit?: number): Promise<string[]>;

  /**
   * Checks if the file exists
   */
  exists(): Promise<boolean>;

  /**
   * Gets file metadata (currently just modification time).
   */
  stat(): Promise<FileStat>;

  /**
   * Writes content to the file.
   * Creates parent directories automatically if they don't exist.
   */
  write(content: string): Promise<void>;

  /**
   * Appends content to the file
   */
  append(content: string): Promise<void>;

  /**
   * Deletes the file
   */
  delete(): Promise<void>;
}

/**
 * File pattern matching
 */
interface FileMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { file: (f: File) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "file"): this is File;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   * Files return false; Directory, Worktree, Junction return true.
   */
  isDirectoryLike(): boolean;
}

// ============================================
// Directory Interface
// ============================================

/**
 * Directory operations
 */
interface DirectoryOperations extends DirectoryLikeOperations {
  readonly kind: "directory";
  readonly name: string;

  /**
   * The absolute filesystem path to this directory.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * Gets a child node by name
   */
  child(name: string): Promise<DirectoryChildResult>;

  /**
   * Lists all children of this directory
   */
  children(): Promise<DirectoryChild[]>;

  /**
   * Searches recursively for nodes matching a glob pattern (e.g. "**\/*.md").
   * Unlike children()'s bare basename, each result's `.name` is its path
   * relative to this directory (posix-separated, e.g. "sub/dir/readme.md") —
   * matches can be nested, so a bare basename would collide across depths and
   * couldn't be passed back into child() to re-fetch the node.
   *
   * @param pattern - Glob pattern to match
   * @param exclude - Directory basenames to prune from traversal entirely
   *   (e.g. ["node_modules", ".git", "dist"]). Pruned directories are never
   *   descended into and never appear in the results, unlike pattern
   *   mismatches which are simply filtered out after being visited.
   */
  glob(pattern: string, exclude?: string[]): Promise<DirectoryChild[]>;

  /**
   * Checks if the directory exists
   */
  exists(): Promise<boolean>;

  /**
   * Creates a new file in this directory
   */
  createFile(name: string, content?: string): Promise<File>;

  /**
   * Creates a new subdirectory
   */
  createDirectory(name: string): Promise<Directory>;

  /**
   * Creates a junction (directory symlink) to another directory.
   * Target must be within the sandbox.
   */
  createJunction(name: string, target: DirectoryLike): Promise<Junction>;

  /**
   * Deletes this directory
   * @param recursive - If true, deletes contents. If false, fails if not empty.
   */
  delete(recursive?: boolean): Promise<void>;
}

/**
 * Directory pattern matching
 */
interface DirectoryMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { directory: (d: Directory) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "directory"): this is Directory;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   */
  isDirectoryLike(): boolean;
}

// ============================================
// Junction Interface
// ============================================

/**
 * Junction operations (directory symlink)
 */
interface JunctionOperations extends DirectoryLikeOperations {
  readonly kind: "junction";
  readonly name: string;

  /**
   * The absolute filesystem path to this junction.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * The target directory this junction points to.
   * Must be within the sandbox.
   */
  readonly target: DirectoryLike;

  /**
   * Gets a child node by name (delegates to target)
   */
  child(name: string): Promise<DirectoryChildResult>;

  /**
   * Lists all children (delegates to target)
   */
  children(): Promise<DirectoryChild[]>;

  /**
   * Searches for nodes matching a glob pattern (delegates to target).
   * Note: each result's `.name` is relative to the junction's *target*
   * directory, not to the junction itself — callers that need paths
   * relative to the junction should prefix with the junction's own name.
   */
  glob(pattern: string): Promise<DirectoryChild[]>;

  /**
   * Checks if the junction exists
   */
  exists(): Promise<boolean>;

  /**
   * Removes the junction (not the target)
   */
  unlink(): Promise<void>;
}

/**
 * Junction pattern matching
 */
interface JunctionMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { junction: (j: Junction) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "junction"): this is Junction;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   */
  isDirectoryLike(): boolean;
}

// ============================================
// BareRepository Interface
// ============================================

/**
 * Bare repository operations
 */
interface BareRepositoryOperations {
  readonly kind: "bare-repository";
  readonly name: string;

  /**
   * The absolute filesystem path to this bare repository.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * The remote URL this repository was cloned from.
   * Null if initialized locally.
   */
  readonly url: string | null;

  /**
   * Creates a worktree from this repository
   * @param into - Directory to create the worktree in
   * @param name - Name for the worktree directory
   * @param branch - Branch to checkout
   */
  createWorktree(
    into: Directory,
    name: string,
    branch: string
  ): Promise<Worktree>;

  /**
   * Creates a sparse worktree from this repository, checking out only the
   * specified subdirectory. The worktree is placed at `into/<name>` and
   * `git sparse-checkout` is configured so only `subdir` is present on disk.
   *
   * In-memory implementations fall back to a regular full worktree.
   *
   * @param into - Directory to create the worktree in
   * @param name - Name for the worktree directory
   * @param branch - Branch to checkout
   * @param subdir - Subdirectory path within the repo to sparse-checkout
   */
  createSparseWorktree(
    into: Directory,
    name: string,
    branch: string,
    subdir: string
  ): Promise<Worktree>;

  /**
   * Lists all worktrees associated with this repository
   */
  worktrees(): Promise<Worktree[]>;

  /**
   * Removes a worktree
   */
  removeWorktree(worktree: Worktree): Promise<void>;

  /**
   * Prunes stale worktree references
   */
  pruneWorktrees(): Promise<void>;

  /**
   * Lists all branches in this repository
   */
  branches(): Promise<string[]>;

  /**
   * Creates a branch at the given ref if it doesn't already exist. Creates
   * no worktree — the branch alone is checked out nowhere. Idempotent: if
   * the branch already exists it is left exactly as-is, even if its current
   * tip differs from `ref` (never force-moves an existing branch).
   *
   * @param name - Branch name to create
   * @param ref - Commit/branch to create it at, when it doesn't already exist
   */
  createBranchIfMissing(name: string, ref: string): Promise<void>;

  /**
   * Creates or force-resets a branch to point at a target ref, without ever
   * checking anything out. Mirrors `git branch -f <name> <target>`, run
   * directly against the bare repository — no worktree is needed, and none
   * is created or touched. Fails (throws) if `name` happens to be checked
   * out in some worktree right now, matching git's own refusal to force-move
   * a checked-out branch; callers that expect that should catch/best-effort it.
   *
   * @param name - Branch name to create or move
   * @param target - Ref (branch name, `origin/<branch>`, commit) to point it at
   */
  updateBranch(name: string, target: string): Promise<void>;

  /**
   * Compare-and-swap variant of `updateBranch`: moves `name` to `target`,
   * but only if `name` currently resolves to exactly `expected` — atomic,
   * so it is safe to call concurrently from multiple worktrees of the same
   * bare repo with no external locking. Returns false (no write performed)
   * if `name` had already moved away from `expected`, instead of throwing —
   * that is the expected outcome of losing a race, not an error. Use this
   * (never `updateBranch`) for the one write in a merge/absorb/promote
   * sequence that advances a branch shared across worktrees (`main`, a
   * trunk, a `plan/<trunk>` mirror): read the branch's current hash, rebase
   * onto it, build the new commit, then try this CAS — on failure, re-read
   * the branch (it now holds whatever a concurrent caller just published),
   * rebase onto that, and retry. `updateBranch`'s blind force-write is
   * exactly what let two concurrent movement merges silently discard one
   * another's just-created commit in a live incident.
   *
   * @param name - Branch name to move
   * @param target - Ref (branch name, `origin/<branch>`, commit) to point it at
   * @param expected - The exact commit hash `name` must currently resolve to
   *   (from `BareRepository.resolveLocalRef`) for the write to proceed; pass
   *   `""` to require that `name` not already exist
   */
  updateBranchIfUnchanged(name: string, target: string, expected: string): Promise<boolean>;

  /**
   * Fetches from `origin`, updating this repo's remote-tracking refs
   * (`origin/<branch>`) without touching any local branch or worktree.
   * Best-effort in spirit — callers should catch failures (offline, no
   * remote configured) rather than treat them as fatal.
   *
   * Coalesced and cached for a couple of minutes: a successful fetch is
   * treated as fresh for a short window, and concurrent callers share one
   * in-flight fetch rather than each starting their own. Pass `force: true`
   * to bypass the cached-fresh window (still joins an in-flight fetch) —
   * use this when the caller has a concrete reason to think its view of
   * origin is stale, e.g. immediately before retrying after a rejected push.
   */
  fetch(force?: boolean): Promise<void>;

  /**
   * Pushes a local branch to its same-named branch on `origin`, without
   * switching to it or requiring any worktree. Mirrors `git push origin
   * <name>:<name>`.
   *
   * @param name - Branch name to push
   */
  pushBranch(name: string): Promise<void>;

  /**
   * Reads a branch or remote-tracking ref's current commit hash directly,
   * without spawning a `git` process. Checks `name` as a local branch
   * (`refs/heads/<name>`) first, then as a remote-tracking ref
   * (`refs/remotes/<name>`, e.g. `origin/main`). Returns null if neither
   * exists.
   *
   * @param name - Branch name (e.g. `main`) or remote-tracking ref (e.g. `origin/main`)
   */
  resolveLocalRef(name: string): Promise<string | null>;

  /**
   * Heals a bare repo cloned the old way (`git clone --bare`, which created a
   * non-tracking local branch per remote branch). Records the origin HEAD
   * symref, sets upstream tracking on the branches the system keeps (the base
   * branch and `plan/main`), and deletes the leftover local mirror branches
   * that origin already fully contains. Idempotent and safe: a branch is
   * deleted only when origin contains all its commits and it is not checked out
   * in any worktree; repos cloned the new (tracking) way are left unchanged.
   *
   * @returns The names of the local branches that were deleted
   */
  normalizeLocalBranches(): Promise<string[]>;

  /**
   * Reads `branch`'s persisted base-trunk override, from ordinary
   * (non-`--worktree`-scoped) repo-level git config keyed by branch name —
   * `Movement.base: Trunk`'s real persistence mechanism (design doc
   * §4.2/§4.1's `Movement`). Shared by every worktree of this repo (and
   * readable with no worktree checked out at all), unlike the
   * `--worktree`-scoped mechanism (`Worktree.baseBranch()`), because a
   * movement's identity is its branch, not any one physical checkout
   * directory. Returns null if no override has ever been recorded for
   * `branch` — callers that need a base regardless (e.g. a remote-default
   * fallback) supply their own default.
   *
   * @param branch - The movement branch to read the override for
   */
  getMovementBase(branch: string): Promise<string | null>;

  /**
   * Persists (or, with `null`, clears) `branch`'s base-trunk override — the
   * write side of `getMovementBase`. Called once when a movement is created
   * (or retargeted), never on every read.
   *
   * @param branch - The movement branch to set the override for
   * @param base - The trunk branch name to record, or `null` to clear
   */
  setMovementBase(branch: string, base: string | null): Promise<void>;

  /**
   * Deletes this bare repository
   */
  delete(): Promise<void>;
}

/**
 * BareRepository pattern matching
 */
interface BareRepositoryMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { bareRepository: (r: BareRepository) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "bare-repository"): this is BareRepository;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   * BareRepository returns false - use worktrees to access content.
   */
  isDirectoryLike(): boolean;
}

// ============================================
// Worktree Interface
// ============================================

/**
 * Worktree operations (editable git directory)
 */
interface WorktreeOperations extends DirectoryLikeOperations {
  readonly kind: "worktree";
  readonly name: string;

  /**
   * The absolute filesystem path to this worktree.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * The branch checked out in this worktree
   */
  readonly branch: string;

  /**
   * The bare repository this worktree belongs to
   */
  readonly repository: BareRepository;

  // --- Directory operations (narrowed to WorktreeChild) ---

  /**
   * Gets a child node by name
   */
  child(name: string): Promise<WorktreeChildResult>;

  /**
   * Lists all children of this worktree
   */
  children(): Promise<WorktreeChild[]>;

  /**
   * Searches recursively for nodes matching a glob pattern (e.g. "**\/*.md").
   * Unlike children()'s bare basename, each result's `.name` is its path
   * relative to this worktree (posix-separated, e.g. "sub/dir/readme.md") —
   * matches can be nested, so a bare basename would collide across depths and
   * couldn't be passed back into child() to re-fetch the node.
   *
   * @param pattern - Glob pattern to match
   * @param exclude - Directory basenames to prune from traversal entirely
   *   (e.g. ["node_modules", ".git", "dist"]). Pruned directories are never
   *   descended into and never appear in the results, unlike pattern
   *   mismatches which are simply filtered out after being visited.
   */
  glob(pattern: string, exclude?: string[]): Promise<WorktreeChild[]>;

  /**
   * Checks if the worktree exists
   */
  exists(): Promise<boolean>;

  // --- Creation (directories within a worktree are also worktrees) ---

  /**
   * Creates a new file in this worktree
   */
  createFile(name: string, content?: string): Promise<File>;

  /**
   * Creates a new subdirectory.
   * Returns a Worktree, not a Directory, since directories within
   * a worktree share the git context.
   */
  createDirectory(name: string): Promise<Worktree>;

  /**
   * Creates a junction (directory symlink) to another directory.
   * Target must be within the sandbox.
   */
  createJunction(name: string, target: DirectoryLike): Promise<Junction>;

  // --- Deletion (of contents, not worktree itself) ---

  /**
   * Deletes a child by name
   * @param name - Name of the child to delete
   * @param recursive - If true, deletes directory contents
   */
  deleteChild(name: string, recursive?: boolean): Promise<void>;

  // --- Git operations (high-level, uses git config for author/email) ---

  /**
   * Commits all changes in the worktree.
   * No staging - always commits everything.
   * Uses git config for author/email.
   *
   * @param message - Commit message
   * @param options.noVerify - Skip pre-commit/commit-msg hooks (git commit --no-verify).
   *   Only pass true when some other check already verified the same things a hook
   *   would — never as a way to force a commit through a failing hook silently.
   * @returns The commit hash
   */
  commitAll(message: string, options?: { noVerify?: boolean }): Promise<string>;

  /**
   * Pushes commits to the remote.
   * Auth errors surface to user for resolution.
   */
  push(): Promise<void>;

  /**
   * Pushes commits to the remote with upstream tracking.
   * @param setUpstream - If true, sets up tracking (like git push -u)
   */
  pushWithTracking(setUpstream?: boolean): Promise<void>;

  /**
   * Force pushes commits to the remote.
   * Use with caution - this rewrites remote history.
   */
  forcePush(): Promise<void>;

  /**
   * Pulls from the remote.
   * Auth errors surface to user for resolution.
   */
  pull(): Promise<void>;

  /**
   * Fetches from the remote without merging. Coalesced and cached for a
   * couple of minutes — see `BareRepository.fetch`'s doc for the full
   * rationale and what `force` does.
   */
  fetch(force?: boolean): Promise<void>;

  // --- Branch operations ---

  /**
   * Gets the current branch name
   */
  currentBranch(): Promise<string>;

  /**
   * Switches to a different branch
   */
  switchBranch(branch: string): Promise<void>;

  /**
   * Lists all branches
   */
  branches(): Promise<string[]>;

  /**
   * Resolves the repository's integration ("base") branch — the branch that
   * movements rebase onto and merge into. This is the remote's default branch
   * (from `refs/remotes/origin/HEAD`), so it works on any repo regardless of
   * whether that branch is named `main`, `master`, `develop`, etc. The tooling
   * never assumes a name: it always asks here.
   *
   * @returns The base branch name (e.g. "main" or "master")
   */
  baseBranch(): Promise<string>;

  /**
   * Sets (or, with `null`, clears) this worktree's own trunk override —
   * the branch `baseBranch()` reports for this worktree specifically,
   * regardless of the repo's actual remote default branch. Persists (in this
   * worktree's own git config) until explicitly changed again. This is the
   * seam experiment trunks use: a wing whose worktree has an override set
   * has all of its `movement`/`plan` operations target that branch instead
   * of `main`, with no other code needing to know why.
   */
  setBaseBranch(branch: string | null): Promise<void>;

  // --- Merge ---

  /**
   * Merges another branch into the current branch.
   * Uses --no-ff to always create a merge commit.
   * @param branch - Branch to merge into current branch
   * @param options - Optional merge options (custom message)
   * @returns Merge result with status and details
   */
  merge(branch: string, options?: MergeOptions): Promise<MergeResult>;

  /**
   * Rebases the current branch onto another branch.
   * On conflict, the rebase is left in progress so the caller can resolve and continue.
   * @param onto - Branch to rebase onto
   * @param options - Optional rebase options (e.g. autostash)
   * @returns Rebase result with status and details
   */
  rebase(onto: string, options?: RebaseOptions): Promise<RebaseResult>;

  /**
   * True if a rebase is currently in progress in this worktree — e.g. left
   * mid-conflict by `rebase()` or a previous `continueRebase()` call.
   */
  hasInProgressRebase(): Promise<boolean>;

  /**
   * Stages all changes in the worktree and continues an in-progress rebase
   * non-interactively (no commit-message editor is ever invoked — original
   * commit messages are reused automatically). Mirrors `rebase()`'s conflict
   * contract: a further conflict leaves the rebase in progress again and
   * returns the same result shape, so a caller can call this repeatedly
   * after each round of conflict resolution.
   */
  continueRebase(): Promise<RebaseResult>;

  /**
   * Abandons an in-progress rebase, restoring the worktree to its pre-rebase
   * state (`git rebase --abort`) — best-effort, never throws (mirrors
   * `DiskAdvanceAttemptImpl.dispose()`'s existing internal use of this same
   * primitive). Safe even when called with no rebase actually in progress.
   *
   * Exists on the port (not just as adapter-internal plumbing) for exactly
   * one caller shape: a `continueRebase()`/`rebase()` result whose `status`
   * is `"conflict"` but whose `conflictedFiles` is EMPTY — there is
   * genuinely nothing for a human to fix (see `GitOperations
   * .pushThroughEmptyHalt`'s own doc comment for the two known-safe halts it
   * already retries automatically before ever surfacing this), yet the halt
   * persists. The most likely explanation confirmed live in production: the
   * in-progress rebase itself is a STALE session orphaned by an earlier,
   * unrelated interruption (a crashed/restarted host process, a dropped
   * connection mid-operation) — its own bookkeeping no longer describes a
   * resolvable state, and no amount of retrying `continueRebase()` will ever
   * change that, since it isn't a transient condition at all. `abortRebase()`
   * plus a fresh `start()` is the same recovery a human did manually to
   * unblock this exact case — nothing is lost by it: the movement's own
   * commits are untouched (this only resets the CURRENT rebase attempt,
   * never the branch's real history), so re-running `start()` just
   * re-attempts the identical logical operation from a clean slate.
   */
  abortRebase(): Promise<void>;

  /**
   * Resets the current branch to point to a reference (branch, tag, or commit).
   * This is a hard reset - working tree is updated to match the target.
   * Useful for fast-forwarding a branch without creating a merge commit.
   * @param ref - The reference to reset to (branch name, tag, or commit hash)
   */
  resetTo(ref: string): Promise<void>;

  /**
   * Updates the sparse-checkout configuration for this worktree to cover
   * a single subdirectory, then re-applies checkout so the working tree
   * reflects the new set of tracked paths.
   * @param subdir - Subdirectory path within the repo to sparse-checkout
   */
  setSparseCheckout(subdir: string): Promise<void>;

  /**
   * Creates or force-resets a branch to point at a target ref, without switching to it.
   * Equivalent to `git branch -f <name> <target>`.
   * Safe to call when not on <name>.
   * @param name - Branch name to create/reset (may contain slashes, e.g. "plan/main")
   * @param target - Ref to point at (branch, tag, or commit)
   */
  updateBranch(name: string, target: string): Promise<void>;

  /**
   * Pushes a named branch to origin without switching to it.
   * Equivalent to `git push origin <name>:<name>`.
   * @param name - Branch name to push (may contain slashes)
   */
  pushBranch(name: string): Promise<void>;

  /**
   * Force pushes a named branch to origin without switching to it, and sets
   * its upstream tracking to origin/<name>. The -u flag applies to the branch
   * named in the refspec regardless of which branch is currently checked out.
   * Equivalent to `git push --force -u origin <name>:<name>`.
   * Use with caution - this rewrites remote history.
   * @param name - Branch name to force-push (may contain slashes)
   */
  forcePushBranch(name: string): Promise<void>;

  /**
   * Creates a commit object from an existing tree and parent refs WITHOUT
   * moving any branch or touching the working tree, and returns the new
   * commit's hash. Equivalent to
   * `git commit-tree <treeSource>^{tree} -p <parents[0]> -p <parents[1]> ...`
   * with the message supplied on stdin.
   *
   * Used to construct a --no-ff merge commit without checking out the target
   * branch: build the commit here, then point a branch at it via updateBranch().
   * This lets a merge land on main without main being checked out anywhere.
   *
   * @param treeSource - Ref whose tree the commit snapshots (e.g. the rebased branch tip)
   * @param parents - Parent refs, in order; parents[0] becomes the first parent
   * @param message - Full commit message (subject + body)
   * @returns The hash of the newly created commit
   */
  commitTree(treeSource: string, parents: string[], message: string): Promise<string>;

  // --- Log ---

  /**
   * Gets commit log between two refs.
   * Returns commits that are in `to` but not in `from`.
   * @param from - Starting ref (exclusive, typically 'main')
   * @param to - Ending ref (inclusive, typically 'HEAD' or branch name)
   */
  log(from: string, to: string): Promise<CommitInfo[]>;

  /**
   * Gets the unified diff of changes introduced by `to` since it diverged
   * from `from` (a three-dot diff: `from...to`) — content changed by the
   * branch, not changes accumulated on `from` in the meantime.
   * @param from - Base ref to diff against (typically the base branch)
   * @param to - Ref whose changes are shown (typically 'HEAD' or a branch name)
   */
  diff(from: string, to: string): Promise<string>;

  /**
   * Lists paths changed between two refs (a two-dot diff: `from..to`).
   * Equivalent to `git diff --name-only <from>..<to>`. Deliberately separate
   * from {@link WorktreeOperations.diff}, which is committed to returning
   * full unified diff text — a caller needing only paths shouldn't have to
   * parse them back out of diff text.
   * @param from - Starting ref
   * @param to - Ending ref
   */
  changedFiles(from: string, to: string): Promise<string[]>;

  /**
   * Reads a file's raw content as it existed at a specific ref, without
   * touching the live worktree checkout. Equivalent to `git show <ref>:<path>`.
   * @param ref - Commit sha or branch name
   * @param path - File path relative to the worktree root
   * @returns The file's content at that ref, or `null` if it didn't exist there
   */
  readFileAtRef(ref: GitRef, path: string): Promise<string | null>;

  // --- Status ---

  /**
   * Checks if there are uncommitted changes
   */
  isDirty(): Promise<boolean>;
}

/**
 * Worktree pattern matching
 */
interface WorktreeMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { worktree: (w: Worktree) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "worktree"): this is Worktree;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   */
  isDirectoryLike(): boolean;
}

// ============================================
// ReadOnlyClone Interface
// ============================================

/**
 * Read-only clone operations
 */
interface ReadOnlyCloneOperations extends DirectoryLikeOperations {
  readonly kind: "read-only-clone";
  readonly name: string;

  /**
   * The absolute filesystem path to this clone.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * The remote URL this was cloned from
   */
  readonly url: string;

  /**
   * The currently checked out branch
   */
  readonly branch: string;

  // --- Directory operations (narrowed to ReadOnlyChild) ---

  /**
   * Gets a child node by name
   */
  child(name: string): Promise<ReadOnlyChildResult>;

  /**
   * Lists all children
   */
  children(): Promise<ReadOnlyChild[]>;

  /**
   * Searches recursively for nodes matching a glob pattern (e.g. "**\/*.md").
   * Unlike children()'s bare basename, each result's `.name` is its path
   * relative to this clone (posix-separated, e.g. "sub/dir/readme.md") —
   * matches can be nested, so a bare basename would collide across depths and
   * couldn't be passed back into child() to re-fetch the node.
   */
  glob(pattern: string): Promise<ReadOnlyChild[]>;

  /**
   * Checks if the clone exists
   */
  exists(): Promise<boolean>;

  // --- Git operations ---

  /**
   * Fetches and resets to the latest remote state.
   * Equivalent to: git fetch && git reset --hard origin/<branch>
   */
  pullAndReset(): Promise<void>;

  /**
   * Switches to a different branch
   */
  switchBranch(branch: string): Promise<void>;

  /**
   * Lists all branches
   */
  branches(): Promise<string[]>;

  // --- Deletion ---

  /**
   * Deletes this clone
   */
  delete(): Promise<void>;
}

/**
 * ReadOnlyClone pattern matching
 */
interface ReadOnlyCloneMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { readOnlyClone: (c: ReadOnlyClone) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "read-only-clone"): this is ReadOnlyClone;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   */
  isDirectoryLike(): boolean;
}

// ============================================
// ReadOnlyDirectory Interface
// ============================================

/**
 * Read-only directory operations (within a ReadOnlyClone)
 */
interface ReadOnlyDirectoryOperations extends DirectoryLikeOperations {
  readonly kind: "read-only-directory";
  readonly name: string;

  /**
   * The absolute filesystem path to this directory.
   * For in-memory implementations, this is a virtual path.
   */
  readonly path: string;

  /**
   * Gets a child node by name
   */
  child(name: string): Promise<ReadOnlyChildResult>;

  /**
   * Lists all children
   */
  children(): Promise<ReadOnlyChild[]>;

  /**
   * Searches recursively for nodes matching a glob pattern (e.g. "**\/*.md").
   * Unlike children()'s bare basename, each result's `.name` is its path
   * relative to this directory (posix-separated, e.g. "sub/dir/readme.md") —
   * matches can be nested, so a bare basename would collide across depths and
   * couldn't be passed back into child() to re-fetch the node.
   */
  glob(pattern: string): Promise<ReadOnlyChild[]>;

  /**
   * Checks if the directory exists
   */
  exists(): Promise<boolean>;
}

/**
 * ReadOnlyDirectory pattern matching
 */
interface ReadOnlyDirectoryMatcher {
  /**
   * Pattern matches on this node type
   */
  match<T>(cases: { readOnlyDirectory: (d: ReadOnlyDirectory) => T }): T;

  /**
   * Type guard for checking node kind
   */
  is(kind: "read-only-directory"): this is ReadOnlyDirectory;
  is(kind: NodeKind): boolean;

  /**
   * Returns true if this node can contain children (is directory-like).
   */
  isDirectoryLike(): boolean;
}

// ============================================
// Sandbox-layer types (design doc §4.1)
//
// See docs/design/movement-trunk-safety-redesign.md §4.1. These types do
// NOT replace anything on `BareRepository`/`Worktree` above. Nothing here is
// wired into the existing `Sandbox`/`BareRepository` interfaces — adapters
// construct these via adapter-specific factory functions instead of a
// `BareRepository.trunk()` method, so `DiskBareRepository` doesn't need to
// implement anything new for them.
//
// One deliberate deviation from the design doc's pseudocode: `Mirror.files`
// and `CheckedOutMovement.files` are typed `MutableDirectoryLike` here, not
// the doc's bare `Directory`. In this codebase `Directory` carries a literal
// `kind: "directory"` tag that a real `Worktree` (`kind: "worktree"`)
// structurally can't satisfy — and a worktree checkout is exactly what
// backs both properties in every adapter. Plain `DirectoryLike` (already
// defined above) isn't quite right either — it also includes `Junction` and
// `ReadOnlyDirectory`/`ReadOnlyClone`, none of which support `createFile`,
// so a caller couldn't actually write through it without a narrowing cast.
// `MutableDirectoryLike` is the union of the two directory-like kinds that
// DO support the full read+write surface the design doc's pseudocode uses
// (child/children/glob/createFile/exists/...).
// ============================================

/** Directory-like nodes that support writing (`createFile`, `createDirectory`, ...), not just reading. */
export type MutableDirectoryLike = Directory | Worktree;

/**
 * A commit reference within one bare repo — a branch name or a commit sha.
 * Reuses {@link GitRef}'s brand rather than introducing a parallel one:
 * both mean "a string already trusted to identify a point in this repo's
 * history," and cross-repo history sharing is explicitly out of scope
 * (design doc §4.1), so there's never an ambiguity about which repo a
 * `CommitRef` belongs to.
 */
export type CommitRef = GitRef;

/**
 * See design doc §4.1's `MovementState` doc comment for the full rationale —
 * reproduced here: `"undefined"` means the branch doesn't exist locally yet;
 * `"integrated"` means no commits reachable from the branch aren't also
 * reachable from base (true whether the movement never diverged, or diverged
 * and was cleanly merged — those are indistinguishable in the git graph and
 * the distinction doesn't matter to any consumer); `"in-progress"` is
 * everything else.
 */
export type MovementState = "undefined" | "in-progress" | "integrated";

/** Options for {@link Movement.merge}. */
export interface MergeSpec {
  /** Custom merge commit message. If not provided, an adapter-chosen default is used. */
  message?: string;
}

/** Options for {@link CheckedOutMovement.commit}. */
export interface CommitSpec {
  /** Commit message. */
  message: string;
  /** Skip pre-commit/commit-msg hooks, mirroring `Worktree.commitAll`'s option. */
  noVerify?: boolean;
}

/** Result of {@link CheckedOutMovement.commit}. */
export interface CommitResult {
  /** The new commit's hash. */
  hash: string;
}

/**
 * Result of {@link CheckedOutMovement.start} — sugar for "fetch base, rebase
 * onto base's latest, autostash." Same shape as {@link RebaseResult} since
 * that's exactly what it wraps.
 */
export type StartResult = RebaseResult;

/** Result of {@link Movement.cherryPick}. */
export type CherryPickResult =
  | { status: "success" }
  | { status: "conflict"; message: string; conflictedFiles: string[] };

/**
 * A branch, not a session. Identity is just `(branch, base)` — handles are
 * cheap and freely reconstructible, and nothing about having merged
 * invalidates a handle, because there's no handle-local state to invalidate.
 * State is always derived, never stored (design doc §4.1).
 */
export interface Movement {
  readonly branch: string;
  readonly base: Trunk;

  state(): Promise<MovementState>;

  /** Defaults to `base`. */
  commitsSince(ref?: Movement | CommitRef): Promise<CommitInfo[]>;
  /** Defaults to `base`. */
  diffFrom(ref?: Movement | CommitRef): Promise<string>;
  /**
   * Resolves this movement's branch to its current commit sha, without
   * requiring a commit to have just happened. `null` if the branch doesn't
   * exist locally yet — mirrors `resolveLocalRef`'s existing null-for-missing
   * convention elsewhere in this port, so callers get a familiar shape for an
   * entirely expected "movement not started yet" state rather than a thrown
   * error. Read-only and base-independent, same spirit as `readFileAtRef`
   * below: no worktree needed, `git rev-parse <branch>` runs fine against a
   * bare repo.
   */
  tipHash(): Promise<string | null>;
  /**
   * Lists paths changed between two refs (a two-dot diff: `from..to`),
   * defaulting the same way `commitsSince`/`diffFrom` do: `from` defaults to
   * `base`, `to` defaults to `this.branch`. A sibling of `diffFrom`, not a
   * replacement for it — `diffFrom` is committed to returning full unified
   * diff text, and a caller that only needs a file-path list (e.g. to report
   * "what changed" without asking anyone to parse diff text back into paths)
   * shouldn't have to go through it.
   */
  changedFiles(from?: Movement | CommitRef, to?: Movement | CommitRef): Promise<string[]>;
  /**
   * Reads a file's raw content as it existed at a specific ref, without
   * touching any worktree checkout. Equivalent to `git show <ref>:<path>`.
   * Read-only and base-independent — callable against any ref reachable in
   * this movement's bare repo, whether or not it has anything to do with
   * `this.branch`/`base` (e.g. an arbitrary historical commit sha). This is
   * the replacement for the old `Worktree.readFileAtRef`, which design doc
   * §5's cut list removes: the operation itself is genuine, real, needed
   * functionality (see `DocsActionGroup`'s `load` action), just relocated
   * onto `Movement` since it never actually needed a checkout, only a bare
   * repo to run `git show` against.
   * @param ref - Commit sha or branch name
   * @param path - File path relative to the repo root
   * @returns The file's content at that ref, or `null` if it didn't exist there
   */
  readFileAtRef(ref: CommitRef, path: string): Promise<string | null>;
  discard(): Promise<void>;
}

/**
 * A {@link Movement} with an attached working tree — the "attended" shape
 * (design doc §4.3).
 *
 * `merge`/`rebaseOnto`/`cherryPick` live HERE, not on the bare `Movement`
 * interface above — every real caller (`MovementManager.mergeMovement()`,
 * `DerivedTrunk.advance()`'s replay) already has a `CheckedOutMovement` on
 * hand (a wing's own worktree, or `resolveIn`) and reuses ITS worktree via a
 * detached-HEAD checkout to build the trial commit, never a disposable
 * scratch worktree/branch. A bare `Movement` (from `Trunk.movement(branch)`,
 * with no worktree of its own) has no such contract to offer these
 * operations against — see `docs/design/movement-trunk-safety-redesign.md`
 * for the removed `Site<T>`-layer code that used to be this design's one
 * caller with genuinely no checkout available.
 */
export interface CheckedOutMovement extends Movement {
  readonly files: MutableDirectoryLike;
  isDirty(): Promise<boolean>;
  commit(spec: CommitSpec): Promise<CommitResult>;
  /**
   * Always targets `base` — there is no "merge a movement into another
   * movement." Builds a genuine two-parent merge commit (`merge --no-ff`;
   * first parent base's tip, second the movement's own tip — never
   * flattened/squashed into one), rebasing onto base's current tip
   * immediately before a CAS publish; on a lost race, re-rebases onto
   * whichever tip won and retries — see design doc §4.1 and §2 invariant A.
   * Base's resulting history reads as a chain of these merge commits, each
   * with the landing movement's own linear commit range intact and reachable
   * as a side branch off it.
   */
  merge(spec: MergeSpec): Promise<MergeResult>;
  rebaseOnto(target: Movement | CommitRef): Promise<RebaseResult>;
  cherryPick(commits: CommitRef[]): Promise<CherryPickResult>;
  /** Sugar: fetch base, `rebaseOnto` base's latest, autostash. */
  start(): Promise<StartResult>;
  resolveConflict(): Promise<StartResult | MergeResult>;
  /**
   * Force-pushes this movement's own branch to origin, syncing it for
   * cross-machine durability. A movement branch is single-writer per-wing —
   * unlike `Trunk`/`Mirror`'s shared refs, there is no multi-writer CAS
   * hazard for the normal case this guards against (design doc §2's
   * invariant A is about shared refs, not a wing's own branch) — but a
   * force-push can still clobber another machine's unpushed work on the
   * *same* branch if two machines are ever active on it at once, so callers
   * should treat this as best-effort, not a safety-checked publish: a
   * failure here should never fail a commit that already succeeded locally,
   * only be surfaced for visibility (e.g. by the next `start()`, which will
   * fetch and rebase against whatever origin actually has).
   */
  push(): Promise<void>;
}

/**
 * Never checked out, a pure merge target. `Trunk.repo`/`Trunk.branch` name
 * which real branch in which bare repo this trunk is; everything else about
 * working with it hangs off the methods below (design doc §4.1).
 */
export interface Trunk {
  readonly repo: BareRepository;
  readonly branch: string;

  /**
   * `branch` here is the MIRROR's own branch name — never the same as
   * `this.branch`, since a trunk is never checked out and a mirror always
   * is (git allows exactly one worktree per branch).
   */
  mirror(branch: string, subtree?: string): Mirror;

  /** Construct/reference a movement whose base is this trunk. */
  movement(branch: string): Movement;

  /** This trunk becomes the parent of a new derived (experiment) trunk. */
  derive(branch: string): DerivedTrunk;

  /**
   * Fast-forwards THIS trunk's branch directly to `target`, but only as a
   * genuine fast-forward from this trunk's current tip — CAS-published the
   * same way `Movement.merge()`/`Mirror.apply()`/`DerivedTrunk.advance()`
   * publish (design doc §2 invariant A): a real push-based CAS to origin on
   * the Disk adapter (there's no local "advance, then push" two-step), a
   * local CAS on InMemory (which has no separate origin to diverge from).
   *
   * Returns `false` (no error thrown) when the fast-forward can't be
   * confirmed — either this trunk's branch moved since the caller last read
   * it, or `target` isn't actually a descendant of this trunk's current
   * tip — the same non-exceptional "lost a race, recompute and retry"
   * contract every other publish primitive in this design uses.
   *
   * Used by `MovementManager.promote()`'s `foldPromotedTrunk()`
   * (`libs/movement-branching`) to fold a just-`advance()`d derived trunk's
   * tip onto its parent — safe by construction once `advance()` has
   * confirmed the derived trunk is a linear descendant of the parent.
   */
  fastForwardPublish(target: string): Promise<boolean>;

  discard(): Promise<void>;
}

/**
 * Result of {@link DerivedTrunk.advance}'s conflict-free fast path. The
 * attended fallback (`beginAdvance()`/`AdvanceAttempt`, design doc §4.4) is
 * not implemented yet.
 */
export type AdvanceResult =
  | { status: "ok" }
  | { status: "conflict"; failedCommit: string; message: string };

export interface DerivedTrunk extends Trunk {
  readonly parent: Trunk;

  /**
   * Rebase this trunk's history onto `parent`'s current tip, PRESERVING every
   * merge commit already in it (design doc §4.1/§4.4) — either succeeds for
   * the whole range or fails clean with nothing left mid-state.
   *
   * `resolveIn` is REQUIRED — matching `beginAdvance()`'s own contract: every
   * real caller (`MovementManager.promote()`) is an agent already operating
   * from inside some wing's own checkout, so there is always exactly one
   * `CheckedOutMovement` on hand to pass. When the fast/conflict-free path
   * needs a real checkout to build the replay (any range beyond a plain
   * fast-forward), `resolveIn`'s own worktree is reused (via a detached-HEAD
   * checkout, mirroring `CheckedOutMovement.merge()`) instead of provisioning
   * a disposable scratch worktree/branch (the Disk adapter's fallback for
   * `Movement.merge()`/`rebaseOnto()`/`cherryPick()`, which have no
   * `resolveIn`-shaped caller). `resolveIn`'s worktree is only actually
   * touched (and so only needs to be clean — throws otherwise, same
   * precondition `beginAdvance()` enforces) when a real replay is needed; a
   * pure fast-forward never borrows it at all. Whenever it IS borrowed, it's
   * always restored to `resolveIn.branch` before this returns, on every exit
   * path.
   */
  advance(resolveIn: CheckedOutMovement): Promise<AdvanceResult>;

  /**
   * The attended path (design doc §4.4), only needed when `advance()`
   * reports a `"conflict"`. Snapshots this trunk's current tip AND the
   * parent's current tip, creates a throwaway branch pointing at this
   * trunk's tip, and checks THAT branch out INTO `resolveIn`'s own worktree
   * — never this trunk's own branch, which (being a `Trunk`) is never
   * checked out anywhere — temporarily replacing whatever `resolveIn` had
   * checked out (real git allows exactly one branch per worktree). Then
   * starts the same merge-preserving rebase mechanism `advance()`'s fast
   * path uses (`rebase --rebase-merges`, non-interactive) onto the parent's
   * snapshotted tip — except a conflict here is left RESUMABLE instead of
   * aborted, for the returned `AdvanceAttempt` to drive to completion.
   *
   * `resolveIn` is REQUIRED: every real caller is an agent already operating
   * from inside some wing's own checkout, so there is always exactly one
   * worktree already available and already exposed to it — no synthetic
   * scratch worktree needs to be provisioned elsewhere. `resolveIn`'s
   * worktree is restored to whatever branch it had checked out before this
   * call once the returned `AdvanceAttempt` reaches a terminal state
   * (`publish()` succeeds, or `abandon()` is called) — the same
   * "remember what to restore" shape `MovementManager.promote()` implements
   * via `Worktree.setPromoteReturnBranch`/`getPromoteReturnBranch`, just
   * scoped to this `AdvanceAttempt` session instead of persisted
   * worktree-wide git config.
   */
  beginAdvance(resolveIn: CheckedOutMovement): Promise<AdvanceAttempt>;
}

/**
 * A resolution session for a real content conflict `DerivedTrunk.advance()`
 * couldn't resolve on its own (design doc §4.4). Backed by a private,
 * single-writer scratch branch — never the derived trunk's own branch,
 * which (being a `Trunk`) is never checked out — checked out into the
 * `resolveIn` worktree the caller passed to `beginAdvance()`, that a client
 * drives to completion via `continueResolving()`, then publishes via
 * `publish()`'s two-sided CAS. `resolveIn`'s original branch is restored
 * once this attempt reaches a terminal state (`publish()` succeeding, or
 * `abandon()`).
 */
export interface AdvanceAttempt {
  /** `resolveIn`'s own worktree (see `beginAdvance()`), temporarily checked out on the scratch branch. Edit conflicted files here. */
  readonly files: MutableDirectoryLike;
  readonly status: "conflict" | "ready";
  /** Populated when `status === "conflict"`. */
  readonly conflictedFiles: string[];

  /**
   * After fixing files in `.files`, stages and resumes the in-progress
   * merge-preserving rebase — the same resumable-rebase contract
   * `CheckedOutMovement.start()`/`resolveConflict()` already use
   * (`hasInProgressRebase()`/`continueRebase()`), just pointed at this
   * private scratch branch. May hit the next conflict in the same range, in
   * which case the returned `AdvanceAttempt` is `"conflict"` again.
   */
  continueResolving(): Promise<AdvanceAttempt>;

  /**
   * Once `status === "ready"`: publishes the resolved tip via the same
   * two-tier CAS `advance()`'s fast path uses (`pushRefCas`, falling back to
   * `pushRefCasExpected`), with a two-sided check against BOTH refs that
   * could have moved since the snapshot (design doc §4.4):
   *
   * - If the PARENT moved: re-runs the merge-preserving rebase using the
   *   just-resolved tip as the new starting point and the parent's current
   *   tip as the new target. Applies cleanly in the common case; on a real
   *   new conflict, this `AdvanceAttempt` returns to `status: "conflict"`
   *   for another round (`continueResolving()` again) rather than failing
   *   outright.
   * - If the DERIVED TRUNK ITSELF moved (someone else's `advance()`/movement
   *   landed on it mid-resolution): detected via CAS against this trunk's
   *   actual current tip. The replay range is EXTENDED to include the new
   *   commits and retried — which may reopen conflicts the new commits
   *   introduce, correctly, rather than silently dropping them.
   *
   * A lost race on the push itself (not a content conflict — just origin
   * having moved in a way this attempt's recomputation already accounts
   * for) is retried automatically, bounded by the same
   * `publishWithRetry`/`maxAttempts` machinery `advance()`'s fast path uses.
   *
   * On success (status `"ok"`), `resolveIn`'s worktree (passed to
   * `beginAdvance()`) is restored to whatever branch it had checked out
   * before this attempt began.
   */
  publish(): Promise<AdvanceResult>;

  /**
   * Discards the scratch branch, leaving the derived trunk untouched, and
   * restores `resolveIn`'s worktree (passed to `beginAdvance()`) to
   * whatever branch it had checked out before this attempt began.
   */
  abandon(): Promise<void>;
}

/**
 * The direct-commit, no-attached-client path. `apply()` is invariant B made
 * concrete: read the trunk's current tip into `view`, run `transform`, commit
 * whatever changed, CAS-publish. On a lost race, re-run the whole `transform`
 * against the fresh tip — `transform` must be pure with respect to its input
 * view, no closures over a stale read from a previous attempt.
 */
export interface Mirror<T extends Trunk = Trunk> {
  readonly trunk: T;
  /** Always-fresh local cache view, safe to read any time. */
  readonly files: MutableDirectoryLike;
  apply<R>(
    transform: (view: MutableDirectoryLike) => Promise<R>,
    opts?: { retries?: number; message?: string },
  ): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }>;
}
