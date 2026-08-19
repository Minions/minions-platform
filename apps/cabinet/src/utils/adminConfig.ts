import type { Directory, File } from '@minions/file-store';

async function getOrCreateDirectory(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.is('directory')) {
    return result.node as Directory;
  }
  return parent.createDirectory(name);
}

async function writeFile(dir: Directory, name: string, content: string): Promise<void> {
  const result = await dir.child(name);
  if (result.found && result.node.is('file')) {
    await (result.node as File).write(content);
  } else {
    await dir.createFile(name, content);
  }
}

/**
 * Write admin/.mcp.json pointing at this cabinet instance's port, overwriting
 * any stale contents. Called on every built-product startup so the admin area
 * is always correctly configured even if the port changed or the file is
 * missing entirely — a human launching Claude Code from admin/ without going
 * through launch-lair-claude.mjs still gets working MCP tools.
 */
export async function writeAdminMcpConfig(lairDir: Directory, port: number): Promise<void> {
  const adminDir = await getOrCreateDirectory(lairDir, 'admin');

  const mcpConfig = {
    mcpServers: {
      'cabinet-lair': { type: 'http', url: `http://localhost:${port}/mcp/lair` },
      'cabinet-conductor': { type: 'http', url: `http://localhost:${port}/mcp/conductor` },
    },
  };

  await writeFile(adminDir, '.mcp.json', JSON.stringify(mcpConfig, null, 2) + '\n');
}

/**
 * Write admin/.claude/settings.json with its default plugin and permission
 * config, overwriting any stale contents. admin/ is entirely under our
 * control (not human-edited), so this always ensures the file is correct
 * and complete rather than only filling it in when missing.
 */
export async function ensureAdminClaudeSettings(lairDir: Directory): Promise<void> {
  const adminDir = await getOrCreateDirectory(lairDir, 'admin');
  const claudeDir = await getOrCreateDirectory(adminDir, '.claude');

  await writeFile(
    claudeDir,
    'settings.json',
    JSON.stringify(
      {
        enabledPlugins: { 'playwright@claude-plugins-official': true },
        hasTrustDialogHooksAccepted: true,
        permissions: { defaultMode: 'auto' },
        model: 'sonnet',
        effortLevel: 'medium',
      },
      null,
      2
    ) + '\n'
  );
}
