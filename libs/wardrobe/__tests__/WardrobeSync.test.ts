import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { syncWardrobe } from '../src/WardrobeSync';
import type { AccessoriesConfig } from '../src/AccessoriesConfig';

async function makeRoots(): Promise<{
  wingRoot: Directory;
  workLocalRoot: Directory;
  lairRoot: Directory;
}> {
  const sandbox = createInMemorySandbox();
  const wingRoot = await sandbox.root.createDirectory('wing');
  const workLocalRoot = await wingRoot.createDirectory('work-local');
  const lairRoot = await sandbox.root.createDirectory('lair');
  return { wingRoot, workLocalRoot, lairRoot };
}

async function readFile(dir: Directory, ...path: string[]): Promise<string | null> {
  let current: Directory = dir;
  for (let i = 0; i < path.length - 1; i++) {
    const r = await current.child(path[i]);
    if (!r.found || r.node.kind !== 'directory') return null;
    current = r.node as Directory;
  }
  const last = path[path.length - 1];
  const r = await current.child(last);
  if (!r.found || r.node.kind !== 'file') return null;
  return (r.node as { read(): Promise<string> }).read();
}

describe('syncWardrobe', () => {
  it('writes .mcp.json with the correct cabinet URL', async () => {
    const { wingRoot, workLocalRoot, lairRoot } = await makeRoots();
    await lairRoot.createDirectory('closet');

    const config: AccessoriesConfig = { costumes: [] };
    await syncWardrobe(wingRoot, workLocalRoot, lairRoot, 'workshop-00', config, 3434);

    const json = await readFile(wingRoot, '.mcp.json');
    expect(json).not.toBeNull();
    if (json === null) throw new Error('expected .mcp.json to exist');
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.cabinet.url).toBe(
      'http://localhost:3434/mcp/henchery/workshop-00'
    );
  });

  it('does not write settings.json when permissions is absent', async () => {
    const { wingRoot, workLocalRoot, lairRoot } = await makeRoots();
    await lairRoot.createDirectory('closet');

    const config: AccessoriesConfig = { costumes: [] };
    await syncWardrobe(wingRoot, workLocalRoot, lairRoot, 'workshop-00', config, 3434);

    const settings = await readFile(workLocalRoot, '.claude', 'settings.json');
    expect(settings).toBeNull();
  });

  it('writes permissions into settings.json when permissions is present', async () => {
    const { wingRoot, workLocalRoot, lairRoot } = await makeRoots();
    await lairRoot.createDirectory('closet');

    const config: AccessoriesConfig = {
      costumes: [],
      permissions: { allow: ['Read'], deny: [] },
    };
    await syncWardrobe(wingRoot, workLocalRoot, lairRoot, 'my-wing', config, 3434);

    const settings = await readFile(workLocalRoot, '.claude', 'settings.json');
    expect(settings).not.toBeNull();
    if (settings === null) throw new Error('expected settings.json to exist');
    const parsed = JSON.parse(settings);
    expect(parsed.permissions).toEqual({ allow: ['Read'], deny: [] });
  });

  it('creates missions junction for active costume with missions/', async () => {
    const { wingRoot, workLocalRoot, lairRoot } = await makeRoots();

    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('dev-and-check');
    const missions = await costumeDir.createDirectory('missions');
    await missions.createFile('my-task.md', '# Task');

    const config: AccessoriesConfig = { costumes: ['dev-and-check'] };
    await syncWardrobe(wingRoot, workLocalRoot, lairRoot, 'workshop-00', config, 3434);

    const cmdResult = await wingRoot.child('.claude');
    expect(cmdResult.found).toBe(true);
    if (cmdResult.found && cmdResult.node.kind === 'directory') {
      const commandsResult = await (cmdResult.node as Directory).child('commands');
      expect(commandsResult.found).toBe(true);
      if (commandsResult.found && commandsResult.node.kind === 'directory') {
        const junctionResult = await (commandsResult.node as Directory).child('dev-and-check');
        expect(junctionResult.found).toBe(true);
        if (junctionResult.found) {
          expect(junctionResult.node.kind).toBe('junction');
        }
      }
    }
  });
});
