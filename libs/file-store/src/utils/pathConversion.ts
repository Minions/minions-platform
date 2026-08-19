import type { Sandbox, File, DirectoryLike } from '../port';
import type { WingName } from '../lair/brandedIds.js';
import { asWingName } from '../lair/brandedIds.js';

/**
 * Splits an absolute path into the segments to walk via child() *starting
 * from sandbox.root* — i.e. relative to the root's own path, not the
 * filesystem root. This matters for Disk sandboxes, whose root.path is a
 * real non-empty absolute path (e.g. "C:\Users\...\lair"): naively
 * splitting the full absolute path into segments and walking all of them
 * from sandbox.root would re-walk the root's own path components as if
 * they were child names and fail immediately. For in-memory sandboxes,
 * root.path is "" and this is a no-op (the whole path is already relative).
 *
 * Comparison is done on forward-slash-normalized strings so callers can
 * build paths with either separator (or, as in this library's own
 * convention, always forward slashes) without needing to know which OS
 * they're on.
 */
function segmentsRelativeToRoot(rootPath: string, targetPath: string): string[] {
  const posixRoot = rootPath.split('\\').join('/');
  const posixTarget = targetPath.split('\\').join('/');

  let relative: string;
  if (!posixRoot || posixTarget === posixRoot) {
    relative = posixRoot ? posixTarget.slice(posixRoot.length) : posixTarget;
  } else if (posixTarget.startsWith(`${posixRoot}/`)) {
    relative = posixTarget.slice(posixRoot.length + 1);
  } else {
    // Not under root by string comparison — treat as already relative
    // (back-compat: callers may pass a root-relative path directly).
    relative = posixTarget;
  }

  return relative.split('/').filter((s) => s.length > 0);
}

/**
 * Convert an absolute file path to a file-store File object.
 * Uses the sandbox to navigate from root to the target file.
 *
 * @param sandbox - The sandbox to navigate within
 * @param filePath - Absolute file path
 * @returns File object, or undefined if path is invalid or file not found
 */
export async function pathToFile(
  sandbox: Sandbox,
  filePath: string
): Promise<File | undefined> {
  const segments = segmentsRelativeToRoot(sandbox.root.path, filePath);

  if (segments.length === 0) {
    return undefined;
  }

  // Navigate from sandbox root through each directory segment
  let current: DirectoryLike = sandbox.root;

  // Navigate through all segments except the last (which is the file)
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const result = await current.child(segment);

    if (!result.found) {
      return undefined;
    }

    // Check if the node is directory-like (can have children)
    if (!result.node.isDirectoryLike()) {
      return undefined;
    }

    current = result.node as DirectoryLike;
  }

  // Get the final segment (the file itself)
  const fileName = segments[segments.length - 1];
  const fileResult = await current.child(fileName);

  if (!fileResult.found) {
    return undefined;
  }

  // Verify it's actually a file
  if (!fileResult.node.is('file')) {
    return undefined;
  }

  return fileResult.node as File;
}

/**
 * Convert an absolute directory-like path to a file-store node.
 * Uses the sandbox to navigate from root to the target, walking via child()
 * at every segment — this is junction-transparent by construction, since
 * child() on a Junction delegates to its target.
 *
 * Returns the resolved node whatever its directory-like kind (Directory,
 * Worktree, Junction, ReadOnlyClone, ReadOnlyDirectory) rather than requiring
 * it be literally kind "directory" — the caller asked to navigate to that
 * path, not to a specific node kind, and the path may legitimately resolve
 * through/into any of these.
 *
 * @param sandbox - The sandbox to navigate within
 * @param dirPath - Absolute directory-like path
 * @returns The resolved directory-like node, or undefined if the path is invalid or not found
 */
export async function pathToDirectory(
  sandbox: Sandbox,
  dirPath: string
): Promise<DirectoryLike | undefined> {
  const segments = segmentsRelativeToRoot(sandbox.root.path, dirPath);

  if (segments.length === 0) {
    // Root directory
    return sandbox.root.isDirectoryLike() ? sandbox.root : undefined;
  }

  // Navigate from sandbox root through each directory segment
  let current: DirectoryLike = sandbox.root;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const result = await current.child(segment);

    if (!result.found) {
      return undefined;
    }

    // Check if the node is directory-like (can have children)
    if (!result.node.isDirectoryLike()) {
      return undefined;
    }

    current = result.node as DirectoryLike;
  }

  return current;
}

/**
 * Parse wing name from a file path.
 * Extracts the wing name from paths like "D:\_Lairs\...\wings\workshop-02"
 *
 * @param filePath - File path containing wing name
 * @returns Wing name
 * @throws Error if wing name cannot be extracted from path
 */
export function parseWingNameFromPath(filePath: string): WingName {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/wings\/([^/]+)/);
  if (!match) {
    throw new Error(`Could not extract wing name from path: ${filePath}`);
  }
  return asWingName(match[1]);
}
