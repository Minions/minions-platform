import { describe, it, expect } from 'vitest';
import { parseTscWatchOutput } from './parseTscWatchOutput.js';

describe('parseTscWatchOutput', () => {
  it('returns null when no cycle-end line has appeared yet', () => {
    expect(parseTscWatchOutput('Starting compilation in watch mode...\n')).toBeNull();
  });

  it('parses a clean cycle as pass', () => {
    const result = parseTscWatchOutput(
      '[10:00:00] Starting compilation in watch mode...\n\n[10:00:01] Found 0 errors. Watching for file changes.\n'
    );

    expect(result).not.toBeNull();
    expect(result?.state.state).toBe('pass');
  });

  it('parses a failing cycle with the diagnostic text as failures', () => {
    const result = parseTscWatchOutput(
      [
        '[10:00:00] File change detected. Starting incremental compilation...',
        '',
        "src/foo.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        '',
        '[10:00:01] Found 1 error. Watching for file changes.',
        '',
      ].join('\n')
    );

    expect(result?.state.state).toBe('fail');
    if (result?.state.state === 'fail') {
      expect(result.state.failures).toEqual([
        "src/foo.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ]);
    }
  });

  it('reports how much of the buffer was consumed so callers can slice it off', () => {
    const buffer = 'Found 0 errors. Watching for file changes.\nleftover next-cycle output';
    const result = parseTscWatchOutput(buffer);

    expect(result?.consumedThrough).toBe('Found 0 errors. Watching for file changes.'.length);
    expect(buffer.slice(result?.consumedThrough ?? 0)).toBe('\nleftover next-cycle output');
  });

  it('excludes the compilation-start banner lines from the failure list', () => {
    const result = parseTscWatchOutput(
      [
        'Starting compilation in watch mode...',
        'src/bar.ts(1,1): error TS1005: expected.',
        'Found 1 error. Watching for file changes.',
      ].join('\n')
    );

    if (result?.state.state === 'fail') {
      expect(result.state.failures).toEqual(['src/bar.ts(1,1): error TS1005: expected.']);
    }
  });

  it('excludes the real vue-tsc --pretty false banner (ANSI clear-screen codes + a plain, unbracketed timestamp) from the failure list', () => {
    // Captured live against the installed vue-tsc@2.2.12 — this banner
    // shape (ESC clear-screen sequence directly followed by "8:01:02 PM - ",
    // no brackets) is NOT what the original bracketed-timestamp fixtures
    // above assumed, and used to leak into the failures list as a bogus
    // "finding".
    const esc = String.fromCharCode(27);
    const banner = `${esc}[2J${esc}[3J${esc}[H8:01:02 PM - File change detected. Starting incremental compilation...`;
    const result = parseTscWatchOutput(
      [
        banner,
        '',
        "src/__perf_check__.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        '',
        'Found 1 error. Watching for file changes.',
      ].join('\n')
    );

    expect(result?.state.state).toBe('fail');
    if (result?.state.state === 'fail') {
      expect(result.state.failures).toEqual([
        "src/__perf_check__.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      ]);
    }
  });
});
