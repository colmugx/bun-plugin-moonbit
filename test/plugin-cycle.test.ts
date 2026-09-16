import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moonbit } from "../src/plugin";

type Fixture = {
  root: string;
  command: string;
  entry: string;
  calls: string;
};

type DtsFixture = Fixture & { dtsOut: string };

function makeFixture(mode: "debug" | "release" = "release"): Fixture {
  const root = fs.mkdtempSync("/tmp/mbtplug-cycle-");
  const command = path.join(root, "fake-moon.sh");
  const calls = path.join(root, "moon.calls");
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "moon.mod"), 'name = "cycle/test"\npreferred_target = "js"\n');
  fs.writeFileSync(
    path.join(root, "lib", "moon.pkg"),
    `options(\n  supported_targets: "+js",\n  link: {\n    "js": {\n      "format": "esm",\n      "exports": ["value"],\n    },\n  },\n)\n`,
  );
  fs.writeFileSync(path.join(root, "lib", "lib.mbt"), "pub fn value() -> Int { 1 }\n");
  const entry = path.join(root, "entry.ts");
  fs.writeFileSync(entry, 'import { value } from "mbt:cycle/test/lib"; console.log(value());\n');
  fs.writeFileSync(
    command,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$PWD/moon.calls"
if [ -f "$PWD/fail.once" ]; then
  rm "$PWD/fail.once"
  echo '{"$message_type":"diagnostic","level":"error","error_code":9001,"path":"lib/lib.mbt","loc":"1:1","message":"scripted failure"}'
  exit 17
fi
if [ "\${1:-}" = "info" ]; then
  exit 0
fi
case " $* " in
  *" -w "*)
    if [ -f "$PWD/watch.fail" ]; then exit 19; fi
    ;;
esac
value=$(sed -n 's/.*{ \\([0-9][0-9]*\\) }.*/\\1/p' "$PWD/lib/lib.mbt")
if [ -z "$value" ]; then value=1; fi
mkdir -p "$PWD/_build/js/${mode}/build/lib"
printf 'export function value() { return %s; }\\n' "$value" > "$PWD/_build/js/${mode}/build/lib/lib.js"
case " $* " in
  *" -w "*)
    if [ -f "$PWD/watch.hold" ]; then
      printf '%s\\n' "$$" > "$PWD/watch.pid"
      trap 'exit 0' INT TERM
      while true; do sleep 1; done
    fi
    ;;
esac
`,
  );
  fs.chmodSync(command, 0o755);
  return { root, command, entry, calls };
}

async function bundle(fixture: Fixture, mode: "debug" | "release", plugin = moonbit({ root: fixture.root, command: fixture.command, mode })) {
  const outdir = fs.mkdtempSync("/tmp/mbtplug-cycle-out-");
  const result = await Bun.build({ entrypoints: [fixture.entry], outdir, plugins: [plugin] });
  if (result.success) {
    const output = result.outputs[0];
    expect(output).toBeDefined();
    expect(fs.readFileSync(output!.path, "utf8")).toContain("return 1");
  }
  return result;
}

function callCount(fixture: Fixture): number {
  if (!fs.existsSync(fixture.calls)) return 0;
  return fs.readFileSync(fixture.calls, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function makeDtsFixture(): DtsFixture {
  const fixture = makeFixture();
  const dtsOut = path.join(fixture.root, "generated", "mbt.d.ts");
  fs.writeFileSync(
    fixture.command,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$PWD/moon.calls"
if [ "\${1:-}" = "info" ]; then
  if grep -q other "$PWD/lib/lib.mbt"; then
    printf 'pub fn value() -> Int\\npub fn other() -> Int\\n' > "$PWD/lib/pkg.generated.mbti"
  else
    printf 'pub fn value() -> Int\\n' > "$PWD/lib/pkg.generated.mbti"
  fi
  exit 0
fi
mkdir -p "$PWD/_build/js/release/build/lib"
if grep -q other "$PWD/lib/lib.mbt"; then
  printf 'export function value(): MoonBit.Int;\\nexport function other(): MoonBit.Int;\\n' > "$PWD/_build/js/release/build/lib/lib.d.ts"
else
  printf 'export function value(): MoonBit.Int;\\n' > "$PWD/_build/js/release/build/lib/lib.d.ts"
fi
printf 'export function value() { return 1; }\\n' > "$PWD/_build/js/release/build/lib/lib.js"
`,
  );
  fs.chmodSync(fixture.command, 0o755);
  fs.rmSync(path.join(fixture.root, "_build"), { recursive: true, force: true });
  return { ...fixture, dtsOut };
}

