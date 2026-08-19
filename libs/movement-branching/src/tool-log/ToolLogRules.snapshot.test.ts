/**
 * Snapshot tests for the tool-log rule system.
 *
 * Each test renders a readable table of the current classification behavior.
 * The snapshots capture current behavior — review the output, correct what's wrong,
 * then update the implementation to match.
 *
 * Run with: pnpm --filter @minions/movement-branching exec vitest run ToolLogRules.snapshot
 * Update:   pnpm --filter @minions/movement-branching exec vitest run ToolLogRules.snapshot -u
 */

import { describe, it, expect } from 'vitest';
import { ChangeAnalyzer } from '../risk/ChangeAnalyzer.js';
import { ToolLogAnalyzer, type IntentionClassification } from './ToolLogAnalyzer.js';
import { mergeIntentions } from './IntentionMerger.js';
import { IntentionCode } from '../tools/GitCommit.js';
import type { ToolLogEntry } from './ToolLogEntry.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function col(value: string, width: number): string {
  return value.padEnd(width);
}

function row(...cells: string[]): string {
  return cells.join(' │ ');
}

function divider(widths: number[]): string {
  return widths.map(w => '─'.repeat(w)).join('─┼─');
}

// ─── 1. File classification ───────────────────────────────────────────────────

describe('Rule snapshots: file classification', () => {
  it('classifies file paths by type', () => {
    const analyzer = new ChangeAnalyzer();

    const cases: Array<[string, string]> = [
      // Source code
      ['src/foo.ts',                       'TypeScript source'],
      ['src/utils/helper.ts',              'nested source'],
      ['apps/cabinet/src/server.ts',       'app source'],
      ['libs/file-store/src/index.ts',     'lib source'],

      // Test files
      ['src/foo.test.ts',                  'vitest test'],
      ['src/foo.spec.ts',                  'jest-style spec'],
      ['__tests__/foo.ts',                 '__tests__ directory'],
      ['src/__tests__/bar.ts',             '__tests__ nested'],
      ['test_foo.ts',                      'test_ prefix'],

      // Documentation — clear cases
      ['README.md',                        'root README'],
      ['docs/guide.md',                    'docs directory'],
      ['docs/api/reference.md',            'docs subdirectory'],
      ['CHANGELOG.md',                     'changelog'],
      ['src/foo.txt',                      '.txt file'],

      // Workflow files — agent instructions that behave like code
      ['CLAUDE.md',                        'root CLAUDE.md (workflow)'],
      ['.claude/CLAUDE.md',               '.claude/ CLAUDE.md (workflow)'],
      ['work/local/CLAUDE.md',            'wing work CLAUDE.md (workflow)'],
      ['any/workflow/foo/bar.md',         'workflow instructions (workflow)'],
      ['any/dev-process/foo/bar.md',      'workflow instructions (workflow)'],
      ['.claude/foo/bar.md',              'workflow instructions (workflow)'],

      // Documentation — ambiguous cases (user should review these)
      ['info/overview.md',                'info dir .md'],
      ['plan/sprint-1.md',               'plan directory .md'],
      ['plans/roadmap.md',               'plans directory .md'],
      ['work/local/plans/q1.md',         'nested plans .md'],
      ['.github/workflows/ci.yml',        'CI workflow (not .md but yaml)'],

      // Config files
      ['package.json',                     'package.json'],
      ['tsconfig.json',                    'tsconfig'],
      ['tsconfig.base.json',              'tsconfig.base'],
      ['vitest.config.ts',               'vitest config'],
      ['vite.config.ts',                 'vite config'],
      ['.eslintrc',                       'eslint config'],
      ['eslint.config.mjs',              'eslint flat config'],
      ['.prettierrc',                    'prettier config'],
      ['nx.json',                        'nx config'],
      ['project.json',                   'nx project config'],
      ['.env',                           '.env file'],
      ['.gitignore',                     '.gitignore'],
    ];

    const W = [45, 28, 12];
    const header = row(col('File path', W[0]), col('Description', W[1]), col('FileType', W[2]));
    const sep = divider(W);
    const lines = [header, sep];

    for (const [path, desc] of cases) {
      const type = analyzer.classifyFile(path);
      lines.push(row(col(path, W[0]), col(desc, W[1]), col(type, W[2])));
    }

    expect(lines.join('\n')).toMatchSnapshot();
  });
});

// ─── 2. Intention classification ─────────────────────────────────────────────

function makeEntry(tool: string, extra?: Partial<ToolLogEntry>): ToolLogEntry {
  return { timestamp: 1000, tool, ...extra };
}

function editFile(path: string, ts = 2000): ToolLogEntry {
  return { timestamp: ts, tool: 'Edit', filePath: path };
}

function runTest(command: string, ts = 3000): ToolLogEntry {
  return { timestamp: ts, tool: 'Bash', command };
}

function planTool(ts = 1500): ToolLogEntry {
  return { timestamp: ts, tool: 'mcp__cabinet__plan' };
}

