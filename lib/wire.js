/**
 * The wire layer: shrink a provider request payload, whatever harness built it.
 *
 * dsh assembles a prompt out of named sections and hands the plugin a hook in
 * which to rewrite them. Pi and Hermes do not: pi fires `before_provider_request`
 * with the payload a provider adapter just built, and Hermes runs an
 * `llm_request` middleware over the kwargs it is about to POST. Both hand over
 * the same thing in three different shapes — the tool list and the system text,
 * already serialized for one provider — so this module is where the plugin stops
 * being dsh-specific: it walks those shapes, applies the same caps, and reports
 * what it cost.
 *
 * Two contracts carried over from the dsh side, because they are the reason the
 * shrink is safe to run on every request:
 *
 *   - **Pure and byte-stable.** Same payload in, same payload out. A request
 *     rewriter that wobbled would break prompt caching, which is the whole point
 *     of shrinking prose instead of dropping it.
 *   - **Never invent.** `systemSections` replaces or removes a heading block the
 *     harness actually sent. A key that matches nothing is reported in
 *     `report.systemMissing` and otherwise ignored: a renamed section upstream
 *     must cost nothing, not inject a paragraph under a heading no harness owns.
 *
 * Nothing here imports a harness. The pi adapter is `extensions/toolscode.mjs`,
 * the Hermes one is `adapters/hermes/`, and the Python port of this file lives
 * beside it; both are tested against `test/fixtures/wire-payloads.json` so the
 * two cannot drift apart.
 */

import { globMatch, shrinkToolSchema } from './shrink.js'

/**
 * Which provider shape a payload is in, from the one thing that distinguishes
 * them: where a tool's own fields live.
 *
 * @param payload - a provider request body.
 * @returns `'openai-chat'`, `'openai-responses'`, `'anthropic'` or `'unknown'`.
 */
export function detectShape(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : []
  if (tools.length === 0) {
    if (typeof payload?.system === 'string' || Array.isArray(payload?.system)) return 'anthropic'
    return 'unknown'
  }
  const [first] = tools
  if (first.function && typeof first.function === 'object') return 'openai-chat'
  if (first.input_schema) return 'anthropic'
  if (first.parameters || first.name) return 'openai-responses'
  return 'unknown'
}

/**
 * Read one element of `payload.tools` as `{ name, description, schema }`.
 *
 * @param entry - a tool entry in any of the three shapes.
 * @returns the three fields the shrinker touches, or `undefined` when the entry
 *   is not a function tool (a hosted tool, say) and must pass through.
 */
export function readTool(entry) {
  const nested = Boolean(entry?.function && typeof entry.function === 'object')
  const holder = nested ? entry.function : entry
  if (!holder || typeof holder !== 'object' || typeof holder.name !== 'string') return undefined
  const schemaKey = nested ? 'parameters' : (holder.input_schema ? 'input_schema' : 'parameters')
  return { name: holder.name, description: holder.description, schema: holder[schemaKey], schemaKey, nested }
}

/**
 * Replace a tool entry's description and/or schema.
 *
 * Copies every level it changes and shares the rest, so the payload the caller
 * was handed — pi and Hermes both keep it alive for their own logging — is never
 * written to.
 *
 * @param entry - the original array element.
 * @param next - `{ description?, schema? }`; a `description` of `undefined`
 *   removes the field, keys left out leave the entry alone.
 * @returns a new array element.
 */
export function patchEntry(entry, next) {
  const { nested, schemaKey } = readTool(entry)
  if (!nested) {
    const out = { ...entry }
    if ('description' in next) {
      if (next.description === undefined) delete out.description
      else out.description = next.description
    }
    if ('schema' in next) out[schemaKey] = next.schema
    return out
  }
  const inner = { ...entry.function }
  if ('description' in next) {
    if (next.description === undefined) delete inner.description
    else inner.description = next.description
  }
  if ('schema' in next) inner[schemaKey] = next.schema
  return { ...entry, function: inner }
}

