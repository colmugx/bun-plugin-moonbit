import { moonbit } from "./plugin";

/**
 * Runtime registration for `bunfig.toml`:
 *
 *   preload = ["./node_modules/bun-plugin-moonbit/src/preload.ts"]
 *
 * Configure via env: MOONBIT_ROOT (project dir), MOONBIT_MODE (debug|release),
 * and MOONBIT_WATCH=1|0. Without MOONBIT_WATCH, watch mode follows
 * `--hot`/`--watch` in argv.
 */
const modeEnv = process.env.MOONBIT_MODE;
const mode = modeEnv === undefined || modeEnv === "release"
  ? "release"
  : modeEnv === "debug"
    ? "debug"
    : (() => {
        throw new Error(`[bun-plugin-moonbit] invalid MOONBIT_MODE=${JSON.stringify(modeEnv)} (expected debug or release)`);
      })();

const watchEnv = process.env.MOONBIT_WATCH;
const watch = watchEnv === undefined
  ? process.argv.includes("--hot") || process.argv.includes("--watch")
  : watchEnv === "1"
    ? true
    : watchEnv === "0"
      ? false
      : (() => {
          throw new Error(`[bun-plugin-moonbit] invalid MOONBIT_WATCH=${JSON.stringify(watchEnv)} (expected 1 or 0)`);
        })();

const plugin = moonbit({
  root: process.env.MOONBIT_ROOT ?? process.cwd(),
  mode,
  watch,
});

await plugin.prepare();
Bun.plugin(plugin);

export default plugin;
