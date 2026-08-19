import { describe, it, expect, vi } from 'vitest';
import { createInMemorySandbox, createLair, canonicalizeRepoUrl, repoIdToDirName, asRepoAlias, asLairRepoName, simulateRemote } from '@minions/file-store';
import type { Directory, Sandbox } from '@minions/file-store';
import { dispatchActionGroup } from '@minions/mcp-types';
import type { ActionContext } from '@minions/mcp-types';
import { LairRepoPerspective } from '@minions/repo-perspective';
import { createPlanActionGroup, shouldTriggerFullSyncAfterAbsorb } from './PlanActionGroup.js';
import { serializeContent, type ContentFields } from './adapters/worktree/planToml.js';
import { asNodeId } from '@minions/planner-types';
import type { PlanItem } from '@minions/planner-types';

async function ensureDir(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.is('directory')) return result.node as Directory;
  return parent.createDirectory(name);
}

/** Writes a one-root content.toml fixture directly, bypassing the store (these tests seed raw plan data to prove routing/resolution, not store behavior). */
interface FixtureItem {
  id: string;
  title?: string;
  type?: ContentFields['type'];
  parent?: string | null;
  children?: string[];
  requires?: string[];
  criteria?: string[];
  approved?: ContentFields['approved'];
  questions?: string[];
}

async function writeContentFixture(
  worktree: { createFile(path: string, content: string): Promise<unknown> },
  rootId: string,
  items: Record<string, FixtureItem>,
): Promise<void> {
  const order = Object.keys(items).map(asNodeId);
  const full: Record<string, ContentFields> = {};
  for (const [id, partial] of Object.entries(items)) {
    full[id] = {
      title: partial.title ?? '',
      type: partial.type ?? 'task',
      parent: partial.parent != null ? asNodeId(partial.parent) : null,
      children: (partial.children ?? []).map(asNodeId),
      requires: (partial.requires ?? []).map(asNodeId),
      criteria: partial.criteria ?? [],
      approved: partial.approved ?? true,
      questions: partial.questions ?? [],
    };
  }
  await worktree.createFile(`.meta/plan/${rootId}/content.toml`, serializeContent(order, full));
}

/**
 * Loose shape covering the plan action-group responses this test file asserts on.
 * `dispatchActionGroup` itself returns `unknown` (its result shape is action-specific),
 * so this is a test-local view of "the properties these tests happen to read."
 */
interface PlanActionResult {
  action: string;
  subtree: { items: Record<string, PlanItem> } | null;
  leaves: Record<string, Record<string, unknown>>;
  roots: Array<{ id: string; title: string }>;
  commitResult?: { success: boolean } | { committed: boolean; commitHash?: string; attempts: number };
  [key: string]: unknown;
}

/** Dispatches `action` through the real atWing/atLair-by-endpoint framework, not a raw execute() call. */
async function callPlan(sandbox: Sandbox, wingName: string | undefined, action: string, params: Record<string, unknown>): Promise<PlanActionResult> {
  const ctx: ActionContext<Sandbox> = wingName === undefined ? { lair: sandbox } : { lair: sandbox, wingName };
  return dispatchActionGroup(createPlanActionGroup(), { action, ...params }, ctx) as Promise<PlanActionResult>;
}

function seedItem(id: string, title: string) {
  return {
    id,
    title,
    type: 'task' as const,
    parent: null,
    children: [],
    requires: [],
    criteria: [],
    approved: true as const,
    questions: [],
  };
}

describe('list-roots via LairRepoPerspective (in-memory fixtures)', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  /**
   * A lair whose "local" work repo (identified by REPO_URL) has a
   * plan/main sparse-checkout worktree already sitting at
   * cabinet/planning/<repo-id>/ — the steady-state layout that
   * MovementActionGroup's syncPlanBranch produces — seeded with a
   * `.meta/plan` item.
   */
  async function makeFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);

    const repoId = repoIdToDirName(canonicalizeRepoUrl(REPO_URL));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');

    await writeContentFixture(planWorktree, 'abc12345', { abc12345: seedItem('abc12345', 'Seeded root') });

    return { sandbox, bareRepo };
  }

  it('list-roots reads the seeded plan item through the canonical-identity-resolved worktree', async () => {
    const { sandbox } = await makeFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'abc12345', title: 'Seeded root' }] });
  });

  it('list-roots rejects with no wingName and no repo — there is no single lair-wide "the" plan repo to default to', async () => {
    const { sandbox } = await makeFixture();

    await expect(callPlan(sandbox, undefined, 'list-roots', {})).rejects.toThrow(/repo is required/);
  });

  it('a MAIN plan-view load (one list-roots plus many get-subtree calls) never fetches or pushes — the mirror already exists, so reads cost no extra git round trip', async () => {
    const { sandbox, bareRepo } = await makeFixture();
    const fetchSpy = vi.spyOn(bareRepo, 'fetch');
    const pushSpy = vi.spyOn(bareRepo, 'pushBranch');

    await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });
    for (let i = 0; i < 15; i++) {
      await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'abc12345', repo: 'local' });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('list-roots/get-subtree with a trunk param, no wingName (in-memory fixtures)', () => {
  /**
   * A lair whose "local" work repo has both a plan/main mirror and a
   * plan/<trunk> mirror for an experiment variation trunk, seeded with
   * different roots each — proves the `trunk` param (added alongside
   * `repo` for non-wing reads, e.g. the throne room's experiment-scope
   * plan selector) picks which mirror gets read, independent of `repo`.
   */
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';
  const TRUNK = 'experiment/faster-cache/redis';

  async function makeTrunkFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);

    const repoId = repoIdToDirName(canonicalizeRepoUrl(REPO_URL));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');

    const mainWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(mainWorktree, 'main-root', { 'main-root': seedItem('main-root', 'Main root') });

    const trunkWorktree = await bareRepo.createSparseWorktree(planningDir, `${repoId}/experiment-faster-cache-redis`, `plan/${TRUNK}`, '.meta/plan');
    await writeContentFixture(trunkWorktree, 'redis-root', { 'redis-root': seedItem('redis-root', 'Redis variation root') });

    return { sandbox };
  }

  it('list-roots with no trunk param reads plan/main', async () => {
    const { sandbox } = await makeTrunkFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'main-root', title: 'Main root' }] });
  });

  it('list-roots with a trunk param reads that trunk\'s plan mirror instead of plan/main', async () => {
    const { sandbox } = await makeTrunkFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local', trunk: TRUNK });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'redis-root', title: 'Redis variation root' }] });
  });

  it('get-subtree with a trunk param reads that trunk\'s plan mirror', async () => {
    const { sandbox } = await makeTrunkFixture();

    const result = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'redis-root', repo: 'local', trunk: TRUNK });

    expect(result.subtree?.items['redis-root']?.title).toBe('Redis variation root');
  });

  it('get-subtree with a trunk param does not see plan/main\'s items', async () => {
    const { sandbox } = await makeTrunkFixture();

    const result = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'main-root', repo: 'local', trunk: TRUNK });

    expect(result).toEqual({ action: 'get-subtree', subtree: null });
  });
});

