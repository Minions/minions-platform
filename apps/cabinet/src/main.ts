import dotenv from 'dotenv';
import path from 'path';
import { execFileSync } from 'child_process';
import { createServer } from './server.js';
import { findAvailablePort } from './utils/port.js';
import { readCabinetPort, writeCabinetPort } from './utils/portConfig.js';
import { writeAdminMcpConfig, ensureAdminClaudeSettings } from './utils/adminConfig.js';
import { createDiskSandbox } from '@minions/file-store';
import { runSelfHeals, selfHeals } from './selfHeal/index.js';

// Build-time constants injected by esbuild (set in built product, undefined in dev)
declare const __BUILT_PRODUCT__: boolean | undefined;
declare const __CABINET_VERSION__: string | undefined;
const isBuiltProduct = typeof __BUILT_PRODUCT__ !== 'undefined' && __BUILT_PRODUCT__;

// Each warmed wing's quality watcher runs one persistent in-process
// `startVitest({ watch: true })` per project directory in that work repo
// (VitestSignalRunner — deliberately one instance per project rather than
// one aggregating instance, to sidestep a real cross-project Vitest bug;
// see that file for why). Vitest's own Node API registers a process-level
// 'exit' listener per instance internally, which is entirely expected here,
// not a leak — this repo alone has ~26 project dirs, so even one warmed
// wing exceeds Node's default max of 10. Set generously high rather than to
// today's exact count, since it grows with the workspace and with how many
// wings are warmed at once.
process.setMaxListeners(200);
// Defense in depth for the same class of issue on process.stdin specifically
// (a separate EventEmitter from `process` itself): VitestSignalRunner
// passes each per-project Vitest instance a fake, non-TTY stdin so it never
// touches the real one, so this isn't load-bearing today. Left as a
// backstop rather than removed, on the same logic as the
// unhandledRejection/uncaughtException handlers below: a config passed at
// one call site can't guarantee nothing else ever touches this shared
// object.
process.stdin.setMaxListeners(200);

// Last-resort safety net: a background quality-watcher failure (a Vitest
// project instance rejecting on cold start, e.g.) must never take down the
// whole cabinet server — every wing's MCP session depends on this one
// process staying up. This is deliberately broad (Node's default behavior
// for both of these, since Node 15, is to crash the process) rather than
// scoped to quality-watcher specifically: some Vitest-internal setup work
// runs as background promises that aren't part of the promise chain
// `startVitest()` returns, so even a correct try/catch around every call
// site can't guarantee catching it — this is the only place that can. Signal
// runner call sites still get their own try/catch (see WingQualityWatcher /
// QualityWatcher / VitestSignalRunner) so a failure is attributed to the
// right watcher and reported as a 'fail' state instead of silently
// vanishing into this log line — this handler is the floor, not the primary
// mechanism.
process.on('unhandledRejection', (reason) => {
  console.error('[MCPApi] Unhandled rejection (process staying up):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[MCPApi] Uncaught exception (process staying up):', error);
});

// Load lair-level .env before reading any process.env values.
// Derive the lair root from the CWD pattern (same logic as below, but without
// relying on process.env.LAIR_ROOT, which may itself be set in the .env file).
{
  const cwd = process.cwd();
  const wingsIdx = cwd.indexOf(path.sep + 'wings' + path.sep);
  const lairRootForEnv = wingsIdx !== -1 ? cwd.substring(0, wingsIdx) : cwd;
  dotenv.config({ path: path.join(lairRootForEnv, '.env') });
}

// Determine lair root (and, in dev mode, which wing this instance runs from —
// reported in the MCP initialize handshake so a client can tell which wing
// it's actually talking to).
let LAIR_ROOT: string;
let WING_NAME: string | undefined;

if (process.env.LAIR_ROOT) {
  // Explicit override via environment variable
  LAIR_ROOT = process.env.LAIR_ROOT;
} else if (isBuiltProduct) {
  // Built product runs from lair root
  LAIR_ROOT = process.cwd();
} else {
  // Dev mode: running from within a wing's work/local directory
  // Path pattern: $lair_root/wings/$wingname/work/local/$repo-path
  const cwd = process.cwd();
  const wingsIndex = cwd.indexOf(path.sep + 'wings' + path.sep);

  if (wingsIndex !== -1) {
    LAIR_ROOT = cwd.substring(0, wingsIndex);
    const afterWings = cwd.slice(wingsIndex + 1 + 'wings'.length + 1);
    WING_NAME = afterWings.split(path.sep)[0];
  } else {
    // Fallback to cwd if wings pattern not found
    LAIR_ROOT = cwd;
  }
}

