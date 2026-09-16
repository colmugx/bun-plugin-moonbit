import * as fs from "node:fs";
import * as path from "node:path";

export interface GenerateDtsOptions {
  /** Package source dir containing moon.pkg and pkg.generated.mbti. */
  srcDir: string;
  /** Moon artifact dir containing lib.d.ts (`…/_build/js/<mode>/build/<module>/<pkg>`). */
  buildDir: string;
  /** Module specifier used in the emitted `declare module`. */
  moduleId: string;
  /**
   * JS shapes for `#external` FFI types declared in the MoonBit package, e.g.
   * `{ JsCallback: "(eventJson: string) => void" }`. A referenced extern with
   * no policy entry fails generation instead of silently degrading to any.
   */
  externPolicy?: Record<string, string>;
}

export interface GenerateDtsResult {
  contents: string;
  warnings: string[];
  exportCount: number;
  /** Structs emitted as data classes (all-primitive fields, literal-compatible). */
  dataClasses: string[];
  /** Structs emitted as branded opaque classes (handles JS must not construct). */
  opaqueTypes: string[];
}

const BUILTIN_EXTERNS: Record<string, string> = {
  "@js_async.AbortSignal": "AbortSignal",
};

const PRIMITIVES: Record<string, string> = {
  String: "string",
  Int: "number",
  UInt: "number",
  Char: "number",
  Byte: "number",
  Float: "number",
  Double: "number",
  Bool: "boolean",
  Unit: "void",
  Bytes: "Uint8Array",
};

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function isTsPrimitive(ts: string): boolean {
  return ts === "string" || ts === "number" || ts === "boolean" || ts === "AbortSignal";
}

