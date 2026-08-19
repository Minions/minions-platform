import { createLair, asLairRepoName } from '@minions/file-store';
import type { Sandbox, Worktree, Directory, File, BareRepository } from '@minions/file-store';
import { resolvePlanDir, serializeContent, serializeClaims, asNodeId } from '@minions/planner';
import type { ContentFields, ClaimFields } from '@minions/planner';
import { LairRepoPerspective } from '@minions/repo-perspective';
import type { SelfHeal } from './types.js';

/**
 * Keeps every lair-level `plan/<trunk>` mirror on the current content.toml +
 * claims.toml format, converting any leftover one-file-per-subtree
 * index.json it finds — see `findAllPlanMirrors` for why wing worktrees are
 * never touched directly.
 *
 * The write path is a single `Mirror.apply()` transform per (repo, trunk)
 * pair (design doc §4.5 shape, matching
 * `libs/planner/src/PlanActionGroup.ts`'s `applyAtLairWrite()`). Two things
 * fall out of that for free: (1) no explicit pre-write resync is needed —
 * `Mirror.apply()` handles that itself (design doc §2 invariant A:
 * optimistic first attempt, reactive scoped fetch only after an actual
 * rejected push, retry against the fresh tip); (2) no separate
 * `absorbPlan()`/force-push-`plan/<trunk>` step is needed either — `apply()`
 * publishes straight to `<trunk>` (e.g. `main`) via a direct CAS push to
 * origin, which is the correct target per invariant A (`plan/<trunk>` itself
 * is purely local, per design doc §4.2, never pushed anywhere).
 */
interface LegacyPlanItem {
  id: string;
  title: string;
  type: 'task' | 'fork' | 'option';
  parent: string | null;
  children: string[];
  requires: string[];
  exploring?: Record<string, string>;
  criteria: string[];
  approved: false | true | 'tentative';
  demoLink?: string;
  claimedBy?: { wing: string; branch: string };
  questions: string[];
  planning_done?: boolean;
  ready?: boolean;
  places?: ContentFields['places'];
}

interface LegacySubtreeIndex {
  root: string;
  items: Record<string, LegacyPlanItem>;
}

const APPROVAL_RANK: Record<string, number> = { false: 0, tentative: 1, true: 2 };
const RANK_TO_APPROVAL: Array<false | 'tentative' | true> = [false, 'tentative', true];

/**
 * `approved` and the now-retired `planning_done` field tracked overlapping
 * "is this ready to move forward" state from two different write paths
 * (throne room vs. cabinet) that drifted out of sync with each other. Take
 * whichever signal was further along, rather than trusting one and
 * discarding the other: false < tentative < true, and planning_done=true
 * counts as at least as strong a signal as approved=true.
 */
function reconcileApproved(approved: false | true | 'tentative', planningDone: boolean | undefined): false | true | 'tentative' {
  const planningRank = planningDone === true ? APPROVAL_RANK['true'] : APPROVAL_RANK['false'];
  const approvedRank = APPROVAL_RANK[String(approved)] ?? 0;
  return RANK_TO_APPROVAL[Math.max(planningRank, approvedRank)];
}

async function writeFileEnsuring(dir: Worktree | Directory, name: string, content: string): Promise<void> {
  const existing = await dir.child(name);
  if (existing.found && existing.node.kind === 'file') {
    await (existing.node as File).write(content);
  } else {
    await dir.createFile(name, content);
  }
}

/** Root ids (subdirectory names) under planDir that still have an index.json. */
async function findLegacyRoots(planDir: Worktree | Directory): Promise<string[]> {
  const children = await planDir.children();
  const roots: string[] = [];
  for (const child of children) {
    if (child.kind !== 'worktree' && child.kind !== 'directory') continue;
    const idx = await child.child('index.json');
    if (idx.found && idx.node.kind === 'file') roots.push(child.name);
  }
  return roots;
}

