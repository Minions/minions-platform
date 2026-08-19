import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves wing root from any script's own file location, given the script lives at a known
 * fixed depth under wing root (e.g. `<wingRoot>/.claude/hooks/foo.mjs` is 2 levels deep;
 * `<wingRoot>/work/local/sharing-keystones/.meta/workflow/foo.mjs` is 5 levels deep). This avoids
 * marker-file scanning (existsSync probing for a package.json, etc.) entirely — wing root is a
 * build-time-known constant relative to wherever the script is installed, valid for ANY script
 * with a fixed on-disk position, not just hooks.
 *
 * @param scriptDir - import.meta.dirname (or __dirname) of the calling script
 * @param depthUnderWingRoot - how many directory levels the script sits under wing root
 */
export function wingRootFromScriptLocation(scriptDir, depthUnderWingRoot) {
  let dir = scriptDir;
  for (let i = 0; i < depthUnderWingRoot; i++) dir = path.dirname(dir);
  return dir;
}

export function dirnameOf(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}
