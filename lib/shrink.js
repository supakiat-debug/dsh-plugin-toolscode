/**
 * Deterministic, validation-equivalent tool-schema shrinking.
 *
 * Every function here is pure and byte-stable for the same input: no Date,
 * no randomness, no locale-sensitive formatting. That is a hard requirement,
 * not hygiene — the agent loop compares the assembled `tools[]` against the
 * previous request header (`toolsChanged`) and a byte-identical result keeps
 * the KV / prompt cache warm across turns.
 *
 * The shrink only ever removes *annotation* keywords (`description`,
 * `title`, `examples`, `$comment`) and truncates the surviving text. JSON
 * Schema validation semantics are untouched, so a call the real schema
 * accepts is still accepted everywhere the shrunk schema is merely *read*
 * (model prompting, SDK typings), and the real definition still validates
 * every argument that actually executes.
 *
 * @module dsh-plugin-toolscode/shrink
 */

/** Keys whose values are model-facing prose the shrink may drop or cap. */
const PROSE_KEYS = new Set(['description', 'title', 'examples', '$comment'])

/** Sub-schemas of a JSON-Schema node that must be walked recursively. */
const SUBSCHEMA_KEYS = new Set([
  'items', 'additionalItems', 'additionalProperties', 'contains',
  'propertyNames', 'not', 'if', 'then', 'else',
  'anyOf', 'oneOf', 'allOf', 'prefixItems',
  'properties', 'patternProperties', '$defs', 'definitions',
])

/**
 * Sub-schema keys that are name → schema MAPS (their object values are
 * sub-schemas; the keys themselves are arbitrary names, not keywords).
 */
const MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

/**
 * Truncate text to at most `cap` characters on a word boundary.
 *
 * Deterministic: same input + cap → same output bytes. A `…` marker is
 * appended when text was actually cut so the model can tell prose was
 * trimmed rather than the tool being ill-maintained.
 *
 * @param text - the original text.
 * @param cap - max characters to keep; `0` drops the text entirely.
 * @returns the truncated text ('' when cap is 0 or text is empty).
 */
export function truncateText(text, cap) {
  if (typeof text !== 'string' || text === '') return text
  if (cap <= 0) return ''
  if (text.length <= cap) return text
  let cut = cap
  // Prefer breaking on whitespace, but only if the break point is not too
  // early (below half the cap the hard cut preserves more information).
  const space = Math.max(text.lastIndexOf(' ', cap), text.lastIndexOf('\n', cap))
  if (space > cap / 2) cut = space
  return `${text.slice(0, cut).replace(/\s+$/, '')}…`
}

/**
 * Shrink one JSON-Schema node recursively.
 *
 * Annotation keywords are dropped or capped; structural keywords
 * (`type`, `properties`, `required`, `enum`, `const`, `default`, bounds,
 * `$ref`, …) are copied through untouched so validation semantics and type
 * generation keep working. Property order is preserved.
 *
 * @param node - any JSON value found in a JSON Schema.
 * @param cap - characters kept per nested prose string.
 * @param depth - recursion guard (schemas are JSON, but cheap insurance).
 * @returns a structurally new, shrunk copy.
 */
