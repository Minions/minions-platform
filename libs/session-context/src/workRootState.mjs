import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function stateDir(wingRoot) {
  return path.join(wingRoot, "private", "untracked", "session-context");
}

function statePath(wingRoot, sessionId) {
  return path.join(stateDir(wingRoot), `${sessionId}.json`);
}

export function defaultWorkRoot(wingRoot) {
  return path.join(wingRoot, "work", "local");
}

/**
 * Returns the current work root for this session, defaulting to
 * <wingRoot>/work/local if no state has been recorded yet.
 *
 * Known gap: a sub-agent gets a distinct session_id from its parent, and the
 * PreToolUse/hook stdin contract observed does not expose a parent-session
 * link, so a sub-agent cannot automatically inherit a parent's *changed*
 * work root — it falls back to the same default. Only the default is
 * guaranteed consistent across a session tree; explicit work-root changes
 * are not currently propagated to children. See session-context README.
 */
export function getWorkRoot(wingRoot, sessionId) {
  const file = statePath(wingRoot, sessionId);
  if (!existsSync(file)) return defaultWorkRoot(wingRoot);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed.workRoot || defaultWorkRoot(wingRoot);
  } catch {
    return defaultWorkRoot(wingRoot);
  }
}

export function setWorkRoot(wingRoot, sessionId, newWorkRootAbsolutePath) {
  mkdirSync(stateDir(wingRoot), { recursive: true });
  writeFileSync(
    statePath(wingRoot, sessionId),
    JSON.stringify({ workRoot: newWorkRootAbsolutePath }, null, 2)
  );
}
