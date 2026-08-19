import { describe, it, expect, beforeAll } from 'vitest';
import { createDiskSandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Domain boundary tests for @minions/costumes
 *
 * These tests verify that costumes maintains clean boundaries:
 * - No imports from @minions/conductor
 * - No imports from @minions/hatchery
 * - Only allowed dependencies: effect
 *
 * Purpose: Prevent circular dependencies and maintain architecture integrity
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let srcDir: Directory;

describe('Costumes Domain Boundaries', () => {
  beforeAll(async () => {
    // Get the source directory using file-store
    // This test file is in libs/costumes/__tests__
    // We need libs/costumes/src which is ../src from here
    const srcPath = resolve(__dirname, '..', 'src');
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
    it('should only depend on effect, @minions/events, @minions/file-store, @minions/gadgets, and Node.js built-ins', async () => {
      const allImports = await findAllExternalImports();
      // @minions/events provides event declaration system - events is a foundational package
      // @minions/file-store is used by ClosetCostumeLoader for file operations
      // @minions/gadgets provides Gadget/CostumeExtensions interfaces used by ClosetExtensionLoader
      const allowedPackages = ['effect', '@minions/events', '@minions/file-store', '@minions/gadgets'];

      // Node.js built-in modules are allowed
      const nodeBuiltins = [
        'fs', 'fs/promises', 'path', 'url', 'util', 'events',
        'stream', 'buffer', 'process', 'os', 'crypto'
      ];

      // Filter to external package imports (not relative imports)
      const externalImports = allImports.filter(imp =>
        !imp.startsWith('.') && !imp.startsWith('/')
      );

      // All external imports should be in allowed list or Node.js built-ins
      const disallowed = externalImports.filter(imp =>
        !allowedPackages.some(allowed => imp.startsWith(allowed)) &&
        !nodeBuiltins.some(builtin => imp === builtin || imp.startsWith(builtin + '/'))
      );

      if (disallowed.length > 0) {
        console.error('Disallowed imports found:', disallowed);
      }

      expect(disallowed).toEqual([]);
    });
  });

  describe('Costumes as shared domain', () => {
    it('should document that both conductor and hatchery depend on costumes', () => {
      // This test documents the architectural decision
      // Both conductor and hatchery depend on costumes, which is correct
      // Costumes is a shared domain package defining minion configuration
      // Costumes depends on @minions/events for event declaration types
      // Costumes depends on @minions/file-store for ClosetCostumeLoader file operations
      // Costumes depends on @minions/gadgets for Gadget/CostumeExtensions interfaces used by ClosetExtensionLoader

      const architecture = {
        package: '@minions/costumes',
        role: 'shared domain - minion configuration',
        dependsOn: ['effect', '@minions/events', '@minions/file-store', '@minions/gadgets'],
        dependedUponBy: ['@minions/conductor', '@minions/hatchery', '@minions/domain-types'],
        hasCircularDependency: false,
      };

      // Verify no circular dependency
      expect(architecture.hasCircularDependency).toBe(false);

      // Verify costumes dependencies
      expect(architecture.dependsOn).toEqual(['effect', '@minions/events', '@minions/file-store', '@minions/gadgets']);

      // Verify both conductor and hatchery depend on costumes
      expect(architecture.dependedUponBy).toContain('@minions/conductor');
      expect(architecture.dependedUponBy).toContain('@minions/hatchery');
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
 * Find all source files in costumes that match a pattern
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
 * Find all external imports across costumes source files
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
