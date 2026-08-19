#!/usr/bin/env node

/**
 * Shared costume build utility
 *
 * Reads build.json from the costume's src/ directory and builds
 * the costume into dist/ according to the specified strategy.
 *
 * Usage:
 *   node path/to/build-costume.cjs [costume-root]
 *
 * If costume-root is not specified, uses the current directory.
 *
 * Strategies:
 * - "copy": Copies src/ to dist/ recursively
 * - "bundle": Bundles TypeScript files with esbuild, copies everything else
 */

const fs = require('fs');
const path = require('path');

const costumeRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const srcDir = path.join(costumeRoot, 'src');
const distDir = path.join(costumeRoot, 'dist');

/**
 * Copy a directory recursively
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy directory but skip TypeScript files (they'll be bundled)
 */
function copyDirSkipTs(src, dest) {
  if (!fs.existsSync(src)) return;

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSkipTs(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Find all TypeScript files in a directory (non-recursive, excluding tests)
 */
function findTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map(f => ({
      name: path.basename(f, '.ts'),
      path: path.join(dir, f),
    }));
}

/**
 * Find the monorepo root (work/local/) by walking up from costume root
 * looking for a directory with both libs/ and costumes/
 */
function findWorkLocalDir() {
  let dir = costumeRoot;
  for (let i = 0; i < 5; i++) {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'libs')) && fs.existsSync(path.join(dir, 'costumes'))) {
      return dir;
    }
  }
  // Fallback: assume costumes are at work/local/costumes/X/
  return path.resolve(costumeRoot, '../..');
}

/**
 * Load esbuild from pnpm's node_modules
 */
function loadEsbuild() {
  const workLocal = findWorkLocalDir();
  const pnpmDir = path.join(workLocal, 'node_modules/.pnpm');

  // Find the installed esbuild version dynamically rather than hardcoding it
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('esbuild@')) {
        const esbuildPkg = path.join(pnpmDir, entry, 'node_modules/esbuild/package.json');
        if (fs.existsSync(esbuildPkg)) {
          const { createRequire } = require('module');
          const esbuildRequire = createRequire(esbuildPkg);
          return esbuildRequire('esbuild');
        }
      }
    }
  }

  throw new Error('Could not find esbuild. Make sure it is installed.');
}

/**
 * Find node_modules paths in the pnpm virtual store so esbuild can resolve
 * packages that are not directly symlinked (e.g. in a workspace with no package.json).
 */
function findPnpmNodePaths(workLocalDir) {
  const pnpmDir = path.join(workLocalDir, 'node_modules', '.pnpm');
  const nodePaths = [];
  if (!fs.existsSync(pnpmDir)) return nodePaths;

  for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nodeModulesPath = path.join(pnpmDir, entry.name, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        nodePaths.push(nodeModulesPath);
      }
    }
  }
  return nodePaths;
}

/**
 * Build workspace package resolver plugin for esbuild
 */
function createWorkspacePlugin(workLocalDir) {
  const libsDir = path.join(workLocalDir, 'libs');
  const workspacePackages = {};

  // Discover workspace packages
  if (fs.existsSync(libsDir)) {
    for (const lib of fs.readdirSync(libsDir, { withFileTypes: true })) {
      if (lib.isDirectory()) {
        const entrypoint = path.join(libsDir, lib.name, 'src/index.ts');
        if (fs.existsSync(entrypoint)) {
          workspacePackages[`@minions/${lib.name}`] = entrypoint;
        }
      }
    }
  }

  return {
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
}

async function build() {
  // Read build.json
  const buildJsonPath = path.join(srcDir, 'build.json');
  if (!fs.existsSync(buildJsonPath)) {
    console.error(`No build.json found at ${buildJsonPath}`);
    process.exit(1);
  }

  const buildConfig = JSON.parse(fs.readFileSync(buildJsonPath, 'utf-8'));
  const strategy = buildConfig.strategy;

  if (strategy !== 'copy' && strategy !== 'bundle') {
    console.error(`Unknown build strategy: ${strategy}`);
    process.exit(1);
  }

  const costumeName = path.basename(costumeRoot);
  console.log(`Building ${costumeName} costume (strategy: ${strategy})...`);

  // Clean dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  if (strategy === 'copy') {
    // Copy everything from src/ to dist/
    copyDir(srcDir, distDir);
    // Remove build.json from dist (it's build metadata, not runtime config)
    const distBuildJson = path.join(distDir, 'build.json');
    if (fs.existsSync(distBuildJson)) {
      fs.unlinkSync(distBuildJson);
    }
    console.log('Done.');
    return;
  }

  // strategy === 'bundle'
  const bundleConfig = buildConfig.bundle || {};
  const bundleDirs = bundleConfig.bundleDirs || ['missions'];
  const external = bundleConfig.external || ['@modelcontextprotocol/*'];

  // Node built-ins are always external
  const nodeBuiltins = [
    'fs', 'path', 'url', 'util', 'stream', 'events', 'buffer',
    'crypto', 'http', 'https', 'net', 'os', 'child_process',
  ];

  const workLocalDir = findWorkLocalDir();
  const esbuild = loadEsbuild();
  const workspacePlugin = createWorkspacePlugin(workLocalDir);
  const pnpmNodePaths = findPnpmNodePaths(workLocalDir);

  // Copy all src/ contents, skipping TS in bundle dirs
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of srcEntries) {
    if (entry.name === 'build.json') continue; // Skip build config

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(distDir, entry.name);

    if (entry.isDirectory()) {
      if (bundleDirs.includes(entry.name)) {
        // For bundle dirs: copy non-TS files, bundle TS files
        copyDirSkipTs(srcPath, destPath);
      } else {
        // For other dirs: copy everything
        copyDir(srcPath, destPath);
      }
    } else {
      // Copy individual files (costume.json, prompt.md, etc.)
      // Skip .ts files — they're utility modules inlined by esbuild, except
      // extensions.ts (the CostumeExtensions entry point), which is bundled below.
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Bundle TypeScript files in each bundle dir
  let totalBundled = 0;

  // Bundle the costume-root extensions.ts entry point, if present — it is
  // never a bundleDir member (ClosetExtensionLoader looks for it directly
  // at the costume root, not inside a subdirectory).
  const extensionsPath = path.join(srcDir, 'extensions.ts');
  if (fs.existsSync(extensionsPath)) {
    console.log('  Bundling extensions.ts...');
    await esbuild.build({
      entryPoints: [extensionsPath],
      outfile: path.join(distDir, 'extensions.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      plugins: [workspacePlugin],
      external: [...nodeBuiltins, ...external],
      nodePaths: pnpmNodePaths,
      loader: { '.md': 'text' },
      sourcemap: true,
      keepNames: true,
    });
    totalBundled++;
  }

  for (const dir of bundleDirs) {
    const tsFiles = findTsFiles(path.join(srcDir, dir));
    const outDir = path.join(distDir, dir);
    fs.mkdirSync(outDir, { recursive: true });

    for (const file of tsFiles) {
      console.log(`  Bundling ${dir}/${file.name}.ts...`);

      await esbuild.build({
        entryPoints: [file.path],
        outfile: path.join(outDir, `${file.name}.js`),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        plugins: [workspacePlugin],
        external: [...nodeBuiltins, ...external],
        nodePaths: pnpmNodePaths,
        loader: { '.md': 'text' },
        sourcemap: true,
        keepNames: true,
      });
      totalBundled++;
    }
  }

  console.log(`Done. Bundled ${totalBundled} TypeScript files.`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