async function healRoot(rootDir: Worktree | Directory): Promise<void> {
  const idxResult = await rootDir.child('index.json');
  if (!idxResult.found || idxResult.node.kind !== 'file') return;
  const raw = await idxResult.node.read();
  const old = JSON.parse(raw) as LegacySubtreeIndex;

  const order = Object.keys(old.items).map(asNodeId);
  const content: Record<string, ContentFields> = {};
  const claims: Record<string, ClaimFields> = {};

  for (const [id, item] of Object.entries(old.items)) {
    content[id] = {
      title: item.title,
      type: item.type,
      parent: item.parent !== null ? asNodeId(item.parent) : null,
      children: item.children.map(asNodeId),
      requires: item.requires.map(asNodeId),
      exploring: item.exploring,
      criteria: item.criteria,
      approved: reconcileApproved(item.approved, item.planning_done),
      questions: item.questions,
      ready: item.ready,
      places: item.places,
    };
    if (item.claimedBy || item.demoLink !== undefined) {
      claims[id] = { claimedBy: item.claimedBy, demoLink: item.demoLink };
    }
  }

  await writeFileEnsuring(rootDir, 'content.toml', serializeContent(order, content));
  if (Object.keys(claims).length > 0) {
    await writeFileEnsuring(rootDir, 'claims.toml', serializeClaims(claims));
  }
  await (idxResult.node as File).delete();
}

interface PlanMirrorEntry {
  planDir: Worktree | Directory;
  bareRepo: BareRepository;
  trunk: string;
}

const PLAN_MIRROR_PREFIX = 'plan/';

/**
 * Finds every lair-level `plan/<trunk>` mirror's plan directory, across
 * every lair-registered repo. Deliberately excludes wing worktrees: this
 * heal only ever writes to a mirror, via a `Mirror.apply()` that commits and
 * publishes straight onto `<trunk>` — a wing gets the migrated files for free
 * the next time it runs
 * `movement start` (fetches/rebases onto origin/<trunk>) or `merge`, once
 * the mirror heal has landed the migration on `<trunk>`. Healing a wing's
 * own worktree directly would just be redundant with that, and would leave
 * an uncommitted edit sitting in the wing's tree with no absorb path of its
 * own to land it anywhere.
 *
 * `bareRepo.worktrees()` + `wt.currentBranch()` below are both raw
 * `BareRepository`/`Worktree` surface marked for eventual removal (design
 * doc §5), so this loop is a known, outstanding low-level usage. It is
 * DELIBERATELY left as raw worktree scanning
 * rather than rewritten against the higher-level object model, because the
 * only alternative available there is not mechanical: enumerating every
 * KNOWN trunk via `Lair`/`WorkRepo` (`main()` + `experiments()` ->
 * `variations()`) and checking each one's `Plan.mirror` for legacy data
 * would force-materialize a mirror worktree for every registered repo's
 * every trunk on every self-heal `check()`/`heal()` pass —
 * `trunk.mirror(branch)` construction itself is cheap/lazy (confirmed by
 * reading `DiskTrunk.mirror()`), but reading `mirror.files` (needed to look
 * for `index.json`) is not, and would reintroduce exactly the eager
 * every-repo-mirror-bootstrap-on-every-pass behavior cabinet startup
 * deliberately avoids (see this file's own `heal()` comment below, which
 * relies on that avoidance to explain why a freshly-registered/rarely-used
 * repo yielding zero mirrors is "self-limiting", not a bug). The
 * higher-level object model has no primitive for "does a mirror already
 * have a materialized worktree, without creating one" — that query is
 * exactly the raw-worktree-enumeration surface §5 marks for deletion, and
 * no replacement exists for it yet. Swapping this loop's discovery strategy
 * therefore requires a real design decision (accept eager materialization
 * on every pass? track known-materialized mirrors some other way?
 * something else?), not a mechanical call-site change — deferred for now.
 */
async function findAllPlanMirrors(lair: Sandbox): Promise<PlanMirrorEntry[]> {
  const lairHandle = createLair(lair);
  const repos = await lairHandle.workRepos();
  const entries: PlanMirrorEntry[] = [];
  for (const bareRepo of repos) {
    const worktrees = await bareRepo.worktrees();
    for (const wt of worktrees) {
      try {
        const branch = await wt.currentBranch();
        if (!branch.startsWith(PLAN_MIRROR_PREFIX)) continue;
        const planDir = await resolvePlanDir(wt, lair);
        if (planDir) entries.push({ planDir, bareRepo, trunk: branch.slice(PLAN_MIRROR_PREFIX.length) });
      } catch {
        // A worktree that can't be read (missing, corrupt) is skipped —
        // nothing for this heal to fix there.
      }
    }
  }
  return entries;
}

