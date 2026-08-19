import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemorySandbox } from '@minions/file-store';
import {
  resetCustomLintInstance,
  createCustomLintProcess,
  loadRuleDataFile,
  resetRuleDataFileCache,
  CUSTOM_LINT_CONFIG_FILENAME,
} from './runCustomLint.js';

describe('runCustomLint', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      resetCustomLintInstance(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  it('reports an instant pass when no custom-rules config exists — nothing for this repo to check', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    const fsDir = (await createInMemorySandbox().root.createDirectory('repo'));

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('nothing to check');
  });

  it('passes when the custom-rules config has no violations', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(0);
  });

  it('fails when a custom rule reports a violation', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    // A trivial inline custom rule: forbid the literal string 'FORBIDDEN'.
    const configContent = `
      const forbidWord = {
        rules: {
          'no-forbidden-word': {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') {
                    context.report({ node, message: 'forbidden word used' });
                  }
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: forbidWord }, rules: { 'local/no-forbidden-word': 'error' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
    writeFileSync(join(dir, 'bad.js'), "const x = 'FORBIDDEN';\n");
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('forbidden word used');
  });

  it('reports a warn-severity violation via warnings, not failures — exit code stays 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    const configContent = `
      const forbidWord = {
        rules: {
          'no-forbidden-word': {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') {
                    context.report({ node, message: 'forbidden word used' });
                  }
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: forbidWord }, rules: { 'local/no-forbidden-word': 'warn' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
    writeFileSync(join(dir, 'bad.js'), "const x = 'FORBIDDEN';\n");
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('forbidden word used');
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.every((w) => w.includes('forbidden word used'))).toBe(true);
  });

  it('reuses the same ESLint instance across repeat calls for the same cwd', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');
    const runProcess = createCustomLintProcess({ dir: fsDir });

    const first = await runProcess(dir, 'lint');
    const second = await runProcess(dir, 'lint');

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
  });

  it('picks up an edit to the config file itself without needing a process restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    const passingConfig = 'export default [{ rules: {} }];\n';
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), passingConfig);
    writeFileSync(join(dir, 'bad.js'), "const x = 'FORBIDDEN';\n");
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, passingConfig);
    const runProcess = createCustomLintProcess({ dir: fsDir });

    const first = await runProcess(dir, 'lint');
    expect(first.exitCode).toBe(0);

    // Someone adds a new custom rule to the config after the watcher already
    // built its ESLint instance for this cwd — the whole point of this test.
    const failingConfig = `
      const forbidWord = {
        rules: {
          'no-forbidden-word': {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') {
                    context.report({ node, message: 'forbidden word used' });
                  }
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: forbidWord }, rules: { 'local/no-forbidden-word': 'error' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), failingConfig);
    const configFile = await fsDir.child(CUSTOM_LINT_CONFIG_FILENAME);
    if (!configFile.found || configFile.node.kind !== 'file') throw new Error('expected config file');
    await configFile.node.write(failingConfig);

    const second = await runProcess(dir, 'lint');

    expect(second.exitCode).toBe(1);
    expect(second.output).toContain('forbidden word used');
  });

  it('calls ensureProjectGraph with the repo cwd before linting', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');
    const ensureProjectGraph = vi.fn(async () => undefined);

    await createCustomLintProcess({ ensureProjectGraph, dir: fsDir })(dir, 'lint');

    expect(ensureProjectGraph).toHaveBeenCalledWith(dir);
  });

  it('keeps reporting onActivity while a slow ensureProjectGraph seed is still pending, not just once linting itself starts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');
    // Simulates the real ensureNxProjectGraphCache seed step: a single
    // opaque, no-progress-of-its-own operation that can legitimately take a
    // while (measured live against this repo's own first-ever run: ~40s).
    const ensureProjectGraph = vi.fn(() => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30)));
    const onActivity = vi.fn();

    await createCustomLintProcess({ ensureProjectGraph, dir: fsDir, seedActivityIntervalMs: 5 })(dir, 'lint', { onActivity });

    // Several ticks from tickWhilePending during the 30ms wait (every 5ms),
    // plus at least one from the actual per-file loop after it resolves.
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('never lets a rule\'s direct process.stdout writes leak to the real console, and drops them on a pass', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    // A rule that writes straight to stdout as a side effect but never
    // reports a violation — simulates @nx/enforce-module-boundaries's "no
    // cached ProjectGraph" notice, which is exactly this shape: a raw
    // process.stdout.write, not a reported lint message.
    const configContent = `
      const noisyRule = {
        rules: {
          noisy: {
            create(context) {
              process.stdout.write('stray warning from a rule\\n');
              return {};
            },
          },
        },
      };
      export default [
        { plugins: { local: noisyRule }, rules: { 'local/noisy': 'warn' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);
    const realWrite = process.stdout.write;
    const writeSpy = vi.fn();
    process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
      writeSpy(...args);
      return true;
    }) as typeof process.stdout.write;

    let result;
    try {
      result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');
    } finally {
      process.stdout.write = realWrite;
    }

    expect(result.exitCode).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('folds a rule\'s stray stdout writes into the failure output, instead of dropping them, when the check fails anyway', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    const configContent = `
      const combo = {
        rules: {
          noisy: {
            create(context) {
              process.stdout.write('stray warning from a rule\\n');
              return {};
            },
          },
          forbid: {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') context.report({ node, message: 'forbidden word used' });
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: combo }, rules: { 'local/noisy': 'warn', 'local/forbid': 'error' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
    writeFileSync(join(dir, 'bad.js'), "const x = 'FORBIDDEN';\n");
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);
    const realWrite = process.stdout.write;
    const writeSpy = vi.fn();
    process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
      writeSpy(...args);
      return true;
    }) as typeof process.stdout.write;

    let result;
    try {
      result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');
    } finally {
      process.stdout.write = realWrite;
    }

    expect(result.exitCode).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result.output).toContain('forbidden word used');
    expect(result.output).toContain('stray warning from a rule');
  });

  it('never forces a failure just because a tiny lockSafetyValveMs is configured — the real result is always awaited', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');

    // lockSafetyValveMs only bounds how long the shared stdio-capture lock
    // waits before freeing itself for the *next* caller — it must never
    // turn into a forced failure for the call that's actually still
    // running, no matter how tiny it's set.
    const result = await createCustomLintProcess({ dir: fsDir, lockSafetyValveMs: 0 })(dir, 'lint');

    expect(result.exitCode).toBe(0);
  });

  it('does not block a later call behind one still holding the stdio lock past its safety valve', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');

    // Fire the first call with a near-zero safety valve so the lock frees
    // itself for the next caller essentially immediately, without waiting
    // for this call's own (fast, but not instant) real completion.
    const first = createCustomLintProcess({ dir: fsDir, lockSafetyValveMs: 0 })(dir, 'lint');
    const second = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(second.exitCode).toBe(0);
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
  });

  it('reports per-file progress via onActivity, once per file actually linted', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
    writeFileSync(join(dir, 'b.js'), 'const b = 1;\n');
    writeFileSync(join(dir, 'c.js'), 'const c = 1;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');
    const onActivity = vi.fn();

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint', { onActivity });

    expect(result.exitCode).toBe(0);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it('aggregates violations across every linted file, not just the first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    const configContent = `
      const forbidWord = {
        rules: {
          'no-forbidden-word': {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') {
                    context.report({ node, message: 'forbidden word used' });
                  }
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: forbidWord }, rules: { 'local/no-forbidden-word': 'error' } },
      ];
      `;
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
    writeFileSync(join(dir, 'first-bad.js'), "const x = 'FORBIDDEN';\n");
    writeFileSync(join(dir, 'clean.js'), 'const y = 1;\n');
    writeFileSync(join(dir, 'second-bad.js'), "const z = 'FORBIDDEN';\n");
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('first-bad.js');
    expect(result.output).toContain('second-bad.js');
  });

  it('does not walk into node_modules while discovering files to lint', async () => {
    dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
    writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), 'export default [{ rules: {} }];\n');
    writeFileSync(join(dir, 'clean.js'), 'const x = 1;\n');
    mkdirSync(join(dir, 'node_modules', 'some-package'), { recursive: true });
    // A syntax error here would fail the whole run if this ever got linted.
    writeFileSync(join(dir, 'node_modules', 'some-package', 'index.js'), 'const x = ;;;\n');
    const fsDir = await createInMemorySandbox().root.createDirectory('repo');
    await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, 'export default [{ rules: {} }];\n');

    const result = await createCustomLintProcess({ dir: fsDir })(dir, 'lint');

    expect(result.exitCode).toBe(0);
  });

  describe('scoped rechecking (changedPaths)', () => {
    const forbidWordConfig = `
      const forbidWord = {
        rules: {
          'no-forbidden-word': {
            create(context) {
              return {
                Literal(node) {
                  if (node.value === 'FORBIDDEN') {
                    context.report({ node, message: 'forbidden word used' });
                  }
                },
              };
            },
          },
        },
      };
      export default [
        { plugins: { local: forbidWord }, rules: { 'local/no-forbidden-word': 'error' } },
      ];
      `;

    it('reuses a cached pass for a file not named in changedPaths, even if that file changed on disk in the meantime', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), forbidWordConfig);
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      writeFileSync(join(dir, 'b.js'), 'const b = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, forbidWordConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      // b.js now has a real violation, but changedPaths only names a.js —
      // its stale cached pass should be reused, not re-verified.
      writeFileSync(join(dir, 'b.js'), "const b = 'FORBIDDEN';\n");
      const second = await runProcess(dir, 'lint', { changedPaths: new Set([join(dir, 'a.js')]) });

      expect(second.exitCode).toBe(0);
    });

    it('relints a file named in changedPaths and picks up a real violation', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), forbidWordConfig);
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      writeFileSync(join(dir, 'b.js'), 'const b = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, forbidWordConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      writeFileSync(join(dir, 'b.js'), "const b = 'FORBIDDEN';\n");
      const second = await runProcess(dir, 'lint', { changedPaths: new Set([join(dir, 'b.js')]) });

      expect(second.exitCode).toBe(1);
      expect(second.output).toContain('forbidden word used');
    });

    it('always relints a file with no cached opinion yet, even when changedPaths omits it', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), forbidWordConfig);
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, forbidWordConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      // A brand-new file appears with a real violation, but changedPaths is
      // empty (not null) — absence from the per-file cache must still force
      // a real check, not be treated as an implicit pass.
      writeFileSync(join(dir, 'c.js'), "const c = 'FORBIDDEN';\n");
      const second = await runProcess(dir, 'lint', { changedPaths: new Set() });

      expect(second.exitCode).toBe(1);
      expect(second.output).toContain('forbidden word used');
    });

    it('clears the whole per-file cache on a .json change, catching a violation from external state a rule reads fresh per file', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      // Mirrors @nx/enforce-module-boundaries: a rule that reads external
      // state (not the file it's linting) fresh on every real invocation,
      // rather than caching it at plugin-import time.
      const externalStateConfig = `
        import { readFileSync } from 'node:fs';
        import { join } from 'node:path';
        const external = {
          rules: {
            'no-forbid-flag': {
              create(context) {
                const flagPath = join(context.cwd, 'external.json');
                const { forbid } = JSON.parse(readFileSync(flagPath, 'utf8'));
                return forbid ? { Program(node) { context.report({ node, message: 'external forbid flag is set' }); } } : {};
              },
            },
          },
        };
        export default [
          { plugins: { local: external }, rules: { 'local/no-forbid-flag': 'error' } },
        ];
        `;
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), externalStateConfig);
      writeFileSync(join(dir, 'external.json'), '{"forbid":false}');
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, externalStateConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      writeFileSync(join(dir, 'external.json'), '{"forbid":true}');
      const second = await runProcess(dir, 'lint', { changedPaths: new Set([join(dir, 'external.json')]) });

      expect(second.exitCode).toBe(1);
      expect(second.output).toContain('external forbid flag is set');
    });

    it('does not clear the per-file cache on a .md change — an unrelated doc edit stays cheap', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      const externalStateConfig = `
        import { readFileSync } from 'node:fs';
        import { join } from 'node:path';
        const external = {
          rules: {
            'no-forbid-flag': {
              create(context) {
                const flagPath = join(context.cwd, 'external.json');
                const { forbid } = JSON.parse(readFileSync(flagPath, 'utf8'));
                return forbid ? { Program(node) { context.report({ node, message: 'external forbid flag is set' }); } } : {};
              },
            },
          },
        };
        export default [
          { plugins: { local: external }, rules: { 'local/no-forbid-flag': 'error' } },
        ];
        `;
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), externalStateConfig);
      writeFileSync(join(dir, 'external.json'), '{"forbid":false}');
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      writeFileSync(join(dir, 'notes.md'), '# notes\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, externalStateConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      // external.json's real truth flips, but only a .md file is reported
      // as changed — the stale cached pass should be reused, not busted.
      writeFileSync(join(dir, 'external.json'), '{"forbid":true}');
      writeFileSync(join(dir, 'notes.md'), '# notes updated\n');
      const second = await runProcess(dir, 'lint', { changedPaths: new Set([join(dir, 'notes.md')]) });

      expect(second.exitCode).toBe(0);
    });

    it('does not error when a previously-linted file has since been deleted', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), forbidWordConfig);
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      writeFileSync(join(dir, 'b.js'), 'const b = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, forbidWordConfig);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      rmSync(join(dir, 'b.js'));
      const second = await runProcess(dir, 'lint', { changedPaths: new Set() });

      expect(second.exitCode).toBe(0);
    });
  });

  describe('loadRuleDataFile', () => {
    let dataFilePath: string | undefined;

    afterEach(() => {
      if (dataFilePath) resetRuleDataFileCache(dataFilePath);
      dataFilePath = undefined;
    });

    it('parses JSON content', () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      dataFilePath = join(dir, 'data.json');
      writeFileSync(dataFilePath, '{"a":1}');

      expect(loadRuleDataFile(dataFilePath)).toEqual({ a: 1 });
    });

    it('returns raw text for non-JSON content', () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      dataFilePath = join(dir, 'data.txt');
      writeFileSync(dataFilePath, 'hello world');

      expect(loadRuleDataFile(dataFilePath)).toBe('hello world');
    });

    it('re-reads the file once its mtime changes, with no cache to explicitly clear', () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      dataFilePath = join(dir, 'data.json');
      writeFileSync(dataFilePath, '{"v":1}');
      expect(loadRuleDataFile(dataFilePath)).toEqual({ v: 1 });

      writeFileSync(dataFilePath, '{"v":2}');
      // Force a real mtime bump — two writeFileSync calls in quick
      // succession can otherwise land in the same filesystem-mtime tick.
      const future = new Date(Date.now() + 60_000);
      utimesSync(dataFilePath, future, future);

      expect(loadRuleDataFile(dataFilePath)).toEqual({ v: 2 });
    });
  });

  describe('the qualityWatcher settings injection (context.settings.qualityWatcher.loadDataFile)', () => {
    it('lets a custom rule read live external state without caching it at module-import time, and without needing a restart', async () => {
      dir = mkdtempSync(join(tmpdir(), 'custom-lint-'));
      // Mirrors eolus-nabu's own pattern, but reading via the injected
      // loader inside create() instead of a module-level const — the whole
      // point being this needs no dependency on @minions/quality-watcher at
      // all, since it's supplied at runtime via ESLint's own settings API.
      const configContent = `
        const rule = {
          rules: {
            'check-flag': {
              create(context) {
                return {
                  Program(node) {
                    const flagPath = context.cwd + '/flag.json';
                    const data = context.settings.qualityWatcher.loadDataFile(flagPath);
                    if (data.forbid) context.report({ node, message: 'flag is set' });
                  },
                };
              },
            },
          },
        };
        export default [
          { plugins: { local: rule }, rules: { 'local/check-flag': 'error' } },
        ];
        `;
      writeFileSync(join(dir, CUSTOM_LINT_CONFIG_FILENAME), configContent);
      writeFileSync(join(dir, 'flag.json'), '{"forbid":false}');
      writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
      const fsDir = await createInMemorySandbox().root.createDirectory('repo');
      await fsDir.createFile(CUSTOM_LINT_CONFIG_FILENAME, configContent);
      const runProcess = createCustomLintProcess({ dir: fsDir });

      const first = await runProcess(dir, 'lint', { changedPaths: null });
      expect(first.exitCode).toBe(0);

      // Flip the flag but name only a.js — NOT flag.json — in changedPaths,
      // so the .json-triggers-cache-bust mechanism plays no role here. If
      // this still catches the flip, it's purely because loadDataFile reads
      // fresh inside create() every time a.js is genuinely re-verified.
      writeFileSync(join(dir, 'flag.json'), '{"forbid":true}');
      const second = await runProcess(dir, 'lint', { changedPaths: new Set([join(dir, 'a.js')]) });

      expect(second.exitCode).toBe(1);
      expect(second.output).toContain('flag is set');
    });
  });
});
