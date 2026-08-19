/**
 * GitOperations Command Wrapper
 *
 * Provides a high-level interface for executing git commands.
 * Used by DiskBareRepository and DiskWorktree.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { join, isAbsolute } from "path";
import { KeyedQueue } from "@minions/scheduling";
import type { MergeResult, RebaseResult, RebaseOptions, CloneAuth, GitRef } from "../../port/types.js";

const execFileAsync = promisify(execFile);

/**
 * Matches the errors git reports when a loose-object write is blocked on
 * Windows. Two distinct root causes, both content-addressed so both are safe
 * to fix by deleting the stray file and letting git recreate it identically
 * (see docs/design/movement-trunk-safety-redesign.md §6 for the full
 * mechanism, root-caused against git's own `object-file.c` and Git for
 * Windows' `compat/mingw.c`):
 *
 * 1. **Read-only valid duplicate** ("... Permission denied"): a loose object
 *    file already sits at its final path, correct content, but marked
 *    read-only (git always writes them that way) or momentarily locked by
 *    an antivirus/indexer handle (NTFS delete-pending state) — Windows'
 *    rename-over-an-existing-file fails outright rather than replacing it.
 * 2. **Corrupt/truncated object** ("files 'X' and 'Y' differ in contents"):
 *    Windows' `rename()` can silently fall back to a non-atomic copy+delete
 *    (`MOVEFILE_COPY_ALLOWED`); if the writing process is killed mid-copy, a
 *    genuinely truncated object can be left at the final path. Since it's
 *    readable (not read-only), git's `check_collision()` reads and compares
 *    it against the freshly-written temp file, finds a mismatch, and reports
 *    THIS message instead — never "permission denied". `check_collision()`
 *    can also fail to even open the (transiently locked) destination for
 *    comparison, reported as "unable to open <path>".
 *
 * Either way, every later retry recomputes the identical content-addressed
 * hash, collides with the same stray file, and fails with the same message
 * forever — not transiently — until the stray file is removed.
 * `clearBlockedObjectFiles` below removes whichever stray file(s) either
 * message names. Kept as a fallback: a plain delay-and-retry for the case
 * where no object path was parseable from the error, or the block was
 * something else transient (e.g. antivirus/indexing briefly holding a
 * non-object file open, or `check_collision`'s "unable to open").
 *
 * 3. **Stale/held lockfile** ("cannot lock ref '...': Unable to create
 *    '<path>.lock': File exists"): git's OWN concurrency mechanism for every
 *    ref write (`branch -f`, `update-ref`, ...), not something-Windows
 *    specific in origin — but on Windows the exact same antivirus/indexer
 *    handle-holding behavior that produces case 1 above for objects can
 *    momentarily hold the `.lock` file itself, and a process that dies
 *    mid-write (killed, crashed, machine slept mid-operation) leaves a
 *    REAL stale `.lock` behind with nothing left to ever clean it up.
 *    Confirmed directly against real git: `git branch -f <name> <target>`
 *    against a repo with a pre-existing `refs/heads/<name>.lock` fails with
 *    exactly this message, unconditionally, until that file is gone —
 *    verified live as the cause of a production `movement merge` failure
 *    (`git branch -f main origin/main` → "couldn't set 'refs/heads/main'",
 *    clean/non-corrupting but requiring a manual retry every time). Unlike
 *    an object path (content-addressed, always safe to delete and let git
 *    recreate identically), a lock file is deleted here on the same
 *    optimistic assumption the object-path case already makes for this
 *    whole mechanism: by the time `withTransientWriteRetry` is retrying at
 *    all, the ORIGINAL git process that would have owned this lock has
 *    already exited (this process's own git invocation just failed and
 *    returned), so any lock file still present is provably not held by a
 *    still-running write from this exact command; it's either a stale
 *    leftover or another concurrent process's lock, both handled the same
 *    way every other ref-write concurrency conflict in this codebase is
 *    (see `updateRefIfUnchanged`/`pushRefCas`'s CAS retry loops) — a
 *    spurious clear here just means the next attempt (this one, immediately
 *    retried) re-races normally instead of dying on stale debris forever.
 *    Matched here via the trailing `unable to create '.*\.lock'`
 *    alternative below — NOT a bare `cannot lock ref` alternative (removed):
 *    git also uses `cannot lock ref '<ref>':` as the generic lead-in for an
 *    unrelated failure, a ref compare-and-swap VALUE mismatch ("is at X but
 *    expected Y", no lock file involved at all) — confirmed live as a
 *    production `movement merge`/`start` failure that this broader match
 *    used to misclassify as "safe to blindly retry," which is actively
 *    wrong: a CAS mismatch never clears by retrying the identical command,
 *    so every retry failed identically until a human intervened manually.
 *    That case now has its own precise, correct handling — see
 *    `pushThroughEmptyHalt`'s "already completed" tier — rather than being
 *    folded into this generic bucket.
 */
const TRANSIENT_WRITE_ERROR = /unable to write file|permission denied|error building trees|differ in contents|unable to open|unable to create '.*\.lock'/i;
const OBJECT_PATH = "[\\\\/]objects[\\\\/][0-9a-f]{2}[\\\\/][0-9a-f]{38}";
const BLOCKED_OBJECT_PATH = new RegExp(
  `unable to write file (.+?${OBJECT_PATH}): permission denied` +
    `|files '.+?' and '(.+?${OBJECT_PATH})' differ in contents`,
  "gi",
);
/** Matches git's generic lockfile-collision message for ANY ref/index write (`refs/heads/<name>.lock`, `index.lock`, `HEAD.lock`, `packed-refs.lock`, ...) — see case 3 above. */
const BLOCKED_LOCK_PATH = /unable to create '(.+?\.lock)': file exists/gi;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a git error message indicates one of the transient Windows write failures above. */
export function isTransientWriteError(message: string): boolean {
  return TRANSIENT_WRITE_ERROR.test(message);
}

/**
 * Removes any stray loose-object files or stale lock files the error message
 * names as blocked — whether by the read-only/locked-permission-denied
 * object path, the corrupt/differs-in-contents object path, or a stale ref/
 * index lockfile (see the doc comment above for all three). Returns true if
 * at least one was actually cleared, so the caller can retry immediately
 * instead of just waiting out a clock.
 */
export async function clearBlockedObjectFiles(message: string): Promise<boolean> {
  const objectPaths = [...message.matchAll(BLOCKED_OBJECT_PATH)].map((match) => match[1] ?? match[2]);
  const lockPaths = [...message.matchAll(BLOCKED_LOCK_PATH)].map((match) => match[1]);
  let clearedAny = false;
  for (const path of objectPaths) {
    try {
      // Loose objects are written read-only; clear that before unlinking.
      await fs.chmod(path, 0o666);
      await fs.unlink(path);
      clearedAny = true;
    } catch {
      // Already gone (git itself cleaned it up, or another retry already
      // cleared it), or a genuine permissions problem — either way, let
      // the next attempt (or the eventual thrown error) speak for itself.
    }
  }
  for (const path of lockPaths) {
    try {
      await fs.unlink(path);
      clearedAny = true;
    } catch {
      // Already gone, or a genuine permissions problem — same fallback as
      // above: let the next attempt (or the eventual thrown error) speak
      // for itself.
    }
  }
  return clearedAny;
}

async function withTransientWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= MAX_TRANSIENT_RETRIES || !isTransientWriteError(message)) {
        throw error;
      }
      const clearedStrayObjects = await clearBlockedObjectFiles(message);
      if (!clearedStrayObjects) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
}

/**
 * Resolves the on-disk location every git command against `repoPath`
 * actually contends on for object writes: for a linked worktree (a `.git`
 * *file* pointing at `<bare>.git/worktrees/<name>`), that's the shared bare
 * repo two levels up — not `repoPath` itself, since two different worktrees
 * of the same bare repo have different `repoPath`s but write into the exact
 * same `objects/` directory. Reads the `.git` file directly rather than
 * shelling out to `git rev-parse --git-common-dir`, so resolving the lock
 * key never itself needs a git process (and so it degrades gracefully, via
 * the catch below, before the repo even exists yet — e.g. during `init`).
 * For a bare repo or a plain non-worktree checkout (`.git` is a directory,
 * or missing entirely), `repoPath` already *is* the shared location.
 */
export async function resolveContentionKey(repoPath: string): Promise<string> {
  try {
    const gitFileContent = await fs.readFile(join(repoPath, ".git"), "utf-8");
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
    if (!match) return repoPath;
    const worktreeGitDir = match[1].trim();
    const gitDir = isAbsolute(worktreeGitDir) ? worktreeGitDir : join(repoPath, worktreeGitDir);
    return join(gitDir, "..", "..");
  } catch {
    return repoPath;
  }
}

/** How long a successful `fetch()` stays valid — see `GitCoordinationState.cachedFetch`. */
const FETCH_CACHE_TTL_MS = 2 * 60 * 1000;

interface FetchCacheEntry {
  /** Set while a real fetch is running; concurrent callers all await this same promise. */
  inFlight: Promise<void> | null;
  /** Wall-clock time (ms) the last fetch actually completed, or null if none has, or the last one was force-invalidated. */
  completedAt: number | null;
}

/**
 * One scoped ref's generation-coalesced fetch state — see
 * `GitCoordinationState.fetchRefSinceGeneration`, the design doc §3.4
 * primitive. `generation` is a monotonic counter local to this process (not
 * a real git concept): it increments once per *actually completed* fetch of
 * this ref, so "newer than generation G I last saw" is a precise, cheap
 * comparison instead of a time-based freshness guess.
 */
interface RefGenerationEntry {
  generation: number;
  /** Set while a real scoped fetch is running for this ref. `targetGeneration`
   *  is the generation this in-flight fetch will produce once it completes —
   *  a concurrent caller asking for "newer than G" joins this instead of
   *  starting its own fetch whenever `targetGeneration > G`, even if it
   *  can't yet see the fetch having completed. */
  inFlight: { promise: Promise<number>; targetGeneration: number } | null;
}