describe('plan/main actions with a repo param, no wingName (in-memory fixtures)', () => {
  /**
   * A lair with two lair-registered work repos, each with its own
   * plan/main-equivalent sparse-checkout worktree at cabinet/planning/<repo-id>/:
   * "local" seeded with "default-root", and a second registered repo ("other")
   * seeded with "other-root". Neither is a "default" — with no wingName to
   * alias through, `repo` is required and must name one explicitly; these
   * tests prove list-roots/get-subtree resolve whichever physical repo `repo`
   * names.
   */
  async function makeMultiRepoFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');

    const defaultUrl = 'https://example.com/CodeWarp/default-repo.git';
    const defaultBare = await lair.addWorkRepo('local', defaultUrl);
    const defaultRepoId = repoIdToDirName(canonicalizeRepoUrl(defaultUrl));
    const defaultWorktree = await defaultBare.createSparseWorktree(planningDir, defaultRepoId, 'plan/main', '.meta/plan');
    await writeContentFixture(defaultWorktree, 'default-root', { 'default-root': seedItem('default-root', 'Default repo root') });

    const otherUrl = 'https://example.com/CodeWarp/other-repo.git';
    const otherBare = await lair.addWorkRepo('other', otherUrl);
    const otherRepoId = repoIdToDirName(canonicalizeRepoUrl(otherUrl));
    const otherWorktree = await otherBare.createSparseWorktree(planningDir, otherRepoId, 'plan/main', '.meta/plan');
    await writeContentFixture(otherWorktree, 'other-root', { 'other-root': seedItem('other-root', 'Other repo root') });

    // A real wing whose own named work repo "other" aliases the lair-registered
    // "other" repo — proves claim-node's atWing resolves `repo` through the
    // calling wing's own alias wiring (WingPerspective#toLairRepo), not a
    // bare lair.workRepo(repo) lookup that ignores which wing is calling.
    await lair.createWing('workshop-03', {
      workLocal: { repo: 'local', branch: 'main' },
      extraWork: { other: { repo: 'other', branch: 'main' } },
    });

    return { sandbox };
  }

  it('list-roots rejects when repo is omitted and there is no wingName to alias through', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    await expect(callPlan(sandbox, undefined, 'list-roots', {})).rejects.toThrow(/repo is required/);
  });

  it('list-roots reads a lair-registered repo named by repo', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'default-root', title: 'Default repo root' }] });
  });

  it('list-roots reads a different lair-registered repo when repo is set', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'other' });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'other-root', title: 'Other repo root' }] });
  });

  it('get-subtree reads a different lair-registered repo when repo is set, no wingName', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    const result = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'other-root', repo: 'other' });

    expect(result.subtree?.items['other-root']?.title).toBe('Other repo root');
  });

  it('get-subtree rejects when repo is omitted and there is no wingName to alias through', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    await expect(callPlan(sandbox, undefined, 'get-subtree', { itemId: 'other-root' })).rejects.toThrow(/repo is required/);
  });

  it('update-item (simple store write) writes to the repo named by the repo param, not the other repo', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    await callPlan(sandbox, undefined, 'update-item', { itemId: 'other-root', approved: false, repo: 'other' });

    const otherRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'other-root', repo: 'other' });
    expect(otherRead.subtree?.items['other-root']?.approved).toBe(false);

    const defaultRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'default-root', repo: 'local' });
    expect(defaultRead.subtree?.items['default-root']?.approved).toBe(true);
  });

  it('claim-node (atomic auto-commit write) claims a node in the repo named by the repo param', async () => {
    const { sandbox } = await makeMultiRepoFixture();

    const result = await callPlan(sandbox, 'workshop-03', 'claim-node', { nodeId: 'other-root', goalId: 'other-root', repo: 'other' });

    expect((result as { commitResult: { committed: boolean } }).commitResult.committed).toBe(true);

    const otherRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'other-root', repo: 'other' });
    expect(otherRead.subtree?.items['other-root']?.claimedBy?.wing).toBe('workshop-03');

    const defaultRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'default-root', repo: 'local' });
    expect(defaultRead.subtree?.items['default-root']?.claimedBy).toBeUndefined();
  });
});

describe('plan/main actions from a wing whose "local" alias is not literally named "local" (in-memory fixtures)', () => {
  /**
   * Some lairs register their primary work repo under a name other than
   * "local" (e.g. "minions") — a wing's work/local worktree still points at
   * it via `WingConfig.workLocal.repo`, but a literal `lair.workRepo('local')`
   * lookup finds nothing. claim-node/unclaim-node/mark-demo must still
   * resolve plan/main correctly by going through the calling wing's own
   * alias wiring (WingPerspective#toLairRepo) instead of assuming a
   * lair-level repo literally named "local".
   */
  async function makeRenamedLocalRepoFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const repoUrl = 'https://example.com/CodeWarp/suite.git';
    const bareRepo = await lair.addWorkRepo('minions', repoUrl);

    await lair.createWing('workshop-03', { workLocal: { repo: 'minions', branch: 'main' } });

    const repoId = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(planWorktree, 'root-id', { 'root-id': seedItem('root-id', 'Root') });

    return { sandbox };
  }

  it('claim-node succeeds with no repo param, resolving plan/main via the wing\'s own "local" alias', async () => {
    const { sandbox } = await makeRenamedLocalRepoFixture();

    const claimResult = await callPlan(sandbox, 'workshop-03', 'claim-node', { nodeId: 'root-id', goalId: 'root-id' });
    expect((claimResult as { commitResult: { committed: boolean } }).commitResult.committed).toBe(true);

    // unclaim-node also forces plan/main via the same "local" alias resolution;
    // it only succeeds if it can see the claim claim-node just wrote there —
    // proving both round-trip through the same physical repo, not two
    // different (and disconnected) stores.
    const unclaimResult = await callPlan(sandbox, 'workshop-03', 'unclaim-node', { nodeId: 'root-id' });
    expect((unclaimResult as { commitResult: { committed: boolean } }).commitResult.committed).toBe(true);
  });
});

