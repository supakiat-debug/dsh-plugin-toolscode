/**
 * toolscode for pi — the same shrink, applied at pi's own levers.
 *
 * pi is not dsh, and pretending otherwise would mean writing a payload rewriter
 * that fights the harness for every byte. pi exposes three levers, and this
 * extension uses the top two:
 *
 *   1. `prepareLoadout` on a carrier tool returns `descriptions` (the
 *      model-facing description of every declared tool) and
 *      `hiddenDeclarations` (tools left off the wire that stay callable). That
 *      is this plugin's `descriptionCap` and `drop`, and pi built the hook for
 *      exactly this kind of tool.
 *   2. `before_agent_start` mutates `systemPromptOptions`, which pi holds by
 *      reference and rebuilds the prompt from afterwards. pi assembles its
 *      prompt from `toolSnippets` (the `- name: snippet` list), `toolGuidelines`
 *      and `promptGuidelines` (the rules bullets), plus overridable sections
 *      such as `docs`. Capping those inputs is the analogue of dsh's
 *      `sectionText`, and because pi diffs prompt sections and re-sends only
 *      what changed, it costs one small patch message instead of a cache miss.
 *   3. `before_provider_request` + `dsh-plugin-toolscode/wire` rewrites the
 *      finished payload. Off by default: it is the only lever that reaches
 *      per-property parameter prose, and the only one pi cannot diff, so it is
 *      opt-in per deployment (`wire: true`).
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never returns `systemPrompt` from `before_agent_start`. That sets
 *     `forceSystemPrompt`, which replaces the whole prompt and loses pi's
 *     section diffing — a bigger win once, a bigger cost every turn after.
 *   - When `codemode` is in the loadout it leaves tool descriptions to
 *     codemode. codemode's own `prepareLoadout` rewrites each callable tool's
 *     description to add its `tools.x(args)` call form, and pi merges hook
 *     output into one map where the last writer wins; this extension's carrier
 *     is registered late, so writing there would quietly delete pi's own
 *     guidance. With codemode active, the knob to turn is
 *     `codemode.inlineBudget`, not this file.
 *
 * Install (from npm or git, as a pi package): `pi -e npm:dsh-plugin-toolscode`,
 * or add `"packages": ["dsh-plugin-toolscode"]` to ~/.pi/agent/settings.json.
 * Config, JSON, later wins: ~/.pi/agent/toolscode.json, ./.pi/toolscode.json,
 * then TOOLSCODE_* environment variables. Keys are the same names the dsh plugin
 * uses: descriptionCap, nestedDescriptionCap, minChars, include, exclude, drop,
 * snippetsCap, guidelinesCap, docsCap.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { globMatch, truncateText } from '../lib/shrink.js'
import { shrinkWirePayload } from '../lib/wire.js'

const DEFAULTS = {
  enabled: true,
  include: ['*'],
  exclude: [],
  drop: [],
  minChars: 1200,
  descriptionCap: 200,
  nestedDescriptionCap: 100,
  snippetsCap: 160,
  guidelinesCap: 200,
  // null leaves pi's own docs section alone; 0 blanks it; a number replaces it
  // with a short pointer of that budget. Blank-by-default would contradict the
  // plugin's own rule of never removing something nobody asked it to remove.
  docsCap: null,
  wire: false,
  wireConfig: {},
}

/**
 * What `docsCap: <number>` writes into pi's `docs` section. The marker comes
 * first so a capped version still says who rewrote it, and it tells the model
 * where the documentation went rather than pretending it was shrunk away.
 */
const DOCS_POINTER = 'toolscode: pi documentation lives in the pi package docs (see pi --help).'

/**
 * Read config from the two conventional files and the environment.
 *
 * Env wins over project wins over agent dir, because the person debugging a
 * surprising prompt should be able to override a file without editing it.
 *
 * @param cwd - the session's working directory.
 * @returns the merged config.
 */
function loadConfig(cwd) {
  const read = (path) => {
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return { __error: `${path}: ${error.message}` }
    }
  }
  const config = { ...DEFAULTS, ...read(join(homedir(), '.pi', 'agent', 'toolscode.json')), ...read(join(cwd, '.pi', 'toolscode.json')) }
  if (process.env.TOOLSCODE_ENABLED === '0') config.enabled = false
  if (process.env.TOOLSCODE_DROP) config.drop = process.env.TOOLSCODE_DROP.split(',').map((s) => s.trim()).filter(Boolean)
  if (process.env.TOOLSCODE_DESCRIPTION_CAP) config.descriptionCap = Number(process.env.TOOLSCODE_DESCRIPTION_CAP)
  if (process.env.TOOLSCODE_WIRE === '1') config.wire = true
  return config
}

