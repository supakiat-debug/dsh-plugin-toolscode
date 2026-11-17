# dsh-plugin-toolscode

Cut the prompt bytes a model pays just to *know* its tools — native tool
schemas, MCP server instructions, and the generated PTC SDK declarations — without
touching argument validation, output validation, dispatch or the tool registry.

[![CI](https://github.com/supakiat-debug/dsh-plugin-toolscode/actions/workflows/ci.yml/badge.svg)](https://github.com/supakiat-debug/dsh-plugin-toolscode/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: ^22.19 || >=24](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green)](https://nodejs.org)
[![no core patches](https://img.shields.io/badge/core%20patches-none-informational)]()

Tool descriptions that read nicely in a GUI cost thousands of input tokens on **every
model step**. With a few MCP servers attached they easily eat half a 128k window:
measured on a 10-server deployment, 333 tools = 249k characters of declarations =
**48.9% of the context before the first user message**.

The plugin mounts once (normally at the profile scope, so every preset and subagent
inherits it) and shrinks, for exactly the agents composed under that mount:

| what it shrinks | how | default |
| --- | --- | --- |
| oversized tool `description` and nested property descriptions in the wire `tools[]` | cap or drop; `title` / `examples` dropped | on |
| `### MCP server: …` instruction sections | truncate to `instructionsCap` | 2000 chars |
| **PTC mode** — JSDoc prose of the generated SDK declarations (the `tools:sdk` section) | cap the summary and each `@param` / `@returns` line | off |
| **PTC mode, v0.2** — the declaration *layout* of matched tools, plus `ToolOutputMap` | one line per tool; result typings collapsed to one index signature | off |
| whatever the model turns out to need | **self-heal**: an argument the real schema rejects comes back with the full real parameter schema attached | on |

Everything else is untouched. The registry keeps the real definitions, so argument
validation, output validation, GUI cards and the executed body are exactly what they
were; the shrunk bytes are only ever *read* by the model. Every shrink is a pure
assembly-time transform, and it is byte-stable — two assemblies of an unchanged state
produce identical bytes, so `toolsChanged()` sees no churn and the KV / prompt cache
stays warm. A shrink that throws logs a warning and falls through to the full-size
prompt: this plugin can lose you a saving, never a request.

## Measured

PTC mode is where the cost concentrates, because that is where the schemas hide: once a
preset presents tools as a TypeScript SDK, the wire `tools[]` holds a single entry
(`run_code`) and the whole contract moves into the `tools:sdk` prompt section.

Replayed with the plugin's own shrinkers over the exact bytes a real assembly served on
a 10-server deployment — 386 declarations, 349 of them MCP, verified by hash against the
logged request header. Tokens at 3.8 chars/token; `tools:sdk` is the section, whole
prompt is everything before the first user message:

| variant | `tools:sdk` | whole prompt | ≈ tokens | vs live |
| --- | --- | --- | --- | --- |
| A v0.1 as deployed (prose caps only) | 140,694 | 157,616 | 41,478 | — |
| B `lines` style, no docs | 87,199 | 104,121 | 27,400 | −33.9% |
| C `lines` style + docs 90 | 120,116 | 137,038 | 36,063 | −13.1% |
| D `table`, no docs | 80,159 | 97,081 | 25,548 | −38.4% |
| E `table` + docs 90 | 112,378 | 129,300 | 34,026 | −18.0% |
| F `table` + docs 160 | 129,059 | 145,981 | 38,416 | −7.4% |
| G `sdkOutputMap: stub` only | 98,617 | 115,539 | 30,405 | −26.7% |
| **H `table` + stub, no docs** | **42,670** | **59,592** | **15,682** | **−62.2%** |
| **I `table` + stub + docs 90 (recommended)** | **74,889** | **91,811** | **24,161** | **−41.8%** |
| J `table` + stub + docs 160 | 91,570 | 108,492 | 28,551 | −31.2% |

Live on the same box after upgrading, on a 34-declaration inventory (MCP servers off),
measured out of the session logs with `tools/measure.mjs`:

```
A/B on an identical declaration inventory (34 entries, 0 MCP), newest slimmed assembly at 24372c:
  vs nothing shrunk        tools:sdk = 34885c  -> -10513c (30.1%, ~2767 tok/step)
  vs v0.1 prose caps       tools:sdk = 30454c  ->  -6082c (20.0%, ~1601 tok/step)
```

With MCP servers off nothing matches `sdkSlimInclude: ["mcp__*"]`, and the
`sdkSlimMinEntries` gate refuses to rewrite a section that small — so that 20% is the
`ToolOutputMap` stub on its own, cleanly isolated. The stub is also the cheapest knob on
a small deployment: 34 result typings for one line.

### Wire `tools[]` (native presentation)

Config sweep over the biggest `tools[]` payloads in the same logs
(`minChars` / `descriptionCap` / `nestedDescriptionCap`):

| config | 35 tools | 77 tools (comfy) | 333 tools |
| --- | --- | --- | --- |
| 1200/200/100 (defaults) | −11% | −42% | −11% |
| **600/160/80 (recommended)** | **−24%** | **−52%** | **−20%** |
| 400/120/60 | −31% | −57% | −25% |

Live: core 38 tools 32,153 → 24,646c (−23.3%), comfy 39 tools 61,736 → 20,072c
(−67.5%), a 35-tool session's whole wire 31,140 → 23,633c (−24.1%), with 0.1–0.3%
residual over-cap prose.

### Why 90 characters of description are worth keeping

The harness renders an MCP tool's arguments as `unknown` whenever its JSON Schema uses a
construct the SDK type renderer does not map — in practice `"type": ["string", "number"]`
unions, which MCP servers emit freely and `jsonSchemaToTs` answers with `unknown`.
**241 of the 349** MCP tools in that deployment render that way, so for them the
description is all the declaration says. Keep `sdkSlimDocCap: 90` unless every server
ships scalar-only schemas; `0` (variant H) is for boxes where the model already knows
the servers by heart. Fixing the renderer upstream would shrink the section further on
its own.

## Install

Ship it as a **profile bundle** — that is the only shape DSH lists on the plugins page,
and the one where a single mount covers every preset and subagent (full reasoning in
[Why a bundle and not a preset row](#why-a-bundle-and-not-a-preset-row)).

1. Make the package resolvable from the profile. The CLI does everything:

   ~~~sh
   dsh plugin --profile web add <path to this checkout>
   ~~~

   …or by hand, which keeps the lockfile untouched: a `link:` dependency plus the name in
   the ordered bundle list of `~/.dsh/profiles/web/package.json`, and a junction (Windows)
   or symlink (POSIX) so the profile can resolve it:

   ~~~json
   {
     "dependencies": { "dsh-plugin-toolscode": "link:../plugins/dsh-plugin-toolscode" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-toolscode"] } }
   }
   ~~~

   ~~~powershell
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-plugin-toolscode" "<path to this checkout>"
   ~~~

   ~~~sh
   ln -s "<path to this checkout>" "$HOME/.dsh/profiles/web/node_modules/dsh-plugin-toolscode"
   ~~~

2. The package contributes its own host row through `dsh.bundle.patch` (its
   [`cordis.patch.yml`](./cordis.patch.yml)):

   ~~~yaml
   - insert:
       - id: toolscode
         name: dsh-plugin-toolscode
         config: {}
   ~~~

3. Patch that row's config in the profile's own `cordis.patch.yml` ([Configure](#configure))
   and restart the harness. Copy-paste shapes for five common setups:
   [`examples/config-snippets.yml`](./examples/config-snippets.yml).

Two caveats measured on a real deployment:

- The profile patch can only `patch` an entry that already exists. A top-level
  `- id: toolscode` row without the bundle behind it fails the boot with
  `patch: entry "toolscode" not found`.
- After a restart, the first one or two assemblies in a scope may serve unshrunk bytes
  while the plugin fiber is being applied, so the saving starts a turn or two late. A
  profile-level mount narrows that window; `tools/measure.mjs` shows exactly which
  assemblies carry the shrink.

### Why a bundle and not a preset row

The plugins list is built from **Loader entries**: the host inventory maps
`ctx.loader.entries()`, and the plugin manager hands back an editable row (`patchId`) only
when the entry's own row sits in the profile patch. A row nested inside a preset's
`plugins:` list never becomes a Loader entry — it mounts per agent, surfaces only under
`agentPresets[].rows` of the raw inventory, and stays invisible to the plugins page and
its enable/disable toggle. That shape works (the shrink fires) while remaining completely
unlisted, which is the opposite of what you want at 3 a.m. The bundle row fixes visibility
and widens the win at once, because the mount is an ancestor of every agent.

### Display metadata

`locale/en.json` and `locale/th.json` carry `meta.title` / `meta.description` (what the
plugins list renders, localized), `icon.svg` the tile icon, and `package.json` exports
`./locale/*.json` and `./package.json` so the host can resolve them through the package
export map. Without them the row still lists, under the raw package name.

## Configure

Patched in the profile's `cordis.patch.yml`, over the row the bundle inserted. Every key
defaults to shrinking nothing that is not already shrunk by default, so an untouched
mount only costs you the wire shrink.

~~~yaml
- id: toolscode
  name: dsh-plugin-toolscode
  config:
    # --- wire tools[] (any presentation) ---
    enabled: true              # kill switch
    include: ["*"]             # globs of tool names to shrink
    exclude: []                # globs never shrunk (wins over include)
    minChars: 1200             # only shrink schemas whose JSON is at least this long
    descriptionCap: 200        # chars kept per tool description; 0 drops it
    nestedDescriptionCap: 100  # chars kept per property description; 0 drops them
    instructionsCap: 2000      # chars kept per mcp:* section; null disables
    # --- PTC mode: JSDoc prose of the generated declarations ---
    sdkDescriptionCap: null    # chars kept per JSDoc summary; null = full fidelity
    sdkTagCap: 120             # chars kept per @param / @returns line
    sdkBlockMinChars: 200      # JSDoc blocks at most this long stay untouched
    # --- PTC mode v0.2: the declarations themselves ---
    sdkSlimInclude: []         # globs whose declarations collapse to one line
    sdkSlimStyle: table        # table = one line per tool; lines = drop comments only
    sdkSlimDocCap: 0           # chars of each description kept inline; 0 drops them
    sdkSlimMinEntries: 8       # fewer matched entries than this -> rewrite nothing
    sdkSlimRecord: true        # drop the trailing & Record<string, JsonValue> escape hatch
    sdkOutputMap: keep         # 'stub' collapses ToolOutputMap to one index signature
    sdkSlimMarker: true        # append the 457-char note explaining what was dropped
    sdkSlimHeal: true          # answer an argument-shaped rejection of a slimmed tool
~~~

The shape deployed here (variant I above, −41.8% of the whole prompt with 10 MCP servers
on, PTC preset):

~~~yaml
    minChars: 600
    descriptionCap: 160
    nestedDescriptionCap: 80
    instructionsCap: 2000
    sdkDescriptionCap: 160
    sdkTagCap: 80
    sdkSlimInclude: ["mcp__*"]   # collapse the MCP flood; core tools keep full declarations
    sdkSlimStyle: table
    sdkSlimDocCap: 90
    sdkOutputMap: stub
~~~

Ideas worth stealing:

- `exclude: ["read", "write", "edit", "bash"]` — keep the core file tools fully described
  while shrinking the MCP flood.
- `include: ["mcp__*"]` — touch nothing that is not an MCP tool.
- `sdkDescriptionCap: 240, sdkTagCap: 120` — a careful first PTC step (−44% of the section
  instead of −49%).
- `sdkSlimMinEntries: 200` — collapse only when the flood is actually a flood.

## How it works

Four public-API mechanisms. No core patches, **no registry mutation**.

1. **Assembly-time wire shrink.** `dsh-system-prompt` builds the final request header —
   sections, contexts *and* `tools[]` — *before* running the `system-prompt/assemble`
   waterfall. A post-order listener (`after next()`) maps every tool whose JSON exceeds
   `minChars` through `shrinkToolSchema`: prose annotations are capped or dropped, while
   every structural keyword (`type`, `properties`, `required`, `enum`, `const`, bounds,
   `$ref`) is copied byte-for-byte, so validation semantics and provider-side strict modes
   are untouched.

   This works regardless of which scope layer registered the tools — which matters: in a
   web deployment the root-plane tool rows are often `disabled: true` and every preset
   mounts its own, so tools live in the preset's standing layer and are invisible to
   global-registry tricks (the first shadow-registration design measured exactly −0%
   because of this). The assembly is the one place every visible tool passes through,
   whatever its origin.

2. **Section shrink.** In the same waterfall `mcp:*` sections are truncated to
   `instructionsCap`, and — when `sdkDescriptionCap` is set — the `tools:sdk` section goes
   through `shrinkSdkSection`, which rewrites every JSDoc block longer than
   `sdkBlockMinChars`: summary capped, `@param` / `@returns` lines capped (the parameter
   name and the ` - ` separator survive), `@example` bodies dropped. Strip the comments
   from the result and you get the input back byte-for-byte — that structural invariant is
   a unit test, not a promise. `run_code`, the PTC transport itself, is never shrunk.

3. **Declaration slimming** (`lib/sdk-slim.js`, v0.2). The prose caps cannot reach the
   declarations, and with MCP servers attached the declarations dominate: 349 MCP tools
   cost 109k of a 157k character prompt. `slimEntries()` rewrites matched entries one per
   line (`table`) or strips their comments (`lines`), keeping tool names, argument names
   and types intact; `stubOutputMap()` collapses `ToolOutputMap` to
   `[toolName: string]: JsonValue | undefined`. Both are pure, opt-in and idempotent, and
   the renderer's own text between entries is never touched, so entries outside the
   include list stay byte-identical. What the compact table stops spelling out — the MCP
   result envelope, the disclosure path — is said once, in a 457-character note appended to
   the section (`sdkSlimMarker: false` drops it).

4. **Self-heal via `tools/post-execute`.** The plugin remembers the real wire schemas it
   shrank (refreshed every assembly). A thrown `ToolArgsError` is normalized by dispatch
   into an error result carrying `error.info.name` and *still flows through post-execute*;
   the listener blocks it with the original violations plus the full real parameter schema
   attached. Scope-filtered dispatch means the listener only sees calls made by agents
   under the mount scope. A tool whose *declaration* was slimmed is rescued the same way:
   an argument-shaped rejection — including the plain error objects MCP servers return,
   which never carry `ToolArgsError` — is answered with the live registry schema, or with
   the stored original declaration when the registry is out of reach. Runtime failures (a
   server that is simply down) are left exactly as they are, and `sdkSlimHeal: false`
   switches the rescue off.

**Determinism contract.** Every transform is a pure function of the assembled input, so
caches stay warm and a restart mid-conversation does not re-price the history. Reading an
uninjected service off `ctx` throws in cordis rather than returning `undefined`, which is
why the plugin declares `inject: ['systemPrompt', 'tools']` and keeps every registry
lookup inside a `try`.

## Verifying

After a restart, open a session on the patched preset. At the **first assembly** (not at
boot) the plugin logs one line per change of state:

```
toolscode: shrunk 39 tool schemas: 61736 -> 20072 chars (-67.5%); SDK section 140694 -> 75346 chars (-46.4%)
```

…and the logged `request/header` shows `…`-terminated descriptions. For anything beyond a
glance, measure from the session logs (a web server has no grep-able plugin log):

~~~sh
npm run measure                 # == node tools/measure.mjs
node tools/measure.mjs --limit=20 --preset=ptc
node tools/measure.mjs --replay=captured-tools-sdk.txt   # size a saved section offline
node tools/measure.mjs --json   # machine-readable
~~~

It decodes the multi-frame zstd session logs under `~/.dsh/sessions`, prints the wire /
instruction / `tools:sdk` sizes of every assembly, replays the shrinkers shipped in `lib/`
against them so you can sweep a config without restarting, and A/Bs two assemblies that
declared the *same* tool inventory — the only comparison that isolates the plugin from
what the conversation happened to contain. Needs Node >= 22.15 (for `zlib` zstd); no
dependencies.

## Tests

~~~sh
npm test          # 36 tests: pure + integration against a real cordis universe
npm run test:unit # 13 pure sdk-slim tests — no dependencies at all
~~~

The integration suite mounts the plugin into a real cordis universe (real `SystemPrompt`,
`ToolRuntime`, `dsh-scope` chains) on the **production topology**: tools registered in the
preset's own standing scope through a registrar row, both mount orders, and an
ancestor-scope (profile-level) mount whose self-heal is triggered by a nested agent. It
covers the shrunk assembly against an untouched second preset, untouched registry
definitions, real-dispatch self-heal (positive and negative), instruction scoping,
`minChars` / `include` / `exclude` steering, byte-stability across assemblies plus late
registration (the cache contract), config validation, deep `items` / `anyOf` recursion,
the SDK prose shrink, and the v0.2 slim (default keeps the section byte-identical; table +
stub compacts it while keeping every declaration; `sdkSlimMinEntries` gates the layout
rewrite while the stub stays independent; a rejected slimmed tool is answered with the
real contract; `sdkSlimHeal: false` stops the disclosure).

The suite needs the `@deepseek-ai/dsh` package. It looks for it in `DSH_ROOT`, then a
local/hoisted `node_modules`, then the npm global root. CI runs the pure suite on a Node
matrix without any install, and the full suite against the published harness package
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

## Limitations

- The shrink is lossy by design: a model that needs a dropped nuance learns it through the
  self-heal round-trip instead of paying for it on every step.
- `run_code` is never shrunk (its contract is what the model writes code against), so in
  PTC mode the wire side has nothing to shrink — the `tools:sdk` and `mcp:*` sections are
  the whole win there.
- The SDK shrink is text-level. A tool description containing a literal `*/` (a quoted glob
  like `**/*.ts`) already ends its JSDoc block early in the generated declarations; the
  shrinker follows that same boundary and never adds or removes a comment delimiter, so
  such a block loses its tail, not its head.
- Self-heal only arms after the first assembly served a shrunk schema — which is always,
  because the model can only call tools it has seen.
- Slimming cannot type what the harness never typed: a tool whose arguments already render
  as `unknown` stays `unknown` in the compact table. The real fix is upstream (map
  `type: [...]` unions in `jsonSchemaToTs`); `sdkSlimDocCap` is the mitigation here.
- `sdkOutputMap: stub` widens `keyof ToolOutputMap` to `string`, so `ToolName` stops being
  a closed union and a typo in a tool name surfaces as a plain runtime error instead of a
  type error. Nothing that ran before stops running; the stub only removes a
  documentation-grade list of 386 near-identical shapes.
- The note appended under a slimmed section is a fixed 457 characters. It pays for itself
  with the second slimmed tool; `sdkSlimMarker: false` removes it for a model that has
  already internalised the layout.
- The layout rewrite is a transform over the *renderer's* output: it expects
  `interface ToolArgsMap` with two-space-indented entries. If a future harness renders a
  different shape, `entryBlocks()` finds nothing and the section is served untouched —
  fail-safe by construction, and `test/fixtures/sdk-sample.txt` pins the current shape.
- Config lives in the profile patch, so it is read at boot: changing a cap means
  restarting the harness, and the first assembly after that may still be unshrunk.

## Repository layout

```
lib/index.js               plugin: config validation, the two waterfall listeners, self-heal
lib/shrink.js              pure wire / instruction / JSDoc prose shrinkers  (…/shrink)
lib/sdk-slim.js            pure declaration slimming + ToolOutputMap stub    (…/sdk-slim)
tools/measure.mjs          session-log measurer, no dependencies
test/unit.test.mjs         integration suite (real cordis universe, production topology)
test/sdk-slim.test.mjs     pure suite — text in, text out
test/fixtures/sdk-sample.txt  trimmed real tools:sdk section the structural contract is pinned to
locale/*.json, icon.svg    metadata rendered by the plugins page
cordis.patch.yml           the row the bundle inserts
examples/config-snippets.yml  copy-paste config shapes
```

## Contributing

Run `npm test` before opening a pull request, and keep the three structural invariants
intact: strip-the-comments-and-get-the-input-back for the prose shrink, every declaration
surviving a layout rewrite, and byte-identical output for an unchanged input. If you change
a transform, add the fixture case that pins it — those invariants are the reason this
plugin is safe to point at a 333-tool prompt.

## Requirements

- Node `^22.19.0 || >=24.0.0` (and >= 22.15 for `tools/measure.mjs`).
- A DSH profile with cordis >= 4.0.1. The wire and instruction shrinks work on any preset;
  the `sdk*` keys only apply to presets that present tools as a generated SDK (PTC mode).

## License

MIT — see [LICENSE](./LICENSE).

