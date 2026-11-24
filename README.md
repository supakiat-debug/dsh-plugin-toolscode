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
| oversized tool `description` and nested property descriptions in the wire `tools[]` | cap or drop; `title` / `examples` dropped | on (dsh 0.2: set `executor: wrap`) |
| `### MCP server: …` instruction sections | truncate to `instructionsCap` | 2000 chars |
| **PTC mode** — JSDoc prose of the generated SDK declarations (the `tools:sdk` section) | cap the summary and each `@param` / `@returns` line | off |
| **PTC mode, v0.2** — the declaration *layout* of matched tools, plus `ToolOutputMap` | one line per tool; result typings collapsed to one index signature | off |
| redundant tools (`v0.4`) | `drop` globs take the definition off the wire; the registry still dispatches it. In PTC mode the same names are also cut out of the generated `tools:sdk` declarations — there, they *are* the wire | off |
| a paragraph the harness owns (`v0.4`) | `sectionText` / `contextText` serve your own summary instead; `''` removes the entry | off |
| **PTC mode, v0.5** — the per-tool guidance sections that tell the model to call a tool by name, which PTC forbids | `ptcDropSections` removes them by glob, `ptcSectionText` serves your own SDK-shaped wording; fires only on an assembly that really serves the SDK | off |
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

Those captures are 0.1 traffic. The shrink is a transform over the schemas, not over a
carrier, so on dsh 0.2 the identical pass at `describe()` time emits byte-for-byte the same
schemas — pinned by the integration suite on both harnesses rather than by a second capture.

### Why 90 characters of description are worth keeping

The harness renders an MCP tool's arguments as `unknown` whenever its JSON Schema uses a
construct the SDK type renderer does not map — in practice `"type": ["string", "number"]`
unions, which MCP servers emit freely and `jsonSchemaToTs` answers with `unknown`.
**241 of the 349** MCP tools in that deployment render that way, so for them the
description is all the declaration says. Keep `sdkSlimDocCap: 90` unless every server
ships scalar-only schemas; `0` (variant H) is for boxes where the model already knows
the servers by heart. Fixing the renderer upstream would shrink the section further on
its own.

### The PTC contradiction (`ptcDropSections` / `ptcSectionText`, v0.5)

PTC takes the tool wire away and leaves the advice in place. `dsh-tools` adds one sentence
(`tools:ptc-only`, 180 chars, order 800) saying `run_code` is the only tool it may call, and
then the tool packages add ~4,600 chars of imperative guidance at orders 1010–2900: *use the
read tool*, *use the grep tool*, *call present*. Over one captured assembly **19 of its 30
prompt blocks — 7,677 characters — name a tool the model is not allowed to call**, against
180 chars of the rule that says otherwise, ordered first: **43:1, with the instruction last**.
A model that follows the newest, most specific sentence emits `read` as a tool call and gets
back `UNKNOWN_TOOL`, because `collapses()` denies the native name rather than rescuing it.

`ptcDropSections` takes those sections out by glob; `ptcSectionText` then serves this
deployment's own wording of whatever rule still holds from inside a program. Detection is
that sentence itself: PTC is where the SDK declarations are being served *and* the harness
is serving `tools:ptc-only` with its text. It is never read off config, because presentation
is per scope — a native agent beside a PTC one under the same mount keeps every paragraph it
was given. Mode `both` is why the sentence, and not the wire, is the signal: it serves the
declarations while a native call still works. And on dsh ≥ 0.2 the wire cannot be read here
at all — `tools[]` comes from a mountable executor that contributes it after this waterfall,
so an absent array says nothing; where a harness registers no rule section either, the wire
decides, and only when the carrier really carries one.

Deployed here and replayed over the captured live prompt (`research/prompt-shrink/measure-ptc.mjs`):

| surface | harness default | with the v0.5 row | |
| --- | --- | --- | --- |
| 18 tool-guidance sections, PTC assembly | 6,032 | 3,271 | **−46%** |
| the same sections, native assembly (v0.4 rewrites only) | 6,032 | 4,328 | −28% |
| `tools:sdk`, raw 140,694 → slim + `drop` | 140,694 | 73,147 | **−48%** |