/**
 * All the process-lifetime (not call-lifetime, not per-worktree-object)
 * state that governs how git subprocesses against a shared bare repo
 * contend with each other: the write-serialization queues and the fetch
 * cache. Deliberately a real object, not module-scope `Map`s — every
 * `GitOperations` instance (and, through it, every `Worktree`/
 * `BareRepository`) needs to agree on the *same* instance to actually
 * serialize/coalesce against each other, and giving that shared state an
 * explicit owner (rather than hiding it in this module's closure) is what
 * lets a long-lived host process — the cabinet — own exactly one instance
 * as a first-class part of its own object graph, construct it once at
 * startup, and hand it down through every `Sandbox`/`Lair`/`Worktree` it
 * creates, the same way it already owns e.g. its per-wing quality watchers.
 *
 * `defaultGitCoordinationState` below is a module-level instance used by
 * every disk adapter constructor that isn't handed one explicitly — this
 * keeps every existing caller (tests, other apps, scripts) working
 * unchanged; only a caller that wants its own explicit, inspectable
 * instance (the cabinet) needs to construct and thread one through.
 */
export class GitCoordinationState {
  private readonly contentionKeyCache = new Map<string, Promise<string>>();
  private readonly repoQueue = new KeyedQueue();
  private readonly worktreeQueue = new KeyedQueue();
  private readonly applyQueue = new KeyedQueue();
  private readonly fetchCache = new Map<string, FetchCacheEntry>();
  private readonly refGenerationCache = new Map<string, RefGenerationEntry>();

  private getContentionKey(repoPath: string): Promise<string> {
    let cached = this.contentionKeyCache.get(repoPath);
    if (!cached) {
      cached = resolveContentionKey(repoPath);
      this.contentionKeyCache.set(repoPath, cached);
    }
    return cached;
  }

  /**
   * Serializes every git command against the same shared repo (see
   * `resolveContentionKey`) within this process — the cabinet backend itself
   * is a heavy source of concurrent git subprocesses against one shared bare
   * repo (status polling, the quality watcher, movement commit/merge, other
   * wings' background activity, ...), and eliminating cabinet's own
   * contribution to that contention is the one lever available in-process.
   * A `KeyedQueue` per contention key, not a global lock: unrelated repos (a
   * different lair, a different bare repo entirely) never wait on each other,
   * and one failed git command never wedges every later command against the
   * same repo (`KeyedQueue` already swallows a failed run's rejection before
   * chaining the next one behind it).
   */
  async withRepoSerialization<T>(repoPath: string, run: () => Promise<T>): Promise<T> {
    const key = await this.getContentionKey(repoPath);
    return this.repoQueue.run(key, run);
  }

  /**
   * Serializes every git command issued against this exact worktree/repo
   * *directory* (not the resolved contention key — see `withRepoSerialization`)
   * relative to every other command issued against that same directory. This
   * is the first, finer-grained gate every write goes through; `exec`/
   * `execWithStdin` additionally nest `withRepoSerialization` inside it for
   * commands that can name a ref another worktree might also touch.
   * `commitAll` is the one write whose surface is proven worktree-private (its
   * own index + its own checked-out branch — never another worktree's, since
   * git refuses to check the same branch out twice — plus the shared,
   * content-addressed object store, safe to write from many worktrees at
   * once), so it uses *only* this gate: two different worktrees can now commit
   * fully in parallel instead of queueing behind one lair-wide FIFO, while
   * still never overlapping a rebase/checkout/reset of their own worktree
   * (those go through this same per-worktree gate too, via exec/execWithStdin).
   */
  async withWorktreeSerialization<T>(repoPath: string, run: () => Promise<T>): Promise<T> {
    return this.worktreeQueue.run(repoPath, run);
  }

  /**
   * Whole-attempt exclusivity for `Mirror.apply()` against one mirror
   * worktree — a DIFFERENT, coarser gate than `withWorktreeSerialization`
   * above, and deliberately backed by its own `KeyedQueue` rather than reused
   * against the same map. `apply()`'s full sequence (ensure/create the
   * worktree, sync to trunk tip, run the transform against real files on
   * disk, `isDirty`, `commitAll`, CAS-push, and on a lost race, loop) is NOT
   * safe to run as two interleaved attempts against the same worktree
   * directory even though every individual git subprocess call inside it is
   * already serialized via `withWorktreeSerialization` — the transform's own
   * file writes are plain filesystem operations that hold no git-level lock
   * at all, and `withWorktreeSerialization` only ever guards one command at a
   * time, not the gap between two commands. This is exactly chunk 4's
   * historical hazard shape (see design doc's implementation progress
   * journal and the movement-trunk-safety-redesign.md investigation this
   * method resolves): a multi-step sequence run by two concurrent callers
   * against a shared worktree, serialized only command-by-command, not as one
   * atomic unit. `commitAll` internally acquires `withWorktreeSerialization`
   * for the SAME worktree path — nesting that call inside a `run()` on the
   * SAME `KeyedQueue` instance (same map) would deadlock (a queued call for a
   * key waits on that key's own prior tail, which here would be itself, since
   * the outer call is still "in flight" on that same queue). Using a
   * genuinely separate `KeyedQueue` (`applyQueue`, its own `Map`) avoids that
   * — this gate and `withWorktreeSerialization`'s gate are independent locks
   * that happen to nest safely because they're never the same queue.
   *
   * Keyed by the mirror's own worktree directory path (not the bare repo's
   * path) — two `Mirror` handles for the SAME mirror branch (e.g. two
   * separately-constructed `trunk.mirror('plan')` calls, or, post
   * plan/conductor consolidation, a plan-shaped and a conductor-shaped
   * `apply()` sharing one worktree) resolve to the identical worktree path
   * and therefore the identical queue key, even though they're different
   * `Mirror`/`GitOperations` object instances.
   */
  async withMirrorApplySerialization<T>(worktreePath: string, run: () => Promise<T>): Promise<T> {
    return this.applyQueue.run(worktreePath, run);
  }

  /**
   * Coalesces and caches `git fetch` per shared bare repo. Two motivations,
   * both from the same root cause: fetch only ever updates remote-tracking
   * refs (`refs/remotes/origin/*`), which are shared by every worktree of one
   * bare repo, so (a) two concurrent fetches for the same repo are redundant
   * network + lock work, not independent operations, and (b) `movement start`/
   * `merge`/`absorbPlan`/`promote` each fetch on every call, so a tight loop of
   * those (including the retry storms a client-side timeout provokes) was
   * hammering origin for state that can't have meaningfully changed between
   * calls a few seconds apart.
   *
   * A successful fetch is treated as fresh for `FETCH_CACHE_TTL_MS` — real
   * staleness against origin is unavoidable regardless (another machine can
   * always have pushed since our last fetch; only `git push`'s own
   * fast-forward check is the actual serialization point, not how recently we
   * fetched), so caching a *known-recent* fetch for a couple of minutes trades
   * a little more of that same unavoidable staleness for a lot less redundant
   * traffic. `force: true` bypasses the cache (but still joins a fetch already
   * in flight) — use it whenever the caller has a concrete reason to believe
   * the cached view is stale, e.g. right before retrying after a rejected push.
   */
  async cachedFetch(repoPath: string, doFetch: () => Promise<void>, force: boolean): Promise<void> {
    const key = await this.getContentionKey(repoPath);
    const existing = this.fetchCache.get(key);
    const entry: FetchCacheEntry = existing ?? { inFlight: null, completedAt: null };
    if (!existing) this.fetchCache.set(key, entry);

    if (entry.inFlight) return entry.inFlight;

    if (!force && entry.completedAt !== null && Date.now() - entry.completedAt < FETCH_CACHE_TTL_MS) {
      return;
    }

    const promise = doFetch()
      .then(
        () => {
          entry.completedAt = Date.now();
        },
        (error: unknown) => {
          // A forced fetch failing means the caller already knew the cached
          // view was stale — don't let a stale-but-not-yet-expired
          // `completedAt` paper over that for the next (non-forced) caller.
          if (force) entry.completedAt = null;
          throw error;
        }
      )
      .finally(() => {
        entry.inFlight = null;
      });
    entry.inFlight = promise;
    return promise;
  }

  /**
   * The generation-coalesced, single-ref fetch primitive described in design
   * doc §3.4, meant for `Movement.merge()`/`Mirror.apply()`-shaped CAS-retry
   * loops (design doc §3.2-3.3: optimistic first attempt, never fetching
   * until an actual push rejection, then a *scoped* fetch of just the one
   * rejected ref) — see `libs/file-store/src/adapters/disk/PublishRetry.ts`,
   * which drives this. Deliberately separate from `cachedFetch` above (a
   * whole-repo, time-boxed cache used by callers — `MovementManager`,
   * `fullSync` — that don't go through the Sandbox-layer types this method
   * serves): a real retry loop doesn't want "fresh within the last two
   * minutes," it wants "strictly newer than the exact tip I built my failed
   * attempt against," which only a monotonic generation counter can answer
   * precisely. `force: true`-vs-not on that TTL cache approximates this by
   * re-fetching unconditionally on every retry, which is exactly the "N
   * concurrent retrants each force their own fetch" problem this method
   * exists to fix: a caller here declares the generation it last saw, and
   * joins whichever fetch (in-flight or already complete) first clears that
   * bar, real network calls or not.
   *
   * @param ref The single ref to fetch — never a full multi-branch fetch.
   * @param sinceGeneration The caller's last-seen generation for this ref.
   *   Returns immediately, with no network call, if the cache already knows
   *   about something newer than this.
   * @param doFetch Performs the actual scoped `git fetch origin <ref>`.
   * @returns The generation now known for this ref (always `> sinceGeneration`
   *   whenever a fetch actually had to run; may equal a still-in-flight
   *   fetch's target generation if this call joined rather than triggered).
   */
  async fetchRefSinceGeneration(
    repoPath: string,
    ref: string,
    sinceGeneration: number,
    doFetch: () => Promise<void>,
  ): Promise<number> {
    const contentionKey = await this.getContentionKey(repoPath);
    const key = `${contentionKey}::${ref}`;
    const existing = this.refGenerationCache.get(key);
    const entry: RefGenerationEntry = existing ?? { generation: 0, inFlight: null };
    if (!existing) this.refGenerationCache.set(key, entry);

    if (entry.generation > sinceGeneration) return entry.generation;
    if (entry.inFlight && entry.inFlight.targetGeneration > sinceGeneration) return entry.inFlight.promise;

    const targetGeneration = entry.generation + 1;
    const promise = doFetch().then(
      () => {
        // Another, later fetch may have already landed a higher generation
        // (e.g. this fetch was slow and got superseded) — never move the
        // counter backwards.
        entry.generation = Math.max(entry.generation, targetGeneration);
        return entry.generation;
      },
      (error: unknown) => {
        throw error;
      },
    ).finally(() => {
      if (entry.inFlight?.targetGeneration === targetGeneration) entry.inFlight = null;
    });
    entry.inFlight = { promise, targetGeneration };
    return promise;
  }

