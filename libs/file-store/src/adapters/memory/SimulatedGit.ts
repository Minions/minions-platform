/**
 * Simulated Git System (OO Port)
 *
 * Provides an in-memory simulation of git operations for testing.
 * Designed for the OO interface with commitAll, merge, rebase, etc.
 *
 * Models exactly what real git shares across every worktree of one bare
 * repo — commits, branches, remote-tracking refs — and nothing else. Unlike
 * real git, this class has no notion of "the current branch" or "the
 * working tree": those are genuinely per-worktree in real git (each linked
 * worktree has its own HEAD, index, and checked-out files), so every method
 * that needs them takes the calling worktree's branch and/or working-tree
 * contents as an explicit parameter instead of reading instance state. This
 * is what lets two `InMemoryWorktree`s built on the same bare repo operate
 * independently and correctly regardless of call order or interleaving —
 * an earlier version kept `currentBranch`/`workingTree` as shared instance
 * fields, which meant one worktree's operation could silently see (or
 * clobber) another worktree's branch/files whenever calls interleaved.
 */

import type { MergeResult, RebaseResult, CommitInfo, GitRef } from "../../port/types.js";

/**
 * Represents a single commit in the simulated git history.
 */
export interface SimulatedCommit {
  hash: string;
  message: string;
  /**
   * All parent hashes, in order — `parents[0]` is the first parent (mirrors
   * real git's `-p` ordering). Empty for a root commit, length 1 for an
   * ordinary commit, length 2 for a merge commit built by `merge()` (first
   * parent = the branch merged into, second = the branch merged in) — never
   * flattened to a single parent, so a movement's whole incremental history
   * stays reachable from main after landing (design doc §4.1).
   */
  parents: string[];
  tree: Map<string, string>; // file path -> content (relative to worktree)
  timestamp: number;
}

/**
 * Result of a simulated merge: the outcome plus the resulting working-tree
 * contents, which the caller (an `InMemoryWorktree`) applies to its own
 * files. `tree` is the merged (or, on conflict/no-op, unchanged) tree —
 * always present so the caller never has to guess whether to re-sync.
 */
export interface SimulatedMergeOutcome {
  result: MergeResult;
  tree: Map<string, string>;
}

/**
 * Result of a simulated rebase: the outcome plus the resulting working-tree
 * contents. `tree` is present only when rebase actually produced a new
 * commit (a real change to sync back to the caller's files) — omitted on
 * both the "nothing to do" and "conflict" paths, where the caller's
 * existing files are already correct as-is.
 */
export interface SimulatedRebaseOutcome {
  result: RebaseResult;
  tree?: Map<string, string>;
}

let globalHashCounter = 0;

/**
 * Characters git's own `check-ref-format` disallows anywhere in a ref
 * component: ASCII control characters, space, and `~^:?*[\`.
 */
