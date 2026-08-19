/**
 * DocsActionGroup — MCP action group for the git-backed markdown doc viewer/editor.
 *
 * Separate from the `review` tool (AI-driven document review loop) and from
 * demo tooling — this is the underlying, decoupled editing surface. A demo
 * link may currently just be a docs URL; that's incidental, not a dependency.
 *
 * Core actions:
 *   open  — create the session's branch (no worktree) and return its shareable URL
 *   list  — materialize the worktree if needed, list the doc set's files
 *   load  — materialize if needed, read one file's content
 *   save  — write one file's content and commit it (explicit save = one commit)
 *   close — tear down the session's worktree deterministically
 *
 * Secondary actions:
 *   status — check for new commits since a given sha, for a later AI to pick up edits
 */

import type { ActionGroupDef } from '@minions/mcp-types';
import { createLair, asGitRef, type Sandbox } from '@minions/file-store';
import { DocSessions, type DocSessionKey, type RepoKind } from './DocSessions.js';

interface ActionContext {
  lair: Sandbox;
  wingName?: string;
}

/** Worktrees materialized but idle this long (no list/load/save) get reaped on the next call. */
const SESSION_TTL_MS = 1000 * 60 * 60 * 48; // 48h

const DEFAULT_GLOB = '**/*.md';

function docsUrl(port: number, key: DocSessionKey, path?: string): string {
  const params = new URLSearchParams({ repoKind: key.repoKind, repo: key.repoName, branch: key.branch });
  if (path) params.set('path', path);
  return `http://localhost:${port}/docs?${params.toString()}`;
}

function filePaths(matches: Array<{ kind: string; name: string }>): string[] {
  return matches.filter(m => m.kind === 'file').map(m => m.name);
}