  /**
   * The generation this process currently believes is fresh for `ref`,
   * without triggering a fetch — 0 if nothing has ever been fetched here.
   * Used as the starting `sinceGeneration` for an optimistic first attempt
   * (design doc §3.2), which itself never calls this — only the retry path,
   * after a rejection, needs to know what it's asking to beat.
   */
  async refGeneration(repoPath: string, ref: string): Promise<number> {
    const contentionKey = await this.getContentionKey(repoPath);
    const key = `${contentionKey}::${ref}`;
    return this.refGenerationCache.get(key)?.generation ?? 0;
  }
}

/**
 * Process-wide default, used by every disk adapter that isn't explicitly
 * handed a `GitCoordinationState` — see that class's doc for why a host
 * process (the cabinet) would want to construct and thread through its own
 * instance instead.
 */
export const defaultGitCoordinationState = new GitCoordinationState();

/**
 * Subcommands (and the specific invocation shapes, where a subcommand can be
 * either) that only ever read — never write an object, ref, or index. These
 * are also the highest-volume calls (status polling, branch/HEAD checks,
 * diffing) made constantly by every wing sharing this lair's bare repo, so
 * routing them through the same per-repo write queue as commit/merge/fetch
 * would serialize the entire lair's read traffic behind one FIFO for no
 * contention-safety benefit — that queue backing up is what turned into
 * user-visible timeouts. Unrecognized or ambiguous invocations still
 * serialize (the safe default); only shapes confirmed read-only here skip it.
 */
function isReadOnlyGitCommand(args: string[]): boolean {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "rev-parse":
    case "status":
    case "log":
    case "diff":
    case "show":
    case "merge-base":
      return true;
    case "branch":
      return rest.includes("--list") || rest.includes("--show-current");
    case "worktree":
      return rest[0] === "list";
    case "config":
      return rest.includes("--get");
    case "symbolic-ref":
      // Reading a ref takes exactly one argument (the ref name); setting one
      // takes two (ref name + target).
      return rest.length === 1;
    default:
      return false;
  }
}

/**
 * Builds an authenticated git URL from a regular URL and auth credentials.
 *
 * For GitHub:
 * - https://github.com/user/repo.git -> https://oauth2:TOKEN@github.com/user/repo.git
 *
 * For Bitbucket:
 * - https://bitbucket.org/user/repo.git -> https://USERNAME:TOKEN@bitbucket.org/user/repo.git
 *
 * For other hosts:
 * - Uses username:token format if username provided, otherwise oauth2:token
 */
function buildAuthenticatedUrl(url: string, auth: CloneAuth): string {
  const parsed = new URL(url);

  // Bitbucket requires username, others can default to oauth2
  const username = auth.username ?? "oauth2";
  parsed.username = username;
  parsed.password = auth.token;

  return parsed.toString();
}

/**
 * Wrapper for executing git commands in a specific directory.
 */
export class GitOperations {
  constructor(
    private repoPath: string,
    private readonly coordination: GitCoordinationState = defaultGitCoordinationState,
  ) {}

  /**
   * Name of the throwaway branch the bare repository's HEAD is pointed at,
   * instead of at a real branch like `main`. A bare repo counts as git's
   * "main worktree" for worktree bookkeeping purposes, so whatever branch its
   * HEAD points to is considered checked out there — if that were `main`,
   * every later `git worktree add <wing-path> main` would fail with
   * `'main' is already used by worktree at '<bare repo path>'`. This branch
   * exists solely to give HEAD somewhere to point: created once off the
   * remote's default branch tip, never moved or tracked afterwards, and safe
   * to ignore in tooling and by humans browsing branch lists.
   */
  private static readonly HEAD_ANCHOR_BRANCH = "_bare-head";

  // ========================================
  // Repository Initialization
  // ========================================

  /**
   * Initializes a new git repository.
   */
  async init(bare = false): Promise<void> {
    // For bare repos, we need to create the directory first
    const { promises: fs } = await import("fs");
    await fs.mkdir(this.repoPath, { recursive: true });

    await this.exec(bare ? ["init", "--bare"] : ["init"]);
  }

  /**
   * Clones a remote into a bare repository using remote-tracking refs.
   *
   * `git clone --bare` copies every remote branch into the bare repo's local
   * refs/heads/* as non-tracking branches and creates no remote-tracking refs,
   * littering the repo with stale local branches that never follow origin.
   *
   * Instead we init an empty bare repo, add the remote (which installs the
   * standard `+refs/heads/*:refs/remotes/origin/*` fetch refspec), and fetch —
   * so all branches land in refs/remotes/origin/*. We then create local
   * tracking branches only for the branches the system actually uses — the
   * remote's default branch (also pointed at by HEAD, so new worktree branches
   * have a base and the movement workflow's `main` exists) and `plan/main` if
   * the remote has it (so plan worktrees check out plan content, not the
   * default branch's tree). Every other branch stays a remote-tracking ref.
   *
   * @param url - Git repository URL
   * @param auth - Optional authentication credentials for private repos
   * @returns The remote's default branch name, or null if the remote is empty
   */
  async cloneBare(url: string, auth?: CloneAuth): Promise<string | null> {
    await fs.mkdir(this.repoPath, { recursive: true });

    const remoteUrl = auth ? buildAuthenticatedUrl(url, auth) : url;

    await this.exec(["init", "--bare"]);
    // `git remote add` installs fetch = +refs/heads/*:refs/remotes/origin/*,
    // so fetched branches become remote-tracking refs, not local heads.
    await this.exec(["remote", "add", "origin", remoteUrl]);
    await this.exec(["fetch", "origin"]);

    const defaultBranch = await this.detectRemoteDefaultBranch();
    if (defaultBranch) {
      // One local branch that tracks origin — no per-remote-branch litter.
      await this.createTrackingBranch(defaultBranch);
      // Point HEAD at the anchor branch, not at the tracking branch itself —
      // see HEAD_ANCHOR_BRANCH.
      await this.ensureHeadAnchor(`refs/remotes/origin/${defaultBranch}`);
    }

    // The plan workflow keeps its tree on a dedicated plan/main branch; create
    // a local tracking branch for it when present so plan worktrees branch from
    // the right ref rather than HEAD.
    if (defaultBranch !== "plan/main") {
      const remotes = await this.remoteBranches();
      if (remotes.includes("plan/main")) {
        await this.createTrackingBranch("plan/main");
      }
    }

    return defaultBranch;
  }

  /**
   * Creates a local branch that tracks its origin counterpart.
   */
  private async createTrackingBranch(branch: string): Promise<void> {
    await this.exec(["branch", "--track", branch, `refs/remotes/origin/${branch}`]);
  }

  /**
   * Points this bare repository's HEAD at HEAD_ANCHOR_BRANCH, creating it
   * (at `ref`) if it doesn't already exist. Never moves the anchor once
   * created — it is deliberately untracked and static, so it never competes
   * with a real branch for a worktree checkout slot.
   */
  private async ensureHeadAnchor(ref: string): Promise<void> {
    await this.createBranchIfMissing(GitOperations.HEAD_ANCHOR_BRANCH, ref);
    await this.exec(["symbolic-ref", "HEAD", `refs/heads/${GitOperations.HEAD_ANCHOR_BRANCH}`]);
  }

