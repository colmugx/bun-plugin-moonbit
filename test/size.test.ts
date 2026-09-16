import { describe, expect, test } from "bun:test";
import { decodeMangledPackage, sizeReport } from "../src/size";

describe("decodeMangledPackage", () => {
  test("workspace path with segment count", () => {
    const d = decodeMangledPackage("_M0FP34acme10anvil_2djs3lib17bridge__run__turn");
    expect(d).not.toBeNull();
    expect(d!.pkg).toBe("acme/anvil-js/lib");
    expect(d!.builtin).toBe(false);
  });

  test("multi-segment paths and multi-digit lengths", () => {
    expect(decodeMangledPackage("_M0TP34acme5anvil6kernel8EffectId")!.pkg).toBe("acme/anvil/kernel");
    expect(decodeMangledPackage("_M0TP44acme5anvil8internal12kernel__exec13EventSequence")!.pkg).toBe(
      "acme/anvil/internal/kernel_exec",
    );
    expect(decodeMangledPackage("_M0FP411moonbitlang5async8internal11event__loop12set__timeout")!.pkg).toBe(
      "moonbitlang/async/internal/event_loop",
    );
  });

  test("dash escape", () => {
    expect(decodeMangledPackage("_M0TP24acme17anvil_2dext_2dmem10CliOutcome")!.pkg).toBe("acme/anvil-ext-mem");
  });

  test("builtin marker", () => {
    const d = decodeMangledPackage("_M0DTPB4Json4Null");
    expect(d!.builtin).toBe(true);
  });

  test("not mangled", () => {
    expect(decodeMangledPackage("plain_name")).toBeNull();
  });
});

describe("sizeReport", () => {
  test("attributes top-level declarations to packages", () => {
    const lib = [
      "import { readFileSync } from \"node:fs\";",
      "function _M0FP34acme10anvil_2djs3lib5f_run() { return 1; }",
      "const _M0DTPB4Json4Null__ = 1;",
      "function helper() { return 2; }",
      "",
    ].join("\n");
    const report = sizeReport(lib);
    const pkgs = report.map((e) => e.package);
    expect(pkgs).toContain("acme/anvil-js/lib");
    expect(pkgs).toContain("moonbitlang/core (builtin)");
    expect(pkgs).toContain("prelude/other");
    const total = report.reduce((a, e) => a + e.share, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});