Nine sections go (`tool:write`, `tool:edit`, `tool:glob`, `tool:grep`, `tool:doc_*`,
`tool:subagent*`) and the rules that survive land in one 631-char paragraph on `tool:read`,
written as `tools.x(…)` calls; the globs are deliberately loose because upstream builds those
names as `tool:${toolName}`. The same `drop` list now also cuts the dropped tools'
declarations out of the SDK — 1,742 more characters — since in PTC the declarations are the
wire. `ptcDropSections` runs before `ptcSectionText`, and an override can never re-add a
section: keep the consolidated text on a name you did not delete. A configured name the
assembly does not serve is a silent no-op, so the plugin warns and prints the names it
*does* serve.

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

## Other harnesses: pi and Hermes

The shrink is not a dsh concept with dsh plumbing bolted on. Since v0.6 the part
that decides what to cut lives in [`lib/wire.js`](./lib/wire.js), which walks a
*provider request payload* rather than a section registry, and knows the three
shapes a payload comes in (OpenAI chat, OpenAI Responses, Anthropic — plus where a
system prompt hides: a `role: system` message, an `instructions` field, or a
`system` list of text blocks). Everything below is that one module wearing a
harness's clothes; `npm run test:parity` proves the Python port still produces
byte-identical output.

### pi (`@earendil-works/pi-coding-agent`)

`package.json` advertises [`extensions/toolscode.mjs`](./extensions/toolscode.mjs)
under `pi.extensions`, so `pi install github:supakiat-debug/dsh-plugin-toolscode`
picks it up, and pi loads extensions with `jiti` — no build step, and no
`@earendil-works/pi-*` import in the file, because pi provides those and a plugin
that imports its host's internals breaks when they move.

pi has no pre-request hook that can replace `tools[]`, so the adapter uses the two
levers it does have, and they are better ones for being narrower:

- **`prepareLoadout` on a carrier tool** rewrites declarations before the provider
  sees them. The carrier is a no-argument `toolscode` tool whose `execute` prints
  what the shrink did — declarations before/after, which tools shrank, what the
  prompt inputs cost — because a shrink you cannot interrogate is a shrink you
  cannot tune.
- **`before_agent_start`** caps the *prompt inputs* — `toolSnippets[name]`,
  `toolGuidelines[name]`, `promptGuidelines[]` — which pi turns into its `tools`
  and `rules` system sections, and which are where the real per-tool prose sits.
  `sections.docs` can be replaced, or set to a single space to blank it: pi copies
  a custom section only `if (content)`, so `''` is silently ignored and a space is
  the only way to remove a block you do not want.
- **`before_provider_request`** is available for a raw payload rewrite and is wired
  to `shrinkWirePayload` behind `wire: true`, off by default: it is the fallback,
  not the plan, and a rewrite there is invisible to `ctx.getSystemPrompt()`.

Config: `~/.pi/agent/toolscode.json`, then `./.pi/toolscode.json`, then
`TOOLSCODE_ENABLED` / `TOOLSCODE_DROP` / `TOOLSCODE_DESCRIPTION_CAP` / `TOOLSCODE_WIRE`.

Two pi-specific rules the adapter follows, both measured rather than assumed:

- **It writes no descriptions when `codemode` is in the loadout.** pi's PTC is
  `codemode`, and its own `prepareLoadout` rewrites every callable tool's
  description to append the `tools.x(args)` call form. pi collects hooks only from
  active tools and merges them into one `descriptions` map, last writer wins — so
  two shrinkers in one loadout is a coin toss on which prose the model reads.
  `drop` still applies (hiding a declaration is not prose), and the carrier reports
  `skipped for codemode; use codemode.inlineBudget` because pi's own knob is the
  right one there.
- **A tool cannot be unregistered, only hidden**, so `drop` maps to
  `hiddenDeclarations` and the tool stays callable by anything that already knows
  it — same honesty rule as `drop` on dsh, which is why the report names every
  removal.

### Hermes Agent (`hermes-agent`)