describe('plan/main actions with no wing at all, whose "local" alias is not literally named "local" (in-memory fixtures)', () => {
  /**
   * The /mcp/throne "MAIN" plan view calls list-roots/get-subtree with no
   * wingName at all — there is no wing to alias "local" through, so
   * LairRepoPerspective.resolve falls all the way through to a literal
   * lair-level `lair.workRepo(...)` lookup. A lair can register any number
   * of work repos with no natural "the" one among them (e.g. the primary
   * repo here is registered as "minions", not "local"), so that literal
   * lookup has no implicit default at all: `repo` is required, and omitting
   * it must fail the call loudly rather than silently resolve to an empty
   * tree (the original bug) or silently guess the wrong repo in a
   * multi-repo lair.
   */
  async function makeNoWingRenamedLocalRepoFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const repoUrl = 'https://example.com/CodeWarp/suite.git';
    const bareRepo = await lair.addWorkRepo('minions', repoUrl);

    const repoId = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(planWorktree, 'root-id', { 'root-id': seedItem('root-id', 'Root') });

    return { sandbox };
  }

  it('list-roots rejects with no wingName and no repo param, rather than silently resolving nothing', async () => {
    const { sandbox } = await makeNoWingRenamedLocalRepoFixture();

    await expect(callPlan(sandbox, undefined, 'list-roots', {})).rejects.toThrow(/repo is required/);
  });

  it('list-roots resolves plan/main when repo names the lair-registered repo explicitly', async () => {
    const { sandbox } = await makeNoWingRenamedLocalRepoFixture();

    const result = await callPlan(sandbox, undefined, 'list-roots', { repo: 'minions' });

    expect(result).toEqual({ action: 'list-roots', roots: [{ id: 'root-id', title: 'Root' }] });
  });

  it('get-subtree resolves plan/main when repo names the lair-registered repo explicitly', async () => {
    const { sandbox } = await makeNoWingRenamedLocalRepoFixture();

    const result = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root-id', repo: 'minions' });

    expect(result.subtree?.items['root-id']?.title).toBe('Root');
  });
});

describe('plan actions with a wing repo param (in-memory fixtures)', () => {
  /**
   * A wing whose work/local is backed by "main-repo" (seeded with a
   * "local-root" plan item) and whose named extra work repo "extra" is
   * backed by a separate "extra-repo" (seeded with an "extra-root" plan
   * item) — so get-subtree with/without `repo: "extra"` proves the wiring
   * reads from a different physical worktree, not just a different path.
   */
  async function makeWingFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const workDir = await ensureDir(lair.root, 'work');

    await lair.sandbox.initBare(workDir, 'main-repo.git');
    await lair.sandbox.initBare(workDir, 'extra-repo.git');

    const wing = await lair.createWing('workshop-03', {
      workLocal: { repo: 'main-repo', branch: 'main' },
      extraWork: { extra: { repo: 'extra-repo', branch: 'main' } },
    });

    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local to exist');
    await writeContentFixture(workLocalResult.worktree, 'local-root', { 'local-root': seedItem('local-root', 'Local repo root') });

    const extraResult = await wing.workNamed(asRepoAlias('extra'));
    if (!extraResult.exists || !('worktree' in extraResult)) throw new Error('expected named work repo "extra" to exist');
    await writeContentFixture(extraResult.worktree, 'extra-root', { 'extra-root': seedItem('extra-root', 'Extra repo root') });

    return { sandbox };
  }

  it('resolves work/local by default (no repo param)', async () => {
    const { sandbox } = await makeWingFixture();

    const result = await callPlan(sandbox, 'workshop-03', 'get-subtree', { itemId: 'local-root' });

    expect(result.subtree?.items['local-root']?.title).toBe('Local repo root');
  });

  it('resolves the named extra work repo when repo is set', async () => {
    const { sandbox } = await makeWingFixture();

    const result = await callPlan(sandbox, 'workshop-03', 'get-subtree', { itemId: 'extra-root', repo: 'extra' });

    expect(result.subtree?.items['extra-root']?.title).toBe('Extra repo root');
  });

  it('does not find the extra repo item when repo is omitted', async () => {
    const { sandbox } = await makeWingFixture();

    const result = await callPlan(sandbox, 'workshop-03', 'get-subtree', { itemId: 'extra-root' });

    expect(result.subtree).toBeNull();
  });
});

