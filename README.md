# bun-plugin-moonbit

Bun plugin and build tooling for MoonBit projects targeting JavaScript.

```
import * as agent from "mbt:acme/anvil-js/lib";
```

- **`mbt:` imports** — resolve MoonBit packages to their `moon build --target js`
  artifacts inside any Bun bundling or (with `Bun.plugin`) at runtime.
- **Incremental by cycle** — every `Bun.build` cycle runs one
  `moon build --target js [--release] --output-json`; Moon decides how much
  work is incremental. A runtime-only registration lazily starts the same
  preparation when Bun has no `onStart` hook.
- **Generated `.d.ts`** — typed declarations derived from `moon.pkg`,
  `pkg.generated.mbti`, and moon's own `lib.d.ts`: Promise-returning signatures,
  data classes for all-primitive structs, branded opaque handles for the rest.
  No hand-written shim to drift.
- **Diagnostics that point at code** — moon errors are forwarded with
  `file:line:col` and an `moon explain <code>` hint.
- **Size attribution** — decode moon's mangled identifiers to attribute a
  `lib.js` byte-by-byte to the source packages that produced it.

The import prefix intentionally matches `vite-plugin-moonbit`, so application
code does not change when switching bundlers.

## Install

```bash
bun add -d bun-plugin-moonbit
```

## Bundling (`Bun.build`)

```ts
// build.ts
import { moonbit } from "bun-plugin-moonbit";

const plugin = moonbit({
  root: "../..",            // dir containing moon.work / moon.mod (default: cwd)
  mode: "release",
  dts: {
    out: "gen/mbt.d.ts",
    externPolicy: {
      OnEvent: "(eventJson: string) => void",
      OnRequest: "(requestJson: string) => Promise<string>",
      ShouldCancel: "() => boolean",
    },
  },
});

const targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"];
for (const target of targets) {
  await Bun.build({
    entrypoints: ["./host.ts"],
    plugins: [plugin], // one instance: one Moon build per Bun cycle
    compile: { target, outfile: `dist/app-${target}` },
    minify: true,
  });
}

// If watch is enabled, the owner must stop the persistent child when its
// build host is disposed.
await plugin.dispose();
```

Include `gen/mbt.d.ts` in `tsconfig.json`, import from `"mbt:<module>/<pkg>"`,
and delete any hand-written module shim.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `root` | `cwd` | Start directory for moon.work / moon.mod discovery (searches upward). |
| `mode` | `"release"` | `debug` artifacts keep readable names and stack traces. |
| `watch` | `false` | Keep `moon build --watch` running; wait for the first artifact. Pairs with `bun --hot`. |
| `command` | `"moon"` | moon executable. |
| `dts` | — | Generate `.d.ts` while bundling (see below). |

## Runtime (dev server / `bun --hot`)

```toml
# bunfig.toml
preload = ["bun-plugin-moonbit/preload"]
```

```bash
MOONBIT_ROOT=../.. MOONBIT_MODE=debug bun --hot host.ts
```

The published preload uses the current working directory by default, builds in
release mode, and enables watch mode only when argv contains `--hot` or
`--watch`. Set `MOONBIT_ROOT` to override the project root,
`MOONBIT_MODE=debug` for debug artifacts, or `MOONBIT_WATCH=1|0` to override
the argv-derived watch setting. Other values fail fast. It awaits
`plugin.prepare()` before registering the plugin, so an empty `_build` is
prepared before the first runtime import. If registering directly, use the
same ordering:

```ts
const plugin = moonbit({ root: "../..", mode: "debug", watch: true });
await plugin.prepare();
Bun.plugin(plugin);
await import("./host.ts");
```

Runtime `onResolve` is synchronous in Bun 1.4; registering without the
`prepare()` step fails fast with an instruction to prepare first.

## Generated declarations

The generator consumes only moon outputs — `moon.pkg` (export surface),
`pkg.generated.mbti` (signatures, `@js_async.Promise[...]`, struct fields),
`lib.d.ts` (parameter names) — plus one declarative policy for `#external`
FFI types. Rules:

- `pub(all)` structs whose fields are all JS primitives → `class` with fields
  and a typed constructor (also accepts struct literals).
- Any other struct → branded class. Exported constructors stay `new`-able;
  everything else gets a `private constructor()` so handles cannot be forged
  or swapped (a `Runtime` handle will not typecheck where an `Agent` handle
  is expected).
- `Map`/`Array`/`Option`/cross-package internal types → `unknown`, reported as
  warnings.
- Missing extern policy, exports absent from the `.mbti`, or parameter-count
  mismatches fail the build instead of emitting `any`.

For js-only modules, `moon info` needs `preferred_target = "js"` in `moon.mod`
(it otherwise falls back to the wasm canonical backend and skips the package).
The plugin runs `moon info` for you when the `.mbti` is older than the sources.

**Drift gate** — commit `gen/mbt.d.ts` and make CI own it:

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

Works on unminified moon output (minifiers rename the mangled identifiers
away). The decode scheme — `_M0` + markers, first digit = package-path segment
count, then length-prefixed segments — is heuristic; it was validated against
real artifacts but is undocumented upstream.

## How resolution works

1. Walk up from `root` for `moon.work` (workspace wins even above a member's
   own `moon.mod`), then for `moon.mod`.
2. `mbt:<member>/<pkg>` matches members by longest prefix; artifacts resolve
   against `_build/<target>/<mode>/build` (workspaces nest the module name,
   single modules stay flat).
3. At the start of each `Bun.build`, the plugin waits for one
   `moon build --target js [--release] --output-json` cycle before resolving
   any `mbt:` import. In the runtime, where Bun 1.4 has no `onStart` hook, the
   first `mbt:` resolution lazily starts that cycle. The plugin does not use
   artifact or source mtimes to decide whether Moon should run.
4. The resolved id is the real artifact path, so Bun's own loader handles the
   file — no virtual modules, native `import`s inside the artifact just work.

With `watch: true`, the plugin first completes the current one-shot build and
then starts `moon build --target js [--release] -w --output-json`. An artifact
left by an earlier run is not accepted until that current build succeeds.
The returned plugin owns that child; call `plugin.dispose()` when the host
ends. SIGINT, SIGTERM, and process exit also terminate the child.

## Limitations

- JS target only (`wasm` / `wasm-gc` need loader semantics this plugin does not
  implement).
- Enums are not mapped to tagged unions yet (`$tag` numbers are a codegen
  detail; recovering them from `prototype.$tag` is planned).
- Generic signatures, trait objects (`&Trait`), and cross-package internal
  types map to `unknown` by design — publish a JSON/primitive boundary instead.
- `bun build` (CLI) does not load plugins; use the `Bun.build` API or bunfig
  preload.

## License

Apache-2.0 (add the standard LICENSE text before publishing).
