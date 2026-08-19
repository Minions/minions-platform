#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { configureNxDaemonEnv } from './nx-daemon.mjs';

// Shared entry point for every check-all* package.json script. Routes all of
// them through configureNxDaemonEnv() so a cold run never lets nx fork a
// detached daemon that can leak a piped stdout handle (see nx-daemon.mjs for
// the full explanation) — do not call `nx` directly from package.json again.
const nxDaemonSetting = configureNxDaemonEnv();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node check.mjs <nx args...>, e.g. run-many -t test lint typecheck --all');
  process.exit(1);
}

const result = spawnSync('nx', args, {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

if (result.error) {
  console.error(`[check.mjs] failed to spawn nx (NX_DAEMON=${nxDaemonSetting}):`, result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
