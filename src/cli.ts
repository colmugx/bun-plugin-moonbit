#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { generateDts } from "./dts";
import { sizeReport } from "./size";

const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(`usage:
  bun-plugin-moonbit gen-dts --src <pkgDir> --build <artifactDir> --module <mbt:id> --out <file.d.ts> [--policy <json>]
  bun-plugin-moonbit size <lib.js>`);
  process.exit(2);
}

if (command === "gen-dts") {
  const src = flag("src");
  const build = flag("build");
  const moduleId = flag("module");
  const out = flag("out");
  if (!src || !build || !moduleId || !out) usage();
  const externPolicy = flag("policy") ? (JSON.parse(flag("policy")!) as Record<string, string>) : undefined;
  const result = generateDts({ srcDir: src, buildDir: build, moduleId, externPolicy });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result.contents);
  console.log(
    `wrote ${out} (${result.exportCount} exports, ${result.dataClasses.length} data classes, ${result.opaqueTypes.length} opaque)`,
  );
  for (const w of result.warnings) console.warn(`warn: ${w}`);
} else if (command === "size") {
  const file = args[0];
  if (!file) usage();
  for (const entry of sizeReport(fs.readFileSync(file, "utf8"))) {
    console.log(`${(entry.bytes / 1024).toFixed(1).padStart(10)} KB  ${(entry.share * 100).toFixed(1).padStart(5)}%  ${entry.package}`);
  }
} else {
  usage();
}
