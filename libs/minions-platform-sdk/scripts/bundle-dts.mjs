#!/usr/bin/env node
// Assembles a self-contained dist/index.d.ts (plus a dist/vendor/ tree of
// the `@minions/*` type declarations it depends on) with no `@minions/*`
// bare specifiers left anywhere — a published-package consumer's `tsc` has
// no workspace to resolve those against.
//
// Not a single-file declaration bundler (vite-plugin-dts's `bundleTypes`
// delegates to `@microsoft/api-extractor`; `rollup-plugin-dts` is the other
// standard option): both hit real, independently-confirmed bugs bundling
// this specific ~700-module graph — api-extractor's own hard-pinned
// TypeScript (5.9.3, not overridable via `typescriptCompilerFolder`, which
// only changes lib.d.ts resolution, not the analysis engine) threw an
// internal "Unable to determine semantic information" defect on
// `McpServerCore.ts`; rollup-plugin-dts silently dropped several of
// `@minions/gadgets`' exports (`CostumeExtensions` and others) when
// treated as a rollup entry point, confirmed with a minimal repro
// (`export type { CostumeExtensions } from '@minions/gadgets'` alone, as
// the *only* line in an entry file, fails the same way — nothing
// SDK-specific about it).
//
// This instead leans on something that already reliably works: every
// `@minions/*` lib already builds its own valid multi-file `dist/*.d.ts`
// via its own ordinary `vite build` (proven continuously by this repo's
// own `check-all`). So: build each one, copy its `dist/*.d.ts` files into
// `dist/vendor/<pkg>/`, and mechanically rewrite every `@minions/<pkg>`
// bare specifier — in the vendored files and in this package's own
// dist/index.d.ts — to a relative path into that vendor tree. No semantic
// analysis of the graph required, just text substitution over already-
// correct individual outputs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const libsRoot = path.resolve(pkgRoot, '..');
const distDir = path.join(pkgRoot, 'dist');
const vendorDir = path.join(distDir, 'vendor');

// Every `@minions/*` package this SDK's public surface (src/index.ts)
// reaches, directly or transitively — mirrors this package's own
// `dependencies`/`devDependencies` list (see package.json).
const BUNDLED_PACKAGES = [
  'mcp-server-core',
  'mcp-types',
  'minions-runtime-core',
  'movement-branching',
  'conductor',
  'costumes',
  'domain-types',
  'events',
  'file-store',
  'gadgets',
  'hatchery',
  'quality-watcher',
  'repo-perspective',
  'scheduling',
];

function findDtsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findDtsFiles(full));
    else if (entry.name.endsWith('.d.ts')) results.push(full);
  }
  return results;
}

// Rewrites every `from '@minions/<pkg>'` (or `import(...)`) specifier in
// `content` to a relative path — computed from `fileDir` — into
// `vendorDir/<pkg>/index.js`. The `.js` extension (not just `./index`) is
// required, not cosmetic: under `moduleResolution: "NodeNext"` (this
// package's own `"type": "module"` + `"exports"` map implies it, and it's
// the resolution mode a strict consumer is likeliest to use), a relative
// import with no extension is a hard error (TS2834) — confirmed by
// consuming the packed tarball under an isolated NodeNext tsconfig with
// `skipLibCheck: false`.
function rewriteSpecifiers(content, fileDir) {
  return content.replace(/(['"])@minions\/([\w-]+)\1/g, (match, quote, pkg) => {
    const target = path.join(vendorDir, pkg, 'index.js');
    let rel = path.relative(fileDir, target).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${quote}${rel}${quote}`;
  });
}

// 1. Build every dependency package fresh, so its dist/*.d.ts is current.
for (const pkg of BUNDLED_PACKAGES) {
  console.log(`[bundle-dts] building ${pkg}...`);
  const pkgDir = path.join(libsRoot, pkg);
  // Every package here builds via its own `vite.config.ts` — except
  // `hatchery`, the one lib in this list with no `vite.config.ts` at all;
  // it builds via plain `tsc` against `tsconfig.build.json` instead (see
  // its own `project.json` — its package.json's `"build": "tsc"` script is
  // stale/no-op, since bare `tsc` picks up `tsconfig.json`, which sets
  // `noEmit` for typecheck-only use).
  const args = existsSync(path.join(pkgDir, 'vite.config.ts'))
    ? ['exec', 'vite', 'build']
    : ['exec', 'tsc', '-p', 'tsconfig.build.json'];
  execFileSync('pnpm', args, { cwd: pkgDir, stdio: 'inherit', shell: true });
}

// 2. Copy each one's declaration files into dist/vendor/<pkg>/, rewriting
//    every @minions/* specifier they contain to a vendor-relative path.
rmSync(vendorDir, { recursive: true, force: true });
for (const pkg of BUNDLED_PACKAGES) {
  const srcDistDir = path.join(libsRoot, pkg, 'dist');
  const destDir = path.join(vendorDir, pkg);
  mkdirSync(destDir, { recursive: true });
  for (const file of findDtsFiles(srcDistDir)) {
    const rel = path.relative(srcDistDir, file);
    const dest = path.join(destDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    const rewritten = rewriteSpecifiers(readFileSync(file, 'utf8'), path.dirname(dest));
    writeFileSync(dest, rewritten);
  }
}

// 3. Write this package's own dist/index.d.ts: its src/index.ts is already
//    nothing but `export {...} from '@minions/<pkg>'` re-export statements
//    (valid .d.ts syntax as-is), so the only transform needed is the same
//    specifier rewrite applied to the vendored files above.
const indexSrc = readFileSync(path.join(pkgRoot, 'src/index.ts'), 'utf8');
writeFileSync(path.join(distDir, 'index.d.ts'), rewriteSpecifiers(indexSrc, distDir));

// Sanity check: fail loudly rather than publish something still broken.
// Scoped to .d.ts files only — dist/index.js legitimately contains the
// substring "@minions/" inside an unrelated Effect `GenericTag(...)` string
// literal, not an import specifier.
const leftover = [path.join(distDir, 'index.d.ts'), ...findDtsFiles(vendorDir)].filter((f) =>
  /(['"])@minions\/[\w-]+\1/.test(readFileSync(f, 'utf8')),
);
if (leftover.length > 0) {
  throw new Error(`bundle-dts: unresolved @minions/* specifiers remain in:\n${leftover.join('\n')}`);
}

console.log(`[bundle-dts] wrote dist/index.d.ts + dist/vendor/ (${BUNDLED_PACKAGES.length} packages)`);
