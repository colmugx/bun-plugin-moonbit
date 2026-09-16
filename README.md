# bun-plugin-moonbit

Bun plugin for importing MoonBit packages into JavaScript: `mbt:` imports backed by `moon build --target js`, generated TypeScript declarations, and bundle size attribution.

```ts
import * as agent from "mbt:acme/anvil-js/lib";
```

## Features

- `mbt:` imports resolve to moon's real JS artifacts, in `Bun.build` and at runtime.
- One `moon build` per bundling cycle — moon handles incrementality.
- Generated `.d.ts` from moon's own outputs; no hand-written shim to drift.
- Moon errors forwarded with `file:line:col` and a `moon explain <code>` hint.
- `size` command attributes `lib.js` bytes to source packages.
- Import prefix matches `vite-plugin-moonbit`, so app code survives switching bundlers.

## Install

```bash
bun add -d bun-plugin-moonbit
```

## Bundle (`Bun.build`)

```ts
// build.ts
import { moonbit } from "bun-plugin-moonbit";

const plugin = moonbit({
  root: "../..",        // dir containing moon.work / moon.mod (default: cwd)
  mode: "release",
  dts: { out: "gen/mbt.d.ts" },
});

await Bun.build({
  entrypoints: ["./host.ts"],
  plugins: [plugin],    // one instance: one moon build per cycle
});

await plugin.dispose(); // stops the moon --watch child when watch: true
```

Import from `"mbt:<module>/<pkg>"`, include `gen/mbt.d.ts` in `tsconfig.json`, and delete any hand-written module shim.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `root` | `cwd` | Where to start moon.work / moon.mod discovery (searches upward). |
| `mode` | `"release"` | `"debug"` keeps readable names and stack traces. |
| `watch` | `false` | Keep `moon build --watch` running; pairs with `bun --hot`. Call `plugin.dispose()` when done. |
| `command` | `"moon"` | moon executable. |
| `dts` | — | Generate `.d.ts` while bundling (see below). |

## Runtime (`bun --hot`)

```toml
# bunfig.toml
preload = ["bun-plugin-moonbit/preload"]
```

```bash
MOONBIT_ROOT=../.. MOONBIT_MODE=debug bun --hot host.ts
```

- `MOONBIT_ROOT` — project root (default: cwd)
- `MOONBIT_MODE` — `debug` | `release` (default: `release`)
- `MOONBIT_WATCH` — `1` | `0` (default: on when argv has `--hot`/`--watch`)

Registering manually? Prepare before `Bun.plugin`:

```ts
const plugin = moonbit({ root: "../..", mode: "debug", watch: true });
await plugin.prepare();
Bun.plugin(plugin);
```

## Generated declarations

When `dts` is set, each imported package gets a `declare module "mbt:…"`, derived from moon's own outputs (`moon.pkg`, `pkg.generated.mbti`, `lib.d.ts`):

- `pub(all)` structs with all-primitive fields → data classes (struct literals accepted).
- Any other struct → branded opaque class; handles cannot be forged or swapped.
- Containers JS can't mirror (`Map`/`Array`/`Option`, cross-package types) → `unknown`, with a warning.
- Drift fails the build instead of emitting `any`: missing `externPolicy` entry for an `#external` type, exports missing from the `.mbti`, parameter-count mismatches.

`externPolicy` gives JS shapes for `#external` FFI types, e.g. `{ OnEvent: "(eventJson: string) => void" }`.

For js-only modules, declare `preferred_target = "js"` in `moon.mod`; the plugin runs `moon info` when the `.mbti` is stale.

Gate drift in CI:

```yaml
- run: bun run build.ts
- run: git diff --exit-code gen/mbt.d.ts
```

## Size report

```bash
bunx bun-plugin-moonbit size ../../_build/js/release/build/<module>/<pkg>/lib.js
```

```
  460.8 KB   7.3%  acme/anvil-internal/puppetry
  344.2 KB   5.4%  acme/anvil-ext-memory
  338.1 KB   5.3%  acme/anvil-ext-skills
  120.4 KB   1.9%  moonbitlang/core (builtin)
  ...
```

Unminified moon output only — minifiers rename the identifiers away.

## Limitations

- JS target only (`wasm` / `wasm-gc` unsupported).
- Enums not yet mapped to tagged unions.
- Generic signatures, trait objects (`&Trait`), and cross-package internal types → `unknown`; publish a JSON/primitive boundary instead.
- `bun build` (CLI) loads no plugins; use the `Bun.build` API or bunfig preload.

## License

MIT
