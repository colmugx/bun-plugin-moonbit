import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildDir, findProject, matchMember, resolveModule } from "../src/manifest";

const fixtures = path.resolve(import.meta.dir, "fixtures");

describe("findProject", () => {
  test("workspace: members, sources, build dir", () => {
    const info = findProject(path.join(fixtures, "proj", "b"));
    expect(info.isWorkspace).toBe(true);
    expect(info.root).toBe(path.join(fixtures, "proj"));
    expect(info.members.map((m) => m.name).sort()).toEqual(["ex/a", "ex/b"]);
    const a = info.members.find((m) => m.name === "ex/a")!;
    expect(a.source).toBe("src");
    expect(buildDir(info)).toBe(path.join(fixtures, "proj", "_build", "js", "release", "build"));
  });

  test("single module: flat layout", () => {
    const info = findProject(path.join(fixtures, "single"));
    expect(info.isWorkspace).toBe(false);
    expect(info.members[0]!.name).toBe("solo/mod");
    const { candidatePaths } = resolveModule(info, "solo/mod/pkg");
    expect(candidatePaths[0]).toBe(
      path.join(fixtures, "single", "_build", "js", "release", "build", "pkg", "pkg.js"),
    );
  });

  test("an ancestor workspace cannot claim an unlisted nearer module", () => {
    const info = findProject(path.join(fixtures, "tiny", "lib"));
    expect(info.isWorkspace).toBe(false);
    expect(info.root).toBe(path.join(fixtures, "tiny"));
    expect(info.members[0]!.name).toBe("mbtplug/tiny");
  });

  test("workspace applicability follows the nearest module membership", () => {
    const root = fs.mkdtempSync("/tmp/mbtplug-manifest-");
    const member = path.join(root, "member");
    const outsider = path.join(root, "outsider");
    try {
      fs.mkdirSync(path.join(member, "src"), { recursive: true });
      fs.mkdirSync(outsider, { recursive: true });
      fs.writeFileSync(path.join(root, "moon.work"), 'members = ["./member"]\n');
      fs.writeFileSync(path.join(member, "moon.mod"), 'name = "workspace/member"\n');
      fs.writeFileSync(path.join(outsider, "moon.mod"), 'name = "standalone/outsider"\n');

      const applicable = findProject(path.join(member, "src"));
      expect(applicable.isWorkspace).toBe(true);
      expect(applicable.root).toBe(root);

      const standalone = findProject(outsider);
      expect(standalone.isWorkspace).toBe(false);
      expect(standalone.root).toBe(outsider);
      expect(standalone.members[0]!.name).toBe("standalone/outsider");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws outside any project", () => {
    expect(() => findProject("/")).toThrow(/no moon\.work or moon\.mod/);
  });
});

describe("resolveModule", () => {
  const info = findProject(path.join(fixtures, "proj"));

  test("multi-member workspace nests the module name first", () => {
    const { candidatePaths, sourceDir } = resolveModule(info, "ex/a/lib");
    expect(candidatePaths[0]).toBe(
      path.join(fixtures, "proj", "_build", "js", "release", "build", "ex", "a", "lib", "lib.js"),
    );
    expect(sourceDir).toBe(path.join(fixtures, "proj", "a", "src", "lib"));
  });

  test("member root package resolves without extra segments", () => {
    const { candidatePaths } = resolveModule(info, "ex/b");
    expect(candidatePaths[0]).toBe(
      path.join(fixtures, "proj", "_build", "js", "release", "build", "ex", "b", "b.js"),
    );
  });

  test("debug mode resolves from the debug artifact tree", () => {
    const { candidatePaths } = resolveModule(info, "ex/a/lib", "js", "debug");
    expect(candidatePaths[0]).toBe(
      path.join(fixtures, "proj", "_build", "js", "debug", "build", "ex", "a", "lib", "lib.js"),
    );
  });

  test("unknown member throws with member list", () => {
    expect(() => resolveModule(info, "nope/x")).toThrow(/does not match any workspace member/);
  });

  test("matchMember picks the longest prefix", () => {
    expect(matchMember(info, "ex/a/lib/deep")!.name).toBe("ex/a");
    expect(matchMember(info, "ex/other")).toBeNull();
  });
});
