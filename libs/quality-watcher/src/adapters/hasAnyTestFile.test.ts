import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import { hasAnyTestFile } from './hasAnyTestFile.js';

describe('hasAnyTestFile', () => {
  it('finds a .test.ts file directly in the dir', async () => {
    const root = createInMemorySandbox().root;
    await root.createFile('foo.test.ts', '');
    expect(await hasAnyTestFile('/root', root)).toBe(true);
  });

  it('finds a .spec.ts file nested in a subdirectory', async () => {
    const root = createInMemorySandbox().root;
    const src = await root.createDirectory('src');
    await src.createFile('thing.spec.tsx', '');
    expect(await hasAnyTestFile('/root', root)).toBe(true);
  });

  it('returns false when the subtree has no test files', async () => {
    const root = createInMemorySandbox().root;
    const src = await root.createDirectory('src');
    await root.createFile('index.ts', '');
    await src.createFile('app.ts', '');
    expect(await hasAnyTestFile('/root', root)).toBe(false);
  });

  it('does not descend into node_modules or dist looking for test files', async () => {
    const root = createInMemorySandbox().root;
    const nodeModules = await root.createDirectory('node_modules');
    const somePkg = await nodeModules.createDirectory('some-pkg');
    await somePkg.createFile('pkg.test.ts', '');
    const dist = await root.createDirectory('dist');
    await dist.createFile('bundle.test.js', '');
    expect(await hasAnyTestFile('/root', root)).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    const root = createInMemorySandbox().root;
    expect(await hasAnyTestFile('/root', root)).toBe(false);
  });
});
