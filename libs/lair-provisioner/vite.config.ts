import { defineConfig } from 'vitest/config';
import path from 'path';
import { readdirSync } from 'fs';

const libsDir = path.resolve(__dirname, '../../libs');
const libAliases = Object.fromEntries(
  readdirSync(libsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@minions/${d.name}`, path.resolve(libsDir, d.name, 'src/index.ts')])
);

export default defineConfig({
  resolve: {
    alias: libAliases,
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