[`adapters/hermes/`](./adapters/hermes/README.md) is the same shrink as an
`llm_request` middleware — the only hook in Hermes whose return value replaces the
request — plus a standard-library Python port of `lib/wire.js` and
`lib/shrink.js`. Read that directory before turning it on: Hermes already defers
its own tool catalog (`tools.tool_search`) and caps its skill index
(`skills.index_desc_limit`), and the descriptions of its `tool_search` bridge tools
and `execute_code` embed a *generated tool list*, which is why they are excluded by
default. The win on Hermes is the prose Hermes does not manage: MCP tools,
third-party plugin tools, your own `register_tool` definitions.

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
    executor: 'off'            # dsh 0.2 only: 'wrap' shrinks the wire through the executor
    include: ["*"]             # globs of tool names to shrink
    exclude: []                # globs never shrunk (wins over include)
    minChars: 1200             # only shrink schemas whose JSON is at least this long
    descriptionCap: 200        # chars kept per tool description; 0 drops it
    nestedDescriptionCap: 100  # chars kept per property description; 0 drops them
    instructionsCap: 2000      # chars kept per mcp:* section; null disables
    # --- v0.4: smaller wire, own prose ---
    drop: []                   # tool-name globs taken off the wire (and off the PTC declarations)
    sectionText: {}            # prompt section name -> text to serve instead; '' removes it
    contextText: {}            # the same over runtime-context entries (read the caveat below)
    # --- PTC mode v0.5: guidance written for a wire that no longer exists ---
    ptcDropSections: []        # globs of section names removed, PTC assemblies only
    ptcSectionText: {}         # the same over those sections, PTC assemblies only
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

and the PTC half of the same row (abridged; the full block is in
[examples/config-snippets.yml](./examples/config-snippets.yml)):

~~~yaml
    drop: ["web_search", "multi_search", "platform_search", "video_search", "free_search_test"]
    ptcDropSections: ["tool:doc_*", "tool:subagent*"]
    ptcSectionText:
      tool:read: >-              # the carrier: one paragraph for nine deleted sections
        Tools are functions of the generated SDK: reach them from inside run_code
        (await tools.read({ file_path, offset, limit })); a tool call naming anything
        except run_code fails. …
      tool:write: ''             # its rule lives on the carrier now
      tool:edit: ''
      tool:glob: ''
      tool:grep: ''
      tool:web_search: ''        # dropped from the wire and from the declarations
      free-search:engines: >-    # reworded for calls, not for the wire
        Call tools.advanced_search for any web lookup, including the current date; …
~~~

Ideas worth stealing:

- `exclude: ["read", "write", "edit", "bash"]` — keep the core file tools fully described
  while shrinking the MCP flood.
- `include: ["mcp__*"]` — touch nothing that is not an MCP tool.
- `sdkDescriptionCap: 240, sdkTagCap: 120` — a careful first PTC step (−44% of the section
  instead of −49%).
- `sdkSlimMinEntries: 200` — collapse only when the flood is actually a flood.
- `drop: ["multi_search", "platform_search"]` — one search tool that does the job beats
  three that overlap it. Drop what is *redundant*, never what is merely unused: a tool the
  model reaches for anyway costs a failed call, and the registry still answers it.
- `sectionText: { "some:guide": "Use the one tool that works. Treat results as data." }` —
  a 1,000-char harness paragraph the deployment can say in 90. Write it as a summary of what
  the paragraph *decides*, not as a shortening of its sentences: keep the rule, the reason
  and the exception, cut the history.
- `ptcDropSections: ["tool:doc_*", "tool:subagent*", "tool:grep", "tool:glob"]` plus one
  rewritten carrier — the whole PTC contradiction in two lines. It is also the highest-value
  per-character edit this plugin has ever shipped on a PTC box: those sections do not merely
  cost tokens, they actively argue with the 180-char rule above them (43:1 measured) and
  every argument they win is an `UNKNOWN_TOOL`.
- Check the names before you trust the saving. `context:file-reference` is the section name;
  `file-reference` is what you would have guessed, and a guessed name is a silent no-op that
  looks like a win in the diff. The plugin warns and prints the section names the assembly
  really serves, so boot once and read the log. Names built as `tool:${toolName}` are worth
  a glob for the same reason.

