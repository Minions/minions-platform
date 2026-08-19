import path from 'node:path';
import type { Directory, File } from '@minions/file-store';
import type { CabinetConfig } from '../registry/types.js';
import { findAvailablePort } from '../utils/port.js';
import {
  SharedBrowserService,
  type SharedBrowserStore,
  type SharedBrowserState,
} from './SharedBrowserService.js';
import { createChromeLauncher } from './chromeLauncher.js';
import { probeChrome } from './chromeProbe.js';

/** Port the shared Chrome search starts from (not stable — we take the first free one). */
export const DEFAULT_SHARED_BROWSER_BASE_PORT = 9333;

const CONFIG_FILE = 'cabinet.config.json';

/** Per-lair persistent profile dir so auth/localStorage are shared across the lair's wings. */
export function sharedBrowserProfileDir(lairRoot: string): string {
  return path.join(lairRoot, '.shared-browser', 'profile');
}

// Tolerant raw read/write of cabinet.config.json. We avoid the port-gated
// readCabinetConfig here so shared-browser state survives even before a port is saved.
async function readRawConfig(lairDir: Directory): Promise<CabinetConfig | null> {
  const result = await lairDir.child(CONFIG_FILE);
  if (!result.found || !result.node.is('file')) return null;
  try {
    return JSON.parse(await (result.node as File).read()) as CabinetConfig;
  } catch {
    return null;
  }
}

async function writeRawConfig(lairDir: Directory, config: CabinetConfig): Promise<void> {
  const content = JSON.stringify(config, null, 2);
  const result = await lairDir.child(CONFIG_FILE);
  if (result.found && result.node.is('file')) {
    await (result.node as File).write(content);
  } else {
    await lairDir.createFile(CONFIG_FILE, content);
  }
}

/**
 * A {@link SharedBrowserStore} backed by the cabinet's lair config
 * (`cabinet.config.json` → `sharedBrowser`). Preserves all other config fields.
 */
export function createCabinetConfigStore(lairDir: Directory, fallbackPort = 0): SharedBrowserStore {
  return {
    async get(): Promise<SharedBrowserState | null> {
      const config = await readRawConfig(lairDir);
      return config?.sharedBrowser ?? null;
    },
    async set(state: SharedBrowserState): Promise<void> {
      const existing = await readRawConfig(lairDir);
      const merged: CabinetConfig = {
        port: fallbackPort,
        ...existing,
        sharedBrowser: state,
      };
      await writeRawConfig(lairDir, merged);
    },
  };
}

/**
 * Wire a {@link SharedBrowserService} with the real Chrome launcher, CDP probe,
 * free-port finder, and lair-config-backed state store.
 */
export function createSharedBrowserService(
  lairRoot: string,
  lairDir: Directory,
  opts: { chromePath?: string; cabinetPort?: number } = {},
): SharedBrowserService {
  return new SharedBrowserService(
    { basePort: DEFAULT_SHARED_BROWSER_BASE_PORT, userDataDir: sharedBrowserProfileDir(lairRoot) },
    {
      launcher: createChromeLauncher(opts.chromePath),
      probe: { probe: (port) => probeChrome(port) },
      store: createCabinetConfigStore(lairDir, opts.cabinetPort ?? 0),
      findFreePort: (start) => findAvailablePort(start),
    },
  );
}
