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
  cacheDir: '../../node_modules/.vite/libs/planner-types',
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.json'),
      aliasesExclude: [/^@minions\//],
    }),
  ],
  resolve: {
    alias: libAliases,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Pure interfaces/types — no behavior of its own to test yet.
    passWithNoTests: true,
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
      external: [/^@minions\//],
    },
  },
});
