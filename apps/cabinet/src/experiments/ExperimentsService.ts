import type { Lair, File as FileNode, Worktree, Directory, WorkArea, WorkAreaFactories, MutableDirectoryLike } from '@minions/file-store';
import { asLairRepoName, createWorkAreaFactoriesForSandbox } from '@minions/file-store';
import { LairRepoPerspective, resolveConductorMirror } from '@minions/repo-perspective';
import type { WingManager } from '../wings/WingManager.js';

/**
 * Experiments: named, throne-room/conductor-driven parallel explorations.
 * Each variation gets its own `experiment/<id>/<slug>` trunk branch; wings
 * assigned to a variation have their `movement`/`plan` operations target
 * that branch instead of `main` — set via the design-doc-§4.2
 * `WorkArea.beginNewActiveMovement(branch, { base: Trunk })` surface (see
 * `retargetTrunk` below), matching `WingManager.setWingTrunk`'s SET path.
 * Clearing the override back to `main` calls
 * `workArea.clearActiveMovementBase()` — the `WorkArea` method that clears
 * BOTH the repo-level mechanism and the lower-level `--worktree`-scoped
 * `Worktree.setBaseBranch` primitive, matching `WingManager.setWingTrunk`'s
 * clear path. Clearing only the repo-level key would leave a stale value in
 * the worktree-scoped mechanism (see `SiteWorkArea.clearActiveMovementBase`'s
 * own doc comment, `@minions/file-store`, for why both must stay in sync).
 *
 * State lives at `.meta/conductor/experiments.json` on `main` (or an
 * experiment trunk), read/written through `resolveConductorMirror()`
 * (`@minions/repo-perspective`) — a design doc §4.1 `Mirror` that shares its
 * underlying worktree with the trunk's PLAN mirror (same `plan/<trunk>`
 * branch, just narrowed to `.meta/conductor` instead of `.meta/plan` — see
 * `resolveConductorMirror`'s own doc comment for the full rationale and
 * concurrency-safety argument). Every write below is a single
 * `Mirror.apply()` transform: real, once-only cross-worktree side effects
 * (branch creation/push, wing trunk retargeting) happen OUTSIDE the
 * transform closure, exactly once; only the actual `experiments.json`
 * read-mutate-write happens INSIDE the closure, so it's genuinely
 * re-computed fresh on every CAS-retry attempt (design doc §2 invariant B)
 * — matching the discipline `claim-node`/etc. follow for the plan mirror.
 * There is no separate `conductor/<trunk>` branch, no
 * `bootstrapConductorMirror`, and no commit-then-absorb two-step
 * (`MovementSession.absorbPlan`) — `apply()` commits and CAS-publishes
 * atomically, with its own retry loop.
 */

export type ExperimentStatus = 'open' | 'completing' | 'resolved';

export interface ExperimentVariation {
  slug: string;
  trunkBranch: string;
  wings: string[];
}

export interface ExperimentRecord {
  id: string;
  status: ExperimentStatus;
  variations: ExperimentVariation[];
  winner: string | null;
}

interface ExperimentsFile {
  experiments: ExperimentRecord[];
}

// ---- storage ----

/**
 * Builds the `WorkAreaFactories` (design doc §4.2) needed to construct the
 * target `Trunk` for a wing's `work/local` trunk-override assignment.
 * Mirrors `WingManager.ts`'s own `getWorkAreaFactories()` — same
 * `{cabinet}/movement-scratch` directory convention, so movement scratch
 * worktrees created by either call path land in one place — but built fresh
 * per call rather than cached on an instance: unlike `WingManager`, this
 * module has no long-lived instance to cache on, and assign/unassign/
 * select-winner calls are infrequent enough that the extra directory lookup
 * is not worth a module-level cache.
 */
async function getWorkAreaFactories(lair: Lair): Promise<WorkAreaFactories> {
  const cabinetDir = await lair.cabinet();
  const existing = await cabinetDir.child('movement-scratch');
  const scratchRoot: Directory =
    existing.found && existing.node.is('directory')
      ? (existing.node as Directory)
      : await cabinetDir.createDirectory('movement-scratch');
  return createWorkAreaFactoriesForSandbox(lair.sandbox, scratchRoot);
}

