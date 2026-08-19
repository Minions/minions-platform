/**
 * Branded (nominal) string identity types for repo/wing identity.
 *
 * Several different "which repo/wing is this" strings coexist in this
 * codebase and are easy to pass to the wrong place with no compiler
 * complaint, even though several of them are literally the string
 * `"local"` in practice:
 *
 * - {@link WingName} — identifies a wing (e.g. `ctx.wingName`, the
 *   `/mcp/henchery/:wingName` path segment).
 * - {@link RepoAlias} — a wing-local repo alias (`"local"`, or a name in
 *   a wing's named work dirs). Only meaningful paired with a WingName —
 *   the same alias string in two different wings need not name the same
 *   physical repo.
 * - {@link LairRepoName} — a lair-wide registered repo name, from
 *   `lair.workRepos()`. Flat, no wing in scope.
 * - {@link RepoId} — the canonical physical repo identity
 *   (`repoIdToDirName(canonicalizeRepoUrl(url))`). The only thing that
 *   determines whether two names refer to the same physical plan data.
 *
 * Each is `string & { readonly __brand: '...' }`. The brand is
 * compile-time only — the wire/storage representation is still a plain
 * string — so the sole purpose is to make it a type error to pass one
 * kind where another is expected. `asWingName`/`asRepoId` do no runtime
 * validation beyond the brand: the string is already trusted at the point
 * it's minted (e.g. straight from `lair.workRepos()`). `asRepoAlias` and
 * `asLairRepoName` are deliberate exceptions — see below — because
 * "defaulting/requiredness" is itself part of what distinguishes those two
 * kinds: a `RepoAlias` always has a valid default ("local" — a wing always
 * has exactly one unambiguous "own" primary repo), a `LairRepoName` never
 * does (a lair may register any number of work repos, with no natural
 * "the" one among them). Centralizing that here means no call site needs
 * its own `?? 'local'` or its own "repo is required" check ever again.
 */

export type WingName = string & { readonly __brand: "WingName" };
export type RepoAlias = string & { readonly __brand: "RepoAlias" };
export type LairRepoName = string & { readonly __brand: "LairRepoName" };
export type RepoId = string & { readonly __brand: "RepoId" };

export function asWingName(raw: string): WingName {
  return raw as WingName;
}

/**
 * Mints a `RepoAlias`, defaulting to `"local"` when `raw` is missing or
 * blank. Never returns anything falsy-empty — callers never need their own
 * `?? 'local'` fallback.
 */
export function asRepoAlias(raw: string | undefined): RepoAlias {
  const trimmed = raw?.trim();
  return (trimmed ? trimmed : "local") as RepoAlias;
}

/**
 * Mints a `LairRepoName`. Throws when `raw` is missing or blank — unlike
 * `RepoAlias`, there is no single lair-wide "the" repo to default to, so a
 * missing value is always a caller error, not something to silently guess
 * at (see `LairRepoPerspective` in `@minions/repo-perspective`).
 */
export function asLairRepoName(raw: string | undefined): LairRepoName {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error('repo is required — no default "the" lair-registered repo exists');
  }
  return trimmed as LairRepoName;
}

export function asRepoId(raw: string): RepoId {
  return raw as RepoId;
}
