import { ChangeAnalyzer, FileType } from '../risk/ChangeAnalyzer.js';
import { RiskCode } from '../risk/RiskComputer.js';
import { IntentionCode } from '../tools/GitCommit.js';
import type { ToolLogEntry } from './ToolLogEntry.js';

/**
 * 'code' means code files were changed but we cannot distinguish feature/bug/refactor.
 * It is compatible with feature/bug/refactor agent intents but conflicts with
 * test/docs/chore/plan (which imply no substantive code changes).
 */
export type IntentionClassification = IntentionCode | 'not_classified' | 'multiple' | 'code';
export type RiskClassification = RiskCode | 'not_classified';

export interface ToolLogAnalysis {
  intention: IntentionClassification;
  risk: RiskClassification;
}

const TEST_COMMAND_PATTERN = /\b(vitest|jest|pytest|pnpm\s+test|npm\s+test|yarn\s+test)\b/;

export class ToolLogAnalyzer {
  private readonly changeAnalyzer = new ChangeAnalyzer();

  constructor(private readonly entries: readonly ToolLogEntry[]) {}

  analyze(): ToolLogAnalysis {
    return {
      intention: this.classifyIntention(),
      risk: this.classifyRisk(),
    };
  }

  private classifyIntention(): IntentionClassification {
    const sawPlan = this.entries.some((e) => e.tool === 'mcp__cabinet__plan');
    const editedFiles = this.editedFilePaths();

    if (editedFiles.length === 0 && !sawPlan) return 'not_classified';

    const types = new Set(editedFiles.map((f) => this.changeAnalyzer.classifyFile(f)));
    const hasCode = types.has(FileType.Code);
    const hasTest = types.has(FileType.Test);
    const hasDocs = types.has(FileType.Docs);
    const hasConfig = types.has(FileType.Config);
    const hasPlan = types.has(FileType.Plan);

    // Plan tool usage: classify by what was actually changed alongside it
    if (sawPlan) {
      if (editedFiles.length === 0) return IntentionCode.Plan;
      if (hasCode) return 'code';
      if (hasTest) return IntentionCode.Test;
      if (hasDocs) return IntentionCode.Docs;
      if (hasConfig) return IntentionCode.Chore;
      return IntentionCode.Plan;
    }

    // Code changes: signal about feature/bug vs refactor
    if (hasCode) {
      if (hasTest) return 'code'; // test file edits → not refactor, but can't tell feature/bug
      const hadTestRun = this.entries.some(
        (e) => e.tool === 'Bash' && e.command && TEST_COMMAND_PATTERN.test(e.command),
      );
      if (hadTestRun) return IntentionCode.Refactor; // ran existing tests, no test file changes → refactor
      return 'code'; // no signal
    }

    // Plan file edits (without plan tool)
    if (hasPlan) return IntentionCode.Plan;

    // Test-only
    if (hasTest && !hasDocs && !hasConfig) return IntentionCode.Test;

    // Docs absorbs test; config absorbs everything
    if (hasDocs && !hasConfig) return IntentionCode.Docs;
    if (hasConfig) return IntentionCode.Chore;

    return 'not_classified';
  }

  private classifyRisk(): RiskClassification {
    const editedFiles = this.editedFilePaths();

    if (editedFiles.length === 0) return 'not_classified';

    const types = new Set(editedFiles.map((f) => this.changeAnalyzer.classifyFile(f)));
    const hasCode = types.has(FileType.Code);
    const hasTest = types.has(FileType.Test);
    const hasDocs = types.has(FileType.Docs);
    const hasConfig = types.has(FileType.Config);

    // Pure docs changes are provable (no behavior change possible)
    if (!hasCode && !hasConfig && hasDocs && !hasTest) return RiskCode.Provable;

    // Pure test changes are thorough (tests are self-verifying)
    if (!hasCode && !hasConfig && hasTest) return RiskCode.Thorough;

    // Code or config changes require test verification
    const testRuns = this.entries.filter(
      (e) => e.tool === 'Bash' && e.command && TEST_COMMAND_PATTERN.test(e.command),
    );

    if (testRuns.length === 0) return RiskCode.Risky;

    const lastTestTs = testRuns[testRuns.length - 1].timestamp;
    const writingEntries = this.entries.filter(
      (e) =>
        (e.tool === 'Edit' || e.tool === 'Write') &&
        e.filePath &&
        [FileType.Code, FileType.Config].includes(this.changeAnalyzer.classifyFile(e.filePath)),
    );

    const hasCodeOrConfigAfterTest = writingEntries.some((e) => e.timestamp > lastTestTs);
    if (hasCodeOrConfigAfterTest) return RiskCode.Risky;

    // LOC-based upgrade: small code change (<9 lines in non-test files) with test edits → thorough
    const codeEditsWithLOC = this.entries.filter(
      (e) =>
        (e.tool === 'Edit' || e.tool === 'Write') &&
        e.filePath &&
        this.changeAnalyzer.classifyFile(e.filePath) === FileType.Code &&
        e.linesChanged !== undefined,
    );
    if (codeEditsWithLOC.length > 0) {
      const totalCodeLOC = codeEditsWithLOC.reduce((sum, e) => sum + (e.linesChanged ?? 0), 0);
      const hasTestEdits = editedFiles.some(
        (f) => this.changeAnalyzer.classifyFile(f) === FileType.Test,
      );
      if (totalCodeLOC < 9 && hasTestEdits) return RiskCode.Thorough;
    }

    return RiskCode.Covered;
  }

  private editedFilePaths(): string[] {
    const paths: string[] = [];
    for (const e of this.entries) {
      if ((e.tool === 'Edit' || e.tool === 'Write') && e.filePath) {
        paths.push(e.filePath);
      }
    }
    return paths;
  }
}