// Version reported in the MCP initialize handshake: the real release version
// (build-time constant) in a built product, or the wing's current commit sha
// in dev — so a client can tell exactly which code it's talking to.
let CABINET_VERSION: string;
if (isBuiltProduct) {
  CABINET_VERSION = typeof __CABINET_VERSION__ !== 'undefined' ? __CABINET_VERSION__ : 'unknown';
} else {
  try {
    CABINET_VERSION = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    }).trim();
  } catch {
    CABINET_VERSION = 'unknown';
  }
}

// Determine port to use
let port: number;

if (process.env.CABINET_PORT) {
  // Explicit port specified - use it directly
  port = parseInt(process.env.CABINET_PORT, 10);
} else if (isBuiltProduct) {
  // Built product: use saved port from config, or find and save a new one
  const lairDir = createDiskSandbox(LAIR_ROOT).root;
  const savedPort = await readCabinetPort(lairDir);
  if (savedPort !== null) {
    port = savedPort;
  } else {
    port = await findAvailablePort(3434);
    await writeCabinetPort(lairDir, port);
  }
} else {
  // Dev mode: use fixed port 3000
  port = 3000;
}

// Built product: (re)write admin/.mcp.json and admin/.claude/settings.json on
// every startup so the admin area is always correctly configured, even if a
// human opens Claude Code there directly instead of via launch-lair-claude.mjs.
// Self-healing and idempotent — safe to run unconditionally on every launch.
if (isBuiltProduct) {
  const lairDir = createDiskSandbox(LAIR_ROOT).root;
  await writeAdminMcpConfig(lairDir, port);
  await ensureAdminClaudeSettings(lairDir);
}

// Reconcile any lair state that's fallen behind the current data format
// (e.g. plan data still in the old index.json layout). Runs in dev mode too
// — a wing's own checkout needs this exactly as much as a built product's
// lair does. See apps/cabinet/src/selfHeal for the mechanism and why it
// checks actual state instead of tracking "have I run this" separately.
//
// Guarded on a globalThis flag, not just this module's own top-level
// `await`, because dev mode's ViteNodeRunner (scripts/dev-server.mjs) can
// re-execute this file within the same long-lived process (e.g. re-running
// main.ts's module body via the runner rather than a real process restart)
// — each such re-execution is not a genuine new "cabinet start," and
// running self-heals again mid-session against the live lair is exactly
// what left worktrees dirty with uncommitted migrations. A real process
// restart (a real new "start") gets a fresh globalThis and runs this once,
// as intended.
const SELF_HEAL_RAN_FLAG = '__cabinetSelfHealsRan';
if (!(globalThis as Record<string, unknown>)[SELF_HEAL_RAN_FLAG]) {
  (globalThis as Record<string, unknown>)[SELF_HEAL_RAN_FLAG] = true;
  await runSelfHeals(createDiskSandbox(LAIR_ROOT), selfHeals);
}

// In dev mode, a ViteNodeRunner module loader may be provided by dev-server.mjs
// via globalThis so that TypeScript mission source files are resolved through Vite.
const devModuleLoader = (globalThis as { __devModuleLoader?: (url: string) => Promise<Record<string, unknown>> }).__devModuleLoader;
const app = await createServer({
  lairRoot: LAIR_ROOT,
  cabinetPort: port,
  isDevMode: !isBuiltProduct,
  version: CABINET_VERSION,
  wingName: WING_NAME,
  moduleLoader: devModuleLoader,
});

app.listen(port, () => {
  console.log(`Cabinet server running on http://localhost:${port}`);
  console.log(`Version: ${CABINET_VERSION}`);
  console.log(`Lair root: ${LAIR_ROOT}`);
  console.log(`Press 'q' to quit`);
});

