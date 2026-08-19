import dotenv from 'dotenv';
import path from 'path';
import { createDominionServer } from './server.js';
import { findAvailablePort } from './utils/port.js';
import { readDominionPort, writeDominionPort } from './utils/portConfig.js';
import { initTray } from './tray.js';
import open from 'open';
import { fileURLToPath } from 'url';
import os from 'os';
import { createDiskSandbox } from '@minions/file-store';

// Build-time constant injected by esbuild
declare const __BUILT_PRODUCT__: boolean | undefined;
const isBuiltProduct = typeof __BUILT_PRODUCT__ !== 'undefined' && __BUILT_PRODUCT__;

// Determine the Dominion root (where lairs.json lives)
async function getDominionRoot(): Promise<string> {
  // If explicit env var, use it
  if (process.env['DOMINION_ROOT']) {
    return process.env['DOMINION_ROOT'];
  }

  // Otherwise read from OS app data config
  const appDataRoot = createDiskSandbox(getAppDataDir()).root;
  const result = await appDataRoot.child('dominion.json');
  if (result.found && result.node.kind === 'file') {
    try {
      const config = JSON.parse(await result.node.read()) as { root?: string };
      if (config.root) return config.root;
    } catch {
      // Malformed config; use default
    }
  }

  // Default: ~/Minions on all platforms (D:\Minions preferred on Windows if exists)
  const homeDir = os.homedir();
  return path.join(homeDir, 'Minions');
}

function getAppDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? os.homedir(), 'Minions');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Minions');
  } else {
    return path.join(os.homedir(), '.config', 'Minions');
  }
}

async function persistDominionRoot(root: string): Promise<void> {
  const appDataRoot = createDiskSandbox(getAppDataDir()).root;
  await appDataRoot.createFile('dominion.json', JSON.stringify({ root }, null, 2));
}

// Load .env from dominion root if it exists
const dominionRoot = await getDominionRoot();
dotenv.config({ path: path.join(dominionRoot, '.env') });

// Persist dominion root so subsequent runs know where to look
await persistDominionRoot(dominionRoot);

// Determine port
let port: number;
if (process.env['DOMINION_PORT']) {
  port = parseInt(process.env['DOMINION_PORT'], 10);
} else if (isBuiltProduct) {
  const dominionDir = createDiskSandbox(dominionRoot).root;
  const saved = await readDominionPort(dominionDir);
  if (saved !== null) {
    port = saved;
  } else {
    port = await findAvailablePort(3535);
    await writeDominionPort(dominionDir, port);
  }
} else {
  // Dev mode: use 3535
  port = await findAvailablePort(3535);
}

// Determine frontend directory (built product has it at dist/frontend/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = isBuiltProduct
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '..', 'src', 'frontend', 'dist');

const app = await createDominionServer({
  dominionRoot,
  port,
  frontendDir,
});

const server = app.listen(port, () => {
  console.log(`The Dominion running at http://localhost:${port}`);
  console.log(`Dominion root: ${dominionRoot}`);
});

// Initialize system tray
const dashboardUrl = `http://localhost:${port}`;
try {
  initTray({
    port,
    onOpen: () => {
      void open(dashboardUrl);
    },
    onQuit: () => {
      console.log('Quitting Dominion...');
      server.close(() => process.exit(0));
    },
  });
} catch (err) {
  // Tray initialization can fail in headless environments; log and continue
  console.warn('Tray initialization failed (headless mode?):', String(err));
}

// Open browser on startup
await open(dashboardUrl);

// Handle graceful shutdown
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