/**
 * Shrink the prose pi assembles its prompt from.
 *
 * @param options - `event.systemPromptOptions`, mutated in place; pi holds this
 *   object by reference and rebuilds the prompt from it after the handlers run.
 * @param config - the merged config.
 * @param report - the report object to record the cut in.
 */
export function shrinkPromptOptions(options, config, report) {
  for (const [name, snippet] of Object.entries(options.toolSnippets ?? {})) {
    if (!selected(config, name)) continue
    const cut = truncateText(snippet, config.snippetsCap)
    if (cut !== snippet) {
      options.toolSnippets[name] = cut
      // Same reason as the guidelines below: pi may run this again over the same
      // options object on a later turn, and the list is a set of names, not a log.
      if (!report.snippets.includes(name)) report.snippets.push(name)
    }
  }
  const capGuidelines = (list) => {
    // Counted from a set of the originals, not by incrementing: pi may hand the
    // same options object again on a later turn of one session, and a tally that
    // grows every turn over-reports the very thing the report exists to measure.
    report.guidelineLines ??= new Set()
    const out = []
    for (const line of list) {
      const cut = truncateText(line, config.guidelinesCap)
      if (cut !== line) report.guidelineLines.add(line)
      out.push(cut)
    }
    report.guidelines = report.guidelineLines.size
    return out
  }
  for (const [name, list] of Object.entries(options.toolGuidelines ?? {})) {
    if (globMatch(config.exclude, name)) continue
    options.toolGuidelines[name] = capGuidelines(list)
  }
  if (Array.isArray(options.promptGuidelines)) {
    options.promptGuidelines = capGuidelines(options.promptGuidelines)
  }
  // pi ignores an empty section (`if (content)`), so a section cannot be blanked
  // — one space is the smallest thing that survives the builder's own filter.
  // The pointer names the marker first, because that is the part a reader has to
  // be able to attribute, and it is capped like everything else here: a
  // deployment that asks for 40 characters of docs gets 40.
  if (config.docsCap === 0) options.sections.docs = ' '
  else if (config.docsCap > 0) options.sections.docs = truncateText(DOCS_POINTER, config.docsCap)
}

/** Whether a tool name is in scope: not excluded, and matched by `include`. */
function selected(config, name) {
  if (globMatch(config.exclude, name)) return false
  return globMatch(config.include.length === 0 ? ['*'] : config.include, name)
}

/**
 * The shrink itself, shared by `prepareLoadout` and the report tool.
 *
 * @param loadout - pi's view of the session's tools.
 * @param config - the merged config.
 * @returns `{ changes, report }` — the changes to return to pi and the numbers
 *   the report tool prints. `before` and `after` are the character cost of the
 *   declarations as they were and as the request will carry them, so the two
 *   numbers answer "what did this cost me" without trusting the caps.
 */
export function shrinkLoadout(loadout, config) {
  const cost = (tool) => JSON.stringify(tool).length
  const declared = loadout.declared
  // codemode rewrites the description of every tool it can call, adding its
  // `tools.x(args)` call form, and pi merges prepareLoadout output with
  // last-writer-wins. Writing here would delete that, so the descriptions are
  // left to codemode and the deployment shrinks its inline budget instead.
  const codemode = declared.some((tool) => tool.name === 'codemode')
  const descriptions = {}
  const hidden = declared.filter((tool) => globMatch(config.drop, tool.name)).map((tool) => tool.name)
  for (const tool of declared) {
    if (codemode || hidden.includes(tool.name)) continue
    if (!selected(config, tool.name) || cost(tool) < config.minChars || typeof tool.description !== 'string') continue
    const cut = truncateText(tool.description, config.descriptionCap)
    if (cut !== tool.description) descriptions[tool.name] = cut
  }
  const report = {
    before: declared.reduce((sum, tool) => sum + cost(tool), 0),
    after: declared
      .filter((tool) => !hidden.includes(tool.name))
      .reduce((sum, tool) => sum + cost(descriptions[tool.name] ? { ...tool, description: descriptions[tool.name] } : tool), 0),
    shrunk: Object.keys(descriptions),
    hidden,
    skippedFor: codemode ? 'codemode' : null,
    snippets: [],
    guidelines: 0,
    docsCap: config.docsCap,
    wire: null,
  }
  const changes = {}
  if (Object.keys(descriptions).length > 0) changes.descriptions = descriptions
  if (hidden.length > 0) changes.hiddenDeclarations = hidden
  return { changes: Object.keys(changes).length > 0 ? changes : undefined, report }
}

