import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWorkRoot, setWorkRoot, defaultWorkRoot } from "../src/workRootState.mjs";

function withTempWingRoot(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "session-context-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getWorkRoot defaults to <wingRoot>/work/local when no state recorded", () => {
  withTempWingRoot((wingRoot) => {
    assert.equal(getWorkRoot(wingRoot, "session-a"), defaultWorkRoot(wingRoot));
  });
});

test("setWorkRoot then getWorkRoot round-trips", () => {
  withTempWingRoot((wingRoot) => {
    const newRoot = path.join(wingRoot, "work", "minions");
    setWorkRoot(wingRoot, "session-a", newRoot);
    assert.equal(getWorkRoot(wingRoot, "session-a"), newRoot);
  });
});

test("work root state is isolated per session id", () => {
  withTempWingRoot((wingRoot) => {
    const newRoot = path.join(wingRoot, "work", "minions");
    setWorkRoot(wingRoot, "session-a", newRoot);
    assert.equal(getWorkRoot(wingRoot, "session-b"), defaultWorkRoot(wingRoot));
    assert.equal(getWorkRoot(wingRoot, "session-a"), newRoot);
  });
});