describe('atWing simple-store writes land in the wing\'s own worktree, not the shared lair mirror (in-memory fixtures)', () => {
  /**
   * A wing whose work/local aliases the SAME lair-registered repo ("local") that
   * also has its own separate plan/main mirror worktree — so a write through the
   * wing's atWing handler and a read through the lair's plan/main mirror are
   * provably two different worktrees/branches of the one bare repo, not just two
   * different paths. This guards against add-question/remove-question/
   * set-root-order silently converting to the lair perspective
   * (`toLairRepo()`) before writing, which would land a wing-session write in
   * the shared mirror instead of the wing's own worktree.
   */
  async function makeAliasedFixture(wingQuestions: string[] = [], mirrorQuestions: string[] = []) {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const repoUrl = 'https://example.com/CodeWarp/aliased.git';
    const bareRepo = await lair.addWorkRepo('local', repoUrl);

    const repoId = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const mirrorWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(mirrorWorktree, 'root-a', { 'root-a': { ...seedItem('root-a', 'Root A'), questions: mirrorQuestions } });
    await writeContentFixture(mirrorWorktree, 'root-b', { 'root-b': seedItem('root-b', 'Root B') });
    await mirrorWorktree.commitAll('seed mirror fixture');

    const wing = await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'main' } });
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local to exist');
    await writeContentFixture(workLocalResult.worktree, 'root-a', { 'root-a': { ...seedItem('root-a', 'Root A'), questions: wingQuestions } });
    await writeContentFixture(workLocalResult.worktree, 'root-b', { 'root-b': seedItem('root-b', 'Root B') });
    await workLocalResult.worktree.commitAll('seed wing fixture');

    return { sandbox };
  }

  it('add-question atWing writes to the wing\'s own worktree, not the lair mirror', async () => {
    const { sandbox } = await makeAliasedFixture();

    await callPlan(sandbox, 'workshop-03', 'add-question', { itemId: 'root-a', questionId: 'q1' });

    const wingRead = await callPlan(sandbox, 'workshop-03', 'get-subtree', { itemId: 'root-a' });
    expect(wingRead.subtree?.items['root-a']?.questions).toEqual(['q1']);

    const lairRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root-a', repo: 'local' });
    expect(lairRead.subtree?.items['root-a']?.questions).toEqual([]);
  });

  it('remove-question atWing writes to the wing\'s own worktree, not the lair mirror', async () => {
    // The wing's own copy already has q1 (e.g. answered locally); the mirror never had it.
    const { sandbox } = await makeAliasedFixture(['q1'], []);

    await callPlan(sandbox, 'workshop-03', 'remove-question', { itemId: 'root-a', questionId: 'q1' });

    const wingRead = await callPlan(sandbox, 'workshop-03', 'get-subtree', { itemId: 'root-a' });
    expect(wingRead.subtree?.items['root-a']?.questions).toEqual([]);
  });

  it('set-root-order atWing reorders the wing\'s own worktree, not the lair mirror', async () => {
    const { sandbox } = await makeAliasedFixture();

    await callPlan(sandbox, 'workshop-03', 'set-root-order', { orderedIds: ['root-b', 'root-a'] });

    const wingRoots = await callPlan(sandbox, 'workshop-03', 'list-roots', {});
    expect(wingRoots.roots.map((r: { id: string }) => r.id)).toEqual(['root-b', 'root-a']);
  });
});

describe('get-leaves action (in-memory fixtures)', () => {
  /**
   * root
   *  ├─ c1 (leaf)
   *  ├─ c2 (leaf, requires c1)
   *  └─ branch (not a leaf)
   *      └─ g1 (leaf, grandchild)
   */
  async function makeLeavesFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', 'https://example.com/CodeWarp/leaves-repo.git');

    const repoId = repoIdToDirName(canonicalizeRepoUrl('https://example.com/CodeWarp/leaves-repo.git'));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');

    const items = {
      root: { ...seedItem('root', 'Root'), children: ['c1', 'c2', 'branch'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
      c2: { ...seedItem('c2', 'Child two'), parent: 'root', requires: ['c1'] },
      branch: { ...seedItem('branch', 'Branch'), parent: 'root', children: ['g1'] },
      g1: { ...seedItem('g1', 'Grandchild'), parent: 'branch' },
    };
    await writeContentFixture(planWorktree, 'root', items);

    return { sandbox };
  }

  it('returns only leaf items, annotated with block counts, when itemId is the tree root', async () => {
    const { sandbox } = await makeLeavesFixture();

    const result = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'root', repo: 'local' });

    expect(result).toEqual({
      action: 'get-leaves',
      root: 'root',
      leaves: {
        c1: expect.objectContaining({ id: 'c1', title: 'Child one', directBlocks: 1, indirectBlocks: 0 }),
        c2: expect.objectContaining({ id: 'c2', title: 'Child two', directBlocks: 0, indirectBlocks: 0 }),
        g1: expect.objectContaining({ id: 'g1', title: 'Grandchild', directBlocks: 0, indirectBlocks: 0 }),
      },
    });
    expect(result.leaves['root']).toBeUndefined();
    expect(result.leaves['branch']).toBeUndefined();
  });

  it('returns only leaves within a mid-tree itemId, not the whole tree', async () => {
    const { sandbox } = await makeLeavesFixture();

    const result = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'branch', repo: 'local' });

    expect(Object.keys(result.leaves)).toEqual(['g1']);
  });

  it('includes details/parentContext per leaf only when includeDetails is set', async () => {
    const { sandbox } = await makeLeavesFixture();

    await callPlan(sandbox, undefined, 'update-item', { itemId: 'c1', details: 'c1 details', repo: 'local' });

    const withoutDetails = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'root', repo: 'local' });
    expect(withoutDetails.leaves['c1'].details).toBeUndefined();

    const withDetails = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'root', includeDetails: true, repo: 'local' });
    expect(withDetails.leaves['c1'].details).toBe('c1 details');
  });

  it('returns an empty leaves map when itemId is not found', async () => {
    const { sandbox } = await makeLeavesFixture();

    const result = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'nope', repo: 'local' });

    expect(result).toEqual({ action: 'get-leaves', root: null, leaves: {} });
  });
});