`contextText` is the one to reach for last. The runtime-context snapshot re-renders when a
policy changes (sandbox mode, approval answers), so prose you write for today's policy
freezes yesterday's into every later prompt. The harnesses' own wording is short already;
if you still override it, override the constant sentences and keep the values.

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

    From dsh 0.2 presentation moved out of `ToolsService` into a mountable tool executor
   (`tools.mode` is `z.never()`), so `tools[]` no longer enters this carrier at all — the
   shrink moves with it. With `executor: wrap` the plugin registers a wrapper over the
   executor the scope already selected: `describe()` runs exactly the pass above over what
   the inner executor returns, `execute()` delegates untouched, and the bytes the model
   reads are the same bytes either way. When to turn it on, and why it refuses to shadow a
   PTC executor, is in [The executor contract](#the-executor-contract-dsh-0-2).

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
   switches the rescue off. On dsh 0.2 the arguments are rejected inside the pipeline, ahead
   of dispatch, and the normalized `ToolArgsError` still arrives on this hook (verified
   against 0.2.2-rc.1) — armed by `describe()` instead of the assembly.

### The executor contract (dsh 0.2)

0.2 turned tool presentation into a mountable service: `ctx.tools.setExecutor(executor)`
takes an object with `describe(definitions)` and `execute(batch)` — one executor per scope —
and `selectExecutor(scope)` answers with the nearest one walking up the scope chain. The
plugin's wrapper is that object with a shrink in the middle, and it mounts only when asked:

- `executor: 'wrap'` (default `'off'`, which is all dsh 0.1 needs) resolves the executor the
  mount scope selects and registers a wrapper over it on the plugin's own scope, so **the row
  has to mount below the executor row**. In the real deployment the executor is the profile
  default and this bundle's row is a profile patch: nearer to the agents, so the wrapper
  serves them and every scope under them, while an agent that resolves a different executor
  keeps that executor's contract.
- The wrapper presents no sections of its own and refuses to replace an executor that does.
  A PTC executor owns `tools:ptc-only` and `tools:sdk`, and an executor's section renders only
  while it is the selected one — shadow it and the very section this plugin shrinks goes blank
  for exactly the agents the wrapper was meant to help, traded away for a wire that in PTC mode
  carries nothing but `run_code`. So: `wrap` where the native executor presents, `off` where a
  PTC executor does, and the plugin logs that reasoning instead of overriding it.
- `execute()` is a pure delegate. The pipeline emits `tools/post-execute` for every call it
  ran, including the ones it rejected itself, so self-heal needs no second path — only the
  real schemas, which `describe()` now hands it exactly as the assembly used to.
- Every refusal is a warning, never a throw: no executor in the composition, an executor that
  owns sections, a scope already carrying a wrapper (the first stays in charge), a harness
  without the contract at all. A plugin that throws at mount takes the agent down with it.

The shrink inside the wrapper is the same pure `shrinkToolSchema` pass, so it is as
byte-stable as the assembly one — a test assembles twice and compares bytes.

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

With `executor: wrap` one more line is logged per scope, at mount rather than at assembly:

```
toolscode: shrinking the wire schemas of "NativeToolExecutor" through an executor wrapper
```

…and every refusal it decided against is a warning naming the executor and the reason.

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
npm test           # 82 tests: 37 integration against a real cordis universe (4 skip on 0.1),
                   # 18 wire, 13 pure sdk-slim, 14 pi — no dsh needed for the last three
npm run test:unit  # the integration suite alone, against a real cordis universe
npm run test:pi    # the pi adapter against a stubbed ExtensionAPI
npm run test:hermes # the Hermes adapter + its Python port, standard library only
npm run test:parity # JS and Python shrinkers over the same payloads, compared as text
~~~

The wire and pi suites need no harness at all: the wire suite drives
`shrinkWirePayload` with four pinned provider payloads, the pi suite hands the
extension a stubbed `ExtensionAPI` and a stubbed `ToolLoadout` and asserts the
changes it returns — including the two rules that only exist because of how pi
behaves (no descriptions written when `codemode` is in the loadout; a `drop` that
still hides declarations in that case).

The integration suite mounts the plugin into a real cordis universe (real `SystemPrompt`,
`ToolRuntime`, `dsh-scope` chains) on the **production topology**: tools registered in the
preset's own standing scope through a registrar row, both mount orders, and an
ancestor-scope (profile-level) mount whose self-heal is triggered by a nested agent. It
covers the shrunk assembly against an untouched second preset, untouched registry
definitions, real-dispatch self-heal (positive and negative), instruction scoping,
`minChars` / `include` / `exclude` steering, byte-stability across assemblies plus late
registration (the cache contract), config validation, deep `items` / `anyOf` recursion,
the SDK prose shrink, the v0.2 slim (default keeps the section byte-identical; table +
stub compacts it while keeping every declaration; `sdkSlimMinEntries` gates the layout
rewrite while the stub stays independent; a rejected slimmed tool is answered with the
real contract; `sdkSlimHeal: false` stops the disclosure), and the executor wrapper:
shrunk presentation over an untouched registry, byte-stable `describe()`, a section-owning
executor declined, a missing executor survived, a second row in one scope left to the first.

The same integration suite covers **both** dsh harness contracts, feature-detected
rather than version-parsed: 0.1 shrinks through the assemble carrier, 0.2 through
the executor, and every wire assertion in between is identical. Only the three
cases that exist solely to pin the executor contract skip on 0.1, with a printed
reason (four skips in total on the pinned install).

The integration job runs the suite twice: against the pinned harness version this plugin
is deployed against, and against the `latest` dist-tag. Both are hard gates, and both are
green with no skipped wire or self-heal case: on 0.2 the universe mounts
`@deepseek-ai/dsh-tool-executor-native` at the root, dispatches through the batch form of
`tools.execute()`, reads the registry through whichever accessor exists, and runs the plugin
with `executor: wrap`.

The suite needs the `@deepseek-ai/dsh` package. It looks for it in `DSH_ROOT`, then a
local/hoisted `node_modules`, then the npm global root. CI runs the pure suite on a Node
matrix without any install, and the full suite against the published harness package
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

## Limitations

- On dsh >= 0.2 the wire shrink needs `executor: wrap`: 0.2 deleted the built-in presentation
  (`tools.mode` is `z.never()`), so `tools[]` no longer passes through
  `system-prompt/assemble` and a post-order listener has nothing left to map. Wrapping is
  opt-in rather than automatic on purpose — it takes over a presentation the deployment
  mounted, and silently re-plumbing someone else's is not a plugin's call. Turn it on per
  scope, and not where a PTC executor presents (it owns the sections; see
  [The executor contract](#the-executor-contract-dsh-0-2)). Everything section-shaped works
  unchanged on both harnesses, and that is where the measured win lives: `mcp:*` instructions,
  SDK prose, the declaration slim, and self-heal of a rejected call — the harness's own
  argument rejection still reaches `tools/post-execute` on 0.2.
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
- PTC detection reads the assembly, and on dsh 0.2 an executor-owned `tools[]` never appears
  in it. The rule is therefore "the SDK section is served and no other callable name is":
  on 0.2 that means any assembly served alongside a `tools:sdk` section counts as PTC, which
  is what a PTC executor serves and nothing else does. PTC *with* `executor: wrap` is out of
  scope either way — `mountExecutorShrink` deliberately bails on an executor that owns
  sections, so the wire shrink stays off and only the section work runs.
- In PTC mode `drop` removes a *declaration*, not a capability: the tool stays registered, so
  a model that remembers its name can still `await tools.that_name({...})` from inside
  `run_code`. What you are cutting is the typed contract it would have read, which is exactly
  the point for a redundant tool and a bad idea for one the model needs.
- The PTC prose keys are per section name. Names the harness builds as `tool:${toolName}`
  (`tool:doc_read`, `tool:subagent`, …) are stable only as long as the tool names are, so
  prefer a glob there and read the boot warning when a key stops matching.
- The layout rewrite is a transform over the *renderer's* output: it expects
  `interface ToolArgsMap` with two-space-indented entries. If a future harness renders a
  different shape, `entryBlocks()` finds nothing and the section is served untouched —
  fail-safe by construction, and `test/fixtures/sdk-sample.txt` pins the current shape.
- Config lives in the profile patch, so it is read at boot: changing a cap means
  restarting the harness, and the first assembly after that may still be unshrunk.
- On pi the adapter caps only what pi lets it cap. There is no setter for a tool's
  `parameters`, or for a single property's description, outside re-registering under
  the same name — so `nestedDescriptionCap` does nothing on the loadout path, and
  per-property prose only shrinks with `wire: true`, which rewrites the raw payload
  and is therefore invisible to `ctx.getSystemPrompt()`. `prepareLoadout` also sees
  `loadout.declared` *before* pi patches it, so a carrier cannot read what another
  hook wrote; that is why the codemode rule is "write nothing" rather than "merge".
- On Hermes the win is narrower than on dsh, on purpose: `tools.tool_search` already
  defers tools with a real fetch-back path, `skills.index_desc_limit` already caps
  the skill index, and the `tool_search` bridge tools plus `execute_code` embed a
  generated tool list in their own descriptions, so they are excluded by default.
  What is left to shrink is MCP tools, third-party plugin tools, and your own
  `register_tool` definitions.
- The two implementations count characters differently: JavaScript counts UTF-16
  code units, Python counts code points, so a cap applied to emoji-heavy prose can
  land one character apart on the two sides. Tool descriptions are not emoji-heavy,
  and the parity run over the shared fixture is byte-identical.
- No pi or Hermes numbers here are token counts. Neither harness was run live (no
  API keys), so everything in this repository is a character count, and the fixture's
  tool universe is written to be representative rather than extracted from either
  harness. `tools/measure.mjs` still measures real dsh session logs.

## Repository layout

```
lib/index.js               plugin: config validation, two waterfall listeners, self-heal,
                           the dsh 0.2 executor wrapper
lib/shrink.js              pure wire / instruction / JSDoc prose shrinkers  (…/shrink)
lib/wire.js                harness-neutral payload shrink: three provider shapes,
                           five places a system prompt hides             (…/wire)
lib/sdk-slim.js            pure declaration slimming + ToolOutputMap stub    (…/sdk-slim)
extensions/toolscode.mjs   pi adapter: prepareLoadout + before_agent_start (+ wire opt-in)
adapters/hermes/           Hermes adapter: llm_request middleware + the Python port of
                           lib/{shrink,wire}.js, stdlib only, with its own README
tools/measure.mjs          session-log measurer, no dependencies
tools/parity.mjs|.py       cross-language parity: same payloads, both shrinkers, diffed
test/unit.test.mjs         integration suite (real cordis universe, production topology)
test/wire.test.mjs         pure suite over four pinned provider payloads
test/pi.test.mjs           pi adapter against a stubbed ExtensionAPI
test/sdk-slim.test.mjs     pure suite — text in, text out
adapters/hermes/test_wire.py  the same fixture, asserted in Python
test/fixtures/wire-payloads.json  the contract both languages pin their strings to
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
- A DSH profile with cordis >= 4.0.1. CI runs the integration suite against the pinned
  0.1.7-rc.2 install and against `latest` (0.2.2-rc.1 at the time of writing): the same tests
  pass on both, and on 0.2 the wire shrink asks for `executor: wrap` plus an executor row
  mounted above the plugin row (`@deepseek-ai/dsh-tool-executor-native` or your own). The
  wire and instruction shrinks work on any preset; the `sdk*` keys only apply to presets that
  present tools as a generated SDK (PTC mode), where `executor` stays `'off'`.
- For the other harnesses: pi `@earendil-works/pi-coding-agent` >= 1.6 (Node >= 22.19) — the
  adapter imports nothing from pi, it only implements the `ExtensionAPI` contract, so it keeps
  working across pi releases that move internals. Hermes Agent (`hermes-agent`) wants Python
  `>=3.11,<3.14`; the port is standard library only, and its tests pass on 3.14 — a version
  Hermes itself cannot be installed onto, which is exactly why they are written that way.
  Neither adapter needs the dsh peers; all three are marked optional.

## License

MIT — see [LICENSE](./LICENSE).

