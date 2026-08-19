import { Env, IndexEntry } from '../types';
import { verifyGitHubToken, getInstallationToken } from '../auth';
import { readConfig, writeConfig, readIndex, writeIndex } from '../github';
import { jsonResponse } from '../response';

const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

function isPreview(version: string): boolean {
  // Stable versions are pure semver numbers (x.y.z). Any hyphen means preview.
  return !/^\d+\.\d+\.\d+$/.test(version);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Sums the size of every object in the bucket. One Class A list op per 1000 objects. */
async function getBucketUsedBytes(bucket: R2Bucket): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1000, cursor });
    for (const obj of page.objects) total += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return total;
}

export async function handlePublish(request: Request, env: Env): Promise<Response> {
  // 1. Authenticate
  const user = await verifyGitHubToken(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  // 2. Parse multipart form
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, 400);
  }

  const form = await request.formData();
  const name = form.get('name') as string | null;
  const version = form.get('version') as string | null;
  const digest = form.get('digest') as string | null;
  const archive = form.get('archive') as File | null;

  if (!name || !version || !digest || !archive || typeof archive === 'string') {
    return jsonResponse(
      { error: 'Missing required fields: name (string), version (string), digest (string), archive (file)' },
      400,
    );
  }

  // 3. Validate name and version formats
  if (!/^[a-z0-9-]+$/.test(name)) {
    return jsonResponse(
      { error: 'Invalid package name: must contain only lowercase letters, numbers, and hyphens' },
      400,
    );
  }
  if (!/^\d/.test(version)) {
    return jsonResponse({ error: 'Invalid version: must start with a digit' }, 400);
  }

  const preview = isPreview(version);
  const archiveBytes = await archive.arrayBuffer();
  const archiveKey = `${name}/${version}/${name}-${version}.tar.gz`;

  // 4. Verify digest
  const actualHex = await sha256Hex(archiveBytes);
  if (digest !== `sha256:${actualHex}`) {
    return jsonResponse({ error: 'Digest mismatch' }, 400);
  }

  // 5. Get GitHub App installation token for index repo writes
  const installToken = await getInstallationToken(env);

  // 6. Read ownership config — check or claim package
  const { config, sha: configSha } = await readConfig(installToken, env.INDEX_REPO);
  const ownerEntry = config.packageOwners[name];

  if (ownerEntry && ownerEntry.github !== user.login) {
    return jsonResponse(
      { error: `Package '${name}' is owned by ${ownerEntry.github}` },
      403,
    );
  }

  const claimingNow = !ownerEntry;
  const updatedConfig = claimingNow
    ? {
        ...config,
        packageOwners: {
          ...config.packageOwners,
          [name]: { github: user.login, claimedAt: new Date().toISOString() },
        },
      }
    : config;

  // 7. Read existing index entries
  const { entries, sha: indexSha } = await readIndex(installToken, env.INDEX_REPO, name);
  const existingEntry = entries.find((e) => e.version === version);

  if (existingEntry && !preview) {
    return jsonResponse(
      { error: `Stable version ${version} already exists and is immutable` },
      409,
    );
  }

  // 8. Check free-tier storage limit (10 GB).
  // For preview re-publishes the existing R2 object is overwritten, so only the
  // net increase counts. For new uploads the full archive size counts.
  const existingObject = existingEntry && preview
    ? await env.ARCHIVE_BUCKET.head(archiveKey)
    : null;
  const replacedBytes = existingObject?.size ?? 0;
  const usedBytes = await getBucketUsedBytes(env.ARCHIVE_BUCKET);
  const netNewBytes = archiveBytes.byteLength - replacedBytes;
  if (usedBytes + netNewBytes > R2_FREE_TIER_BYTES) {
    return jsonResponse(
      {
        error: 'Registry has reached its 10 GB storage limit',
        usedBytes,
        limitBytes: R2_FREE_TIER_BYTES,
      },
      507,
    );
  }

  // 9. Store archive in R2
  const archiveUrl = `https://quartermaster.minions.tools/${archiveKey}`;
  await env.ARCHIVE_BUCKET.put(archiveKey, archiveBytes, {
    httpMetadata: { contentType: 'application/gzip' },
  });

  // 10. Build updated index entry
  const now = new Date().toISOString();
  const newEntry: IndexEntry = {
    version,
    url: archiveUrl,
    digest,
    publishedAt: existingEntry?.publishedAt ?? now,
    yanked: false,
    isPreview: preview,
    publisher: user.login,
  };
  if (existingEntry && preview) {
    newEntry.replacedAt = now;
  }

  const updatedEntries = existingEntry
    ? entries.map((e) => (e.version === version ? newEntry : e))
    : [...entries, newEntry];

  // 11. Write ownership config (only if we just claimed the package)
  if (claimingNow) {
    await writeConfig(installToken, env.INDEX_REPO, updatedConfig, configSha);
  }

  // 12. Write index
  await writeIndex(
    installToken,
    env.INDEX_REPO,
    name,
    updatedEntries,
    indexSha,
    `publish: ${name}@${version} by ${user.login}`,
  );

  return jsonResponse({ url: archiveUrl });
}