/** A fresh prompt-side report; the loadout side keeps its own so neither wipes the other. */
function promptReport(config) {
  return { snippets: [], guidelines: 0, docsCap: config.docsCap }
}

export default function toolscode(pi, injected = {}) {
  // pi calls this with one argument; the second one exists so a test (or an SDK
  // host embedding pi) can pin the config instead of depending on a file.
  const config = { ...loadConfig(process.cwd()), ...injected.config }
  const state = { loadout: null, prompt: promptReport(config), wire: null }

  if (!config.enabled) return

  pi.registerTool({
    name: 'toolscode',
    label: 'Toolscode',
    description: 'Report how much model-facing tool prose this session removed. No arguments.',
    promptSnippet: 'Report the toolscode prompt shrink for this session',
    // A plain JSON Schema is what TypeBox compiles to, and pi validates tool
    // arguments with plain JSON Schema, so a carrier that takes no arguments
    // does not need to import TypeBox at all.
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    prepareLoadout: (loadout) => {
      const { changes, report } = shrinkLoadout(loadout, config)
      state.loadout = report
      return changes
    },
    async execute() {
      if (state.loadout === null) {
        return { content: [{ type: 'text', text: 'toolscode has not seen a loadout yet.' }], details: {} }
      }
      const loadout = state.loadout
      const list = (items) => (items.length > 0 ? `: ${items.join(', ')}` : '')
      const lines = [
        config.__error ? `config problem: ${config.__error} (running on defaults)` : null,
        `tool declarations: ${loadout.before} -> ${loadout.after} chars `
          + `(${loadout.shrunk.length} shrunk${list(loadout.shrunk)}, ${loadout.hidden.length} hidden${list(loadout.hidden)})`,
        loadout.skippedFor === null ? null
          : `descriptions left to ${loadout.skippedFor}, which rewrites them itself; shrink ${loadout.skippedFor}.inlineBudget instead`,
        `prompt inputs: ${state.prompt.snippets.length} snippet(s) capped${list(state.prompt.snippets)}, `
          + `${state.prompt.guidelines} guideline line(s) capped, docs section `
          + `${state.prompt.docsCap === null ? 'untouched' : 'replaced'}`,
        state.wire === null
          ? 'wire: off (set wire: true to also shrink parameter property prose)'
          : `wire (${state.wire.shape}): tools ${state.wire.toolsBefore} -> ${state.wire.toolsAfter} chars, `
            + `system ${state.wire.systemBefore} -> ${state.wire.systemAfter} chars`
            + `${state.wire.systemMissing.length > 0 ? `; unmatched section key(s): ${state.wire.systemMissing.join(', ')}` : ''}`,
      ]
      // filter(Boolean) is load-bearing: two of these lines are conditional, and
      // joining an array containing null would print the word "null" to the model.
      return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }], details: { ...state } }
    },
  })

  // Mutating systemPromptOptions is deliberate: pi holds that object by
  // reference, rebuilds the prompt from it after the handlers run, then diffs
  // the sections and re-sends only what changed. Returning `systemPrompt` would
  // set forceSystemPrompt and replace the whole prompt instead of one section.
  pi.on('before_agent_start', (event) => {
    const options = event.systemPromptOptions
    if (!options || options.customPrompt || options.forceSystemPrompt) return
    options.sections ??= {}
    shrinkPromptOptions(options, config, state.prompt)
  })

  if (config.wire) {
    pi.on('before_provider_request', (event) => {
      const { payload, report } = shrinkWirePayload(event.payload, {
        minChars: config.minChars,
        descriptionCap: config.descriptionCap,
        nestedDescriptionCap: config.nestedDescriptionCap,
        include: config.include,
        exclude: config.exclude,
        drop: config.drop,
        ...config.wireConfig,
      })
      state.wire = report
      const unchanged = report.toolsAfter === report.toolsBefore
        && report.dropped.length === 0
        && report.systemAfter === report.systemBefore
      // undefined keeps the payload pi already has, and lets any extension
      // registered after this one see the original rather than a copy.
      return unchanged ? undefined : payload
    })
  }
}
