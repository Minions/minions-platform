import { describe, it, expect } from "vitest";
import { samePath } from "./repoIdentity.js";

describe("samePath", () => {
  it("treats identical paths as the same", () => {
    expect(samePath("/a/b/c", "/a/b/c")).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "treats paths differing only by separator style as the same on win32",
    () => {
      expect(samePath("a/b/c", "a\\b\\c")).toBe(true);
    }
  );

  it.runIf(process.platform !== "win32")(
    "treats a backslash as an ordinary filename character off win32",
    () => {
      expect(samePath("a/b/c", "a\\b\\c")).toBe(false);
    }
  );

  it("treats genuinely different paths as different", () => {
    expect(samePath("/a/b/c", "/a/b/d")).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "treats paths differing only in case as the same on win32 (git can report either drive-letter case)",
    () => {
      expect(samePath("D:\\lair\\cabinet\\planning\\repo", "d:\\lair\\cabinet\\planning\\repo")).toBe(true);
    }
  );

  it.runIf(process.platform !== "win32")(
    "treats paths differing only in case as different off win32",
    () => {
      expect(samePath("/lair/Cabinet", "/lair/cabinet")).toBe(false);
    }
  );
});
