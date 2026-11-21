/**
 * dsh-plugin-toolscode — shrink model-facing tool schemas and MCP server
 * instructions for the agents composed under the scope this plugin is
 * mounted in (normally an agent preset's `plugins` list).
 *
 * How it works (all public prompt/dispatch API, no core patches, no
 * registry mutation):
 *
 * 1. The `system-prompt/assemble` waterfall receives the fully assembled
 *    request header — `sections`, `contexts`, AND the final `tools[]` wire
 *    schemas (`dsh-system-prompt` builds `tools` before any waterfall
 *    runs; from dsh 0.2 the same array is presented by a mountable tool
 *    executor instead, so the shrink moves with it (item 7). After the
 *    awaited next() call this plugin maps every tool whose JSON exceeds
 *    `minChars` through `shrinkToolSchema`: prose annotations (`description`,
 *    nested `description`, `title`, `examples`) are capped or dropped; every
 *    structural keyword (`type`, `properties`, `required`, `enum`, `const`,
 *    bounds, `$ref`) is copied byte-for-byte, so validation semantics and
 *    provider-side strict modes are untouched.
 *
 *    This works regardless of which scope layer registers the tools — and
 *    that matters: in the DSH web deployment the root-plane tool rows are
 *    `disabled: true` and every preset mounts its own tool rows, so tools
 *    live in the preset's standing layer, invisible to global-registry
 *    tricks. The assembly is the one place every visible tool passes
 *    through, whatever its origin (core, MCP, scoped shadow).
 *
 * 2. Dispatch, argument validation, output validation and presentation all
 *    keep using the real definition untouched — the wire schema is only
 *    ever *read* by the model, never executed.
 *
 * 3. MCP `### MCP server: …` instruction sections are truncated in the same
 *    waterfall (`mcp:*` sections only).
 *
 * 4. PTC mode: when the preset presents tools as a generated SDK (the
 *    tools:sdk section) the schemas never appear in tools[] at all, so the
 *    JSDoc prose of the declarations is capped instead — opt-in via
 *    sdkDescriptionCap, off by default, structure never touched.
 *
 * 5. PTC mode, v0.2 — structural slimming (see ./sdk-slim.js). The prose caps
 *    cannot touch the declarations themselves, and on an MCP-heavy deployment
 *    they dominate: 349 MCP tools cost 109k of a 157k character prompt. With
 *    sdkSlimInclude the entries are rewritten one per line (names, argument
 *    names and types preserved — only layout, comments and the Record escape
 *    hatch go), and with sdkOutputMap 'stub' the ToolOutputMap result typings
 *    collapse to an index signature. Both are pure and opt-in; the registry is
 *    never touched, so every call still resolves against the real schema.
 *
 * 6. Self-heal: the plugin keeps the real wire schemas it shrank (refreshed
 *    on every assembly). When the model sends arguments the real schema
 *    rejects, the `tools/post-execute` waterfall sees the normalized
 *    `ToolArgsError` (`result.error.info.name`) and blocks the result with
 *    the original message plus the full real parameter schema attached —
 *    the wire stays small and the complete contract arrives exactly when
 *    the model proves it needs it. A tool whose declaration was slimmed
 *    self-heals the same way, from the live registry or the stored original
 *    block, because the compact table is a layout-only summary.
 *
 * 7. dsh >= 0.2, executor: wrap. Presentation and dispatch moved out of
 *    ToolsService into a mountable tool executor: selectExecutor(scope)
 *    .describe(definitions) is what the model reads there, and the assemble
 *    waterfall no longer sees tools[] at all. The plugin then wraps the
 *    deployment executor: describe() shrinks exactly as in item 1, execute()
 *    delegates untouched, so the real pipeline keeps validating and running
 *    every call. An executor presenting its own prompt sections (the PTC
 *    executor tools:sdk) is never shadowed - its text renders only while it
 *    is the selected executor, and in that mode tools[] carries just the
 *    entrypoint tool, so shadowing would trade the SDK shrink for nothing.
 *
 * 8. Owning the prose (v0.4) and the PTC contradiction (v0.5). `drop` takes
 *    tool definitions off the wire — and out of the PTC declaration section,
 *    which is the same surface under `ptc` — while `sectionText` /
 *    `contextText` serve this deployment's own summary in place of a paragraph
 *    the harness owns (`''` removes it; a name that vanished upstream is
 *    reported, never invented). `ptcDropSections` / `ptcSectionText` apply only
 *    when the assembly presents `run_code` as the sole callable tool: every
 *    tool package registers guidance naming itself, none of them know about
 *    presentation, and they are ordered after the harness' one-sentence rule —
 *    so a PTC agent reads ~15 paragraphs telling it to emit calls the collapse
 *    answers with `UNKNOWN_TOOL`. Deleting them is the fix; the rules that
 *    still hold from inside a program belong in `ptcSectionText`.
 *
 * Determinism contract: the shrink is a pure function of the assembled
 * input, so two assemblies of an unchanged state are byte-identical —
 * `toolsChanged()` sees no churn and the KV / prompt cache stays warm.
 *
 * Mount it as a plugin inside an agent preset's `plugins` list to shrink
 * just that preset's agents (preset rows mount in the preset's standing
 * scope, the agents' ancestor); a profile-level row shrinks every agent.
 *
 * @module dsh-plugin-toolscode
 */

