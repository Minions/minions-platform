import type { Directory } from '@minions/file-store';
import { type AccessoriesConfig, isAccessoriesConfig } from './AccessoriesConfig.js';

const META_DIR = '.meta';
const FILE_NAME = 'accessories.json';

async function getOrCreateDir(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.kind === 'directory') {
    return result.node as Directory;
  }
  return parent.createDirectory(name);
}

/**
 * Read the wing's accessories.json from [wing-root]/.meta/accessories.json.
 * Returns null if the file is absent, unreadable, or fails validation.
 */
export async function readAccessoriesFile(wingRoot: Directory): Promise<AccessoriesConfig | null> {
  const metaResult = await wingRoot.child(META_DIR);
  if (!metaResult.found) return null;
  if (metaResult.node.kind !== 'directory') return null;

  const fileResult = await (metaResult.node as Directory).child(FILE_NAME);
  if (!fileResult.found) return null;
  if (fileResult.node.kind !== 'file') return null;

  try {
    const text = await (fileResult.node as { read(): Promise<string> }).read();
    const parsed: unknown = JSON.parse(text);
    return isAccessoriesConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the wing's accessories.json to [wing-root]/.meta/accessories.json.
 * Creates .meta/ if it does not exist.
 */
export async function writeAccessoriesFile(
  wingRoot: Directory,
  config: AccessoriesConfig
): Promise<void> {
  const metaDir = await getOrCreateDir(wingRoot, META_DIR);
  const content = JSON.stringify(config, null, 2) + '\n';

  const existing = await metaDir.child(FILE_NAME);
  if (existing.found && existing.node.kind === 'file') {
    await (existing.node as { write(c: string): Promise<void> }).write(content);
  } else {
    await metaDir.createFile(FILE_NAME, content);
  }
}
