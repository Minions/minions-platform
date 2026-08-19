#!/usr/bin/env node
/**
 * publish-costume.mjs — Publish a built costume to a GitHub-based registry.
 *
 * Prerequisites:
 *   - Costume must be built first: pnpm exec nx build <costume-name>
 *   - GITHUB_TOKEN env var must be set with push access to the registry repo
 *
 * Usage:
 *   node scripts/publish-costume.mjs \
 *     --name dev-and-check \
 *     --version 0.1.0 \
 *     --registry codewarp/costume-registry \
 *     --dist ./costumes/dev-and-check/dist
 *
 * Options:
 *   --name        Costume package name (required)
 *   --version     Version to publish, e.g. 0.1.0 or 0.2.0-pre (required)
 *   --registry    GitHub owner/repo of the registry, e.g. codewarp/costume-registry (required)
 *   --dist        Path to the costume's dist/ directory (required)
 *   --publisher   GitHub username of the publisher (optional, defaults to authenticated user)
 *   --dry-run     Print what would happen without uploading or pushing
 *   --help        Show this help
 *
 * Version policy:
 *   - Stable versions (no pre/alpha/beta/rc suffix) are IMMUTABLE — publish is rejected
 *     if the version already exists in the index.
 *   - Preview versions (*-pre, *-alpha, *-beta, *-rc.*) are MUTABLE — re-publishing
 *     updates the archive and digest in-place.
 */

import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { printHelp(); process.exit(0); }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

function printHelp() {
  console.log(`
publish-costume.mjs — Publish a built costume to a GitHub-based registry

Usage:
  node scripts/publish-costume.mjs \\
    --name <costume-name> \\
    --version <semver> \\
    --registry <owner/repo> \\
    --dist <path-to-dist>

Options:
  --name        Costume package name (required)
  --version     Version, e.g. 0.1.0 or 0.2.0-pre (required)
  --registry    GitHub owner/repo of the index repo (required)
  --dist        Path to the built dist/ directory (required)
  --publisher   GitHub username of the publisher (optional)
  --dry-run     Show what would happen without uploading
  --help        Show this help

Environment:
  GITHUB_TOKEN  GitHub personal access token with repo scope (required)
`);
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function isPreviewVersion(version) {
  return !/^\d+\.\d+\.\d+$/.test(version);
}

// ---------------------------------------------------------------------------
// Archive creation
// ---------------------------------------------------------------------------

function makeTarHeader(path, size, isDir) {
  const header = Buffer.alloc(512);
  const name = path.length <= 100 ? path : path.slice(-100);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  const sizeStr = isDir ? '00000000000\0' : size.toString(8).padStart(11, '0') + '\0';
  header.write(sizeStr, 124, 12);
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  header.write(mtime, 136, 12);
  header[156] = isDir ? 0x35 : 0x30;
  header.write('ustar  \0', 257, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

/**
 * Create a .tar.gz archive from a directory.
 * The archive has a top-level directory named `{name}-{version}/`.
 * Returns the archive as a Buffer and its SHA-256 digest string.
 */
async function createArchive(distDir, name, version) {
  const prefix = `${name}-${version}`;
  const chunks = [];

  async function addEntry(entryPath, relativePath) {
    const s = await stat(entryPath);
    if (s.isDirectory()) {
      chunks.push(makeTarHeader(prefix + '/' + relativePath + '/', 0, true));
      const entries = await readdir(entryPath);
      for (const entry of entries.sort()) {
        await addEntry(join(entryPath, entry), relativePath ? relativePath + '/' + entry : entry);
      }
    } else {
      const data = await readFile(entryPath);
      const fullPath = prefix + '/' + relativePath;

      if (fullPath.length > 100) {
        const longName = Buffer.from(fullPath + '\0');
        const lnHeader = makeTarHeader('././@LongLink', longName.length, false);
        lnHeader[156] = 0x4c; // 'L'
        chunks.push(lnHeader);
        chunks.push(longName);
        const padding = 512 - (longName.length % 512 || 512);
        if (padding < 512) chunks.push(Buffer.alloc(padding));
      }

      const fileHeader = makeTarHeader(fullPath.slice(0, 100), data.length, false);
      chunks.push(fileHeader);
      chunks.push(data);
      const padding = 512 - (data.length % 512 || 512);
      if (padding < 512) chunks.push(Buffer.alloc(padding));
    }
  }

  await addEntry(distDir, '');
  chunks.push(Buffer.alloc(1024)); // two end-of-archive blocks

  const tarBuffer = Buffer.concat(chunks);

  const gzipChunks = [];
  await new Promise((resolve, reject) => {
    const gz = createGzip({ level: 6 });
    const pass = new PassThrough();
    pass.on('data', c => gzipChunks.push(c));
    pass.on('end', resolve);
    pass.on('error', reject);
    gz.pipe(pass);
    gz.write(tarBuffer);
    gz.end();
  });

  const archiveBuffer = Buffer.concat(gzipChunks);
  const digest = 'sha256:' + createHash('sha256').update(archiveBuffer).digest('hex');
  return { archiveBuffer, digest };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'costume-registry-publisher/1.0',
  };
}

async function githubPost(url, body, token) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text().catch(() => '');
    throw new Error(`GitHub POST ${url}: ${resp.status} ${respBody}`);
  }
  return resp.json();
}

