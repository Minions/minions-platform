import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { createInMemorySandbox, type Directory } from '@minions/file-store';
import { createFallbackOxlint, type Spawner, type SpawnResult } from './ensureFallbackOxlint.js';

const LAIR_ROOT = '/lair';
const BINARY_NAME = process.platform === 'win32' ? 'oxlint.CMD' : 'oxlint';
const EXPECTED_BINARY_PATH = join(LAIR_ROOT, 'tools', 'runtime', 'deps', 'node_modules', '.bin', BINARY_NAME);

function tempLairRoot(): Directory {
  return createInMemorySandbox().root;
}

const BINARY_RELATIVE_PATH = `tools/runtime/deps/node_modules/.bin/${BINARY_NAME}`;
const PACKAGE_JSON_RELATIVE_PATH = 'tools/runtime/deps/package.json';

async function binaryExists(dir: Directory): Promise<boolean> {
  return (await dir.child(BINARY_RELATIVE_PATH)).found;
}

async function writeBinary(dir: Directory, content: string): Promise<void> {
  await dir.createFile(BINARY_RELATIVE_PATH, content);
}

async function readPackageJson(dir: Directory): Promise<{ dependencies: Record<string, string>; packageManager: string }> {
  const result = await dir.child(PACKAGE_JSON_RELATIVE_PATH);
  if (!result.found || result.node.kind !== 'file') {
    throw new Error('package.json not found');
  }
  return JSON.parse(await result.node.read());
}

/** Simulates a real environment: pnpm is on PATH, and `pnpm install` succeeds and drops the binary in place. */
function happyPathSpawner(dir: Directory): { spawner: Spawner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawner: Spawner = async (command, args): Promise<SpawnResult> => {
    calls.push({ command, args });
    if (command === 'pnpm' && args[0] === '--version') return { exitCode: 0, output: '11.1.3' };
    if (command === 'pnpm' && args.includes('install')) {
      await writeBinary(dir, '#!/bin/sh\necho fake-oxlint');
      return { exitCode: 0, output: 'installed' };
    }
    throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`);
  };
  return { spawner, calls };
}

describe('createFallbackOxlint', () => {
  it('returns the binary path immediately, without spawning anything, if it already exists', async () => {
    const dir = tempLairRoot();
    await writeBinary(dir, 'already here');
    const spawner: Spawner = vi.fn();

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);
    const result = await fallback.ensureBinary();

    expect(result).toBe(EXPECTED_BINARY_PATH);
    expect(spawner).not.toHaveBeenCalled();
  });

  it('writes a deps package.json pinning oxlint and the workspace pnpm version, then installs via pnpm', async () => {
    const dir = tempLairRoot();
    const { spawner, calls } = happyPathSpawner(dir);

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);
    const result = await fallback.ensureBinary();

    expect(result).toBe(EXPECTED_BINARY_PATH);
    expect(await binaryExists(dir)).toBe(true);
    const pkgJson = await readPackageJson(dir);
    expect(pkgJson.dependencies.oxlint).toBeTruthy();
    expect(pkgJson.packageManager).toContain('pnpm@');
    expect(calls.map((c) => c.command)).toEqual(['pnpm', 'pnpm']);
  });

  it('bootstraps pnpm via corepack when pnpm is not on PATH', async () => {
    const dir = tempLairRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawner: Spawner = async (command, args) => {
      calls.push({ command, args });
      if (command === 'pnpm' && args[0] === '--version') return { exitCode: 1, output: 'command not found' };
      if (command === 'corepack' && args[0] === 'enable') return { exitCode: 0, output: '' };
      if (command === 'corepack' && args[0] === 'pnpm') {
        await writeBinary(dir, 'fake');
        return { exitCode: 0, output: 'installed via corepack' };
      }
      throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`);
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);
    const result = await fallback.ensureBinary();

    expect(result).toBe(EXPECTED_BINARY_PATH);
    expect(calls).toEqual([
      { command: 'pnpm', args: ['--version'] },
      { command: 'corepack', args: ['enable'] },
      { command: 'corepack', args: ['pnpm', 'install', '--prod'] },
    ]);
  });

  it('throws a clear error when pnpm is missing and corepack cannot enable it', async () => {
    const dir = tempLairRoot();
    const spawner: Spawner = async (command) => {
      if (command === 'pnpm') return { exitCode: 1, output: 'not found' };
      if (command === 'corepack') return { exitCode: 1, output: 'corepack is disabled by policy' };
      throw new Error('unexpected');
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);

    await expect(fallback.ensureBinary()).rejects.toThrow(/Corepack couldn't enable it/);
  });

  it('throws a clear error when pnpm install reports failure', async () => {
    const dir = tempLairRoot();
    const spawner: Spawner = async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, output: '11.1.3' };
      return { exitCode: 1, output: 'ERR_PNPM_FETCH_404' };
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);

    await expect(fallback.ensureBinary()).rejects.toThrow(/pnpm install failed/);
  });

  it('throws a clear error when install "succeeds" but the binary still is not there', async () => {
    const dir = tempLairRoot();
    const spawner: Spawner = async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, output: '11.1.3' };
      return { exitCode: 0, output: 'installed, but no oxlint binary for this platform' };
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);

    await expect(fallback.ensureBinary()).rejects.toThrow(/binary wasn't found/);
  });

  it('shares one in-flight install across concurrent callers', async () => {
    const dir = tempLairRoot();
    let installCount = 0;
    const spawner: Spawner = async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, output: '11.1.3' };
      installCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeBinary(dir, 'fake');
      return { exitCode: 0, output: 'installed' };
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);
    const [a, b, c] = await Promise.all([fallback.ensureBinary(), fallback.ensureBinary(), fallback.ensureBinary()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(installCount).toBe(1);
  });

  it('lets a later call retry after a failed install, instead of caching the failure forever', async () => {
    const dir = tempLairRoot();
    let attempt = 0;
    const spawner: Spawner = async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, output: '11.1.3' };
      attempt += 1;
      if (attempt === 1) return { exitCode: 1, output: 'transient network error' };
      await writeBinary(dir, 'fake');
      return { exitCode: 0, output: 'installed' };
    };

    const fallback = createFallbackOxlint(LAIR_ROOT, spawner, dir);

    await expect(fallback.ensureBinary()).rejects.toThrow(/pnpm install failed/);
    const result = await fallback.ensureBinary();
    expect(result).toBe(EXPECTED_BINARY_PATH);
  });
});
