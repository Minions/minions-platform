/**
 * Custom vite-node launcher that keeps the vite transform server alive.
 *
 * The standard `vite-node` CLI closes the vite server after executing the
 * entry file (when not using --watch). For a short-lived script, this is
 * fine. For a long-running HTTP server like the cabinet, it is fatal:
 * any subsequent dynamic import() calls — specifically loading TypeScript
 * mission files on demand — hit a closed server and fail with
 * ERR_CLOSED_SERVER.
 *
 * This script replicates the vite-node CLI setup exactly but skips the
 * server.close() call so the transform server stays up for the lifetime
 * of the process.
 */

import { createServer, loadEnv } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ViteNodeServer } from 'vite-node/server';
import { ViteNodeRunner } from 'vite-node/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');  // apps/cabinet/

// Create the vite server (same options as vite-node CLI in non-watch mode).
// No HMR and no file watcher — nodemon handles process restarts.
const server = await createServer({
  logLevel: 'error',
  root,
  server: {
    hmr: false,
    watch: null,
  },
});

// Initialize the plugin container (required for vite 6+).
await server.environments.client.pluginContainer.buildStart({});

// Populate process.env from the project's .env files (same as vite-node CLI).
const env = loadEnv(server.config.mode, server.config.envDir, '');
for (const key in env) {
  process.env[key] ??= env[key];
}

// Set up the vite-node transform server and module runner.
const node = new ViteNodeServer(server);

const runner = new ViteNodeRunner({
  root: server.config.root,
  base: server.config.base,
  fetchModule(id) {
    return node.fetchModule(id);
  },
  resolveId(id, importer) {
    return node.resolveId(id, importer);
  },
});

// Inject vite's env defines (e.g. import.meta.env.MODE).
await runner.executeId('/@vite/env');

// Expose a module loader on globalThis so that main.ts can pass it to createServer().
// This allows ClosetMissionLoader to load TypeScript mission source files (from the
// dev overlay in getWorkLocalCostumes) through Vite's transform pipeline rather than
// native Node ESM — which cannot resolve @minions/* workspace imports.
globalThis.__devModuleLoader = async (url) => {
  // Convert file:// URL to plain path for vite-node, which prefers absolute paths.
  const path = url.startsWith('file:///') ? fileURLToPath(url) : url;
  return runner.executeId(path);
};

// Execute the cabinet HTTP server entry point.
await runner.executeFile(resolve(root, 'src/main.ts'));

// IMPORTANT: Do NOT call server.close() here.
// The vite server must remain open for the lifetime of this process so that
// the __devModuleLoader above can transform TypeScript mission source files
// on demand via runner.executeId() → node.fetchModule() → vite transform.
