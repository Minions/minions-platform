/**
 * Contract tests for Lair with InMemorySandbox
 *
 * Runs the full Lair contract test suite against an in-memory sandbox.
 */

import { runLairContractTests } from "../../src/lair/lair-contracts.js";
import { createLair } from "../../src/lair/LairImpl.js";
import { InMemorySandbox } from "../../src/adapters/memory/InMemorySandbox.js";

runLairContractTests("InMemory", () => {
  const sandbox = new InMemorySandbox("test-lair");
  return createLair(sandbox);
});
