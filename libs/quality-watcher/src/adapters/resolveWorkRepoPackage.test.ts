import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasWorkRepoPackage,
  resolveFromSources,
  workRepoPackageEntrySource,
  resolveWorkRepoPackageEntry,
  type PackageResolver,
  type PackageResolution,
  type PackageSource,
  type WorkRepoPackageEntryOptions,
} from './resolveWorkRepoPackage.js';

/** Writes a fake `<packageName>/package.json` under a fresh temp dir and returns a resolver that points at it. */
function fakeInstalledPackage(packageName: string, pkg: Record<string, unknown>): PackageResolver {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-work-repo-package-'));
  const pkgPath = join(dir, 'package.json');
  writeFileSync(pkgPath, JSON.stringify(pkg));
  return vi.fn((specifier: string, _cwd: string) => {
    if (specifier === `${packageName}/package.json`) return pkgPath;
    throw new Error(`unexpected specifier: ${specifier}`);
  });
}

const baseOptions: Omit<WorkRepoPackageEntryOptions, 'minSupportedMajor' | 'maxSupportedMajor'> = {
  packageName: 'some-tool',
  signalName: 'example',
  entryRelPath: (pkg) => (pkg.main as string) ?? 'dist/index.js',
};

describe('hasWorkRepoPackage', () => {
  it('is true when the package resolves from the work repo', () => {
    const resolvePackage: PackageResolver = () => '/wing/work/local/node_modules/oxlint/package.json';

    expect(hasWorkRepoPackage('/wing/work/local', 'oxlint', resolvePackage)).toBe(true);
  });

  it('is false when resolution throws', () => {
    const resolvePackage: PackageResolver = () => {
      throw new Error("Cannot find module 'oxlint/package.json'");
    };

    expect(hasWorkRepoPackage('/wing/work/local', 'oxlint', resolvePackage)).toBe(false);
  });

  it('never reads the file — resolution success/failure alone decides the result', () => {
    const resolvePackage: PackageResolver = () => '/nonexistent/path/oxlint/package.json';

    expect(hasWorkRepoPackage('/wing/work/local', 'oxlint', resolvePackage)).toBe(true);
  });
});

describe('workRepoPackageEntrySource + resolveWorkRepoPackageEntry', () => {
  it('reports not-found when the repo has no installed copy of the package', async () => {
    const resolvePackage: PackageResolver = () => {
      throw new Error("Cannot find module 'some-tool/package.json'");
    };

    const resolution = await resolveWorkRepoPackageEntry('/wing/work/local', { ...baseOptions, minSupportedMajor: 1, maxSupportedMajor: 2 }, resolvePackage);

    expect(resolution).toEqual({ kind: 'not-found' });
  });

  it('reports unsupported-version when the installed major is below the supported floor', async () => {
    const resolvePackage = fakeInstalledPackage('some-tool', { version: '0.9.0', main: './dist/index.js' });

    const resolution = await resolveWorkRepoPackageEntry('/wing/work/local', { ...baseOptions, minSupportedMajor: 1, maxSupportedMajor: 2 }, resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
    if (resolution.kind === 'unsupported-version') {
      expect(resolution.version).toBe('0.9.0');
      expect(resolution.message).toContain('outside the range');
      expect(resolution.message).toContain('some-tool');
      expect(resolution.message).toContain('example');
    }
  });

  it('reports unsupported-version when the installed major is above the supported ceiling', async () => {
    const resolvePackage = fakeInstalledPackage('some-tool', { version: '3.0.0', main: './dist/index.js' });

    const resolution = await resolveWorkRepoPackageEntry('/wing/work/local', { ...baseOptions, minSupportedMajor: 1, maxSupportedMajor: 2 }, resolvePackage);

    expect(resolution.kind).toBe('unsupported-version');
  });

  it('resolves ok with an entry URL built from entryRelPath, for a supported version', async () => {
    const resolvePackage = fakeInstalledPackage('some-tool', { version: '2.1.0', main: './dist/index.js' });

    const resolution = await resolveWorkRepoPackageEntry('/wing/work/local', { ...baseOptions, minSupportedMajor: 1, maxSupportedMajor: 2 }, resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.version).toBe('2.1.0');
      expect(resolution.entryUrl.startsWith('file://')).toBe(true);
      expect(resolution.entryUrl.endsWith('dist/index.js')).toBe(true);
    }
  });

  it('passes the parsed package.json through to entryRelPath, e.g. to read exports fields', async () => {
    const resolvePackage = fakeInstalledPackage('some-tool', {
      version: '2.0.0',
      exports: { './node': { default: './dist/node.js' } },
    });
    const options: WorkRepoPackageEntryOptions = {
      ...baseOptions,
      minSupportedMajor: 1,
      maxSupportedMajor: 2,
      entryRelPath: (pkg) => (pkg.exports as { './node': { default: string } })['./node'].default,
    };

    const resolution = await resolveWorkRepoPackageEntry('/wing/work/local', options, resolvePackage);

    expect(resolution.kind).toBe('ok');
    if (resolution.kind === 'ok') {
      expect(resolution.entryUrl.endsWith('dist/node.js')).toBe(true);
    }
  });
});

