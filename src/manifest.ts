import * as fs from "node:fs";
import * as path from "node:path";

export interface MemberInfo {
  name: string;
  memberDir: string;
  /** Source dir declared in moon.mod; "" means the member root itself. */
  source: string;
}

export interface ProjectInfo {
  /** Directory that owns _build (workspace root, or module root outside workspaces). */
  root: string;
  isWorkspace: boolean;
  members: MemberInfo[];
}

function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function stripComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, "");
}

function dslString(text: string, key: string): string | undefined {
  return stripComments(text).match(new RegExp(`\\b${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
}

function dslStringArray(text: string, key: string): string[] | null {
  const block = stripComments(text).match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`))?.[1];
  if (block === undefined) return null;
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

function readMod(modPath: string): { name?: string; source?: string } {
  const text = fs.readFileSync(modPath, "utf8");
  if (modPath.endsWith(".json")) {
    const j = JSON.parse(text) as { name?: string; source?: string };
    return { name: j.name, source: j.source };
  }
  return { name: dslString(text, "name"), source: dslString(text, "source") };
}

function readWork(workPath: string): { members: string[] } {
  const text = fs.readFileSync(workPath, "utf8");
  if (workPath.endsWith(".json")) {
    const j = JSON.parse(text) as { members?: string[] };
    return { members: j.members ?? [] };
  }
  return { members: dslStringArray(text, "members") ?? [] };
}

export function findProject(startDir: string): ProjectInfo {
  const start = path.resolve(startDir);
  let nearestModule:
    | { root: string; name: string; source: string }
    | null = null;
  let cursor = start;
  while (true) {
    const mod = firstExisting(cursor, ["moon.mod", "moon.mod.json"]);
    if (mod && !nearestModule) {
      const { name, source } = readMod(mod);
      nearestModule = {
        root: cursor,
        name: name ?? path.basename(cursor),
        source: source ?? "",
      };
    }
    const work = firstExisting(cursor, ["moon.work", "moon.work.json"]);
    if (work) {
      const members: MemberInfo[] = [];
      for (const rel of readWork(work).members) {
        const memberDir = path.resolve(cursor, rel);
        const mod = firstExisting(memberDir, ["moon.mod", "moon.mod.json"]);
        const { name, source } = mod ? readMod(mod) : {};
        members.push({ name: name ?? rel, memberDir, source: source ?? "" });
      }
      if (!nearestModule || members.some((member) => member.memberDir === nearestModule!.root)) {
        return { root: cursor, isWorkspace: true, members };
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (nearestModule) {
    return {
      root: nearestModule.root,
      isWorkspace: false,
      members: [{
        name: nearestModule.name,
        memberDir: nearestModule.root,
        source: nearestModule.source,
      }],
    };
  }
  throw new Error(`[bun-plugin-moonbit] no moon.work or moon.mod found at or above ${startDir}`);
}

export function buildDir(info: ProjectInfo, target = "js", mode = "release"): string {
  return path.join(info.root, "_build", target, mode, "build");
}

export function matchMember(info: ProjectInfo, id: string): MemberInfo | null {
  const parts = id.split("/");
  let best: MemberInfo | null = null;
  let bestLen = 0;
  for (const m of info.members) {
    const segs = m.name.split("/");
    if (segs.length > parts.length) continue;
    if (parts.slice(0, segs.length).join("/") !== m.name) continue;
    if (segs.length > bestLen) {
      best = m;
      bestLen = segs.length;
    }
  }
  return best;
}

export interface ModuleResolution {
  /** Artifact candidates, most likely first (workspace nests the module name, single modules stay flat). */
  candidatePaths: string[];
  /** Source dir of the package (for moon.pkg hints and moon info). */
  sourceDir: string;
  member: MemberInfo;
}

export function resolveModule(
  info: ProjectInfo,
  id: string,
  target = "js",
  mode = "release",
): ModuleResolution {
  const member = matchMember(info, id);
  if (!member) {
    throw new Error(
      `[bun-plugin-moonbit] "${id}" does not match any workspace member of ${info.root} ` +
        `(members: ${info.members.map((m) => m.name).join(", ") || "none"})`,
    );
  }
  const memberSegs = member.name.split("/");
  const pkgParts = id.split("/").slice(memberSegs.length);
  const last = (pkgParts.length ? pkgParts[pkgParts.length - 1] : memberSegs[memberSegs.length - 1])!;
  const base = buildDir(info, target, mode);
  const nested = path.join(base, ...memberSegs, ...pkgParts, `${last}.js`);
  const flat = path.join(base, ...pkgParts, `${last}.js`);
  return {
    candidatePaths: info.isWorkspace ? [nested, flat] : [flat],
    sourceDir: path.join(member.memberDir, member.source, ...pkgParts),
    member,
  };
}
