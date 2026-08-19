import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkRepoVitest, MIN_SUPPORTED_VITEST_MAJOR, MAX_SUPPORTED_VITEST_MAJOR, type PackageResolver } from './resolveWorkRepoVitest.js';

/** Writes a fake `vitest/package.json` under a fresh temp dir and returns a resolver that points at it. */
function fakeInstalledVitest(pkg: Record<string, unknown>): PackageResolver {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-vitest-'));
  const pkgPath = join(dir, 'package.json');
  writeFileSync(pkgPath, JSON.stringify(pkg));
  return vi.fn((specifier: string, _cwd: string) => {
    if (specifier === 'vitest/package.json') return pkgPath;
    throw new Error(`unexpected specifier: ${specifier}`);
  });
}

describe('resolveWorkRepoVitest', () => {
  it('reports not-found when the repo has no installed vitest', async () => {
    const resolvePackage: PackageResolver = () => {
      throw new Error("Cannot find module 'vitest/package.json'");
    };

    const resolution = await resolveWorkRepoVitest('/wing/work/local', resolvePackage);

    expect(resolution).toEqual({ kind: 'not-found' });
  });

  it('reports unsupported-version when the installed major is below the supported floor', async () => {
    const resolvePackage = fakeInstalledVitest({
      version: `${MIN_SUPPORTED_VITEST_MAJOR - 1}.0.0`,
      exports: { './node': { default: './dist/node.js' } },
    });

    const resolution = await resolveWorkRepoVitest('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
    if (resolution.kind === 'unsupported-version') {
      expect(resolution.version).toBe(`${MIN_SUPPORTED_VITEST_MAJOR - 1}.0.0`);
      expect(resolution.message).toContain('outside the range');
    }
  });

  it('reports unsupported-version when the installed major is above the supported ceiling', async () => {
    const resolvePackage = fakeInstalledVitest({
      version: `${MAX_SUPPORTED_VITEST_MAJOR + 1}.0.0`,
      exports: { './node': { default: './dist/node.js' } },
    });

    const resolution = await resolveWorkRepoVitest('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
  });

  it('resolves ok with an entry URL built from the exports["./node"] field, for a supported version', async () => {
    const resolvePackage = fakeInstalledVitest({
      version: `${MIN_SUPPORTED_VITEST_MAJOR}.2.0`,
      exports: { './node': { default: './dist/node.js' } },
    });

    const resolution = await resolveWorkRepoVitest('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.version).toBe(`${MIN_SUPPORTED_VITEST_MAJOR}.2.0`);
      expect(resolution.entryUrl.startsWith('file://')).toBe(true);
      expect(resolution.entryUrl.endsWith('dist/node.js')).toBe(true);
    }
  });

  it('falls back to dist/node.js when exports["./node"] is missing', async () => {
    const resolvePackage = fakeInstalledVitest({ version: `${MIN_SUPPORTED_VITEST_MAJOR}.0.0` });

    const resolution = await resolveWorkRepoVitest('/wing/work/local', resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.entryUrl.endsWith('dist/node.js')).toBe(true);
    }
  });
});
