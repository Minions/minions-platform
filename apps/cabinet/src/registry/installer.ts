/**
 * Registry Installer
 *
 * Downloads a costume archive from a registry, verifies its SHA-256 digest,
 * extracts it to the lair closet, and creates .claude/ links for missions,
 * briefings (disguises), and skills.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, symlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { RegistryConfig, RegistryIndexEntry } from './types.js';

// ---------------------------------------------------------------------------
// Index fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the index entry for a specific package version from a registry.
 * The index file is at {indexBaseUrl}/index/{name}.json (JSON Lines format).
 */
export async function fetchIndexEntry(
  name: string,
  version: string,
  registry: RegistryConfig
): Promise<RegistryIndexEntry> {
  const url = `${registry.indexBaseUrl}/index/${name}.json`;
  const headers = buildAuthHeaders(registry);

  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Package "${name}" not found in registry`);
    }
    throw new Error(`Failed to fetch index for "${name}": HTTP ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const entry = JSON.parse(line) as RegistryIndexEntry;
    if (entry.version === version) {
      return entry;
    }
  }

  throw new Error(`Version "${version}" of package "${name}" not found in registry index`);
}

// ---------------------------------------------------------------------------
// Archive download + verification
// ---------------------------------------------------------------------------

/**
 * Download an archive from a URL and verify its SHA-256 digest.
 * Returns the verified archive as a Uint8Array.
 */
