import path from "node:path";
import fs from "node:fs";

/**
 * Leading path segments that resolve relative to WING ROOT rather than the
 * current WORK ROOT. Must be leading-segment matches, not substring matches
 * (e.g. "work-utils/foo" is not "work/foo"). This is the stable set of
 * wing-root DIRECTORY entries (confirmed against both tooling-01 and
 * tooling-00's actual wing roots) — deliberately excludes incidental/
 * session-created files (e.g. a scratch script or a leftover screenshot),
 * which the existence-check fallback below already handles correctly on
 * its own. Also deliberately excludes CLAUDE.md: work/local has its own
 * CLAUDE.md too, and a bare relative "CLAUDE.md" is meant to resolve to
 * the CURRENT WORK ROOT's copy, not the wing root's — the wing-root copy
 * is still reachable via the existence-check fallback for an absolute path.
 */
export const WING_ROOT_SIBLINGS = [
  "work",
  "private",
  "info",
  "closet",
  ".claude",
  ".mcp.json",
  ".playwright",
];

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const GIT_BASH_DRIVE_ABSOLUTE = /^\/[A-Za-z]\//;
const POSIX_ABSOLUTE = /^\//;

/**
 * Recognizes all path forms seen in this environment's Bash tool output:
 * `D:\...`, `D:/...`, and git-bash's `/d/...`.
 */
export function isAbsolutePath(rawPath) {
  if (!rawPath) return false;
  return (
    DRIVE_ABSOLUTE.test(rawPath) ||
    GIT_BASH_DRIVE_ABSOLUTE.test(rawPath) ||
    POSIX_ABSOLUTE.test(rawPath)
  );
}

function leadingSegment(rawPath) {
  const normalized = rawPath.replace(/\\/g, "/");
  const slashIndex = normalized.indexOf("/");
  return slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
}

function toComparablePosix(p) {
  // Normalize D:\..., D:/..., and /d/... to a single comparable POSIX-ish
  // lowercase form so prefix checks work across all 3 absolute forms.
  let s = p.replace(/\\/g, "/");
  const gitBash = /^\/([A-Za-z])\//.exec(s);
  if (gitBash) s = `${gitBash[1]}:/${s.slice(3)}`;
  return s.toLowerCase();
}

function isUnder(childAbs, parentAbs) {
  const child = toComparablePosix(childAbs);
  const parent = toComparablePosix(parentAbs).replace(/\/$/, "");
  return child === parent || child.startsWith(parent + "/");
}

/**
 * Applies the 3-branch path-resolution rule to a Read/Write/Edit/Glob/Grep
 * path or pattern parameter:
 *   - relative, leading segment is a wing-root sibling (work/, private/,
 *     info/, closet/, .claude/, .mcp.json, .playwright/) -> resolved against
 *     wingRoot. Deliberately excludes "CLAUDE.md" — a bare relative
 *     "CLAUDE.md" resolves against the current WORK ROOT's own copy, not
 *     the wing root's (reachable separately via the existence-check
 *     fallback for an absolute path).
 *   - relative, otherwise -> resolved against the current workRoot
 *   - absolute, already under workRoot, or under wingRoot matching a
 *     wing-root-sibling prefix (checked unconditionally, before any
 *     existence check, so creating a brand-new file under a real sibling
 *     never gets misdiagnosed as the harness bug below), or outside
 *     wingRoot entirely -> unchanged
 *   - absolute, under wingRoot, but NOT matching a wing-root-sibling prefix
 *     -> re-rooted under workRoot instead. This handles the harness's own
 *     pre-resolution behavior: Read/Write/Edit's file_path and Grep/Glob's
 *     path arrive at this hook ALREADY made absolute against wing root (its
 *     default base), even when the model passed a bare relative path meant
 *     to be workRoot-relative (e.g. "sharing-keystones/x" arrives as
 *     "<wingRoot>/sharing-keystones/x", not "<workRoot>/sharing-keystones/x").
 *     Verified live, 2026-07-13: the raw tool_input the hook receives for
 *     Read.file_path is already absolute-against-wingRoot even though the
 *     model's Read call used a relative path.
 *
 * Returns an absolute, OS-native path. Ambiguous/empty input is returned
 * unchanged rather than guessed at (see design note on silent-wrong being
 * worse than loud-wrong).
 */
export function resolvePathForTool(rawPath, { wingRoot, workRoot }) {
  if (!rawPath || typeof rawPath !== "string") return rawPath;

  if (isAbsolutePath(rawPath)) {
    if (isUnder(rawPath, workRoot)) return rawPath;
    if (!isUnder(rawPath, wingRoot)) return rawPath;

    // Slice from the ORIGINAL rawPath (not the lowercased comparable form)
    // to preserve casing — toComparablePosix is for comparison only.
    const wingRootLen = toComparablePosix(wingRoot).replace(/\/$/, "").length;
    const rawNormalized = rawPath.replace(/\\/g, "/");
    const rawPosix = /^\/[A-Za-z]\//.test(rawNormalized)
      ? `${rawNormalized[1]}:${rawNormalized.slice(2)}`
      : rawNormalized;
    const wingRel = rawPosix.slice(wingRootLen).replace(/^\//, "");

    // A path whose wing-root-relative leading segment is a recognized
    // sibling (work/, private/, etc.) is always intentional, regardless of
    // whether it exists yet — mirrors the relative-path branch below, and
    // fixes a false positive on Write of a brand-new file under a real
    // sibling (e.g. a different work root's package): an existence-only
    // check can't distinguish "doesn't exist because the harness
    // mis-resolved it" from "doesn't exist because I'm creating it."
    const wingRelSegment = leadingSegment(wingRel);
    const isWingRootSiblingAbs = WING_ROOT_SIBLINGS.some(
      (sibling) =>
        wingRelSegment === sibling || wingRelSegment === sibling.replace(/\/$/, "")
    );
    if (isWingRootSiblingAbs) return rawPath;

    // A file that genuinely exists at this wing-root-relative location (e.g.
    // the wing's own top-level CLAUDE.md) is presumed intentional, even if
    // its leading segment isn't in WING_ROOT_SIBLINGS — that allowlist can't
    // enumerate every legitimate top-level wing-root file. Only re-root
    // when the wing-root location does NOT exist, which is the actual
    // failure signature of the harness's wrong-default-base bug.
    let existsAtWingRoot;
    try {
      existsAtWingRoot = fs.existsSync(rawPath);
    } catch {
      existsAtWingRoot = false;
    }
    if (existsAtWingRoot) return rawPath;

    return path.join(workRoot, wingRel);
  }

  const segment = leadingSegment(rawPath);
  const isWingRootSibling = WING_ROOT_SIBLINGS.some(
    (sibling) => segment === sibling || segment === sibling.replace(/\/$/, "")
  );

  const base = isWingRootSibling ? wingRoot : workRoot;
  return path.join(base, rawPath);
}
