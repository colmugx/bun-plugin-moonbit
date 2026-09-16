import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { generateDts } from "../src/dts";

const fixtures = path.resolve(import.meta.dir, "fixtures");

const POLICY = {
  JsCallback: "(eventJson: string) => void",
};

describe("generateDts", () => {
  test("emits data classes, opaque handles, Promise, extern policy", () => {
    const result = generateDts({
      srcDir: path.join(fixtures, "dts"),
      buildDir: path.join(fixtures, "dts"),
      moduleId: "mbt:x/dts-fixture",
      externPolicy: POLICY,
    });

    expect(result.contents).toContain(`export class Point {
    x: number;
    y: number;
    constructor(x: number, y: number);
  }`);
    expect(result.contents).toContain(`export class Runtime {
    constructor(point: Point);
    private readonly __brand: "Runtime";
  }`);
    expect(result.contents).toContain("export function double_x(p: Point, factor: number): number;");
    expect(result.contents).toContain("export function shutdown(p: Point): Promise<void>;");
    expect(result.contents).toContain(
      "export function set_cb(p: Point, cb: (eventJson: string) => void): string;",
    );
    // struct referenced only by signatures (not exported) still gets a class
    expect(result.contents).toContain(`export class Inner {
    scale: number;
  }`);
    expect(result.contents).toContain("export function scale_point(p: Point, inner: Inner): Inner;");
    expect(result.dataClasses).toEqual(["Point", "Inner"]);
    expect(result.opaqueTypes).toEqual(["Runtime"]);
    expect(result.exportCount).toBe(6);
  });

  test("extern without policy entry fails instead of degrading to any", () => {
    expect(() =>
      generateDts({ srcDir: path.join(fixtures, "dts"), buildDir: path.join(fixtures, "dts"), moduleId: "mbt:x" }),
    ).toThrow(/no extern policy for #external type "JsCallback"/);
  });

  test("drift: export missing from mbti fails", () => {
    expect(() =>
      generateDts({
        srcDir: path.join(fixtures, "dts-drift"),
        buildDir: path.join(fixtures, "dts-drift"),
        moduleId: "mbt:x",
        externPolicy: POLICY,
      }),
    ).toThrow(/drift: moon\.pkg exports "ghost"/);
  });
});