describe('claim-leaf action (in-memory fixtures)', () => {
  async function makeClaimLeafFixture(items: Record<string, FixtureItem>) {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', 'https://example.com/CodeWarp/claim-leaf-repo.git');

    const repoId = repoIdToDirName(canonicalizeRepoUrl('https://example.com/CodeWarp/claim-leaf-repo.git'));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(planWorktree, 'root', items);

    for (const wingName of ['workshop-01', 'workshop-02', 'workshop-03']) {
      await lair.createWing(wingName, { workLocal: { repo: 'local', branch: `l/x/w/${wingName}` } });
    }

    return { sandbox };
  }

  it('claims the unclaimed, unblocked leaf that frees up the most other work', async () => {
    // root
    //  ├─ c1 (leaf, no requires) — blocks c2 and c3 directly: highest total block count
    //  ├─ c2 (leaf, requires c1)
    //  ├─ c3 (leaf, requires c1)
    //  └─ c4 (leaf, no requires) — blocks nothing
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['c1', 'c2', 'c3', 'c4'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
      c2: { ...seedItem('c2', 'Child two'), parent: 'root', requires: ['c1'] },
      c3: { ...seedItem('c3', 'Child three'), parent: 'root', requires: ['c1'] },
      c4: { ...seedItem('c4', 'Child four'), parent: 'root' },
    });

    const result = await callPlan(sandbox, undefined, 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result.action).toBe('claim-leaf');
    expect(result['nodeId']).toBe('c1');
    expect(result['goalId']).toBe('root');
    expect(result['candidatesConsidered']).toBe(2); // c1 and c4 — c2/c3 have unmet requires
    expect(result['parallelismScore']).toBe(2); // c1 directly blocks c2 and c3
    expect((result.commitResult as { committed: boolean }).committed).toBe(true);
  });

  it('breaks a tie in total block count by picking the leaf on the longest serial chain', async () => {
    // root
    //  ├─ x (leaf, no requires) — directly blocks y1, transitively blocks y2: total 2, chain length 2
    //  ├─ y1 (requires x)
    //  ├─ y2 (requires y1)
    //  ├─ z (leaf, no requires) — directly blocks w1 and w2: total 2, chain length 1
    //  ├─ w1 (requires z)
    //  └─ w2 (requires z)
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['x', 'y1', 'y2', 'z', 'w1', 'w2'] },
      x: { ...seedItem('x', 'X'), parent: 'root' },
      y1: { ...seedItem('y1', 'Y1'), parent: 'root', requires: ['x'] },
      y2: { ...seedItem('y2', 'Y2'), parent: 'root', requires: ['y1'] },
      z: { ...seedItem('z', 'Z'), parent: 'root' },
      w1: { ...seedItem('w1', 'W1'), parent: 'root', requires: ['z'] },
      w2: { ...seedItem('w2', 'W2'), parent: 'root', requires: ['z'] },
    });

    const result = await callPlan(sandbox, undefined, 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result['nodeId']).toBe('x');
    expect(result['parallelismScore']).toBe(2);
    expect(result['chainLength']).toBe(2);
  });

  it('excludes a leaf already claimed by another wing from consideration', async () => {
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['c1', 'c2'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
      c2: { ...seedItem('c2', 'Child two'), parent: 'root' },
    });

    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'c1', goalId: 'root', repo: 'local' });

    const result = await callPlan(sandbox, 'workshop-02', 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result['nodeId']).toBe('c2');
    expect(result['candidatesConsidered']).toBe(1);
  });

  it('returns the calling wing\'s existing leaf claim outright, without ranking against other candidates', async () => {
    // c1 blocks nothing; c2 blocks c3 directly — if ranked normally, c2 would win.
    // But workshop-01 already holds c1, so c1 must be returned regardless.
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['c1', 'c2', 'c3'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
      c2: { ...seedItem('c2', 'Child two'), parent: 'root' },
      c3: { ...seedItem('c3', 'Child three'), parent: 'root', requires: ['c2'] },
    });

    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'c1', goalId: 'root', repo: 'local' });

    const result = await callPlan(sandbox, 'workshop-01', 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result['nodeId']).toBe('c1');
    expect(result['alreadyClaimed']).toBe(true);
  });

  it('keeps one leaf claim and releases the rest when the calling wing holds more than one', async () => {
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['c1', 'c2', 'c3'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
      c2: { ...seedItem('c2', 'Child two'), parent: 'root' },
      c3: { ...seedItem('c3', 'Child three'), parent: 'root' },
    });

    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'c2', goalId: 'root', repo: 'local' });
    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'c3', goalId: 'root', repo: 'local' });

    const result = await callPlan(sandbox, 'workshop-01', 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result['nodeId']).toBe('c2'); // lowest id kept

    const subtree = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root', repo: 'local' });
    expect(subtree.subtree?.items['c2']?.claimedBy?.wing).toBe('workshop-01');
    expect(subtree.subtree?.items['c3']?.claimedBy).toBeUndefined();
  });

  it('self-heals a claim left on a non-leaf item, regardless of which wing holds it', async () => {
    // 'branch' has a child ('leaf'), so it's not a leaf itself — but claim-node
    // has no leaf restriction, so it can still end up claimed directly (e.g. by
    // a leaf getting reparented under it without going through unclaim-node).
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['branch'] },
      branch: { ...seedItem('branch', 'Branch'), parent: 'root', children: ['leaf'] },
      leaf: { ...seedItem('leaf', 'Leaf'), parent: 'branch' },
    });

    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'branch', goalId: 'root', repo: 'local' });

    const result = await callPlan(sandbox, 'workshop-02', 'claim-leaf', { goalId: 'root', repo: 'local' });
    expect(result['nodeId']).toBe('leaf');

    const subtree = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root', repo: 'local' });
    expect(subtree.subtree?.items['branch']?.claimedBy).toBeUndefined();
  });

  it('throws instructing the caller to stop when no leaf is claimable', async () => {
    // The only leaf has an unmet requires — nothing under root is claimable.
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['blocked'] },
      blocked: { ...seedItem('blocked', 'Blocked'), parent: 'root', requires: ['ghost'] },
    });

    await expect(callPlan(sandbox, undefined, 'claim-leaf', { goalId: 'root', repo: 'local' })).rejects.toThrow(
      /No claimable work available.*stop.*cleared/is,
    );
  });

  it('rejects when goalId is not found', async () => {
    const { sandbox } = await makeClaimLeafFixture({
      root: { ...seedItem('root', 'Root'), children: ['c1'] },
      c1: { ...seedItem('c1', 'Child one'), parent: 'root' },
    });

    await expect(callPlan(sandbox, undefined, 'claim-leaf', { goalId: 'nope', repo: 'local' })).rejects.toThrow(/Goal not found/);
  });

  it('follows requires links across root boundaries to find a claimable leaf', async () => {
    // root (goal)
    //  └─ gate (leaf, requires "other" — a DIFFERENT root)
    // other (a separate root, unrelated to root except via gate's requires)
    //  └─ otherLeaf (leaf, no requires)
    //
    // root's own subtree has no claimable leaf at all — gate is a leaf but
    // blocked on "other". The real claimable work (otherLeaf) only becomes
    // reachable by crossing that requires edge into the other root.
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const repoUrl = 'https://example.com/CodeWarp/claim-leaf-cross-root-repo.git';
    const bareRepo = await lair.addWorkRepo('local', repoUrl);
    const repoId = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');

    await writeContentFixture(planWorktree, 'root', {
      root: { ...seedItem('root', 'Root'), children: ['gate'] },
      gate: { ...seedItem('gate', 'Gate'), parent: 'root', requires: ['other'] },
    });
    await writeContentFixture(planWorktree, 'other', {
      other: { ...seedItem('other', 'Other root'), children: ['otherLeaf'] },
      otherLeaf: { ...seedItem('otherLeaf', 'Other leaf'), parent: 'other' },
    });

    const leaves = await callPlan(sandbox, undefined, 'get-leaves', { itemId: 'root', repo: 'local' });
    expect(Object.keys(leaves.leaves)).toEqual(expect.arrayContaining(['gate', 'otherLeaf']));

    const result = await callPlan(sandbox, undefined, 'claim-leaf', { goalId: 'root', repo: 'local' });

    expect(result['nodeId']).toBe('otherLeaf');
    expect(result['candidatesConsidered']).toBe(1); // gate is blocked on "other"; only otherLeaf is unmet-requires-free
    expect(result['path']).toEqual(['otherLeaf', 'other', 'gate', 'root']);

    // The claim must land under otherLeaf's real home root ("other"), not
    // "root" (the goal's own root) — otherwise it would be unreadable from
    // the root it actually lives under.
    const otherSubtree = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'other', repo: 'local' });
    expect(otherSubtree.subtree?.items['otherLeaf']?.claimedBy?.wing).toBe('unknown');
  });
});