export function generateDts(o: GenerateDtsOptions): GenerateDtsResult {
  const moonPkg = fs.readFileSync(path.join(o.srcDir, "moon.pkg"), "utf8");
  const mbti = fs.readFileSync(path.join(o.srcDir, "pkg.generated.mbti"), "utf8");
  const libDts = fs.readFileSync(path.join(o.buildDir, "lib.d.ts"), "utf8");
  const policy = o.externPolicy ?? {};

  const exportsBlock = moonPkg.match(/"exports"\s*:\s*\[([^\]]*)\]/)?.[1];
  if (exportsBlock === undefined) {
    throw new Error(`[bun-plugin-moonbit] no link.js.exports block in ${path.join(o.srcDir, "moon.pkg")}`);
  }
  const exportNames = [...exportsBlock.matchAll(/"([A-Za-z_]\w*)"/g)].map((m) => m[1]!);

  const fnSigs = new Map<string, { params: string[]; ret: string }>();
  for (const m of mbti.matchAll(/^pub fn ([A-Za-z_]\w*)(?:::([A-Za-z_]\w*))?\((.*)\) -> (.+)$/gm)) {
    // `Name::Name(...)` constructors export under the bare struct name
    fnSigs.set(m[2] ?? m[1]!, { params: splitTopLevel(m[3]!), ret: m[4]!.trim() });
  }

  const structs = new Map<string, [string, string][]>();
  for (const m of mbti.matchAll(/^pub(?:\(all\))? struct (\w+) \{([^}]*)\}/gm)) {
    structs.set(
      m[1]!,
      [...m[2]!.matchAll(/(?:mut\s+)?(\w+)\s*:\s*(.+)/g)].map((f) => [f[1]!, f[2]!.trim()] as [string, string]),
    );
  }

  const externs = new Set([...mbti.matchAll(/\n#external\s*\npub type (\w+)/g)].map((m) => m[1]!));

  // lib.d.ts is the only moon output that knows parameter names (mbti is positional)
  const paramNames = new Map<string, string[]>();
  for (const m of libDts.matchAll(/export function (\w+)\(([^)]*)\)/g)) {
    paramNames.set(
      m[1]!,
      m[2]!.split(",").filter((x) => x.trim()).map((x) => x.split(":")[0]!.trim()),
    );
  }

  const warnings = new Set<string>();
  const dataClasses = new Map<string, [string, string][]>();
  const opaqueTypes = new Set<string>();
  const usedStructs = new Set<string>();
  const resolving = new Set<string>();

  function mapType(t: string): string {
    t = t.trim();
    if (BUILTIN_EXTERNS[t]) return BUILTIN_EXTERNS[t]!;
    if (PRIMITIVES[t]) return PRIMITIVES[t]!;
    const promise = t.match(/^[\w.@/-]*Promise\[(.+)\]$/);
    if (promise) return `Promise<${mapType(promise[1]!)}>`;
    if (/^(Map|Array|Option|FixedArray|Iter|Cons|View)\[/.test(t) || /\?$/.test(t)) {
      warnings.add(`opaque MoonBit container "${t}" → unknown`);
      return "unknown";
    }
    if (externs.has(t)) {
      const shape = policy[t];
      if (!shape) {
        throw new Error(
          `[bun-plugin-moonbit] no extern policy for #external type "${t}" — add it to externPolicy ` +
            `(the shape only exists on the JS side, so it cannot be derived)`,
        );
      }
      return shape;
    }
    if (structs.has(t)) {
      usedStructs.add(t);
      if (resolving.has(t)) return t;
      resolving.add(t);
      const fields = structs.get(t)!.map(([n, ft]) => [n, mapType(ft)] as [string, string]);
      resolving.delete(t);
      if (fields.length > 0 && fields.every(([, ft]) => isTsPrimitive(ft))) {
        dataClasses.set(t, fields);
      } else {
        opaqueTypes.add(t);
      }
      return t;
    }
    warnings.add(`unmapped MoonBit type "${t}" → unknown`);
    return "unknown";
  }

  // classify exported structs up front; everything else classifies lazily
  // when an exported signature references it
  for (const name of exportNames) {
    if (structs.has(name)) mapType(name);
  }

  function typedParams(fnName: string, params: string[]): string[] {
    const names = paramNames.get(fnName);
    if (!names || names.length !== params.length) {
      throw new Error(
        `[bun-plugin-moonbit] drift: "${fnName}" parameter names unavailable ` +
          `(lib.d.ts has ${names?.length ?? 0}, pkg.generated.mbti has ${params.length}) — rebuild and re-run moon info`,
      );
    }
    return params.map((t, i) => `${names[i]}: ${mapType(t)}`);
  }

  // signatures first: mapping them populates usedStructs, which decides which
  // non-exported structs still need a class declaration
  const fnLines: string[] = [];
  for (const name of exportNames) {
    if (structs.has(name)) continue; // constructor exported via its class below
    const sig = fnSigs.get(name);
    if (!sig) {
      if (externs.has(name)) {
        warnings.add(`exported #external type "${name}" has no derivable JS shape; skipped`);
        continue;
      }
      throw new Error(
        `[bun-plugin-moonbit] drift: moon.pkg exports "${name}" but pkg.generated.mbti has no matching signature — re-run moon info`,
      );
    }
    if (structs.has(name)) continue; // constructor exported via its class below
    fnLines.push(`  export function ${name}(${typedParams(name, sig.params).join(", ")}): ${mapType(sig.ret)};`);
  }

  const classNames = [...structs.keys()].filter((n) => exportNames.includes(n) || usedStructs.has(n));
  const classLines: string[] = [];
  for (const name of classNames) {
    const exported = exportNames.includes(name);
    const ctor = fnSigs.get(name);
    const params = exported && ctor ? typedParams(name, ctor.params) : null;
    let body: string[];
    if (dataClasses.has(name)) {
      const fieldLines = dataClasses.get(name)!.map(([n, ft]) => `    ${n}: ${ft};`);
      if (params) fieldLines.push(`    constructor(${params.join(", ")});`);
      body = fieldLines;
    } else if (params) {
      // opaque handle with an exported constructor: newable, but the brand
      // blocks struct-literal misuse
      body = [`    constructor(${params.join(", ")});`, `    private readonly __brand: "${name}";`];
    } else {
      body = ["    private constructor();", `    private readonly __brand: "${name}";`];
    }
    classLines.push(`  export class ${name} {\n${body.join("\n")}\n  }`);
  }

  const header = `/* Generated by bun-plugin-moonbit — do not edit.
 * Sources: moon.pkg (export surface) · pkg.generated.mbti (signatures, Promise, structs)
 *          · lib.d.ts (parameter names) · externPolicy (FFI shapes)
 * Regenerate: bun-plugin-moonbit gen-dts --src ${o.srcDir} --build ${o.buildDir} --module ${o.moduleId} --out <file> */`;

  return {
    contents: `${header}\ndeclare module "${o.moduleId}" {\n${[...classLines, ...fnLines].join("\n")}\n}\n`,
    warnings: [...warnings],
    exportCount: exportNames.length,
    dataClasses: [...dataClasses.keys()].filter((n) => classNames.includes(n)),
    opaqueTypes: [...opaqueTypes].filter((n) => classNames.includes(n)),
  };
}
