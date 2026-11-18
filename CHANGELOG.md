# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-18

A compatibility fix for dsh 0.2.x, driven by the `latest` entry of the CI matrix going red.

### Fixed

- The assembly shrink pass no longer aborts when the `system-prompt/assemble` carrier has no
  `tools` array. dsh 0.2 moved tool presentation into a mountable tool executor
  (`ctx.tools.setExecutor`; `tools.mode` became `z.never()`), so the array is gone from the
  carrier and `result.tools.map` threw — the catch swallowed it and the section work was lost
  with it. `tools[]` is now handled only when present, so on 0.2+ the `mcp:*` instruction
  truncation, the SDK prose caps and the whole declaration slim keep shrinking (the bigger
  half of the win), and self-heal of a slimmed tool rejected by a server still fires.

### Changed

- The integration suite speaks both harness contracts. It feature-detects
  `ToolRuntime.prototype.setExecutor`, mounts `@deepseek-ai/dsh-tool-executor-native` when
  the harness refuses to assemble without one, dispatches through the batch form of
  `tools.execute()` (`{calls: [{id, name, arguments}]}` returning `{results: [{callId, result}]}`),
  and reads the registry through `definitions()` instead of the removed
  `resolveExecution()` / `sdkSchemas()`. Six tests that assert the moved mechanisms skip with an
  explicit reason instead of failing: the wire `tools[]` shrink (needs an executor wrapper)
  and the harness-side `ToolArgsError` rescue (0.2 validates inside the pipeline, before
  dispatch, so `tools/post-execute` never sees it).
- `.github/workflows/ci.yml`: the `latest` harness run is a hard gate again
  (`continue-on-error` removed) now that both matrix entries pass.

### Known gap

- On dsh >= 0.2 the wire shrink is inert until the plugin can wrap the executor. Documented
  in README Limitations; the section-shaped features above are what the deployed win depends on.

## [0.2.0] - 2026-11-13

The release that matters once MCP servers are attached: the **declarations** themselves,
not just their prose. In PTC mode the generated `tools:sdk` section is where the schemas
hide, and with 349 MCP tools it is 109k of a 157k character prompt before the first user
message.

### Added

- `lib/sdk-slim.js` — pure, idempotent declaration slimming:
  `slimEntries()` rewrites matched entries one per line (`table`) or strips their comments
  (`lines`), keeping tool names, argument names and types byte-identical; `stubOutputMap()`
  collapses the near-identical `ToolOutputMap` result typings into one index signature.
- Config keys `sdkSlimInclude`, `sdkSlimStyle`, `sdkSlimDocCap`, `sdkSlimMinEntries`,
  `sdkSlimRecord`, `sdkOutputMap`, `sdkSlimMarker`, `sdkSlimHeal` (all documented in
  README; every one defaults to shrinking nothing, so an existing mount is unaffected).
- Self-heal for slimmed declarations: an argument-shaped rejection — including the plain
  error objects MCP servers return, which never carry `ToolArgsError` — is answered with
  the live registry schema, or with the stored original declaration when the registry is
  out of reach. Runtime failures (a server that is simply down) are left untouched.
- A fixed 457-character note appended once under a slimmed section, saying what the
  compact table stopped spelling out (the MCP result envelope, the disclosure path).
- `test/sdk-slim.test.mjs`: 13 pure tests (idempotence, structural contract, gating,
  include/exclude, stub independence, note placement).
- `tools/measure.mjs`: dependency-free session-log measurer — decodes the zstd session
  logs, reports the served `tools:sdk` size and which shrink fingerprints are present,
  and A/Bs two assemblies that declared the same tool inventory.

### Fixed

- The plugin did not declare `inject: ['systemPrompt', 'tools']`. Reading an uninjected
  service off `ctx` throws in cordis rather than returning `undefined`, so the registry
  lookup inside the self-heal path died as an swallowed error and slimmed tools were
  never rescued. The lookup now runs entirely inside a `try`.
- Test harness resolution: `DSH_ROOT`, then a local/hoisted `node_modules` install, then
  the npm global root — instead of one hardcoded absolute path.

### Docs

- README rewritten around the measured variants A–J (whole-prompt −41.8% at the
  recommended `sdkSlimDocCap: 90`, −62.2% at `0`), including why 90 characters of
  description are worth keeping: 241 of 349 MCP tools render their arguments as
  `unknown` because MCP servers emit `"type": ["string", "number"]` unions, which the
  SDK type renderer answers with `unknown`.

## [0.1.0] - 2026-10-22

### Added

- Assembly-time wire shrink of oversized tool schemas (`include`, `exclude`, `minChars`,
  `descriptionCap`, `nestedDescriptionCap`): prose annotations capped or dropped, every
  structural JSON Schema keyword copied byte-for-byte, `run_code` never touched.
- `instructionsCap` for `### MCP server: …` instruction sections.
- `sdkDescriptionCap` / `sdkTagCap` / `sdkBlockMinChars`: JSDoc prose shrink for the PTC
  `tools:sdk` section, opt-in, with the structural invariant (strip the comments and you
  get the input back) enforced by a test.
- Self-heal through `tools/post-execute`: a `ToolArgsError` comes back with the original
  violations plus the full real parameter schema attached.
- Profile-bundle deployment shape (`dsh.bundle.patch` + a bundle entry) so the row is a
  Loader entry and therefore visible to the plugins page and its enable/disable toggle;
  localized `meta.title` / `meta.description` and `icon.svg`.
- 23 tests against a real cordis universe on the production topology (tools registered
  in the preset's own layer, ancestor mount, self-heal from a nested agent, byte-stability
  across assemblies).
