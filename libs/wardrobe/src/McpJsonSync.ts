/**
 * McpJsonSync — writes the wing's .mcp.json pointing at the cabinet.
 *
 * Always overwrites. Creates the file if absent.
 */

import type { Directory } from '@minions/file-store';

const MCP_JSON_FILE = '.mcp.json';

/**
 * Write [wing-root]/.mcp.json with a cabinet MCP server entry.
 *
 * @param wingRoot - The wing's root directory
 * @param wingName - The wing name (used in the URL path)
 * @param port - The cabinet's port number
 */
export async function syncMcpJson(
  wingRoot: Directory,
  wingName: string,
  port: number
): Promise<void> {
  const content = JSON.stringify(
    {
      mcpServers: {
        cabinet: {
          type: 'http',
          url: `http://localhost:${port}/mcp/henchery/${wingName}`,
        },
      },
    },
    null,
    2
  ) + '\n';

  const existing = await wingRoot.child(MCP_JSON_FILE);
  if (existing.found && existing.node.kind === 'file') {
    await (existing.node as { write(c: string): Promise<void> }).write(content);
  } else {
    await wingRoot.createFile(MCP_JSON_FILE, content);
  }
}
