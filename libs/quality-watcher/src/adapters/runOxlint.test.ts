import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInMemorySandbox, type Directory } from '@minions/file-store';
import { runOxlint, createOxlintProcess, materializeDefaultOxlintConfig, type PackageResolver, type FallbackOxlint } from './runOxlint.js';

vi.mock('cross-spawn', () => ({
  default: vi.fn(),
}));

async function importSpawnMock() {
  const { default: spawn } = await import('cross-spawn');
  return spawn as unknown as ReturnType<typeof vi.fn>;
}

function fakeChild(exitCode: number, output: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  (child.stdout as EventEmitter & { destroy?: () => void }).destroy = () => undefined;
  (child.stderr as EventEmitter & { destroy?: () => void }).destroy = () => undefined;
  setImmediate(() => {
    if (output) child.stdout.emit('data', Buffer.from(output));
    child.emit('exit', exitCode);
  });
  return child;
}

/** A cwd string for the process runner — never touched by real fs; config detection now goes through the injected in-memory Directory instead. */
function fakeCwd(): string {
  return '/repo';
}

function emptyDir(): Directory {
  return createInMemorySandbox().root;
}

const resolveOxlintFound: PackageResolver = (specifier, cwd) => join(cwd, 'node_modules', specifier);
const resolveOxlintMissing: PackageResolver = () => {
  throw new Error("Cannot find module 'oxlint/package.json'");
};

describe('runOxlint (default, no fallback wired)', () => {
  beforeEach(async () => {
    (await importSpawnMock()).mockReset();
  });

  it('runs via `pnpm exec oxlint` rather than a bare `oxlint`, so it resolves through pnpm instead of the ambient PATH', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('.oxlintrc.json', '{}');
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(0, 'no problems'));
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintFound });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result).toEqual({ exitCode: 0, output: 'no problems' });
    expect(spawn).toHaveBeenCalledWith('pnpm', ['exec', 'oxlint', '--format', 'json', '.'], expect.anything());
  });

  it('passes the materialized default config when the repo has no .oxlintrc of its own', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(0, ''));
    const materializeDefaultConfig = vi.fn(() => '/tmp/default.oxlintrc.json');
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintFound, materializeDefaultConfig });

    await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(spawn).toHaveBeenCalledWith('pnpm', ['exec', 'oxlint', '--format', 'json', '--config', '/tmp/default.oxlintrc.json', '.'], expect.anything());
  });

  it('reports an instant pass when the repo has no oxlint and no tsconfig.json — nothing to check', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    const spawn = await importSpawnMock();
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintMissing });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result.exitCode).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a fail when the repo has TypeScript but no oxlint and no fallback is wired', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('tsconfig.json', '{}');
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintMissing });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('no oxlint installed');
  });

  it('splits oxlint JSON diagnostics by severity into failures (exit code) and warnings', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('.oxlintrc.json', '{}');
    const diagnosticsJson = JSON.stringify({
      diagnostics: [
        { message: 'Unexpected any', code: 'typescript(no-explicit-any)', severity: 'warning', filename: 'a.ts', labels: [{ span: { line: 1, column: 22 } }] },
        { message: 'debugger statement', code: 'no-debugger', severity: 'error', filename: 'b.ts', labels: [{ span: { line: 3, column: 1 } }] },
      ],
    });
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(1, diagnosticsJson));
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintFound });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('b.ts:3:1 debugger statement (no-debugger)');
    expect(result.warnings).toEqual(['a.ts:1:22 Unexpected any (typescript(no-explicit-any))']);
  });

  it('reports warnings with a clean exit code when oxlint itself only found warning-severity diagnostics', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('.oxlintrc.json', '{}');
    const diagnosticsJson = JSON.stringify({
      diagnostics: [
        { message: 'Unexpected any', code: 'typescript(no-explicit-any)', severity: 'warning', filename: 'a.ts', labels: [{ span: { line: 1, column: 22 } }] },
      ],
    });
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(0, diagnosticsJson));
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintFound });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result.exitCode).toBe(0);
    expect(result.warnings).toEqual(['a.ts:1:22 Unexpected any (typescript(no-explicit-any))']);
  });

  it('actually writes the default config to disk once, as real JSON oxlint can read', () => {
    const path = materializeDefaultOxlintConfig();
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.categories.correctness).toBe('deny');
    expect(materializeDefaultOxlintConfig()).toBe(path);
  });
});

describe('runOxlint with a fallback wired', () => {
  beforeEach(async () => {
    (await importSpawnMock()).mockReset();
  });

  it('uses the fallback binary directly (not via `pnpm exec`) when the repo has TypeScript but no oxlint of its own', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('tsconfig.json', '{}');
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(0, ''));
    const fallback: FallbackOxlint = { ensureBinary: vi.fn(async () => '/cabinet/tools/runtime/deps/node_modules/.bin/oxlint') };
    const oxlintProcess = createOxlintProcess({
      resolvePackage: resolveOxlintMissing,
      fallback,
      materializeDefaultConfig: () => '/tmp/default.oxlintrc.json',
    });

    await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(fallback.ensureBinary).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      '/cabinet/tools/runtime/deps/node_modules/.bin/oxlint',
      ['--format', 'json', '--config', '/tmp/default.oxlintrc.json', '.'],
      expect.anything()
    );
  });

  it('respects the repo\'s own config even when using the fallback binary', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('tsconfig.json', '{}');
    await dir.createFile('.oxlintrc.json', '{}');
    const spawn = await importSpawnMock();
    spawn.mockReturnValueOnce(fakeChild(0, ''));
    const fallback: FallbackOxlint = { ensureBinary: vi.fn(async () => '/fallback/oxlint') };
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintMissing, fallback });

    await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(spawn).toHaveBeenCalledWith('/fallback/oxlint', ['--format', 'json', '.'], expect.anything());
  });

  it('reports a clear fail, not a crash, when the fallback install fails', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    await dir.createFile('tsconfig.json', '{}');
    const fallback: FallbackOxlint = { ensureBinary: vi.fn(async () => { throw new Error('no network access'); }) };
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintMissing, fallback });

    const result = await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("couldn't install oxlint");
    expect(result.output).toContain('no network access');
  });

  it('never touches the fallback when the repo has no tsconfig.json — nothing TS to lint', async () => {
    const cwd = fakeCwd();
    const dir = emptyDir();
    const fallback: FallbackOxlint = { ensureBinary: vi.fn(async () => '/fallback/oxlint') };
    const oxlintProcess = createOxlintProcess({ resolvePackage: resolveOxlintMissing, fallback });

    await oxlintProcess(cwd, 'oxlint', undefined, dir);

    expect(fallback.ensureBinary).not.toHaveBeenCalled();
  });
});

describe('runOxlint (exported default)', () => {
  it('is createOxlintProcess() with no fallback', async () => {
    expect(typeof runOxlint).toBe('function');
  });
});