describe('resolveFromSources', () => {
  it('returns not-found when every source comes up empty', async () => {
    const sources: PackageSource<string>[] = [() => ({ kind: 'not-found' }), () => ({ kind: 'not-found' })];

    const resolution = await resolveFromSources('/wing/work/local', sources);

    expect(resolution).toEqual({ kind: 'not-found' });
  });

  it('falls through a not-found source to try the next one — the fallback pattern', async () => {
    const primary: PackageSource<string> = vi.fn((): PackageResolution<string> => ({ kind: 'not-found' }));
    const fallback: PackageSource<string> = vi.fn((): PackageResolution<string> => ({ kind: 'ok', value: 'from-fallback' }));

    const resolution = await resolveFromSources('/wing/work/local', [primary, fallback]);

    expect(resolution).toEqual({ kind: 'ok', value: 'from-fallback' });
    expect(primary).toHaveBeenCalledWith('/wing/work/local');
    expect(fallback).toHaveBeenCalledWith('/wing/work/local');
  });

  it('never even calls a later source once an earlier one resolves ok', async () => {
    const primary: PackageSource<string> = () => ({ kind: 'ok', value: 'from-primary' });
    const fallback: PackageSource<string> = vi.fn((): PackageResolution<string> => ({ kind: 'ok', value: 'from-fallback' }));

    const resolution = await resolveFromSources('/wing/work/local', [primary, fallback]);

    expect(resolution).toEqual({ kind: 'ok', value: 'from-primary' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('supports a chain of more than one fallback — first ok anywhere in the chain wins', async () => {
    const sources: PackageSource<string>[] = [
      () => ({ kind: 'not-found' }),
      () => ({ kind: 'not-found' }),
      () => ({ kind: 'ok', value: 'from-third-fallback' }),
    ];

    const resolution = await resolveFromSources('/wing/work/local', sources);

    expect(resolution).toEqual({ kind: 'ok', value: 'from-third-fallback' });
  });

  it('falls through an unsupported-version source too, in case a fallback works', async () => {
    const primary: PackageSource<string> = () => ({ kind: 'unsupported-version', version: '0.1.0', message: 'too old' });
    const fallback: PackageSource<string> = () => ({ kind: 'ok', value: 'from-fallback' });

    const resolution = await resolveFromSources('/wing/work/local', [primary, fallback]);

    expect(resolution).toEqual({ kind: 'ok', value: 'from-fallback' });
  });

  it('surfaces the first unsupported-version if nothing later pans out either', async () => {
    const primary: PackageSource<string> = () => ({ kind: 'unsupported-version', version: '0.1.0', message: 'too old' });
    const fallback: PackageSource<string> = () => ({ kind: 'not-found' });

    const resolution = await resolveFromSources('/wing/work/local', [primary, fallback]);

    expect(resolution).toEqual({ kind: 'unsupported-version', version: '0.1.0', message: 'too old' });
  });

  it('awaits async sources', async () => {
    const sources: PackageSource<string>[] = [async () => ({ kind: 'ok', value: 'async-value' })];

    const resolution = await resolveFromSources('/wing/work/local', sources);

    expect(resolution).toEqual({ kind: 'ok', value: 'async-value' });
  });

  it('propagates a source that throws — a real acquisition failure, not "keep looking"', async () => {
    const sources: PackageSource<string>[] = [
      async () => {
        throw new Error('provisioning failed');
      },
    ];

    await expect(resolveFromSources('/wing/work/local', sources)).rejects.toThrow('provisioning failed');
  });

  it('composes with workRepoPackageEntrySource: the repo\'s own install, with a fallback source added on top', async () => {
    const resolvePackage: PackageResolver = () => {
      throw new Error("not installed in the repo");
    };
    const ownSource = workRepoPackageEntrySource({ ...baseOptions, minSupportedMajor: 1, maxSupportedMajor: 2 }, resolvePackage);
    const cabinetFallbackSource: PackageSource<{ version: string; entryUrl: string }> = () => ({
      kind: 'ok',
      value: { version: '1.2.3', entryUrl: 'file:///cabinet/fallback/dist/index.js' },
    });

    const resolution = await resolveFromSources('/wing/work/local', [ownSource, cabinetFallbackSource]);

    expect(resolution).toEqual({ kind: 'ok', value: { version: '1.2.3', entryUrl: 'file:///cabinet/fallback/dist/index.js' } });
  });
});

describe('resolveFromSources type export', () => {
  it('PackageResolution is usable as a standalone type for a custom source', () => {
    const result: PackageResolution<number> = { kind: 'ok', value: 42 };
    expect(result.kind).toBe('ok');
  });
});
