import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moonbit } from "../src/plugin";
import { buildOnce, ensureMbti } from "../src/moon";
import { generateDts } from "../src/dts";
import { buildDir, findProject, resolveModule } from "../src/manifest";
import { LinkManifest, isFreshBySources } from "../src/link";

const moon = Bun.which("moon");
const fixture = path.resolve(import.meta.dir, "fixtures", "tiny");

describe.skipIf(!moon)("integration with real moon toolchain", () => {
  test(
    "empty _build is prepared by the plugin and runs through mbt import",
    async () => {
      const root = fs.mkdtempSync("/tmp/mbtplug-empty-build-");
      try {
        fs.copyFileSync(path.join(fixture, "moon.mod"), path.join(root, "moon.mod"));
        fs.cpSync(path.join(fixture, "lib"), path.join(root, "lib"), { recursive: true });
        fs.rmSync(path.join(root, "_build"), { recursive: true, force: true });
        const outdir = fs.mkdtempSync("/tmp/mbtplug-empty-build-out-");
        const result = await Bun.build({
          entrypoints: [path.resolve(import.meta.dir, "fixtures", "entry-tiny.ts")],
          outdir,
          plugins: [moonbit({ root, mode: "release" })],
        });
        expect(result.success).toBe(true);
        const proc = Bun.spawnSync(["bun", result.outputs[0]!.path]);
        expect(proc.exitCode).toBe(0);
        expect(proc.stdout.toString().trim()).toBe("4");
        console.log(`empty-build stdout: ${proc.stdout.toString().trim()}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "build → rsp freshness → dts → bundle via plugin → run",
    async () => {
      await buildOnce({ root: fixture, mode: "release" });
      await ensureMbti({ root: fixture, package: "mbtplug/tiny/lib", pkgDir: path.join(fixture, "lib") });

      const proj = findProject(fixture);
      const { candidatePaths, sourceDir } = resolveModule(proj, "mbtplug/tiny/lib");
      const artifact = candidatePaths.find((p) => fs.existsSync(p));
      expect(artifact).toBeTruthy();

      // single-package links get no rsp; multi-package ones do — accept either
      const link = LinkManifest.load(artifact!, buildDir(proj));
      const fresh = link ? link.isFresh() : isFreshBySources(artifact!, sourceDir);
      expect(fresh).toBe(true);

      const dts = generateDts({
        srcDir: sourceDir,
        buildDir: path.dirname(artifact!),
        moduleId: "mbt:mbtplug/tiny/lib",
      });
      expect(dts.contents).toContain("export class Point {");
      expect(dts.contents).toContain("constructor(x: number, y: number);");

      const outdir = fs.mkdtempSync("/tmp/mbtplug-e2e-");
      const result = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "fixtures", "entry-tiny.ts")],
        outdir,
        plugins: [moonbit({ root: fixture, mode: "release" })],
      });
      expect(result.success).toBe(true);

      const outfile = path.join(outdir, "entry-tiny.js");
      const proc = Bun.spawnSync(["bun", outfile]);
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString().trim()).toBe("4");
    },
    120_000,
  );
});
