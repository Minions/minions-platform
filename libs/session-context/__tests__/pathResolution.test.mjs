import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAbsolutePath, resolvePathForTool } from "../src/pathResolution.mjs";

const wingRoot = "D:\\_Lairs\\coaching-nabu\\wings\\tooling-01";
const workRoot = "D:\\_Lairs\\coaching-nabu\\wings\\tooling-01\\work\\local\\sharing-keystones";

// Hermetic fixture, independent of this repo's real disk layout: a temp dir
// standing in for wingRoot, with a real top-level file and a real work-root
// subtree, so existsSync-dependent branches are tested against known state.
function makeFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "path-resolution-test-"));
  const fixtureWorkRoot = path.join(fixtureRoot, "work", "local");
  fs.mkdirSync(fixtureWorkRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "CLAUDE.md"), "wing-root CLAUDE.md");
  fs.mkdirSync(path.join(fixtureWorkRoot, "sharing-keystones"), { recursive: true });
  fs.writeFileSync(path.join(fixtureWorkRoot, "sharing-keystones", "CLAUDE.md"), "work-root CLAUDE.md");
  return { fixtureRoot, fixtureWorkRoot };
}

test("isAbsolutePath recognizes all three Windows forms", () => {
  assert.equal(isAbsolutePath("D:\\foo\\bar"), true);
  assert.equal(isAbsolutePath("D:/foo/bar"), true);
  assert.equal(isAbsolutePath("/d/foo/bar"), true);
  assert.equal(isAbsolutePath("relative/path"), false);
});

test("wing-root-sibling leading segments resolve against wing root, not work root", () => {
  for (const p of ["work/minions/libs", "private/local/notes.md", "info/x", "closet/y", ".claude/settings.json", ".mcp.json", ".playwright/output/x.log"]) {
    const resolved = resolvePathForTool(p, { wingRoot, workRoot });
    assert.ok(resolved.startsWith(wingRoot), `${p} -> ${resolved} should start with wingRoot`);
  }
});

test("substring collision: work-utils/foo is NOT treated as a work/ prefix", () => {
  const resolved = resolvePathForTool("work-utils/foo.ts", { wingRoot, workRoot });
  assert.ok(resolved.startsWith(workRoot), `expected work-root-relative, got ${resolved}`);
  assert.ok(!resolved.startsWith(wingRoot + "\\work-utils"), "must not have been wing-root-prefixed as a sibling");
});

test("bare relative path resolves against current work root", () => {
  const resolved = resolvePathForTool("packages/author-packets/src/Packet.ts", { wingRoot, workRoot });
  assert.ok(resolved.startsWith(workRoot));
});

test("absolute path outside wing root entirely passes through unchanged", () => {
  const abs = "C:\\Users\\someone\\Desktop\\notes.md";
  assert.equal(resolvePathForTool(abs, { wingRoot, workRoot }), abs);
});

test("empty/undefined input passes through rather than guessing", () => {
  assert.equal(resolvePathForTool("", { wingRoot, workRoot }), "");
  assert.equal(resolvePathForTool(undefined, { wingRoot, workRoot }), undefined);
});

test("absolute path already under work root passes through unchanged", () => {
  const { fixtureRoot, fixtureWorkRoot } = makeFixture();
  try {
    const abs = path.join(fixtureWorkRoot, "sharing-keystones", "CLAUDE.md");
    assert.equal(resolvePathForTool(abs, { wingRoot: fixtureRoot, workRoot: fixtureWorkRoot }), abs);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("absolute path under wing root that genuinely exists there is left alone, even without a WING_ROOT_SIBLINGS match", () => {
  const { fixtureRoot, fixtureWorkRoot } = makeFixture();
  try {
    const abs = path.join(fixtureRoot, "CLAUDE.md"); // real file at wing root, no wing-root-sibling prefix
    assert.equal(resolvePathForTool(abs, { wingRoot: fixtureRoot, workRoot: fixtureWorkRoot }), abs);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("bare relative CLAUDE.md resolves against work root, not wing root", () => {
  // work/local has its own CLAUDE.md; a bare relative "CLAUDE.md" must mean
  // that one, not the wing root's — CLAUDE.md is deliberately excluded from
  // WING_ROOT_SIBLINGS for this reason.
  const resolved = resolvePathForTool("CLAUDE.md", { wingRoot, workRoot });
  assert.ok(resolved.startsWith(workRoot), `expected work-root-relative, got ${resolved}`);
});

test("harness pre-resolved-against-wing-root bug: absolute path under wing root that does NOT exist there, and isn't a sibling prefix, is re-rooted under work root", () => {
  const { fixtureRoot, fixtureWorkRoot } = makeFixture();
  try {
    // Simulates the harness turning a model's relative Read("sharing-keystones/CLAUDE.md")
    // into file_path=<wingRoot>/sharing-keystones/CLAUDE.md before the hook runs.
    const wrongAbs = path.join(fixtureRoot, "sharing-keystones", "CLAUDE.md");
    assert.ok(!fs.existsSync(wrongAbs), "fixture invariant: must not exist at the wrong location");
    const resolved = resolvePathForTool(wrongAbs, { wingRoot: fixtureRoot, workRoot: fixtureWorkRoot });
    const expected = path.join(fixtureWorkRoot, "sharing-keystones", "CLAUDE.md");
    assert.equal(resolved, expected);
    assert.ok(fs.existsSync(resolved), "corrected path must actually exist");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("absolute path to a brand-new (not-yet-existing) file under a real wing-root sibling is left alone, not re-rooted", () => {
  const { fixtureRoot, fixtureWorkRoot } = makeFixture();
  try {
    // Simulates Write("<wingRoot>/work/minions/libs/x/new-file.mjs") — a
    // legitimate absolute path under a DIFFERENT real work root (work/minions,
    // not the current session's work/local) that doesn't exist yet because
    // it's being created. Must not be misdiagnosed as the harness's
    // pre-resolution bug and re-rooted under the current workRoot instead.
    const brandNewUnderSibling = path.join(fixtureRoot, "work", "minions", "libs", "x", "new-file.mjs");
    assert.ok(!fs.existsSync(brandNewUnderSibling), "fixture invariant: must not exist yet");
    const resolved = resolvePathForTool(brandNewUnderSibling, { wingRoot: fixtureRoot, workRoot: fixtureWorkRoot });
    assert.equal(resolved, brandNewUnderSibling, "must be left unchanged, not re-rooted under workRoot");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("re-rooting preserves original casing (not lowercased)", () => {
  const { fixtureRoot, fixtureWorkRoot } = makeFixture();
  try {
    const wrongAbs = path.join(fixtureRoot, "Sharing-Keystones", "CLAUDE.md");
    const resolved = resolvePathForTool(wrongAbs, { wingRoot: fixtureRoot, workRoot: fixtureWorkRoot });
    assert.ok(resolved.includes("Sharing-Keystones"), `expected original casing preserved, got ${resolved}`);
    assert.ok(!resolved.includes("sharing-keystones") || resolved.includes("Sharing-Keystones"), "must not be lowercased");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
