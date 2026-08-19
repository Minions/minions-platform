import { describe, it, expect } from 'vitest';
import type { Directory } from '../../src/port/types.js';
import { createInMemorySandbox, simulateRemote, pathToFile } from '../../src/index.js';

const URL = 'https://example.com/acme/widgets.git';

describe('simulateRemote (in-memory remote simulation)', () => {
  it('seeds a new clone with the remote-tracking refs the remote already has', async () => {
    const sandbox = createInMemorySandbox();
    const remote = simulateRemote(sandbox, URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('README.md', '# from origin');
    await remoteMain.commitAll('seed origin main');

    const clone = await sandbox.cloneBare(URL, sandbox.root, 'clone.git');

    await expect(clone.updateBranch('main', 'origin/main')).resolves.toBeUndefined();
    await clone.createWorktree(sandbox.root, 'clone-work', 'main');
    const readme = await pathToFile(sandbox, 'clone-work/README.md');
    expect(await readme?.read()).toBe('# from origin');
  });

  it('fetch() picks up commits the remote gained after the clone was created', async () => {
    const sandbox = createInMemorySandbox();
    const remote = simulateRemote(sandbox, URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('README.md', '# v1');
    await remoteMain.commitAll('v1');

    const clone = await sandbox.cloneBare(URL, sandbox.root, 'clone.git');
    await clone.updateBranch('main', 'origin/main');

    await remoteMain.createFile('README.md', '# v2');
    await remoteMain.commitAll('v2');

    // Before fetching, the clone's origin/main ref is still stale.
    await expect(clone.updateBranch('main', 'origin/main')).resolves.toBeUndefined();
    const staleWorktree = await clone.createWorktree(sandbox.root, 'clone-work-stale', 'main');
    const staleReadme = await pathToFile(sandbox, 'clone-work-stale/README.md');
    expect(await staleReadme?.read()).toBe('# v1');
    await clone.removeWorktree(staleWorktree);

    await clone.fetch();
    await clone.updateBranch('main', 'origin/main');
    await clone.createWorktree(sandbox.root, 'clone-work-fresh', 'main');
    const freshReadme = await pathToFile(sandbox, 'clone-work-fresh/README.md');
    expect(await freshReadme?.read()).toBe('# v2');
  });

  it('pushBranch() publishes to the shared remote, visible to a second, independent clone via fetch()', async () => {
    const sandbox = createInMemorySandbox();
    simulateRemote(sandbox, URL);

    const cloneA = await sandbox.cloneBare(URL, sandbox.root, 'clone-a.git');
    const workA = await cloneA.createWorktree(sandbox.root, 'work-a', 'main');
    await workA.createFile('README.md', '# from clone A');
    await workA.commitAll('clone A commit');
    await cloneA.pushBranch('main');

    const cloneB = await sandbox.cloneBare(URL, sandbox.root, 'clone-b.git');
    await expect(cloneB.updateBranch('main', 'origin/main')).resolves.toBeUndefined();
    await cloneB.createWorktree(sandbox.root, 'work-b', 'main');
    const readme = await pathToFile(sandbox, 'work-b/README.md');
    expect(await readme?.read()).toBe('# from clone A');
  });

  it('commits made on a clone never collide with commits imported from the remote', async () => {
    const sandbox = createInMemorySandbox();
    const remote = simulateRemote(sandbox, URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('README.md', 'v1');
    await remoteMain.commitAll('seed one');
    await remoteMain.createFile('README.md', 'v2');
    await remoteMain.commitAll('seed two');

    const clone = await sandbox.cloneBare(URL, sandbox.root, 'clone.git');
    await clone.updateBranch('main', 'origin/main');
    const work = await clone.createWorktree(sandbox.root, 'work', 'main');
    await work.createFile('local.md', 'local change');
    await work.commitAll('local commit');

    const pending = await work.log('origin/main', 'main');
    expect(pending.map((c) => c.subject)).toEqual(['local commit']);
  });

  it('throws when called on a sandbox that is not an in-memory sandbox', () => {
    const notInMemory = { root: {} as Directory } as unknown as Parameters<typeof simulateRemote>[0];
    expect(() => simulateRemote(notInMemory, URL)).toThrow(/only works with an in-memory sandbox/);
  });
});
