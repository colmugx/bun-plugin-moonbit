export interface SizeEntry {
  package: string;
  bytes: number;
  share: number;
}

const UNESCAPES: Record<string, string> = { "2d": "-", "2f": "/", "5f": "_" };

function unescapeSegment(seg: string): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    if (seg[i] === "_" && seg[i + 1] === "_") {
      out += "_";
      i += 2;
    } else if (seg[i] === "_" && UNESCAPES[seg.slice(i + 1, i + 3)] !== undefined) {
      out += UNESCAPES[seg.slice(i + 1, i + 3)]!;
      i += 3;
    } else {
      out += seg[i++]!;
    }
  }
  return out;
}

function readSegments(rest: string, count: number | null): { segments: string[]; ok: boolean } {
  const segments: string[] = [];
  let i = 0;
  const limit = count ?? Number.POSITIVE_INFINITY;
  while (segments.length < limit) {
    const lenMatch = /^\d+/.exec(rest.slice(i));
    if (!lenMatch) break;
    const len = Number(lenMatch[0]);
    const start = i + lenMatch[0].length;
    if (len === 0 || start + len > rest.length) return { segments, ok: false };
    segments.push(rest.slice(start, start + len));
    i = start + len;
  }
  return { segments, ok: count === null || segments.length === count };
}

/**
 * Decodes the package path embedded in a moon-mangled identifier such as
 * `_M0FP34acme10anvil_2djs3lib17bridge__run__turn` → `acme/anvil-js/lib`.
 * The scheme is heuristic (undocumented upstream): `_M0` + marker letters,
 * where `B` marks builtin/core and `P` marks a length-prefixed package path.
 * The first digit is the segment count (e.g. `34acme…` = 3 segments, first
 * one 4 chars); builtin ids have no count. Only used for size attribution.
 */
export function decodeMangledPackage(id: string): { pkg: string; builtin: boolean } | null {
  const m = /^_M0([A-Z]+)(\d*)(.*)$/.exec(id);
  if (!m) return null;
  const markers = m[1]!;
  const digits = m[2]!;
  const rest = m[3]!;
  const builtin = markers.includes("B");
  let segments: string[] = [];
  if (!builtin && digits) {
    const count = Number(digits[0]);
    const body = digits.slice(1) + rest;
    const counted = readSegments(body, count);
    if (counted.ok) segments = counted.segments;
  }
  if (segments.length === 0) {
    const greedy = readSegments(digits + rest, null);
    if (greedy.ok) segments = greedy.segments;
  }
  if (segments.length === 0) return null;
  return { pkg: segments.map(unescapeSegment).join("/"), builtin };
}

/**
 * Attributes the bytes of a moon-emitted lib.js to source packages by decoding
 * the mangled identifier that starts each top-level declaration. Heuristic —
 * meant for reports on unminified moon output.
 */
export function sizeReport(libJs: string): SizeEntry[] {
  const byPkg = new Map<string, number>();
  let total = 0;
  let current: string | null = null;
  for (const line of libJs.split("\n")) {
    if (/^(function|const|class|let|var|import|export)\b/.test(line)) {
      const mangled = /_M0[A-Za-z0-9_]+/.exec(line);
      const decoded = mangled ? decodeMangledPackage(mangled[0]) : null;
      current = decoded ? (decoded.builtin ? "moonbitlang/core (builtin)" : decoded.pkg) : "prelude/other";
    }
    if (current) {
      const bytes = line.length + 1;
      byPkg.set(current, (byPkg.get(current) ?? 0) + bytes);
      total += bytes;
    }
  }
  const safeTotal = total || 1;
  return [...byPkg]
    .map(([pkg, bytes]) => ({ package: pkg, bytes, share: bytes / safeTotal }))
    .sort((a, b) => b.bytes - a.bytes);
}
