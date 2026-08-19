/**
 * Contract tests for DiskSandbox (OO Port)
 *
 * Runs the OO contract test suite against the disk implementation.
 * Uses temporary directories for isolation.
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSandboxContractTests } from "../../src/port/contracts.js";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import { useRealGitTimeout, rmRetry } from "../disk-test-helpers.js";

// Real disk/git-backed: shells out to git for every operation, unlike the
// InMemory sibling suite that runs the same contract tests. Needs more
// headroom than the package's fast default.
useRealGitTimeout();

let tmpDir: string;

runSandboxContractTests(
  "Disk",
  () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    return new DiskSandbox(tmpDir);
  },
  async () => {
    if (tmpDir) {
      await rmRetry(tmpDir);
    }
  },
  { skipNetworkTests: true }
);
