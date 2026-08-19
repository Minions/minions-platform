/**
 * DocSessions — worktree lifecycle for the git-backed doc viewer/editor.
 *
 * A "session" is identified purely by (repoKind, repoName, branch) — there is
 * no generated id and no separate index. The path under the lair's cabinet
 * area (see @minions/file-store Lair.cabinet()) is derived directly from
 * those three values in both directions, so a worktree path, its meta
 * sidecar path, and the session identity are always mutually recoverable.
 *
 * Opening a session (createSession) creates only a branch — cheap, no
 * worktree. The worktree is materialized lazily on first real access
 * (materialize), which a caller typically triggers from a "list"/"load"
 * MCP tool the first time a human opens the viewer URL.
 */

import type {
  BareRepository,
  CheckedOutMovement,
  CherryPickResult,
  CommitInfo,
  CommitRef,
  CommitResult,
  CommitSpec,
  Directory,
  File,
  GitRef,
  Lair,
  MergeResult,
  MergeSpec,
  Movement,
  MovementState,
  MutableDirectoryLike,
  RebaseResult,
  StartResult,
  Trunk,
  Worktree,
} from '@minions/file-store';
import { createWorkAreaFactoriesForSandbox } from '@minions/file-store';

export type RepoKind = 'work' | 'private';

export interface DocSessionKey {
  repoKind: RepoKind;
  repoName: string;
  branch: string;
}

export interface DocSessionMeta extends DocSessionKey {
  createdAt: string;
  lastActivityAt: string;
  /** The ref the session branch was created from — the default diff base for this session. */
  commitRef: GitRef;
  /** Advisory doc-set scope recorded at open time — files/globs the viewer defaults to listing. */
  paths?: string[];
  /** Advisory human-readable purpose recorded at open time. */
  purpose?: string;
}

const SESSIONS_PREFIX = 'docs/sessions';
const META_PREFIX = 'docs/meta';
const META_FILE_NAME = 'meta.json';

/**
 * A doc session's branch must always be a fresh, session-owned branch created
 * at a given commit ref — never the repo's own base branch. Checking out
 * `main` into a session worktree is illegal: main must stay free for other
 * worktrees to merge into at will, at any time.
 */
const PROTECTED_BRANCH = 'main';

/**
 * Adapts a doc session's (Movement, Worktree) pair into the design doc §4.2
 * `CheckedOutMovement` shape.
 *
 * Why this is hand-assembled here rather than obtained from an existing
 * factory: every `CheckedOutMovement` constructor in `@minions/file-store`
 * either (a) is `WorkArea.beginNewActiveMovement`, which checks the branch
 * out into ONE worktree per work area (a wing's own single checkout) — doc
 * sessions need arbitrarily many concurrently-checked-out session branches
 * on the same repo, which is structurally incompatible with "one active
 * movement at a time" — or (b) is the adapter-internal
 * `WorkAreaFactories.createCheckedOutMovement(base, branch)`, which is
 * multi-worktree-safe but hardcodes its worktree's path to
 * `__movement__<sanitized-branch>` under a scratch root, not the
 * `docs/sessions/<repoKind>/<repoName>/<branch>` layout this component's
 * tests and on-disk convention already commit to. Neither shape fits, so
 * this composes the two independent, genuinely adapter-agnostic port
 * primitives that DO fit: `Trunk.movement(branch)` for the git-history
 * operations (state/commitsSince/diffFrom/discard — all of which run
 * directly against the bare repo, no worktree needed), and this class's own
 * already-materialized `Worktree` (unchanged worktree lifecycle, still using
 * the raw `BareRepository.createWorktree`/`worktrees`/`removeWorktree`
 * primitives design doc §5 plans to remove — no replacement for
 * custom-path worktree creation exists yet) for the file-level operations.
 *
 * `start()`/`resolveConflict()` are required by the `CheckedOutMovement`
 * interface but deliberately unsupported here: a doc session never
 * auto-fetches/rebases its branch onto its base — per `DocsActionGroup`'s
 * own `status` action doc comment, picking up a session's edits into a wing
 * branch is a human/AI decision made later, through the `movement` tool,
 * not something this component does on a session's behalf.
 *
 * `merge()`/`rebaseOnto()`/`cherryPick()` are unsupported for the identical
 * reason, and are stubbed the same way: `meta.commitRef` (surfaced here as
 * `this.movement.base.branch`) is an arbitrary caller-supplied ref recorded
 * purely as "the default diff base for this session" (see
 * `DocSessionMeta.commitRef`'s own doc comment) — sometimes a real branch
 * like `main`, sometimes a raw commit sha, never a genuine merge target a
 * CAS-publish should ever be attempted against. Delegating these three
 * straight through to `this.movement` would let a generic
 * `CheckedOutMovement` caller unknowingly attempt a real publish against
 * whatever `commitRef` happens to be.
 */