// oxlint-disable-next-line no-control-regex -- intentional: git's own check-ref-format disallows ASCII control chars too
const DISALLOWED_REF_CHARS = /[\x00-\x1f\x7f ~^:?*[\\]/;

/**
 * Validates a branch (ref) name against a subset of real git's
 * `check-ref-format` rules — enough to keep this adapter at parity with real
 * git, which rejects a malformed ref (e.g. one with an empty path component,
 * like `"__exp//v1/main"` from an empty experiment name) at branch-creation
 * time. Without this check, `SimulatedGit` would silently accept and store
 * the branch under the malformed name instead.
 * Callers creating/moving a branch under a naming convention with its own
 * human-supplied NAME COMPONENT are additionally expected to validate that
 * component itself before it ever reaches here — this is defense-in-depth
 * against a bypass of that layer, not the primary line of defense, matching
 * real git's own "the tool that builds the ref string should validate its
 * inputs, and git itself refuses malformed refs too" shape.
 */
function assertValidRefName(name: string): void {
  if (name.length === 0) {
    throw new Error(`Invalid ref name: (empty)`);
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    throw new Error(`Invalid ref name '${name}': cannot start or end with '/'`);
  }
  if (name.includes("//")) {
    throw new Error(`Invalid ref name '${name}': cannot contain consecutive '/' (empty path component)`);
  }
  if (name.includes("..")) {
    // Real git's `check-ref-format` rejects ".." ANYWHERE in a ref, not just
    // as an isolated whole path component (confirmed directly:
    // `git check-ref-format --branch "foo..bar"` fails).
    throw new Error(`Invalid ref name '${name}': cannot contain '..' anywhere in the ref`);
  }
  for (const component of name.split("/")) {
    if (component === "." || component === "..") {
      throw new Error(`Invalid ref name '${name}': '.' or '..' path component`);
    }
    if (component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock")) {
      throw new Error(`Invalid ref name '${name}': path component cannot start/end with '.' or end with '.lock'`);
    }
  }
  if (DISALLOWED_REF_CHARS.test(name)) {
    throw new Error(`Invalid ref name '${name}': contains a character not allowed in a git ref`);
  }
  if (name.includes("@{")) {
    throw new Error(`Invalid ref name '${name}': cannot contain '@{'`);
  }
}

/**
 * Simulated git system that stores commits and branches in memory.
 *
 * Key differences from the legacy SimulatedGit:
 * - Uses commitAll() instead of staged add/commit
 * - Supports merge with MergeResult type
 * - Every worktree-scoped operation takes branch/working-tree explicitly
 *   (see the class doc) instead of reading shared "current" state
 * - Better dirty state tracking
 */
export class SimulatedGit {
  private commits = new Map<string, SimulatedCommit>();
  private branches = new Map<string, string>(); // branch name -> commit hash
  private remoteRefs = new Map<string, string>(); // e.g. "origin/main" -> commit hash

  // Configurable behavior for testing
  private simulatedRebaseConflict = false;
  private simulatedRebaseConflictMessage = "Simulated rebase conflict";
  private simulatedRebaseConflictFiles: string[] = [];

  constructor() {
    // Initialize with main branch pointing to empty
    this.branches.set("main", "");
  }

  /**
   * Configure simulated rebase behavior for testing.
   * @param conflict - If true, rebase operations will fail with conflict
   * @param message - Optional custom conflict message
   * @param files - Optional list of conflicted files
   */
  setSimulatedRebaseConflict(conflict: boolean, message?: string, files?: string[]): void {
    this.simulatedRebaseConflict = conflict;
    if (message) {
      this.simulatedRebaseConflictMessage = message;
    }
    if (files) {
      this.simulatedRebaseConflictFiles = files;
    }
  }

  // ========================================
  // Branch Management
  // ========================================

  /**
   * Ensures a branch exists (creates it, pointing at `from`, if not).
   * @param from - Branch a newly-created branch should start from (defaults
   *   to "main", mirroring a fresh clone's default branch)
   */
  ensureBranch(branch: string, from = "main"): void {
    if (!this.branches.has(branch)) {
      assertValidRefName(branch);
      this.branches.set(branch, this.branches.get(from) || "");
    }
  }

  /**
   * Gets all branch names.
   */
  getBranches(): string[] {
    return Array.from(this.branches.keys());
  }

  /**
   * Resolves a ref (branch name, remote-tracking ref like "origin/main", or
   * commit hash) to a commit hash. Returns "" when the ref is unknown or
   * points at nothing. Has no notion of "HEAD" — real git's HEAD is
   * per-worktree, so a caller meaning "this worktree's current branch" must
   * resolve that itself (see `InMemoryWorktree`'s own HEAD handling) and
   * pass the branch name in.
   */
  private resolveRef(ref: string): string {
    if (this.branches.has(ref)) {
      return this.branches.get(ref) || "";
    }
    if (this.remoteRefs.has(ref)) {
      return this.remoteRefs.get(ref) || "";
    }
    if (this.commits.has(ref)) {
      return ref;
    }
    return "";
  }

  /**
   * Records `ref` (e.g. "origin/main") as pointing at `branch`'s current
   * commit — mirrors what `git push` advances on the remote's tracking ref.
   * Throws if `branch` doesn't exist locally (matching git's own refusal to
   * push an unknown branch).
   */
  setRemoteRefFromBranch(ref: string, branch: string): void {
    if (!this.branches.has(branch)) {
      throw new Error(`Unknown branch: ${branch}`);
    }
    const hash = this.branches.get(branch) || "";
    if (!hash) {
      throw new Error(`Branch '${branch}' has no commits yet`);
    }
    this.remoteRefs.set(ref, hash);
  }

  /**
   * Directly points a remote-tracking ref (e.g. "origin/main") at an
   * already-known commit — for tests simulating a remote that has advanced
   * independently of this repo's local branches (e.g. another clone already
   * pushed). `hash` must already exist as a commit here (the simulation has
   * no separate remote object store — see SimulatedGit's module doc).
   */
  setRemoteRef(ref: string, hash: string): void {
    if (!this.commits.has(hash)) {
      throw new Error(`Unknown commit: ${hash}`);
    }
    this.remoteRefs.set(ref, hash);
  }

  /**
   * Removes a local branch entirely (not just its worktree) — mirrors
   * `git branch -D`. For tests simulating a repo that has a remote-tracking
   * ref but no corresponding local branch yet (e.g. before the first
   * `updateBranch('main', 'origin/main')` has ever run).
   */
  deleteBranch(name: string): void {
    this.branches.delete(name);
  }

  /**
   * All commits, keyed by hash. Commit objects are content-addressed and
   * safe to share verbatim across `SimulatedGit` instances — used to copy
   * history between a clone and its simulated remote (see `cloneFrom`).
   * @internal
   */
  getAllCommits(): ReadonlyMap<string, SimulatedCommit> {
    return this.commits;
  }

  /**
   * All local branch tips, keyed by branch name. Used to seed a clone's
   * remote-tracking refs from a simulated remote's current state (see
   * `cloneFrom`).
   * @internal
   */
  getAllBranches(): ReadonlyMap<string, string> {
    return this.branches;
  }

  /**
   * Inserts a commit object as-is (already has its final hash) — for
   * copying history from another `SimulatedGit` instance. No-op if a commit
   * with that hash is already present (commit objects are immutable once
   * created, so this is always safe).
   * @internal
   */
  importCommit(commit: SimulatedCommit): void {
    if (!this.commits.has(commit.hash)) {
      this.commits.set(commit.hash, commit);
    }
  }

  /**
   * Directly sets a local branch to an already-known commit hash, bypassing
   * `updateBranch`'s ref resolution — for simulating a push landing on a
   * remote (the remote has no local branches of its own otherwise; this is
   * how its "current state" advances during `pushBranch`).
   * @internal
   */
  forceSetLocalBranch(name: string, hash: string): void {
    this.branches.set(name, hash);
  }

  /**
   * Copies every commit and current branch tip from `remote` into this
   * repo's remote-tracking refs ("origin/<branch>") — never into local
   * branches. Mirrors what `git clone`/`git fetch` populate. Safe to call
   * repeatedly (e.g. once at clone time, again on every `fetch()`) — already-
   * known commits are skipped, and remote-tracking refs are simply
   * overwritten with the remote's current tips.
   */
  cloneFrom(remote: SimulatedGit): void {
    for (const commit of remote.getAllCommits().values()) {
      this.importCommit(commit);
    }
    for (const [branch, hash] of remote.getAllBranches()) {
      if (hash) this.remoteRefs.set(`origin/${branch}`, hash);
    }
  }

  /**
   * The commit hash a local branch currently points at, or undefined if the
   * branch doesn't exist or has no commits yet.
   */
  getBranchHash(name: string): string | undefined {
    return this.branches.get(name) || undefined;
  }

  /**
   * Resolves `name` as a local branch first, then as a remote-tracking ref
   * (e.g. "origin/main"), mirroring `BareRepository.resolveLocalRef`.
   * Returns undefined if neither is known.
   */
  resolveLocalRef(name: string): string | undefined {
    return this.branches.get(name) || this.remoteRefs.get(name) || undefined;
  }

  /**
   * Creates or force-resets a branch to point at a target ref, without
   * switching to it. Mirrors `git branch -f <name> <target>`.
   * Throws when the target cannot be resolved (matching git's behavior).
   */
  updateBranch(name: string, target: string): void {
    assertValidRefName(name);
    const targetHash = this.resolveRef(target);
    if (!targetHash) {
      throw new Error(`Unknown reference: ${target}`);
    }
    this.branches.set(name, targetHash);
  }

  /**
   * Compare-and-swap: moves `name` to `target`, but only if it currently
   * resolves to exactly `expected`. Mirrors `git update-ref <ref> <new>
   * <old>` — see `DiskWorktree.updateBranchIfUnchanged`'s doc for why this
   * exists instead of `updateBranch`'s blind overwrite.
   */
  updateBranchIfUnchanged(name: string, target: string, expected: string): boolean {
    assertValidRefName(name);
    const current = this.branches.get(name) ?? "";
    if (current !== expected) return false;
    const targetHash = this.resolveRef(target);
    if (!targetHash) {
      throw new Error(`Unknown reference: ${target}`);
    }
    this.branches.set(name, targetHash);
    return true;
  }

  /**
   * Creates a branch at ref if it doesn't already exist. Never moves an
   * existing branch. Mirrors `git branch <name> <ref>`.
   */
  createBranchIfMissing(name: string, ref: string): void {
    if (this.branches.has(name)) return;
    this.updateBranch(name, ref);
  }

  /**
   * Creates a commit from an existing tree and parent refs without moving any
   * branch or touching any working tree. Returns the new commit hash.
   * Mirrors `git commit-tree -p <parents[0]> -p <parents[1]> ...` — every
   * resolvable parent is recorded, in order.
   */
  commitTree(treeSource: string, parents: string[], message: string): string {
    const sourceHash = this.resolveRef(treeSource);
    const sourceCommit = sourceHash ? this.commits.get(sourceHash) : undefined;
    const tree = sourceCommit ? new Map(sourceCommit.tree) : new Map<string, string>();

    const parentHashes = parents
      .map((parent) => this.resolveRef(parent))
      .filter((hash) => hash !== "");

    const hash = this.generateHashUniqueAcrossAllInstances();
    const commit: SimulatedCommit = {
      hash,
      message,
      parents: parentHashes,
      tree,
      timestamp: Date.now(),
    };

    this.commits.set(hash, commit);
    return hash;
  }

  // ========================================
  // Commit Operations
  // ========================================

  /**
   * Commits `workingTree` as the new tip of `branch`. No staging — always
   * commits everything the caller passes in (that worktree's full current
   * file state), mirroring `git commit -a`.
   */
  commitAll(branch: string, workingTree: ReadonlyMap<string, string>, message: string): string {
    const parentHash = this.branches.get(branch) || null;
    const parents = parentHash ? [parentHash] : [];

    const hash = this.generateHashUniqueAcrossAllInstances();
    const commit: SimulatedCommit = {
      hash,
      message,
      parents,
      tree: new Map(workingTree),
      timestamp: Date.now(),
    };

    this.commits.set(hash, commit);
    this.branches.set(branch, hash);

    return hash;
  }

  /**
   * Gets a commit by hash.
   */
  getCommit(hash: string): SimulatedCommit | undefined {
    return this.commits.get(hash);
  }

  /**
   * Gets a branch's current commit hash, or null if it doesn't exist or has
   * no commits yet.
   */
  getHeadCommit(branch: string): string | null {
    const hash = this.branches.get(branch);
    return hash === "" || hash === undefined ? null : hash;
  }

  /**
   * Returns the file tree recorded at a branch's current commit (path ->
   * content), or undefined if the branch doesn't exist or has no commits
   * yet. Non-mutating.
   */
  getTree(branch: string): Map<string, string> | undefined {
    const hash = this.branches.get(branch);
    if (!hash) return undefined;
    return this.commits.get(hash)?.tree;
  }

  /**
   * Checks whether `workingTree` differs from `branch`'s current commit
   * tree. `branch` and `workingTree` are always the calling worktree's own
   * — see the class doc for why neither is implicit state here.
   */
  isDirty(branch: string, workingTree: ReadonlyMap<string, string>): boolean {
    const headHash = this.branches.get(branch);
    if (!headHash) {
      return workingTree.size > 0;
    }

    const headCommit = this.commits.get(headHash);
    if (!headCommit) {
      return workingTree.size > 0;
    }

    return !this.treesEqual(workingTree, headCommit.tree);
  }

  /**
   * Gets commit log between two refs.
   * Returns commits that are in `to` but not in `from`. Both must already
   * be resolvable refs (branch, remote-tracking ref, or hash) — a caller
   * meaning "this worktree's current branch" resolves that itself before
   * calling in (see the class doc's note on HEAD).
   */
  log(from: string, to: string): CommitInfo[] {
    const fromHash = this.resolveRef(from);
    const toHash = this.resolveRef(to);

    if (!toHash) {
      return [];
    }

    const commits: CommitInfo[] = [];
    let currentHash: string | null = toHash;

    // Walk the commit chain from 'to' back to 'from'
    while (currentHash && currentHash !== fromHash) {
      const commit = this.commits.get(currentHash);
      if (!commit) break;

      commits.push({
        hash: commit.hash,
        subject: commit.message.split('\n')[0],
        body: commit.message.split('\n').slice(1).join('\n').trim(),
        author: 'Test User',
        date: new Date(commit.timestamp).toISOString(),
      });

      currentHash = commit.parents[0] ?? null;
    }

    return commits;
  }

  /**
   * Mirrors `git merge-base --is-ancestor <ancestor> <descendant>`: true if
   * `ancestor` is reachable by walking ALL parents (not just the first) from
   * `descendant`, including `descendant === ancestor` itself. A full
   * multi-parent walk is required — unlike `log()`'s first-parent walk —
   * because `ancestor` may be a merge commit's second parent (a movement's
   * own landing commit), which a first-parent-only walk would never visit.
   */
  isAncestor(ancestor: string, descendant: string): boolean {
    const ancestorHash = this.resolveRef(ancestor);
    const descendantHash = this.resolveRef(descendant);
    if (!ancestorHash || !descendantHash) return false;
    if (ancestorHash === descendantHash) return true;

    const visited = new Set<string>();
    const stack = [descendantHash];
    while (stack.length > 0) {
      const hash = stack.pop() as string;
      if (visited.has(hash)) continue;
      visited.add(hash);
      const commit = this.commits.get(hash);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestorHash) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /**
   * Gets the unified diff of changes between the trees of two refs.
   * Simplified simulation (whole-file +/- blocks, not a real line-level
   * diff algorithm) — sufficient for tests asserting on changed content.
   * Both refs must already be resolvable — see `log`'s note on HEAD.
   */
  diff(from: string, to: string): string {
    const fromHash = this.resolveRef(from);
    const toHash = this.resolveRef(to);

    const fromTree = fromHash ? this.commits.get(fromHash)?.tree ?? new Map<string, string>() : new Map<string, string>();
    const toTree = toHash ? this.commits.get(toHash)?.tree ?? new Map<string, string>() : new Map<string, string>();

    const paths = Array.from(new Set([...fromTree.keys(), ...toTree.keys()])).sort();
    const chunks: string[] = [];

    for (const filePath of paths) {
      const before = fromTree.get(filePath);
      const after = toTree.get(filePath);
      if (before === after) continue;

      if (before === undefined) {
        chunks.push(
          `diff --git a/${filePath} b/${filePath}\nnew file\n+++ b/${filePath}\n` +
          (after ?? '').split('\n').map(line => `+${line}`).join('\n')
        );
      } else if (after === undefined) {
        chunks.push(
          `diff --git a/${filePath} b/${filePath}\ndeleted file\n--- a/${filePath}\n` +
          before.split('\n').map(line => `-${line}`).join('\n')
        );
      } else {
        chunks.push(
          `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n` +
          before.split('\n').map(line => `-${line}`).join('\n') + '\n' +
          after.split('\n').map(line => `+${line}`).join('\n')
        );
      }
    }

    return chunks.join('\n');
  }

  /**
   * Lists paths changed between the trees of two refs (a two-dot diff, but
   * this simulation stores each commit's whole tree rather than deltas, so
   * "two-dot vs three-dot" is moot here — it's always a direct tree-to-tree
   * comparison). Both refs must already be resolvable — see `log`'s note on
   * HEAD.
   */
  changedFiles(from: string, to: string): string[] {
    const fromHash = this.resolveRef(from);
    const toHash = this.resolveRef(to);

    const fromTree = fromHash ? this.commits.get(fromHash)?.tree ?? new Map<string, string>() : new Map<string, string>();
    const toTree = toHash ? this.commits.get(toHash)?.tree ?? new Map<string, string>() : new Map<string, string>();

    const paths = Array.from(new Set([...fromTree.keys(), ...toTree.keys()])).sort();
    return paths.filter((filePath) => fromTree.get(filePath) !== toTree.get(filePath));
  }

  /**
   * Reads a file's content as it existed at a specific ref, or `null` if
   * the ref is unknown or the file didn't exist in that commit's tree.
   */
  readFileAtRef(ref: GitRef, path: string): string | null {
    const hash = this.resolveRef(ref);
    if (!hash) return null;
    const content = this.commits.get(hash)?.tree.get(path);
    return content ?? null;
  }

  // ========================================
  // Merge Operations
  // ========================================

  /**
   * Merges `sourceBranch` into `ontoBranch`, applying its tree on top of
   * `workingTree` (the calling worktree's own current files). Returns both
   * the outcome and the resulting tree — always present (unchanged from
   * `workingTree` on the "already up to date" path) so the caller never has
   * to guess whether to re-sync its files.
   * @param ontoBranch - The branch being merged into (whose new tip a
   *   successful merge commits onto)
   * @param workingTree - The calling worktree's current file state
   * @param sourceBranch - Branch being merged in
   * @param message - Optional custom merge commit message
   */
  merge(ontoBranch: string, workingTree: ReadonlyMap<string, string>, sourceBranch: string, message?: string): SimulatedMergeOutcome {
    const targetHash = this.branches.get(sourceBranch);
    const currentHash = this.branches.get(ontoBranch);

    // Check if already up to date
    if (targetHash === currentHash || !targetHash || targetHash === "") {
      return { result: { status: "already-up-to-date" }, tree: new Map(workingTree) };
    }

    // Get target tree
    const targetCommit = this.commits.get(targetHash);
    if (!targetCommit) {
      return { result: { status: "already-up-to-date" }, tree: new Map(workingTree) };
    }

    // Simple merge: apply all files from target, detect conflicts
    const conflicts: string[] = [];
    const mergedTree = new Map(workingTree);

    for (const [path, content] of targetCommit.tree) {
      const currentContent = mergedTree.get(path);
      if (currentContent !== undefined) {
        if (currentContent !== content) {
          // Different content = potential conflict
          // For simplicity, just take target's content (no real conflict resolution)
          conflicts.push(path);
        }
      }
      mergedTree.set(path, content);
    }

    // In a real implementation, conflicts would stop the merge
    // For simulation, we auto-resolve by keeping merged result
    if (conflicts.length > 0) {
      return { result: { status: "conflict", conflictedFiles: conflicts }, tree: mergedTree };
    }

    // Create a genuine two-parent merge commit — mirrors `git merge --no-ff`,
    // which always creates a merge commit even when a fast-forward would be
    // possible. First parent is `ontoBranch`'s own tip, second is the branch
    // merged in — never flattened to one parent, so a movement's whole
    // incremental history stays reachable as a side branch after landing
    // (design doc §4.1; see `Movement.merge()`'s callers, which publish this
    // commit unaltered rather than rebuilding it with `commitTree`).
    const commitMessage = message ?? `Merge branch '${sourceBranch}'`;
    const hash = this.generateHashUniqueAcrossAllInstances();
    const parents = currentHash ? [currentHash, targetHash] : [targetHash];
    const commit: SimulatedCommit = {
      hash,
      message: commitMessage,
      parents,
      tree: mergedTree,
      timestamp: Date.now(),
    };
    this.commits.set(hash, commit);
    this.branches.set(ontoBranch, hash);
    return { result: { status: "success", commit: hash }, tree: mergedTree };
  }

  /**
   * Resets `branch` to point at `ref`. Returns the tree at that ref, for the
   * caller to apply to its own files (mirrors `git reset --hard`, which
   * updates the working tree along with the branch pointer).
   * @param branch - The branch being reset (the calling worktree's own)
   * @param ref - Branch name, remote-tracking ref, or commit hash to reset to
   */
  resetTo(branch: string, ref: string): Map<string, string> {
    const targetHash = this.resolveRef(ref);

    if (!targetHash) {
      throw new Error(`Unknown reference: ${ref}`);
    }

    this.branches.set(branch, targetHash);

    const commit = this.commits.get(targetHash);
    return commit ? new Map(commit.tree) : new Map();
  }

  // ========================================
  // Rebase
  // ========================================

  /**
   * Rebases `branch` onto `onto`. In simulation, this checks for configured
   * conflict behavior. `tree` is present in the result only when a new
   * commit was actually created — the caller applies it to its own files;
   * on the "nothing to do" or "conflict" paths, the caller's existing files
   * are already correct as-is.
   * @param branch - The branch being rebased (the calling worktree's own)
   * @param onto - Branch to rebase onto
   */
  rebase(branch: string, onto: string): SimulatedRebaseOutcome {
    const originalHead = this.getHeadCommit(branch) || "";
    const targetHash = this.resolveRef(onto);
    const currentHash = this.branches.get(branch);

    // Check if already up to date (same commit or no target) - still success
    if (!targetHash || targetHash === "" || targetHash === currentHash) {
      return { result: { status: "success" } };
    }

    // Check for simulated conflict
    if (this.simulatedRebaseConflict) {
      return {
        result: {
          status: "conflict",
          message: this.simulatedRebaseConflictMessage,
          originalHead,
          conflictedFiles: this.simulatedRebaseConflictFiles,
        },
      };
    }

    // Successful rebase simulation:
    // In a real rebase, commits would be replayed on top of the target.
    // For simulation, we create a new commit that has the combined tree
    // (current branch changes on top of target branch state).
    const targetCommit = this.commits.get(targetHash);
    const currentCommit = currentHash ? this.commits.get(currentHash) : null;

    if (targetCommit) {
      // Start with target's tree
      const newTree = new Map(targetCommit.tree);

      // Apply current branch's changes on top
      if (currentCommit) {
        for (const [path, content] of currentCommit.tree) {
          newTree.set(path, content);
        }
      }

      // Create a new "rebased" commit
      const hash = this.generateHashUniqueAcrossAllInstances();
      const commit: SimulatedCommit = {
        hash,
        message: currentCommit?.message ?? "Rebased commit",
        parents: [targetHash],
        tree: newTree,
        timestamp: Date.now(),
      };

      this.commits.set(hash, commit);
      this.branches.set(branch, hash);

      return { result: { status: "success" }, tree: newTree };
    }

    return { result: { status: "success" } };
  }

  // ========================================
  // Push/Pull/Fetch (Simulated)
  // ========================================

  /**
   * Simulated push - no-op for in-memory.
   */
  push(): void {
    // No-op for in-memory simulation
  }

  /**
   * Simulated push with upstream tracking - no-op for in-memory.
   */
  pushWithSetUpstream(_setUpstream = false): void {
    // No-op for in-memory simulation
  }

  /**
   * Simulated force push - no-op for in-memory.
   */
  forcePush(): void {
    // No-op for in-memory simulation
  }

  /**
   * Simulated pull - no-op for in-memory.
   */
  pull(): void {
    // No-op for in-memory simulation
  }

  /**
   * Simulated fetch - no-op for in-memory.
   */
  fetch(): void {
    // No-op for in-memory simulation
  }

  // ========================================
  // Internal Helpers
  // ========================================

  private generateHashUniqueAcrossAllInstances(): string {
    globalHashCounter++;
    return `commit-${globalHashCounter.toString(16).padStart(8, "0")}`;
  }

  /**
   * Compares two trees for equality.
   */
  private treesEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (b.get(key) !== value) return false;
    }
    return true;
  }
}
