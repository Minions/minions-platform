import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readdirSync } from 'fs';

const libsDir = path.resolve(__dirname, '../../libs');
const libAliases = Object.fromEntries(
  readdirSync(libsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`@minions/${d.name}`, path.resolve(libsDir, d.name, 'src/index.ts')])
);

// Resolve MCP SDK paths - the package uses subpath exports that need explicit resolution in Vite
const mcpSdkBase = path.resolve(__dirname, 'node_modules/@modelcontextprotocol/sdk/dist/esm');

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  resolve: {
    alias: {
      ...libAliases,
      '@modelcontextprotocol/sdk/client/index.js': path.join(mcpSdkBase, 'client/index.js'),
      '@modelcontextprotocol/sdk/client/streamableHttp.js': path.join(mcpSdkBase, 'client/streamableHttp.js'),
    },
  },
  build: {
    outDir: 'dist',
    // Remaining chunks over the default 500kB are verified-legitimate, already
    // lazy-loaded feature weight (DocsViewer's Tiptap/ProseMirror editor, the
    // mermaid engine) or an unavoidable dependency of the official MCP client
    // SDK (ajv/zod) in the main bundle — not accidental bloat pulled in by our
    // own code. Router routes and mermaidExtension's mermaid import are
    // already lazy; that's what got the main bundle and DocsViewer under
    // control. Limit is set just above the current largest chunk (mermaid's
    // core diagram chunk, ~663kB) so any *new* oversized chunk still warns.
    chunkSizeWarningLimit: 670,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