class DocSessionMovement implements CheckedOutMovement {
  constructor(
    private readonly movement: Movement,
    private readonly worktree: Worktree,
  ) {}

  get branch(): string {
    return this.movement.branch;
  }

  get base(): Trunk {
    return this.movement.base;
  }

  get files(): MutableDirectoryLike {
    return this.worktree;
  }

  state(): Promise<MovementState> {
    return this.movement.state();
  }

  merge(_spec: MergeSpec): Promise<MergeResult> {
    throw new Error('DocSessionMovement.merge() is not supported — a doc session\'s commitRef is a diff base, not a genuine merge target; see this class\'s doc comment.');
  }

  rebaseOnto(_target: Movement | CommitRef): Promise<RebaseResult> {
    throw new Error('DocSessionMovement.rebaseOnto() is not supported — a doc session\'s commitRef is a diff base, not a genuine merge target; see this class\'s doc comment.');
  }

  cherryPick(_commits: CommitRef[]): Promise<CherryPickResult> {
    throw new Error('DocSessionMovement.cherryPick() is not supported — a doc session\'s commitRef is a diff base, not a genuine merge target; see this class\'s doc comment.');
  }

  readFileAtRef(ref: CommitRef, path: string): Promise<string | null> {
    return this.movement.readFileAtRef(ref, path);
  }

  commitsSince(ref?: Movement | CommitRef): Promise<CommitInfo[]> {
    return this.movement.commitsSince(ref);
  }

  diffFrom(ref?: Movement | CommitRef): Promise<string> {
    return this.movement.diffFrom(ref);
  }

  tipHash(): Promise<string | null> {
    return this.movement.tipHash();
  }

  changedFiles(from?: Movement | CommitRef, to?: Movement | CommitRef): Promise<string[]> {
    return this.movement.changedFiles(from, to);
  }

  discard(): Promise<void> {
    return this.movement.discard();
  }

  isDirty(): Promise<boolean> {
    return this.worktree.isDirty();
  }

  async commit(spec: CommitSpec): Promise<CommitResult> {
    const hash = await this.worktree.commitAll(spec.message, { noVerify: spec.noVerify });
    return { hash };
  }

  start(): Promise<StartResult> {
    throw new Error('DocSessionMovement.start() is not supported — doc sessions never auto-rebase onto their base; see this class\'s doc comment.');
  }

  resolveConflict(): Promise<StartResult | MergeResult> {
    throw new Error('DocSessionMovement.resolveConflict() is not supported — doc sessions never auto-rebase onto their base; see this class\'s doc comment.');
  }

  push(): Promise<void> {
    // A doc session's branch is single-writer scratch state, same as a
    // movement branch — force-pushing it for cross-machine durability is
    // safe for the identical reason `CheckedOutMovement.push`'s interface
    // doc gives. `forcePushBranch` (not plain `forcePush()`), matching both
    // adapters' `CheckedOutMovement.push()`: a session's first-ever commit
    // has no upstream tracking ref yet, and `forcePushBranch` sets `-u`
    // every time.
    return this.worktree.forcePushBranch(this.movement.branch);
  }
}

export class DocSessions {
  constructor(private readonly lair: Lair) {}