import { globMatch, schemaChars, shrinkInstructions, shrinkSdkSection, shrinkToolSchema } from './shrink.js'
import { SLIM_MARKER, collectBlocks, dropDeclarations, slimEntries, stubOutputMap } from './sdk-slim.js'

/** Accepted values of the executor config key. */
const EXECUTOR_MODES = ['off', 'wrap']

const DEFAULTS = {
  enabled: true,
  /**
   * dsh >= 0.2 only: wrap mounts a shrinking wrapper around the deployment
   * tool executor, which is what presents tools[] there. off - the default,
   * and all that 0.1 needs - leaves the mounted executor in charge, because
   * the assembly waterfall already carries tools[] on that harness.
   */
  executor: 'off',
  /** globs of tool names to shrink (always all when empty). */
  include: ['*'],
  /** globs of tool names never to shrink; wins over include. */
  exclude: [],
  /**
   * globs of tool names taken off the wire entirely. Dispatch is untouched —
   * the registry still answers a call — the model just never sees the
   * definition, so a tool this deployment does not want used stops costing a
   * description. In PTC mode the same names are cut out of the generated
   * `tools:sdk` declarations too, because there the declaration section is
   * what the model reads instead of tools[]. Empty by default: dropping a tool
   * the model does need costs a failed call, which is a deliberate trade, not a
   * tidy-up. Use it for redundancy (`['multi_search']` when `advanced_search`
   * covers it), never on a hunch.
   */
  drop: [],
  /**
   * section name -> the exact text to serve in its place, applied post-order
   * to the assembled prompt, so what is served is exactly what ships; `''`
   * removes the section. Names that are not present are skipped and reported,
   * never created: an upstream rename must cost nothing, not inject a stale
   * paragraph under a heading the harness no longer has.
   */
  sectionText: {},
  /**
   * the same for entries of the runtime-context snapshot (the message the
   * harness appends after the system prompt). Prefer leaving these alone:
   * unlike static guidance, they re-render when a policy changes, and a
   * hand-written replacement freezes the old policy into every prompt.
   */
  contextText: {},
  /**
   * PTC mode only, v0.5: globs of prompt section names removed while the
   * assembly presents `run_code` as the only directly callable tool.
   *
   * Every tool package registers its own guidance section naming itself ("Use
   * the read tool — not shell commands"), and none of them know which
   * presentation the agent is running: under `ptc` the harness adds one
   * sentence saying only `run_code` may be named, then ~15 paragraphs say the
   * opposite, ordered after it. The model reads a catalogue of tools it is
   * told to use, emits a native call, and gets `UNKNOWN_TOOL` for a tool the
   * prompt just declared. Removing the paragraphs is the fix; the rules that
   * still hold when the tool is reached from inside a program belong in
   * `ptcSectionText` instead of being deleted with them.
   */
  ptcDropSections: [],
  /**
   * PTC mode only, v0.5: section name -> text, applied after `sectionText`, so
   * a deployment can keep one paragraph of tool rules worded for the SDK
   * surface (`tools.read(...)`) and answer the rest with `''`. Same contract as
   * `sectionText`: replace or remove only, never invent a section, and a name
   * that is not present is reported instead of served.
   */
  ptcSectionText: {},
  /** only shrink tools whose full schema JSON is at least this long. */
  minChars: 1200,
  /** characters kept of the tool description; 0 drops it. */
  descriptionCap: 200,
  /** characters kept of every nested property description; 0 drops them. */
  nestedDescriptionCap: 100,
  /** truncate `mcp:*` server instruction sections to this many chars; 0 keeps the header only; null disables. */
  instructionsCap: 2000,
  /**
   * PTC mode only: characters kept of a generated SDK declaration block's
   * summary prose (the tools:sdk section). null — the default — leaves the
   * SDK section byte-identical, which is the contract for anyone who wants
   * the full-fidelity typings.
   */
  sdkDescriptionCap: null,
  /** characters kept of each @param / @returns line of an SDK declaration block. */
  sdkTagCap: 120,
  /** SDK declaration blocks at most this long stay byte-identical. */
  sdkBlockMinChars: 200,
  /**
   * PTC mode, v0.2: globs of tool names whose SDK declarations are rewritten
   * one per line. Empty — the default — leaves the declaration layout exactly
   * as the harness generated it.
   */
  sdkSlimInclude: [],
  /** 'table' collapses an entry to one line; 'lines' only drops its comments. */
  sdkSlimStyle: 'table',
  /** drop the trailing '& Record<string, JsonValue>' escape hatch of slimmed entries. */
  sdkSlimRecord: true,
  /** characters of a slimmed tool's description to keep inline; 0 drops it. */
  sdkSlimDocCap: 0,
  /** fewer matching entries than this leaves the section alone. */
  sdkSlimMinEntries: 8,
  /** 'stub' replaces the ToolOutputMap result typings with an index signature. */
  sdkOutputMap: 'keep',
  /** append the note explaining what the slimmed section does not spell out. */
  sdkSlimMarker: true,
  /** answer argument-shaped rejections of a slimmed tool with its real contract. */
  sdkSlimHeal: true,
}

