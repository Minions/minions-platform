/**
 * Converts a Windows path (either `D:\foo\bar` or `D:/foo/bar`) to the
 * git-bash form (`/d/foo/bar`) that this environment's Bash tool actually
 * runs under (observed as `/usr/bin/bash` in tool_result error text).
 * Paths already in a non-drive form are returned unchanged.
 */
export function toGitBashPath(windowsPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return windowsPath;
  const [, drive, rest] = match;
  return `/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

/**
 * Builds the preamble prefixed onto every Bash command: exports
 * $WING_ROOT/$WORK_ROOT and sets the shell's starting directory to the
 * current work root. Failure to cd (e.g. work root doesn't exist yet) does
 * not abort the command — it's surfaced by the D-layer failure-correction
 * hook instead of silently swallowed.
 */
export function buildBashPreamble({ wingRoot, workRoot }) {
  const wingRootPosix = toGitBashPath(wingRoot);
  const workRootPosix = toGitBashPath(workRoot);
  return `export WING_ROOT="${wingRootPosix}" WORK_ROOT="${workRootPosix}"; cd "${workRootPosix}" && `;
}