/**
 * Retargets a wing's `work/local` trunk override to `trunkBranch` via the
 * design-doc-§4.2 `Movement.base: Trunk` surface
 * (`WorkArea.beginNewActiveMovement`) — the same approach
 * `WingManager.setWingTrunk`'s SET path uses, not the raw
 * `Worktree.setBaseBranch` directly. `workArea`'s currently checked-out
 * branch already exists and is already checked out (it's an existing wing's
 * active work/local worktree), so this re-targets its base without creating
 * a new branch or moving the checkout.
 *
 * Takes a ready-made `WorkArea` rather than a raw `Worktree` — callers
 * already have one (`wing.workAreaLocal()`). `lair` is still needed here,
 * purely to build the `Trunk` for the NEW target branch via
 * `WorkAreaFactories.createTrunk` (constructing a `Trunk` is adapter-specific
 * — e.g. the disk/in-memory adapters both need a scratch-root convention —
 * and `WorkArea` itself doesn't expose its own factories publicly, matching
 * `WingManager.setWingTrunk`'s SET path, which does the same thing).
 */
async function retargetTrunk(lair: Lair, workArea: WorkArea, trunkBranch: string): Promise<void> {
  const factories = await getWorkAreaFactories(lair);
  const movement = await workArea.activeMovement();
  await workArea.beginNewActiveMovement(movement.branch, { base: factories.createTrunk(workArea.repo, trunkBranch) });
}

/**
 * `view` is a `Mirror.apply()` transform's own view (or, for reads, a fresh
 * `Mirror.files`) — always the mirror worktree's ROOT, narrowed to
 * `.meta/conductor` via `resolveConductorMirror`'s sparse checkout, so paths
 * here are still written relative to the worktree root (`.meta/conductor/…`),
 * not relative to the subtree itself.
 */
async function readExperimentsFile(view: MutableDirectoryLike): Promise<ExperimentsFile> {
  const metaResult = await view.child('.meta');
  if (!metaResult.found || metaResult.node.kind !== 'worktree') return { experiments: [] };
  const conductorResult = await (metaResult.node as Worktree).child('conductor');
  if (!conductorResult.found || conductorResult.node.kind !== 'worktree') return { experiments: [] };
  const fileResult = await (conductorResult.node as Worktree).child('experiments.json');
  if (!fileResult.found || fileResult.node.kind !== 'file') return { experiments: [] };
  try {
    const content = await (fileResult.node as FileNode).read();
    const parsed = JSON.parse(content) as Partial<ExperimentsFile>;
    return { experiments: parsed.experiments ?? [] };
  } catch {
    return { experiments: [] };
  }
}

async function writeExperimentsFile(view: MutableDirectoryLike, data: ExperimentsFile): Promise<void> {
  const metaResult = await view.child('.meta');
  const metaDir = metaResult.found && metaResult.node.kind === 'worktree'
    ? (metaResult.node as Worktree)
    : await view.createDirectory('.meta');
  const conductorResult = await metaDir.child('conductor');
  const conductorDir = conductorResult.found && conductorResult.node.kind === 'worktree'
    ? (conductorResult.node as Worktree)
    : await metaDir.createDirectory('conductor');
  const fileResult = await conductorDir.child('experiments.json');
  const content = JSON.stringify(data, null, 2) + '\n';
  if (fileResult.found && fileResult.node.kind === 'file') {
    await (fileResult.node as FileNode).write(content);
  } else {
    await conductorDir.createFile('experiments.json', content);
  }
}

// ---- reads ----

export async function listExperiments(lair: Lair, repo = 'local'): Promise<ExperimentRecord[]> {
  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  return (await readExperimentsFile(mirror.files)).experiments;
}

