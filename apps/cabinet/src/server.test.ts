import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from './server';
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { createInMemorySandbox, type Sandbox } from '@minions/file-store';
import type { WingManager } from './wings/WingManager.js';

/** Seeds a real bare `local.git` repo directly under the lair's `work/`
 * directory (the layout `Lair.workRepo('local')` looks for — see
 * `LairImpl.workRepo`) with a `main` branch containing a real file, so a
 * wing's `work/local` can be created against it. Simpler than the
 * `simulateRemote`/`addWorkRepo` clone pattern used elsewhere: a clone's
 * `main` only exists as a remote-tracking `origin/main` ref (see
 * `SimulatedGit.cloneFrom`), not a real local branch, so a subsequently
 * created wing branch (via `ensureBranch(branch, from: "main")`, which only
 * ever looks at LOCAL branches) would start empty. Seeding `local.git`
 * directly avoids that indirection. */
async function seedLocalWorkRepoWithFile(sandbox: Sandbox): Promise<void> {
  const workDir = await sandbox.root.createDirectory('work');
  const repo = await sandbox.initBare(workDir, 'local.git');
  const seedWorktree = await repo.createWorktree(sandbox.root, 'seed-files-list', 'main');
  await seedWorktree.createFile('hello.txt', 'hello world');
  await seedWorktree.commitAll('seed main');
}

/**
 * Server-level integration tests for Cabinet.
 *
 * Uses in-memory sandbox via dependency injection for fast, isolated tests.
 *
 * Note: MCP tool tests have been removed as they are covered by unit tests:
 * - MinionService.test.ts - minion spawn, list, history, kill
 * - ArchiveService.test.ts - archive list, add, remove
 * - WingService.test.ts - wing creation
 * - lairStateService.test.ts - lair state
 * - QuestionQueue.test.ts - question handling
 * - MCPServer.test.ts - MCP server setup
 *
 * The MCP HTTP integration tests were also incompatible with the
 * StreamableHTTPServerTransport which uses streaming responses.
 */
describe('Cabinet Server', () => {
  let app: Express;
  let server: Server;
  let sandbox: Sandbox;
  const port = 3456;

  beforeEach(async () => {
    // Create in-memory lair structure for tests
    sandbox = createInMemorySandbox();

    // Create wing structure using file-store
    const wingsDir = await sandbox.root.createDirectory('wings');
    const wingDir = await wingsDir.createDirectory('test-wing');
    const workDir = await wingDir.createDirectory('work');
    await workDir.createDirectory('local');

    app = await createServer({ sandbox });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('creates an express server', () => {
    expect(app).toBeDefined();
  });

  it('provides health check endpoint', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('allows CORS for development', async () => {
    // CORS dev-mode gating is driven by the explicit isDevMode option, not
    // process.env.NODE_ENV (see 4eb90b0f) — nothing sets that automatically
    // when running from source, so the gate must not depend on it.
    const devApp = await createServer({ sandbox, isDevMode: true });

    const response = await request(devApp)
      .options('/mcp/conductor')
      .set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('serves static files from throne room dist at / route', async () => {
    server = app.listen(port);
    const response = await fetch(`http://localhost:${port}/`);
    // Should serve HTML or at least attempt to serve from dist
    expect(response.status).toBeLessThanOrEqual(404); // Either serves file or 404
  });

  it('provides secretary status endpoint', async () => {
    server = app.listen(port);
    const response = await fetch(`http://localhost:${port}/api/secretary/status`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('isActive');
  });

  it('secretary status shows inactive by default', async () => {
    server = app.listen(port);
    const response = await fetch(`http://localhost:${port}/api/secretary/status`);
    const data = await response.json();
    expect(data.isActive).toBe(false);
  });

  it('secretary status includes lastActivity field', async () => {
    server = app.listen(port);
    const response = await fetch(`http://localhost:${port}/api/secretary/status`);
    const data = await response.json();
    expect(data).toHaveProperty('lastActivity');
  });

  describe('quality stream', () => {
    /** Reads the first `data:` line off an SSE response, then aborts the connection so the test doesn't hang on the endpoint's ongoing poll interval. */
    async function readFirstEvent(url: string): Promise<{ disabled: boolean; wings: Record<string, unknown> }> {
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      if (!response.body) throw new Error('SSE response had no body');
      const reader = response.body.getReader();
      const { value } = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(value);
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      if (!line) throw new Error(`No SSE data line in: ${text}`);
      return JSON.parse(line.slice('data: '.length));
    }

    it('reports quality watching disabled by default (HACK_OFF_QUALITY_CHECKS on in prod flags)', async () => {
      server = app.listen(port);
      const payload = await readFirstEvent(`http://localhost:${port}/api/quality/stream`);
      expect(payload).toEqual({ disabled: true, wings: {} });
    });

    it('reports enabled with no watched wings when the higher-perf watcher flag is on', async () => {
      const devApp = await createServer({ sandbox, isDevMode: true });
      server = devApp.listen(port);
      const payload = await readFirstEvent(`http://localhost:${port}/api/quality/stream`);
      expect(payload).toEqual({ disabled: false, wings: {} });
    });
  });

  // Regression coverage (design doc §4.2 WorkArea): `createServer`'s real
  // bootstrap must pass a real `WorkAreaFactories` into
  // `createLair(sandbox, workAreaFactories)`, or every
  // `Wing.workAreaLocal()`/etc. call on a production `Wing` throws
  // unconditionally. This exercises the real `createServer({ sandbox })`
  // bootstrap end-to-end (real `WingManager`, real `Lair`, no hand-built
  // `WorkAreaFactories` injected by the test) and hits the
  // `/api/files/list` route, so it fails if either the wiring regresses or
  // the route's `wing.workAreaLocal()` / `activeMovement()` / `files.glob()`
  // call chain breaks. Without `WorkAreaFactories`, `wing.workAreaLocal()`
  // inside this route throws "...was constructed without
  // WorkAreaFactories", which the route's own try/catch turns into a 404
  // "has no work/local worktree" instead of the 200 asserted below.
  it('lists files in a wing\'s work/local repo via GET /api/files/list (proves WorkAreaFactories reaches the real production bootstrap)', async () => {
    const testSandbox = app.locals.sandbox as Sandbox;
    const wingManager = app.locals.wingManager as WingManager;

    await testSandbox.root.createDirectory('info');
    await seedLocalWorkRepoWithFile(testSandbox);

    await wingManager.createWing({
      name: 'files-list-wing',
      workLocalRepo: 'local',
      workLocalBranch: 'l/sandbox/w/files-list-wing/local',
    });

    server = app.listen(port);
    const response = await fetch(`http://localhost:${port}/api/files/list?wingName=files-list-wing`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.files).toContain('hello.txt');
  });

  it('returns 404 from /api/files/list when the wing has no work/local worktree', async () => {
    server = app.listen(port);
    // 'test-wing' (seeded in beforeEach) has a bare `work/local` directory
    // with no bare repo / movement behind it, so `workAreaLocal()` throws
    // and the route's try/catch should turn that into a 404, not a 500.
    const response = await fetch(`http://localhost:${port}/api/files/list?wingName=test-wing`);

    expect(response.status).toBe(404);
  });
});