function requireRepoKind(value: unknown): RepoKind {
  if (value !== 'work' && value !== 'private') {
    throw new Error(`repoKind must be "work" or "private", got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function reapOpportunistically(sessions: DocSessions): Promise<void> {
  try {
    await sessions.reapStale(SESSION_TTL_MS);
  } catch {
    // Best-effort — never block a real request on the sweep.
  }
}

// ---- action: open ----

function makeOpenAction(port: number) {
  return {
    description: 'create a doc-viewer session\'s branch and return its shareable URL — cheap, creates no worktree',
    help: `**docs open** — Open (or reopen) a doc-viewer session.

Creates the session's branch at commitRef if it doesn't already exist — idempotent,
and never moves an already-existing branch. No worktree is created here; it is
materialized lazily on the human's first view (see docs list/load).

Required: repoKind ("work" | "private"), repo, branch, commitRef
Optional: paths (advisory doc-set scope), purpose (advisory, shown to the human)
Returns: { action: 'open', url, repoKind, repo, branch }`,
    params: {
      repoKind: { type: 'string' as const, enum: ['work', 'private'], description: 'Which kind of repo to open the session on' },
      repo: { type: 'string' as const, description: 'Repo name (for private repos: "local" or "global")' },
      branch: { type: 'string' as const, description: 'Session branch name — also the session\'s identity, together with repoKind + repo' },
      commitRef: { type: 'string' as const, description: 'Commit/branch to create the session branch at, if it does not already exist' },
      paths: { type: 'array' as const, items: { type: 'string' as const }, description: 'Advisory doc-set scope — files/globs the viewer defaults to listing' },
      purpose: { type: 'string' as const, description: 'Advisory human-readable purpose for this session' },
    },
    required: ['repoKind', 'repo', 'branch', 'commitRef'] as string[],
    async execute(ctx: ActionContext, params: Record<string, unknown>) {
      const key: DocSessionKey = {
        repoKind: requireRepoKind(params['repoKind']),
        repoName: params['repo'] as string,
        branch: params['branch'] as string,
      };
      const lair = createLair(ctx.lair);
      const sessions = new DocSessions(lair);

      await sessions.createSession(key, asGitRef(params['commitRef'] as string), {
        paths: params['paths'] as string[] | undefined,
        purpose: params['purpose'] as string | undefined,
      });

      return { action: 'open', url: docsUrl(port, key), ...key };
    },
  };
}

// ---- action: list ----

const listAction = {
  description: 'list the doc set\'s files, materializing the session worktree on first call',
  help: `**docs list** — List a doc-viewer session's files.

For repoKind "work"/"private": materializes the session's worktree if this is the
first access (may be slower than subsequent calls), then globs it.
For repoKind "info": reads directly from the read-only info clone — no session,
no branch; the branch param is ignored.

Required: repoKind ("work" | "private" | "info"), repo
Optional: branch (required for work/private), glob (defaults to the session's
  advisory paths from open, or "**/*.md")
Returns: { action: 'list', repoKind, repo, branch, readOnly, files: string[], isDirty? }`,
  params: {
    repoKind: { type: 'string' as const, enum: ['work', 'private', 'info'], description: 'Which kind of repo to list' },
    repo: { type: 'string' as const, description: 'Repo name' },
    branch: { type: 'string' as const, description: 'Session branch (required for work/private; ignored for info)' },
    glob: { type: 'string' as const, description: 'Glob pattern to filter files (defaults to the session\'s advisory scope, or **/*.md)' },
  },
  required: ['repoKind', 'repo'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const repoKind = params['repoKind'] as string;
    const repo = params['repo'] as string;
    const lair = createLair(ctx.lair);

    if (repoKind === 'info') {
      const result = await lair.infoRepo(repo);
      if (!result.exists) throw new Error(`Info repo not found: ${repo}`);
      const globPattern = (params['glob'] as string | undefined) ?? DEFAULT_GLOB;
      const matches = await result.clone.glob(globPattern);
      const files = filePaths(matches);
      return { action: 'list', repoKind: 'info', repo, branch: result.clone.branch, readOnly: true, files };
    }

    const key: DocSessionKey = { repoKind: requireRepoKind(repoKind), repoName: repo, branch: params['branch'] as string };
    const sessions = new DocSessions(lair);
    await reapOpportunistically(sessions);

    const movement = await sessions.materialize(key);
    const meta = await sessions.getMeta(key);
    const globPattern = (params['glob'] as string | undefined) ?? meta?.paths?.[0] ?? DEFAULT_GLOB;
    const matches = await movement.files.glob(globPattern);
    const files = filePaths(matches);
    const isDirty = await movement.isDirty();

    return { action: 'list', ...key, readOnly: false, files, isDirty };
  },
};

// ---- action: load ----

const loadAction = {
  description: 'read one file\'s content, materializing the session worktree on first call',
  help: `**docs load** — Read one file from a doc-viewer session (or an info repo).

Optional \`ref\` reads the file's content at that commit/branch instead of the
live worktree file — used to fetch a diff base. When the file didn't exist at
that ref, content is \`null\` (distinct from an empty file). Every non-info load
also echoes \`sessionCommitRef\`, the ref the session branch was opened from, so
a client can default a diff comparison to it without a separate lookup.

Required: repoKind ("work" | "private" | "info"), repo, path
Optional: branch (required for work/private; ignored for info), ref (commit/branch to read the file at, instead of the live worktree)
Returns: { action: 'load', repoKind, repo, branch, path, readOnly, content, ref?, sessionCommitRef? }`,
  params: {
    repoKind: { type: 'string' as const, enum: ['work', 'private', 'info'], description: 'Which kind of repo to read from' },
    repo: { type: 'string' as const, description: 'Repo name' },
    branch: { type: 'string' as const, description: 'Session branch (required for work/private; ignored for info)' },
    path: { type: 'string' as const, description: 'File path within the repo' },
    ref: { type: 'string' as const, description: 'Commit sha or branch to read the file\'s content at, instead of the live worktree file' },
  },
  required: ['repoKind', 'repo', 'path'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const repoKind = params['repoKind'] as string;
    const repo = params['repo'] as string;
    const path = params['path'] as string;
    const ref = params['ref'] !== undefined ? asGitRef(params['ref'] as string) : undefined;
    const lair = createLair(ctx.lair);

    if (repoKind === 'info') {
      const result = await lair.infoRepo(repo);
      if (!result.exists) throw new Error(`Info repo not found: ${repo}`);
      const fileResult = await result.clone.child(path);
      if (!fileResult.found || fileResult.node.kind !== 'file') throw new Error(`File not found: ${path}`);
      const content = await fileResult.node.read();
      return { action: 'load', repoKind: 'info', repo, branch: result.clone.branch, path, readOnly: true, content };
    }

    const key: DocSessionKey = { repoKind: requireRepoKind(repoKind), repoName: repo, branch: params['branch'] as string };
    const sessions = new DocSessions(lair);
    await reapOpportunistically(sessions);

    const movement = await sessions.materialize(key);
    const meta = await sessions.getMeta(key);
    const sessionCommitRef = meta?.commitRef;

    if (ref !== undefined) {
      // `Movement.readFileAtRef` (design doc §4.1) — read-only, base-
      // independent, and runs directly against the bare repo, no worktree
      // narrowing cast needed.
      const content = await movement.readFileAtRef(ref, path);
      return { action: 'load', ...key, path, readOnly: false, content, ref, sessionCommitRef };
    }

    const fileResult = await movement.files.child(path);
    if (!fileResult.found || fileResult.node.kind !== 'file') throw new Error(`File not found: ${path}`);
    const content = await fileResult.node.read();

    return { action: 'load', ...key, path, readOnly: false, content, sessionCommitRef };
  },
};

// ---- action: save ----

const saveAction = {
  description: 'write one file\'s content and commit it — the only way doc-viewer edits are persisted',
  help: `**docs save** — Write and commit one file in a doc-viewer session.

Explicit save only — there is no auto-save. Each save is exactly one commit,
authored as the human's edit. Materializes the session worktree if needed.

Required: repoKind ("work" | "private"), repo, branch, path, content
Optional: commitMessage (defaults to "docs: update <path>")
Returns: { action: 'save', repoKind, repo, branch, path, commitHash }`,
  params: {
    repoKind: { type: 'string' as const, enum: ['work', 'private'], description: 'Which kind of repo to save to' },
    repo: { type: 'string' as const, description: 'Repo name' },
    branch: { type: 'string' as const, description: 'Session branch' },
    path: { type: 'string' as const, description: 'File path within the repo' },
    content: { type: 'string' as const, description: 'New full content of the file' },
    commitMessage: { type: 'string' as const, description: 'Commit message (defaults to "docs: update <path>")' },
  },
  required: ['repoKind', 'repo', 'branch', 'path', 'content'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const key: DocSessionKey = {
      repoKind: requireRepoKind(params['repoKind']),
      repoName: params['repo'] as string,
      branch: params['branch'] as string,
    };
    const path = params['path'] as string;
    const content = params['content'] as string;
    const lair = createLair(ctx.lair);
    const sessions = new DocSessions(lair);
    await reapOpportunistically(sessions);

    const movement = await sessions.materialize(key);
    await movement.files.createFile(path, content);
    const commitMessage = (params['commitMessage'] as string | undefined) ?? `docs: update ${path}`;
    const { hash: commitHash } = await movement.commit({ message: commitMessage });

    return { action: 'save', ...key, path, commitHash };
  },
};

// ---- action: close ----

const closeAction = {
  description: 'tear down a doc-viewer session\'s worktree deterministically — leaves the branch and its commits intact',
  help: `**docs close** — Explicitly close a doc-viewer session.

Removes the session's worktree. The branch and everything committed to it are
left untouched — closing only frees the worktree's disk space and lets the
session be reopened fresh later (materialize recreates the worktree from the
same branch on next access).

Required: repoKind ("work" | "private"), repo, branch
Returns: { action: 'close', repoKind, repo, branch }`,
  params: {
    repoKind: { type: 'string' as const, enum: ['work', 'private'], description: 'Which kind of repo the session is on' },
    repo: { type: 'string' as const, description: 'Repo name' },
    branch: { type: 'string' as const, description: 'Session branch' },
  },
  required: ['repoKind', 'repo', 'branch'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const key: DocSessionKey = {
      repoKind: requireRepoKind(params['repoKind']),
      repoName: params['repo'] as string,
      branch: params['branch'] as string,
    };
    const lair = createLair(ctx.lair);
    const sessions = new DocSessions(lair);
    await sessions.close(key);
    return { action: 'close', ...key };
  },
};

// ---- secondary action: status ----

const statusAction = {
  description: 'check whether a session has new commits since a given sha — for a later AI to pick up human edits',
  help: `**docs status** — Check a doc-viewer session for new commits.

Materializes the session's worktree if needed (any existing worktree of the
repo can read any branch's log, since they share one object database — this
uses the session's own worktree for simplicity). An AI that opened a session
and walked away calls this later (possibly from a different wing/session) to
decide whether to pick up edits — merging them back into a wing branch reuses
the existing \`movement\` tool, not a new mechanism.

Required: repoKind ("work" | "private"), repo, branch, sinceSha
Returns: { action: 'status', repoKind, repo, branch, hasNewCommits, commits: CommitInfo[] }`,
  params: {
    repoKind: { type: 'string' as const, enum: ['work', 'private'], description: 'Which kind of repo the session is on' },
    repo: { type: 'string' as const, description: 'Repo name' },
    branch: { type: 'string' as const, description: 'Session branch' },
    sinceSha: { type: 'string' as const, description: 'Commit sha to check for new commits after' },
  },
  required: ['repoKind', 'repo', 'branch', 'sinceSha'] as string[],
  async execute(ctx: ActionContext, params: Record<string, unknown>) {
    const key: DocSessionKey = {
      repoKind: requireRepoKind(params['repoKind']),
      repoName: params['repo'] as string,
      branch: params['branch'] as string,
    };
    const lair = createLair(ctx.lair);
    const sessions = new DocSessions(lair);

    const movement = await sessions.materialize(key);
    // `commitsSince(ref)` computes `log(ref, this.branch)` — identical to the
    // old `worktree.log(sinceSha, 'HEAD')` call, since the session's worktree
    // is always checked out on `this.branch` (HEAD IS the session branch).
    const commits = await movement.commitsSince(asGitRef(params['sinceSha'] as string));

    return { action: 'status', ...key, hasNewCommits: commits.length > 0, commits };
  },
};

// ---- factory ----

/**
 * Create the `docs` ActionGroupDef.
 *
 * @param port - The cabinet's port number, used to build shareable doc-viewer URLs
 */
export function createDocsActionGroup(port: number): ActionGroupDef {
  return {
    name: 'docs',
    description:
      'Git-backed markdown doc viewer/editor: open a shareable session URL, list/load/save files, close when done.',
    workflow: 'open → (human opens URL) → list/load → save (repeat) → close',
    coreActions: {
      open: makeOpenAction(port),
      list: listAction,
      load: loadAction,
      save: saveAction,
      close: closeAction,
    },
    secondaryActions: {
      status: statusAction,
    },
  };
}
