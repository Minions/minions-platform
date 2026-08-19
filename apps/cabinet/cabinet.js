#!/usr/bin/env node

/**
 * Cabinet Runtime Wrapper
 *
 * This script should be copied to a lair's tools/ directory as "cabinet"
 * It runs the cabinet server with the lair root automatically configured.
 *
 * Usage from lair root:
 *   node tools/cabinet          # Production mode
 *   node tools/cabinet --dev    # Development mode
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lair root is parent of tools/ directory
const lairRoot = resolve(__dirname, '..');

// Determine if in dev mode
const isDev = process.argv.includes('--dev');

// Path to cabinet app
const cabinetAppPath = join(__dirname, '..', 'wings', 'central-planning', 'work', 'local', 'apps', 'cabinet');

// Set environment
process.env.LAIR_ROOT = lairRoot;

if (isDev) {
  console.log(`Starting Cabinet in development mode for lair: ${lairRoot}`);

  // Run with vite-node for dev mode
  const child = spawn('pnpm', ['dev'], {
    cwd: cabinetAppPath,
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
} else {
  console.log(`Starting Cabinet in production mode for lair: ${lairRoot}`);

  // Check if built
  const distPath = join(cabinetAppPath, 'dist', 'main.js');

  // Run production build
  const child = spawn('node', [distPath], {
    cwd: cabinetAppPath,
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}
