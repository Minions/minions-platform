/**
 * PublishService — Publish a costume archive to a registry.
 *
 * Two publish paths:
 *   publishDirect — Cabinet writes directly to GitHub (Releases for archives,
 *                   Contents API for index). Suitable for the untangler registry
 *                   or personal use where the publisher controls the index repo.
 *
 *   publishViaApi — Cabinet POSTs to a Cloudflare Worker that enforces publisher
 *                   ownership and writes to R2 + GitHub. Suitable for the official
 *                   multi-publisher registry.
 */

import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { RegistryIndexEntry } from './types.js';

// ---------------------------------------------------------------------------
// Archive creation (shared between both publish paths)
// ---------------------------------------------------------------------------

/**
 * Build a tar header block (512 bytes) for a file or directory entry.
 * Uses the ustar format with GNU long-name extension for paths > 100 chars.
 */
function makeTarHeader(path: string, size: number, isDir: boolean): Uint8Array {
  const header = Buffer.alloc(512);
  const name = path.length <= 100 ? path : path.slice(-100);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8); // mode
  header.write('0000000\0', 108, 8); // uid
  header.write('0000000\0', 116, 8); // gid
  const sizeStr = isDir ? '00000000000\0' : size.toString(8).padStart(11, '0') + '\0';
  header.write(sizeStr, 124, 12);
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  header.write(mtime, 136, 12);
  header[156] = isDir ? 0x35 : 0x30; // '5' = dir, '0' = file
  header.write('ustar  \0', 257, 8);
  // Checksum: treat checksum field as spaces during calculation
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

/**
 * Create a .tar.gz archive from a directory.
 * The archive has a top-level directory named `{name}-{version}/`.
 * Returns the compressed bytes and the SHA-256 digest string.
 */
export async function createArchive(
  distDir: string,
  name: string,
  version: string
): Promise<{ archiveBuffer: Uint8Array; digest: string }> {
  const prefix = `${name}-${version}`;
  const chunks: Uint8Array[] = [];

  async function addEntry(entryPath: string, relativePath: string): Promise<void> {
    const s = await stat(entryPath);
    if (s.isDirectory()) {
      const dirHeader = makeTarHeader(prefix + '/' + relativePath + '/', 0, true);
      chunks.push(dirHeader);
      const entries = await readdir(entryPath);
      for (const entry of entries.sort()) {
        await addEntry(join(entryPath, entry), relativePath ? relativePath + '/' + entry : entry);
      }
    } else {
      const data = await readFile(entryPath);
      const fullPath = prefix + '/' + relativePath;

      // GNU long-name extension for paths > 100 chars
      if (fullPath.length > 100) {
        const longName = Buffer.from(fullPath + '\0');
        const lnHeader = makeTarHeader('././@LongLink', longName.length, false);
        (lnHeader as Buffer)[156] = 0x4c; // 'L'
        chunks.push(lnHeader);
        chunks.push(longName);
        const padding = 512 - (longName.length % 512 || 512);
        if (padding < 512) chunks.push(new Uint8Array(padding));
      }

      const fileHeader = makeTarHeader(fullPath.slice(0, 100), data.length, false);
      chunks.push(fileHeader);
      chunks.push(data);
      const padding = 512 - (data.length % 512 || 512);
      if (padding < 512) chunks.push(new Uint8Array(padding));
    }
  }

  await addEntry(distDir, '');
  chunks.push(new Uint8Array(1024)); // two end-of-archive blocks

  // Concatenate all chunks into one Uint8Array
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const tarBuffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tarBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Gzip the tar
  const gzipChunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const gz = createGzip({ level: 6 });
    const pass = new PassThrough();
    pass.on('data', (c: Uint8Array) => gzipChunks.push(c));
    pass.on('end', resolve);
    pass.on('error', reject);
    gz.pipe(pass);
    gz.write(tarBuffer);
    gz.end();
  });

  const gzTotal = gzipChunks.reduce((acc, c) => acc + c.length, 0);
  const archiveBuffer = new Uint8Array(gzTotal);
  let gzOffset = 0;
  for (const chunk of gzipChunks) {
    archiveBuffer.set(chunk, gzOffset);
    gzOffset += chunk.length;
  }

  const digest = 'sha256:' + createHash('sha256').update(archiveBuffer).digest('hex');
  return { archiveBuffer, digest };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'costume-registry-publisher/1.0',
  };
}