describe('claim-leaf searches the calling wing\'s own content, not just the lair mirror (in-memory fixtures)', () => {
  /**
   * Same "local" repo aliased by two different worktrees — the plan/main
   * mirror and workshop-03's own work/local — so a leaf that exists only in
   * the wing's own not-yet-merged content is provably invisible to a search
   * that reads the mirror alone. Mirrors makeAliasedFixture's shape above.
   */
  async function makeWingOnlyLeafFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const repoUrl = 'https://example.com/CodeWarp/claim-leaf-wing-repo.git';
    const bareRepo = await lair.addWorkRepo('local', repoUrl);

    const repoId = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    // Mirror only knows about "root" and its one child "c-main" — no "c-wing".
    const mirrorWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(mirrorWorktree, 'root', {
      root: { ...seedItem('root', 'Root'), children: ['c-main'] },
      'c-main': { ...seedItem('c-main', 'Main child'), parent: 'root' },
    });
    await mirrorWorktree.commitAll('seed mirror fixture');

    // workshop-01 validates claim-node against its own (empty) worktree,
    // which falls back to the mirror — no plan content needed here.
    await lair.createWing('workshop-01', { workLocal: { repo: 'local', branch: 'wip/a' } });

    // workshop-03's own worktree already knows about "c-wing" too — created
    // locally, not yet merged to plan/main.
    const wing = await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'wip/b' } });
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local to exist');
    await writeContentFixture(workLocalResult.worktree, 'root', {
      root: { ...seedItem('root', 'Root'), children: ['c-main', 'c-wing'] },
      'c-main': { ...seedItem('c-main', 'Main child'), parent: 'root' },
      'c-wing': { ...seedItem('c-wing', 'Wing-only child'), parent: 'root' },
    });
    await workLocalResult.worktree.commitAll('seed wing fixture');

    return { sandbox };
  }

  it('claims a leaf that exists only in the wing\'s own not-yet-merged content', async () => {
    const { sandbox } = await makeWingOnlyLeafFixture();

    // The mirror's only leaf ("c-main") is claimed by another wing, so a
    // mirror-only search would find zero candidates and throw. The wing's
    // own content additionally has "c-wing", which claim-leaf must find.
    await callPlan(sandbox, 'workshop-01', 'claim-node', { nodeId: 'c-main', goalId: 'root', repo: 'local' });

    const result = await callPlan(sandbox, 'workshop-03', 'claim-leaf', { goalId: 'root' });

    expect(result['nodeId']).toBe('c-wing');

    // The claim landed on the canonical mirror (a dangling claims.toml entry,
    // by design, since "c-wing" itself hasn't merged there) — visible to any
    // wing reading plan/main directly.
    const mirrorRead = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'c-wing', repo: 'local' });
    expect(mirrorRead.subtree).toBeNull(); // content itself hasn't merged
  });

  it('throws when the mirror-only leaf is claimed and the wing has not locally created any alternative', async () => {
    const sandbox2 = createInMemorySandbox();
    const lair2 = createLair(sandbox2);
    const repoUrl = 'https://example.com/CodeWarp/claim-leaf-no-wing-repo.git';
    const bareRepo2 = await lair2.addWorkRepo('local', repoUrl);
    const repoId2 = repoIdToDirName(canonicalizeRepoUrl(repoUrl));
    const cabinetDir2 = await lair2.cabinet();
    const planningDir2 = await ensureDir(cabinetDir2, 'planning');
    const mirrorWorktree2 = await bareRepo2.createSparseWorktree(planningDir2, repoId2, 'plan/main', '.meta/plan');
    await writeContentFixture(mirrorWorktree2, 'root', {
      root: { ...seedItem('root', 'Root'), children: ['c-main'] },
      'c-main': { ...seedItem('c-main', 'Main child'), parent: 'root' },
    });
    await mirrorWorktree2.commitAll('seed mirror fixture');
    await lair2.createWing('workshop-01', { workLocal: { repo: 'local', branch: 'wip/a' } });
    await lair2.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'wip/b' } });

    await callPlan(sandbox2, 'workshop-01', 'claim-node', { nodeId: 'c-main', goalId: 'root', repo: 'local' });

    await expect(callPlan(sandbox2, 'workshop-03', 'claim-leaf', { goalId: 'root' })).rejects.toThrow(
      /No claimable work available/,
    );
  });
});

