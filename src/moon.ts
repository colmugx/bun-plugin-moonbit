import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MoonSpawnOptions {
  root: string;
  command?: string;
  mode?: "debug" | "release";
}

export interface MoonDiagnostic {
  level: "warning" | "error";
  code: number;
  path: string;
  line: number;
  column: number;
  message: string;
}

export class MoonDiagnosticParseError extends Error {
  constructor(readonly line: string, cause?: unknown) {
    super(`[bun-plugin-moonbit] malformed diagnostic JSON: ${line}`, { cause });
    this.name = "MoonDiagnosticParseError";
  }
}

export class MoonBuildError extends Error {
  constructor(
    message: string,
    readonly diagnostics: MoonDiagnostic[],
    readonly raw: string,
  ) {
    super(message);
    this.name = "MoonBuildError";
  }
}

export function parseDiagnostics(raw: string): MoonDiagnostic[] {
  const out: MoonDiagnostic[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new MoonDiagnosticParseError(trimmed, error);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MoonDiagnosticParseError(trimmed);
    }
    const o = value as Record<string, unknown>;
    if (o["$message_type"] !== "diagnostic") continue;
    if (o["level"] !== "warning" && o["level"] !== "error") {
      throw new MoonDiagnosticParseError(trimmed);
    }
    const code = Number(o["error_code"] ?? 0);
    if (!Number.isFinite(code)) throw new MoonDiagnosticParseError(trimmed);
    const locValue = o["loc"];
    const loc = typeof locValue === "string" ? locValue.match(/^(\d+):(\d+)/) : null;
    if (locValue !== undefined && !loc) throw new MoonDiagnosticParseError(trimmed);
    out.push({
      level: o["level"],
      code,
      path: String(o["path"] ?? ""),
      line: loc ? Number(loc[1]) : 1,
      column: loc ? Number(loc[2]) : 1,
      message: String(o["message"] ?? ""),
    });
  }
  return out;
}

function formatDiagnostics(diags: MoonDiagnostic[]): string {
  return diags
    .map((d) => `  [${d.level === "error" ? "E" : "W"}${d.code}] ${d.path}:${d.line}:${d.column} ${d.message}`)
    .join("\n");
}

function run(
  args: string[],
  root: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (stdout.length > 8_000_000) child.kill();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function runSync(
  args: string[],
  root: string,
  command: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function buildArgs(o: MoonSpawnOptions & { packages?: string[] }): string[] {
  return [
    "build",
    "--target",
    "js",
    ...(o.mode === "release" ? ["--release"] : []),
    "--output-json",
    ...(o.packages ?? []),
  ];
}

function checkBuildResult(code: number, stdout: string, stderr: string): void {
  const raw = stdout + stderr;
  let diagnostics: MoonDiagnostic[];
  try {
    diagnostics = parseDiagnostics(`${stdout}\n${stderr}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoonBuildError(
      `[bun-plugin-moonbit] moon build emitted malformed diagnostics\n${detail}`,
      [],
      raw,
    );
  }
  const errors = diagnostics.filter((d) => d.level === "error");
  if (code !== 0 || errors.length) {
    const detail = formatDiagnostics(errors.length ? errors : diagnostics) || stderr.trim() || stdout.trim();
    throw new MoonBuildError(
      `[bun-plugin-moonbit] moon build failed (exit ${code})\n${detail}\nhint: \`moon explain <code>\` explains a diagnostic code`,
      diagnostics,
      raw,
    );
  }
}

export async function buildOnce(o: MoonSpawnOptions & { packages?: string[] }): Promise<void> {
  const command = o.command ?? "moon";
  const args = buildArgs(o);
  const { code, stdout, stderr } = await run(args, o.root, command);
  checkBuildResult(code, stdout, stderr);
}

export async function moonInfo(o: MoonSpawnOptions & { package: string }): Promise<void> {
  const command = o.command ?? "moon";
  const { code, stdout, stderr } = await run(["info", "-p", o.package], o.root, command);
  if (code !== 0) {
    throw new Error(`[bun-plugin-moonbit] moon info failed for ${o.package}\n${stdout || stderr}`);
  }
}

function moonInfoSync(o: MoonSpawnOptions & { package: string }): void {
  const command = o.command ?? "moon";
  const { code, stdout, stderr } = runSync(["info", "-p", o.package], o.root, command);
  if (code !== 0) {
    throw new Error(`[bun-plugin-moonbit] moon info failed for ${o.package}\n${stdout || stderr}`);
  }
}

function newestPackageInputMtime(pkgDir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (e.isFile() && (e.name.endsWith(".mbt") || e.name === "moon.pkg" || e.name === "moon.pkg.json")) {
      newest = Math.max(newest, fs.statSync(path.join(pkgDir, e.name)).mtimeMs);
    }
  }
  return newest;
}

/**
 * Ensures pkg.generated.mbti exists and is newer than the package's MoonBit
 * inputs, running `moon info -p <package>` when needed.
 *
 * js-only modules must declare `preferred_target = "js"` in moon.mod — moon
 * info otherwise uses the wasm canonical backend and skips them silently.
 */
export async function ensureMbti(
  o: MoonSpawnOptions & { package: string; pkgDir: string },
): Promise<string> {
  const mbti = path.join(o.pkgDir, "pkg.generated.mbti");
  if (fs.existsSync(mbti) && fs.statSync(mbti).mtimeMs >= newestPackageInputMtime(o.pkgDir)) return mbti;
  await moonInfo(o);
  if (!fs.existsSync(mbti)) {
    throw new Error(
      `[bun-plugin-moonbit] moon info produced no ${mbti}. ` +
        `For js-only modules add \`preferred_target = "js"\` to moon.mod.`,
    );
  }
  return mbti;
}

/** Synchronous counterpart for runtime-only Bun plugin resolution. */
export function ensureMbtiSync(
  o: MoonSpawnOptions & { package: string; pkgDir: string },
): string {
  const mbti = path.join(o.pkgDir, "pkg.generated.mbti");
  if (fs.existsSync(mbti) && fs.statSync(mbti).mtimeMs >= newestPackageInputMtime(o.pkgDir)) return mbti;
  moonInfoSync(o);
  if (!fs.existsSync(mbti)) {
    throw new Error(
      `[bun-plugin-moonbit] moon info produced no ${mbti}. ` +
        `For js-only modules add \`preferred_target = "js"\` to moon.mod.`,
    );
  }
  return mbti;
}
