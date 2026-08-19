import { Config, IndexEntry } from './types';

interface GitHubFileContent {
  content: string;
  sha: string;
  encoding: string;
}

function splitRepo(indexRepo: string): { owner: string; repo: string } {
  const slash = indexRepo.indexOf('/');
  return { owner: indexRepo.slice(0, slash), repo: indexRepo.slice(slash + 1) };
}

function decodeContent(content: string): string {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'costume-registry/1.0',
    'Content-Type': 'application/json',
  };
}

async function readFile(
  token: string,
  indexRepo: string,
  path: string,
): Promise<{ text: string; sha: string } | null> {
  const { owner, repo } = splitRepo(indexRepo);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: ghHeaders(token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${path} failed: ${res.status}`);
  const data = (await res.json()) as GitHubFileContent;
  return { text: decodeContent(data.content), sha: data.sha };
}

async function writeFile(
  token: string,
  indexRepo: string,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<void> {
  const { owner, repo } = splitRepo(indexRepo);
  const body: Record<string, string> = { message, content: encodeContent(text) };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub write ${path} failed: ${res.status} ${detail}`);
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export async function readConfig(
  token: string,
  indexRepo: string,
): Promise<{ config: Config; sha?: string }> {
  const result = await readFile(token, indexRepo, 'config.json');
  if (!result) return { config: { schemaVersion: 1, packageOwners: {} } };
  return { config: JSON.parse(result.text) as Config, sha: result.sha };
}

export async function writeConfig(
  token: string,
  indexRepo: string,
  config: Config,
  sha?: string,
): Promise<void> {
  await writeFile(
    token,
    indexRepo,
    'config.json',
    JSON.stringify(config, null, 2) + '\n',
    'chore: update package ownership',
    sha,
  );
}

// ── Index ─────────────────────────────────────────────────────────────────────

export async function readIndex(
  token: string,
  indexRepo: string,
  name: string,
): Promise<{ entries: IndexEntry[]; sha?: string }> {
  const result = await readFile(token, indexRepo, `index/${name}.json`);
  if (!result) return { entries: [] };
  const entries = result.text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as IndexEntry);
  return { entries, sha: result.sha };
}

export async function writeIndex(
  token: string,
  indexRepo: string,
  name: string,
  entries: IndexEntry[],
  sha?: string,
  message?: string,
): Promise<void> {
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(
    token,
    indexRepo,
    `index/${name}.json`,
    text,
    message ?? `chore: update index for ${name}`,
    sha,
  );
}
