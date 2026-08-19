import path from "node:path";
import type { Wing } from "./Wing.js";
import type { WorkArea } from "./work-area-types.js";
import type { RepoAlias, RepoId } from "./brandedIds.js";
import { asRepoId } from "./brandedIds.js";

/**
 * True when two filesystem paths refer to the same directory, tolerant of
 * separator differences (git reports forward slashes; `path.join` uses the
 * OS separator) and, on win32 only, of case (the filesystem there is
 * case-insensitive, but two paths to the same directory can differ in case —
 * e.g. a drive letter reported as "D:" by git vs. "d:" from a
 * lowercase-cwd-relative resolve — which a plain string comparison would
 * wrongly treat as different paths).
 */
export function samePath(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  return process.platform === "win32"
    ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
    : resolvedA === resolvedB;
}

/**
 * Result of resolving a wing-local work-repo alias to a canonical repo identity.
 */
export type RepoIdentityResult =
  | { resolved: true; id: RepoId }
  | { resolved: false; reason: "not-found" | "no-remote-url" | "unsupported" };

/**
 * Normalizes a git remote URL (https, ssh://, or scp-like git@host:path form)
 * to a canonical identity string, so the same physical repo cloned under
 * different URL forms (or by different local aliases) resolves identically.
 */
export function canonicalizeRepoUrl(url: string): string {
  const scpMatch = url.trim().match(/^([\w.-]+)@([\w.-]+):(.+)$/);
  const normalized = scpMatch && !url.includes("://") ? `ssh://${scpMatch[2]}/${scpMatch[3]}` : url.trim();

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return normalized
      .toLowerCase()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  }
}

/**
 * Sanitizes a canonical repo id (`${host}${path}`, from `canonicalizeRepoUrl`)
 * into a single filesystem-safe path segment, for use as a directory name
 * (e.g. `cabinet/planning/<repo-id>/`). The id contains `/` from the repo's
 * path, which is not safe as a bare directory segment.
 */
export function repoIdToDirName(id: string): string {
  return id.replace(/\//g, "--");
}

function identityFromWorkArea(workArea: WorkArea): RepoIdentityResult {
  const url = workArea.repo.url;
  if (!url) return { resolved: false, reason: "no-remote-url" };
  return { resolved: true, id: asRepoId(canonicalizeRepoUrl(url)) };
}

/**
 * Resolves a wing-local work-repo alias ("local" or a named extra work
 * directory) to a canonical physical-repo identity, derived from the backing
 * `BareRepository`'s clone URL. Two wings/lairs aliasing the same physical
 * repo under different local names resolve to the same id.
 *
 * Built on the `WorkArea`-returning surface (design doc §4.2) rather than the
 * `Worktree`-returning `workLocal()`/`workNamed()`. For the named-alias case,
 * `workAreaNamed()` alone can't distinguish "doesn't exist" from "exists but
 * is a plain junction with no `BareRepository` of its own" — both collapse to
 * `undefined` (`Wing.ts`'s own doc comment on `workAreaNamed()`) — so
 * `namedWorkPath()` (which reports a real path for every existing kind,
 * including a plain junction) decides existence first, mirroring
 * `lairStateService.ts`'s `getNamedWorkGitInfo()`.
 *
 * The plain "junction" kind (a same-repo subdir mapping into an
 * already-checked-out worktree elsewhere in the wing) does not expose its
 * backing worktree and is not yet resolvable — callers get `unsupported`.
 */
export async function resolveRepoIdentity(wing: Wing, alias: RepoAlias): Promise<RepoIdentityResult> {
  if (alias === "local") {
    const workArea = await wing.workAreaLocalIfExists();
    if (!workArea) return { resolved: false, reason: "not-found" };
    return identityFromWorkArea(workArea);
  }

  const path = await wing.namedWorkPath(alias);
  if (path === undefined) return { resolved: false, reason: "not-found" };

  const workArea = await wing.workAreaNamed(alias);
  if (!workArea) return { resolved: false, reason: "unsupported" };

  return identityFromWorkArea(workArea);
}