/**
 * Validate and normalize the row config against {@link DEFAULTS}.
 * Manual (no schemastery) so the plugin stays dependency-free.
 * @param config - raw config from the patch row, usually an object or undefined.
 * @returns the merged effective config.
 */
function normalizeConfig(config) {
  if (config === undefined || config === null) return { ...DEFAULTS }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`toolscode: config must be an object, got ${JSON.stringify(config)}`)
  }
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new TypeError(`toolscode: unknown config key "${key}" (known: ${[...known].join(', ')})`)
  }
  const cfg = { ...DEFAULTS, ...config }
  if (typeof cfg.enabled !== 'boolean') throw new TypeError('toolscode: enabled must be a boolean')
  if (!EXECUTOR_MODES.includes(cfg.executor)) {
    throw new TypeError('toolscode: executor must be ' + EXECUTOR_MODES.map((mode) => JSON.stringify(mode)).join(' or '))
  }
  for (const key of ['include', 'exclude', 'drop', 'ptcDropSections']) {
    if (!Array.isArray(cfg[key]) || cfg[key].some((p) => typeof p !== 'string')) {
      throw new TypeError(`toolscode: ${key} must be an array of glob strings`)
    }
  }
  for (const key of ['sectionText', 'contextText', 'ptcSectionText']) {
    const map = cfg[key]
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new TypeError(`toolscode: ${key} must be a section-name to text map`)
    }
    for (const [name, text] of Object.entries(map)) {
      if (typeof text !== 'string') {
        throw new TypeError(`toolscode: ${key}.${name} must be a string ('' removes the entry)`)
      }
    }
  }
  for (const key of ['minChars', 'descriptionCap', 'nestedDescriptionCap']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 0) throw new TypeError(`toolscode: ${key} must be a non-negative integer`)
  }
  if (cfg.instructionsCap !== null && (!Number.isInteger(cfg.instructionsCap) || cfg.instructionsCap < 0)) {
    throw new TypeError('toolscode: instructionsCap must be a non-negative integer or null')
  }
  if (cfg.sdkDescriptionCap !== null && (!Number.isInteger(cfg.sdkDescriptionCap) || cfg.sdkDescriptionCap < 0)) {
    throw new TypeError('toolscode: sdkDescriptionCap must be a non-negative integer or null')
  }
  for (const key of ['sdkTagCap', 'sdkBlockMinChars']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 0) throw new TypeError(`toolscode: ${key} must be a non-negative integer`)
  }
  if (!Array.isArray(cfg.sdkSlimInclude) || cfg.sdkSlimInclude.some((p) => typeof p !== 'string')) {
    throw new TypeError('toolscode: sdkSlimInclude must be an array of glob strings')
  }
  if (!['table', 'lines'].includes(cfg.sdkSlimStyle)) {
    throw new TypeError('toolscode: sdkSlimStyle must be "table" or "lines"')
  }
  if (!['keep', 'stub'].includes(cfg.sdkOutputMap)) {
    throw new TypeError('toolscode: sdkOutputMap must be "keep" or "stub"')
  }
  for (const key of ['sdkSlimDocCap', 'sdkSlimMinEntries']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 0) throw new TypeError(`toolscode: ${key} must be a non-negative integer`)
  }
  for (const key of ['sdkSlimRecord', 'sdkSlimMarker', 'sdkSlimHeal']) {
    if (typeof cfg[key] !== 'boolean') throw new TypeError(`toolscode: ${key} must be a boolean`)
  }
  return cfg
}

/**
 * The section name dsh-tools registers its generated SDK declarations
 * under (PTC mode). Exported so tests and measurement scripts target the
 * very same section the plugin shrinks.
 */
export const SDK_SECTION_NAME = 'tools:sdk'

/**
 * What the slimmed section stops spelling out, said once instead of per tool:
 * the MCP result envelope every mcp__ tool resolves to (the ToolOutputMap
 * entries that carried it are collapsed by sdkOutputMap 'stub'), plus what
 * happens when the one-line form is not enough.
 */
export const SDK_SLIM_NOTE = SLIM_MARKER + String.fromCharCode(10)
  + 'MCP tools resolve to the standard envelope: { content: ({ type: "text", text: string } | { type: "image" | "audio", data: string, mimeType: string })[], isError?: boolean, structuredContent?: object }.'
  + ' An argument-shaped rejection from a slimmed tool is answered with its full declaration and real parameter schema.'

