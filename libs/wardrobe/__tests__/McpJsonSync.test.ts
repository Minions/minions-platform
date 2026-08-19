import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { syncMcpJson } from '../src/McpJsonSync';

async function makeWingRoot(): Promise<Directory> {
  const sandbox = createInMemorySandbox();
  return sandbox.root;
}

async function readMcpJson(wingRoot: Directory): Promise<unknown> {
  const result = await wingRoot.child('.mcp.json');
  if (!result.found || result.node.kind !== 'file') return null;
  const text = await (result.node as { read(): Promise<string> }).read();
  return JSON.parse(text);
}

describe('syncMcpJson', () => {
  it('creates .mcp.json with the correct structure', async () => {
    const wingRoot = await makeWingRoot();
    await syncMcpJson(wingRoot, 'workshop-00', 3434);

    const json = await readMcpJson(wingRoot);
    expect(json).toEqual({
      mcpServers: {
        cabinet: {
          type: 'http',
          url: 'http://localhost:3434/mcp/henchery/workshop-00',
        },
      },
    });
  });

  it('overwrites an existing .mcp.json', async () => {
    const wingRoot = await makeWingRoot();

    await wingRoot.createFile('.mcp.json', JSON.stringify({ old: 'data' }));

    await syncMcpJson(wingRoot, 'workshop-01', 9999);

    const json = await readMcpJson(wingRoot);
    expect(json).toEqual({
      mcpServers: {
        cabinet: {
          type: 'http',
          url: 'http://localhost:9999/mcp/henchery/workshop-01',
        },
      },
    });
  });

  it('uses the provided port and wingName in the URL', async () => {
    const wingRoot = await makeWingRoot();
    await syncMcpJson(wingRoot, 'my-wing', 8080);

    const json = (await readMcpJson(wingRoot)) as { mcpServers: { cabinet: { url: string } } };
    expect(json.mcpServers.cabinet.url).toBe('http://localhost:8080/mcp/henchery/my-wing');
  });
});
