import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Directory, type File } from '@minions/file-store';
import { writeAdminMcpConfig, ensureAdminClaudeSettings } from './adminConfig.js';

describe('adminConfig', () => {
  let lairDir: Directory;

  beforeEach(() => {
    const sandbox = createInMemorySandbox();
    lairDir = sandbox.root;
  });

  async function readJson(path: string[]): Promise<unknown> {
    let dir: Directory = lairDir;
    for (const name of path.slice(0, -1)) {
      const result = await dir.child(name);
      if (!result.found || !result.node.is('directory')) {
        throw new Error(`Expected directory at ${name}`);
      }
      dir = result.node as Directory;
    }
    const fileResult = await dir.child(path[path.length - 1]);
    if (!fileResult.found || !fileResult.node.is('file')) {
      throw new Error(`Expected file at ${path.join('/')}`);
    }
    return JSON.parse(await (fileResult.node as File).read());
  }

  describe('writeAdminMcpConfig', () => {
    it('creates admin/.mcp.json with the given port', async () => {
      await writeAdminMcpConfig(lairDir, 3434);

      const mcp = await readJson(['admin', '.mcp.json']) as { mcpServers: Record<string, { url: string }> };
      expect(mcp.mcpServers['cabinet-lair'].url).toBe('http://localhost:3434/mcp/lair');
      expect(mcp.mcpServers['cabinet-conductor'].url).toBe('http://localhost:3434/mcp/conductor');
    });

    it('creates the admin directory if missing', async () => {
      const before = await lairDir.child('admin');
      expect(before.found).toBe(false);

      await writeAdminMcpConfig(lairDir, 3434);

      const after = await lairDir.child('admin');
      expect(after.found).toBe(true);
    });

    it('overwrites a stale or wrong mcp.json on every call', async () => {
      const adminDir = await lairDir.createDirectory('admin');
      await adminDir.createFile(
        '.mcp.json',
        JSON.stringify({ mcpServers: { bogus: { type: 'http', url: 'http://localhost:9999/nope' } } })
      );

      await writeAdminMcpConfig(lairDir, 5000);

      const mcp = await readJson(['admin', '.mcp.json']) as { mcpServers: Record<string, { url: string }> };
      expect(mcp.mcpServers.bogus).toBeUndefined();
      expect(mcp.mcpServers['cabinet-lair'].url).toBe('http://localhost:5000/mcp/lair');
    });

    it('updates the port on repeated calls', async () => {
      await writeAdminMcpConfig(lairDir, 3434);
      await writeAdminMcpConfig(lairDir, 4242);

      const mcp = await readJson(['admin', '.mcp.json']) as { mcpServers: Record<string, { url: string }> };
      expect(mcp.mcpServers['cabinet-lair'].url).toBe('http://localhost:4242/mcp/lair');
    });
  });

  describe('ensureAdminClaudeSettings', () => {
    it('creates admin/.claude/settings.json when missing', async () => {
      await ensureAdminClaudeSettings(lairDir);

      const settings = await readJson(['admin', '.claude', 'settings.json']) as {
        enabledPlugins?: Record<string, boolean>;
        hasTrustDialogHooksAccepted?: boolean;
        permissions?: { defaultMode?: string };
        model?: string;
        effortLevel?: string;
      };
      expect(settings.enabledPlugins?.['playwright@claude-plugins-official']).toBe(true);
      expect(settings.hasTrustDialogHooksAccepted).toBe(true);
      expect(settings.permissions?.defaultMode).toBe('auto');
      expect(settings.model).toBe('sonnet');
      expect(settings.effortLevel).toBe('medium');
    });

    it('overwrites a stale or wrong settings.json on every call', async () => {
      const adminDir = await lairDir.createDirectory('admin');
      const claudeDir = await adminDir.createDirectory('.claude');
      await claudeDir.createFile('settings.json', JSON.stringify({ custom: true }));

      await ensureAdminClaudeSettings(lairDir);

      const settings = await readJson(['admin', '.claude', 'settings.json']) as {
        custom?: boolean;
        enabledPlugins?: Record<string, boolean>;
        hasTrustDialogHooksAccepted?: boolean;
        permissions?: { defaultMode?: string };
        model?: string;
        effortLevel?: string;
      };
      expect(settings.custom).toBeUndefined();
      expect(settings.enabledPlugins?.['playwright@claude-plugins-official']).toBe(true);
      expect(settings.hasTrustDialogHooksAccepted).toBe(true);
      expect(settings.permissions?.defaultMode).toBe('auto');
      expect(settings.model).toBe('sonnet');
      expect(settings.effortLevel).toBe('medium');
    });
  });
});
