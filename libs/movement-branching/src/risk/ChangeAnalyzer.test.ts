import { describe, it, expect } from 'vitest';
import { ChangeAnalyzer, FileType, ChangeSize } from './ChangeAnalyzer.js';

describe('ChangeAnalyzer', () => {
  describe('classifying file types', () => {
    it('classifies TypeScript source files as code', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('src/app.ts')).toBe(FileType.Code);
      expect(analyzer.classifyFile('src/utils/helper.ts')).toBe(FileType.Code);
    });

    it('classifies JavaScript source files as code', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('src/app.js')).toBe(FileType.Code);
      expect(analyzer.classifyFile('lib/index.js')).toBe(FileType.Code);
    });

    it('classifies test files as test', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('src/app.test.ts')).toBe(FileType.Test);
      expect(analyzer.classifyFile('src/app.spec.ts')).toBe(FileType.Test);
      expect(analyzer.classifyFile('__tests__/app.ts')).toBe(FileType.Test);
    });

    it('classifies markdown files as docs', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('README.md')).toBe(FileType.Docs);
      expect(analyzer.classifyFile('docs/guide.md')).toBe(FileType.Docs);
      expect(analyzer.classifyFile('CHANGELOG.md')).toBe(FileType.Docs);
    });

    it('classifies config files as config', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('package.json')).toBe(FileType.Config);
      expect(analyzer.classifyFile('tsconfig.json')).toBe(FileType.Config);
      expect(analyzer.classifyFile('.eslintrc.js')).toBe(FileType.Config);
      expect(analyzer.classifyFile('vite.config.ts')).toBe(FileType.Config);
      expect(analyzer.classifyFile('.prettierrc')).toBe(FileType.Config);
      expect(analyzer.classifyFile('.gitignore')).toBe(FileType.Config);
    });

    it('classifies plan directory markdown files as plan', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('apps/plan/ps_0013/index.md')).toBe(FileType.Plan);
      expect(analyzer.classifyFile('apps/plan/ps_0013/Phase-1.md')).toBe(FileType.Plan);
      expect(analyzer.classifyFile('plan/sprint-1.md')).toBe(FileType.Plan);
      expect(analyzer.classifyFile('plans/roadmap.md')).toBe(FileType.Plan);
      expect(analyzer.classifyFile('work/local/plans/q1.md')).toBe(FileType.Plan);
    });

    it('classifies workflow files as code', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('CLAUDE.md')).toBe(FileType.Code);
      expect(analyzer.classifyFile('.claude/CLAUDE.md')).toBe(FileType.Code);
      expect(analyzer.classifyFile('work/local/CLAUDE.md')).toBe(FileType.Code);
      expect(analyzer.classifyFile('any/workflow/foo/bar.md')).toBe(FileType.Code);
      expect(analyzer.classifyFile('any/dev-process/foo/bar.md')).toBe(FileType.Code);
      expect(analyzer.classifyFile('.claude/foo/bar.md')).toBe(FileType.Code);
    });

    it('classifies Vue files as code', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('src/components/Button.vue')).toBe(FileType.Code);
    });

    it('classifies Python files as code', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('src/main.py')).toBe(FileType.Code);
    });

    it('classifies Python test files as test', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifyFile('tests/test_main.py')).toBe(FileType.Test);
      expect(analyzer.classifyFile('src/test_app.py')).toBe(FileType.Test);
    });
  });

  describe('isDocsOrPlanOnly', () => {
    it('is true for plan-only changes', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isDocsOrPlanOnly(['plans/roadmap.md'])).toBe(true);
    });

    it('is true for a mix of plan and docs', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isDocsOrPlanOnly(['plans/roadmap.md', 'README.md'])).toBe(true);
    });

    it('is false when a code file is included', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isDocsOrPlanOnly(['plans/roadmap.md', 'src/app.ts'])).toBe(false);
    });

    it('is false for no changes', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isDocsOrPlanOnly([])).toBe(false);
    });
  });

  describe('analyzing changes', () => {
    it('returns empty analysis for no changes', () => {
      const analyzer = new ChangeAnalyzer();

      const result = analyzer.analyze([]);

      expect(result.codeFiles).toEqual([]);
      expect(result.testFiles).toEqual([]);
      expect(result.docsFiles).toEqual([]);
      expect(result.configFiles).toEqual([]);
    });

    it('groups files by type', () => {
      const analyzer = new ChangeAnalyzer();

      const result = analyzer.analyze([
        'src/app.ts',
        'src/app.test.ts',
        'README.md',
        'package.json',
      ]);

      expect(result.codeFiles).toEqual(['src/app.ts']);
      expect(result.testFiles).toEqual(['src/app.test.ts']);
      expect(result.docsFiles).toEqual(['README.md']);
      expect(result.configFiles).toEqual(['package.json']);
    });
  });

  describe('detecting change size', () => {
    it('classifies small changes (< 100 lines)', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifySize(10, 5)).toBe(ChangeSize.Small);
      expect(analyzer.classifySize(50, 20)).toBe(ChangeSize.Small);
      expect(analyzer.classifySize(99, 0)).toBe(ChangeSize.Small);
    });

    it('classifies medium changes (100-500 lines)', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifySize(100, 0)).toBe(ChangeSize.Medium);
      expect(analyzer.classifySize(200, 100)).toBe(ChangeSize.Medium);
      expect(analyzer.classifySize(499, 0)).toBe(ChangeSize.Medium);
    });

    it('classifies large changes (> 500 lines)', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.classifySize(500, 0)).toBe(ChangeSize.Large);
      expect(analyzer.classifySize(1000, 200)).toBe(ChangeSize.Large);
    });

    it('considers additions and deletions separately', () => {
      const analyzer = new ChangeAnalyzer();

      // Both additions and deletions contribute to total
      expect(analyzer.classifySize(250, 250)).toBe(ChangeSize.Large);
    });
  });

  describe('query methods', () => {
    it('checks if changes are docs only', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isDocsOnly(['README.md', 'docs/guide.md'])).toBe(true);
      expect(analyzer.isDocsOnly(['README.md', 'src/app.ts'])).toBe(false);
      expect(analyzer.isDocsOnly([])).toBe(false);
    });

    it('checks if changes are test only', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isTestOnly(['src/app.test.ts'])).toBe(true);
      expect(analyzer.isTestOnly(['src/app.test.ts', '__tests__/utils.ts'])).toBe(true);
      expect(analyzer.isTestOnly(['src/app.test.ts', 'src/app.ts'])).toBe(false);
      expect(analyzer.isTestOnly([])).toBe(false);
    });

    it('checks if changes are config only', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isConfigOnly(['package.json', 'tsconfig.json'])).toBe(true);
      expect(analyzer.isConfigOnly(['package.json', 'src/app.ts'])).toBe(false);
    });

    it('checks if changes have code modifications', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.hasCodeChanges(['src/app.ts'])).toBe(true);
      expect(analyzer.hasCodeChanges(['README.md'])).toBe(false);
      expect(analyzer.hasCodeChanges(['src/app.test.ts'])).toBe(false);
    });

    it('checks if changes have tests', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.hasTestChanges(['src/app.test.ts'])).toBe(true);
      expect(analyzer.hasTestChanges(['src/app.ts'])).toBe(false);
    });
  });

  describe('counting by type', () => {
    it('counts files by type', () => {
      const analyzer = new ChangeAnalyzer();

      const counts = analyzer.countByType([
        'src/app.ts',
        'src/utils.ts',
        'src/app.test.ts',
        'README.md',
        'package.json',
      ]);

      expect(counts.code).toBe(2);
      expect(counts.test).toBe(1);
      expect(counts.docs).toBe(1);
      expect(counts.config).toBe(1);
    });
  });

  describe('provable changes detection', () => {
    it('identifies provable changes (test or docs only)', () => {
      const analyzer = new ChangeAnalyzer();

      expect(analyzer.isProvable(['src/app.test.ts'])).toBe(true);
      expect(analyzer.isProvable(['README.md'])).toBe(true);
      expect(analyzer.isProvable(['src/app.test.ts', 'README.md'])).toBe(true);
      expect(analyzer.isProvable(['src/app.ts'])).toBe(false);
      expect(analyzer.isProvable(['package.json'])).toBe(false);
    });
  });
});