export async function getExperiment(lair: Lair, id: string, repo = 'local'): Promise<ExperimentRecord | null> {
  const experiments = await listExperiments(lair, repo);
  return experiments.find((e) => e.id === id) ?? null;
}

// ---- writes ----

export interface CreateExperimentVariationInput {
  slug: string;
}

/**
 * Creates an experiment: cuts an `experiment/<id>/<slug>` branch off current
 * `origin/main` for each variation (by name, no checkout — same pattern
 * `movement merge` uses to keep `main` free), then records it in
 * experiments.json. Variations start with no assigned wings — use
 * `assignWing` to attach one (which also sets that wing's trunk override).
 */
export async function createExperiment(
  lair: Lair,
  id: string,
  variationInputs: CreateExperimentVariationInput[],
  repo = 'local',
): Promise<ExperimentRecord> {
  if (!id.trim()) throw new Error('Experiment id must be non-empty');
  if (variationInputs.length === 0) throw new Error('An experiment needs at least one variation');
  for (const v of variationInputs) {
    if (!v.slug.trim()) throw new Error('Variation slug must be non-empty');
  }

  const workRepoResult = await lair.workRepo(repo);
  if (!workRepoResult.exists) throw new Error(`Work repo not found: ${repo}`);
  const bareRepo = workRepoResult.repo;

  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  const preflight = await readExperimentsFile(mirror.files);
  if (preflight.experiments.some((e) => e.id === id)) {
    throw new Error(`Experiment already exists: ${id}`);
  }

  try { await bareRepo.fetch(); } catch { /* offline, or no remote configured */ }

  // Real, once-only cross-worktree side effects (branch creation/push, plan
  // mirror bootstrap) — happen exactly once here, OUTSIDE the `apply()`
  // transform below (design doc §2 invariant B: only the actual
  // experiments.json mutation needs to be a pure, re-computable transform;
  // these do not, and re-running them on every CAS-retry would be wasteful
  // and, for the push, potentially confusing).
  const variations: ExperimentVariation[] = [];
  for (const v of variationInputs) {
    const trunkBranch = `experiment/${id}/${v.slug}`;
    try {
      await bareRepo.updateBranch(trunkBranch, 'origin/main');
    } catch {
      await bareRepo.updateBranch(trunkBranch, 'main');
    }
    try { await bareRepo.pushBranch(trunkBranch); } catch { /* best-effort */ }
    // Makes the new variation trunk's plan mirror immediately queryable via
    // `LairRepoPerspective`, which constructs a `DerivedTrunk`'s
    // `Trunk.mirror(...)` and needs no intertwining cascade to stay fresh
    // (plan/<trunk> is purely local, invariant A). No separate conductor
    // mirror bootstrap is needed — conductor state lives on the SAME
    // `plan/<trunk>` mirror (see `resolveConductorMirror`), materialized
    // lazily the first time anything actually writes to it.
    const trunkPerspective = await LairRepoPerspective.resolve(lair, asLairRepoName(repo), trunkBranch);
    await trunkPerspective.worktree.children();
    variations.push({ slug: v.slug, trunkBranch, wings: [] });
  }

  const record: ExperimentRecord = { id, status: 'open', variations, winner: null };
  await mirror.apply(async (view) => {
    // Re-checked fresh against this attempt's own view (design doc §2
    // invariant B) — not just the `preflight` read above, which could be
    // stale by the time this transform actually runs (first attempt or a
    // CAS-retry after losing a race).
    const data = await readExperimentsFile(view);
    if (data.experiments.some((e) => e.id === id)) {
      throw new Error(`Experiment already exists: ${id}`);
    }
    data.experiments.push(record);
    await writeExperimentsFile(view, data);
  });

  return record;
}

/**
 * Assigns a wing to a variation: sets the wing's `work/local` trunk override
 * to that variation's `trunkBranch` (see `retargetTrunk` above) and records
 * the assignment in experiments.json. Idempotent for the JSON side —
 * re-assigning a wing already listed just re-applies the trunk override.
 */