describe('sync — force-refresh the local trunk ref from origin, on demand', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  async function makeRemoteFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('.meta/plan/README.md', '# plan v1');
    await remoteMain.commitAll('seed origin main');
    await lair.addWorkRepo('local', REPO_URL);
    return { sandbox, lair, remoteMain };
  }

  // `sync` doesn't touch any mirror worktree directly — it only fetches
  // origin and fast-forwards the LOCAL `main` ref to match
  // (`refreshTrunkFromOrigin`, `@minions/repo-perspective`). Freshness is
  // then visible through the NEXT fresh `Mirror` any plan/movement action
  // builds, so this test verifies it via a direct
  // `LairRepoPerspective.resolve()` after `sync`, not by reaching into any
  // conventional mirror worktree path.
  it('fast-forwards the local trunk ref so a subsequent read sees origin state', async () => {
    const { sandbox, lair } = await makeRemoteFixture();

    const result = await callPlan(sandbox, undefined, 'sync', { repo: 'local' });

    expect(result).toEqual({ action: 'sync', repo: 'local' });
    const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const readme = await perspective.worktree.child('.meta/plan/README.md');
    expect(readme.found && readme.node.kind === 'file' ? await readme.node.read() : undefined).toBe('# plan v1');
  });

  it('every call pulls current origin state — no stale caching between calls', async () => {
    const { sandbox, lair, remoteMain } = await makeRemoteFixture();
    const group = createPlanActionGroup();
    const ctx: ActionContext<Sandbox> = { lair: sandbox };

    const first = await dispatchActionGroup(group, { action: 'sync', repo: 'local' }, ctx);
    await remoteMain.createFile('.meta/plan/README.md', '# plan v2');
    await remoteMain.commitAll('advance origin main');
    const second = await dispatchActionGroup(group, { action: 'sync', repo: 'local' }, ctx);

    expect(first).toEqual({ action: 'sync', repo: 'local' });
    expect(second).toEqual({ action: 'sync', repo: 'local' });
    const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const readme = await perspective.worktree.child('.meta/plan/README.md');
    expect(readme.found && readme.node.kind === 'file' ? await readme.node.read() : undefined).toBe('# plan v2');
  });

  it('resolves the wing repo alias when called from a wing session', async () => {
    const { sandbox, lair } = await makeRemoteFixture();
    await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'main' } });

    const result = await callPlan(sandbox, 'workshop-03', 'sync', {});

    expect(result).toEqual({ action: 'sync', repo: 'local' });
    const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const readme = await perspective.worktree.child('.meta/plan/README.md');
    expect(readme.found && readme.node.kind === 'file' ? await readme.node.read() : undefined).toBe('# plan v1');
  });

  it('rejects with no wingName and no repo', async () => {
    const { sandbox } = await makeRemoteFixture();

    await expect(callPlan(sandbox, undefined, 'sync', {})).rejects.toThrow(/repo is required/);
  });
});

describe('shouldTriggerFullSyncAfterAbsorb — HUMAN DECISION: a rebase-conflict absorb failure never triggers a resync', () => {
  // HUMAN DECISION, do not change without explicit human approval: a rebase
  // conflict leaves the mirror worktree mid-conflicted-rebase; running a
  // sync over it risks destroying what a human needs to `git add` + `git
  // rebase --continue` to resolve.
  it('does not trigger when no absorb was attempted', () => {
    expect(shouldTriggerFullSyncAfterAbsorb(undefined)).toBe(false);
  });

  it('triggers on a successful absorb', () => {
    expect(shouldTriggerFullSyncAfterAbsorb({ success: true, absorbed: 0 })).toBe(true);
  });

  it('triggers on a non-conflict absorb failure (e.g. a rogue out-of-band change)', () => {
    expect(shouldTriggerFullSyncAfterAbsorb({ success: false, error: 'fetch failed' })).toBe(true);
  });

  it(
    'HUMAN DECISION — does NOT trigger on a rebase-conflict absorb failure: this would risk destroying ' +
      'the conflicted state a human still needs to resolve. Do not change without explicit human approval.',
    () => {
      expect(shouldTriggerFullSyncAfterAbsorb({ success: false, needsRebase: true, error: 'conflict' })).toBe(false);
    },
  );
});

/**
 * `claim-node` runs its entire mutation through a single `Mirror.apply()`
 * call (design doc §4.5), which already does read-fresh + commit +
 * CAS-publish-with-retry with no external locking needed (server-side
 * fast-forward CAS is safe under concurrency by construction). There is no
 * dispatch-level `mirrorOpLock`, commit-then-absorb two-step, or
 * post-absorb full-sync trigger to test here, because `claim-node` has none
 * of those. The concurrency GUARANTEE this covers — "two racing claims on
 * the same node: exactly one wins, cleanly" — is exercised below via the
 * real `Mirror.apply()` CAS-retry path.
 */
