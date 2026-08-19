import { Env } from '../types';
import { verifyGitHubToken, getInstallationToken } from '../auth';
import { readConfig } from '../github';
import { jsonResponse } from '../response';

export async function handleMe(request: Request, env: Env): Promise<Response> {
  // 1. Authenticate
  const user = await verifyGitHubToken(request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  // 2. Get installation token and read config
  const installToken = await getInstallationToken(env);
  const { config } = await readConfig(installToken, env.INDEX_REPO);

  // 3. Find all packages owned by this user
  const ownedPackages = Object.entries(config.packageOwners)
    .filter(([, owner]) => owner.github === user.login)
    .map(([pkgName]) => pkgName);

  return jsonResponse({ login: user.login, ownedPackages });
}
