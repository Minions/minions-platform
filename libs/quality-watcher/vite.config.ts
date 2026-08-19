import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';
import path from 'path';
import { readdirSync } from 'fs';

const libsDir = path.resolve(__dirname, '..');
const libAliases = Object.fromEntries(
  readdirSync(libsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@minions/${d.name}`, path.resolve(libsDir, d.name, 'src/index.ts')])
);

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/quality-watcher',
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.json'),
      aliasesExclude: [/^@minions\//],
      exclude: ['**/*.test.ts'],
    }),
  ],
  resolve: {
    alias: libAliases,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
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
      // vite/vitest/typescript are used as real runtime dependencies here
      // (their Node APIs, for in-process watch signals) — never bundle
      // them, or their own optional native deps (e.g. fsevents) end up
      // getting dragged into this library's build.
      external: [/^@minions\//, 'effect', /^node:/, 'eslint', 'vite', 'vitest', 'vitest/node', 'typescript'],
    },
  },
});
