import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { WingManager, installToolLogHookTo, ensureDefaultPermissions } from './WingManager';
import { TOOL_LOG_HOOK_SCRIPT } from '@minions/movement-branching';
import {
  createInMemorySandbox,
  createLair,
  simulateRemote,
  resolveMovementBase,
  type Sandbox,
  type Lair,
  type File,
} from '@minions/file-store';

const REPO_URL = 'https://example.com/CodeWarp/suite.git';

/** Seeds a bare "remote" repo with a `main` branch and an `experiment/exp1/a` branch,
 * then clones it in as this lair's `local` work repo — mirrors
 * `ExperimentsService.test.ts`'s `seedRemoteMain` helper. */
async function seedLocalWorkRepo(sandbox: Sandbox, lair: Lair): Promise<void> {
  const remote = simulateRemote(sandbox, REPO_URL);
  const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
  await remoteMain.createFile('README.md', '# suite');
  await remoteMain.commitAll('seed origin main');
  const remoteExperiment = await remote.createWorktree(sandbox.root, 'remote-seed-exp', 'experiment/exp1/a');
  await remoteExperiment.createFile('EXPERIMENT.md', '# exp1/a');
  await remoteExperiment.commitAll('seed experiment/exp1/a');
  await lair.addWorkRepo('local', REPO_URL);
}

const TEST_PORT = 3434;

