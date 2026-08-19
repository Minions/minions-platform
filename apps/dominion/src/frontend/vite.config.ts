import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3535',
      '/mcp': 'http://localhost:3535',
      '/health': 'http://localhost:3535',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
