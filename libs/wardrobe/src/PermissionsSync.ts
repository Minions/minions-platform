/**
 * PermissionsSync — merges the permissions section into work/local/.claude/settings.json.
 *
 * If permissions is undefined, this is a strict no-op — settings.json is never touched.
 * If permissions is defined, reads settings.json (or starts with {}), replaces/adds the
 * permissions key, and writes back.
 */

import type { Directory } from '@minions/file-store';
import type { AccessoriesPermissions } from './AccessoriesConfig.js';

const CLAUDE_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';

async function getOrCreateDirectory(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.kind === 'directory') {
    return result.node as Directory;
  }
  return parent.createDirectory(name);
}

/**
 * Merge permissions into [work-local-root]/.claude/settings.json.
 *
 * - If permissions is undefined: no-op.
 * - If defined: read existing settings.json (defaulting to {}), replace the
 *   `permissions` key with the provided value, and write back.
 *
 * @param workLocalRoot - The [wing-root]/work/local/ directory
 * @param permissions - New permissions value, or undefined to skip
 */
export async function syncPermissions(
  workLocalRoot: Directory,
  permissions: AccessoriesPermissions | undefined
): Promise<void> {
  if (permissions === undefined) return;

  const claudeDir = await getOrCreateDirectory(workLocalRoot, CLAUDE_DIR);

  // Read existing settings or start with empty object
  let settings: Record<string, unknown> = {};
  const fileResult = await claudeDir.child(SETTINGS_FILE);
  if (fileResult.found && fileResult.node.kind === 'file') {
    try {
      const text = await (fileResult.node as { read(): Promise<string> }).read();
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON — start fresh
    }
  }

  // Replace the permissions key
  settings['permissions'] = permissions;

  const content = JSON.stringify(settings, null, 2) + '\n';

  if (fileResult.found && fileResult.node.kind === 'file') {
    await (fileResult.node as { write(c: string): Promise<void> }).write(content);
  } else {
    await claudeDir.createFile(SETTINGS_FILE, content);
  }
}