// Every warm wing's quality watcher owns live subprocesses (vue-tsc, Vitest,
// oxlint, ...) that outlive this process unless told to stop first — see
// MCPServer.shutdown(). Guarded like the handlers above: dev mode's
// ViteNodeRunner can re-execute this module body without a real process
// restart, and registering this twice would run shutdown twice (harmless,
// but also register duplicate signal listeners forever).
const SHUTDOWN_HANDLERS_REGISTERED_FLAG = '__cabinetShutdownHandlersRegistered';
if (!(globalThis as Record<string, unknown>)[SHUTDOWN_HANDLERS_REGISTERED_FLAG]) {
  (globalThis as Record<string, unknown>)[SHUTDOWN_HANDLERS_REGISTERED_FLAG] = true;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, stopping quality watchers before exit...`);
    // Hard cap on the ENTIRE shutdown, independent of mcpServer.shutdown()'s
    // own internal timeouts. Those internal timeouts bound how long each
    // watcher is graciously waited on, but they only bound the *promise
    // resolving* — they can't rescue us if shutdown() itself never settles
    // (an unforeseen hang, an unhandled rejection stalling the await chain,
    // etc.). This timer is the actual guarantee that 'q'/Ctrl+C exits within
    // FORCE_EXIT_MS no matter what happens above.
    const FORCE_EXIT_MS = 5_000;
    const forceExitTimer = setTimeout(() => {
      console.error(`[MCPApi] Shutdown did not complete within ${FORCE_EXIT_MS}ms; forcing exit.`);
      process.exit(0);
    }, FORCE_EXIT_MS);
    try {
      await app.locals.mcpServer.shutdown();
    } catch (err) {
      console.error('[MCPApi] Error during shutdown:', err);
    } finally {
      clearTimeout(forceExitTimer);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  (globalThis as Record<string, unknown>)['__cabinetShutdown'] = shutdown;
}

// Handle 'q' to quit. Guarded the same way as the self-heal run above: dev
// mode's ViteNodeRunner (scripts/dev-server.mjs) can re-execute this file's
// module body within the same long-lived process without a real process
// restart — without this guard, each such re-execution would add another
// 'data' listener to process.stdin, which is exactly the kind of unbounded
// per-"start" listener growth that trips Node's MaxListenersExceededWarning
// over a long-lived process's lifetime.
//
// Deliberately NOT gated on `process.stdin.isTTY`: in the standard dev
// workflow (`pnpm dev`), this process is a grandchild spawned by nodemon
// with stdin connected via a plain pipe, not an inherited TTY — nodemon
// forwards the real terminal's keystrokes into that pipe regardless, so
// `isTTY` is false here even though a human is typing at a real terminal.
// Gating registration on `isTTY` would silently make 'q' a no-op in
// the very setup the docs call the normal dev command. Only `setRawMode`
// itself is TTY-gated, since pipe streams don't support it. One consequence
// of not being able to force raw mode on a piped stdin: nodemon's own stdin
// (configured `restartable`, see nodemon.json) stays in cooked/line-buffered
// mode, so a piped-through keystroke arrives as "q\n"/"q\r\n" once Enter is
// pressed rather than a bare 'q' — hence the trim() below instead of a
// strict equality check.
const STDIN_HANDLER_REGISTERED_FLAG = '__cabinetStdinHandlerRegistered';
if (!(globalThis as Record<string, unknown>)[STDIN_HANDLER_REGISTERED_FLAG]) {
  (globalThis as Record<string, unknown>)[STDIN_HANDLER_REGISTERED_FLAG] = true;
  if (process.stdin.isTTY) {
    // Guarded: setRawMode can throw on some platforms/consoles (e.g. certain
    // Windows terminal configurations) even when isTTY is true. Previously
    // an unguarded throw here aborted this whole synchronous block, so
    // resume()/on('data') below never ran and 'q' silently did nothing for
    // the rest of the process's life (only SIGINT, delivered independently
    // by the OS, still worked). Falling back to cooked mode means 'q' then
    // needs Enter, same as the piped-stdin dev case above, but the
    // quit-key handler is at least always registered.
    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      console.error('[MCPApi] Failed to enable raw stdin mode; \'q\' will require Enter to register:', err);
    }
  }
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    // 'q' key or Ctrl+C
    if (key.toString().trim() === 'q' || key[0] === 3) {
      console.log('\nShutting down cabinet...');
      const shutdown = (globalThis as Record<string, unknown>)['__cabinetShutdown'] as
        | ((signal: string) => Promise<void>)
        | undefined;
      if (shutdown) {
        void shutdown('quit-key');
      } else {
        process.exit(0);
      }
    }
  });
}