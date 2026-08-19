/**
 * Shared helpers for disk/git-backed test suites.
 *
 * These suites shell out to a real `git` binary, unlike the package's other
 * (in-memory) tests, so they need more timeout headroom and a retrying
 * cleanup for Windows' occasionally-slow-to-release temp directories.
 */
import { vi } from "vitest";
import { rmSync } from "fs";
import {
  execSync as nodeExecSync,
  type ExecSyncOptions,
  type ExecSyncOptionsWithBufferEncoding,
  type ExecSyncOptionsWithStringEncoding,
} from "child_process";

/**
 * `execSync` wrapper for these git-backed test suites. Node's `execSync`
 * inherits the child's stderr to the parent process by default (unlike plain
 * `exec`/`execFile`) unless `stdio` is explicitly given — so every git
 * informational message (clone/worktree notices, CRLF warnings) prints
 * straight to the test runner's console. Passing a fully-piped `stdio` here
 * captures it instead; failures still surface normally, since the captured
 * stderr is included on the thrown error the same as with inherited stdio.
 *
 * Overloaded (mirroring Node's own `execSync`) so callers that pass
 * `encoding` still get a `string` back instead of a `Buffer`.
 */
export function execSync(command: string, options: ExecSyncOptionsWithStringEncoding): string;
export function execSync(command: string, options?: ExecSyncOptionsWithBufferEncoding): Buffer;
export function execSync(command: string, options: ExecSyncOptions = {}): string | Buffer {
  return nodeExecSync(command, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Opts the calling test file into a longer timeout for real git operations.
 * Call once at file scope — vi.setConfig applies per test file, so sibling
 * in-memory suites sharing the same contract-test bodies are unaffected.
 * Covers both testTimeout (individual it()s) and hookTimeout (beforeAll/
 * beforeEach etc., which default to a separate, shorter 10s ceiling and can
 * be exceeded by template/fixture setup under load even when only tests
 * themselves were bumped).
 */
export function useRealGitTimeout(ms = 30000): void {
  vi.setConfig({ testTimeout: ms, hookTimeout: ms });
}

/**
 * Removes a directory, retrying on failure — Windows can hold a brief lock
 * on files a just-finished git process touched.
 */
export async function rmRetry(dir: string, retries = 5, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
