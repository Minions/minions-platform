import * as path from 'path';

/**
 * File type classification
 */
export enum FileType {
  Code = 'code',
  Test = 'test',
  Docs = 'docs',
  Config = 'config',
  /** Plan documents — markdown files in plan/plans directories */
  Plan = 'plan',
}

/**
 * Change size classification
 */
export enum ChangeSize {
  Small = 'small',
  Medium = 'medium',
  Large = 'large',
}

/**
 * Result of change analysis
 */
export interface ChangeAnalysis {
  codeFiles: string[];
  testFiles: string[];
  docsFiles: string[];
  configFiles: string[];
}

/**
 * File count by type
 */
export interface FileTypeCounts {
  code: number;
  test: number;
  docs: number;
  config: number;
}

/**
 * Patterns for test files
 */
const TEST_PATTERNS = ['.test.', '.spec.', '__tests__', 'test_'];

/**
 * Extensions for documentation files
 */
const DOC_EXTENSIONS = ['.md', '.txt', '.rst', '.adoc'];

/**
 * Config file patterns (base names or extensions)
 */
const CONFIG_PATTERNS = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  'eslint.config',
  '.prettierrc',
  'prettier.config',
  'vite.config',
  'vitest.config',
  'jest.config',
  '.gitignore',
  '.npmrc',
  '.env',
  'nx.json',
  'project.json',
];

/**
 * Directory name segments that classify a .md file as a workflow (code) file.
 * Workflow files are agent instructions that behave like code — high risk.
 * Matched as path segments: the path must contain /<dir>/ or start with <dir>/
 */
const WORKFLOW_DIRS = ['.claude', 'workflow', 'workflows', 'dev-process', 'skills'];

/**
 * Directory name segments that classify a .md file as a plan file.
 * Matched as path segments.
 */
const PLAN_DIRS = ['plan', 'plans'];

/**
 * Thresholds for change size classification
 */
const SIZE_THRESHOLDS = {
  small: 100,
  medium: 500,
};

/**
 * Analyzes file changes to classify by type and size.
 *
 * ChangeAnalyzer helps determine what kinds of changes are being made,
 * which is used by the RiskComputer to determine risk levels.
 * For example, documentation-only changes are always provable.
 *
 * Special classifications:
 * - Workflow files (CLAUDE.md, .claude/, workflow/, dev-process/, skills/) → Code
 * - Plan files (plan/, plans/ dirs with .md) → Plan
 */
export class ChangeAnalyzer {
  /**
   * Classify a file by type
   */
  classifyFile(filePath: string): FileType {
    // Check for test files first (most specific)
    if (this.isTestFilePath(filePath)) {
      return FileType.Test;
    }

    // Workflow files look like docs but are agent instructions — treat as code
    if (this.isWorkflowFile(filePath)) {
      return FileType.Code;
    }

    // Plan directory markdown files
    if (this.isPlanFile(filePath)) {
      return FileType.Plan;
    }

    // Check for documentation
    if (this.isDocsFilePath(filePath)) {
      return FileType.Docs;
    }

    // Check for config files
    if (this.isConfigFilePath(filePath)) {
      return FileType.Config;
    }

    // Default to code for source files
    return FileType.Code;
  }

  /**
   * Analyze a list of changed files
   */
  analyze(files: string[]): ChangeAnalysis {
    const codeFiles: string[] = [];
    const testFiles: string[] = [];
    const docsFiles: string[] = [];
    const configFiles: string[] = [];

    for (const file of files) {
      const type = this.classifyFile(file);
      switch (type) {
        case FileType.Code:
          codeFiles.push(file);
          break;
        case FileType.Test:
          testFiles.push(file);
          break;
        case FileType.Docs:
          docsFiles.push(file);
          break;
        case FileType.Config:
          configFiles.push(file);
          break;
        // Plan files are not included in the legacy ChangeAnalysis structure
      }
    }

    return { codeFiles, testFiles, docsFiles, configFiles };
  }