describe('Rule snapshots: intention classification', () => {
  it('classifies intention from tool log entries', () => {
    const cases: Array<[string, ToolLogEntry[]]> = [
      ['no entries',
        []],
      ['read-only tools only',
        [makeEntry('Read'), makeEntry('Grep'), makeEntry('Bash', { command: 'git status' })]],
      ['plan tool only (no edits)',
        [planTool()]],
      ['plan tool + doc edit',
        [planTool(), editFile('docs/guide.md')]],
      ['plan tool + code edit',
        [planTool(), editFile('src/foo.ts')]],
      ['plan tool + test edit',
        [planTool(), editFile('src/foo.test.ts')]],
      ['code edit + test edit',
        [editFile('src/foo.ts', 1000), editFile('src/foo.test.ts', 1500)]],
      ['code edit + no test edit (test run, no test file changes)',
        [editFile('src/foo.ts', 1000), runTest('pnpm test', 2000)]],
      ['code file edited',
        [editFile('src/foo.ts')]],
      ['multiple code files',
        [editFile('src/foo.ts'), editFile('src/bar.ts')]],
      ['test file only',
        [editFile('src/foo.test.ts')]],
      ['test + code',
        [editFile('src/foo.test.ts'), editFile('src/foo.ts')]],
      ['docs file only',
        [editFile('README.md')]],
      ['docs + test',
        [editFile('README.md'), editFile('src/foo.test.ts')]],
      ['docs + code',
        [editFile('README.md'), editFile('src/foo.ts')]],
      ['config file only',
        [editFile('package.json')]],
      ['config + test',
        [editFile('package.json'), editFile('src/foo.test.ts')]],
      ['config + docs',
        [editFile('package.json'), editFile('README.md')]],
      ['config + docs + test',
        [editFile('package.json'), editFile('README.md'), editFile('src/foo.test.ts')]],
      ['CLAUDE.md (classified as code — workflow file)',
        [editFile('CLAUDE.md')]],
      ['plan dir .md',
        [editFile('plan/sprint-1.md')]],
    ];

    const W = [50, 16];
    const header = row(col('Scenario', W[0]), col('Intention', W[1]));
    const sep = divider(W);
    const lines = [header, sep];

    for (const [scenario, entries] of cases) {
      const result = new ToolLogAnalyzer(entries).analyze();
      lines.push(row(col(scenario, W[0]), col(result.intention, W[1])));
    }

    expect(lines.join('\n')).toMatchSnapshot();
  });
});

// ─── 3. Risk classification ───────────────────────────────────────────────────

describe('Rule snapshots: risk classification', () => {
  it('classifies risk from tool log entries', () => {
    const cases: Array<[string, ToolLogEntry[]]> = [
      ['no entries',
        []],
      ['only reads/search',
        [makeEntry('Read'), makeEntry('Grep')]],
      ['docs edit only',
        [editFile('README.md')]],
      ['test edit only',
        [editFile('src/foo.test.ts')]],
      ['config edit only',
        [editFile('package.json')]],
      ['code edit, no test run',
        [editFile('src/foo.ts', 1000)]],
      ['code edit → test run',
        [editFile('src/foo.ts', 1000), runTest('pnpm test', 2000)]],
      ['code edit (<9 LOC) + test edit → test run',
        [
          { timestamp: 1000, tool: 'Edit', filePath: 'src/foo.ts', linesChanged: 5 },
          { timestamp: 1500, tool: 'Edit', filePath: 'src/foo.test.ts', linesChanged: 3 },
          runTest('pnpm test', 2000),
        ]],
      ['code edit → test run → code edit (code after test)',
        [editFile('src/foo.ts', 1000), runTest('pnpm test', 2000), editFile('src/bar.ts', 3000)]],
      ['code edit → test run → docs edit (docs after test, not code)',
        [editFile('src/foo.ts', 1000), runTest('pnpm test', 2000), editFile('README.md', 3000)]],
      ['code edit → vitest run',
        [editFile('src/foo.ts', 1000), runTest('pnpm exec vitest run', 2000)]],
      ['code edit → jest run',
        [editFile('src/foo.ts', 1000), runTest('jest --run', 2000)]],
      ['code edit → unrelated bash (not a test command)',
        [editFile('src/foo.ts', 1000), runTest('git commit -m "fix"', 2000)]],
      ['multiple test runs, last one after all code edits',
        [editFile('src/foo.ts', 1000), runTest('pnpm test', 2000), editFile('src/bar.ts', 3000), runTest('pnpm test', 4000)]],
    ];

    const W = [56, 16];
    const header = row(col('Scenario', W[0]), col('Risk', W[1]));
    const sep = divider(W);
    const lines = [header, sep];

    for (const [scenario, entries] of cases) {
      const result = new ToolLogAnalyzer(entries).analyze();
      lines.push(row(col(scenario, W[0]), col(result.risk, W[1])));
    }

    expect(lines.join('\n')).toMatchSnapshot();
  });
});

// ─── 4. Intention merge matrix ────────────────────────────────────────────────

describe('Rule snapshots: intention merge matrix', () => {
  it('produces merged intention from agent × analyzer', () => {
    const agentTypes: IntentionCode[] = [
      IntentionCode.Feature,
      IntentionCode.Bug,
      IntentionCode.Refactor,
      IntentionCode.Test,
      IntentionCode.Docs,
      IntentionCode.Chore,
      IntentionCode.Plan,
    ];

    const analyzerResults: IntentionClassification[] = [
      'not_classified',
      'multiple',
      IntentionCode.Plan,
      IntentionCode.Test,
      IntentionCode.Docs,
      IntentionCode.Chore,
      'code',
    ];

    const AW = 12; // agent column width
    const CW = 15; // cell width

    // Header: agent types as columns
    const headerCells = [col('analyzer ↓  agent →', AW)];
    for (const a of agentTypes) {
      headerCells.push(col(a, CW));
    }
    const header = headerCells.join(' │ ');
    const sep = [AW, ...agentTypes.map(() => CW)].map(w => '─'.repeat(w)).join('─┼─');

    const lines = [header, sep];

    for (const analyzerResult of analyzerResults) {
      const cells = [col(String(analyzerResult), AW)];
      for (const agent of agentTypes) {
        const merged = mergeIntentions(agent, analyzerResult);
        cells.push(col(String(merged), CW));
      }
      lines.push(cells.join(' │ '));
    }

    expect(lines.join('\n')).toMatchSnapshot();
  });
});