/**
 * Heals one `(bareRepo, trunk)` pair's mirror inside a single
 * `Mirror.apply()` transform: re-finds legacy roots fresh against whatever
 * `view` `apply()` hands it (re-run in full on every CAS retry — invariant
 * B), converts each to content.toml/claims.toml, and lets `apply()` commit +
 * CAS-publish straight to `<trunk>` on origin. Resolves the SAME mirror
 * worktree `findAllPlanMirrors` discovered — `Mirror`'s own worktree-reuse
 * logic finds an existing worktree by branch name
 * (`LairRepoPerspective.resolve()`'s doc comment), so this doesn't fork a
 * second, disconnected checkout.
 *
 * Returns the number of roots healed; throws on persistent publish
 * contention (bounded retries inside `apply()`) — the caller logs and moves
 * on to the next repo rather than letting one repo's contention stop the
 * whole pass.
 */
async function healMirrorViaApply(lair: Sandbox, bareRepo: BareRepository, trunk: string): Promise<number> {
  const lairHandle = createLair(lair);
  // `bareRepo.name` is the child node's own name (e.g. "local.git" — the
  // `${name}.git` convention `Lair.workRepo()`/`workRepos()` store it under),
  // but `LairRepoPerspective.resolve()` wants the bare repo NAME as
  // registered (it appends `.git` itself internally) — strip the suffix.
  const repoName = asLairRepoName(bareRepo.name.endsWith('.git') ? bareRepo.name.slice(0, -'.git'.length) : bareRepo.name);
  const perspective = await LairRepoPerspective.resolve(lairHandle, repoName, trunk);
  const { result } = await perspective.mirror.apply(async (view) => {
    const planDir = (await resolvePlanDir(view as Worktree, lair)) as Worktree | Directory | null;
    if (!planDir) return 0;
    const legacyRoots = await findLegacyRoots(planDir);
    for (const rootId of legacyRoots) {
      const rootDirResult = await planDir.child(rootId);
      if (!rootDirResult.found || (rootDirResult.node.kind !== 'worktree' && rootDirResult.node.kind !== 'directory')) continue;
      await healRoot(rootDirResult.node as Worktree | Directory);
    }
    return legacyRoots.length;
  });
  return result;
}

export const planTomlFormatHeal: SelfHeal = {
  id: 'plan-toml-format',
  description: 'convert .meta/plan/*/index.json to content.toml + claims.toml',
  async check(lair) {
    for (const { planDir } of await findAllPlanMirrors(lair)) {
      if ((await findLegacyRoots(planDir)).length > 0) return false;
    }
    return true;
  },
  async heal(lair) {
    let total = 0;
    // Discovery is by scanning already-checked-out `plan/*` worktrees — a
    // cheap, read-only way to find which repos actually have stale-format
    // data before doing any real work. `findAllPlanMirrors` finds FEWER (or
    // zero) mirrors for a freshly-registered or rarely-used repo, since
    // cabinet startup does not eagerly bootstrap every repo's mirror —
    // self-limiting (no legacy data is lost or corrupted; a repo with no
    // mirror worktree yet has no stale format to find there either), not
    // silently broken.
    for (const { planDir, bareRepo, trunk } of await findAllPlanMirrors(lair)) {
      const legacyRoots = await findLegacyRoots(planDir);
      if (legacyRoots.length === 0) continue;

      // No explicit pre-write resync, and no separate commit-then-absorb
      // step — see this file's header comment: `healMirrorViaApply`'s single
      // `Mirror.apply()` call handles both freshness (invariant A) and
      // publishing (a direct CAS push to `trunk` on origin) as one atomic
      // step. One repo's persistent publish contention is logged and skipped
      // rather than stopping the whole pass — the self-heal registry re-runs
      // `check`/`heal` on its own schedule, so a losing repo just waits for
      // the next pass rather than needing anything to "call again".
      try {
        total += await healMirrorViaApply(lair, bareRepo, trunk);
      } catch (err) {
        console.error(
          `[self-heal] plan-toml-format: failed to heal plan/${trunk} mirror (continuing):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.log(`[self-heal] plan-toml-format: converted ${total} root(s)`);
  },
};
