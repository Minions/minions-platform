import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import { readLairsConfig, writeLairsConfig, addLair } from './lairs-config.js';

describe('lairs-config', () => {
  it('readLairsConfig returns empty list when file does not exist', async () => {
    const sandbox = createInMemorySandbox();
    const config = await readLairsConfig(sandbox.root);
    expect(config).toEqual({ lairs: [] });
  });

  it('writeLairsConfig persists and readLairsConfig retrieves', async () => {
    const sandbox = createInMemorySandbox();
    const entry = { name: 'my-lair', root: '/home/user/my-lair', port: 3434 };
    await writeLairsConfig(sandbox.root, { lairs: [entry] });
    const config = await readLairsConfig(sandbox.root);
    expect(config).toEqual({ lairs: [entry] });
  });

  it('addLair appends a new entry', async () => {
    const sandbox = createInMemorySandbox();
    const entry = { name: 'my-lair', root: '/home/user/my-lair', port: 3434 };
    await addLair(sandbox.root, entry);
    const config = await readLairsConfig(sandbox.root);
    expect(config.lairs).toEqual([entry]);
  });

  it('addLair updates an existing entry matched by root', async () => {
    const sandbox = createInMemorySandbox();
    const entry = { name: 'my-lair', root: '/home/user/my-lair', port: 3434 };
    await addLair(sandbox.root, entry);
    await addLair(sandbox.root, { ...entry, port: 4000 });
    const config = await readLairsConfig(sandbox.root);
    expect(config.lairs).toEqual([{ ...entry, port: 4000 }]);
  });
});