/**
 * Wrappers this plugin mounted. The delegate is the deployment default, which
 * after a root-scope mount is one of ours: without this a second row would
 * wrap a wrapper and shrink the same schema twice.
 * @type {WeakSet<object>}
 */
const OWN_WRAPPERS = new WeakSet()

/** Label for logs: an executor is not required to carry a name. */
function executorLabel(executor) {
  return executor?.name ?? executor?.constructor?.name ?? 'tool executor'
}

/** Percentage removed, for a log line. */
function percentCut(kept, full) {
  return full > 0 ? Math.round((1 - kept / full) * 100) : 0
}

/**
 * Replace or remove prompt entries by name, and report the byte delta: the
 * deployment serves its own summary of a paragraph it does not own, while the
 * harness keeps registering it. Removal is by `''`; a name that is not present
 * is skipped (and reported by the caller), so an upstream rename costs nothing
 * instead of serving a stale paragraph under a heading nobody has any more.
 * @param entries - the assembled `{ name, text }` list, sections or contexts.
 * @param overrides - entry name -> replacement text.
 * @returns `{ list, before, after, hits }`; `list` is the original array when
 *   nothing matched, so an unconfigured deployment hands back the same bytes.
 */
function applyOverrides(entries, overrides) {
  if (Object.keys(overrides).length === 0) return { list: entries, before: 0, after: 0, hits: [] }
  let before = 0
  let after = 0
  const hits = []
  const list = []
  for (const entry of entries) {
    if (!Object.prototype.hasOwnProperty.call(overrides, entry.name)) {
      list.push(entry)
      continue
    }
    const text = overrides[entry.name]
    before += entry.text.length
    after += text.length
    hits.push(entry.name)
    if (text !== '') list.push({ ...entry, text })
  }
  return { list, before, after, hits }
}

/**
 * The one tool name a PTC assembly leaves callable from the model's own
 * tool-call channel (dsh-tools `RUN_CODE_NAME`).
 */
export const RUN_CODE_NAME = 'run_code'

/**
 * The sentence the harness itself serves when a tool call may name nothing but
 * the programmatic transport. dsh-tools registers it in PTC, registers it with
 * an empty text in mode `both` - where the SDK is served *and* a native call
 * still works - and registers no such section in `native`; on dsh >= 0.2 it
 * belongs to the selected executor instead. Nothing else separates those modes,
 * so this is what PTC-only work keys on.
 */
export const PTC_ONLY_SECTION = 'tools:ptc-only'

/**
 * Whether this assembly presents the programmatic surface: the generated SDK
 * declarations are being served, and the harness is saying in its own words
 * that a tool call may name nothing except the `run_code` transport.
 *
 * Read off the assembly rather than off a config field, because presentation is
 * per scope (`tools.presentAs()` under an agent preset, the selected executor on
 * dsh >= 0.2) and this hook is the one place that sees both halves of the
 * decision already resolved. A native agent beside a PTC one under the same
 * deployment gets a different assembly, and only the PTC one is contradicted by
 * per-tool guidance sections.
 *
 * The rule is what the harness states, never an absence: `tools:ptc-only`
 * carrying its sentence. Where that section was never registered the wire
 * decides, and only where the carrier really carries one - dsh >= 0.2 moved
 * tools[] into a mountable executor that contributes it after this waterfall, so
 * there a missing array says nothing at all, and guessing from it would strip a
 * native deployment's guidance the moment it served the SDK in mode `both`.
 *
 * @param assembly - the `{ sections, tools }` carrier of this request.
 * @returns whether tool guidance naming a directly callable tool is a lie here.
 */
export function isPtcAssembly(assembly) {
  const sections = assembly.sections ?? []
  const sdk = sections.find((section) => section.name === SDK_SECTION_NAME)
  if (sdk === undefined || sdk.text === '') return false
  const rule = sections.find((section) => section.name === PTC_ONLY_SECTION)
  if (rule !== undefined) return rule.text !== ''
  return Array.isArray(assembly.tools)
    && assembly.tools.length > 0
    && assembly.tools.every((tool) => tool.name === RUN_CODE_NAME)
}

/**
 * dsh >= 0.2 (executor: wrap): take over presentation by wrapping the
 * deployment tool executor. describe() output is the only wire left to shrink
 * there; execute() delegates untouched, so argument validation, the real
 * schemas and the tools/post-execute self-heal all stay with the real
 * pipeline. Every refusal is a log line and a no-op, never a throw: a plugin
 * row that cannot have what it asked for leaves the composition as it was.
 * @param ctx - plugin context; its scope is where the wrapper gets selected.
 * @param cfg - the effective config.
 * @param wants - include/exclude gate over tool names.
 * @param realSchemas - the self-heal stash this wrapper arms.
 * @param log - plugin logger.
 */