async function getOrCreateRelease(owner, repo, tag, token, isPreview) {
  const getResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
    { headers: githubHeaders(token) }
  );
  if (getResp.ok) return getResp.json();
  if (getResp.status !== 404) {
    const body = await getResp.text().catch(() => '');
    throw new Error(`GitHub API error checking release: ${getResp.status} ${body}`);
  }
  return githubPost(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    { tag_name: tag, name: tag, draft: false, prerelease: isPreview },
    token
  );
}

async function deleteReleaseAsset(owner, repo, assetId, token) {
  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
    { method: 'DELETE', headers: githubHeaders(token) }
  );
}

async function uploadReleaseAsset(uploadUrl, filename, archiveBuffer, token) {
  const baseUrl = uploadUrl.replace(/\{[^}]+\}$/, '');
  const url = `${baseUrl}?name=${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(archiveBuffer.length),
    },
    body: archiveBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Failed to upload release asset: ${resp.status} ${body}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Index update via GitHub Contents API (no git clone needed)
// ---------------------------------------------------------------------------

/**
 * Fetch the current index file from GitHub.
 * Returns { sha, lines } or null if the file does not exist yet.
 */
async function readIndexFile(owner, repo, name, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/index/${name}.json`;
  const resp = await fetch(url, { headers: githubHeaders(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub Contents API GET ${url}: ${resp.status} ${body}`);
  }
  const json = await resp.json();
  const decoded = Buffer.from(json.content, 'base64').toString('utf8');
  const lines = decoded.split('\n').filter(l => l.trim());
  return { sha: json.sha, lines };
}

/**
 * Write the updated index file to GitHub via the Contents API.
 */
async function writeIndexFile(owner, repo, name, version, lines, sha, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/index/${name}.json`;
  const content = Buffer.from(lines.join('\n') + '\n', 'utf8').toString('base64');
  const body = {
    message: `publish ${name}@${version}`,
    content,
    committer: { name: 'Costume Publisher', email: 'publisher@costume-registry' },
    ...(sha ? { sha } : {}),
  };
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

/**
 * Update the package index file to add/replace the entry for this version.
 */
async function updateIndex({ owner, repo, name, version, digest, archiveUrl, publisher, isPreview, dryRun, token }) {
  // 1. Read existing index
  const current = await readIndexFile(owner, repo, name, token);
  let lines = current?.lines ?? [];
  const sha = current?.sha ?? null;

  // 2. Immutability check for stable versions
  if (!isPreview && lines.some(l => {
    try { return JSON.parse(l).version === version; } catch { return false; }
  })) {
    throw new Error(
      `Stable version ${version} of "${name}" already exists in the registry. ` +
      'Stable versions are immutable. Use a new version number or a preview suffix (-pre).'
    );
  }

  // 3. For preview: remove existing entry for this version
  const hadPrior = isPreview && lines.some(l => {
    try { return JSON.parse(l).version === version; } catch { return false; }
  });
  if (isPreview) {
    lines = lines.filter(l => {
      try { return JSON.parse(l).version !== version; } catch { return true; }
    });
  }

  // 4. Build new entry
  const now = new Date().toISOString();
  const entry = {
    version,
    digest,
    url: archiveUrl,
    ...(publisher ? { publisher } : {}),
    publishedAt: now,
    yanked: false,
    isPreview,
    ...(isPreview && hadPrior ? { replacedAt: now } : {}),
  };

  lines.push(JSON.stringify(entry));

  if (dryRun) {
    console.log(`  [dry-run] Would write index/${name}.json:`);
    console.log(`  ${JSON.stringify(entry)}`);
    return;
  }

  // 5. Write via Contents API
  await writeIndexFile(owner, repo, name, version, lines, sha, token);
  console.log(`  Index updated via GitHub Contents API.`);
}

// ---------------------------------------------------------------------------
// Resolve authenticated GitHub username
// ---------------------------------------------------------------------------

async function getAuthenticatedUser(token) {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'costume-registry-publisher/1.0',
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.login ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const name = args.name;
  const version = args.version;
  const registry = args.registry; // owner/repo
  const distDir = args.dist;
  const dryRun = args.dryRun ?? false;
  let publisher = args.publisher ?? null;

  if (!name || !version || !registry || !distDir) {
    console.error('Error: --name, --version, --registry, and --dist are all required.\n');
    printHelp();
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is not set.');
    process.exit(1);
  }

  const [owner, repo] = registry.split('/');
  if (!owner || !repo) {
    console.error('Error: --registry must be in owner/repo format (e.g. codewarp/costume-registry)');
    process.exit(1);
  }

  const isPreview = isPreviewVersion(version);
  const tag = `${name}@${version}`;
  const filename = `${name}-${version}.tar.gz`;

  console.log(`Publishing ${name}@${version} to ${owner}/${repo}`);
  if (isPreview) console.log('  (preview version — mutable)');
  if (dryRun) console.log('  [DRY RUN — no changes will be made]');

  // Resolve publisher if not provided
  if (!publisher) {
    publisher = await getAuthenticatedUser(token);
    if (publisher) console.log(`  Publisher: ${publisher}`);
  }

  // 1. Create archive
  console.log(`\n1. Creating archive from ${distDir}...`);
  const { archiveBuffer, digest } = await createArchive(distDir, name, version);
  console.log(`   Archive: ${filename} (${(archiveBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`   Digest:  ${digest}`);

  if (dryRun) {
    console.log('\n2. [dry-run] Would upload release asset to GitHub');
    const archiveUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${filename}`;
    await updateIndex({ owner, repo, name, version, digest, archiveUrl, publisher, isPreview, dryRun, token });
    console.log('\nDry run complete. No changes made.');
    return;
  }

  // 2. Upload release asset
  console.log(`\n2. Uploading to GitHub release ${tag}...`);
  const release = await getOrCreateRelease(owner, repo, tag, token, isPreview);

  // For preview: delete existing asset with same name if present
  if (isPreview && release.assets) {
    const existing = release.assets.find(a => a.name === filename);
    if (existing) {
      console.log(`   Replacing existing asset...`);
      await deleteReleaseAsset(owner, repo, existing.id, token);
    }
  }

  const asset = await uploadReleaseAsset(release.upload_url, filename, archiveBuffer, token);
  const archiveUrl = asset.browser_download_url;
  console.log(`   Uploaded: ${archiveUrl}`);

  // 3. Update index
  console.log(`\n3. Updating registry index...`);
  await updateIndex({ owner, repo, name, version, digest, archiveUrl, publisher, isPreview, dryRun, token });

  console.log(`\nDone. Install with:`);
  console.log(`  costumes action=install-from-registry name="${name}" version="${version}"`);
}

main().catch(err => {
  console.error('\nPublish failed:', err.message);
  process.exit(1);
});