async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${url}: ${resp.status} ${body}`);
  }
  return resp.json() as Promise<T>;
}

interface GithubRelease {
  id: number;
  upload_url: string;
  assets: Array<{ id: number; name: string; browser_download_url: string }>;
}

async function getOrCreateRelease(
  owner: string,
  repo: string,
  tag: string,
  token: string,
  isPreview: boolean
): Promise<GithubRelease> {
  // Check if release exists
  const getResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
    { headers: githubHeaders(token) }
  );

  if (getResp.ok) {
    return getResp.json() as Promise<GithubRelease>;
  }
  if (getResp.status !== 404) {
    const body = await getResp.text().catch(() => '');
    throw new Error(`GitHub API: error checking release: ${getResp.status} ${body}`);
  }

  // Create release
  return githubJson<GithubRelease>(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: isPreview }),
    }
  );
}

async function deleteReleaseAsset(
  owner: string,
  repo: string,
  assetId: number,
  token: string
): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
    { method: 'DELETE', headers: githubHeaders(token) }
  );
}

async function uploadReleaseAsset(
  uploadUrl: string,
  filename: string,
  data: Uint8Array,
  token: string
): Promise<{ browser_download_url: string }> {
  const baseUrl = uploadUrl.replace(/\{[^}]+\}$/, '');
  const url = `${baseUrl}?name=${encodeURIComponent(filename)}`;
  return githubJson<{ browser_download_url: string }>(url, token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
    },
    body: data,
  });
}

// ---------------------------------------------------------------------------
// GitHub Contents API — index update
// ---------------------------------------------------------------------------

/**
 * Read the current index file from GitHub and return its content + SHA.
 * Returns null if the file does not exist (first publish).
 */
async function readIndexFile(
  owner: string,
  repo: string,
  name: string,
  token: string
): Promise<{ sha: string; lines: string[] } | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/index/${name}.json`;
  const resp = await fetch(url, { headers: githubHeaders(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub Contents API GET ${url}: ${resp.status} ${body}`);
  }
  const json = (await resp.json()) as { sha: string; content: string };
  const decoded = Buffer.from(json.content, 'base64').toString('utf8');
  const lines = decoded.split('\n').filter((l) => l.trim());
  return { sha: json.sha, lines };
}

/**
 * Write an updated index file to GitHub via the Contents API.
 */
async function writeIndexFile(
  owner: string,
  repo: string,
  name: string,
  version: string,
  lines: string[],
  sha: string | null,
  token: string
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/index/${name}.json`;
  const content = Buffer.from(lines.join('\n') + '\n', 'utf8').toString('base64');
  const body: Record<string, unknown> = {
    message: `publish ${name}@${version}`,
    content,
    committer: {
      name: 'Costume Publisher',
      email: 'publisher@costume-registry',
    },
  };
  if (sha) body['sha'] = sha;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text().catch(() => '');
    throw new Error(`GitHub Contents API PUT ${url}: ${resp.status} ${respBody}`);
  }
}

// ---------------------------------------------------------------------------
// Version policy helpers
// ---------------------------------------------------------------------------

export function isPreviewVersion(version: string): boolean {
  return !/^\d+\.\d+\.\d+$/.test(version);
}

// ---------------------------------------------------------------------------
// Publish result
// ---------------------------------------------------------------------------

export interface PublishResult {
  message: string;
  archiveUrl: string;
  digest: string;
  version: string;
}

// ---------------------------------------------------------------------------
// publishDirect — cabinet → GitHub Releases + GitHub Contents API
// ---------------------------------------------------------------------------

export interface PublishDirectParams {
  name: string;
  version: string;
  distDir: string;
  /** GitHub "owner/repo" of the index repository */
  indexRepo: string;
  /** GitHub OAuth token with contents:write on indexRepo */
  githubToken: string;
  /** GitHub username of the publishing user (stored in index entry) */
  publisher?: string;
  dryRun?: boolean;
}

/**
 * Publish a costume via direct GitHub access:
 * 1. Create tar.gz archive from distDir
 * 2. Get or create a GitHub Release on the indexRepo for tag `{name}@{version}`
 * 3. Upload archive as a Release asset
 * 4. Update the index file via the GitHub Contents API
 */
export async function publishDirect(params: PublishDirectParams): Promise<PublishResult> {
  const { name, version, distDir, indexRepo, githubToken, publisher, dryRun = false } = params;
  const isPreview = isPreviewVersion(version);
  const [owner, repo] = indexRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`indexRepo must be "owner/repo", got: ${indexRepo}`);
  }

  const tag = `${name}@${version}`;
  const filename = `${name}-${version}.tar.gz`;

  // 1. Create archive
  const { archiveBuffer, digest } = await createArchive(distDir, name, version);

  if (dryRun) {
    const archiveUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${filename}`;
    console.log(`[publishDirect] dry-run: archive=${filename} (${archiveBuffer.length} bytes) digest=${digest}`);
    return { message: `[dry-run] Would publish ${name}@${version}`, archiveUrl, digest, version };
  }

  // 2. Get or create release
  const release = await getOrCreateRelease(owner, repo, tag, githubToken, isPreview);

  // 3. For preview: delete existing asset if present
  if (isPreview && release.assets.length > 0) {
    const existing = release.assets.find((a) => a.name === filename);
    if (existing) {
      await deleteReleaseAsset(owner, repo, existing.id, githubToken);
    }
  }

  // 4. Upload archive
  const asset = await uploadReleaseAsset(release.upload_url, filename, archiveBuffer, githubToken);
  const archiveUrl = asset.browser_download_url;

  // 5. Read current index
  const current = await readIndexFile(owner, repo, name, githubToken);
  let lines: string[] = current?.lines ?? [];
  const sha = current?.sha ?? null;

  // Immutability check for stable versions
  if (!isPreview && lines.some((l) => { try { return (JSON.parse(l) as RegistryIndexEntry).version === version; } catch { return false; } })) {
    throw new Error(
      `Stable version ${version} of "${name}" already exists. Stable versions are immutable. ` +
      'Use a new version number or a non-semver version string (e.g. with a pre-release suffix).'
    );
  }

  // For preview: remove existing entry for this version
  if (isPreview) {
    lines = lines.filter((l) => { try { return (JSON.parse(l) as RegistryIndexEntry).version !== version; } catch { return true; } });
  }

  const now = new Date().toISOString();
  const entry: RegistryIndexEntry = {
    version,
    digest,
    url: archiveUrl,
    publisher,
    publishedAt: now,
    yanked: false,
    isPreview,
    ...(isPreview && current?.lines.some((l) => { try { return (JSON.parse(l) as RegistryIndexEntry).version === version; } catch { return false; } })
      ? { replacedAt: now }
      : {}),
  };

  // Strip undefined fields
  const cleanEntry = Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined)
  );

  lines.push(JSON.stringify(cleanEntry));

  // 6. Write index via Contents API
  await writeIndexFile(owner, repo, name, version, lines, sha, githubToken);

  return {
    message: `Published ${name}@${version} to ${indexRepo}`,
    archiveUrl,
    digest,
    version,
  };
}

// ---------------------------------------------------------------------------
// publishViaApi — cabinet → Cloudflare Worker
// ---------------------------------------------------------------------------

export interface PublishApiParams {
  name: string;
  version: string;
  distDir: string;
  /** URL of the Cloudflare Worker publish endpoint */
  apiUrl: string;
  /** GitHub OAuth token passed to the Worker for auth */
  githubToken: string;
  publisher?: string;
  dryRun?: boolean;
}

/**
 * Publish a costume via a Cloudflare Worker API:
 * 1. Create tar.gz archive from distDir
 * 2. POST to the Worker with the archive and metadata
 * 3. Worker enforces publisher ownership, stores archive in R2, updates index
 */
export async function publishViaApi(params: PublishApiParams): Promise<PublishResult> {
  const { name, version, distDir, apiUrl, githubToken, publisher, dryRun = false } = params;

  // 1. Create archive
  const { archiveBuffer, digest } = await createArchive(distDir, name, version);

  if (dryRun) {
    console.log(`[publishViaApi] dry-run: archive size=${archiveBuffer.length} bytes digest=${digest}`);
    return {
      message: `[dry-run] Would publish ${name}@${version} via ${apiUrl}`,
      archiveUrl: '',
      digest,
      version,
    };
  }

  // 2. POST to Worker using multipart/form-data
  const formData = new FormData();
  formData.append('name', name);
  formData.append('version', version);
  formData.append('digest', digest);
  if (publisher) formData.append('publisher', publisher);
  formData.append(
    'archive',
    new Blob([archiveBuffer], { type: 'application/octet-stream' }),
    `${name}-${version}.tar.gz`
  );

  const resp = await fetch(`${apiUrl}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${githubToken}` },
    body: formData,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Publish API error: ${resp.status} ${body}`);
  }

  // Worker returns { url: string } — the public R2 URL for the uploaded archive
  const result = (await resp.json()) as { url: string };
  return {
    message: `Published ${name}@${version} via ${apiUrl}`,
    archiveUrl: result.url,
    digest,
    version,
  };
}