  /**
   * Classify change size based on lines added/deleted
   */
  classifySize(linesAdded: number, linesDeleted: number): ChangeSize {
    const total = linesAdded + linesDeleted;

    if (total < SIZE_THRESHOLDS.small) {
      return ChangeSize.Small;
    }
    if (total < SIZE_THRESHOLDS.medium) {
      return ChangeSize.Medium;
    }
    return ChangeSize.Large;
  }

  /**
   * Check if all changes are documentation only
   */
  isDocsOnly(files: string[]): boolean {
    if (files.length === 0) return false;
    return files.every((f) => this.classifyFile(f) === FileType.Docs);
  }

  /**
   * Check if all changes are plan documents, or a mix of plan and docs.
   * Plan documents are non-executable prose, like docs — no test coverage can apply.
   */
  isDocsOrPlanOnly(files: string[]): boolean {
    if (files.length === 0) return false;
    return files.every((f) => {
      const type = this.classifyFile(f);
      return type === FileType.Docs || type === FileType.Plan;
    });
  }

  /**
   * Check if all changes are tests only
   */
  isTestOnly(files: string[]): boolean {
    if (files.length === 0) return false;
    return files.every((f) => this.classifyFile(f) === FileType.Test);
  }

  /**
   * Check if all changes are config only
   */
  isConfigOnly(files: string[]): boolean {
    if (files.length === 0) return false;
    return files.every((f) => this.classifyFile(f) === FileType.Config);
  }

  /**
   * Check if changes include code modifications
   */
  hasCodeChanges(files: string[]): boolean {
    return files.some((f) => this.classifyFile(f) === FileType.Code);
  }

  /**
   * Check if changes include test modifications
   */
  hasTestChanges(files: string[]): boolean {
    return files.some((f) => this.classifyFile(f) === FileType.Test);
  }

  /**
   * Count files by type
   */
  countByType(files: string[]): FileTypeCounts {
    const analysis = this.analyze(files);
    return {
      code: analysis.codeFiles.length,
      test: analysis.testFiles.length,
      docs: analysis.docsFiles.length,
      config: analysis.configFiles.length,
    };
  }

  /**
   * Check if changes are provable (test or docs only, no code changes)
   */
  isProvable(files: string[]): boolean {
    if (files.length === 0) return false;

    return files.every((f) => {
      const type = this.classifyFile(f);
      return type === FileType.Test || type === FileType.Docs;
    });
  }

  /**
   * Check if a file path is a test file
   */
  private isTestFilePath(filePath: string): boolean {
    const normalizedPath = filePath.toLowerCase();
    return TEST_PATTERNS.some((pattern) => normalizedPath.includes(pattern));
  }

  /**
   * Workflow files are agent instructions (CLAUDE.md, .claude/, workflow/, dev-process/, skills/).
   * They look like docs but behave like code — changes are high risk with no test coverage.
   */
  private isWorkflowFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = path.basename(filePath);

    // CLAUDE.md is always a workflow file regardless of location
    if (basename === 'CLAUDE.md') return true;

    // Files inside workflow-related directories
    return WORKFLOW_DIRS.some(
      (dir) => normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`),
    );
  }

  /**
   * Plan files are markdown documents in plan/plans directories.
   */
  private isPlanFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.md') return false;

    const normalized = filePath.replace(/\\/g, '/');
    return PLAN_DIRS.some(
      (dir) => normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`),
    );
  }

  /**
   * Check if a file path is a documentation file
   */
  private isDocsFilePath(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return DOC_EXTENSIONS.includes(ext);
  }

  /**
   * Check if a file path is a config file
   */
  private isConfigFilePath(filePath: string): boolean {
    const baseName = path.basename(filePath).toLowerCase();

    // Check exact matches and pattern matches
    return CONFIG_PATTERNS.some((pattern) => {
      const lowerPattern = pattern.toLowerCase();
      return baseName === lowerPattern || baseName.startsWith(lowerPattern);
    });
  }
}
