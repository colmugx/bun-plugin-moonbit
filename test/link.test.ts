import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LinkManifest } from "../src/link";

function makeFixture() {
  const dir = fs.mkdtempSync("/tmp/mbtplug-link-");
  const buildDir = path.join(dir, "build", "ex", "a");
  fs.mkdirSync(path.join(buildDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(buildDir, "dep"), { recursive: true });
  const coreA = path.join(buildDir, "lib", "lib.core");
  const coreB = path.join(buildDir, "dep", "dep.core");
  fs.writeFileSync(coreA, "core");
  fs.writeFileSync(coreB, "core");
  const artifact = path.join(buildDir, "lib", "lib.js");
  fs.writeFileSync(artifact + ".rsp", `link-core\n${coreA}\n${coreB}\n`);
  return { dir, buildDir: path.join(dir, "build"), artifact, coreA, coreB };
}

describe("LinkManifest", () => {
  test("parses package ids from rsp and checks freshness", () => {
    const f = makeFixture();
    const link = LinkManifest.load(f.artifact, f.buildDir)!;
    expect(link).not.toBeNull();
    expect(link.containsPackage("ex/a/lib")).toBe(true);
    expect(link.containsPackage("ex/a/dep")).toBe(true);
    expect(link.containsPackage("ex/a/missing")).toBe(false);

    expect(link.isFresh()).toBe(false); // no artifact yet
    fs.writeFileSync(f.artifact, "js");
    expect(link.isFresh()).toBe(true);

    // a rebuilt input core must invalidate the artifact
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(f.coreB, future, future);
    expect(link.isFresh()).toBe(false);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  test("returns null without an rsp", () => {
    const dir = fs.mkdtempSync("/tmp/mbtplug-link-");
    const artifact = path.join(dir, "lib.js");
    fs.writeFileSync(artifact, "js");
    expect(LinkManifest.load(artifact, dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
