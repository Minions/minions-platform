import { describe, it, expect } from 'vitest';
import { dispatchActionGroup } from '@minions/mcp-types';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory, Sandbox } from '@minions/file-store';
import { createCostumesActionGroup } from '../src/CostumesActionGroup';
import type { AccessoriesConfig } from '../src/AccessoriesConfig';

// Minimal ActionContext matching mcp-types
interface ActionContext {
  lair: Sandbox;
  [key: string]: unknown;
}

async function makeLairSandbox(): Promise<{ ctx: ActionContext; lairRoot: Directory }> {
  const sandbox = createInMemorySandbox();
  const lairRoot = sandbox.root;
  // Create wings/ and closet/ at lair root
  await lairRoot.createDirectory('wings');
  await lairRoot.createDirectory('closet');
  return { ctx: { lair: sandbox }, lairRoot };
}

async function makeWingInLair(
  lairRoot: Directory,
  wingName: string
): Promise<Directory> {
  const wings = await lairRoot.child('wings');
  if (!wings.found || wings.node.kind !== 'directory') throw new Error('wings not found');
  const wingsDir = wings.node as Directory;
  const wingDir = await wingsDir.createDirectory(wingName);
  return wingDir;
}

async function writeAccessoriesJson(wingRoot: Directory, config: AccessoriesConfig): Promise<void> {
  const meta = await wingRoot.createDirectory('.meta');
  await meta.createFile('accessories.json', JSON.stringify(config));
}

