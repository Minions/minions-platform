import { describe, it, expect } from 'vitest';
import { createInMemorySandbox, createLair } from '@minions/file-store';

describe('dbg', () => {
  it('inspect', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    await lair.addWorkRepo('local', 'https://example.com/CodeWarp/suite.git');
    await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'wip/test' } });
    const wingResult = await lair.wing('workshop-03');
    if (!wingResult.exists) throw new Error('no wing');
    const wl = await wingResult.wing.workLocal();
    if (!wl.exists) throw new Error('no worklocal');
    console.log('branch', wl.worktree.branch);
    console.log('branches', await wl.worktree.branches());
    await wl.worktree.createFile('README.md', 'v2');
    await wl.worktree.commitAll('diverge');
    console.log('branches after', await wl.worktree.branches());
    console.log('baseBranch', await wl.worktree.baseBranch());
    const d = await wl.worktree.diff('main', 'HEAD');
    console.log('diff result:', JSON.stringify(d));
    const d2 = await wl.worktree.diff('main', wl.worktree.branch);
    console.log('diff result2:', JSON.stringify(d2));
    expect(true).toBe(true);
  });
});
