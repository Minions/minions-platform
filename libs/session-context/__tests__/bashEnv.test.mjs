import { test } from "node:test";
import assert from "node:assert/strict";
import { toGitBashPath, buildBashPreamble } from "../src/bashEnv.mjs";

test("toGitBashPath converts backslash drive form", () => {
  assert.equal(toGitBashPath("D:\\_Lairs\\coaching-nabu"), "/d/_Lairs/coaching-nabu");
});

test("toGitBashPath converts forward-slash drive form", () => {
  assert.equal(toGitBashPath("D:/_Lairs/coaching-nabu"), "/d/_Lairs/coaching-nabu");
});

test("toGitBashPath leaves already-posix paths unchanged", () => {
  assert.equal(toGitBashPath("/d/_Lairs/coaching-nabu"), "/d/_Lairs/coaching-nabu");
});

test("buildBashPreamble exports both env vars and cds into work root", () => {
  const preamble = buildBashPreamble({
    wingRoot: "D:\\wing",
    workRoot: "D:\\wing\\work\\local",
  });
  assert.match(preamble, /export WING_ROOT="\/d\/wing" WORK_ROOT="\/d\/wing\/work\/local"/);
  assert.match(preamble, /cd "\/d\/wing\/work\/local" &&/);
});
