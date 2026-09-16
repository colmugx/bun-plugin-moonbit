import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { BunPlugin } from "bun";
import { findProject, resolveModule, type ProjectInfo } from "./manifest";
import { buildOnce, ensureMbti, ensureMbtiSync } from "./moon";
import { generateDts } from "./dts";

export interface MoonbitPluginOptions {
  /** Directory to start MoonBit project discovery from (default: cwd). */
  root?: string;
  mode?: "debug" | "release";
  /**
   * Dev mode: keep a persistent `moon build --watch` running and wait for its
   * first artifact. Pairs with `bun --hot`, which re-evaluates the artifact on
   * rebuilds.
   */
  watch?: boolean;
  /** moon executable (default: "moon"). */
  command?: string;
  /**
   * Generate a .d.ts for each resolved module next to bundling, from
   * moon-generated sources (moon.pkg + pkg.generated.mbti + lib.d.ts).
   */
  dts?: {
    out: string;
    /** Package source dir override (default: resolved from the mbt: id). */
    srcDir?: string;
    /** JS shapes for #external FFI types; missing entries fail the build. */
    externPolicy?: Record<string, string>;
  };
}

export interface MoonbitPlugin extends BunPlugin {
  /** Run and await one Moon preparation cycle before runtime registration. */
  prepare(): Promise<void>;
  /** Stop a persistent watch child owned by this plugin instance. */
  dispose(): Promise<void>;
}

interface BuildCycle {
  project: ProjectInfo;
  promise: Promise<void>;
  status: "pending" | "fulfilled" | "rejected";
  error: Error | null;
  dtsSections: Map<string, string>;
  dtsPromises: Map<string, Promise<void>>;
  dtsWrite: Promise<void>;
}

const WATCH_START_GRACE_MS = 50;

