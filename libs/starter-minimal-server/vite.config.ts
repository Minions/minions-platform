import { defineConfig } from 'vitest/config';

// This package is a template to copy out of the repo, not a built lib — no
// `build` target, just enough config to typecheck and run its own test
// in-repo as proof the template actually works, not just compiles.
export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/libs/starter-minimal-server',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
