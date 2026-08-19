import { describe, it, expect, expectTypeOf } from "vitest";
import { asWingName, asRepoAlias, asLairRepoName, asRepoId } from "./brandedIds.js";
import type { WingName, RepoAlias, LairRepoName, RepoId } from "./brandedIds.js";

describe("branded repo/wing identity constructors", () => {
  it("asWingName does no validation, just brands the string", () => {
    expect(asWingName("workshop-01")).toBe("workshop-01");
  });

  it("asRepoAlias brands a given string unchanged", () => {
    expect(asRepoAlias("named")).toBe("named");
  });

  it("asRepoAlias defaults to \"local\" when missing or blank", () => {
    expect(asRepoAlias(undefined)).toBe("local");
    expect(asRepoAlias("  ")).toBe("local");
  });

  it("asLairRepoName brands a given string unchanged", () => {
    expect(asLairRepoName("minions")).toBe("minions");
  });

  it("asLairRepoName throws when missing or blank — no valid default exists", () => {
    expect(() => asLairRepoName(undefined)).toThrow();
    expect(() => asLairRepoName("")).toThrow();
    expect(() => asLairRepoName("   ")).toThrow();
  });

  it("asRepoId does no validation, just brands the string", () => {
    expect(asRepoId("github.com/foo/bar")).toBe("github.com/foo/bar");
  });

  it("branded types are structurally distinct at the type level", () => {
    const wingName: WingName = asWingName("w");
    const repoAlias: RepoAlias = asRepoAlias("local");
    const lairRepoName: LairRepoName = asLairRepoName("local");
    const repoId: RepoId = asRepoId("id");

    expectTypeOf(wingName).not.toEqualTypeOf<RepoAlias>();
    expectTypeOf(repoAlias).not.toEqualTypeOf<LairRepoName>();
    expectTypeOf(lairRepoName).not.toEqualTypeOf<RepoId>();
    expectTypeOf(repoId).not.toEqualTypeOf<WingName>();

    // Every branded kind is still assignable to plain string (wire/storage form).
    expectTypeOf(wingName).toMatchTypeOf<string>();
    expectTypeOf(repoAlias).toMatchTypeOf<string>();
    expectTypeOf(lairRepoName).toMatchTypeOf<string>();
    expectTypeOf(repoId).toMatchTypeOf<string>();
  });
});
