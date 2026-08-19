/**
 * Contract tests for Lair with DiskSandbox
 *
 * Runs the full Lair contract test suite against a disk sandbox.
 * Uses temporary directories for isolation.
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLairContractTests } from "../../src/lair/lair-contracts.js";
import { createLair } from "../../src/lair/LairImpl.js";
import { DiskSandbox } from "../../src/adapters/disk/DiskSandbox.js";
import { useRealGitTimeout, rmRetry } from "../disk-test-helpers.js";

// Real disk/git-backed: shells out to git for every worktree/commit
// operation, unlike the InMemory sibling suite that runs the same contract
// tests. Needs more headroom than the package's fast default.
useRealGitTimeout();

let tmpDir: string;

runLairContractTests(
  "Disk",
  () => {
    // Lair name will be derived from the temp directory basename
    tmpDir = mkdtempSync(join(tmpdir(), "lair-test-"));
    const sandbox = new DiskSandbox(tmpDir);
    return createLair(sandbox);
  },
  async () => {
    if (tmpDir) {
      await rmRetry(tmpDir);
    }
  }
);
