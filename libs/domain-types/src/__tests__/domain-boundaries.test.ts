import { describe, it, expect, beforeAll } from 'vitest';
import { createDiskSandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Domain boundary tests for @minions/domain-types
 *
 * These tests verify that domain-types maintains clean boundaries:
 * - No imports from @minions/conductor
 * - No imports from @minions/hatchery
 * - Only allowed dependencies: effect, @minions/costumes
 *
 * Purpose: Prevent circular dependencies and maintain architecture integrity
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let srcDir: Directory;

describe('Domain Types Boundaries', () => {
  beforeAll(async () => {
    // Get the source directory using file-store
    // This test file is in libs/domain-types/src/__tests__
    // We need libs/domain-types/src which is .. from here
    const srcPath = resolve(__dirname, '..');
    const sandbox = createDiskSandbox(srcPath);

    srcDir = sandbox.root;
  });
  describe('No conductor dependencies', () => {
    it('should not import from @minions/conductor', async () => {
      const violations = await findImportViolations(/@minions\/conductor/);

      expect(violations).toEqual([]);
    });

    it('should not import from ../conductor or ../../conductor', async () => {
      const violations = await findImportViolations(/from ['"].*\.\.\/.*conductor/);

      expect(violations).toEqual([]);
    });
  });

  describe('No hatchery dependencies', () => {
    it('should not import from @minions/hatchery', async () => {
      const violations = await findImportViolations(/@minions\/hatchery/);

      expect(violations).toEqual([]);
    });

    it('should not import from ../hatchery or ../../hatchery', async () => {
      const violations = await findImportViolations(/from ['"].*\.\.\/.*hatchery/);

      expect(violations).toEqual([]);
    });
  });

  describe('Allowed dependencies', () => {
    it('should only depend on effect and @minions/costumes', async () => {
      const allImports = await findAllExternalImports();
      const allowedPackages = ['effect', '@minions/costumes'];

      // Filter to external package imports (not relative imports)
      const externalImports = allImports.filter(imp =>
        !imp.startsWith('.') && !imp.startsWith('/')
      );

      // All external imports should be in allowed list
      const disallowed = externalImports.filter(imp =>
        !allowedPackages.some(allowed => imp.startsWith(allowed))
      );

      if (disallowed.length > 0) {
        console.error('Disallowed imports found:', disallowed);
      }

      expect(disallowed).toEqual([]);
    });
  });
});

/**
 * Get all TypeScript source files from a directory via traversal
 */
async function getSourceFiles(dir: Directory): Promise<string[]> {
  const children = await dir.children();
  return children
    .filter(child =>
      child.kind === 'file' &&
      child.name.endsWith('.ts') &&
      !child.name.endsWith('.test.ts') &&
      !child.name.includes('__tests__')
    )
    .map(child => child.name);
}

/**
 * Find all source files in domain-types that match a pattern
 */
async function findImportViolations(pattern: RegExp): Promise<string[]> {
  const violations: string[] = [];

  // Discover source files via directory traversal
  const sourceFiles = await getSourceFiles(srcDir);

  for (const file of sourceFiles) {
    const fileResult = await srcDir.child(file);
    if (!fileResult.found || fileResult.node.kind !== 'file') {
      // File might not exist, skip
      continue;
    }

    try {
      const content = await fileResult.node.read();

      // Check each line for violations
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    } catch {
      // File read error, skip
    }
  }

  return violations;
}

/**
 * Find all external imports across domain-types source files
 */
async function findAllExternalImports(): Promise<string[]> {
  const imports: string[] = [];

  // Discover source files via directory traversal
  const sourceFiles = await getSourceFiles(srcDir);

  // Regex to match import statements
  const importRegex = /from ['"]([^'"]+)['"]/g;

  for (const file of sourceFiles) {
    const fileResult = await srcDir.child(file);
    if (!fileResult.found || fileResult.node.kind !== 'file') {
      // File might not exist, skip
      continue;
    }

    try {
      const content = await fileResult.node.read();

      // Find all imports in file
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        if (!imports.includes(importPath)) {
          imports.push(importPath);
        }
      }
    } catch {
      // File read error, skip
    }
  }

  return imports;
}