  /**
   * Heals a bare repo cloned the old way (`git clone --bare`, which created a
   * non-tracking local branch per remote branch) *and* a repo that was cloned
   * before the tracking-branch step existed at all, so it has no local `main`
   * (or `plan/main`) branch whatsoever. Records the origin HEAD symref,
   * creates the kept branches (base + plan/main) when missing or sets upstream
   * tracking on them when they already exist, and deletes the leftover local
   * mirror branches that origin already contains.
   *
   * Safe and idempotent: a branch is deleted only when origin contains all its
   * commits (so nothing is lost — the content survives in refs/remotes/origin/*)
   * and it is not checked out in any worktree. A repo cloned the new way has no
   * mirror branches to delete and already has its kept branches, so this is a
   * no-op there.
   *
   * @returns The names of the local branches that were deleted
   */
  async normalizeLocalBranches(): Promise<string[]> {
    // A `git clone --bare` repo has no fetch refspec and no remote-tracking
    // refs at all. Install the standard refspec and fetch so refs/remotes/
    // origin/* exist — that's what tells us which local heads are mirrors.
    // Best-effort: offline / no-remote repos simply yield no mirrors to prune.
    try {
      await this.exec([
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      await this.exec(["fetch", "origin"]);
    } catch {
      // No remote or offline — proceed with whatever refs already exist.
    }

    // Record origin/HEAD if missing (best-effort; needs network for legacy repos).
    try {
      await this.exec(["remote", "set-head", "origin", "--auto"]);
    } catch {
      // Offline or no remote — baseBranch() still falls back below.
    }

    const base = await this.baseBranch();
    const keep = new Set([base, "plan/main"]);
    const remoteSet = new Set(await this.remoteBranches());

    // Ensure the kept branches exist locally and track origin. A repo can be
    // missing them entirely (provisioned before the tracking-branch step
    // existed) or have them as non-tracking heads (`git clone --bare` litter)
    // — either way, end up with a local branch tracking origin/<branch>.
    const localSet = new Set(await this.branches());
    for (const branch of keep) {
      if (!remoteSet.has(branch)) continue;
      if (!localSet.has(branch)) {
        try {
          await this.createTrackingBranch(branch);
        } catch {
          // Best-effort; leave for the caller to retry.
        }
        continue;
      }
      try {
        await this.exec(["branch", `--set-upstream-to=origin/${branch}`, branch]);
      } catch {
        // Already tracking or otherwise unsettable; not fatal.
      }
    }

    // Repos cloned the old way (or before the anchor-branch step existed)
    // have HEAD pointing straight at `base`, which blocks `git worktree add`
    // for that branch (see HEAD_ANCHOR_BRANCH). Move HEAD off of it.
    try {
      const anchorRef = remoteSet.has(base)
        ? `refs/remotes/origin/${base}`
        : localSet.has(base)
          ? `refs/heads/${base}`
          : null;
      if (anchorRef) {
        await this.ensureHeadAnchor(anchorRef);
      }
    } catch {
      // Best-effort; leave for the caller to retry.
    }

    // Branches checked out in a worktree must never be deleted.
    const checkedOut = new Set((await this.worktreeList()).map((w) => w.branch));

    const deleted: string[] = [];
    for (const branch of await this.branches()) {
      if (keep.has(branch) || checkedOut.has(branch)) continue;
      // Only consider local branches that mirror an origin branch — never
      // touch branches that exist solely on this machine.
      if (!remoteSet.has(branch)) continue;
      // Delete only when origin already contains every commit on the local
      // branch (ancestor-or-equal); keep anything ahead of / diverged from origin.
      try {
        await this.exec(["merge-base", "--is-ancestor", branch, `origin/${branch}`]);
      } catch {
        continue;
      }
      try {
        await this.exec(["branch", "-D", branch]);
        deleted.push(branch);
      } catch {
        // e.g. unexpectedly checked out — skip rather than fail the whole sweep.
      }
    }

    return deleted;
  }

  /**
   * Git config key (read/written with `--worktree`) holding a per-worktree
   * trunk override — see `setBaseBranch`/`baseBranch`.
   */
  private static readonly TRUNK_OVERRIDE_KEY = "minions.trunk-branch";

  /**
   * Resolves the repository's integration ("base") branch — the branch that
   * movements rebase onto and merge into.
   *
   * Checks this worktree's own persisted override first (see `setBaseBranch`)
   * — set once, it wins over remote-default detection until explicitly
   * cleared, and needs no network access to read. Falls back to the remote's
   * default branch (from `refs/remotes/origin/HEAD`) when no override is set,
   * so unmodified worktrees keep working on any repo regardless of whether
   * its default branch is named `main`, `master`, `develop`, etc.
   */
  async baseBranch(remote = "origin"): Promise<string> {
    const override = await this.getWorktreeConfigValue(GitOperations.TRUNK_OVERRIDE_KEY);
    if (override) return override;

    try {
      const result = await this.exec(["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const ref = result.stdout.trim();
      const prefix = `refs/remotes/${remote}/`;
      if (ref.startsWith(prefix)) {
        return ref.slice(prefix.length);
      }
    } catch {
      // Symref not recorded; establish or derive it below.
    }
    return (await this.detectRemoteDefaultBranch(remote)) ?? "main";
  }

  /**
   * Sets (or, with `null`, clears) this worktree's persisted trunk override —
   * the branch `baseBranch()` reports for THIS worktree specifically, until
   * changed again. Stored via `git config --worktree`, which is per-linked-
   * worktree config (unlike ordinary `git config`, which is shared by the
   * whole repository) — this is what lets one worktree track an experiment
   * branch while every other worktree on the same bare repo keeps tracking
   * the remote's real default branch. `extensions.worktreeConfig` is enabled
   * lazily (idempotent) on first write so the per-worktree config file exists.
   */
  async setBaseBranch(branch: string | null): Promise<void> {
    await this.setWorktreeConfigValue(GitOperations.TRUNK_OVERRIDE_KEY, branch);
  }

  /**
   * Shared read/write helpers behind `setBaseBranch`/`baseBranch` — a simple
   * string persisted via `git config --worktree`, which needs
   * `extensions.worktreeConfig` enabled (lazily, idempotently) on first write.
   */
  private async getWorktreeConfigValue(key: string): Promise<string | null> {
    try {
      const result = await this.exec(["config", "--worktree", "--get", key]);
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * The key `getMovementBase`/`setMovementBase` read/write under —
   * `movement.<branch>.base`, an ordinary (non-`--worktree`-scoped)
   * repo-level git config entry, shared by every worktree of this repo (and
   * readable with no worktree checked out at all). `<branch>` is git config's
   * "subsection" (the middle segment, between the outer two dots) rather than
   * the final key segment specifically because subsections may contain any
   * character (including `/` and `.`, both common in real branch names —
   * `wip/foo`, `release/1.0`) while a final key segment may not (git rejects
   * `movement.base.<branch>` outright once `<branch>` contains a `/`, e.g.
   * `error: invalid key`, confirmed directly against real git before picking
   * this shape) — see docs/design/movement-trunk-safety-redesign.md §4.2.
   */
  private static movementBaseKey(branch: string): string {
    return `movement.${branch}.base`;
  }

  /**
   * Reads `branch`'s persisted base-trunk override from ordinary
   * (non-`--worktree`-scoped) repo-level git config — see `movementBaseKey`.
   * Returns null if never set.
   */
  async getMovementBase(branch: string): Promise<string | null> {
    return this.getConfigValue(GitOperations.movementBaseKey(branch));
  }

  /**
   * Sets (or, with `null`, clears) `branch`'s persisted base-trunk override —
   * the write side of `getMovementBase`. Deliberately does NOT touch
   * `extensions.worktreeConfig` or write with `--worktree` — this is ordinary
   * repo-level config, shared by every worktree of this repo, not scoped to
   * whichever worktree happens to be running the write.
   */
  async setMovementBase(branch: string, base: string | null): Promise<void> {
    await this.setConfigValue(GitOperations.movementBaseKey(branch), base);
  }

  /** Shared read helper behind `getMovementBase` — ordinary (non-`--worktree`) `git config --get`. */
  private async getConfigValue(key: string): Promise<string | null> {
    try {
      const result = await this.exec(["config", "--get", key]);
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Shared write helper behind `setMovementBase` — ordinary (non-`--worktree`) `git config`/`--unset`. */
  private async setConfigValue(key: string, value: string | null): Promise<void> {
    if (value === null) {
      try {
        await this.exec(["config", "--unset", key]);
      } catch {
        // Already unset — nothing to do.
      }
      return;
    }
    await this.exec(["config", key, value]);
  }

  private async setWorktreeConfigValue(key: string, value: string | null): Promise<void> {
    if (value === null) {
      try {
        await this.exec(["config", "--worktree", "--unset", key]);
      } catch {
        // Already unset — nothing to do.
      }
      return;
    }
    let justEnabled = false;
    try {
      const before = await this.exec(["config", "--get", "extensions.worktreeConfig"]).catch(() => ({ stdout: "" }));
      justEnabled = before.stdout.trim() !== "true";
      await this.exec(["config", "extensions.worktreeConfig", "true"]);
    } catch {
      // Unsettable in this environment — proceed anyway; the config write
      // below will surface any real problem.
    }
    if (justEnabled) {
      await this.migrateExistingWorktreesForWorktreeConfig();
    }
    await this.exec(["config", "--worktree", key, value]);
  }

  /**
   * Documented git gotcha: turning on `extensions.worktreeConfig` makes
   * per-worktree config files authoritative for `core.bare`/`core.worktree`,
   * but existing linked worktrees (created before this flag was set) never
   * get that per-worktree override written automatically. Left alone, the
   * shared config's `core.bare=true` (correct for the bare repo itself)
   * silently applies to every one of its worktrees too — including ones
   * having nothing to do with the worktree that enabled the flag — and every
   * git command run in them starts failing with "this operation must be run
   * in a work tree". Enumerate every worktree of this repo (not just the
   * current one — this setting is repo-wide, so the blast radius is too) and
   * write the correct per-worktree override into each.
   */
  private async migrateExistingWorktreesForWorktreeConfig(): Promise<void> {
    let listing: string;
    try {
      listing = (await this.exec(["worktree", "list", "--porcelain"])).stdout;
    } catch {
      return;
    }
    const paths = listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
    for (const path of paths) {
      try {
        await this.exec(["-C", path, "config", "--worktree", "core.bare", "false"]);
      } catch {
        // Best-effort — a worktree that can't be migrated surfaces its own
        // failure the next time something touches it directly.
      }
    }
  }

  /**
   * Determines the remote's default branch name (without the `origin/` prefix).
   * Falls back to `main`, then `master`, then the first remote branch.
   */
  async detectRemoteDefaultBranch(remote = "origin"): Promise<string | null> {
    try {
      await this.exec(["remote", "set-head", remote, "--auto"]);
      const result = await this.exec(["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
      const ref = result.stdout.trim();
      const prefix = `refs/remotes/${remote}/`;
      if (ref.startsWith(prefix)) {
        return ref.slice(prefix.length);
      }
    } catch {
      // set-head can fail (e.g. detached remote HEAD); fall back to scanning.
    }

    const remotes = await this.remoteBranches(remote);
    if (remotes.includes("main")) return "main";
    if (remotes.includes("master")) return "master";
    return remotes[0] ?? null;
  }

  /**
   * Lists remote-tracking branch names for a remote (without the `origin/`
   * prefix), excluding the symbolic `HEAD` entry.
   */
  async remoteBranches(remote = "origin"): Promise<string[]> {
    try {
      const result = await this.exec([
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/remotes/${remote}`,
      ]);
      const prefix = `${remote}/`;
      return result.stdout
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean)
        .map((b) => (b.startsWith(prefix) ? b.slice(prefix.length) : b))
        .filter((b) => b !== "HEAD");
    } catch {
      return [];
    }
  }

  /**
   * Clones a repository with optional branch specification.
   *
   * @param url - Git repository URL
   * @param targetPath - Local path to clone into
   * @param branch - Optional branch to check out
   * @param auth - Optional authentication credentials for private repos
   * @returns The actual branch that was checked out
   */
  async cloneWithBranch(
    url: string,
    targetPath: string,
    branch?: string,
    auth?: CloneAuth
  ): Promise<string> {
    const cloneUrl = auth ? buildAuthenticatedUrl(url, auth) : url;
    const args = ["clone", ...(branch ? ["--branch", branch] : []), cloneUrl, targetPath];
    // Clone command runs from parent context (no repo yet at targetPath).
    await execFileAsync("git", args);

    // Return the actual branch that was checked out
    const git = new GitOperations(targetPath);
    return await git.currentBranch();
  }

  // ========================================
  // Worktree Management
  // ========================================

  /**
   * Adds a new worktree.
   */
  async worktreeAdd(path: string, branch: string): Promise<void> {
    // First check if branch exists
    const branches = await this.branches();
    if (branches.includes(branch)) {
      await this.exec(["worktree", "add", path, branch]);
    } else {
      // Create new branch with worktree
      await this.exec(["worktree", "add", "-b", branch, path]);
    }
  }

  /**
   * Adds a new worktree without checking out files (--no-checkout).
   * Used as the first step for sparse-checkout worktrees.
   */
  async worktreeAddNoCheckout(path: string, branch: string): Promise<void> {
    const branches = await this.branches();
    if (branches.includes(branch)) {
      await this.exec(["worktree", "add", "--no-checkout", path, branch]);
    } else {
      await this.exec(["worktree", "add", "--no-checkout", "-b", branch, path]);
    }
  }

  /**
   * Configures sparse-checkout (cone mode) for the given subdirectory and
   * performs a checkout. Must be called from within the worktree directory
   * (i.e. this GitOperations instance must point at the worktree path).
   *
   * @param subdir - Repository-relative path to the directory to check out
   */
  async sparseCheckoutSet(subdir: string): Promise<void> {
    await this.exec(["sparse-checkout", "init", "--cone"]);
    await this.exec(["sparse-checkout", "set", subdir]);
    await this.exec(["checkout"]);
  }

  /**
   * Removes a worktree.
   */
  async worktreeRemove(path: string): Promise<void> {
    await this.exec(["worktree", "remove", path, "--force"]);
  }

  /**
   * Prunes stale worktree references.
   */
  async worktreePrune(): Promise<void> {
    await this.exec(["worktree", "prune"]);
  }

  /**
   * Lists all worktrees.
   * Returns array of [path, branch] tuples.
   */
  async worktreeList(): Promise<Array<{ path: string; branch: string }>> {
    try {
      const result = await this.exec(["worktree", "list", "--porcelain"]);
      const worktrees: Array<{ path: string; branch: string }> = [];
      let currentPath = "";
      let currentBranch = "";

      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length).trim();
        } else if (line.startsWith("branch ")) {
          currentBranch = line.slice("branch refs/heads/".length).trim();
        } else if (line === "" && currentPath) {
          // Don't include the bare repository itself
          if (currentBranch) {
            worktrees.push({ path: currentPath, branch: currentBranch });
          }
          currentPath = "";
          currentBranch = "";
        }
      }

      // Handle last entry if no trailing newline
      if (currentPath && currentBranch) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  // ========================================
  // Commit Operations
  // ========================================

  /**
   * Commits all changes.
   * No staging - always commits everything.
   * Uses -F - to read message from stdin to properly handle multi-line messages.
   *
   * Gated by `withWorktreeSerialization` only, not the cross-worktree shared
   * queue — see that function's comment for why `add -A` + `commit` is safe
   * to run in parallel across different worktrees. Calls the raw `runGit*`
   * primitives directly (not `exec`/`execWithStdin`) so this one gate is the
   * only one acquired; nesting into the per-worktree queue a second time
   * from inside itself would deadlock.
   */
  async commitAll(message: string, options?: { noVerify?: boolean }): Promise<string> {
    return this.coordination.withWorktreeSerialization(this.repoPath, async () => {
      await this.runGit(["add", "-A"]);
      const commitArgs = ["commit", "--allow-empty-message", "-F", "-"];
      if (options?.noVerify) commitArgs.push("--no-verify");
      await this.runGitWithStdin(commitArgs, message);
      const result = await this.runGit(["rev-parse", "HEAD"]);
      return result.stdout.trim();
    });
  }

  /**
   * Gets the hash of the last commit.
   */
  async getLastCommitHash(): Promise<string> {
    const result = await this.exec(["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  // ========================================
  // Push/Pull
  // ========================================

  /**
   * Pushes commits to the remote.
   */
  async push(): Promise<void> {
    await this.exec(["push"]);
  }

  /**
   * Pushes commits with upstream tracking.
   * @param setUpstream - If true, sets up tracking (like git push -u)
   */
  async pushWithSetUpstream(setUpstream = false): Promise<void> {
    if (setUpstream) {
      const branch = await this.currentBranch();
      await this.exec(["push", "-u", "origin", branch]);
    } else {
      await this.exec(["push"]);
    }
  }

  /**
   * Force pushes commits to the remote.
   * Use with caution - this rewrites remote history.
   */
  async forcePush(): Promise<void> {
    await this.exec(["push", "--force"]);
  }

  /**
   * Pulls from the remote.
   */
  async pull(): Promise<void> {
    await this.exec(["pull"]);
  }

  /**
   * Fetches from origin. Coalesced and cached per shared bare repo — see
   * `GitCoordinationState.cachedFetch`. Pass `force: true` to bypass a
   * still-fresh cached result (e.g. right before retrying after a rejected
   * push); a fetch already in flight is always joined regardless.
   */
  async fetch(force = false): Promise<void> {
    await this.coordination.cachedFetch(this.repoPath, async () => { await this.exec(["fetch"]); }, force);
  }

  /**
   * Fetches exactly one ref from origin (`git fetch origin <ref>`) — never a
   * full multi-branch fetch. This is the low-level scoped-fetch primitive
   * design doc §3.3 calls for; not currently exposed on `Worktree`/
   * `BareRepository`'s public surface (there is no public `fetch()` at all
   * in the redesign — see §3.1), and not yet wired into any CAS-retry loop
   * (that's the Disk adapter, chunk 4). Callers are expected to coalesce
   * concurrent calls for the same ref via
   * `GitCoordinationState.fetchRefSinceGeneration`
   * (`libs/file-store/src/adapters/disk/PublishRetry.ts` drives this), not
   * call this directly and unconditionally.
   */
  async fetchRef(ref: string): Promise<void> {
    await this.exec(["fetch", "origin", ref]);
  }

  // ========================================
  // Branch Operations
  // ========================================

  /**
   * Switches to a different branch.
   * Creates the branch if it doesn't exist.
   */
  async switchBranch(branch: string): Promise<void> {
    try {
      await this.exec(["checkout", branch]);
    } catch {
      // Branch doesn't exist, create it
      await this.exec(["checkout", "-b", branch]);
    }
  }

  /**
   * Gets the current branch name.
   */
  async currentBranch(): Promise<string> {
    const result = await this.exec(["branch", "--show-current"]);
    return result.stdout.trim();
  }

  /**
   * Checks out `ref` with a detached HEAD — the working tree moves to
   * `ref`'s content, but no branch ref is created or updated, and whatever
   * branch was previously checked out here is untouched (it's simply no
   * longer checked out anywhere while HEAD stays detached). Used by
   * `DiskCheckedOutMovementImpl.merge()` to build a trial landing commit
   * against the base trunk's tip directly in a wing's own worktree — never
   * `this.branch`'s own ref — without provisioning a separate scratch
   * worktree/branch for it (see that method's own doc comment).
   */
  async checkoutDetached(ref: string): Promise<void> {
    await this.exec(["checkout", "--detach", ref]);
  }

  /**
   * Creates or force-resets a branch to point at a target ref without switching to it.
   * Safe when called from any other branch.
   */
  async branchForceReset(name: string, target: string): Promise<void> {
    await this.exec(["branch", "-f", name, target]);
  }

  /**
   * Compare-and-swap: moves branch `name` to `target`, but only if it
   * currently resolves to exactly `expected` — atomic at the git
   * ref-storage level (`git update-ref <ref> <new> <old>`), so this is safe
   * to call from multiple worktrees of the same shared bare repo (or even
   * multiple processes) with no additional in-process lock. Pass `""` for
   * `expected` to require that `name` not already exist.
   *
   * Returns false (no write performed) rather than throwing when the
   * current value doesn't match `expected` — that is the expected,
   * non-exceptional outcome of losing a race, and callers are expected to
   * re-read the ref and retry their computation against its new value
   * rather than treat this as a hard error.
   *
   * This is what `mergeMovement`/`absorbPlanBranch`/`promote` use instead of
   * `branchForceReset` for the one write in each that advances a branch
   * shared across worktrees (`main`, a trunk, a `plan/<trunk>` mirror) —
   * `branchForceReset`'s blind overwrite is exactly what let two concurrent
   * merges silently discard one another's just-created commit in a live
   * incident (see `MovementManager`'s retry-loop callers for the full
   * writeup).
   */
  async updateRefIfUnchanged(name: string, target: string, expected: string): Promise<boolean> {
    try {
      await this.exec(["update-ref", `refs/heads/${name}`, target, expected]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a branch at ref if it doesn't already exist. Never moves an
   * existing branch, unlike branchForceReset. Safe to run directly against a
   * bare repository path — branch creation needs no working tree.
   *
   * Atomic: attempts the create unconditionally and swallows only an
   * "already exists" failure, rather than checking `branches()` first and
   * creating on a miss. A check-then-act shape would be racy — two
   * concurrent callers could both observe "branch missing" via `branches()`
   * (an unserialized read) before either one's `exec(["branch", ...])`
   * write landed, so both would attempt the create and the second would
   * crash with an uncaught `fatal: a branch named '<name>' already exists`
   * instead of a graceful no-op — reproducible deterministically via
   * concurrent `Movement.merge()` calls on the same trunk. Instead, the
   * create itself is the only check: it's already serialized per-repo/per-worktree
   * by `exec` (see that method's own doc comment), so a losing concurrent
   * caller's create simply fails against a branch that already exists by
   * the time its turn comes, and that specific failure is exactly what's
   * swallowed here.
   */
  async createBranchIfMissing(name: string, ref: string): Promise<void> {
    try {
      await this.exec(["branch", name, ref]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return;
      throw error;
    }
  }

  /**
   * Pushes a named branch to origin without switching to it.
   */
  async pushBranch(name: string): Promise<void> {
    await this.exec(["push", "origin", `${name}:${name}`]);
  }

  async forcePushBranch(name: string): Promise<void> {
    await this.exec(["push", "--force", "-u", "origin", `${name}:${name}`]);
  }

  /**
   * The actual publish primitive design doc §2 invariant A calls for: a
   * direct push of an already-built commit straight to origin's ref
   * (`git push origin <sha>:refs/heads/<branch>`), which git's own
   * receive-side fast-forward check makes an atomic, server-side CAS for
   * free — no local "advance, then push" two-step, so there's no crash
   * window where local state is ahead of origin and nothing knows it. Used
   * by the Disk `Movement.merge()`/`Mirror.apply()` implementations as their
   * actual publish step, instead of the local-only `updateRefIfUnchanged` —
   * a local CAS alone can't be "publish": it can succeed while origin never
   * sees the commit at all.
   *
   * Returns `false` (no error thrown) when the push is rejected because
   * origin's ref moved past what `sha` was built against — the expected,
   * non-exceptional outcome of losing a race, exactly like
   * `updateRefIfUnchanged`'s contract. Any other failure (auth, network,
   * repo doesn't exist) propagates as a real error.
   *
   * @param branch - Branch name on origin to publish to.
   * @param sha - The already-built commit hash to publish.
   */
  async pushRefCas(branch: string, sha: string): Promise<boolean> {
    try {
      await this.exec(["push", "origin", `${sha}:refs/heads/${branch}`]);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/(non-fast-forward|fetch first|stale info|\[rejected\]|failed to push)/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * A real expected-VALUE CAS push (`git push
   * --force-with-lease=<branch>:<expectedOld>`), as opposed to `pushRefCas`'s
   * ancestor-based fast-forward CAS. Needed specifically by
   * `DerivedTrunk.advance()`'s merge-preserving-replay path (design doc
   * §4.4): a `rebase --rebase-merges` REWRITES history — every commit in the
   * replayed range gets a brand-new hash — so even when the replay is
   * genuinely correct and lossless, the resulting tip does NOT have origin's
   * PREVIOUSLY-published tip as a literal git ancestor (the old commit
   * objects simply aren't in the new tip's history at all, only their
   * rebased equivalents are). A plain `pushRefCas` (ancestor-based) would
   * therefore reject this as "non-fast-forward" EVERY time origin already
   * has anything published for this branch beyond the exact merge-base the
   * replay was computed from — not a race, a structural certainty — which is
   * exactly the design doc §4.4 prose's own framing: "the actual publish
   * write being a CAS: `updateRefIfUnchanged(derivedTrunk.branch,
   * resolvedTip, snapshottedTrunkTipAtStart)`" — an EXPECTED-VALUE compare,
   * not an ancestry check. `--force-with-lease=<branch>:<expectedOld>` is
   * git's real primitive for exactly this: still atomic and server-side
   * (git refuses if the ref's CURRENT value differs from `expectedOld` at
   * push time, no matter what `sha`'s ancestry looks like), but permits
   * `sha` to not be a literal descendant — which a legitimate rebase result
   * never is. `expectedOld === null` means "the branch must not exist yet on
   * origin" (an empty expected value in `--force-with-lease` syntax).
   *
   * Returns `false` (no error thrown) on a lost race — origin's ref no
   * longer matches `expectedOld` — the same non-exceptional contract
   * `pushRefCas` has. Any other failure propagates as a real error.
   */
  async pushRefCasExpected(branch: string, sha: string, expectedOld: string | null): Promise<boolean> {
    const lease = `${branch}:${expectedOld ?? ""}`;
    try {
      await this.exec(["push", `--force-with-lease=${lease}`, "origin", `${sha}:refs/heads/${branch}`]);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/(stale info|\[rejected\]|failed to push|not up to date|remote ref updated since checkout|reference already exists)/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Real-git ancestry check: is `ancestor` reachable from `descendant`?
   * Equivalent to `git merge-base --is-ancestor <ancestor> <descendant>`
   * (exit 0 = yes, exit 1 = no — not an error), used by the Disk
   * `Movement.state()` implementation's "integrated" derivation instead of
   * the InMemory adapter's `log("", base)` full-history-walk trick, which
   * only worked by an InMemory-specific accident: real `git log
   * <empty>..<to>` treats an omitted left side as `HEAD`, not "the root of
   * history," so it doesn't port. Bypasses `exec`'s
   * write-serialization queues (this is read-only plumbing, already treated
   * as such by `isReadOnlyGitCommand`) and inspects the child process's real
   * exit code directly, rather than parsing an error message, since exit
   * code 1 here is a normal, expected outcome, not a failure.
   */
  async mergeBaseIsAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: this.repoPath,
      });
      return true;
    } catch (error: unknown) {
      const code = (error as { code?: number }).code;
      if (code === 1) return false;
      throw error;
    }
  }

  /**
   * Real-git merge-base: the best common ancestor of `a` and `b`, or `null`
   * if they share no history. Used by `DerivedTrunk.advance()` (design doc
   * §4.4) to find where a derived trunk's own history diverged from its
   * parent — the "old parent tip" a merge-preserving `rebase --rebase-merges
   * --onto <newParentTip> <oldParentTip> <derivedTip>` replays relative to.
   * Bypasses `exec`'s write-serialization queues (read-only plumbing, same
   * treatment as `mergeBaseIsAncestor`).
   */
  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      const result = await execFileAsync("git", ["merge-base", a, b], { cwd: this.repoPath });
      return result.stdout.trim() || null;
    } catch (error: unknown) {
      const code = (error as { code?: number }).code;
      if (code === 1) return null;
      throw error;
    }
  }

  /**
   * Runs a merge-preserving rebase (`git -c core.editor=true rebase
   * --rebase-merges --onto <onto> <upstream>`) against the CURRENT branch
   * checked out in this worktree, non-interactively. Used exclusively by
   * `DerivedTrunk.advance()`'s conflict-free fast path (design doc §4.4)
   * against a private scratch branch/worktree — never the trunk's own
   * checkout.
   *
   * **Fails clean on conflict, always** — this is the fast path's own
   * contract (design doc: "either succeeds for the whole range or fails
   * clean with nothing left mid-state"), so unlike `rebase()`/
   * `continueRebase()` (which deliberately LEAVE a conflicted rebase
   * in-progress for a caller to resolve and `continueRebase()`), this method
   * always runs `git rebase --abort` itself before returning a `"conflict"`
   * result — there is no resumable state left behind, matching `advance()`'s
   * "no attended fallback" fast-path contract. The attended path (design doc
   * §4.4's `beginAdvance()`/`AdvanceAttempt`, not yet implemented) is where a
   * conflict is meant to be left resumable instead.
   */
  async rebaseMergesOntoOrAbort(onto: string, upstream: string): Promise<RebaseResult> {
    const result = await this.rebaseMergesOnto(onto, upstream);
    if (result.status === "conflict") {
      try {
        await this.exec(["rebase", "--abort"]);
      } catch {
        // Best-effort: if the abort itself fails, there's nothing more this
        // method can do — surfaced state is still "conflict" either way.
      }
    }
    return result;
  }

  /**
   * Runs a merge-preserving rebase (`git -c core.editor=true rebase
   * --rebase-merges --onto <onto> <upstream>`) against the CURRENT branch
   * checked out in this worktree, non-interactively — the same underlying
   * command as `rebaseMergesOntoOrAbort`, but **on conflict, LEAVES the
   * rebase in progress** (resumable via `continueRebase()`/
   * `hasInProgressRebase()`, the exact same contract `rebase()` already
   * uses) instead of aborting it. Used by `DerivedTrunk.beginAdvance()`'s
   * `AdvanceAttempt` (design doc §4.4's attended path) — a real content
   * conflict here is meant to be resolved by a client editing files in the
   * scratch worktree and calling `continueRebase()`, not aborted outright
   * the way the conflict-free fast path (`advance()`, via
   * `rebaseMergesOntoOrAbort`) does.
   */
  async rebaseMergesOnto(onto: string, upstream: string): Promise<RebaseResult> {
    const originalHead = await this.getLastCommitHash();
    try {
      await this.exec(["-c", "core.editor=true", "rebase", "--rebase-merges", "--onto", onto, upstream]);
      return { status: "success" };
    } catch (error: unknown) {
      const errorMessage = (error as Error).message || "";
      const conflictedFiles = await this.getConflictedFiles();
      return {
        status: "conflict",
        message: `Rebase conflict: ${errorMessage}`,
        originalHead,
        conflictedFiles,
      };
    }
  }

  /**
   * Creates a commit object from an existing tree and parent refs without
   * moving any branch or touching the working tree. Returns the new commit
   * hash. The message is supplied via stdin so multi-line messages are handled
   * safely. Used to build a --no-ff merge commit without a checkout.
   */
  async commitTree(treeSource: string, parents: string[], message: string): Promise<string> {
    const args = ["commit-tree", `${treeSource}^{tree}`];
    for (const parent of parents) {
      args.push("-p", parent);
    }
    const result = await this.execWithStdin(args, message);
    return result.stdout.trim();
  }

  /**
   * Lists all branches.
   */
  async branches(): Promise<string[]> {
    try {
      const result = await this.exec(["branch", "--list", "--format=%(refname:short)"]);
      return result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((b) => b.trim());
    } catch {
      return [];
    }
  }

  // ========================================
  // Merge
  // ========================================

  /**
   * Merges another branch into the current branch.
   * Uses -F - to read message from stdin to properly handle multi-line messages.
   * @param branch - Branch to merge
   * @param message - Optional custom merge commit message
   */
  async merge(branch: string, message?: string): Promise<MergeResult> {
    // First check if the current branch is the same as the target
    const currentBranch = await this.currentBranch();
    if (currentBranch === branch) {
      return { status: "already-up-to-date" };
    }

    // Check if branches point to the same commit
    try {
      const currentHash = await this.exec(["rev-parse", "HEAD"]);
      const targetHash = await this.exec(["rev-parse", branch]);
      if (currentHash.stdout.trim() === targetHash.stdout.trim()) {
        return { status: "already-up-to-date" };
      }
    } catch {
      // If we can't get hashes, proceed with merge attempt
    }

    try {
      if (message) {
        // Use temp file for message (git merge -F doesn't support stdin like commit does)
        const tempFile = join(this.repoPath, `.git-merge-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fs.writeFile(tempFile, message, "utf8");
        try {
          await this.exec(["merge", "--no-ff", "-F", tempFile, branch]);
        } finally {
          // oxlint-disable-next-line no-empty-function
          await fs.unlink(tempFile).catch(() => {});
        }
      } else {
        await this.exec(["merge", "--no-ff", branch]);
      }
      const hash = await this.getLastCommitHash();
      return { status: "success", commit: hash };
    } catch (error: unknown) {
      const errorMessage = (error as Error).message || "";

      if (errorMessage.includes("Already up to date")) {
        return { status: "already-up-to-date" };
      }

      if (errorMessage.includes("CONFLICT") || errorMessage.includes("Merge conflict")) {
        // Abort the merge to clean up
        try {
          await this.exec(["merge", "--abort"]);
        } catch {
          // Ignore abort errors
        }
        const conflicts = await this.getConflictedFiles();
        return { status: "conflict", conflictedFiles: conflicts };
      }

      throw error;
    }
  }

  /**
   * Resets the current branch to point to a reference.
   * This is a hard reset - working tree is updated to match the target.
   * @param ref - Branch name, tag, or commit hash to reset to
   */
  async resetTo(ref: string): Promise<void> {
    await this.exec(["reset", "--hard", ref]);
  }

  /**
   * Rebases the current branch onto another branch.
   * @param onto - Branch to rebase onto
   * @param options - Optional rebase options
   * @returns RebaseResult with status and details
   */
  async rebase(onto: string, options?: RebaseOptions): Promise<RebaseResult> {
    // Get current HEAD for recovery info
    const originalHead = await this.getLastCommitHash();

    // Check if we're already on the target or have nothing to rebase
    try {
      const mergeBase = await this.exec(["merge-base", "HEAD", onto]);
      const ontoHash = await this.exec(["rev-parse", onto]);

      // If HEAD is already on or ahead of onto, nothing to do - that's still success
      const headHash = await this.exec(["rev-parse", "HEAD"]);
      if (headHash.stdout.trim() === ontoHash.stdout.trim()) {
        return { status: "success" };
      }

      // If HEAD is the merge-base, the branch has no commits of its own and is
      // simply behind onto. `git rebase` would no-op here ("Already up to date"),
      // so fast-forward the branch pointer instead, preserving any uncommitted
      // changes via stash/pop when autostash is requested.
      if (headHash.stdout.trim() === mergeBase.stdout.trim()) {
        const dirty = options?.autostash && await this.isDirty();
        if (dirty) {
          await this.exec(["stash"]);
        }
        await this.resetTo(onto);
        if (dirty) {
          await this.exec(["stash", "pop"]);
        }
        return { status: "success" };
      }
    } catch {
      // If we can't compute merge-base, proceed with rebase attempt
    }

    try {
      // --empty=keep: without this, a commit whose conflict resolution makes
      // its patch a no-op (already applied upstream) halts the rebase with
      // "The previous cherry-pick is now empty" — a second, distinct stop
      // that `git status`/`hasInProgressRebase()` cannot tell apart from an
      // unresolved conflict (both read as "all conflicts fixed: run git
      // rebase --continue" once the empty commit is reached). Since
      // continueRebase() only re-runs `git add -A && git rebase --continue`,
      // that halt would repeat identically forever with no conflicted files
      // to point at. Keeping the (now-empty) commit instead of stopping
      // avoids the loop entirely. This applies for the whole rebase session,
      // including through `--continue`, once set here.
      await this.exec(["rebase", "--empty=keep", ...(options?.autostash ? ["--autostash"] : []), onto]);
      return { status: "success" };
    } catch (error: unknown) {
      return this.pushThroughEmptyHalt(error, originalHead);
    }
  }

  /**
   * Git's own wording for the ONE known halt this function exists to walk
   * through: the sequencer stops even though there is genuinely nothing left
   * to resolve, because the replayed commit's patch nets to zero against its
   * new parent (either the same change was already applied upstream, or a
   * conflict auto-resolved via git's own merge machinery — no markers left
   * in any file — and the result is identical to the parent). `--empty=keep`
   * (passed to the initial `git rebase` invocation above) already prevents
   * most of these outright by keeping such a commit without asking, so this
   * pattern is mainly a defensive backstop for whatever slips through (an
   * older git, a `--continue` on a rebase started before this flag existed,
   * a message shape not seen yet).
   */
  private static readonly EMPTY_PATCH_HALT = /previous cherry-pick is now empty|nothing to commit/i;

  /**
   * Git's own wording for the OTHER known-safe halt this function walks
   * through automatically: the sequencer's final ref-update step failed with
   * a compare-and-swap mismatch, but the branch is ALREADY at the exact
   * commit that update was trying to set it to. This is not a hypothetical —
   * confirmed live in production: a `movement merge`/`start` process got
   * interrupted (killed, connection dropped) AFTER its `rebase --continue`
   * had already successfully moved the branch ref, but BEFORE the sequencer
   * cleaned up its own `rebase-merge` session directory. Every later
   * `--continue` retry replays the identical doomed update (the sequencer's
   * own `orig-head` bookkeeping is stale and never gets refreshed), so it
   * fails identically forever — not transiently, and no amount of retrying
   * the identical command will ever change that; a human previously had to
   * notice this and run `git rebase --abort`/`--quit` manually.
   * `refAlreadyAtRebaseTip` proves this precisely (not just plausibly) by
   * checking `is at <X>` against this worktree's own current `HEAD` — the
   * replayed tip mid-finalization — rather than any looser heuristic, so
   * this can never misfire and silently drop a real divergent change.
   */
  private static readonly REF_ALREADY_AT_TARGET =
    /cannot lock ref '[^']+': is at ([0-9a-f]{7,40}) but expected [0-9a-f]{7,40}/i;

  /** True if `message` is the ref-CAS-mismatch shape described above AND the ref's current value already matches this worktree's own HEAD — i.e. the rebase's real work is done, only the sequencer's bookkeeping is stale. */
  private async refAlreadyAtRebaseTip(message: string): Promise<boolean> {
    const match = GitOperations.REF_ALREADY_AT_TARGET.exec(message);
    if (!match) return false;
    try {
      const head = (await this.exec(["rev-parse", "HEAD"])).stdout.trim();
      return head === match[1];
    } catch {
      return false;
    }
  }

  /**
   * A `git rebase`/`--continue` invocation can halt (non-zero exit, "fix
   * conflicts and run rebase --continue") even when there is nothing left
   * for a human to look at. `getConflictedFiles()` (`git diff
   * --diff-filter=U`) alone was the original gate here, but "no unmerged
   * files right now" is a weaker condition than "this halt is safe to walk
   * through automatically" — other genuine failures also leave no file
   * unmerged, and blindly walking through THOSE via `add -A && rebase
   * --continue` either silently papers over a real problem or, after
   * exhausting the retry budget, reports `"conflict"` with an empty file
   * list — the exact dead end this function was written to eliminate, just
   * from a different trigger. (NOT a concern: git's rebase machinery never
   * invokes `pre-commit`/`commit-msg` hooks for a replayed or continued
   * commit at all — confirmed directly against real git, including a
   * conflict-then-`--continue` sequence, with a hook that unconditionally
   * exits 1 — so a repo-level commit hook can never be the cause of a halt
   * here, whatever it does.)
   *
   * A real conflict (`getConflictedFiles()` non-empty) is checked FIRST,
   * every iteration, and NEVER enters any automatic recovery below — those
   * files always go straight back to the caller to fix by hand. Once that's
   * ruled out, each halt is triaged into exactly one of four tiers, checked
   * in this order:
   *
   * 1. **Already done** (`refAlreadyAtRebaseTip`) — the rebase's real work
   *    already completed; only the sequencer's own bookkeeping is stale.
   *    `git rebase --quit` (NOT `--continue`, which is precisely what's
   *    failing, and NOT `--abort`, which would reset HEAD/branch and throw
   *    away the already-correct result) just discards that stale sequencer
   *    session without touching HEAD or the branch ref — success,
   *    immediately, no further looping.
   * 2. **Known-safe empty-patch halt** (`EMPTY_PATCH_HALT`) — see that
   *    constant's own doc. Retried via another `add -A && rebase
   *    --continue`.
   * 3. **A stale lock artifact from a crash** (`clearBlockedObjectFiles` —
   *    the SAME Windows transient-write/lock recovery `withTransientWriteRetry`
   *    already applies per-command; `exec()`'s own 3 attempts are already
   *    exhausted by the time a halt reaches here, so this is one more
   *    chance at the SAME clear, not a different mechanism). Retried the
   *    same way as tier 2 once a lock was actually cleared.
   * 4. **Neither of the above** — nothing left this function knows how to
   *    fix automatically. Stops immediately (no more looping) and falls
   *    through to the final return, which surfaces the complete underlying
   *    git error either way — a real conflict's file list, or (when there's
   *    nothing to edit) the full message explaining that plainly instead of
   *    generic advice to "fix conflicted files" that don't exist.
   *
   * Bounded to {@link MAX_HALT_RECOVERY_ATTEMPTS} (not an arbitrarily large
   * cap): forward progress is checked every iteration too (a retry whose
   * resulting error message is byte-identical to the previous attempt's
   * means the retry changed nothing — stop immediately rather than spending
   * the rest of the budget replaying a deterministic failure). Confirmed
   * live in production what an unbounded version of this loop actually
   * costs: dozens of doomed retries against a CAS mismatch that could never
   * self-resolve, manifesting as the caller's tool call taking minutes and
   * eventually needing to be moved to the background.
   */
  private async pushThroughEmptyHalt(error: unknown, originalHead: string): Promise<RebaseResult> {
    let errorMessage = error instanceof Error ? error.message : String(error);
    let conflictedFiles = await this.getConflictedFiles();
    let previousMessage: string | null = null;

    for (let attempt = 0; attempt < GitOperations.MAX_HALT_RECOVERY_ATTEMPTS; attempt++) {
      if (conflictedFiles.length > 0) break;

      if (await this.refAlreadyAtRebaseTip(errorMessage)) {
        await this.exec(["rebase", "--quit"]).catch(() => undefined);
        return { status: "success" };
      }

      const isKnownSafeHalt = GitOperations.EMPTY_PATCH_HALT.test(errorMessage);
      const clearedStaleLock = !isKnownSafeHalt && (await clearBlockedObjectFiles(errorMessage));
      if (!isKnownSafeHalt && !clearedStaleLock) break;

      // Deterministic failure: retrying the identical command against
      // identical state will just fail identically again — stop instead of
      // burning the rest of the attempt budget on a doomed repeat.
      if (errorMessage === previousMessage) break;
      previousMessage = errorMessage;

      try {
        await this.exec(["add", "-A"]);
        await this.exec(["-c", "core.editor=true", "rebase", "--continue"]);
        return { status: "success" };
      } catch (continueError: unknown) {
        errorMessage = continueError instanceof Error ? continueError.message : String(continueError);
        conflictedFiles = await this.getConflictedFiles();
      }
    }

    return {
      status: "conflict",
      message:
        conflictedFiles.length > 0
          ? `Rebase conflict: ${errorMessage}`
          : `Rebase halted for an unexpected reason with no conflicted files to fix (not a known-recoverable case) — this needs investigation, not a file edit: ${errorMessage}`,
      originalHead,
      conflictedFiles,
    };
  }

  /**
   * Hard ceiling on `pushThroughEmptyHalt`'s recovery loop — see that
   * method's own doc comment for why 3, not a large number: every tier it
   * tries either resolves in one retry or is deterministic (a repeat attempt
   * against unchanged state fails identically), so more attempts than this
   * only delay surfacing the eventual result, never change it.
   */
  private static readonly MAX_HALT_RECOVERY_ATTEMPTS = 3;

  /**
   * True if a rebase is currently in progress in this worktree (e.g. left
   * mid-conflict by rebase() or continueRebase()).
   *
   * Checked via the on-disk rebase-state directory (`rebase-merge` for the
   * default merge-based backend, `rebase-apply` for the am-based one) rather
   * than `REBASE_HEAD`: that ref is a convenience pointer git sets when a
   * rebase starts but does NOT clean up when the rebase finishes — verified
   * empirically, it keeps resolving after a fully completed `rebase
   * --continue` — so it would report "in progress" forever after the first
   * rebase. `git rev-parse --git-path` resolves the correct path for this
   * specific worktree (linked worktrees keep rebase state under their own
   * `.git/worktrees/<id>/`, not the shared common dir).
   */
  async hasInProgressRebase(): Promise<boolean> {
    for (const kind of ["rebase-merge", "rebase-apply"]) {
      try {
        const result = await this.exec(["rev-parse", "--git-path", kind]);
        const gitPath = result.stdout.trim();
        const absolute = isAbsolute(gitPath) ? gitPath : join(this.repoPath, gitPath);
        await fs.access(absolute);
        return true;
      } catch {
        // Not present, or path couldn't be resolved — check the other kind.
      }
    }
    return false;
  }

  /**
   * Best-effort `git rebase --abort` — used by `DerivedTrunk.beginAdvance()`'s
   * `AdvanceAttempt.abandon()`/`dispose()` (design doc §4.4) to leave a
   * borrowed `resolveIn` worktree clean (no in-progress rebase, no conflict
   * markers) before checking it back out onto its original branch. Failures
   * are swallowed — if there's nothing to abort, or the abort itself fails,
   * there's nothing more this method can usefully do.
   */
  async abortRebase(): Promise<void> {
    try {
      await this.exec(["rebase", "--abort"]);
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  /**
   * Stages all changes in the worktree (`git add -A`) and continues an
   * in-progress rebase non-interactively — no commit-message editor is ever
   * invoked (`-c core.editor=true`); original commit messages are reused
   * automatically. Mirrors rebase()'s conflict contract: a further conflict
   * leaves the rebase in progress again and returns the same shape. A halt
   * with nothing actually unmerged (see `pushThroughEmptyHalt`) is walked
   * through automatically rather than reported as a conflict.
   */
  async continueRebase(): Promise<RebaseResult> {
    const originalHead = await this.getLastCommitHash();
    await this.exec(["add", "-A"]);
    try {
      await this.exec(["-c", "core.editor=true", "rebase", "--continue"]);
      return { status: "success" };
    } catch (error: unknown) {
      return this.pushThroughEmptyHalt(error, originalHead);
    }
  }

  /**
   * Gets list of conflicted files.
   */
  private async getConflictedFiles(): Promise<string[]> {
    try {
      const result = await this.exec(["diff", "--name-only", "--diff-filter=U"]);
      return result.stdout
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ========================================
  // Status
  // ========================================

  /**
   * Checks if there are uncommitted changes.
   */
  async isDirty(): Promise<boolean> {
    const result = await this.exec(["status", "--porcelain"]);
    return result.stdout.trim().length > 0;
  }

  // ========================================
  // Log Operations
  // ========================================

  /**
   * Gets commit log between two refs.
   * Returns commits that are in `to` but not in `from`.
   * @param from - Starting ref (exclusive, typically 'main')
   * @param to - Ending ref (inclusive, typically 'HEAD' or branch name)
   * @returns Array of commit info with hash, subject, body, author, and date
   */
  async log(from: string, to: string): Promise<Array<{
    hash: string;
    subject: string;
    body: string;
    author: string;
    date: string;
  }>> {
    try {
      // Use a format that we can reliably parse
      // %H = full hash, %s = subject, %b = body, %an = author name, %ai = author date ISO
      // Using %x00 (NUL) as separator between fields, and %x1e (record separator) between commits
      const format = '%H%x00%s%x00%b%x00%an%x00%ai%x1e';
      const result = await this.exec(["log", `--format=${format}`, `${from}..${to}`]);

      const output = result.stdout.trim();
      if (!output) {
        return [];
      }

      // Split by record separator and filter empty entries
      const records = output.split('\x1e').filter(Boolean);

      return records.map(record => {
        const parts = record.split('\x00');
        return {
          hash: parts[0] || '',
          subject: parts[1] || '',
          body: (parts[2] || '').trim(),
          author: parts[3] || '',
          date: parts[4] || '',
        };
      });
    } catch {
      // If the range is invalid (e.g., main doesn't exist), return empty array
      return [];
    }
  }

  /**
   * Gets the unified diff of changes introduced by `to` since it diverged
   * from `from` (three-dot diff).
   * @param from - Base ref to diff against
   * @param to - Ref whose changes are shown
   */
  async diff(from: string, to: string): Promise<string> {
    try {
      const result = await this.exec(["diff", `${from}...${to}`]);
      return result.stdout;
    } catch {
      return '';
    }
  }

  /**
   * Lists paths changed between two refs (a two-dot diff: `from..to`).
   * @param from - Starting ref
   * @param to - Ending ref
   */
  async changedFiles(from: string, to: string): Promise<string[]> {
    try {
      const result = await this.exec(["diff", "--name-only", `${from}..${to}`]);
      return result.stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Reads a file's raw content as it existed at a specific ref.
   * @param ref - Commit sha or branch name
   * @param path - File path relative to the worktree root
   */
  async readFileAtRef(ref: GitRef, path: string): Promise<string | null> {
    try {
      const result = await this.exec(["show", `${ref}:${path}`]);
      return result.stdout;
    } catch {
      return null;
    }
  }

  // ========================================
  // Internal Helpers
  // ========================================

  /**
   * Runs `git <args>` via `execFile` with no queue gating at all — the raw
   * primitive every gated call site (exec/execWithStdin/commitAll) builds
   * on. Never call this directly for anything that writes; only the gating
   * wrappers below know which queue(s) a given write needs.
   */
  private async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return withTransientWriteRetry(async () => {
      try {
        return await execFileAsync("git", args, { cwd: this.repoPath });
      } catch (error: unknown) {
        const execError = error as { stdout?: string; stderr?: string; message?: string };
        // Include stdout/stderr in error for better debugging
        throw new Error(
          `Git command failed: git ${args.join(" ")}\n` +
            `${execError.stderr || ""}\n` +
            `${execError.stdout || ""}\n` +
            `${execError.message || ""}`
        );
      }
    });
  }

  /** Same as runGit, but feeds `stdin` to the process instead of passing it as an arg. */
  private async runGitWithStdin(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
    return withTransientWriteRetry(
      () =>
        new Promise((resolve, reject) => {
          const proc = spawn("git", args, {
            cwd: this.repoPath,
            stdio: ["pipe", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";

          proc.stdout.on("data", (data) => {
            stdout += data.toString();
          });

          proc.stderr.on("data", (data) => {
            stderr += data.toString();
          });

          proc.on("close", (code) => {
            if (code === 0) {
              resolve({ stdout, stderr });
            } else {
              reject(
                new Error(
                  `Git command failed: git ${args.join(" ")}\n` + `${stderr}\n` + `${stdout}`
                )
              );
            }
          });

          proc.on("error", (err) => {
            reject(new Error(`Git command failed: git ${args.join(" ")}\n${err.message}`));
          });

          proc.stdin.write(stdin);
          proc.stdin.end();
        })
    );
  }

  /**
   * Executes a git command in the repository directory. No shell is
   * spawned, so args are passed exactly as given with no quoting or
   * escaping needed (and no shell-metacharacter risk from ref/branch/path
   * values).
   *
   * Every write is gated by this worktree's own queue first (so it can
   * never overlap another write issued against this exact directory — see
   * `withWorktreeSerialization`), and — unless the caller has already
   * proven the command's write surface is worktree-private (`commitAll`
   * does; see its own comment) — additionally by the cross-worktree shared
   * queue (`withRepoSerialization`), since most commands here can name an
   * arbitrary branch/ref that a *different* worktree of the same bare repo
   * might also be touching (push, fetch, updateBranch, rebase, ...).
   */
  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (isReadOnlyGitCommand(args)) return this.runGit(args);
    return this.coordination.withWorktreeSerialization(this.repoPath, () =>
      this.coordination.withRepoSerialization(this.repoPath, () => this.runGit(args))
    );
  }

  /**
   * Executes a git command with stdin input.
   * Used for commands like commit and merge with multi-line messages.
   * @param args - Git command arguments (without 'git' prefix)
   * @param stdin - Content to write to stdin
   */
  private async execWithStdin(args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
    return this.coordination.withWorktreeSerialization(this.repoPath, () =>
      this.coordination.withRepoSerialization(this.repoPath, () => this.runGitWithStdin(args, stdin))
    );
  }
}
