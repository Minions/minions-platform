import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import { readDominionPort, writeDominionPort } from './portConfig.js';

describe('portConfig', () => {
  it('readDominionPort returns null when file does not exist', async () => {
    const sandbox = createInMemorySandbox();
    const port = await readDominionPort(sandbox.root);
    expect(port).toBeNull();
  });

  it('writeDominionPort persists and readDominionPort retrieves', async () => {
    const sandbox = createInMemorySandbox();
    await writeDominionPort(sandbox.root, 3535);
    const port = await readDominionPort(sandbox.root);
    expect(port).toBe(3535);
  });
});