describe('claim-node concurrency (in-memory fixtures)', () => {
  const REPO_URL = 'https://example.com/CodeWarp/lockrepo.git';

  /** A repo with a real (in-memory-simulated) remote and a steady-state plan/main mirror, seeded with one claimable root. */
  async function makeLockFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('.meta/plan/README.md', '# plan v1');
    await remoteMain.commitAll('seed origin main');

    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    const repoId = repoIdToDirName(canonicalizeRepoUrl(REPO_URL));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(planWorktree, 'root-id', { 'root-id': seedItem('root-id', 'Root') });

    return { sandbox, bareRepo, remote };
  }

  it('two concurrent claim-node calls against the same node: exactly one succeeds, the other fails cleanly', async () => {
    const { sandbox } = await makeLockFixture();

    const results = await Promise.allSettled([
      callPlan(sandbox, undefined, 'claim-node', { nodeId: 'root-id', goalId: 'root-id', repo: 'local' }),
      callPlan(sandbox, undefined, 'claim-node', { nodeId: 'root-id', goalId: 'root-id', repo: 'local' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already claimed/);

    const read = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root-id', repo: 'local' });
    expect(read.subtree?.items['root-id']?.claimedBy?.wing).toBeDefined();
  });
});

/**
 * The content-owning atLair actions (add-children/set-root-order/
 * add-question/remove-question/update-item/create-root/move-node, design
 * doc §4.5) write through a single `Mirror.apply()` call, so the atLair
 * path is genuinely atomic: the write is both committed AND published all
 * the way onto the repo's real `main` branch (`Mirror.apply()`'s publish
 * target is always `trunk.branch`, never the mirror's own branch — design
 * doc §4.1) by the time the call returns, not merely present as
 * uncommitted dirty files in the mirror worktree. These tests prove that.
 *
 * `update-item`'s atLair path already had incidental coverage above ("writes
 * to the repo named by the repo param, not the other repo") — real, not
 * dead, so worth calling out: these actions ARE exercised atLair in
 * practice, not just atWing.
 */
describe('content-owning atLair writes are atomic (in-memory fixtures)', () => {
  async function makeContentFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', 'https://example.com/CodeWarp/content-repo.git');

    const repoId = repoIdToDirName(canonicalizeRepoUrl('https://example.com/CodeWarp/content-repo.git'));
    const cabinetDir = await lair.cabinet();
    const planningDir = await ensureDir(cabinetDir, 'planning');
    const planWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
    await writeContentFixture(planWorktree, 'root', { root: seedItem('root', 'Root') });
    await planWorktree.commitAll('seed content fixture');

    return { sandbox, bareRepo, planWorktree };
  }

  it('create-root atLair commits and publishes onto the repo\'s real main branch, not just the mirror worktree', async () => {
    const { sandbox, bareRepo, planWorktree } = await makeContentFixture();
    const mainTipBefore = await bareRepo.resolveLocalRef('main');

    const result = await callPlan(sandbox, undefined, 'create-root', { title: 'New root', repo: 'local' });

    expect((result as { commitResult?: { committed: boolean } }).commitResult?.committed).toBe(true);
    expect(await planWorktree.isDirty()).toBe(false);
    const mainTipAfter = await bareRepo.resolveLocalRef('main');
    expect(mainTipAfter).not.toBe(mainTipBefore);

    // Provably durable, not just dirty-but-unread: a completely fresh
    // LairRepoPerspective/get-subtree call (a new Mirror construction) sees it.
    const read = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root', repo: 'local' });
    void read;
    const roots = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });
    expect(roots.roots.map((r) => r.title)).toContain('New root');
  });

  it('add-children atLair commits and publishes atomically', async () => {
    const { sandbox, bareRepo, planWorktree } = await makeContentFixture();
    const mainTipBefore = await bareRepo.resolveLocalRef('main');

    const result = await callPlan(sandbox, undefined, 'add-children', {
      parentId: 'root',
      children: [{ title: 'Child', details: 'details', context: 'context' }],
      repo: 'local',
    });

    expect((result as { commitResult?: { committed: boolean } }).commitResult?.committed).toBe(true);
    expect(await planWorktree.isDirty()).toBe(false);
    expect(await bareRepo.resolveLocalRef('main')).not.toBe(mainTipBefore);
  });

  it('move-node atLair commits and publishes atomically', async () => {
    const { sandbox, bareRepo, planWorktree } = await makeContentFixture();
    await callPlan(sandbox, undefined, 'add-children', {
      parentId: 'root',
      children: [{ title: 'Child', details: 'details', context: 'context' }],
      repo: 'local',
    });
    const listBefore = await callPlan(sandbox, undefined, 'get-subtree', { itemId: 'root', repo: 'local' });
    const childId = Object.keys(listBefore.subtree?.items ?? {}).find((id) => id !== 'root');
    if (!childId) throw new Error('expected a child item');
    const mainTipBefore = await bareRepo.resolveLocalRef('main');

    const result = await callPlan(sandbox, undefined, 'move-node', { itemId: childId, newParentId: null, repo: 'local' });

    expect((result as { commitResult?: { committed: boolean } }).commitResult?.committed).toBe(true);
    expect(await planWorktree.isDirty()).toBe(false);
    expect(await bareRepo.resolveLocalRef('main')).not.toBe(mainTipBefore);

    const roots = await callPlan(sandbox, undefined, 'list-roots', { repo: 'local' });
    expect(roots.roots.map((r) => r.id)).toContain(childId);
  });
});

/**
 * `list-wings` reads through `workAreaLocalIfExists()`/`activeMovement()`,
 * not `wing.workLocal()` directly — same shape as `wingStillHasNode()`. A
 * bare `createLair(ctx.lair)` (no `WorkAreaFactories`) makes
 * `workAreaLocalIfExists()` throw for every wing, which this action's own
 * per-wing try/catch would silently swallow as "wing not usable" — these
 * tests prove real wings with real plan content still come back, not just
 * that the action doesn't throw.
 */
describe('list-wings (in-memory fixtures)', () => {
  it('lists every wing that has a work/local checkout with a resolvable plan store, with its current branch', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    await lair.addWorkRepo('local', 'https://example.com/CodeWarp/list-wings-repo.git');

    const wingA = await lair.createWing('workshop-01', { workLocal: { repo: 'local', branch: 'wip/a' } });
    const workLocalA = await wingA.workLocal();
    if (!workLocalA.exists) throw new Error('expected work/local to exist');
    await writeContentFixture(workLocalA.worktree, 'root-a', { 'root-a': seedItem('root-a', 'Root A') });
    await workLocalA.worktree.commitAll('seed wing A plan');

    const wingB = await lair.createWing('workshop-02', { workLocal: { repo: 'local', branch: 'wip/b' } });
    const workLocalB = await wingB.workLocal();
    if (!workLocalB.exists) throw new Error('expected work/local to exist');
    await writeContentFixture(workLocalB.worktree, 'root-b', { 'root-b': seedItem('root-b', 'Root B') });
    await workLocalB.worktree.commitAll('seed wing B plan');

    const result = await callPlan(sandbox, undefined, 'list-wings', {});

    expect(result.wings).toEqual(
      expect.arrayContaining([
        { name: 'workshop-01', branch: 'wip/a' },
        { name: 'workshop-02', branch: 'wip/b' },
      ]),
    );
    expect(result.wings).toHaveLength(2);
  });

  it('omits a wing with no work/local checkout at all', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    await lair.addWorkRepo('local', 'https://example.com/CodeWarp/list-wings-repo2.git');

    // No workLocal in the config — mirrors a wing with no repo checkout.
    await lair.createWing('workshop-09', { workLocal: { repo: 'nonexistent-repo', branch: 'wip/never' } });

    const result = await callPlan(sandbox, undefined, 'list-wings', {});

    expect(result.wings).toEqual([]);
  });
});