/**
 * Split system text into heading blocks.
 *
 * A block runs from its heading line to the line before the next heading line at
 * any level — level-aware nesting would make one config key mean different
 * things in two harnesses that structure their prompts differently, and this is
 * a replacement tool, not a Markdown parser. Text before the first heading is
 * `lead`: it has no name to match, so no config key can reach it and it is
 * always kept — dropping it would silently drop the harness's own opening
 * instruction.
 *
 * @param text - the system prompt as one string.
 * @returns `{ lead, blocks: [{ heading, level, text }] }`.
 */
export function headingBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const lead = []
  const blocks = []
  let current = null
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      current = { heading: heading[2].trim(), level: heading[1].length, lines: [line] }
      blocks.push(current)
      continue
    }
    if (current === null) lead.push(line)
    else current.lines.push(line)
  }
  return {
    lead: lead.join('\n'),
    blocks: blocks.map((block) => ({ heading: block.heading, level: block.level, text: block.lines.join('\n') })),
  }
}

/**
 * Replace or remove heading blocks by `*`-glob against the heading text.
 *
 * @param text - the system prompt as one string.
 * @param sections - glob -> replacement; `''` removes the block. A block matched
 *   by two globs takes the first matching key in insertion order.
 * @returns `{ text, replaced, missing }`, where `missing` lists keys that matched
 *   nothing so a config naming a section this harness does not send is visible in
 *   the report instead of silently useless.
 */
export function applySystemSections(text, sections) {
  const keys = Object.keys(sections ?? {})
  if (keys.length === 0) return { text, replaced: [], missing: [] }
  const { lead, blocks } = headingBlocks(text)
  const replaced = []
  const matched = new Set()
  const out = blocks.map((block) => {
    for (const key of keys) {
      if (!globMatch([key], block.heading)) continue
      matched.add(key)
      if (!replaced.includes(key)) replaced.push(key)
      return sections[key] === '' ? '' : sections[key]
    }
    return block.text
  })
  const kept = out.filter((block) => block !== '')
  return {
    text: [lead, ...kept].filter((part) => part !== '').join('\n'),
    replaced,
    missing: keys.filter((key) => !matched.has(key)),
  }
}

/**
 * The system text of a payload, plus the address it lives at.
 *
 * Anthropic keeps it in `system` (string, or text blocks that carry the cache
 * breakpoints), OpenAI-chat-style payloads keep it as a `role: 'system'` message
 * whose content is a string or a list of parts.
 *
 * @param payload - a provider request body.
 * @returns `{ text, kind }` or `undefined` when the payload has no system text.
 */
function systemOf(payload) {
  if (typeof payload.system === 'string') return { text: payload.system, kind: 'string' }
  if (Array.isArray(payload.system)) {
    const block = payload.system.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    return block === undefined ? undefined : { text: block.text, kind: 'blocks' }
  }
  // OpenAI Responses keeps its instructions beside the payload, not in the
  // transcript, so it has no role to recognise.
  if (typeof payload.instructions === 'string') return { text: payload.instructions, kind: 'instructions' }
  const head = Array.isArray(payload.messages) ? payload.messages[0] : undefined
  if (head?.role !== 'system') return undefined
  if (typeof head.content === 'string') return { text: head.content, kind: 'message-string' }
  const part = Array.isArray(head.content) ? head.content.find((p) => p?.type === 'text' && typeof p.text === 'string') : undefined
  return part === undefined ? undefined : { text: part.text, kind: 'message-parts' }
}

/**
 * Write back to exactly the address `systemOf` read from, copying the containers
 * it changes and leaving cache-control metadata on the block it replaces.
 *
 * @param payload - the payload to rebuild.
 * @param address - the `{ kind }` `systemOf` reported.
 * @param text - the new system text.
 * @returns a new payload.
 */
function writeSystem(payload, address, text) {
  if (address.kind === 'string') return { ...payload, system: text }
  if (address.kind === 'instructions') return { ...payload, instructions: text }
  if (address.kind === 'blocks') {
    let done = false
    return {
      ...payload,
      system: payload.system.map((block) => {
        if (done || block?.type !== 'text' || typeof block.text !== 'string') return block
        done = true
        return { ...block, text }
      }),
    }
  }
  const [head, ...rest] = payload.messages
  if (address.kind === 'message-string') return { ...payload, messages: [{ ...head, content: text }, ...rest] }
  let done = false
  const content = head.content.map((part) => {
    if (done || part?.type !== 'text' || typeof part.text !== 'string') return part
    done = true
    return { ...part, text }
  })
  return { ...payload, messages: [{ ...head, content }, ...rest] }
}

