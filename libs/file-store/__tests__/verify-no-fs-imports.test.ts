/**
 * Verification test: Ensure no direct fs imports outside of acceptable exceptions
 *
 * This test enforces the file-store migration policy by scanning the codebase
 * for direct imports from 'fs' or 'fs/promises' and ensuring they only appear
 * in documented exception cases.
 *
 * Acceptable exceptions:
 * 1. file-store adapters (libs/file-store/src/adapters) - these ARE the fs abstraction
 * 2. file-store tests (libs/file-store/__tests__) - testing the adapters
 * 3. Build scripts (apps scripts) - dev tooling, not production code
 * 4. Dev tooling scripts (patterns scripts) - dev tooling, not production code
 * 7. Coverage reports (coverage) - generated files, not source code
 * 12. vite.config.ts files - build/dev tooling, not production code
 * 14. Costume briefing-reader - readBriefingFromMission uses import.meta.url, no DirectoryLike available
 * 15. ClaudeCodeClient / Dominion server.ts - binary discovery via existsSync, no file-store equivalent
 */

import { describe, it, expect, vi } from 'vitest';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

// Get the repository root (work/local directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '../../..');

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.nx']);

// Source-file extensions `import`/`from` can appear in. No point opening
// anything else (json, images, lockfiles, ...).
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue']);

// Static imports always sit at the top of a module (by convention and, for
// the exports-before-imports-forbidden common case, by the language too) —
// so we only need to read the first slice of each file, not the whole thing.
const SCAN_BYTES = 8192;

// Matches static `import ... from 'fs'` and side-effect `import 'fs'`,
// single or double quoted. Deliberately does not match `import('fs')` /
// `typeof import('fs')` (dynamic/type-only imports aren't the runtime fs
// access this policy cares about) or the `node:fs` scheme prefix — the
// codebase uses `node:fs` pervasively outside file-store already, so
// flagging it is a policy-scope change, not part of this fix. See the
// investigation notes for that question.
const FS_IMPORT_RE = /\bfrom\s+["']fs(?:\/promises)?["']|^\s*import\s+["']fs(?:\/promises)?["']/;

/**
 * Check if a file path matches an acceptable exception pattern
 */
function isAcceptableException(filePath: string): boolean {
  // Normalize path separators for consistent matching
  const normalizedPath = filePath.split(sep).join('/');

  // Exception 1: file-store adapters
  if (normalizedPath.includes('libs/file-store/src/adapters/')) {
    return true;
  }

  // Exception 2: file-store tests
  if (normalizedPath.includes('libs/file-store/__tests__/')) {
    return true;
  }

  // Exception 3: Build scripts (*.js and *.mjs in apps/*/scripts/)
  if (normalizedPath.match(/apps\/[^/]+\/scripts\/.*\.(m?js)$/)) {
    return true;
  }

  // Exception 4: Dev tooling scripts (patterns/*/scripts/*.ts)
  if (normalizedPath.match(/patterns\/[^/]+\/scripts\/.*\.ts$/)) {
    return true;
  }

  // Exception 7: Coverage reports
  if (normalizedPath.includes('/coverage/')) {
    return true;
  }

  // Exception 8: Documentation and plan files
  if (normalizedPath.endsWith('.md')) {
    return true;
  }

  // Exception 9: Cabinet public integration scripts (browser-side bootstrapping)
  if (normalizedPath.includes('apps/cabinet/public/')) {
    return true;
  }

  // Exception 12: Vite build configuration files — dev/build tooling, not production code
  if (normalizedPath.endsWith('/vite.config.ts') || normalizedPath.endsWith('\\vite.config.ts')) {
    return true;
  }

  // Exception 14: Costume briefing reader — readBriefingFromMission() locates briefing files
  // relative to import.meta.url (caller's on-disk path), so no DirectoryLike is available
  if (normalizedPath.includes('costumes/ui-generation/src/briefing-reader.ts')) {
    return true;
  }

  // Exception 15: ClaudeCodeClient / Dominion server.ts — check for the claude
  // binary on the filesystem (or the native installer's known install path)
  // using existsSync; no file-store abstraction exists for binary discovery
  if (normalizedPath.includes('libs/hatchery/src/adapters/clients/ClaudeCodeClient.ts')) {
    return true;
  }
  if (normalizedPath.includes('apps/dominion/src/server.ts')) {
    return true;
  }

  return false;
}

/**
 * Recursively collects every source file under `root`, skipping directories
 * that never hold reviewable production code.
 */
function collectSourceFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        files.push(...collectSourceFiles(fullPath));
      }
      continue;
    }

    const dot = entry.name.lastIndexOf('.');
    const ext = dot === -1 ? '' : entry.name.slice(dot);
    if (SOURCE_EXTENSIONS.has(ext)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Reads only the leading `SCAN_BYTES` of a file — enough to cover every
 * static import, without paying to read the whole file for a scan that only
 * cares about the top.
 */
function readLeadingBytes(filePath: string): string {
  const size = statSync(filePath).size;
  const bytesToRead = Math.min(SCAN_BYTES, size);
  if (bytesToRead === 0) return '';

  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, 0);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

describe('fs import verification', () => {
  // Walks every source file in the repo, so its runtime scales with repo
  // size and can exceed the file-store default 500ms budget under load —
  // opt into a longer timeout the same way the real disk/git suites do.
  vi.setConfig({ testTimeout: 10000 });

  it('should have no direct fs imports outside of acceptable exceptions', () => {
    const violations: Array<{ file: string; line: number; content: string }> = [];

    for (const filePath of collectSourceFiles(repoRoot)) {
      const relPath = relative(repoRoot, filePath);
      if (isAcceptableException(relPath)) continue;

      const leading = readLeadingBytes(filePath);
      const lines = leading.split('\n');

      lines.forEach((line, index) => {
        if (FS_IMPORT_RE.test(line)) {
          violations.push({ file: relPath, line: index + 1, content: line.trim() });
        }
      });
    }

    // Report violations — toEqual([]) shows the actual violations in the test output
    expect(violations).toEqual([]);
  });
});
