import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Parses the linker response file (`<artifact>.js.rsp`) that moon emits next to
 * each JS artifact. The rsp lists every `.core` input of the final link, which
 * gives us (a) the exact link set and (b) a precise freshness check without
 * spawning moon.
 */
export class LinkManifest {
  readonly artifact: string;
  readonly rspPath: string;
  readonly corePaths: string[];
  readonly packageIds: ReadonlySet<string>;

  private constructor(
    artifact: string,
    rspPath: string,
    corePaths: string[],
    packageIds: Set<string>,
  ) {
    this.artifact = artifact;
    this.rspPath = rspPath;
    this.corePaths = corePaths;
    this.packageIds = packageIds;
  }

  static load(artifact: string, buildDir: string): LinkManifest | null {
    const rspPath = artifact + ".rsp";
    if (!fs.existsSync(rspPath)) return null;
    const corePaths = fs
      .readFileSync(rspPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".core"));
    const ids = new Set<string>();
    for (const core of corePaths) {
      const rel = path.relative(buildDir, core);
      if (rel.startsWith("..")) continue; // builtins under ~/.moon never invalidate the artifact
      const segs = rel.split(path.sep);
      segs.pop(); // build layout repeats the package name as the file name
      if (segs.length) ids.add(segs.join("/"));
    }
    return new LinkManifest(artifact, rspPath, corePaths, ids);
  }

  containsPackage(id: string): boolean {
    return this.packageIds.has(id);
  }

  isFresh(): boolean {
    if (!fs.existsSync(this.artifact)) return false;
    const outputMtime = fs.statSync(this.artifact).mtimeMs;
    for (const core of this.corePaths) {
      if (!fs.existsSync(core)) return false;
      if (fs.statSync(core).mtimeMs > outputMtime) return false;
    }
    return true;
  }
}

/**
 * Fallback for the no-rsp case: moon only writes a response file when a link
 * has multiple core inputs, so single-package modules get none. There the
 * package's own sources are the only inputs worth checking.
 */
export function isFreshBySources(artifact: string, sourceDir: string): boolean {
  if (!fs.existsSync(artifact)) return false;
  const outputMtime = fs.statSync(artifact).mtimeMs;
  try {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mbt") && entry.name !== "moon.pkg" && entry.name !== "moon.pkg.json") continue;
      if (fs.statSync(path.join(sourceDir, entry.name)).mtimeMs > outputMtime) return false;
    }
  } catch {
    return false;
  }
  return true;
}