export async function assignWing(
  lair: Lair,
  wingManager: WingManager,
  id: string,
  slug: string,
  wingName: string,
  repo = 'local',
): Promise<ExperimentRecord> {
  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  const preflight = await readExperimentsFile(mirror.files);
  const experiment = preflight.experiments.find((e) => e.id === id);
  if (!experiment) throw new Error(`Experiment not found: ${id}`);
  const variation = experiment.variations.find((v) => v.slug === slug);
  if (!variation) throw new Error(`Variation not found: ${id}/${slug}`);

  const wing = wingManager.getWing(wingName);
  if (!wing) throw new Error(`Wing not found: ${wingName}`);
  const workArea = await wing.workAreaLocalIfExists();
  if (!workArea) throw new Error(`Wing ${wingName} has no work/local worktree`);
  // Real, once-only cross-worktree side effect — see `createExperiment`'s
  // matching comment.
  await retargetTrunk(lair, workArea, variation.trunkBranch);

  let result = experiment;
  await mirror.apply(async (view) => {
    const data = await readExperimentsFile(view);
    const freshExperiment = data.experiments.find((e) => e.id === id);
    if (!freshExperiment) throw new Error(`Experiment not found: ${id}`);
    const freshVariation = freshExperiment.variations.find((v) => v.slug === slug);
    if (!freshVariation) throw new Error(`Variation not found: ${id}/${slug}`);
    if (!freshVariation.wings.includes(wingName)) {
      freshVariation.wings.push(wingName);
      await writeExperimentsFile(view, data);
    }
    result = freshExperiment;
  });

  return result;
}

/**
 * Unassigns a wing from a variation: clears the wing's `work/local` trunk
 * override (back to ordinary main-tracked behavior) and removes it from
 * experiments.json. Idempotent for the JSON side — unassigning a wing not
 * listed is a no-op.
 */
export async function unassignWing(
  lair: Lair,
  wingManager: WingManager,
  id: string,
  slug: string,
  wingName: string,
  repo = 'local',
): Promise<ExperimentRecord> {
  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  const preflight = await readExperimentsFile(mirror.files);
  const experiment = preflight.experiments.find((e) => e.id === id);
  if (!experiment) throw new Error(`Experiment not found: ${id}`);
  const variation = experiment.variations.find((v) => v.slug === slug);
  if (!variation) throw new Error(`Variation not found: ${id}/${slug}`);

  const wing = wingManager.getWing(wingName);
  if (wing) {
    // Clearing (not just retargeting) calls `clearActiveMovementBase()` —
    // see the module doc comment above. Real, once-only cross-worktree side
    // effect — see `createExperiment`'s matching comment.
    const workArea = await wing.workAreaLocalIfExists();
    if (workArea) {
      await workArea.clearActiveMovementBase();
    }
  }

  let result = experiment;
  await mirror.apply(async (view) => {
    const data = await readExperimentsFile(view);
    const freshExperiment = data.experiments.find((e) => e.id === id);
    if (!freshExperiment) throw new Error(`Experiment not found: ${id}`);
    const freshVariation = freshExperiment.variations.find((v) => v.slug === slug);
    if (!freshVariation) throw new Error(`Variation not found: ${id}/${slug}`);
    if (freshVariation.wings.includes(wingName)) {
      freshVariation.wings = freshVariation.wings.filter((w) => w !== wingName);
      await writeExperimentsFile(view, data);
    }
    result = freshExperiment;
  });

  return result;
}

/**
 * Selects a winner (throne-room only — enforced by the caller, not here):
 * frees every wing on every non-winning variation back to ordinary
 * main-tracked behavior (the winner's wings stay assigned — they carry on
 * until `movement promote` resolves the experiment), then sets status to
 * `completing` and records the winning slug so a subsequent `movement
 * promote` (see the `movement promote action` plan child) knows which trunk
 * to fold into `main`.
 */
