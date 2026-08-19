import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_LOG_HOOK_SCRIPT, TOOL_LOG_HOOK_SCRIPT_NAME } from './hook-script.js';

/**
 * Creates a minimal fake lair in tmpDir, installs the hook script, and returns
 * a helper that runs the hook for a given wing name.
 */
function setupFakeLair(tmpDir: string): {
  scriptPath: string;
  run: (stdinPayload: object, wingName: string) => SpawnSyncReturns<string>;
  logPath: (wingName: string) => string;
} {
  const toolsDir = join(tmpDir, 'tools');
  mkdirSync(toolsDir, { recursive: true });
  const scriptPath = join(toolsDir, TOOL_LOG_HOOK_SCRIPT_NAME);
  writeFileSync(scriptPath, TOOL_LOG_HOOK_SCRIPT, 'utf-8');

  const run = (stdinPayload: object, wingName: string) =>
    spawnSync('node', [scriptPath, wingName], {
      input: JSON.stringify(stdinPayload),
      encoding: 'utf8',
      env: { ...process.env, LAIR_ROOT: tmpDir },
    });

  const logPath = (wingName: string) =>
    join(tmpDir, 'wings', wingName, 'private', 'untracked', 'tool-log.jsonl');

  return { scriptPath, run, logPath };
}

describe('log-tool-use hook', () => {
  let tmpDir: string;
  let run: ReturnType<typeof setupFakeLair>['run'];
  let logPath: ReturnType<typeof setupFakeLair>['logPath'];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hook-test-'));
    ({ run, logPath } = setupFakeLair(tmpDir));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('wing name argument', () => {
    it('exits 1 with clear message when no wing name is given', () => {
      const result = spawnSync('node', [join(tmpDir, 'tools', TOOL_LOG_HOOK_SCRIPT_NAME)], {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }),
        encoding: 'utf8',
        env: { ...process.env, LAIR_ROOT: tmpDir },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('[log-tool-use] ERROR');
      expect(result.stderr).toContain('wing name required');
    });

    it('routes log to the named wing directory', () => {
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'my-wing');
      expect(existsSync(logPath('my-wing'))).toBe(true);
    });
  });

  describe('stdin handling', () => {
    it('exits cleanly with invalid JSON input', () => {
      const result = spawnSync(
        'node',
        [join(tmpDir, 'tools', TOOL_LOG_HOOK_SCRIPT_NAME), 'my-wing'],
        { input: 'not-json', encoding: 'utf8', env: { ...process.env, LAIR_ROOT: tmpDir } },
      );
      expect(result.status).toBe(0);
    });

    it('exits cleanly when tool_name is missing', () => {
      const result = run({ tool_input: {} }, 'my-wing');
      expect(result.status).toBe(0);
    });
  });

  describe('tool logging', () => {
    it('creates the log file on first run', () => {
      run({ tool_name: 'Read', tool_input: {} }, 'my-wing');
      expect(existsSync(logPath('my-wing'))).toBe(true);
    });

    it('logs Edit tool with file_path', () => {
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/foo.ts', old_string: 'x', new_string: 'y' } }, 'my-wing');

      const log = readFileSync(logPath('my-wing'), 'utf8');
      const entry = JSON.parse(log.trim());
      expect(entry.tool).toBe('Edit');
      expect(entry.filePath).toBe('src/foo.ts');
      expect(entry.timestamp).toBeTypeOf('number');
      expect(entry).not.toHaveProperty('old_string');
      expect(entry).not.toHaveProperty('new_string');
    });

    it('logs Write tool with file_path', () => {
      run({ tool_name: 'Write', tool_input: { file_path: 'src/new.ts', content: 'big content' } }, 'my-wing');

      const entry = JSON.parse(readFileSync(logPath('my-wing'), 'utf8').trim());
      expect(entry.tool).toBe('Write');
      expect(entry.filePath).toBe('src/new.ts');
      expect(entry).not.toHaveProperty('content');
    });

    it('logs Bash tool with command (truncated at 500 chars)', () => {
      run({ tool_name: 'Bash', tool_input: { command: 'a'.repeat(600) } }, 'my-wing');

      const entry = JSON.parse(readFileSync(logPath('my-wing'), 'utf8').trim());
      expect(entry.tool).toBe('Bash');
      expect(entry.command).toHaveLength(500);
    });

    it('logs MCP plan tool with mcpAction', () => {
      run({ tool_name: 'mcp__cabinet__plan', tool_input: { action: 'delete-subtree', itemId: 'ps_0013' } }, 'my-wing');

      const entry = JSON.parse(readFileSync(logPath('my-wing'), 'utf8').trim());
      expect(entry.tool).toBe('mcp__cabinet__plan');
      expect(entry.mcpAction).toBe('delete-subtree');
    });

    it('logs read-only tools with just tool name and timestamp', () => {
      run({ tool_name: 'Read', tool_input: { file_path: 'src/foo.ts' } }, 'my-wing');

      const entry = JSON.parse(readFileSync(logPath('my-wing'), 'utf8').trim());
      expect(entry.tool).toBe('Read');
      expect(entry.timestamp).toBeTypeOf('number');
      expect(entry).not.toHaveProperty('filePath');
    });

    it('appends multiple entries as separate JSON lines', () => {
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'my-wing');
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } }, 'my-wing');

      const lines = readFileSync(logPath('my-wing'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).filePath).toBe('src/a.ts');
      expect(JSON.parse(lines[1]).filePath).toBe('src/b.ts');
    });

    it('isolates logs by wing name', () => {
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'wing-a');
      run({ tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } }, 'wing-b');

      const aEntry = JSON.parse(readFileSync(logPath('wing-a'), 'utf8').trim());
      const bEntry = JSON.parse(readFileSync(logPath('wing-b'), 'utf8').trim());
      expect(aEntry.filePath).toBe('src/a.ts');
      expect(bEntry.filePath).toBe('src/b.ts');
    });
  });
});