describe('createCostumesActionGroup', () => {
  it('returns an ActionGroupDef with name "costumes"', () => {
    const group = createCostumesActionGroup(3434);
    expect(group.name).toBe('costumes');
    expect(group.coreActions).toHaveProperty('list');
    expect(group.coreActions).toHaveProperty('status');
    expect(group.coreActions).toHaveProperty('change');
  });

  describe('list action', () => {
    it('returns empty list when closet is empty', async () => {
      const { ctx } = await makeLairSandbox();
      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'list' }, ctx);
      expect(result).toMatchObject({ action: 'list', costumes: [] });
    });

    it('returns summaries for installed costumes', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      const closetResult = await lairRoot.child('closet');
      if (!closetResult.found) throw new Error('closet not found');
      const closet = closetResult.node as Directory;
      const costume = await closet.createDirectory('my-costume');
      await costume.createFile(
        'costume.json',
        JSON.stringify({ model: 'claude-opus-4-5', accessories: { missions: true } })
      );

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'list' }, ctx) as {
        action: string;
        costumes: Array<{ name: string; isDebugInstalled: boolean; missions: string[] }>;
      };
      expect(result.action).toBe('list');
      expect(result.costumes).toHaveLength(1);
      expect(result.costumes[0].name).toBe('my-costume');
      // listInstalledCostumes returns InstalledCostumeSummary with missions array
      expect(Array.isArray(result.costumes[0].missions)).toBe(true);
    });
  });

  describe('status action', () => {
    it('returns status for a wing', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      const wingRoot = await makeWingInLair(lairRoot, 'workshop-00');
      await writeAccessoriesJson(wingRoot, { costumes: ['my-costume'] });

      const closetResult = await lairRoot.child('closet');
      if (!closetResult.found) throw new Error('closet not found');
      const closet = closetResult.node as Directory;
      await closet.createDirectory('my-costume');

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, {
        action: 'status',
        wing: 'workshop-00',
      }, ctx) as { action: string; wing: string; activeCostumes: string[] };

      expect(result.action).toBe('status');
      expect(result.wing).toBe('workshop-00');
      expect(result.activeCostumes).toContain('my-costume');
    });

    it('returns status with empty costumes when accessories.json is absent', async () => {
      const { ctx } = await makeLairSandbox();
      // No wing created — wing directory doesn't exist

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, {
        action: 'status',
        wing: 'no-such-wing',
      }, ctx) as { action: string; activeCostumes: string[] };

      expect(result.action).toBe('status');
      expect(result.activeCostumes).toEqual([]);
    });
  });

  describe('change action', () => {
    it('writes accessories.json for the wing', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      const wingRoot = await makeWingInLair(lairRoot, 'workshop-00');
      // Create work/local inside wing for settings.json support
      await wingRoot.createDirectory('work');
      const work = await wingRoot.child('work');
      if (work.found && work.node.kind === 'directory') {
        await (work.node as Directory).createDirectory('local');
      }

      const newConfig: AccessoriesConfig = { costumes: ['dev-and-check'] };

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, {
        action: 'change',
        wing: 'workshop-00',
        to: JSON.stringify(newConfig),
      }, ctx) as { action: string; wing: string };

      expect(result.action).toBe('change');
      expect(result.wing).toBe('workshop-00');

      // Verify accessories.json was written
      const metaResult = await wingRoot.child('.meta');
      expect(metaResult.found).toBe(true);
      if (metaResult.found && metaResult.node.kind === 'directory') {
        const fileResult = await (metaResult.node as Directory).child('accessories.json');
        expect(fileResult.found).toBe(true);
        if (fileResult.found && fileResult.node.kind === 'file') {
          const text = await (fileResult.node as { read(): Promise<string> }).read();
          expect(JSON.parse(text)).toMatchObject({ costumes: ['dev-and-check'] });
        }
      }
    });

    it('returns error for invalid JSON in to param', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      await makeWingInLair(lairRoot, 'workshop-00');

      const group = createCostumesActionGroup(3434);
      await expect(
        dispatchActionGroup(group, {
          action: 'change',
          wing: 'workshop-00',
          to: 'not-valid-json',
        }, ctx)
      ).rejects.toThrow();
    });

    it('returns error for config that fails validation', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      await makeWingInLair(lairRoot, 'workshop-00');

      const group = createCostumesActionGroup(3434);
      await expect(
        dispatchActionGroup(group, {
          action: 'change',
          wing: 'workshop-00',
          to: JSON.stringify({ costumes: 'not-an-array' }),
        }, ctx)
      ).rejects.toThrow();
    });
  });

  describe('sync-all action', () => {
    it('returns empty results when wings/ does not exist', async () => {
      const sandbox = createInMemorySandbox();
      const ctx = { lair: sandbox };
      // No wings/ directory

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'sync-all' }, ctx) as {
        action: string;
        results: unknown[];
      };
      expect(result.action).toBe('sync-all');
      expect(result.results).toEqual([]);
    });

    it('syncs a wing with existing accessories.json', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      const wingRoot = await makeWingInLair(lairRoot, 'workshop-01');
      await wingRoot.createDirectory('work');
      const work = await wingRoot.child('work');
      if (work.found && work.node.kind === 'directory') {
        await (work.node as Directory).createDirectory('local');
      }
      await writeAccessoriesJson(wingRoot, { costumes: ['dev-and-check'] });

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'sync-all' }, ctx) as {
        action: string;
        results: Array<{ wing: string; status: string }>;
      };

      expect(result.action).toBe('sync-all');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ wing: 'workshop-01', status: 'synced' });

      // .mcp.json should have been written at wing root
      const mcpResult = await wingRoot.child('.mcp.json');
      expect(mcpResult.found).toBe(true);
    });

    it('initializes wings without accessories.json using empty costumes', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      const wingRoot = await makeWingInLair(lairRoot, 'workshop-02');
      // No accessories.json — directory only

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'sync-all' }, ctx) as {
        action: string;
        results: Array<{ wing: string; status: string }>;
      };

      expect(result.results[0]).toMatchObject({ wing: 'workshop-02', status: 'synced' });
      // .mcp.json should be written
      const mcpResult = await wingRoot.child('.mcp.json');
      expect(mcpResult.found).toBe(true);
    });

    it('reports error for a wing that fails sync, continues to next', async () => {
      const { ctx, lairRoot } = await makeLairSandbox();
      // Wing without work/ or any sub-structure — sync will still succeed (uses wingRoot as fallback)
      await makeWingInLair(lairRoot, 'wing-a');
      await makeWingInLair(lairRoot, 'wing-b');

      const group = createCostumesActionGroup(3434);
      const result = await dispatchActionGroup(group, { action: 'sync-all' }, ctx) as {
        action: string;
        results: Array<{ wing: string; status: string }>;
      };

      expect(result.results).toHaveLength(2);
      // Both should succeed (no missions to link, no permissions to write)
      expect(result.results.every((r) => r.status === 'synced')).toBe(true);
    });
  });
});