export async function downloadAndVerifyArchive(
  name: string,
  version: string,
  expectedDigest: string,
  url: string,
  authHeaders: Record<string, string> = {}
): Promise<Uint8Array> {
  const headers = { Accept: 'application/octet-stream', ...authHeaders };

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to download ${name}@${version}: HTTP ${response.status} from ${url}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  // Verify digest
  const actual = 'sha256:' + createHash('sha256').update(data).digest('hex');
  if (actual !== expectedDigest) {
    throw new Error(
      `Digest mismatch for ${name}@${version}:\n  expected: ${expectedDigest}\n  actual:   ${actual}`
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// tar.gz extraction (minimal implementation using node:zlib)
// ---------------------------------------------------------------------------

/**
 * Decompress gzip and return raw tar bytes.
 */
async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const gunzip = createGunzip();
    const readable = Readable.from(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    readable.pipe(gunzip);
    gunzip.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    gunzip.on('end', () => {
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(result);
    });
    gunzip.on('error', reject);
  });
}

/**
 * Strip trailing NUL padding from a decoded tar header field.
 * Avoids a regex control-character class (e.g. /\0+$/) by comparing char codes directly.
 */
function stripTrailingNuls(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}

/**
 * Parse a tar archive and extract entries to destDir.
 * Strips the first path component (the top-level archive directory).
 * Handles POSIX ustar format and GNU tar long-name (L) extensions.
 */
async function extractTar(tarData: Uint8Array, destDir: string): Promise<void> {
  const textDecoder = new TextDecoder('utf8');
  let offset = 0;
  let longName: string | null = null;

  while (offset + 512 <= tarData.length) {
    const header = tarData.subarray(offset, offset + 512);

    // End-of-archive: two 512-byte zero blocks
    if (header.every((b) => b === 0)) break;

    const rawName = stripTrailingNuls(textDecoder.decode(header.subarray(0, 100)));
    const typeflag = String.fromCharCode(header[156]);
    const sizeStr = stripTrailingNuls(textDecoder.decode(header.subarray(124, 136))).trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512;
    const dataBlocks = Math.ceil(size / 512);
    const data = tarData.subarray(offset, offset + size);
    offset += dataBlocks * 512;

    // GNU long name extension: next entry has the real name
    if (typeflag === 'L') {
      longName = stripTrailingNuls(textDecoder.decode(data));
      continue;
    }

    const entryName = longName ?? rawName;
    longName = null;

    if (!entryName) continue;

    // Strip the first path component (archive root dir like "dev-and-check-0.1.0/")
    const slashIndex = entryName.indexOf('/');
    if (slashIndex === -1) continue;
    const relativePath = entryName.slice(slashIndex + 1);
    if (!relativePath) continue;

    const destPath = join(destDir, relativePath);

    if (typeflag === '5' || entryName.endsWith('/')) {
      await mkdir(destPath, { recursive: true });
    } else if (typeflag === '0' || typeflag === '' || typeflag === '\0') {
      await mkdir(join(destPath, '..'), { recursive: true });
      await writeFile(destPath, data);
    }
    // Skip symlinks, hard links, and other special entry types
  }
}

/**
 * Extract a .tar.gz archive (as Uint8Array) to destDir, stripping the top-level directory.
 */
async function extractTarGz(data: Uint8Array, destDir: string): Promise<void> {
  const tarData = await gunzipBytes(data);
  await extractTar(tarData, destDir);
}

// ---------------------------------------------------------------------------
// Closet installation
// ---------------------------------------------------------------------------

/**
 * Install a registry costume into the lair closet.
 *
 * 1. Fetches the index entry and validates it is not yanked.
 * 2. Downloads and verifies the archive.
 * 3. Extracts to [lairRootPath]/closet/[name]/ (real directory, not a junction).
 * 4. Creates .claude/ symlinks for missions→commands, briefings→agents, skills→skills.
 */
export async function installFromRegistry(
  lairRootPath: string,
  name: string,
  version: string,
  registry: RegistryConfig
): Promise<{
  message: string;
  closetPath: string;
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
}> {
  // 1. Fetch and validate index entry
  const entry = await fetchIndexEntry(name, version, registry);
  if (entry.yanked) {
    throw new Error(
      `Version ${version} of "${name}" has been yanked` +
        (entry.yankReason ? `: ${entry.yankReason}` : '')
    );
  }

  // 2. Download + verify
  const authHeaders = buildAuthHeaders(registry);
  const data = await downloadAndVerifyArchive(name, version, entry.digest, entry.url, authHeaders);

  // 3. Extract to closet
  const closetPath = join(lairRootPath, 'closet', name);
  await rm(closetPath, { recursive: true, force: true });
  await mkdir(closetPath, { recursive: true });
  await extractTarGz(data, closetPath);

  // 4. Create .claude/ links
  const claudeDir = join(lairRootPath, '.claude');
  await mkdir(claudeDir, { recursive: true });

  const result: {
    message: string;
    closetPath: string;
    commandsPath?: string;
    agentsPath?: string;
    skillsPath?: string;
  } = {
    message: `Installed ${name}@${version} from registry`,
    closetPath,
  };

  result.commandsPath = await linkSubdir(closetPath, claudeDir, name, 'missions', 'commands');
  result.agentsPath = await linkSubdir(closetPath, claudeDir, name, 'briefings', 'agents');
  result.skillsPath = await linkSubdir(closetPath, claudeDir, name, 'skills', 'skills');

  return result;
}

/**
 * Create a junction/symlink: .claude/{claudeSubdir}/{name} → closet/{name}/{costumeSubdir}.
 * Returns the link path if the subdirectory exists in the extracted costume, undefined otherwise.
 */
async function linkSubdir(
  closetPath: string,
  claudeDir: string,
  name: string,
  costumeSubdir: string,
  claudeSubdir: string
): Promise<string | undefined> {
  const source = join(closetPath, costumeSubdir);
  try {
    const s = await stat(source);
    if (!s.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const targetDir = join(claudeDir, claudeSubdir);
  await mkdir(targetDir, { recursive: true });

  const linkPath = join(targetDir, name);
  await rm(linkPath, { recursive: true, force: true });
  await symlink(source, linkPath, 'junction');
  return linkPath;
}

// ---------------------------------------------------------------------------
// List versions
// ---------------------------------------------------------------------------

/**
 * List all available versions for a package from a registry index.
 */
export async function listRegistryVersions(
  name: string,
  registry: RegistryConfig
): Promise<RegistryIndexEntry[]> {
  const url = `${registry.indexBaseUrl}/index/${name}.json`;
  const headers = buildAuthHeaders(registry);

  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`Failed to fetch index for "${name}": HTTP ${response.status}`);
  }

  const text = await response.text();
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RegistryIndexEntry);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildAuthHeaders(registry: RegistryConfig): Record<string, string> {
  if (registry.auth?.type === 'github-token') {
    const token = process.env[registry.auth.envVar];
    if (!token) {
      throw new Error(`Registry auth requires env var ${registry.auth.envVar} (not set)`);
    }
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
