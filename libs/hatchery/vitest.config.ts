import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['specs/**/*.spec.ts'],
    exclude: ['specs/integration/**', 'specs/clients/opencode.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts']
    },
    testTimeout: 10000
  }
});
