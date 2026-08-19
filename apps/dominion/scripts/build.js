#!/usr/bin/env node
import { build } from 'esbuild';
import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const workspaceRoot = path.resolve(__dirname, '../../..');
const libsDir = path.join(workspaceRoot, 'libs');

const workspacePackages = {
  '@minions/file-store': path.join(libsDir, 'file-store/src/index.ts'),
  '@minions/lair-config': path.join(libsDir, 'lair-config/src/index.ts'),
  '@minions/lair-provisioner': path.join(libsDir, 'lair-provisioner/src/index.ts'),
};

const workspacePlugin = {
  name: 'workspace-packages',
  setup(build) {
    build.onResolve({ filter: /^@minions\// }, (args) => {
      const packagePath = workspacePackages[args.path];
      if (packagePath) {
        return { path: packagePath };
      }
      return null;
    });
  },
};

console.log('Building dominion with esbuild...');

await build({
  entryPoints: [path.resolve(__dirname, '../src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: path.resolve(__dirname, '../dist/main.js'),
  plugins: [workspacePlugin],
  external: [
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`),
    // Keep native modules external
    'node-systray',
  ],
  sourcemap: false,
  minify: false,
  define: {
    __BUILT_PRODUCT__: 'true',
  },
  banner: {
    js: `#!/usr/bin/env node
import { createRequire } from 'module';
import { fileURLToPath as __fileURLToPath__ } from 'url';
import __path__ from 'path';
const require = createRequire(import.meta.url);
const __filename = __fileURLToPath__(import.meta.url);
const __dirname = __path__.dirname(__filename);
`,
  },
});

console.log('✓ Dominion built successfully');
