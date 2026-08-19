import type { Lair, Wing, Worktree, BareRepository, WingName, RepoAlias, WorkArea } from '@minions/file-store';
import { asLairRepoName, resolveMovementBase } from '@minions/file-store';
import { LairRepoPerspective } from './LairRepoPerspective.js';

/**
 * The full context for a wing-scoped action, in any current or future
 * action group: the wing's own worktree for `repoAlias`, plus the `Wing`
 * and `Lair` objects it hangs off of. This is the ONE way any wing-scoped
 * MCP action resolves its working context — never re-derive wing/worktree
 * resolution ad hoc in an action body.
 */
export class WingPerspective {
  private constructor(
    readonly wingName: WingName,
    readonly repoAlias: RepoAlias,
    readonly wing: Wing,
    readonly worktree: Worktree,
  ) {}

  get lair(): Lair {
    return this.wing.lair;
  }

  get bareRepo(): BareRepository {
    return this.worktree.repository;
  }

  /**
   * The design doc §4.2 `WorkArea` for this perspective's own repo/worktree —
   * the intended replacement surface for `this.worktree`, added here so
   * callers that only need `WorkArea.activeMovement()`/
   * `beginNewActiveMovement()` (not the raw `Worktree` itself) can migrate
   * off the public `worktree` field one call site at a time, without every
   * consumer of `WingPerspective` having to move in lockstep. Mirrors
   * `WingPerspective.resolve`'s own local-vs-named branching, since `Wing`
   * has no single "work area for whatever repoAlias this perspective
   * resolved" accessor. This is the shared accessor for that lookup — call
   * `perspective.workArea()` rather than re-deriving it locally.
   *
   * Lazy, not eager: this resolves on first call, not during `resolve()`
   * itself, because `wing.workAreaLocal()`/`workAreaNamed()` throw unless the
   * `Lair` was constructed with `WorkAreaFactories` (`Wing.ts`'s own doc
   * comment) — many `WingPerspective.resolve()` callers (e.g.
   * `PlanActionGroup.ts`) build their `Lair` without them today and never
   * need a `WorkArea` at all, so eagerly resolving one here would needlessly
   * break them. Calling `workArea()` without factories throws the same clear
   * error `wing.workAreaLocal()` already throws — no new failure mode.
   */
  async workArea(): Promise<WorkArea> {
    if (this.repoAlias === 'local') {
      return this.wing.workAreaLocal();
    }
    const workArea = await this.wing.workAreaNamed(this.repoAlias);
    if (!workArea) {
      throw new Error(
        `Repo '${this.repoAlias}' has no WorkArea (missing worktree, or a same-repo subdir junction with no worktree of its own).`,
      );
    }
    return workArea;
  }

  static async resolve(lair: Lair, wingName: WingName, repoAlias: RepoAlias): Promise<WingPerspective> {
    const wingResult = await lair.wing(wingName);
    if (!wingResult.exists) throw new Error(`Wing not found: ${wingName}`);
    const wing = wingResult.wing;

    if (repoAlias === 'local') {
      const workLocalResult = await wing.workLocal();
      if (!workLocalResult.exists) throw new Error(`Wing ${wingName} has no work/local worktree`);
      return new WingPerspective(wingName, repoAlias, wing, workLocalResult.worktree);
    }

    const named = await wing.workNamed(repoAlias);
    if (!named.exists) {
      const available = await wing.namedWorkNames();
      throw new Error(
        `Repo '${repoAlias}' not found for wing ${wingName}. Available repos: local${available.length ? ', ' + available.join(', ') : ''}`
      );
    }
    if (!('worktree' in named) || !named.worktree) {
      throw new Error(`Repo '${repoAlias}' is a same-repo subdir link and is not yet supported here`);
    }
    return new WingPerspective(wingName, repoAlias, wing, named.worktree);
  }

  /**
   * The trivial hop to this wing repo's corresponding lair-registered
   * perspective — by the backing `BareRepository`'s registered lair name,
   * not by physical `RepoId`/URL canonicalization. Within one lair, a
   * registered name and the physical repo it names are already 1:1
   * (`lair.addWorkRepo(name, url)`), so this needs no extra I/O beyond
   * what `resolve` already did.
   *
   * Resolves to *this wing's own trunk's* plan mirror (via
   * `resolveMovementBase()` — design doc §4.2's `Movement.base: Trunk`
   * persistence, with a fallback to the `--worktree`-scoped override for any
   * wing whose base hasn't been re-persisted under the repo-level key since —
   * see `resolveMovementBase`'s own doc comment) — a wing whose trunk is
   * overridden to an experiment branch lands on that experiment's shared plan
   * tree here automatically, with no special-casing.
   */
  async toLairRepo(): Promise<LairRepoPerspective> {
    // BareRepository.name carries a ".git" suffix; the lair-registered name
    // (what lair.workRepo()/lair.addWorkRepo() key on) does not.
    const trunk = await resolveMovementBase(this.bareRepo, this.worktree);
    return LairRepoPerspective.resolve(this.lair, asLairRepoName(this.bareRepo.name.replace(/\.git$/, '')), trunk);
  }
}