function mountExecutorShrink(ctx, cfg, wants, realSchemas, log) {
  if (typeof ctx.tools?.setExecutor !== 'function' || typeof ctx.tools?.selectExecutor !== 'function') {
    log.warn('executor "wrap" needs dsh >= 0.2 (no tools.setExecutor here); ignored - this harness still carries tools[] through the assembly waterfall, which is already shrunk')
    return
  }
  let inner
  try {
    // The unscoped contribution is the deployment default the agents fall
    // back to; the wrapper is registered over this plugin own nearer scope.
    inner = ctx.tools.selectExecutor()
  } catch {
    log.warn('executor "wrap" found no tool executor to wrap - mount the executor row (dsh-tool-executor-native / -ptc) before this plugin')
    return
  }
  if (OWN_WRAPPERS.has(inner)) {
    log.warn('executor "wrap" found "' + executorLabel(inner) + '" already wrapping the executor; leaving it in charge')
    return
  }
  if (Array.isArray(inner.sections) && inner.sections.length > 0) {
    const owned = inner.sections.map((section) => section.name).join(', ')
    log.warn('executor "wrap" will not shadow "' + executorLabel(inner) + '": it presents its own prompt sections (' + owned + '), which go blank for exactly the agents a wrapper would serve - and in that mode tools[] has nothing to shrink')
    return
  }
  const wrapper = createExecutorShrink(inner, cfg, wants, realSchemas, log)
  OWN_WRAPPERS.add(wrapper)
  try {
    ctx.tools.setExecutor(wrapper)
  } catch (error) {
    OWN_WRAPPERS.delete(wrapper)
    log.warn('executor "wrap" could not be registered (' + error.message + ') - mount this plugin in a scope below the executor row')
    return
  }
  log.info('shrinking the wire schemas of "' + executorLabel(inner) + '" through an executor wrapper')
}

/**
 * The wrapper: shrink on presentation, delegate on execution. Pure and
 * deterministic - the same definitions always describe the same bytes, so the
 * prompt / KV cache stays warm exactly like the assembly shrink does. No
 * sections are forwarded on purpose (see mountExecutorShrink).
 * @param inner - the executor being wrapped.
 * @param cfg - the effective config.
 * @param wants - include/exclude gate over tool names.
 * @param realSchemas - the self-heal stash to arm with the real schemas.
 * @param log - plugin logger.
 * @returns a tool executor for ctx.tools.setExecutor.
 */
function createExecutorShrink(inner, cfg, wants, realSchemas, log) {
  let lastSignature = null
  return {
    name: 'toolscode+' + executorLabel(inner),
    describe(definitions) {
      const description = inner.describe(definitions)
      try {
        if (!Array.isArray(description?.schemas)) return description
        let picked = 0
        let before = 0
        let after = 0
        // Same drop list as the assembly path, so a deployment configured once
        // behaves identically on dsh 0.1 and 0.2. knownNames is left alone on
        // purpose: the tools are still registered, only never shown.
        const dropGlobs = Array.isArray(cfg.drop) ? cfg.drop : []
        const visible = dropGlobs.length === 0 ? description.schemas : description.schemas.filter(
          (schema) => !(typeof schema?.name === 'string' && globMatch(dropGlobs, schema.name)),
        )
        const dropped = description.schemas.length - visible.length
        const schemas = visible.map((schema) => {
          if (typeof schema?.name !== 'string' || !wants(schema.name)) return schema
          const size = schemaChars(schema)
          if (size < cfg.minChars) return schema
          const shrunk = shrinkToolSchema(schema, cfg)
          // The self-heal source. shrinkToolSchema copies rather than mutates,
          // so remembering the registry own object is safe, and describe() runs
          // on every assembly: MCP reconnects land in the stash next turn.
          realSchemas.set(schema.name, schema)
          picked += 1
          before += size
          after += schemaChars(shrunk)
          return shrunk
        })
        if (picked === 0 && dropped === 0) return description
        const signature = JSON.stringify([picked, before, after, dropped])
        if (signature !== lastSignature) {
          lastSignature = signature
          let message = 'shrunk ' + picked + ' tool schemas: ' + before + ' -> ' + after + ' chars (-' + percentCut(after, before) + '%)'
          if (dropped > 0) message += '; dropped ' + dropped + ' tool definition(s) from the wire'
          log.info(message)
        }
        // Spread first: knownNames and anything else the delegate returns wins.
        return { ...description, schemas }
      } catch (error) {
        // A shrink bug must never eat a prompt or a call: the full size wire
        // is always safe, just expensive.
        log.warn('executor shrink failed: ' + String(error.stack ?? error.message))
        return description
      }
    },
    execute(input) {
      return inner.execute(input)
    },
  }
}

export const name = 'dsh-plugin-toolscode'

export const inject = ['systemPrompt', 'tools']