export async function selectWinner(
  lair: Lair,
  wingManager: WingManager,
  id: string,
  winnerSlug: string,
  repo = 'local',
): Promise<ExperimentRecord> {
  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  const preflight = await readExperimentsFile(mirror.files);
  const experiment = preflight.experiments.find((e) => e.id === id);
  if (!experiment) throw new Error(`Experiment not found: ${id}`);
  if (experiment.status !== 'open') {
    throw new Error(`Experiment "${id}" is not open (status: ${experiment.status})`);
  }
  if (!experiment.variations.some((v) => v.slug === winnerSlug)) {
    throw new Error(`Variation not found: ${id}/${winnerSlug}`);
  }

  // Real, once-only cross-worktree side effects — see `createExperiment`'s
  // matching comment.
  for (const variation of experiment.variations) {
    if (variation.slug === winnerSlug) continue;
    for (const wingName of variation.wings) {
      const wing = wingManager.getWing(wingName);
      if (!wing) continue;
      const workArea = await wing.workAreaLocalIfExists();
      if (!workArea) continue;
      // Clear path — see `unassignWing`'s matching comment.
      await workArea.clearActiveMovementBase();
    }
  }

  let result = experiment;
  await mirror.apply(async (view) => {
    const data = await readExperimentsFile(view);
    const freshExperiment = data.experiments.find((e) => e.id === id);
    if (!freshExperiment) throw new Error(`Experiment not found: ${id}`);
    if (freshExperiment.status !== 'open') {
      throw new Error(`Experiment "${id}" is not open (status: ${freshExperiment.status})`);
    }
    if (!freshExperiment.variations.some((v) => v.slug === winnerSlug)) {
      throw new Error(`Variation not found: ${id}/${winnerSlug}`);
    }
    for (const variation of freshExperiment.variations) {
      if (variation.slug !== winnerSlug) variation.wings = [];
    }
    freshExperiment.status = 'completing';
    freshExperiment.winner = winnerSlug;
    await writeExperimentsFile(view, data);
    result = freshExperiment;
  });

  return result;
}

/**
 * Marks an experiment resolved and frees every wing across every variation —
 * winner and losers alike — back to ordinary `main`-tracked behavior. Not
 * exposed via the `experiments` MCP tool: called internally by `movement
 * promote` (the next plan child) once the actual merge to `main` succeeds,
 * never by the throne room directly.
 */
export async function resolveExperiment(
  lair: Lair,
  wingManager: WingManager,
  id: string,
  repo = 'local',
): Promise<ExperimentRecord> {
  const workRepoResult = await lair.workRepo(repo);
  if (!workRepoResult.exists) throw new Error(`Work repo not found: ${repo}`);

  const mirror = await resolveConductorMirror(lair, asLairRepoName(repo));
  const preflight = await readExperimentsFile(mirror.files);
  const experiment = preflight.experiments.find((e) => e.id === id);
  if (!experiment) throw new Error(`Experiment not found: ${id}`);
  if (experiment.status !== 'completing') {
    throw new Error(`Experiment "${id}" is not completing (status: ${experiment.status})`);
  }

  // Real, once-only cross-worktree side effects — see `createExperiment`'s
  // matching comment.
  for (const variation of experiment.variations) {
    for (const wingName of variation.wings) {
      const wing = wingManager.getWing(wingName);
      if (!wing) continue;
      const workArea = await wing.workAreaLocalIfExists();
      if (!workArea) continue;
      // Clear path — see `unassignWing`'s matching comment.
      await workArea.clearActiveMovementBase();
    }
  }

  let result = experiment;
  await mirror.apply(async (view) => {
    const data = await readExperimentsFile(view);
    const freshExperiment = data.experiments.find((e) => e.id === id);
    if (!freshExperiment) throw new Error(`Experiment not found: ${id}`);
    if (freshExperiment.status !== 'completing') {
      throw new Error(`Experiment "${id}" is not completing (status: ${freshExperiment.status})`);
    }
    freshExperiment.status = 'resolved';
    for (const variation of freshExperiment.variations) {
      variation.wings = [];
    }
    await writeExperimentsFile(view, data);
    result = freshExperiment;
  });

  return result;
}
