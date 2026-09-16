import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildOnce, MoonBuildError, parseDiagnostics } from "../src/moon";

describe("Moon diagnostics", () => {
  test("accepts reordered diagnostic fields", () => {
    const diagnostics = parseDiagnostics(
      '{"level":"error","message":"bad","$message_type":"diagnostic","path":"lib/lib.mbt","loc":"2:3","error_code":7}\n',
    );
    expect(diagnostics).toEqual([
      {
        level: "error",
        code: 7,
        path: "lib/lib.mbt",
        line: 2,
        column: 3,
        message: "bad",
      },
    ]);
  });

  test("rejects malformed diagnostic JSON", () => {
    expect(() => parseDiagnostics('{"$message_type":"diagnostic"')).toThrow(/malformed diagnostic JSON/);
  });

  test("parses diagnostics emitted on stderr and preserves raw output", async () => {
    const root = fs.mkdtempSync("/tmp/mbtplug-diagnostics-");
    const command = path.join(root, "moon.sh");
    const raw =
      '{"level":"error","message":"stderr failure","$message_type":"diagnostic","path":"lib/lib.mbt","loc":"4:5","error_code":901}\n';
    try {
      fs.writeFileSync(command, `#!/bin/sh\nprintf '%s' '${raw}' >&2\nexit 0\n`);
      fs.chmodSync(command, 0o755);
      let caught: unknown;
      try {
        await buildOnce({ root, command, mode: "debug" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MoonBuildError);
      const error = caught as MoonBuildError;
      expect(error.diagnostics[0]).toMatchObject({ code: 901, path: "lib/lib.mbt", line: 4, column: 5 });
      expect(error.raw).toContain(raw);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
