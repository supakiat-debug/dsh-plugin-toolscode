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
 *    runs). After `next()` this plugin maps every tool whose JSON exceeds
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
import { SLIM_MARKER, collectBlocks, slimEntries, stubOutputMap } from './sdk-slim.js'

const DEFAULTS = {
  enabled: true,
  /** globs of tool names to shrink (always all when empty). */
  include: ['*'],
  /** globs of tool names never to shrink; wins over include. */
  exclude: [],
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
  for (const key of ['include', 'exclude']) {
    if (!Array.isArray(cfg[key]) || cfg[key].some((p) => typeof p !== 'string')) {
      throw new TypeError(`toolscode: ${key} must be an array of glob strings`)
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
  /** Argument-shaped rejections worth a disclosure; deliberately narrow. */
  const ARG_COMPLAINT = /(missing (?:required )?(?:argument|parameter)|unknown (?:argument|parameter|key)|unexpected (?:argument|parameter)|invalid (?:argument|parameter|value)|required propert(?:y|ies)|missing propert(?:y|ies)|must (?:be|provide|contain|match|have)|is not allowed|should be)/i

  // The one shrink pass: tools[] + mcp:* sections, post-order so every
  // other waterfall (tool policies, MCP instructions) has contributed and
  // what we shrink is exactly the bytes the model will receive.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      let picked = 0
      let before = 0
      let after = 0
      // dsh 0.2 moved tools[] out of this carrier and into a mountable tool
      // executor, so the array is optional here: without it the section work
      // below still has to run (it is the bigger half of the win).
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
      // PTC mode: the schemas reach the model as the generated declaration
      // section instead of the wire tools[] array, so the JSDoc prose is capped
      // here. Opt-in: with sdkDescriptionCap null the section stays byte-identical.
      let sdkBefore = 0
      let sdkAfter = 0
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
      const signature = JSON.stringify([picked, before, after, sdkBefore, sdkAfter])
      if (signature !== lastSignature) {
        lastSignature = signature
        const pct = (kept, full) => (full > 0 ? Math.round((1 - kept / full) * 100) : 0)
        let message = `shrunk ${picked} tool schemas: ${before} -> ${after} chars (-${pct(after, before)}%)`
        if (sdkBefore > 0) message += `; SDK section ${sdkBefore} -> ${sdkAfter} chars (-${pct(sdkAfter, sdkBefore)}%)`
        log.info(message)
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
