import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { wingRootFromScriptLocation } from "../src/wingRoot.mjs";

test("depth 2 resolves a .claude/hooks script back to wing root", () => {
  const scriptDir = path.join("D:", "wing", ".claude", "hooks");
  assert.equal(wingRootFromScriptLocation(scriptDir, 2), path.join("D:", "wing"));
});

test("depth 5 resolves a sharing-keystones/.meta/workflow script back to wing root", () => {
  const scriptDir = path.join("D:", "wing", "work", "local", "sharing-keystones", ".meta", "workflow");
  assert.equal(wingRootFromScriptLocation(scriptDir, 5), path.join("D:", "wing"));
});

test("depth 3 resolves the same workflow script location to work root (work/local)", () => {
  const scriptDir = path.join("D:", "wing", "work", "local", "sharing-keystones", ".meta", "workflow");
  assert.equal(wingRootFromScriptLocation(scriptDir, 3), path.join("D:", "wing", "work", "local"));
});

test("depth 0 is a no-op", () => {
  const scriptDir = path.join("D:", "wing", "anywhere");
  assert.equal(wingRootFromScriptLocation(scriptDir, 0), scriptDir);
});