export function moonbit(options: MoonbitPluginOptions = {}): MoonbitPlugin {
  const mode = options.mode ?? "release";
  let watchChild: ChildProcess | null = null;
  let watchCleanup: (() => void) | null = null;
  let watchClose: Promise<void> | null = null;
  let preparedCycle: BuildCycle | null = null;

  function noArtifactError(id: string, candidates: string[], sourceDir: string): Error {
    const pkgFile = ["moon.pkg", "moon.pkg.json"]
      .map((n) => path.join(sourceDir, n))
      .find((p) => fs.existsSync(p));
    const pkgText = pkgFile ? fs.readFileSync(pkgFile, "utf8") : "";
    let hint =
      `no JS artifact for "${id}" (expected one of: ${candidates.join(", ")}). ` +
      `Does the package declare link.js exports in moon.pkg?`;
    if (/virtual/.test(pkgText)) {
      hint += " This looks like a virtual package: virtual packages emit no runtime JS — import the app package that declares overrides instead.";
    } else if (/implement/.test(pkgText)) {
      hint += " This looks like an implement package: implementations are linked by the app that declares overrides.";
    }
    return new Error(`[bun-plugin-moonbit] ${hint}`);
  }

  async function startWatch(cycle: BuildCycle): Promise<void> {
    if (watchChild && watchChild.exitCode === null) return;

    const child = spawn(
      options.command ?? "moon",
      [
        "build",
        "--target",
        "js",
        ...(mode === "release" ? ["--release"] : []),
        "-w",
        "--output-json",
      ],
      { cwd: cycle.project.root, stdio: "inherit" },
    );
    watchChild = child;

    let spawned = false;
    let startupSettled = false;
    let resolveStartup: (() => void) | null = null;
    let rejectStartup: ((error: Error) => void) | null = null;
    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    let resolveClose: (() => void) | null = null;
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    watchClose = close;

    const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
    const markFailure = (error: Error): void => {
      cycle.error = error;
      cycle.status = "rejected";
      if (!spawned && !startupSettled) {
        startupSettled = true;
        rejectStartup?.(error);
      }
    };
    const terminate = (signal: NodeJS.Signals = "SIGTERM"): void => {
      if (child.exitCode === null) child.kill(signal);
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      terminate(signal);
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    };
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");
    const onProcessExit = (): void => terminate("SIGTERM");
    const removeOwnerListeners = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("exit", onProcessExit);
      if (watchCleanup === cleanup) watchCleanup = null;
    };
    const cleanup = (): void => {
      removeOwnerListeners();
      terminate();
    };
    const onError = (error: Error): void => {
      if (watchChild === child) watchChild = null;
      markFailure(asError(error));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (watchChild === child) watchChild = null;
      removeOwnerListeners();
      if (code !== 0 || signal !== null) {
        markFailure(
          new Error(
            `[bun-plugin-moonbit] moon --watch exited with code ${code ?? "signal"}`,
          ),
        );
      }
      resolveClose?.();
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("exit", onProcessExit);
    watchCleanup = cleanup;
    child.once("error", onError);
    child.once("spawn", () => {
      spawned = true;
      if (!startupSettled) {
        startupSettled = true;
        resolveStartup?.();
      }
    });
    child.once("close", onClose);

    await startup;
    await Bun.sleep(WATCH_START_GRACE_MS);
    if (cycle.error) throw cycle.error;
  }

  function newCycle(): BuildCycle {
    const cycle: BuildCycle = {
      project: findProject(options.root ?? process.cwd()),
      promise: Promise.resolve(),
      status: "pending",
      error: null,
      dtsSections: new Map<string, string>(),
      dtsPromises: new Map<string, Promise<void>>(),
      dtsWrite: Promise.resolve(),
    };
    cycle.promise = (async () => {
      try {
        await buildOnce({ root: cycle.project.root, command: options.command, mode });
        if (options.watch) await startWatch(cycle);
        cycle.status = "fulfilled";
      } catch (error) {
        cycle.status = "rejected";
        cycle.error = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    })();
    return cycle;
  }

  async function ensureArtifact(cycle: BuildCycle, id: string): Promise<string> {
    const { candidatePaths, sourceDir } = resolveModule(cycle.project, id, "js", mode);
    await cycle.promise;
    if (cycle.status === "rejected") {
      throw cycle.error ?? new Error(`[bun-plugin-moonbit] Moon build failed for ${cycle.project.root}`);
    }
    const artifact = candidatePaths.find((p) => fs.existsSync(p));
    if (!artifact) {
      throw noArtifactError(id, candidatePaths, sourceDir);
    }
    return artifact;
  }

  function writeDts(out: string, sections: Map<string, string>): void {
    const contents = [...sections.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, section]) => section)
      .join("\n");
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(out, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous === contents) return;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const temp = path.join(
      path.dirname(out),
      `.${path.basename(out)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(temp, contents, { flag: "wx" });
      fs.renameSync(temp, out);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  async function maybeGenDts(
    cycle: BuildCycle,
    moduleSpecifier: string,
    id: string,
    artifactDir: string,
    sourceDir: string,
  ): Promise<void> {
    if (!options.dts || cycle.dtsSections.has(moduleSpecifier)) return;
    const pending = cycle.dtsPromises.get(moduleSpecifier);
    if (pending) return pending;

    const generation = (async () => {
      if (!options.dts) return;
      await ensureMbti({ root: cycle.project.root, command: options.command, package: id, pkgDir: sourceDir });
      const result = generateDts({
        srcDir: options.dts.srcDir ?? sourceDir,
        buildDir: artifactDir,
        moduleId: moduleSpecifier,
        externPolicy: options.dts.externPolicy,
      });
      cycle.dtsSections.set(moduleSpecifier, result.contents);
      const write = cycle.dtsWrite.then(() => writeDts(options.dts!.out, cycle.dtsSections));
      cycle.dtsWrite = write.catch(() => undefined);
      try {
        await write;
      } catch (error) {
        cycle.dtsSections.delete(moduleSpecifier);
        throw error;
      }
      if (result.warnings.length) {
        console.warn(`[bun-plugin-moonbit] dts warnings for ${moduleSpecifier}:\n  ${result.warnings.join("\n  ")}`);
      }
    })();
    cycle.dtsPromises.set(moduleSpecifier, generation);
    try {
      await generation;
    } catch (error) {
      cycle.dtsPromises.delete(moduleSpecifier);
      throw error;
    }
  }

  function maybeGenDtsSync(
    cycle: BuildCycle,
    moduleSpecifier: string,
    id: string,
    artifactDir: string,
    sourceDir: string,
  ): void {
    if (!options.dts || cycle.dtsSections.has(moduleSpecifier)) return;
    ensureMbtiSync({ root: cycle.project.root, command: options.command, package: id, pkgDir: sourceDir });
    const result = generateDts({
      srcDir: options.dts.srcDir ?? sourceDir,
      buildDir: artifactDir,
      moduleId: moduleSpecifier,
      externPolicy: options.dts.externPolicy,
    });
    cycle.dtsSections.set(moduleSpecifier, result.contents);
    writeDts(options.dts.out, cycle.dtsSections);
    if (result.warnings.length) {
      console.warn(`[bun-plugin-moonbit] dts warnings for ${moduleSpecifier}:\n  ${result.warnings.join("\n  ")}`);
    }
  }

  function ensureArtifactSync(cycle: BuildCycle, id: string): { artifact: string; sourceDir: string } {
    const { candidatePaths, sourceDir } = resolveModule(cycle.project, id, "js", mode);
    if (cycle.status === "rejected") {
      throw cycle.error ?? new Error(`[bun-plugin-moonbit] Moon build failed for ${cycle.project.root}`);
    }
    const artifact = candidatePaths.find((p) => fs.existsSync(p));
    if (!artifact) throw noArtifactError(id, candidatePaths, sourceDir);
    return { artifact, sourceDir };
  }

  async function dispose(): Promise<void> {
    const cleanup = watchCleanup;
    cleanup?.();
    const close = watchClose;
    if (close) await close;
    watchCleanup = null;
    watchClose = null;
    watchChild = null;
  }

  async function prepare(): Promise<void> {
    if (preparedCycle?.status === "fulfilled") return;
    if (preparedCycle?.status === "pending") {
      await preparedCycle.promise;
      return;
    }
    const cycle = newCycle();
    preparedCycle = cycle;
    await cycle.promise;
  }

  return {
    name: "bun-plugin-moonbit",
    prepare,
    dispose,
    setup(build) {
      let cycle: BuildCycle | null = null;
      const hasOnStart = typeof build.onStart === "function";
      if (hasOnStart) {
        build.onStart(() => {
          cycle = newCycle();
          return cycle.promise;
        });
      }

      // Resolve mbt: ids to the real artifact path so both Bun.build and the
      // runtime loader read moon's output natively — no virtual module needed.
      const resolveMbt = (args: { path: string; namespace: string }) => {
        const id = hasOnStart
          ? args.path.slice("mbt:".length)
          : args.path.startsWith("mbt:")
            ? args.path.slice("mbt:".length)
            : args.path;
        const moduleSpecifier = `mbt:${id}`;
        if (hasOnStart) {
          if (!cycle) cycle = newCycle();
          const activeCycle = cycle;
          return (async () => {
            const artifact = await ensureArtifact(activeCycle, id);
            const { sourceDir } = resolveModule(activeCycle.project, id, "js", mode);
            await maybeGenDts(activeCycle, moduleSpecifier, id, path.dirname(artifact), sourceDir);
            return { path: artifact, namespace: "file" };
          })();
        }

        // Bun 1.4's runtime hook cannot return a pending Promise. Runtime
        // registration therefore has an explicit async prepare() phase.
        if (!cycle || (cycle.status === "rejected" && cycle !== preparedCycle)) cycle = preparedCycle;
        if (!cycle) {
          throw new Error(
            `[bun-plugin-moonbit] runtime mbt resolution requires await plugin.prepare() before Bun.plugin(plugin)`,
          );
        }
        const { artifact, sourceDir } = ensureArtifactSync(cycle, id);
        maybeGenDtsSync(cycle, moduleSpecifier, id, path.dirname(artifact), sourceDir);
        return { path: artifact, namespace: "file" };
      };
      build.onResolve({ filter: /^mbt:/ }, resolveMbt);
      build.onResolve({ filter: /.*/, namespace: "mbt" }, resolveMbt);
    },
  };
}
