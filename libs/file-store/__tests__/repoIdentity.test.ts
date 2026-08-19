import { describe, it, expect } from 'vitest';
import { canonicalizeRepoUrl, repoIdToDirName, resolveRepoIdentity } from '../src/lair/repoIdentity.js';
import { asRepoAlias } from '../src/lair/brandedIds.js';
import { createInMemorySandbox, createLair, createInMemoryWorkAreaFactories } from '../src/index.js';
import type { Lair } from '../src/index.js';

/**
 * `resolveRepoIdentity()` is now built on the design-doc-§4.2 `WorkArea`-
 * returning surface (`workAreaLocalIfExists()`/`namedWorkPath()`/
 * `workAreaNamed()`), which requires a `Wing` constructed with
 * `WorkAreaFactories` — every `Lair` in this file's tests needs one, even
 * though the identity resolution itself never touches a `Trunk`/`Movement`.
 */
function testLair(sandbox: ReturnType<typeof createInMemorySandbox>): Lair {
  return createLair(sandbox, createInMemoryWorkAreaFactories('scratch'));
}

describe('canonicalizeRepoUrl', () => {
  it('strips a trailing .git suffix', () => {
    expect(canonicalizeRepoUrl('https://github.com/acme/widgets.git')).toBe(
      canonicalizeRepoUrl('https://github.com/acme/widgets')
    );
  });

  it('strips a trailing slash', () => {
    expect(canonicalizeRepoUrl('https://github.com/acme/widgets/')).toBe(
      canonicalizeRepoUrl('https://github.com/acme/widgets')
    );
  });

  it('lower-cases the host but preserves path casing', () => {
    expect(canonicalizeRepoUrl('https://GitHub.com/acme/Widgets')).toBe('github.com/acme/Widgets');
  });

  it('collapses ssh scp-like syntax and https to the same identity', () => {
    expect(canonicalizeRepoUrl('git@github.com:acme/widgets.git')).toBe(
      canonicalizeRepoUrl('https://github.com/acme/widgets.git')
    );
  });

  it('collapses explicit ssh:// form to the same identity as scp-like syntax', () => {
    expect(canonicalizeRepoUrl('ssh://git@github.com/acme/widgets.git')).toBe(
      canonicalizeRepoUrl('git@github.com:acme/widgets.git')
    );
  });
});

describe('repoIdToDirName', () => {
  it('replaces path separators with a filesystem-safe token', () => {
    expect(repoIdToDirName('github.com/acme/widgets')).toBe('github.com--acme--widgets');
  });

  it('produces distinct names for ids that only differ in slash position', () => {
    const a = repoIdToDirName('github.com/acme/widgets');
    const b = repoIdToDirName('github.com/acme-widgets');
    expect(a).not.toBe(b);
  });

  it('never contains a path separator', () => {
    expect(repoIdToDirName('github.com/acme/widgets')).not.toMatch(/[/\\]/);
  });
});

/**
 * `resolveRepoIdentity()` is built on the design-doc-§4.2 `WorkArea`-returning
 * accessors (`workAreaLocalIfExists()`/`namedWorkPath()`/`workAreaNamed()`).
 * These tests exercise it against a REAL `Wing` (`LairWing`, via
 * `createLair()` + `createWing()`) backed by the InMemory sandbox, not a
 * hand-built mock — `testLair()` above supplies real `WorkAreaFactories` so
 * those accessors work end to end.
 *
 * `lair.addWorkRepo(name, url)` clones a bare repo with a real clone URL
 * attached (the InMemory adapter's `cloneBare()` stores it verbatim), which
 * is exactly what `resolveRepoIdentity()` reads via `workArea.repo.url`. The
 * one case with no analogous `Lair`-level helper — a work repo with NO
 * remote URL — uses `sandbox.initBare()` directly into the same
 * `work/<name>.git` convention path `addWorkRepo()`/`workRepo()` use,
 * matching the pattern already established in
 * `__tests__/memory-specific/work-area.test.ts`.
 */
