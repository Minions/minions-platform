import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAvailablePort } from './utils/port.js';

// Build-time constant injected by esbuild
declare const __BUILT_PRODUCT__: boolean | undefined;
const isBuiltProduct = typeof __BUILT_PRODUCT__ !== 'undefined' && __BUILT_PRODUCT__;

export interface LairProcess {
  lairRoot: string;
  port: number;
  pid: number;
}

/** In-memory map of running lair processes, keyed by lairRoot */
const runningLairs = new Map<string, LairProcess>();

/**
 * Resolve the Cabinet's main.js path.
 *
 * Priority:
 *   1. CABINET_MAIN_JS env var (explicit override)
 *   2. Built product: cabinet is co-bundled at dist/cabinet/main.js
 *   3. Dev fallback: apps/cabinet/dist/main.js relative to monorepo root
 */
function resolveCabinetMainJs(): string {
  if (process.env['CABINET_MAIN_JS']) {
    return process.env['CABINET_MAIN_JS'];
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (isBuiltProduct) {
    // In __tools/dist/: cabinet is co-bundled at __tools/dist/cabinet/main.js
    return path.resolve(__dirname, 'cabinet', 'main.js');
  }
  // Dev: cabinet is built separately in the monorepo workspace
  return path.resolve(__dirname, '..', '..', '..', 'apps', 'cabinet', 'dist', 'main.js');
}

export async function startLairCabinet(lairRoot: string): Promise<LairProcess> {
  const existing = runningLairs.get(lairRoot);
  if (existing) return existing;

  const port = await findAvailablePort(3434);
  const cabinetMainJs = resolveCabinetMainJs();

  const child = spawn('node', [cabinetMainJs], {
    env: {
      ...process.env,
      LAIR_ROOT: lairRoot,
      CABINET_PORT: String(port),
    },
    detached: false,
    stdio: 'inherit',
  });

  const lairProcess: LairProcess = {
    lairRoot,
    port,
    pid: child.pid ?? 0,
  };

  runningLairs.set(lairRoot, lairProcess);

  child.on('exit', () => {
    runningLairs.delete(lairRoot);
  });

  return lairProcess;
}

export function stopLairCabinet(lairRoot: string): boolean {
  const proc = runningLairs.get(lairRoot);
  if (!proc) return false;
  try {
    process.kill(proc.pid, 'SIGTERM');
  } catch {
    // Process may have already exited
  }
  runningLairs.delete(lairRoot);
  return true;
}

export function getRunningLairs(): LairProcess[] {
  return Array.from(runningLairs.values());
}

export function getLairProcess(lairRoot: string): LairProcess | undefined {
  return runningLairs.get(lairRoot);
}
