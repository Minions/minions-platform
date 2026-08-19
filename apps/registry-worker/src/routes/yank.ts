import { Env } from '../types';
import { verifyGitHubToken, getInstallationToken } from '../auth';
import { readConfig, readIndex, writeIndex } from '../github';
import { jsonResponse } from '../response';

export async function handleYank(request: Request, env: Env): Promise<Response> {
  // 1. Authenticate
  const user = await verifyGitHubToken(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  // 2. Parse body
  const body = (await request.json()) as { name?: unknown; version?: unknown; reason?: unknown };
  const { name, version, reason } = body;

  if (typeof name !== 'string' || typeof version !== 'string') {
    return jsonResponse({ error: 'Missing required fields: name (string), version (string)' }, 400);
  }

  // 3. Get installation token
  const installToken = await getInstallationToken(env);

  // 4. Verify ownership
  const { config } = await readConfig(installToken, env.INDEX_REPO);
  const ownerEntry = config.packageOwners[name];

  if (!ownerEntry) {
    return jsonResponse({ error: `Package '${name}' not found` }, 404);
  }
  if (ownerEntry.github !== user.login) {
    return jsonResponse(
      { error: `Only the owner (${ownerEntry.github}) can yank this package` },
      403,
    );
  }

  // 5. Find version in index
  const { entries, sha: indexSha } = await readIndex(installToken, env.INDEX_REPO, name);
  const entry = entries.find((e) => e.version === version);

  if (!entry) {
    return jsonResponse({ error: `Version ${version} not found for package '${name}'` }, 404);
  }
  if (entry.yanked) {
    return jsonResponse({ error: `Version ${version} is already yanked` }, 409);
  }

  // 6. Update entry
  const now = new Date().toISOString();
  const updatedEntries = entries.map((e) =>
    e.version === version
      ? {
          ...e,
          yanked: true,
          yankedAt: now,
          ...(typeof reason === 'string' ? { yankReason: reason } : {}),
        }
      : e,
  );

  // 7. Write index
  await writeIndex(
    installToken,
    env.INDEX_REPO,
    name,
    updatedEntries,
    indexSha,
    `yank: ${name}@${version} by ${user.login}`,
  );

  return jsonResponse({ success: true });
}