  /**
   * Creates the session's branch at commitRef if it doesn't already exist.
   * Never creates a worktree, and never moves an already-existing branch.
   * Optionally records advisory scope (paths/purpose) in the meta sidecar —
   * this is a small JSON write, not a worktree, so open stays cheap.
   */
  async createSession(key: DocSessionKey, commitRef: GitRef, scope?: { paths?: string[]; purpose?: string }): Promise<void> {
    this.assertSessionBranch(key.branch);
    const repo = await this.resolveRepo(key);
    await repo.createBranchIfMissing(key.branch, commitRef);
    await this.upsertMeta(key, { commitRef, ...scope });
  }

  /**
   * Materializes the session's worktree if it doesn't exist yet, and bumps
   * lastActivityAt either way. Safe to call on every list/load — a no-op
   * beyond the activity bump when already materialized.
   */
  async materialize(key: DocSessionKey): Promise<CheckedOutMovement> {
    this.assertSessionBranch(key.branch);
    const repo = await this.resolveRepo(key);
    const cabinetDir = await this.lair.cabinet();

    const existing = await this.findWorktree(repo, key.branch);
    const worktree = existing ?? (await repo.createWorktree(cabinetDir, this.sessionRelPath(key), key.branch));
    const meta = await this.upsertMeta(key, {});

    const trunk = this.trunkFor(repo, cabinetDir, meta.commitRef);
    return new DocSessionMovement(trunk.movement(key.branch), worktree);
  }

  /** Bumps lastActivityAt on the session's meta sidecar without touching the worktree. */
  async touch(key: DocSessionKey): Promise<void> {
    await this.upsertMeta(key, {});
  }

  /** Reads the session's meta sidecar (createdAt, lastActivityAt, advisory scope), if any. */
  async getMeta(key: DocSessionKey): Promise<DocSessionMeta | null> {
    const cabinetDir = await this.lair.cabinet();
    return this.readMeta(cabinetDir, key);
  }

  /** Deterministically tears down the session's worktree and meta sidecar. Leaves the branch (and its commits) intact. */
  async close(key: DocSessionKey): Promise<void> {
    const repo = await this.resolveRepo(key);
    const cabinetDir = await this.lair.cabinet();
    // `discard()` only touches `repo`/`branch` — the trunk's own branch value
    // is irrelevant to it (see `Movement.discard()`'s implementation: it
    // finds any worktree checked out on `this.branch` and removes it,
    // leaving the branch pointer alone), so the real base ref isn't needed
    // here, unlike `materialize()`.
    const trunk = this.trunkFor(repo, cabinetDir, PROTECTED_BRANCH);
    await trunk.movement(key.branch).discard();

    const metaResult = await cabinetDir.child(this.metaRelPath(key));
    if (metaResult.found && metaResult.node.is('file')) {
      await (metaResult.node as File).delete();
    }
  }

  /**
   * Removes materialized worktrees whose sessions have been idle longer than
   * ttlMs and were never explicitly closed. Best-effort — a failure reaping
   * one session never stops the sweep of the rest. Returns the sessions reaped.
   */
  async reapStale(ttlMs: number): Promise<DocSessionKey[]> {
    const cabinetDir = await this.lair.cabinet();
    const metaRootResult = await cabinetDir.child(META_PREFIX);
    if (!metaRootResult.found || !metaRootResult.node.is('directory')) return [];

    const now = Date.now();
    const reaped: DocSessionKey[] = [];
    for (const metaFile of await this.walkMetaFiles(metaRootResult.node as Directory)) {
      let meta: DocSessionMeta;
      try {
        meta = JSON.parse(await metaFile.read()) as DocSessionMeta;
      } catch {
        continue;
      }

      const lastActivity = Date.parse(meta.lastActivityAt);
      if (Number.isNaN(lastActivity) || now - lastActivity < ttlMs) continue;

      const key: DocSessionKey = { repoKind: meta.repoKind, repoName: meta.repoName, branch: meta.branch };
      try {
        await this.close(key);
        reaped.push(key);
      } catch {
        // Best-effort — leave this one for the next sweep.
      }
    }
    return reaped;
  }

  // ----------------------------------------------------------------------

  private assertSessionBranch(branch: string): void {
    if (branch === PROTECTED_BRANCH) {
      throw new Error(
        `Doc sessions can never use "${PROTECTED_BRANCH}" as the session branch — main must never be checked out into a worktree. Pass a fresh session branch name and use "${PROTECTED_BRANCH}" only as the commitRef to branch from.`,
      );
    }
  }

