import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { applyTextChanges, hashContent } from './apply.js';
import type { TextChange } from './types.js';

describe('applyTextChanges', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');
    await worktree.createFile('f.ts', 'const x = 1;\n');
    await worktree.commitAll('initial');
  });

  it('applies a pinned edit and writes the patched content', async () => {
    const content = 'const x = 1;\n';
    const change: TextChange = {
      kind: 'text',
      producer: 'p',
      value: { file: 'f.ts', baseContentHash: hashContent(content), range: [6, 7], replacement: 'y' },
    };

    const result = await applyTextChanges(worktree, new Map([['f.ts', [change]]]));
    expect(result.patchedFiles).toEqual(['f.ts']);
    expect(result.staleEdits).toHaveLength(0);

    const found = await worktree.child('f.ts');
    if (found.found && found.node.kind === 'file') {
      expect(await found.node.read()).toBe('const y = 1;\n');
    } else {
      throw new Error('expected file');
    }
  });

  it('never applies an edit pinned to stale content — surfaces it instead', async () => {
    const change: TextChange = {
      kind: 'text',
      producer: 'p',
      value: { file: 'f.ts', baseContentHash: hashContent('this is not the current content'), range: [0, 1], replacement: 'z' },
    };

    const result = await applyTextChanges(worktree, new Map([['f.ts', [change]]]));
    expect(result.patchedFiles).toHaveLength(0);
    expect(result.staleEdits).toEqual([change]);

    const found = await worktree.child('f.ts');
    if (found.found && found.node.kind === 'file') {
      expect(await found.node.read()).toBe('const x = 1;\n');
    } else {
      throw new Error('expected file');
    }
  });
});
