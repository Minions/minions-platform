#!/usr/bin/env node
import { build } from 'esbuild';
import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { cp, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { version: cabinetVersion } = JSON.parse(
  await readFile(path.resolve(__dirname, '../package.json'), 'utf-8')
);

// Workspace root is two levels up from scripts/ (apps/cabinet/scripts -> work/local)
const workspaceRoot = path.resolve(__dirname, '../../..');
const libsDir = path.join(workspaceRoot, 'libs');

// Baked in at build time — this is the only way to know a built product's
// commit sha, since a deployed lair root isn't necessarily a git checkout
// and dev mode's runtime `git rev-parse` (main.ts) doesn't run for a built
// product. Works for any local build (no CI-only env var like GITHUB_SHA
// needed) — just shells out to the git binary already required to have
// this checkout in the first place. Falls back to 'unknown' rather than
// failing the build if git isn't available for some reason.
let cabinetSha;
try {
  cabinetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf-8' }).trim();
} catch {
  cabinetSha = 'unknown';
}
const cabinetVersionWithSha = `${cabinetVersion}+${cabinetSha}`;

// Read once here rather than hardcoding in ensureFallbackOxlint.ts, so
// bumping the workspace's own `packageManager` or `oxlint` devDependency
// carries through to the fallback oxlint installer automatically on the
// next Cabinet build/deploy, instead of silently drifting out of sync.
const { packageManager: workspacePnpmPackageManager, devDependencies: workspaceDevDependencies } = JSON.parse(
  await readFile(path.join(workspaceRoot, 'package.json'), 'utf-8')
);
const workspaceOxlintVersionRange = workspaceDevDependencies.oxlint;

// Map workspace package names to their source entry points
// This allows esbuild to bundle workspace dependencies
const workspacePackages = {
  '@minions/conductor': path.join(libsDir, 'conductor/src/index.ts'),
  '@minions/costumes': path.join(libsDir, 'costumes/src/index.ts'),
  '@minions/domain-types': path.join(libsDir, 'domain-types/src/index.ts'),
  '@minions/events': path.join(libsDir, 'events/src/index.ts'),
  '@minions/file-store': path.join(libsDir, 'file-store/src/index.ts'),
  '@minions/gadgets': path.join(libsDir, 'gadgets/src/index.ts'),
  '@minions/hatchery': path.join(libsDir, 'hatchery/src/index.ts'),
  '@minions/mcp-types': path.join(libsDir, 'mcp-types/src/index.ts'),
  '@minions/movement-branching': path.join(libsDir, 'movement-branching/src/index.ts'),
  '@minions/quality-watcher': path.join(libsDir, 'quality-watcher/src/index.ts'),
};

// Plugin to resolve workspace packages to their source files
const workspacePlugin = {
  name: 'workspace-packages',
  setup(build) {
    // Resolve @minions/* packages to their source entry points
    build.onResolve({ filter: /^@minions\// }, (args) => {
      const packagePath = workspacePackages[args.path];
      if (packagePath) {
        return { path: packagePath };
      }
      // Let esbuild handle unknown @minions packages normally
      return null;
    });
  },
};

// Every esbuild ESM output that might bundle a CJS dependency doing its own
// `require()` (e.g. cross-spawn, pulled in transitively by
// productionQualityWatcherFactory.ts's real oxlint-process spawning) needs
// this shim — esbuild's own `require` polyfill for `format: 'esm'` bundles.
// Shared between both build() calls below so the second one doesn't drift
// from the main bundle's own working banner.
const cjsInteropBanner = `import { createRequire as __createRequire__ } from 'module';
import { fileURLToPath as __fileURLToPath__ } from 'url';
import __path__ from 'path';
const require = __createRequire__(import.meta.url);
const __filename = __fileURLToPath__(import.meta.url);
const __dirname = __path__.dirname(__filename);
`;

console.log('Building cabinet with esbuild...');

try {
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
      // vitest is dynamically imported (`await import('vitest/node')`) to
      // drive watch mode; its optional browser-mode chunks reference
      // '@vitest/browser', which isn't installed. Leave vitest external so
      // esbuild doesn't try to statically resolve those optional deps.
      'vitest',
      'vitest/node',
      '@vitest/browser',
      // vue3-sfc-loader (dynamically imported in compileVueAskContent.ts,
      // to server-render a Vue SFC for the ask tool) pulls in
      // @vue/compiler-sfc, whose bundled consolidate.js does its own
      // dynamic `require()` of dozens of optional third-party template
      // engines — none of which are installed, and none of which are ever
      // exercised (only the Vue SFC compiler path runs; every other
      // consolidate.js entry point is dead code for us). Rather than
      // externalizing vue3-sfc-loader itself (this build has no install
      // step at deploy time — see new_lair.zip/scripts/create-lair-package.js
      // — so an external runtime dependency would 404 at require-time
      // instead of build-time), mark just these unused leaf packages
      // external: esbuild leaves their `require("x")` calls as literal,
      // unresolved requires in the bundle, which only matters if that
      // specific template engine's branch actually runs — it never does.
      'velocityjs',
      'dustjs-linkedin',
      'atpl',
      'liquor',
      'twig',
      'eco',
      'jazz',
      'jqtpl',
      'hamljs',
      'hamlet',
      'whiskers',
      'haml-coffee',
      'hogan.js',
      'templayed',
      'underscore',
      'walrus',
      'mustache',
      'just',
      'ect',
      'mote',
      'toffee',
      'dot',
      'bracket-template',
      'ractive',
      'htmling',
      'babel-core',
      'plates',
      'react-dom/server',
      'react',
      'vash',
      'slm',
      'marko',
      'teacup/lib/express',
      'coffee-script',
      'squirrelly',
      'twing',
    ],
    sourcemap: true,
    minify: false,
    define: {
      __BUILT_PRODUCT__: 'true',
      __CABINET_VERSION__: JSON.stringify(cabinetVersionWithSha),
      __WORKSPACE_PNPM_PACKAGE_MANAGER__: JSON.stringify(workspacePnpmPackageManager),
      __WORKSPACE_OXLINT_VERSION_RANGE__: JSON.stringify(workspaceOxlintVersionRange),
    },
    banner: {
      js: `#!/usr/bin/env node\n${cjsInteropBanner}`,
    },
  });

  console.log('✓ Cabinet built successfully');

  // Copy public directory to dist
  await copyPublicDir();

  // productionQualityWatcherFactory.ts (see server.ts's own doc comment) is
  // reached from the main bundle via a non-literal `import()` specifier —
  // deliberately opaque to esbuild's static bundler, so server.ts type-
  // checks identically whether or not this file exists in this checkout
  // (e.g. it doesn't in a `minions-platform`-only extraction, per
  // docs/design/repo-split-analysis.md). That opacity means esbuild never
  // pulls this file's own code into dist/main.js, so it needs its own
  // separate build step to actually produce a real dist/quality/*.js file
  // for that runtime import to find — without this, the built product
  // silently runs with quality watching permanently disabled, since nothing
  // else ever compiles src/quality/*.ts to dist/. Skipped entirely (not an
  // error) when the source file isn't present, so this same script also
  // works unmodified against a `minions-platform`-only checkout.
  await buildProductionQualityWatcherFactory();
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}

