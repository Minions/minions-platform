import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { readClosetCostumes } from '../src/ClosetReader';

async function makeLairRoot(): Promise<Directory> {
  const sandbox = createInMemorySandbox();
  return sandbox.root;
}

describe('readClosetCostumes', () => {
  it('returns empty array when closet does not exist', async () => {
    const lairRoot = await makeLairRoot();
    expect(await readClosetCostumes(lairRoot)).toEqual([]);
  });

  it('returns empty array when closet is empty', async () => {
    const lairRoot = await makeLairRoot();
    await lairRoot.createDirectory('closet');
    expect(await readClosetCostumes(lairRoot)).toEqual([]);
  });

  it('returns a summary for a costume with missions=true', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('my-costume');
    await costumeDir.createFile(
      'costume.json',
      JSON.stringify({
        model: 'claude-opus-4-5',
        accessories: { missions: true },
      })
    );

    const result = await readClosetCostumes(lairRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'my-costume',
      hasMissions: true,
      mcpServers: {},
    });
  });

  it('returns a summary with hasMissions=false when accessories.missions is absent', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('no-missions');
    await costumeDir.createFile(
      'costume.json',
      JSON.stringify({ model: 'claude-opus-4-5' })
    );

    const result = await readClosetCostumes(lairRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'no-missions',
      hasMissions: false,
      mcpServers: {},
    });
  });

  it('includes mcpServers from accessories', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('server-costume');
    await costumeDir.createFile(
      'costume.json',
      JSON.stringify({
        model: 'claude-opus-4-5',
        accessories: {
          missions: false,
          mcpServers: {
            myServer: { type: 'http', url: 'http://localhost:9000' },
          },
        },
      })
    );

    const result = await readClosetCostumes(lairRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'server-costume',
      hasMissions: false,
      mcpServers: { myServer: { type: 'http', url: 'http://localhost:9000' } },
    });
  });

  it('skips entries that are not directories or junctions', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');
    // Create a file inside closet (not a directory/junction)
    await closet.createFile('stray-file.json', '{}');
    expect(await readClosetCostumes(lairRoot)).toEqual([]);
  });

  it('handles multiple costumes', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');

    const costumeA = await closet.createDirectory('alpha');
    await costumeA.createFile(
      'costume.json',
      JSON.stringify({ model: 'claude-opus-4-5', accessories: { missions: true } })
    );

    const costumeB = await closet.createDirectory('beta');
    await costumeB.createFile(
      'costume.json',
      JSON.stringify({ model: 'claude-opus-4-5' })
    );

    const result = await readClosetCostumes(lairRoot);
    expect(result).toHaveLength(2);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('treats missing costume.json gracefully (returns hasMissions=false, mcpServers={})', async () => {
    const lairRoot = await makeLairRoot();
    const closet = await lairRoot.createDirectory('closet');
    await closet.createDirectory('no-config');

    const result = await readClosetCostumes(lairRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'no-config',
      hasMissions: false,
      mcpServers: {},
    });
  });
});
