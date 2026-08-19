import { defineConfig } from 'vitest/config';
import path from 'path';
import { readdirSync } from 'fs';

// Unlike a normal in-repo lib, this package is the publishable SDK artifact
// itself: every `@minions/*` workspace dep it pulls in (mcp-server-core,
// minions-runtime-core, and their own transitive `@minions/*` deps) must be
// bundled into dist/index.js, not left as external `@minions/*` imports —
// an external application installing this package has no workspace to
// resolve those against. Only real npm packages and Node builtins stay
// external. The equivalent problem for type declarations (dist/index.d.ts)
// is solved separately, by scripts/bundle-dts.mjs — a plain Node script
// that copies each dependency's already-built .d.ts files into dist/vendor/
// and rewrites their `@minions/*` specifiers with text substitution; it
// does not import or reuse this alias map (see that file's own header
// comment for why single-file declaration bundling via vite-plugin-dts/
// api-extractor and rollup-plugin-dts were both tried and abandoned).
const libsDir = path.resolve(__dirname, '..');
const libAliases = Object.fromEntries(
  readdirSync(libsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@minions/${d.name}`, path.resolve(libsDir, d.name, 'src/index.ts')])
);

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/minions-platform-sdk',
  resolve: {
    alias: libAliases,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        /^@anthropic-ai\//,
        /^@modelcontextprotocol\//,
        /^node:/,
        'crypto',
        'path',
        'fs',
        'events',
        'os',
        'child_process',
        'util',
        'stream',
        'url',
        'readline',
        'module',
        'effect',
        'eventemitter3',
        'express',
      ],
    },
  },
});
