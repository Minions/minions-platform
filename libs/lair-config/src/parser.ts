import { load as yamlLoad } from 'js-yaml';
import type { LairConfig } from './types.js';
import { applyDefaults, type RawLairConfig } from './defaults.js';

const CONFIG_FILE_NAME = '.minions-lair.config.md';

/** Result of attempting to read and parse the config file */
export type ParseResult =
  | { found: true; config: LairConfig }
  | { found: false; config: LairConfig };

/**
 * Parse the `.minions-lair.config.md` file content.
 *
 * @param content  Raw string content of the config file
 * @param primaryRepoUrl  The URL of the primary work repo (used for defaults)
 * @returns Parsed and defaulted `LairConfig`
 */
export function parseLairConfig(content: string, primaryRepoUrl: string): LairConfig {
  const { frontMatter, body } = extractFrontMatter(content);

  let raw: Partial<RawLairConfig> = {};
  if (frontMatter) {
    const parsed = yamlLoad(frontMatter);
    if (parsed && typeof parsed === 'object') {
      raw = parsed as RawLairConfig;
    }
  }

  const config = applyDefaults(raw, primaryRepoUrl);

  // Override work_archives with the one from raw config if present
  // (applyDefaults already handles this, but we need to set postInstallMission from body)
  const postInstallBody = body.trim();
  config.postInstallMission = postInstallBody.length > 0 ? postInstallBody : null;

  return config;
}

/**
 * Read the lair config from a work archive directory.
 * Returns a `ParseResult` indicating whether the config file was found.
 *
 * @param readFile  Async function to read a file by path (relative to repo root)
 * @param primaryRepoUrl  The primary repo URL (for defaults)
 */
export async function readLairConfig(
  readFile: (path: string) => Promise<string | null>,
  primaryRepoUrl: string,
): Promise<ParseResult> {
  const content = await readFile(CONFIG_FILE_NAME);

  if (content === null) {
    // File not found — return all-default config
    const config = applyDefaults({}, primaryRepoUrl);
    config.postInstallMission = null;
    return { found: false, config };
  }

  const config = parseLairConfig(content, primaryRepoUrl);
  return { found: true, config };
}

/**
 * Extract YAML front-matter and body from a Markdown string.
 * Front-matter is delimited by `---` on its own line at the start.
 */
function extractFrontMatter(content: string): { frontMatter: string | null; body: string } {
  // Strip BOM if present
  const stripped = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/);

  // First line must be exactly `---`
  if (lines[0] !== '---') {
    return { frontMatter: null, body: stripped };
  }

  // Find the closing `---` line (starting from line 1)
  const closingIdx = lines.indexOf('---', 1);
  if (closingIdx === -1) {
    return { frontMatter: null, body: stripped };
  }

  const frontMatter = lines.slice(1, closingIdx).join('\n');
  const body = lines.slice(closingIdx + 1).join('\n');

  return {
    frontMatter: frontMatter.trim() ? frontMatter : null,
    body,
  };
}

export { CONFIG_FILE_NAME };
