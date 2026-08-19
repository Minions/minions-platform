import { defineConfig } from 'vitest/config';
import path from 'path';
import { readdirSync } from 'fs';

const libsDir = path.resolve(__dirname, '../../libs');
const libAliases = Object.fromEntries(
  readdirSync(libsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@minions/${d.name}`, path.resolve(libsDir, d.name, 'src/index.ts')])
);

// No `test` block here — vitest.config.ts is this project's actual test
// config (vitest prefers it over this file for direct/`vitest run`
// invocations, so this one was dead code for tests already). Duplicating a
// `test` field here too gave the workspace-root vitest.workspace.ts glob
// two separate project configs with the same inferred project name
// (`@minions/cabinet`), which vitest rejects as non-unique the moment
// anything resolves the workspace as a whole (e.g. QualityWatcher's
// VitestSignalRunner, run at the repo root instead of per-project).
export default defineConfig({
  resolve: {
    alias: libAliases,
  },
});