/**
 * Mount the shrinker over the calling scope (an agent preset's standing
 * scope, normally).
 * @param ctx - the cordis context of the plugin fiber.
 * @param config - the row config, see {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const log = ctx.logger('toolscode')
  if (!cfg.enabled) {
    log.info('disabled by config')
    return
  }

  const wants = (toolName) => {
    if (toolName === 'run_code') return false
    if (cfg.exclude.length > 0 && globMatch(cfg.exclude, toolName)) return false
    if (cfg.include.length > 0 && !globMatch(cfg.include, toolName)) return false
    return true
  }

  /**
   * The real (unshrunk) wire schemas this scope last served, keyed by tool
   * name — the self-heal source. Refreshed on every assembly, so MCP
   * reconnects and tool reloads are picked up on the next turn; bounded by
   * the visible tool count.
   * @type {Map<string, object>}
   */
  const realSchemas = new Map()
  /**
   * The original declaration blocks of the entries v0.2 collapsed, keyed by
   * tool name - the lazy-disclosure source. Refreshed on every assembly that
   * slimmed, bounded so a long-lived process cannot grow without end.
   * @type {Map<string, string>}
   */
  const slimmedBlocks = new Map()
  /** Last shrink summary signature; changes only then do we log again. */
  let lastSignature = null
  /** Last set of configured override names that matched nothing; same rule. */
  let lastMissed = null
  /** Whether the last PTC glob pass matched nothing; same rule, logged once. */
  let lastGlobMissed = false
  /** Argument-shaped rejections worth a disclosure; deliberately narrow. */
  const ARG_COMPLAINT = /(missing (?:required )?(?:argument|parameter)|unknown (?:argument|parameter|key)|unexpected (?:argument|parameter)|invalid (?:argument|parameter|value)|required propert(?:y|ies)|missing propert(?:y|ies)|must (?:be|provide|contain|match|have)|is not allowed|should be)/i

  // dsh >= 0.2: the executor is what presents tools[] there, so wrapping it is
  // the only way left to shrink the wire. Opt-in: 'off' keeps the 0.1 contract
  // and leaves any mounted executor, including a PTC one, exactly as it was.
  if (cfg.executor === 'wrap') mountExecutorShrink(ctx, cfg, wants, realSchemas, log)

  // The one shrink pass: tools[] + mcp:* sections, post-order so every
  // other waterfall (tool policies, MCP instructions) has contributed and
  // what we shrink is exactly the bytes the model will receive.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      let picked = 0
      let before = 0
      let after = 0
      let dropped = 0
      const droppedNames = []
      // dsh 0.2 moved tools[] out of this carrier and into a mountable tool
      // executor, so the array is optional here: without it the section work
      // below still has to run (it is the bigger half of the win).
      if (Array.isArray(result.tools) && cfg.drop.length > 0) {
        const kept = []
        for (const schema of result.tools) {
          if (globMatch(cfg.drop, schema.name)) {
            dropped += 1
            droppedNames.push(schema.name)
            continue
          }
          kept.push(schema)
        }
        result.tools = kept
      }
      if (Array.isArray(result.tools)) {
        result.tools = result.tools.map((schema) => {
          if (!wants(schema.name)) return schema
          const size = schemaChars(schema)
          if (size < cfg.minChars) return schema
          const shrunk = shrinkToolSchema(schema, cfg)
          realSchemas.set(schema.name, schema)
          picked += 1
          before += size
          after += schemaChars(shrunk)
          return shrunk
        })
      }
      if (cfg.instructionsCap !== null) {
        for (const section of result.sections) {
          if (section.name.startsWith('mcp:')) section.text = shrinkInstructions(section.text, cfg.instructionsCap)
        }
      }
      // Deployment prose: serve this deployment's own summary in place of a
      // paragraph the harness owns. Post-order and by name, so the bytes
      // replaced are exactly the bytes that would have been served.
      const sectionNames = result.sections.map((section) => section.name)
      const prose = applyOverrides(result.sections, cfg.sectionText)
      result.sections = prose.list
      const snapshot = applyOverrides(result.contexts ?? [], cfg.contextText)
      if (Array.isArray(result.contexts)) result.contexts = snapshot.list
      // PTC mode (v0.5): the per-tool guidance sections were written for a wire
      // that no longer exists here, and they are ordered after the one sentence
      // that says only run_code may be named. Take them out, then serve this
      // deployment's own wording of whatever rule still holds from inside a
      // program. Both passes are opt-in; nothing is configured by default.
      const ptc = isPtcAssembly(result)
      const guidanceNames = []
      let guidanceCut = 0
      if (ptc && cfg.ptcDropSections.length > 0) {
        const kept = []
        for (const section of result.sections) {
          if (!globMatch(cfg.ptcDropSections, section.name)) { kept.push(section); continue }
          guidanceNames.push(section.name)
          guidanceCut += section.text.length
        }
        result.sections = kept
      }
      const ptcProse = ptc
        ? applyOverrides(result.sections, cfg.ptcSectionText)
        : { list: result.sections, before: 0, after: 0, hits: [] }
      result.sections = ptcProse.list
      const proseBefore = prose.before + snapshot.before
      const proseAfter = prose.after + snapshot.after
      const proseHits = prose.hits.concat(snapshot.hits)
      const ptcBefore = guidanceCut + ptcProse.before
      const ptcAfter = ptcProse.after
      // PTC mode: the schemas reach the model as the generated declaration
      // section instead of the wire tools[] array, so that section is where
      // `drop` has to bite as well — a tool taken off the wire whose
      // declaration stays behind is still reachable from inside run_code.
      let sdkBefore = 0
      let sdkAfter = 0
      const sdkDropNames = []
      if (cfg.drop.length > 0) {
        for (const section of result.sections) {
          if (section.name !== SDK_SECTION_NAME) continue
          const cut = dropDeclarations(section.text, cfg.drop)
          if (cut.removed.length === 0) continue
          sdkBefore += section.text.length
          sdkAfter += cut.text.length
          sdkDropNames.push(...cut.removed)
          section.text = cut.text
        }
      }
      // The JSDoc prose caps, over what is left. Opt-in: with
      // sdkDescriptionCap null the section stays byte-identical.
      if (cfg.sdkDescriptionCap !== null) {
        for (const section of result.sections) {
          if (section.name !== SDK_SECTION_NAME) continue
          const shrunkSection = shrinkSdkSection(section.text, {
            descriptionCap: cfg.sdkDescriptionCap,
            tagCap: cfg.sdkTagCap,
            blockMinChars: cfg.sdkBlockMinChars,
          })
          if (shrunkSection === section.text) continue
          sdkBefore += section.text.length
          sdkAfter += shrunkSection.length
          section.text = shrunkSection
        }
      }
      // PTC mode, v0.2: the declaration layout itself, after the prose pass.
      // Pure and opt-in: with sdkSlimInclude empty and sdkOutputMap 'keep'
      // (the defaults) not one byte moves.
      if (cfg.sdkSlimInclude.length > 0 || cfg.sdkOutputMap === 'stub') {
        for (const section of result.sections) {
          if (section.name !== SDK_SECTION_NAME) continue
          const original = section.text
          let slimmed = original
          if (cfg.sdkSlimInclude.length > 0) {
            const blocks = collectBlocks(slimmed, cfg.sdkSlimInclude)
            slimmed = slimEntries(slimmed, {
              include: cfg.sdkSlimInclude,
              style: cfg.sdkSlimStyle,
              dropRecord: cfg.sdkSlimRecord,
              docCap: cfg.sdkSlimDocCap,
              minEntries: cfg.sdkSlimMinEntries,
            })
            if (slimmed !== original) {
              if (slimmedBlocks.size > 4000) slimmedBlocks.clear()
              for (const [toolName, block] of blocks) slimmedBlocks.set(toolName, block)
            }
          }
          if (cfg.sdkOutputMap === 'stub') slimmed = stubOutputMap(slimmed)
          if (slimmed === original) continue
          sdkBefore += original.length
          sdkAfter += slimmed.length
          section.text = cfg.sdkSlimMarker ? slimmed + SDK_SLIM_NOTE : slimmed
        }
      }
      const signature = JSON.stringify([picked, before, after, sdkBefore, sdkAfter, droppedNames, proseHits, proseAfter, ptc, guidanceNames, sdkDropNames, ptcAfter])
      if (signature !== lastSignature && (picked > 0 || sdkBefore > 0 || dropped > 0 || proseHits.length > 0 || guidanceNames.length > 0 || ptcProse.hits.length > 0)) {
        lastSignature = signature
        const parts = []
        if (picked > 0) parts.push('shrunk ' + picked + ' tool schemas: ' + before + ' -> ' + after + ' chars (-' + percentCut(after, before) + '%)')
        if (dropped > 0) parts.push('dropped ' + dropped + ' tool definition' + (dropped === 1 ? '' : 's') + ' from the wire (' + droppedNames.join(', ') + ')')
        if (sdkBefore > 0) {
          parts.push('SDK section ' + sdkBefore + ' -> ' + sdkAfter + ' chars (-' + percentCut(sdkAfter, sdkBefore) + '%)'
            + (sdkDropNames.length > 0 ? ', declarations of ' + sdkDropNames.join(', ') : ''))
        }
        if (proseHits.length > 0) {
          parts.push('rewrote ' + proseHits.length + ' prompt entr' + (proseHits.length === 1 ? 'y' : 'ies')
            + ' [' + proseHits.join(', ') + ']: ' + proseBefore + ' -> ' + proseAfter + ' chars (-' + percentCut(proseAfter, proseBefore) + '%)')
        }
        if (ptc && (guidanceNames.length > 0 || ptcProse.hits.length > 0)) {
          parts.push('PTC mode: ' + (guidanceNames.length > 0
            ? 'removed ' + guidanceNames.length + ' tool-guidance section' + (guidanceNames.length === 1 ? '' : 's')
            : 'reworded')
            + (ptcProse.hits.length > 0 ? ', reworded ' + ptcProse.hits.length + ' for the SDK surface' : '')
            + ' (' + ptcBefore + ' -> ' + ptcAfter + ' chars, -' + percentCut(ptcAfter, ptcBefore) + '%)')
        }
        log.info(parts.join('; '))
      }
      // A configured name the harness no longer registers is a silent no-op,
      // and a silent no-op is how a stale override survives an upgrade. PTC
      // keys are only checked in PTC mode: on a native assembly they are meant
      // to match nothing.
      const configured = Object.keys(cfg.sectionText).concat(Object.keys(cfg.contextText))
      if (ptc) configured.push(...Object.keys(cfg.ptcSectionText))
      const missed = [...new Set(configured)].filter((name) => !proseHits.includes(name) && !ptcProse.hits.includes(name)).join(',')
      const globMissed = ptc && cfg.ptcDropSections.length > 0 && guidanceNames.length === 0
      if (missed !== lastMissed || globMissed !== lastGlobMissed) {
        lastMissed = missed
        lastGlobMissed = globMissed
        if (missed !== '') {
          // The names are the point: an override that matches nothing is
          // invisible unless the assembly says what it does have.
          const available = [...new Set(sectionNames.concat((result.contexts ?? []).map((entry) => entry.name)))].sort()
          log.warn('prompt overrides matched nothing, renamed upstream? ' + missed.split(',').join(', ')
            + ' | this assembly serves: ' + available.slice(0, 40).join(', ') + (available.length > 40 ? ', …' : ''))
        }
        if (globMissed) log.warn('ptcDropSections matched no section of this assembly: ' + cfg.ptcDropSections.join(', '))
      }
    } catch (error) {
      // A shrink bug must never eat the prompt: the full-size wire is
      // always safe, just expensive.
      log.warn(`assembly shrink failed: ${error.stack ?? error.message}`)
    }
    return result
  })

  // Self-heal: a ToolArgsError proves the model needed the full contract.
  // `tools/post-execute` sees thrown tools normalized to an error result
  // (`result.error.info.name === 'ToolArgsError'`); block it with the
  // original text plus the real schema attached. Scope-filtered dispatch:
  // this listener only sees calls made by agents under this scope.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (result?.isError !== true) return next()
    const original = result.content?.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
      ?? `Error: ${result.error?.message ?? 'tool call failed'}`
    try {
      // A rejected contract of a tool this plugin shrank on the wire: hand
      // back the full real schema it was told less about.
      if (result.error?.info?.name === 'ToolArgsError') {
        // Only tools THIS plugin made smaller get the note; a tool that was always
        // full-fidelity on the wire needs no rescue (and its own error is enough).
        const real = realSchemas.get(exec.name)
          ?? (slimmedBlocks.has(exec.name) && cfg.sdkSlimHeal ? await registrySchema(exec) : undefined)
        if (real !== undefined) {
          const note = `\n\nFull parameter schema for "${exec.name}":\n${JSON.stringify({ description: real.description ?? '', parameters: real.parameters })}`
          return { kind: 'block', feedback: [{ type: 'text', text: original + note }] }
        }
      }
      // A tool whose declaration this plugin collapsed: the compact table is a
      // layout-only summary, so an argument-shaped rejection is answered with
      // the real contract instead of left for the model to guess at. MCP
      // servers reject arguments themselves (no ToolArgsError), hence the
      // message shape test; the live registry is asked first and the stored
      // original declaration is the fallback.
      if (!cfg.sdkSlimHeal || !slimmedBlocks.has(exec.name)) return next()
      if (!ARG_COMPLAINT.test(original.slice(0, 1200))) return next()
      const real = await registrySchema(exec)
      const disclosure = real !== undefined
        ? `\n\nFull parameter schema for "${exec.name}":\n${JSON.stringify({ description: real.description ?? '', parameters: real.parameters })}`
        : `\n\nFull declaration for "${exec.name}":\n${slimmedBlocks.get(exec.name)}`
      return { kind: 'block', feedback: [{ type: 'text', text: original + disclosure }] }
    } catch (error) {
      log.warn(`self-heal failed for "${exec.name}": ${error.message}`)
      return next()
    }
    return next()
  })

  /**
   * Look the real definition up in the live registry (public API; the registry
   * is never modified). Undefined whenever the lookup cannot reach it, which is
   * normal for tools registered in a scope this plugin cannot see.
   * @param exec - the execution that was rejected.
   * @returns an object with `description` and `parameters`, or undefined.
   */
  async function registrySchema(exec) {
    // Reading ctx.tools on a scope that did not inject it throws in cordis,
    // so the whole lookup lives inside the try.
    try {
      if (typeof ctx.tools?.get !== 'function') return undefined
      const found = await ctx.tools.get(exec.name, exec.agent)
      const definition = found?.definition ?? found
      return definition && (definition.parameters || definition.description) ? definition : undefined
    } catch {
      return undefined
    }
  }
}

export default { name, inject, apply }