async function buildProductionQualityWatcherFactory() {
  const entry = path.resolve(__dirname, '../src/quality/productionQualityWatcherFactory.ts');
  if (!existsSync(entry)) {
    console.log('  (skipping productionQualityWatcherFactory.ts build — not present in this checkout)');
    return;
  }

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.resolve(__dirname, '../dist/quality/productionQualityWatcherFactory.js'),
    plugins: [workspacePlugin],
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    sourcemap: true,
    minify: false,
    // Must match the main bundle's own `define` block: without these baked
    // in, ensureFallbackOxlint.ts's resolveVersionPins() falls back to
    // computing a workspace package.json path relative to this file's own
    // location — a fallback meant only for running unbundled straight out of
    // src/. That fallback happens to still resolve correctly from this
    // monorepo's own dist/ (same directory depth as src/), which is exactly
    // why omitting this went unnoticed here — but create-lair-package.js
    // flattens dist/* into <lair>/tools/runtime/*, four directories
    // shallower than any real workspace root, so the same relative lookup
    // silently escapes the deployed lair package and fails to find any
    // package.json at all.
    define: {
      __WORKSPACE_PNPM_PACKAGE_MANAGER__: JSON.stringify(workspacePnpmPackageManager),
      __WORKSPACE_OXLINT_VERSION_RANGE__: JSON.stringify(workspaceOxlintVersionRange),
    },
    banner: {
      js: cjsInteropBanner,
    },
  });

  console.log('✓ productionQualityWatcherFactory built successfully');
}

async function copyPublicDir() {
  const publicDir = path.resolve(__dirname, '../public');
  const distDir = path.resolve(__dirname, '../dist');

  try {
    // Copy public directory contents to dist
    await cp(publicDir, distDir, { recursive: true });
    console.log('✓ Public directory copied to dist');
  } catch (error) {
    // Ignore if public directory doesn't exist
    if (error.code !== 'ENOENT') {
      console.error('Failed to copy public directory:', error);
      throw error;
    }
  }
}