describe('resolveRepoIdentity', () => {
  it('resolves "local" via wing.workLocal()', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    await lair.addWorkRepo('local', 'https://github.com/acme/local.git');
    const wing = await lair.createWing('w', { workLocal: { repo: 'local', branch: 'wip/local' } });

    const result = await resolveRepoIdentity(wing, asRepoAlias('local'));

    expect(result).toEqual({ resolved: true, id: 'github.com/acme/local' });
  });

  it('resolves a named work repo via wing.workNamed()', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    // workLocal is required by WingConfig's type, but points at a repo that's
    // never registered — this wing genuinely has no work/local checkout,
    // proving resolution for "billing-service" comes only from workNamed().
    await lair.addWorkRepo('billing-service', 'git@github.com:acme/billing.git');
    const wing = await lair.createWing('w', {
      workLocal: { repo: 'nonexistent', branch: 'wip/local' },
      extraWork: { 'billing-service': { repo: 'billing-service', branch: 'wip/billing' } },
    });

    const result = await resolveRepoIdentity(wing, asRepoAlias('billing-service'));

    expect(result).toEqual({ resolved: true, id: 'github.com/acme/billing' });
  });

  it('resolves a junction-worktree named work repo the same as a plain worktree', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    // A DIFFERENT repo than work/local, with a subdir — LairWing.addWorkNamed's
    // "Case 2 (different-repo)" branch, which produces a hidden sparse-checkout
    // worktree behind a junction (kind: 'junction-worktree'), not a plain worktree.
    await lair.addWorkRepo('local', 'https://github.com/acme/other.git');
    await lair.addWorkRepo('billing-service', 'https://github.com/acme/billing.git');
    const wing = await lair.createWing('w', {
      workLocal: { repo: 'local', branch: 'wip/local' },
      extraWork: { 'billing-service': { repo: 'billing-service', branch: 'wip/billing', subdir: 'src' } },
    });

    const namedResult = await wing.workNamed(asRepoAlias('billing-service'));
    expect(namedResult.exists && namedResult.kind).toBe('junction-worktree');

    const result = await resolveRepoIdentity(wing, asRepoAlias('billing-service'));

    expect(result).toEqual({ resolved: true, id: 'github.com/acme/billing' });
  });

  it('two wings/aliases pointing at the same physical repo resolve to the same id', async () => {
    const sandboxA = createInMemorySandbox();
    const lairA: Lair = testLair(sandboxA);
    await lairA.addWorkRepo('shared', 'git@github.com:acme/shared.git');
    const wingA = await lairA.createWing('a', { workLocal: { repo: 'shared', branch: 'wip/a' } });

    const sandboxB = createInMemorySandbox();
    const lairB: Lair = testLair(sandboxB);
    await lairB.addWorkRepo('shared', 'https://github.com/acme/shared');
    const wingB = await lairB.createWing('b', {
      workLocal: { repo: 'nonexistent', branch: 'wip/b' },
      extraWork: { shared: { repo: 'shared', branch: 'wip/b-shared' } },
    });

    const idA = await resolveRepoIdentity(wingA, asRepoAlias('local'));
    const idB = await resolveRepoIdentity(wingB, asRepoAlias('shared'));

    expect(idA).toEqual(idB);
  });

  it('returns not-found when the alias has no backing work directory', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    const wing = await lair.createWing('w', { workLocal: { repo: 'nonexistent', branch: 'wip/local' } });

    const result = await resolveRepoIdentity(wing, asRepoAlias('missing'));

    expect(result).toEqual({ resolved: false, reason: 'not-found' });
  });

  it('returns no-remote-url when the backing repo has no remote (locally initialized)', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    // No Lair-level helper clones a bare repo with a null URL — addWorkRepo()
    // always takes a real url. Mirrors it manually at the same work/<name>.git
    // convention path addWorkRepo()/workRepo() use (established pattern, see
    // __tests__/memory-specific/work-area.test.ts).
    const workDir = await sandbox.root.createDirectory('work');
    await sandbox.initBare(workDir, 'local.git');
    const wing = await lair.createWing('w', { workLocal: { repo: 'local', branch: 'wip/local' } });

    const result = await resolveRepoIdentity(wing, asRepoAlias('local'));

    expect(result).toEqual({ resolved: false, reason: 'no-remote-url' });
  });

  it('returns unsupported for a plain junction (same-repo subdir) named work entry', async () => {
    const sandbox = createInMemorySandbox();
    const lair: Lair = testLair(sandbox);
    await lair.addWorkRepo('local', 'https://github.com/acme/local.git');
    // Same repo checked out at work/local AND as a same-repo subdir junction
    // at work/sub — LairWing.addWorkNamed's "Case 1 (same-repo)" branch,
    // which produces a plain `junction` (no worktree of its own).
    const wing = await lair.createWing('w', {
      workLocal: { repo: 'local', branch: 'wip/local' },
      extraWork: { sub: { repo: 'local', branch: 'wip/local', subdir: 'sub' } },
    });

    const namedResult = await wing.workNamed(asRepoAlias('sub'));
    expect(namedResult.exists && namedResult.kind).toBe('junction');

    const result = await resolveRepoIdentity(wing, asRepoAlias('sub'));

    expect(result).toEqual({ resolved: false, reason: 'unsupported' });
  });
});
