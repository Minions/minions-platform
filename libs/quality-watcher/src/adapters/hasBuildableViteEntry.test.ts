import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import { hasBuildableViteEntry } from './hasBuildableViteEntry.js';

describe('hasBuildableViteEntry', () => {
  it('is false for a directory with neither a vite config nor an index.html', async () => {
    const dir = createInMemorySandbox().root;

    expect(await hasBuildableViteEntry('/repo', dir)).toBe(false);
  });

  it('is true when a root index.html is present', async () => {
    const dir = createInMemorySandbox().root;
    await dir.createFile('index.html', '<!doctype html>');

    expect(await hasBuildableViteEntry('/repo', dir)).toBe(true);
  });

  it('is true when a root vite.config.ts is present', async () => {
    const dir = createInMemorySandbox().root;
    await dir.createFile('vite.config.ts', 'export default {}');

    expect(await hasBuildableViteEntry('/repo', dir)).toBe(true);
  });
});
