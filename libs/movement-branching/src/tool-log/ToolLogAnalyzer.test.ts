import { describe, it, expect } from 'vitest';
import { ToolLogAnalyzer } from './ToolLogAnalyzer.js';
import type { ToolLogEntry } from './ToolLogEntry.js';

function entry(overrides: Partial<ToolLogEntry> & { tool: string }): ToolLogEntry {
  return { timestamp: Date.now(), ...overrides };
}

function editEntry(filePath: string, tsOffset = 0): ToolLogEntry {
  return { timestamp: Date.now() + tsOffset, tool: 'Edit', filePath };
}

function bashEntry(command: string, tsOffset = 0): ToolLogEntry {
  return { timestamp: Date.now() + tsOffset, tool: 'Bash', command };
}

function planEntry(mcpAction: string): ToolLogEntry {
  return { timestamp: Date.now(), tool: 'mcp__cabinet__plan', mcpAction };
}

describe('ToolLogAnalyzer', () => {
  describe('skeleton — empty / read-only log', () => {
    it('returns not_classified intention for empty log', () => {
      const result = new ToolLogAnalyzer([]).analyze();
      expect(result.intention).toBe('not_classified');
    });

    it('returns not_classified risk for empty log', () => {
      const result = new ToolLogAnalyzer([]).analyze();
      expect(result.risk).toBe('not_classified');
    });

    it('returns not_classified for read-only tools only', () => {
      const entries = [
        entry({ tool: 'Read', filePath: 'src/foo.ts' }),
        entry({ tool: 'Glob' }),
        entry({ tool: 'Grep' }),
        entry({ tool: 'WebSearch' }),
      ];
      const result = new ToolLogAnalyzer(entries).analyze();
      expect(result.intention).toBe('not_classified');
      expect(result.risk).toBe('not_classified');
    });
  });

  describe('plan intention rule', () => {
    it('classifies plan tool usage (no file edits) as plan intention', () => {
      const result = new ToolLogAnalyzer([planEntry('delete-subtree')]).analyze();
      expect(result.intention).toBe('plan');
    });

    it('classifies multiple plan actions as plan intention', () => {
      const result = new ToolLogAnalyzer([
        planEntry('list-roots'),
        planEntry('delete-subtree'),
      ]).analyze();
      expect(result.intention).toBe('plan');
    });

    it('plan + code file edits = code intention (code dominates)', () => {
      const result = new ToolLogAnalyzer([
        planEntry('delete-subtree'),
        editEntry('src/foo.ts'),
      ]).analyze();
      expect(result.intention).toBe('code');
    });

    it('plan + doc edits = docs intention', () => {
      const result = new ToolLogAnalyzer([
        planEntry('delete-subtree'),
        editEntry('docs/guide.md'),
      ]).analyze();
      expect(result.intention).toBe('docs');
    });

    it('plan + test file edits = test intention', () => {
      const result = new ToolLogAnalyzer([
        planEntry('delete-subtree'),
        editEntry('src/foo.test.ts'),
      ]).analyze();
      expect(result.intention).toBe('test');
    });
  });

  describe('test-only intention rule', () => {
    it('classifies test-file-only edits as test intention', () => {
      const result = new ToolLogAnalyzer([editEntry('src/foo.test.ts')]).analyze();
      expect(result.intention).toBe('test');
    });

    it('classifies spec file edits as test intention', () => {
      const result = new ToolLogAnalyzer([editEntry('src/foo.spec.ts')]).analyze();
      expect(result.intention).toBe('test');
    });

    it('test files + read-only tools still = test intention', () => {
      const result = new ToolLogAnalyzer([
        entry({ tool: 'Read', filePath: 'src/foo.ts' }),
        editEntry('src/foo.test.ts'),
      ]).analyze();
      expect(result.intention).toBe('test');
    });

    it('test + code files = code intention (code has test edits → not refactor)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/foo.test.ts'),
        editEntry('src/foo.ts'),
      ]).analyze();
      expect(result.intention).toBe('code');
    });
  });

  describe('docs-only intention rule', () => {
    it('classifies docs-file-only edits as docs intention', () => {
      const result = new ToolLogAnalyzer([editEntry('README.md')]).analyze();
      expect(result.intention).toBe('docs');
    });

    it('docs + test files = docs intention (test is subsumed)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('README.md'),
        editEntry('src/foo.test.ts'),
      ]).analyze();
      expect(result.intention).toBe('docs');
    });

    it('docs + code files = code intention (code dominates)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('README.md'),
        editEntry('src/foo.ts'),
      ]).analyze();
      expect(result.intention).toBe('code');
    });
  });

  describe('chore-only intention rule', () => {
    it('classifies config-file-only edits as chore intention', () => {
      const result = new ToolLogAnalyzer([editEntry('package.json')]).analyze();
      expect(result.intention).toBe('chore');
    });

    it('config + test files = chore intention (test is subsumed)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('tsconfig.json'),
        editEntry('src/setup.test.ts'),
      ]).analyze();
      expect(result.intention).toBe('chore');
    });

    it('config + code files = code intention (code dominates)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('package.json'),
        editEntry('src/app.ts'),
      ]).analyze();
      expect(result.intention).toBe('code');
    });
  });

  describe('code file edits — intention', () => {
    it('code only, no test run = code intention (no signal to distinguish)', () => {
      const result = new ToolLogAnalyzer([editEntry('src/app.ts')]).analyze();
      expect(result.intention).toBe('code');
    });

    it('code + test run but no test file edits = refactor (ran existing tests)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('pnpm test', 100),
      ]).analyze();
      expect(result.intention).toBe('refactor');
    });

    it('code + test file edits = code (test changes → not refactor)', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        editEntry('src/app.test.ts', 50),
      ]).analyze();
      expect(result.intention).toBe('code');
    });
  });

  describe('plan file intention rule', () => {
    it('editing a plan directory markdown = plan intention', () => {
      const result = new ToolLogAnalyzer([editEntry('plan/sprint-1.md')]).analyze();
      expect(result.intention).toBe('plan');
    });

    it('plans/ directory markdown = plan intention', () => {
      const result = new ToolLogAnalyzer([editEntry('work/local/plans/q1.md')]).analyze();
      expect(result.intention).toBe('plan');
    });
  });

  describe('risk: no test command', () => {
    it('code file edits with no bash test command = risky', () => {
      const result = new ToolLogAnalyzer([editEntry('src/app.ts')]).analyze();
      expect(result.risk).toBe('@');
    });

    it('docs-only edits = provable risk', () => {
      const result = new ToolLogAnalyzer([editEntry('README.md')]).analyze();
      expect(result.risk).toBe('.');
    });

    it('test-only edits = thorough risk', () => {
      const result = new ToolLogAnalyzer([editEntry('src/app.test.ts')]).analyze();
      expect(result.risk).toBe('^');
    });
  });

  describe('risk: test command detection', () => {
    it('pnpm test + code edits before it = covered risk', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('pnpm test', 100),
      ]).analyze();
      expect(result.risk).toBe('!');
    });

    it('npm test + code edits before it = covered risk', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('npm test', 100),
      ]).analyze();
      expect(result.risk).toBe('!');
    });

    it('vitest run + code edits before it = covered risk', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('pnpm --filter @foo/bar vitest run', 100),
      ]).analyze();
      expect(result.risk).toBe('!');
    });

    it('jest + code edits before it = covered risk', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('npx jest', 100),
      ]).analyze();
      expect(result.risk).toBe('!');
    });
  });

  describe('risk: LOC-based upgrade', () => {
    it('small code change (<9 LOC) with test edits and test run = thorough', () => {
      const result = new ToolLogAnalyzer([
        { timestamp: 1000, tool: 'Edit', filePath: 'src/app.ts', linesChanged: 5 },
        { timestamp: 1500, tool: 'Edit', filePath: 'src/app.test.ts', linesChanged: 3 },
        { timestamp: 2000, tool: 'Bash', command: 'pnpm test' },
      ]).analyze();
      expect(result.risk).toBe('^');
    });

    it('large code change (>=9 LOC) with test edits = covered, not thorough', () => {
      const result = new ToolLogAnalyzer([
        { timestamp: 1000, tool: 'Edit', filePath: 'src/app.ts', linesChanged: 15 },
        { timestamp: 1500, tool: 'Edit', filePath: 'src/app.test.ts', linesChanged: 10 },
        { timestamp: 2000, tool: 'Bash', command: 'pnpm test' },
      ]).analyze();
      expect(result.risk).toBe('!');
    });

    it('small code change without test edits = covered (LOC rule requires test edits)', () => {
      const result = new ToolLogAnalyzer([
        { timestamp: 1000, tool: 'Edit', filePath: 'src/app.ts', linesChanged: 3 },
        { timestamp: 2000, tool: 'Bash', command: 'pnpm test' },
      ]).analyze();
      expect(result.risk).toBe('!');
    });
  });

  describe('risk: code edited after last test run', () => {
    it('code edit after last test run = risky', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('pnpm test', 100),
        editEntry('src/app.ts', 200),  // edit AFTER test
      ]).analyze();
      expect(result.risk).toBe('@');
    });

    it('code edit before test run = covered', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        editEntry('src/other.ts', 50),
        bashEntry('pnpm test', 200),   // test AFTER all edits
      ]).analyze();
      expect(result.risk).toBe('!');
    });

    it('multiple test runs — only last matters', () => {
      const result = new ToolLogAnalyzer([
        editEntry('src/app.ts', 0),
        bashEntry('pnpm test', 100),
        editEntry('src/app.ts', 200),  // edit after first test
        bashEntry('pnpm test', 300),   // second test covers it
      ]).analyze();
      expect(result.risk).toBe('!');
    });
  });
});
