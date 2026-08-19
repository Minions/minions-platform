import { defineConfig } from 'vitest/config';
import path from 'path';

const root = path.resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@minions/mcp-types': path.join(root, 'libs/mcp-types/src'),
      '@minions/quality-watcher': path.join(root, 'libs/quality-watcher/src'),
      '@minions/feature-flags': path.join(root, 'libs/feature-flags/src'),
      '@minions/planner': path.join(root, 'libs/planner/src'),
      '@minions/planner-types': path.join(root, 'libs/planner-types/src'),
      '@minions/movement-branching': path.join(root, 'libs/movement-branching/src'),
      '@minions/file-store': path.join(root, 'libs/file-store/src'),
      '@minions/hatchery': path.join(root, 'libs/hatchery/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
