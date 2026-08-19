/**
 * `Wing`'s movement-shaped accessors (design doc §4.2).
 *
 * `WorkArea` replaces a raw `Worktree` result for `workLocal`/`workNamed`/
 * `workGlobal`/`privateGlobal`: instead of handing back a `Worktree` whose
 * raw git-mechanics surface (`rebase`, `resetTo`, `updateBranch`, `pushBranch`,
 * ...) is exactly the kind of primitive design doc §1 identifies as letting
 * unrelated code touch a shared ref unsafely, a `WorkArea` only ever hands
 * back a `CheckedOutMovement` — the movement-mediated, attended-conflict
 * shape design doc §4.3 describes.
 *
 * `Scratchpad` replaces `privateLocal`'s raw `Worktree`: no base, no merge
 * target, no origin, expected to reset between uses (design doc §4.5) —
 * forcing the fuller `Movement`/`WorkArea` shape onto it would misrepresent
 * what a scratchpad actually is.
 *
 * These accessors are named `workAreaLocal`/`workAreaGlobal`/`workAreaNamed`/
 * `privateWorkAreaGlobal`/`scratchpad` (see `Wing.ts`'s doc comment on those)
 * rather than the plain `workLocal`/`workGlobal`/`workNamed`/`privateGlobal`/
 * `privateLocal` names, because those plain names are already in use by the
 * `Worktree`-returning surface that real callers across the monorepo
 * (`libs/movement-branching`, `libs/planner`, `apps/cabinet`, and more) still
 * depend on.
 */

import type { BareRepository, MutableDirectoryLike, Movement, CheckedOutMovement, Trunk, CommitRef } from "../port/types.js";

/**
 * A movement-shaped work area — see design doc §4.2. Backed by a single real
 * worktree (the same one `workLocal()`/etc. resolve to), whose currently
 * checked-out branch IS the "active movement."
 */
export interface WorkArea {
  readonly repo: BareRepository;

  /**
   * The `CheckedOutMovement` for whatever branch is currently checked out in
   * this work area. Its `base` is resolved from the worktree's own
   * `baseBranch()` (the pre-existing `Worktree.baseBranch()`/`setBaseBranch()`
   * trunk-override mechanism — `beginNewActiveMovement` below persists the
   * base it used there, so a later `activeMovement()` call reconstructs the
   * SAME base rather than silently defaulting back to the repo's root trunk).
   *
   * Throws if this work area's worktree hasn't been set up yet (mirrors the
   * `{ exists: false }` case `workLocal()`/etc. return — see this work
   * area's own doc comment on how it's constructed for the exact
   * precondition).
   */
  activeMovement(): Promise<CheckedOutMovement>;

  /**
   * Creates `branch` (off `opts.from`'s ref, defaulting to `base.branch`),
   * checks it out into this work area's own worktree (replacing whatever was
   * checked out there before — real git allows exactly one branch checked
   * out per worktree), and returns it as the new `activeMovement()`.
   *
   * `opts.base` is required if `opts.from` is a bare `CommitRef` or omitted
   * entirely. If `opts.from` is a `Movement`, `base` defaults to
   * `opts.from.base` — branching off a movement does NOT make the new
   * movement's base equal to the old movement's branch; it inherits the same
   * base the old one had (design doc §4.2).
   */
  beginNewActiveMovement(
    branch: string,
    opts?: { from?: Movement | CommitRef; base?: Trunk },
  ): Promise<CheckedOutMovement>;

  /**
   * Clears this work area's currently-checked-out branch's persisted base-
   * trunk override — both mechanisms `activeMovement()`'s base resolution can
   * read from (the repo-level `setMovementBase` key, and the
   * `--worktree`-scoped write it falls back to for a wing whose base was
   * persisted before that key existed), so a later `activeMovement()` call
   * falls through to the sane remote-default behavior instead of resurrecting
   * a stale value from that fallback. Delegates to the same logic
   * `beginNewActiveMovement` uses to persist a base in the first place; there
   * is no equivalent "set an explicit empty base" — this is the one place
   * that clears rather than sets.
   */
  clearActiveMovementBase(): Promise<void>;
}