describe('WingManager', () => {
  let sandbox: Sandbox;
  let lair: Lair;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    lair = createLair(sandbox);
  });

  it('derives lair name from sandbox root', () => {
    const manager = new WingManager(lair, TEST_PORT);
    // In-memory sandbox root is named "sandbox" by default
    expect(manager.lairName).toBe('sandbox');
  });

  it('discovers wings from filesystem', async () => {
    const wingsDir = await sandbox.root.createDirectory('wings');
    const wing1Dir = await wingsDir.createDirectory('wing1');
    const wing1WorkDir = await wing1Dir.createDirectory('work');
    await wing1WorkDir.createDirectory('local');

    const wing2Dir = await wingsDir.createDirectory('wing2');
    const wing2WorkDir = await wing2Dir.createDirectory('work');
    await wing2WorkDir.createDirectory('local');

    const manager = new WingManager(lair, TEST_PORT);
    await manager.scan();

    const wings = manager.getWings();
    expect(wings.length).toBe(2);
    expect(wings.map(w => w.name)).toContain('wing1');
    expect(wings.map(w => w.name)).toContain('wing2');
  });

  it('lists available work repos from work/', async () => {
    const workDir = await sandbox.root.createDirectory('work');
    await sandbox.initBare(workDir, 'suite.git');
    await sandbox.initBare(workDir, 'another.git');

    const manager = new WingManager(lair, TEST_PORT);
    const repos = await manager.getAvailableWorkRepos();

    expect(repos).toContain('suite');
    expect(repos).toContain('another');
  });

  it('returns empty array when work directory does not exist', async () => {
    const manager = new WingManager(lair, TEST_PORT);
    const repos = await manager.getAvailableWorkRepos();
    expect(repos).toEqual([]);
  });

  it('rejects duplicate wing names', async () => {
    await sandbox.root.createDirectory('wings');
    await sandbox.root.createDirectory('info');

    const manager = new WingManager(lair, TEST_PORT);

    await manager.createWing({
      name: 'dup',
      workLocalRepo: 'nonexistent',
      workLocalBranch: 'main'
    });

    await expect(
      manager.createWing({
        name: 'dup',
        workLocalRepo: 'nonexistent',
        workLocalBranch: 'main'
      })
    ).rejects.toThrow('already exists');
  });

  describe('installToolLogHookTo', () => {
    let wingRoot: string;

    beforeEach(() => {
      wingRoot = mkdtempSync(join(tmpdir(), 'wing-hook-test-'));
    });

    afterEach(() => {
      rmSync(wingRoot, { recursive: true, force: true });
    });

    // Wing root is {lairRoot}/wings/{wingName}, so two dirnames up = lairRoot,
    // and the shared hook script is written to {lairRoot}/tools/log-tool-use.cjs.
    const scriptPathFor = (root: string) =>
      join(dirname(dirname(root)), 'tools', 'log-tool-use.cjs').replace(/\\/g, '/');

    it('creates the hook script at {lairRoot}/tools/log-tool-use.cjs', async () => {
      await installToolLogHookTo(wingRoot);
      expect(existsSync(scriptPathFor(wingRoot))).toBe(true);
    });

    it('writes the CJS tool log hook script that references the tool log', async () => {
      await installToolLogHookTo(wingRoot);
      const content = readFileSync(scriptPathFor(wingRoot), 'utf-8');
      expect(content).toBe(TOOL_LOG_HOOK_SCRIPT);
      expect(content).toContain("'use strict'");
      expect(content).toContain('require(');
      expect(content).toContain('tool_name');
      expect(content).toContain('tool-log.jsonl');
    });

    it('creates .claude/settings.json with PostToolUse hook if it does not exist', async () => {
      await installToolLogHookTo(wingRoot);
      const settings = JSON.parse(readFileSync(join(wingRoot, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks?.PostToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('log-tool-use.cjs');
    });

    it('uses an absolute hook command with the wing name argument', async () => {
      await installToolLogHookTo(wingRoot);
      const settings = JSON.parse(readFileSync(join(wingRoot, '.claude', 'settings.json'), 'utf-8'));
      const command: string = settings.hooks.PostToolUse[0].hooks[0].command;
      const wingName = basename(wingRoot);
      expect(command).toBe(`node ${scriptPathFor(wingRoot)} ${wingName}`);
    });

    it('merges hook into existing settings.json without removing other settings', async () => {
      await mkdir(join(wingRoot, '.claude'), { recursive: true });
      await writeFile(
        join(wingRoot, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'playwright@claude-plugins-official': true } }, null, 2),
      );

      await installToolLogHookTo(wingRoot);

      const settings = JSON.parse(readFileSync(join(wingRoot, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.enabledPlugins?.['playwright@claude-plugins-official']).toBe(true);
      expect(settings.hooks?.PostToolUse).toBeDefined();
    });

    it('is idempotent — does not add duplicate hook entries on repeated calls', async () => {
      await installToolLogHookTo(wingRoot);
      await installToolLogHookTo(wingRoot);
      const settings = JSON.parse(readFileSync(join(wingRoot, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks.PostToolUse).toHaveLength(1);
    });
  });

  describe('ensureDefaultPermissions', () => {
    it('sets permissions.defaultMode to acceptEdits when settings.json does not exist', async () => {
      const dirSandbox = createInMemorySandbox();
      await ensureDefaultPermissions(dirSandbox.root);

      const settingsResult = await dirSandbox.root.child('.claude');
      expect(settingsResult.found).toBe(true);
      if (settingsResult.found && settingsResult.node.is('directory')) {
        const fileResult = await settingsResult.node.child('settings.json');
        expect(fileResult.found).toBe(true);
        if (fileResult.found && fileResult.node.is('file')) {
          const settings = JSON.parse(await (fileResult.node as File).read());
          expect(settings.permissions.defaultMode).toBe('acceptEdits');
        }
      }
    });

    it('preserves an existing custom defaultMode without overwriting it', async () => {
      const dirSandbox = createInMemorySandbox();
      const claudeDir = await dirSandbox.root.createDirectory('.claude');
      await claudeDir.createFile(
        'settings.json',
        JSON.stringify({ permissions: { defaultMode: 'plan' } }),
      );

      await ensureDefaultPermissions(dirSandbox.root);

      const fileResult = await claudeDir.child('settings.json');
      if (fileResult.found && fileResult.node.is('file')) {
        const settings = JSON.parse(await (fileResult.node as File).read());
        expect(settings.permissions.defaultMode).toBe('plan');
      }
    });

    it('merges into existing settings.json without removing other settings', async () => {
      const dirSandbox = createInMemorySandbox();
      const claudeDir = await dirSandbox.root.createDirectory('.claude');
      await claudeDir.createFile(
        'settings.json',
        JSON.stringify({ enabledPlugins: { 'playwright@claude-plugins-official': true } }),
      );

      await ensureDefaultPermissions(dirSandbox.root);

      const fileResult = await claudeDir.child('settings.json');
      if (fileResult.found && fileResult.node.is('file')) {
        const settings = JSON.parse(await (fileResult.node as File).read());
        expect(settings.enabledPlugins?.['playwright@claude-plugins-official']).toBe(true);
        expect(settings.permissions.defaultMode).toBe('acceptEdits');
      }
    });
  });

  describe('wing creation writes .mcp.json', () => {
    beforeEach(async () => {
      await sandbox.root.createDirectory('wings');
      await sandbox.root.createDirectory('info');
    });

    it('writes .claude/settings.json with permissions.defaultMode "acceptEdits"', async () => {
      const manager = new WingManager(lair, TEST_PORT);

      const wing = await manager.createWing({
        name: 'test-wing',
        workLocalRepo: 'nonexistent',
        workLocalBranch: 'main',
      });

      const claudeDirResult = await wing.root.child('.claude');
      expect(claudeDirResult.found).toBe(true);
      if (claudeDirResult.found && claudeDirResult.node.is('directory')) {
        const settingsResult = await claudeDirResult.node.child('settings.json');
        expect(settingsResult.found).toBe(true);
        if (settingsResult.found && settingsResult.node.is('file')) {
          const settings = JSON.parse(await (settingsResult.node as File).read());
          expect(settings.permissions.defaultMode).toBe('acceptEdits');
        }
      }
    });

    it('always writes .mcp.json at wing root', async () => {
      const manager = new WingManager(lair, TEST_PORT);

      const wing = await manager.createWing({
        name: 'test-wing',
        workLocalRepo: 'nonexistent',
        workLocalBranch: 'main',
      });

      const mcpJsonResult = await wing.root.child('.mcp.json');
      expect(mcpJsonResult.found).toBe(true);
    });

    it('writes correct MCP server URL using cabinet port', async () => {
      const manager = new WingManager(lair, TEST_PORT);

      const wing = await manager.createWing({
        name: 'test-wing',
        workLocalRepo: 'nonexistent',
        workLocalBranch: 'main',
      });

      const mcpJsonResult = await wing.root.child('.mcp.json');
      expect(mcpJsonResult.found).toBe(true);
      if (mcpJsonResult.found && mcpJsonResult.node.is('file')) {
        const content = await (mcpJsonResult.node as File).read();
        const parsed = JSON.parse(content);
        expect(parsed.mcpServers.cabinet.type).toBe('http');
        expect(parsed.mcpServers.cabinet.url).toBe(`http://localhost:${TEST_PORT}/mcp/henchery/test-wing`);
      }
    });

    it('uses the correct port from the WingManager instance', async () => {
      const customPort = 5000;
      const manager = new WingManager(lair, customPort);

      const wing = await manager.createWing({
        name: 'custom-port-wing',
        workLocalRepo: 'nonexistent',
        workLocalBranch: 'main',
      });

      const mcpJsonResult = await wing.root.child('.mcp.json');
      if (mcpJsonResult.found && mcpJsonResult.node.is('file')) {
        const content = await (mcpJsonResult.node as File).read();
        const parsed = JSON.parse(content);
        expect(parsed.mcpServers.cabinet.url).toBe(`http://localhost:${customPort}/mcp/henchery/custom-port-wing`);
      }
    });
  });

  // `createWing`'s `trunk` option and `setWingTrunk` persist the trunk
  // override via the design-doc-§4.2 `WorkArea.beginNewActiveMovement`/
  // `BareRepository.setMovementBase` surface (see WingManager.ts) — the
  // real, ordinary repo-level, branch-name-keyed mechanism, distinct from
  // the lower-level `--worktree`-scoped `Worktree.setBaseBranch` primitive.
  // These tests exercise the resulting worktree-visible behavior end to end
  // via `resolveMovementBase()`, the same read helper real callers
  // (MCPServer.ts, PlanActionGroup.ts, WingPerspective.ts,
  // MovementSession.ts, MovementManager.ts, MovementActionGroup.ts) use —
  // NOT the raw `Worktree.baseBranch()`, which does not reflect a base set
  // through this surface (see `SiteWorkArea.beginNewActiveMovement`'s doc
  // comment: writes only go to the repo-level mechanism).
  describe('trunk override (design doc §4.2 Movement.base: Trunk)', () => {
    beforeEach(async () => {
      await sandbox.root.createDirectory('wings');
      await sandbox.root.createDirectory('info');
      await seedLocalWorkRepo(sandbox, lair);
    });

    it('createWing with a trunk option sets the work/local trunk override at creation', async () => {
      const manager = new WingManager(lair, TEST_PORT);

      const wing = await manager.createWing({
        name: 'exp-wing',
        workLocalRepo: 'local',
        workLocalBranch: 'l/sandbox/w/exp-wing/local',
        trunk: 'experiment/exp1/a',
      });

      const workLocalResult = await wing.workLocal();
      if (!workLocalResult.exists) throw new Error('expected work/local');
      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('experiment/exp1/a');
    });

    it('createWing without a trunk option leaves the trunk override unset (falls back to remote default)', async () => {
      const manager = new WingManager(lair, TEST_PORT);

      const wing = await manager.createWing({
        name: 'plain-wing',
        workLocalRepo: 'local',
        workLocalBranch: 'l/sandbox/w/plain-wing/local',
      });

      const workLocalResult = await wing.workLocal();
      if (!workLocalResult.exists) throw new Error('expected work/local');
      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('main');
    });

    it('setWingTrunk retargets an existing wing\'s trunk override', async () => {
      const manager = new WingManager(lair, TEST_PORT);
      const wing = await manager.createWing({
        name: 'retarget-wing',
        workLocalRepo: 'local',
        workLocalBranch: 'l/sandbox/w/retarget-wing/local',
      });
      const workLocalResult = await wing.workLocal();
      if (!workLocalResult.exists) throw new Error('expected work/local');
      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('main');

      await manager.setWingTrunk('retarget-wing', 'experiment/exp1/a');

      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('experiment/exp1/a');
    });

    it('setWingTrunk(name, null) clears the trunk override back to the remote default', async () => {
      const manager = new WingManager(lair, TEST_PORT);
      const wing = await manager.createWing({
        name: 'clear-wing',
        workLocalRepo: 'local',
        workLocalBranch: 'l/sandbox/w/clear-wing/local',
        trunk: 'experiment/exp1/a',
      });
      const workLocalResult = await wing.workLocal();
      if (!workLocalResult.exists) throw new Error('expected work/local');
      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('experiment/exp1/a');

      await manager.setWingTrunk('clear-wing', null);

      expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('main');
    });

    it('setWingTrunk throws for an unknown wing', async () => {
      const manager = new WingManager(lair, TEST_PORT);
      await expect(manager.setWingTrunk('no-such-wing', 'main')).rejects.toThrow('not found');
    });
  });
});
