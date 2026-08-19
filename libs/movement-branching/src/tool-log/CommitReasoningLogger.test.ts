import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitReasoningLogger } from './CommitReasoningLogger.js';
import type { CommitReasoningEntry } from './CommitReasoningLogger.js';
import { RiskCode } from '../risk/RiskComputer.js';
import { IntentionCode } from '../tools/GitCommit.js';

function makeEntry(overrides: Partial<CommitReasoningEntry> = {}): CommitReasoningEntry {
  return {
    timestamp: new Date('2026-06-05T10:00:00Z'),
    agentInput: {
      type: 'feature',
      summary: 'Add reasoning logger',
      testsRan: true,
      testsPassed: true,
    },
    toolEntries: [],
    analyzedIntention: null,
    analyzedRisk: null,
    mergedIntention: null,
    riskAssessment: null,
    finalCommitMessage: '! f Add reasoning logger',
    commitHash: 'abc123',
    success: true,
    ...overrides,
  };
}

describe('CommitReasoningLogger', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reasoning-logger-'));
    logPath = join(tmpDir, 'sub', 'reasoning.md');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('creates the file and parent directories', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry());
      expect(existsSync(logPath)).toBe(true);
    });

    it('appends multiple entries sequentially', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({ finalCommitMessage: '! f First' }));
      await logger.append(makeEntry({ finalCommitMessage: '@ f Second' }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('! f First');
      expect(content).toContain('@ f Second');
    });
  });

  describe('format', () => {
    it('includes timestamp and commit message in heading', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry());

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('## 2026-06-05T10:00:00.000Z — ! f Add reasoning logger');
    });

    it('includes agent input section', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({ agentInput: { type: 'bug', summary: 'Fix crash', testsRan: false, testsPassed: false } }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('- type: bug');
      expect(content).toContain('- summary: Fix crash');
      expect(content).toContain('- testsRan: false');
      expect(content).toContain('- testsPassed: false');
    });

    it('includes isComprehensive when provided', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({ agentInput: { type: 'feature', summary: 'X', testsRan: true, testsPassed: true, isComprehensive: true } }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('- isComprehensive: true');
    });

    it('omits isComprehensive when not provided', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry());

      const content = readFileSync(logPath, 'utf-8');
      expect(content).not.toContain('isComprehensive');
    });

    it('shows (none) when there are no tool entries', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({ toolEntries: [] }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('_(none)_');
    });

    it('renders tool entries as a table', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        toolEntries: [
          { timestamp: new Date('2026-06-05T09:00:00Z').getTime(), tool: 'Edit', filePath: 'src/foo.ts', linesChanged: 12 },
          { timestamp: new Date('2026-06-05T09:01:00Z').getTime(), tool: 'Bash', command: 'pnpm test' },
        ],
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('| Edit | src/foo.ts | 12 |');
      expect(content).toContain('| Bash | pnpm test | — |');
    });

    it('renders mcp action in tool entries', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        toolEntries: [{ timestamp: Date.now(), tool: 'mcp__cabinet__plan', mcpAction: 'get-subtree' }],
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('| mcp__cabinet__plan | get-subtree |');
    });

    it('includes tool log classification when present', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        analyzedIntention: 'code',
        analyzedRisk: RiskCode.Covered,
        mergedIntention: IntentionCode.Feature,
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('### Tool Log Classification');
      expect(content).toContain('- Intention: code');
      expect(content).toContain(`- Risk: ${RiskCode.Covered}`);
    });

    it('includes intention merge when present', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        agentInput: { type: 'feature', summary: 'X', testsRan: true, testsPassed: true },
        analyzedIntention: 'code',
        analyzedRisk: RiskCode.Covered,
        mergedIntention: IntentionCode.Feature,
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('### Intention Merge');
      expect(content).toContain('- Agent said: feature');
      expect(content).toContain('- Analyzer saw: code');
      expect(content).toContain('- Merged: feature');
    });

    it('includes risk assessment when present', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        riskAssessment: {
          code: RiskCode.Covered,
          reason: 'Partial test coverage',
          automated: { code: RiskCode.Covered, reason: 'Partial test coverage' },
          manualFactors: [],
          suggestions: [],
        },
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('### Risk Assessment');
      expect(content).toContain('- Automated: `!` — Partial test coverage');
      expect(content).toContain('- Manual factors: none');
      expect(content).toContain('**Final: `!` — Partial test coverage**');
    });

    it('shows manual risk factors in risk assessment', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        riskAssessment: {
          code: RiskCode.Risky,
          reason: 'Manual: Breaking API change',
          automated: { code: RiskCode.Covered, reason: 'Partial test coverage' },
          manualFactors: [{ code: RiskCode.Risky, reason: 'Breaking API change', details: 'public interface removed' }],
          suggestions: [],
        },
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('`@` — Breaking API change (public interface removed)');
    });

    it('shows suggestions when present', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        riskAssessment: {
          code: RiskCode.Risky,
          reason: 'No test coverage',
          automated: { code: RiskCode.Risky, reason: 'No test coverage' },
          manualFactors: [],
          suggestions: ['Add tests for src/foo.ts'],
        },
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('  - Add tests for src/foo.ts');
    });

    it('shows commit hash on success', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({ commitHash: 'deadbeef' }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('Hash: `deadbeef`');
    });

    it('shows failure message on error', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry({
        success: false,
        finalCommitMessage: null,
        commitHash: null,
        error: 'nothing to commit',
      }));

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('**Failed**: nothing to commit');
    });

    it('ends each entry with a horizontal rule', async () => {
      const logger = new CommitReasoningLogger(logPath);
      await logger.append(makeEntry());

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('\n---\n');
    });
  });
});
