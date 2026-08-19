import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkRepoVite, MIN_SUPPORTED_VITE_MAJOR, MAX_SUPPORTED_VITE_MAJOR, type PackageResolver } from './resolveWorkRepoVite.js';

/** Writes a fake `vite/package.json` under a fresh temp dir and returns a resolver that points at it. */
function fakeInstalledVite(pkg: Record<string, unknown>): PackageResolver {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-vite-'));
  const pkgPath = join(dir, 'package.json');
  writeFileSync(pkgPath, JSON.stringify(pkg));
  return vi.fn((specifier: string, _cwd: string) => {
    if (specifier === 'vite/package.json') return pkgPath;
    throw new Error(`unexpected specifier: ${specifier}`);
  });
}

describe('resolveWorkRepoVite', () => {
  it('reports not-found when the repo has no installed vite', async () => {
    const resolvePackage: PackageResolver = () => {
      throw new Error("Cannot find module 'vite/package.json'");
    };

    const resolution = await resolveWorkRepoVite('/wing/work/local', resolvePackage);

    expect(resolution).toEqual({ kind: 'not-found' });
  });

  it('reports unsupported-version when the installed major is below the supported floor', async () => {
    const resolvePackage = fakeInstalledVite({ version: `${MIN_SUPPORTED_VITE_MAJOR - 1}.0.0`, main: './dist/node/index.js' });

    const resolution = await resolveWorkRepoVite('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
    if (resolution.kind === 'unsupported-version') {
      expect(resolution.version).toBe(`${MIN_SUPPORTED_VITE_MAJOR - 1}.0.0`);
      expect(resolution.message).toContain('outside the range');
    }
  });

  it('reports unsupported-version when the installed major is above the supported ceiling', async () => {
    const resolvePackage = fakeInstalledVite({ version: `${MAX_SUPPORTED_VITE_MAJOR + 1}.0.0`, main: './dist/node/index.js' });

    const resolution = await resolveWorkRepoVite('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
  });

  it('resolves ok with an entry URL built from the package\'s main field, for a supported version', async () => {
    const resolvePackage = fakeInstalledVite({ version: `${MIN_SUPPORTED_VITE_MAJOR}.2.0`, main: './dist/node/index.js' });

    const resolution = await resolveWorkRepoVite('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.version).toBe(`${MIN_SUPPORTED_VITE_MAJOR}.2.0`);
      expect(resolution.entryUrl.startsWith('file://')).toBe(true);
      expect(resolution.entryUrl.endsWith('dist/node/index.js')).toBe(true);
    }
  });

  it('prefers the module field over main when present', async () => {
    const resolvePackage = fakeInstalledVite({
      version: `${MIN_SUPPORTED_VITE_MAJOR}.0.0`,
      main: './dist/node/cjs-index.js',
      module: './dist/node/index.js',
    });

    const resolution = await resolveWorkRepoVite('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.entryUrl.endsWith('dist/node/index.js')).toBe(true);
      expect(resolution.entryUrl.includes('cjs-index')).toBe(false);
    }
  });
});
