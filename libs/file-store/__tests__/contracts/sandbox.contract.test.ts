/**
 * Contract tests for InMemorySandbox (OO Port)
 *
 * Runs the full OO contract test suite against the in-memory implementation.
 */

import { runSandboxContractTests } from "../../src/port/contracts.js";
import { InMemorySandbox } from "../../src/adapters/memory/InMemorySandbox.js";

runSandboxContractTests("InMemory", () => new InMemorySandbox());
