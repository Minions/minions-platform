import { describe, it, expect } from 'vitest';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { syncMissions } from '../src/MissionsSync';

async function makeRoots(): Promise<{ wingRoot: Directory; lairRoot: Directory }> {
  const sandbox = createInMemorySandbox();
  const wingRoot = await sandbox.root.createDirectory('wing');
  const lairRoot = await sandbox.root.createDirectory('lair');
  return { wingRoot, lairRoot };
}

async function getCommands(wingRoot: Directory): Promise<string[]> {
  const claudeResult = await wingRoot.child('.claude');
  if (!claudeResult.found || claudeResult.node.kind !== 'directory') return [];
  const cmdResult = await (claudeResult.node as Directory).child('commands');
  if (!cmdResult.found || cmdResult.node.kind !== 'directory') return [];
  const children = await (cmdResult.node as Directory).children();
  return children.map((c) => c.name).sort();
}

describe('syncMissions', () => {
  it('does nothing when no active costumes and no commands dir exists', async () => {
    const { wingRoot, lairRoot } = await makeRoots();
    await syncMissions(wingRoot, lairRoot, []);
    const commands = await getCommands(wingRoot);
    expect(commands).toEqual([]);
  });

  it('creates junction for active costume with missions', async () => {
    const { wingRoot, lairRoot } = await makeRoots();

    // Set up closet with a costume that has missions/
    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('my-costume');
    const missionsDir = await costumeDir.createDirectory('missions');
    await missionsDir.createFile('do-thing.md', '# Do the thing');

    // Set up closet entry as a directory (already done above)
    // Sync
    await syncMissions(wingRoot, lairRoot, ['my-costume']);

    const commands = await getCommands(wingRoot);
    expect(commands).toContain('my-costume');
  });

  it('skips costume with no missions/ directory', async () => {
    const { wingRoot, lairRoot } = await makeRoots();

    // Closet entry exists but no missions subdirectory
    const closet = await lairRoot.createDirectory('closet');
    await closet.createDirectory('no-missions-costume');

    await syncMissions(wingRoot, lairRoot, ['no-missions-costume']);

    const commands = await getCommands(wingRoot);
    expect(commands).toEqual([]);
  });

  it('removes stale junctions not in active costumes', async () => {
    const { wingRoot, lairRoot } = await makeRoots();

    // Create a stale junction in .claude/commands/
    const claudeDir = await wingRoot.createDirectory('.claude');
    const commandsDir = await claudeDir.createDirectory('commands');

    // Set up lairRoot to have stale-costume/missions
    const closet = await lairRoot.createDirectory('closet');
    const staleDir = await closet.createDirectory('stale-costume');
    const missionsSt = await staleDir.createDirectory('missions');
    await missionsSt.createFile('old.md', '# Old');

    // Create a junction for stale-costume
    await commandsDir.createJunction('stale-costume', missionsSt);

    // Sync with empty active list
    await syncMissions(wingRoot, lairRoot, []);

    const commands = await getCommands(wingRoot);
    expect(commands).toEqual([]);
  });

  it('keeps active junctions and removes stale ones', async () => {
    const { wingRoot, lairRoot } = await makeRoots();

    const closet = await lairRoot.createDirectory('closet');

    // Active costume with missions
    const activeDir = await closet.createDirectory('active');
    const activeMissions = await activeDir.createDirectory('missions');
    await activeMissions.createFile('task.md', '# Task');

    // Stale costume with missions
    const staleDir = await closet.createDirectory('stale');
    const staleMissions = await staleDir.createDirectory('missions');
    await staleMissions.createFile('old.md', '# Old');

    // Pre-create stale junction
    const claudeDir = await wingRoot.createDirectory('.claude');
    const commandsDir = await claudeDir.createDirectory('commands');
    await commandsDir.createJunction('stale', staleMissions);

    // Sync with only 'active'
    await syncMissions(wingRoot, lairRoot, ['active']);

    const commands = await getCommands(wingRoot);
    expect(commands).toContain('active');
    expect(commands).not.toContain('stale');
  });

  it('creates .claude/commands/ directories if they do not exist', async () => {
    const { wingRoot, lairRoot } = await makeRoots();

    const closet = await lairRoot.createDirectory('closet');
    const costumeDir = await closet.createDirectory('alpha');
    const missions = await costumeDir.createDirectory('missions');
    await missions.createFile('go.md', '# Go');

    await syncMissions(wingRoot, lairRoot, ['alpha']);

    const commands = await getCommands(wingRoot);
    expect(commands).toContain('alpha');
  });

  it('skips costume not found in closet', async () => {
    const { wingRoot, lairRoot } = await makeRoots();
    await lairRoot.createDirectory('closet');

    await syncMissions(wingRoot, lairRoot, ['ghost-costume']);

    const commands = await getCommands(wingRoot);
    expect(commands).toEqual([]);
  });
});