describe("moonbit plugin build cycles", () => {
  test("builds once per Bun.build cycle and observes changed MoonBit source", async () => {
    const fixture = makeFixture();
    try {
      const plugin = moonbit({ root: fixture.root, command: fixture.command, mode: "release" });
      expect((await bundle(fixture, "release", plugin)).success).toBe(true);
      expect(callCount(fixture)).toBe(1);

      fs.writeFileSync(path.join(fixture.root, "lib", "lib.mbt"), "pub fn value() -> Int { 2 }\n");
      const outdir = fs.mkdtempSync("/tmp/mbtplug-cycle-out-");
      const result = await Bun.build({ entrypoints: [fixture.entry], outdir, plugins: [plugin] });
      expect(result.success).toBe(true);
      expect(callCount(fixture)).toBe(2);
      expect(fs.readFileSync(result.outputs[0]!.path, "utf8")).toContain("return 2");
    } finally {
      cleanup(fixture);
    }
  });

  test("does not poison the next cycle after Moon fails", async () => {
    const fixture = makeFixture();
    try {
      fs.writeFileSync(path.join(fixture.root, "fail.once"), "retry\n");
      const plugin = moonbit({ root: fixture.root, command: fixture.command, mode: "release" });
      let firstFailed = false;
      try {
        await bundle(fixture, "release", plugin);
      } catch {
        firstFailed = true;
      }
      expect(firstFailed).toBe(true);
      const second = await bundle(fixture, "release", plugin);
      expect(second.success).toBe(true);
      expect(callCount(fixture)).toBe(2);
    } finally {
      cleanup(fixture);
    }
  });

  test("re-discovers the module manifest for every build cycle", async () => {
    const fixture = makeFixture();
    try {
      const plugin = moonbit({ root: fixture.root, command: fixture.command, mode: "release" });
      expect((await bundle(fixture, "release", plugin)).success).toBe(true);
      fs.writeFileSync(path.join(fixture.root, "moon.mod"), 'name = "cycle/updated"\npreferred_target = "js"\n');
      fs.writeFileSync(fixture.entry, 'import { value } from "mbt:cycle/updated/lib"; console.log(value());\n');
      const outdir = fs.mkdtempSync("/tmp/mbtplug-cycle-out-");
      const result = await Bun.build({ entrypoints: [fixture.entry], outdir, plugins: [plugin] });
      expect(result.success).toBe(true);
      expect(callCount(fixture)).toBe(2);
    } finally {
      cleanup(fixture);
    }
  });

  test("preload prepares a real Bun.plugin runtime import before registration", () => {
    const fixture = makeFixture();
    try {
      fs.rmSync(path.join(fixture.root, "_build"), { recursive: true, force: true });
      const moonOnPath = path.join(fixture.root, "moon");
      fs.copyFileSync(fixture.command, moonOnPath);
      fs.chmodSync(moonOnPath, 0o755);
      const runtime = path.join(fixture.root, "runtime.ts");
      const entry = path.join(fixture.root, "runtime-entry.ts");
      const preloadPath = path.resolve(import.meta.dir, "..", "src", "preload.ts");
      fs.writeFileSync(entry, 'import { value } from "mbt:cycle/test/lib"; console.log(value());\n');
      fs.writeFileSync(
        runtime,
        `process.env.MOONBIT_ROOT = ${JSON.stringify(fixture.root)};
process.env.MOONBIT_MODE = "release";
process.env.MOONBIT_WATCH = "0";
process.env.PATH = ${JSON.stringify(fixture.root)} + ":" + (process.env.PATH ?? "");
await import(${JSON.stringify(preloadPath)});
await import("./runtime-entry.ts");
`,
      );
      const proc = Bun.spawnSync([process.execPath, runtime], { cwd: fixture.root });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString().trim()).toBe("1");
      expect(callCount(fixture)).toBe(1);
    } finally {
      cleanup(fixture);
    }
  });

  test("runtime resolution without prepare fails fast", () => {
    const fixture = makeFixture();
    try {
      const runtime = path.join(fixture.root, "runtime-unprepared.ts");
      const entry = path.join(fixture.root, "runtime-entry.ts");
      const pluginPath = path.resolve(import.meta.dir, "..", "src", "plugin.ts");
      fs.writeFileSync(entry, 'import { value } from "mbt:cycle/test/lib"; console.log(value());\n');
      fs.writeFileSync(
        runtime,
        `import { moonbit } from ${JSON.stringify(pluginPath)};
Bun.plugin(moonbit({ root: ${JSON.stringify(fixture.root)}, command: ${JSON.stringify(fixture.command)}, mode: "release", watch: false }));
await import("./runtime-entry.ts");
`,
      );
      const proc = Bun.spawnSync([process.execPath, runtime], { cwd: fixture.root });
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("await plugin.prepare()");
      expect(callCount(fixture)).toBe(0);
    } finally {
      cleanup(fixture);
    }
  });

  test("preload defaults to release without a watcher for ordinary runtime", () => {
    const fixture = makeFixture();
    try {
      const moonOnPath = path.join(fixture.root, "moon");
      fs.copyFileSync(fixture.command, moonOnPath);
      fs.chmodSync(moonOnPath, 0o755);
      const runtime = path.join(fixture.root, "preload-ordinary.ts");
      const preloadPath = path.resolve(import.meta.dir, "..", "src", "preload.ts");
      fs.writeFileSync(
        runtime,
        `delete process.env.MOONBIT_MODE;
delete process.env.MOONBIT_WATCH;
process.env.MOONBIT_ROOT = ${JSON.stringify(fixture.root)};
process.env.PATH = ${JSON.stringify(fixture.root)} + ":" + (process.env.PATH ?? "");
const preload = await import(${JSON.stringify(preloadPath)});
await preload.default.dispose();
`,
      );
      const proc = Bun.spawnSync([process.execPath, runtime], { cwd: fixture.root });
      expect(proc.exitCode).toBe(0);
      expect(fs.readFileSync(fixture.calls, "utf8").trim()).toBe("build --target js --release --output-json");
    } finally {
      cleanup(fixture);
    }
  });

  test("preload enables watch only for hot/watch argv and disposes it", () => {
    const fixture = makeFixture();
    try {
      const moonOnPath = path.join(fixture.root, "moon");
      fs.copyFileSync(fixture.command, moonOnPath);
      fs.chmodSync(moonOnPath, 0o755);
      fs.writeFileSync(path.join(fixture.root, "watch.hold"), "hold\n");
      const runtime = path.join(fixture.root, "preload-watch.ts");
      const preloadPath = path.resolve(import.meta.dir, "..", "src", "preload.ts");
      fs.writeFileSync(
        runtime,
        `delete process.env.MOONBIT_MODE;
delete process.env.MOONBIT_WATCH;
process.env.MOONBIT_ROOT = ${JSON.stringify(fixture.root)};
process.env.PATH = ${JSON.stringify(fixture.root)} + ":" + (process.env.PATH ?? "");
const preload = await import(${JSON.stringify(preloadPath)});
await preload.default.dispose();
`,
      );
      for (const flag of ["--hot", "--watch"]) {
        const proc = Bun.spawnSync([process.execPath, runtime, flag], { cwd: fixture.root });
        expect(proc.exitCode).toBe(0);
      }
      const calls = fs.readFileSync(fixture.calls, "utf8").trim().split(/\r?\n/);
      expect(calls.length).toBe(4);
      expect(calls.filter((line) => line.includes("-w --output-json")).length).toBe(2);
    } finally {
      cleanup(fixture);
    }
  });

  test("preload rejects invalid watch env values", () => {
    const fixture = makeFixture();
    try {
      const runtime = path.join(fixture.root, "preload-invalid.ts");
      const preloadPath = path.resolve(import.meta.dir, "..", "src", "preload.ts");
      fs.writeFileSync(
        runtime,
        `process.env.MOONBIT_ROOT = ${JSON.stringify(fixture.root)};
process.env.MOONBIT_WATCH = "yes";
await import(${JSON.stringify(preloadPath)});
`,
      );
      const proc = Bun.spawnSync([process.execPath, runtime], { cwd: fixture.root });
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("invalid MOONBIT_WATCH");
      expect(callCount(fixture)).toBe(0);
    } finally {
      cleanup(fixture);
    }
  });

  test("selects the debug artifact tree and omits release", async () => {
    const fixture = makeFixture("debug");
    try {
      const result = await bundle(fixture, "debug");
      expect(result.success).toBe(true);
      const args = fs.readFileSync(fixture.calls, "utf8");
      expect(args).toContain("build --target js --output-json");
      expect(args).not.toContain("--release");
    } finally {
      cleanup(fixture);
    }
  });

  test("watch mode builds before starting its persistent watcher", async () => {
    const fixture = makeFixture();
    try {
      const artifact = path.join(fixture.root, "_build", "js", "release", "build", "lib", "lib.js");
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, "export function value() { return 0; }\n");
      const result = await Bun.build({
        entrypoints: [fixture.entry],
        outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"),
        plugins: [moonbit({ root: fixture.root, command: fixture.command, mode: "release", watch: true })],
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(result.outputs[0]!.path, "utf8")).toContain("return 1");
      const calls = fs.readFileSync(fixture.calls, "utf8").trim().split(/\r?\n/);
      expect(calls.length).toBe(2);
      expect(calls[0]).toBe("build --target js --release --output-json");
      expect(calls[1]).toBe("build --target js --release -w --output-json");
      await Bun.sleep(100);
    } finally {
      cleanup(fixture);
    }
  });

  test("watch child failures reject the current cycle", async () => {
    const fixture = makeFixture();
    try {
      fs.writeFileSync(path.join(fixture.root, "watch.fail"), "fail\n");
      let failed = false;
      try {
        await Bun.build({
          entrypoints: [fixture.entry],
          outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"),
          plugins: [moonbit({ root: fixture.root, command: fixture.command, mode: "release", watch: true })],
        });
      } catch (error) {
        failed = error instanceof Error && /moon --watch exited with code 19/.test(error.message);
      }
      expect(failed).toBe(true);
      expect(fs.readFileSync(fixture.calls, "utf8")).toContain("-w --output-json");
    } finally {
      cleanup(fixture);
    }
  });

  test("dispose tears down a watcher and the next cycle can recover", async () => {
    const fixture = makeFixture();
    const plugin = moonbit({ root: fixture.root, command: fixture.command, mode: "release", watch: true });
    try {
      fs.writeFileSync(path.join(fixture.root, "watch.hold"), "hold\n");
      const first = await Bun.build({
        entrypoints: [fixture.entry],
        outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"),
        plugins: [plugin],
      });
      expect(first.success).toBe(true);
      const pid = Number(fs.readFileSync(path.join(fixture.root, "watch.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();

      await plugin.dispose();
      await Bun.sleep(100);
      let stopped = false;
      try {
        process.kill(pid, 0);
      } catch {
        stopped = true;
      }
      expect(stopped).toBe(true);

      fs.rmSync(path.join(fixture.root, "watch.hold"), { force: true });
      const second = await Bun.build({
        entrypoints: [fixture.entry],
        outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"),
        plugins: [plugin],
      });
      expect(second.success).toBe(true);
      expect(callCount(fixture)).toBe(4);
    } finally {
      await plugin.dispose();
      cleanup(fixture);
    }
  });

  test("refreshes declarations per cycle and preserves unchanged output mtime", async () => {
    const fixture = makeDtsFixture();
    try {
      const plugin = moonbit({
        root: fixture.root,
        command: fixture.command,
        mode: "release",
        dts: { out: fixture.dtsOut },
      });
      expect((await Bun.build({ entrypoints: [fixture.entry], outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"), plugins: [plugin] })).success).toBe(true);
      const first = fs.readFileSync(fixture.dtsOut, "utf8");
      expect(first).toContain("export function value(): number;");
      expect(first).not.toContain("export function other(): number;");

      await Bun.sleep(100);
      fs.writeFileSync(path.join(fixture.root, "lib", "lib.mbt"), "pub fn value() -> Int { 2 }\npub fn other() -> Int { 3 }\n");
      fs.writeFileSync(
        path.join(fixture.root, "lib", "moon.pkg"),
        `options(\n  supported_targets: "+js",\n  link: {\n    "js": {\n      "format": "esm",\n      "exports": ["value", "other"],\n    },\n  },\n)\n`,
      );
      const second = await Bun.build({ entrypoints: [fixture.entry], outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"), plugins: [plugin] });
      expect(second.success).toBe(true);
      const refreshed = fs.readFileSync(fixture.dtsOut, "utf8");
      expect(refreshed).toContain("export function other(): number;");

      const mtime = fs.statSync(fixture.dtsOut).mtimeMs;
      await Bun.sleep(100);
      const third = await Bun.build({ entrypoints: [fixture.entry], outdir: fs.mkdtempSync("/tmp/mbtplug-cycle-out-"), plugins: [plugin] });
      expect(third.success).toBe(true);
      expect(fs.statSync(fixture.dtsOut).mtimeMs).toBe(mtime);
    } finally {
      cleanup(fixture);
    }
  });
});