/**
 * `privateLocal`'s new shape — ephemeral by design (design doc §4.2/§4.5):
 * no base, no merge target, no origin. It IS a real local git repository
 * (real commits, real branches, real history you can move around in) — it
 * just has nothing attached to publish to, and no long-lived-history
 * expectation. "No base, no merge" describes what's absent relative to
 * `Movement` (nothing to rebase onto, nothing to land anywhere), not an
 * absence of git semantics generally.
 */
export interface Scratchpad {
  /**
   * A real working-tree view of whatever branch is currently checked out —
   * same caveat as `Movement.files`/`Mirror.files` (see `MutableDirectoryLike`'s
   * own doc comment in `port/types.ts`): at runtime this is the same
   * `Worktree` object those use, so its full raw git surface (including
   * `push`/`fetch`/`pull`) is technically reachable through a cast. That's an
   * established, accepted deviation elsewhere in this codebase, not something
   * unique to `Scratchpad` — and it's inert here regardless, since every
   * `Scratchpad`'s backing bare repository is created via `Sandbox.initBare()`
   * with no remote (`BareRepository.url === null`), so even a cast-through
   * `push()` call has nothing to push to. `Scratchpad`'s OWN surface (this
   * interface) is the real boundary: it never exposes `push`/`fetch`/`pull`,
   * by design, not oversight.
   */
  readonly files: MutableDirectoryLike;

  /** Commits everything currently in `files` as a checkpoint; returns the new commit hash. */
  commit(message: string): Promise<string>;

  /**
   * Creates `name` at `opts?.from` (a branch name or commit sha), defaulting
   * to whatever's currently checked out, if `name` doesn't already exist —
   * idempotent, mirrors `BareRepository.createBranchIfMissing`. Does NOT
   * switch onto it; call `checkout()` afterward for that. Purely a local
   * ref-creation operation — no push, no remote involved, nothing to
   * coordinate with (this repo has no other writer, so there's no CAS
   * invariant to apply here the way there is for `Movement`/`Mirror`'s
   * shared-branch writes).
   */
  branch(name: string, opts?: { from?: string }): Promise<void>;

  /**
   * Switches `files` onto `name`, an already-existing branch (mirrors
   * `Worktree.switchBranch`, minus its fallback — see below). Call `branch()`
   * first to create `name` if it doesn't exist yet: this method verifies
   * `name` already exists and throws rather than falling through to
   * `switchBranch`'s own implicit-create fallback for a missing branch, whose
   * start point is adapter-dependent (real git branches from the current
   * checkout; this codebase's in-memory adapter branches from `main` — see
   * `WorkArea.beginNewActiveMovement()`'s doc comment, which avoids this
   * exact fallback for the same reason). This is an enforced precondition,
   * not just caller guidance — the whole point is that the two adapters must
   * never observably diverge for the same call.
   */
  checkout(name: string): Promise<void>;

  /**
   * Hard-resets the currently checked-out branch to `ref` (a commit sha or
   * branch name), discarding every commit after it — mirrors
   * `Worktree.resetTo`. A REAL discard: once nothing else in this repo
   * references the discarded commits, the branch tip no longer reaches them,
   * so they're unreachable and eligible for `git gc` to reclaim, not merely
   * hidden behind a moved pointer. This is the "go back to an earlier point
   * and keep going" operation the human's "backtrack" request asks for; for
   * "go back to nothing at all," use `reset()` instead.
   */
  backtrack(ref: string): Promise<void>;

  /**
   * Discards all history/content — matches the "next usage starts empty"
   * workflow. Implemented as: delete every file, commit that empty state (if
   * anything needed deleting), then build a genuinely PARENTLESS commit with
   * the same (now-empty) tree via `commitTree(..., [], ...)` and hard-reset
   * the branch to it — the prior commits become unreachable from the branch
   * tip, so a real git gc will eventually reclaim them, not just leave an
   * empty working tree with old history still attached.
   */
  reset(): Promise<void>;
}