function shrinkNode(node, cap, depth) {
  if (Array.isArray(node)) {
    if (depth > 32) return node
    return node.map((item) => shrinkNode(item, cap, depth + 1))
  }
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (PROSE_KEYS.has(key)) {
      if (cap <= 0) continue
      if (key === 'examples') continue // pure prose payload, always droppable
      if (typeof value === 'string') out[key] = truncateText(value, cap)
      continue
    }
    if (SUBSCHEMA_KEYS.has(key) && depth <= 32) {
      if (MAP_KEYS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const mapped = {}
        for (const [subName, subSchema] of Object.entries(value)) mapped[subName] = shrinkNode(subSchema, cap, depth + 1)
        out[key] = mapped
      } else {
        out[key] = shrinkNode(value, cap, depth + 1)
      }
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Shrink a tool schema for the model-facing wire / SDK.
 *
 * @param schema - a registry schema `{ name, description, parameters, … }`.
 * @param options - `{ descriptionCap, nestedDescriptionCap, dropExamples }`.
 * @returns a new schema object with the same shape and name, shrunk text.
 */
export function shrinkToolSchema(schema, { descriptionCap = 200, nestedDescriptionCap = 100 } = {}) {
  const shrunk = {
    ...schema,
    parameters: shrinkNode(schema.parameters, nestedDescriptionCap, 0),
  }
  if (descriptionCap <= 0) delete shrunk.description
  else shrunk.description = truncateText(schema.description ?? '', descriptionCap)
  return shrunk
}

/**
 * Approximate wire cost of one schema (the same JSON.stringify the provider
 * request ultimately performs).
 *
 * @param schema - the registry schema.
 * @returns character count of its JSON form.
 */
export function schemaChars(schema) {
  return JSON.stringify(schema).length
}

/**
 * Whether a name matches a `*`-glob list (any pattern).
 *
 * @param patterns - list of globs; empty or undefined never matches.
 * @param name - the tool name to test.
 * @returns whether any pattern matches the whole name.
 */
export function globMatch(patterns, name) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    if (pattern === '*') return true
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`))
    if (new RegExp(`^${escaped}$`).test(name)) return true
  }
  return false
}

/**
 * Shrink a registered MCP server instructions section.
 *
 * The text arrives as `### MCP server: <name>\n\n<body>`; the header line is
 * always kept (it names the server) and the body is truncated at
 * `cap - header` characters with a stable marker.
 *
 * @param text - the assembled section text.
 * @param cap - total characters kept, header included; `0` keeps only the
 *   header line plus a drop marker.
 * @returns the shrunk section text (byte-stable for the same input).
 */
export function shrinkInstructions(text, cap) {
  if (typeof text !== 'string' || text.length <= cap) return text
  const newline = text.indexOf('\n')
  const header = newline === -1 ? text : text.slice(0, newline)
  if (cap <= 0) return `${header}\n…[toolscode: server instructions dropped]`
  const bodyBudget = Math.max(0, cap - header.length - 2)
  const body = text.slice(newline === -1 ? 0 : newline + 1).trimStart()
  const kept = truncateText(body, bodyBudget)
  return `${header}\n${kept}\n…[toolscode: server instructions truncated]`
}

/**
 * Shrink the generated PTC SDK declaration section (section name tools:sdk).
 *
 * In PTC mode the tool schemas never travel in the wire tools[] array —
 * they reach the model as TypeScript declarations with JSDoc prose, so
 * shrinkToolSchema has nothing to bite on. This is the text-level
 * counterpart: every JSDoc documentation block longer than blockMinChars is
 * rewritten in place — the summary prose capped at descriptionCap, each
 * @param / @returns line capped at tagCap, @example bodies dropped — while
 * every declaration, type and identifier is copied byte-for-byte. Strip the
 * comments from the result and you get exactly the input back: that is the
 * contract the tests pin, structure never changes, only annotation prose.
 *
 * Byte-stable like the rest of this module (pure; no Date, no randomness,
 * no locale-sensitive formatting), and returns the identical string when no
 * block exceeds blockMinChars, so the KV / prompt cache stays warm.
 *
 * @param text - the assembled tools:sdk section text.
 * @param options - `{ descriptionCap, tagCap, blockMinChars }`.
 * @returns the section with shrunk documentation blocks, or the identical
 *   string when nothing was over the minimum.
 */
export function shrinkSdkSection(text, { descriptionCap = 160, tagCap = 120, blockMinChars = 200 } = {}) {
  if (typeof text !== 'string' || !text.includes('/**')) return text
  let changed = false
  const shrunk = text.replace(/\/\*[\s\S]*?\*\//g, (block) => {
    if (!block.startsWith('/**') || block.length <= blockMinChars) return block
    const next = shrinkDocBlock(block, descriptionCap, tagCap)
    if (next === block) return block
    changed = true
    return next
  })
  if (!changed) return text
  return shrunk.replace(/\s+$/, '') + SDK_SECTION_MARKER
}

/** Line appended to a shrunk SDK section so the model knows prose was trimmed. */
const SDK_SECTION_MARKER =
  '\n\n…[toolscode: SDK declaration prose shrunk — a rejected call returns the full real schema]'

/** Tags whose second token is a parameter/type name and must survive capping. */
const NAMED_TAGS = new Set(['@param', '@property', '@prop', '@throws', '@emits', '@typedef', '@template'])

/**
 * Flatten comment text to one line and neutralize any comment terminator.
 *
 * @param text - raw prose.
 * @returns single-line, terminator-free prose.
 */
function oneLine(text) {
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim()
}

/**
 * Rewrite one JSDoc block: capped summary, capped tag lines, no examples.
 *
 * @param block - the full block including the delimiters.
 * @param descriptionCap - characters kept of the summary prose; 0 drops it.
 * @param tagCap - characters kept of each tag line after the name.
 * @returns the shrunk block, or '' when the whole annotation went away.
 */
function shrinkDocBlock(block, descriptionCap, tagCap) {
  const lines = block
    .slice(3, -2)
    .split('\n')
    .map((line) => line.replace(/^\s*\*+ ?/, '').trim())
    .filter((line) => line !== '')
  const prose = []
  const tags = []
  for (const line of lines) {
    if (/^@[a-zA-Z]/.test(line)) tags.push(line)
    else if (tags.length === 0) prose.push(line)
    else tags[tags.length - 1] += ' ' + line // continuation of the previous tag
  }
  const keptProse = descriptionCap <= 0 ? '' : truncateText(oneLine(prose.join(' ')), descriptionCap)
  const keptTags = []
  for (const tag of tags) {
    const word = /^[^\s]+/.exec(tag)?.[0] ?? tag
    if (word === '@example') continue // code samples are the most expensive prose there is
    let head = word
    if (NAMED_TAGS.has(word)) {
      const rest = tag.slice(word.length).replace(/^\s+/, '')
      const name = /^[^\s-]+/.exec(rest)?.[0]
      if (name !== undefined) head = word + ' ' + name
    }
    const rest = tag.slice(head.length).replace(/^[\s:]+/, '')
    const keptRest = tagCap <= 0 ? '' : truncateText(oneLine(rest), tagCap)
    keptTags.push(keptRest === '' ? head : head + ' ' + keptRest)
  }
  if (keptTags.length === 0) return keptProse === '' ? '' : '/** ' + keptProse + ' */'
  const first = keptProse === '' ? '/**' : '/** ' + keptProse
  return first + '\n' + keptTags.map((tag) => ' * ' + tag).join('\n') + '\n */'
}
