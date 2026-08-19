import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolLogEntry } from './ToolLogEntry.js';
import type { IntentionClassification, RiskClassification } from './ToolLogAnalyzer.js';
import type { RiskAssessment } from '../risk/RiskComputer.js';

export interface CommitReasoningEntry {
  timestamp: Date;
  agentInput: {
    type: string;
    summary: string;
    testsRan: boolean;
    testsPassed: boolean;
    isComprehensive?: boolean;
  };
  toolEntries: readonly ToolLogEntry[];
  analyzedIntention: IntentionClassification | null;
  analyzedRisk: RiskClassification | null;
  mergedIntention: IntentionClassification | null;
  riskAssessment: RiskAssessment | null;
  finalCommitMessage: string | null;
  commitHash: string | null;
  success: boolean;
  error?: string;
}

export class CommitReasoningLogger {
  constructor(private readonly filePath: string) {}

  async append(entry: CommitReasoningEntry): Promise<void> {
    const text = this.format(entry);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, text, 'utf-8');
  }

  private format(entry: CommitReasoningEntry): string {
    const ts = entry.timestamp.toISOString();
    const heading = entry.finalCommitMessage ?? '(no commit)';
    const parts: string[] = [];

    parts.push(`## ${ts} — ${heading}`, '');

    parts.push('### Agent Input');
    parts.push(`- type: ${entry.agentInput.type}`);
    parts.push(`- summary: ${entry.agentInput.summary}`);
    parts.push(`- testsRan: ${entry.agentInput.testsRan}`);
    parts.push(`- testsPassed: ${entry.agentInput.testsPassed}`);
    if (entry.agentInput.isComprehensive !== undefined) {
      parts.push(`- isComprehensive: ${entry.agentInput.isComprehensive}`);
    }
    parts.push('');

    parts.push('### Tool Usages');
    if (entry.toolEntries.length === 0) {
      parts.push('_(none)_');
    } else {
      parts.push('| Tool | Detail | Lines | Timestamp |');
      parts.push('|------|--------|-------|-----------|');
      for (const e of entry.toolEntries) {
        const detail = e.filePath ?? e.command ?? e.mcpAction ?? '—';
        const loc = e.linesChanged !== undefined ? String(e.linesChanged) : '—';
        const t = new Date(e.timestamp).toISOString();
        parts.push(`| ${e.tool} | ${detail} | ${loc} | ${t} |`);
      }
    }
    parts.push('');

    if (entry.analyzedIntention !== null || entry.analyzedRisk !== null) {
      parts.push('### Tool Log Classification');
      parts.push(`- Intention: ${entry.analyzedIntention ?? '—'}`);
      parts.push(`- Risk: ${entry.analyzedRisk ?? '—'}`);
      parts.push('');
    }

    if (entry.mergedIntention !== null) {
      parts.push('### Intention Merge');
      parts.push(`- Agent said: ${entry.agentInput.type}`);
      parts.push(`- Analyzer saw: ${entry.analyzedIntention}`);
      parts.push(`- Merged: ${entry.mergedIntention}`);
      parts.push('');
    }

    if (entry.riskAssessment !== null) {
      const r = entry.riskAssessment;
      parts.push('### Risk Assessment');
      parts.push(`- Automated: \`${r.automated.code}\` — ${r.automated.reason}`);
      if (r.manualFactors.length > 0) {
        parts.push('- Manual factors:');
        for (const f of r.manualFactors) {
          parts.push(`  - \`${f.code}\` — ${f.reason}${f.details ? ` (${f.details})` : ''}`);
        }
      } else {
        parts.push('- Manual factors: none');
      }
      parts.push(`- **Final: \`${r.code}\` — ${r.reason}**`);
      if (r.suggestions.length > 0) {
        parts.push('- Suggestions:');
        for (const s of r.suggestions) {
          parts.push(`  - ${s}`);
        }
      }
      parts.push('');
    }

    parts.push('### Final Commit');
    if (entry.success) {
      parts.push(`\`${entry.finalCommitMessage}\``);
      if (entry.commitHash) {
        parts.push(`Hash: \`${entry.commitHash}\``);
      }
    } else {
      parts.push(`**Failed**: ${entry.error ?? 'unknown error'}`);
    }
    parts.push('', '---', '');

    return parts.join('\n');
  }
}