  /**
   * Constructs a `Trunk` for `branch` in `repo`, via `WorkAreaFactories`
   * (design doc §4.2) — adapter-agnostic (works for both the Disk and
   * InMemory adapters via `createWorkAreaFactoriesForSandbox`'s own
   * adapter-detection, see its doc comment). `scratchRoot` is only ever
   * touched by `Trunk` operations this class never calls (`merge`/`derive`'s
   * scratch worktrees) — `cabinetDir` is passed because it's already on
   * hand, not because its exact location matters here.
   */
  private trunkFor(repo: BareRepository, cabinetDir: Directory, branch: string): Trunk {
    const factories = createWorkAreaFactoriesForSandbox(this.lair.sandbox, cabinetDir);
    return factories.createTrunk(repo, branch);
  }

  private async resolveRepo(key: Pick<DocSessionKey, 'repoKind' | 'repoName'>): Promise<BareRepository> {
    if (key.repoKind === 'work') {
      const result = await this.lair.workRepo(key.repoName);
      if (!result.exists) throw new Error(`Work repo not found: ${key.repoName}`);
      return result.repo;
    }

    if (key.repoName !== 'local' && key.repoName !== 'global') {
      throw new Error(`Private repo name must be "local" or "global", got: ${key.repoName}`);
    }
    const result = await this.lair.privateRepo(key.repoName);
    if (!result.exists) throw new Error(`Private repo not found: ${key.repoName}`);
    return result.repo;
  }

  private async findWorktree(repo: BareRepository, branch: string): Promise<Worktree | undefined> {
    const all = await repo.worktrees();
    return all.find(wt => wt.branch === branch);
  }

  /**
   * Path relative to the cabinet directory. repoKind is included (not just
   * repoName + branch) because a work repo and a private repo can share a
   * name (e.g. both named "local") — without it, sessions on those two repos
   * with the same branch name would collide on disk.
   */
  private sessionRelPath(key: DocSessionKey): string {
    return [SESSIONS_PREFIX, key.repoKind, key.repoName, key.branch].join('/');
  }

  private metaRelPath(key: DocSessionKey): string {
    return [META_PREFIX, key.repoKind, key.repoName, key.branch, META_FILE_NAME].join('/');
  }

  /** Reads existing meta (if any), merges in patch fields and a fresh lastActivityAt, writes it back. */
  private async upsertMeta(key: DocSessionKey, patch: { commitRef?: GitRef; paths?: string[]; purpose?: string }): Promise<DocSessionMeta> {
    const cabinetDir = await this.lair.cabinet();
    const existing = await this.readMeta(cabinetDir, key);
    const now = new Date().toISOString();
    const commitRef = patch.commitRef ?? existing?.commitRef;
    if (!commitRef) {
      throw new Error(`No commitRef recorded for doc session ${key.repoKind}/${key.repoName}/${key.branch} — sessions must be opened via createSession before materialize/touch.`);
    }
    const merged: DocSessionMeta = {
      ...key,
      createdAt: existing?.createdAt ?? now,
      lastActivityAt: now,
      commitRef,
      paths: patch.paths ?? existing?.paths,
      purpose: patch.purpose ?? existing?.purpose,
    };
    await cabinetDir.createFile(this.metaRelPath(key), JSON.stringify(merged, null, 2));
    return merged;
  }

  private async readMeta(cabinetDir: Directory, key: DocSessionKey): Promise<DocSessionMeta | null> {
    const result = await cabinetDir.child(this.metaRelPath(key));
    if (!result.found || !result.node.is('file')) return null;
    try {
      return JSON.parse(await (result.node as File).read()) as DocSessionMeta;
    } catch {
      return null;
    }
  }

  private async walkMetaFiles(dir: Directory): Promise<File[]> {
    const files: File[] = [];
    for (const child of await dir.children()) {
      if (child.is('directory')) {
        files.push(...(await this.walkMetaFiles(child as Directory)));
      } else if (child.is('file') && child.name === META_FILE_NAME) {
        files.push(child as File);
      }
    }
    return files;
  }
}