/** Sum of the JSON size of every entry, the same counting the request does. */
function toolsChars(tools) {
  let total = 0
  for (const entry of tools) total += JSON.stringify(entry).length
  return total
}

/**
 * Shrink one provider request payload.
 *
 * Config is the subset of the dsh plugin's keys that means something on a raw
 * payload — `include`, `exclude`, `drop`, `minChars`, `descriptionCap`,
 * `nestedDescriptionCap` — plus `systemSections` where dsh has `sectionText` (a
 * payload has no section registry, only text) and `systemCap` as a blunt tail
 * cut for a deployment that would rather pay a truncation marker than a long
 * persona. `drop` is the one key that changes behaviour rather than prose: the
 * tool leaves the request, and the harness behind it can still dispatch a call
 * to it, which is why the report names every tool it removed.
 *
 * @param payload - a provider request body; never mutated.
 * @param config - the knobs above, all optional.
 * @returns `{ payload, shape, report }`, with character counts before and after
 *   so a caller can print what the shrink saved.
 */
export function shrinkWirePayload(payload, config = {}) {
  const {
    include = ['*'], exclude = [], drop = [],
    minChars = 0, descriptionCap = 200, nestedDescriptionCap = 100,
    systemSections = {}, systemCap = 0,
  } = config
  const shape = detectShape(payload)
  const report = {
    shape,
    toolsBefore: 0, toolsAfter: 0, dropped: [], shrunk: [],
    systemBefore: 0, systemAfter: 0, systemReplaced: [], systemMissing: [],
  }
  if (!payload || typeof payload !== 'object') return { payload, shape, report }

  let next = payload

  if (Array.isArray(payload.tools)) {
    report.toolsBefore = toolsChars(payload.tools)
    const tools = []
    for (const entry of payload.tools) {
      const tool = readTool(entry)
      if (tool === undefined) {
        tools.push(entry)
        continue
      }
      // A hosted tool (`{"type":"web_search_20250305","name":"web_search"}`) has
      // a name and neither prose nor schema of its own: there is nothing here to
      // cap, and writing an empty description onto it would add a key the
      // provider never asked for and report a shrink that never happened.
      if (tool.description === undefined && tool.schema === undefined) {
        tools.push(entry)
        continue
      }
      if (globMatch(drop, tool.name)) {
        report.dropped.push(tool.name)
        continue
      }
      if (globMatch(exclude, tool.name) || !globMatch(include.length === 0 ? ['*'] : include, tool.name)
        || JSON.stringify(entry).length < minChars) {
        tools.push(entry)
        continue
      }
      const shrunk = shrinkToolSchema(
        { name: tool.name, description: tool.description ?? '', parameters: tool.schema ?? {} },
        { descriptionCap, nestedDescriptionCap },
      )
      const entry2 = patchEntry(entry, { description: shrunk.description, schema: shrunk.parameters })
      // Already-short prose comes back identical; only report real changes, so
      // `shrunk` is a list of tools whose bytes actually moved on the wire.
      if (JSON.stringify(entry2) !== JSON.stringify(entry)) report.shrunk.push(tool.name)
      tools.push(entry2)
    }
    report.toolsAfter = toolsChars(tools)
    next = { ...next, tools }
  }

  const system = systemOf(next)
  if (system !== undefined) {
    report.systemBefore = system.text.length
    const applied = applySystemSections(system.text, systemSections)
    report.systemReplaced = applied.replaced
    report.systemMissing = applied.missing
    let text = applied.text
    if (systemCap > 0 && text.length > systemCap) {
      text = `${text.slice(0, systemCap).trimEnd()}\n…[toolscode: system prompt truncated]`
    }
    report.systemAfter = text.length
    if (text !== system.text) next = writeSystem(next, system, text)
  }

  return { payload: next, shape, report }
}
