/**
 * Structural slimming of the generated PTC SDK declaration section (v0.2).
 *
 * The prose caps in shrink.js can only shorten JSDoc; on a real MCP-heavy
 * assembly the declarations themselves dominate (measured on this deployment:
 * 349 MCP tools = 109,337 chars of a 157,616-char prompt, about 52k of it doc
 * prose and 35k ToolOutputMap result typings). This module rewrites the
 * declaration LAYOUT while keeping every tool name, argument name and type:
 *
 *  - slimEntries(): one line per selected entry (style 'table'), or drop the
 *    comments only and keep the layout (style 'lines').
 *  - stubOutputMap(): replace the ToolOutputMap body with an index signature.
 *  - collectBlocks(): keep the original blocks of the slimmed tools so a
 *    rejected call can be answered with the full declaration (lazy disclosure).
 *
 * Everything here is pure and byte-stable: same input, same bytes, so
 * toolsChanged() stays quiet and the KV / prompt cache survives. Each function
 * returns the identical string when it would change nothing.
 *
 * @module dsh-plugin-toolscode/sdk-slim
 */

/**
 * Glob match against a list of patterns, mirroring shrink.js without creating
 * an import cycle.
 *
 * @param patterns - globs; empty or undefined never matches.
 * @param name - the name to test.
 * @returns whether any pattern matches the whole name.
 */
function globMatch(patterns, name) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === EMPTY) continue
    if (pattern === '*') return true
    if (!pattern.includes('*')) { if (pattern === name) return true; continue }
    const parts = pattern.split('*')
    let ok = true
    let offset = 0
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      if (part === EMPTY) continue
      if (i === 0) {
        if (!name.startsWith(part)) { ok = false; break }
        offset = part.length
      } else if (i === parts.length - 1) {
        if (!name.endsWith(part) || name.length - part.length < offset) { ok = false; break }
      } else {
        const at = name.indexOf(part, offset)
        if (at === -1) { ok = false; break }
        offset = at + part.length
      }
    }
    if (ok) return true
  }
  return false
}

// Single-character constants: this module is written without regular
// expressions or template literals so the generated declaration text can
// never be disturbed by an escape sequence.
const NL = String.fromCharCode(10)
const EMPTY = String.fromCharCode()
const SLASH = String.fromCharCode(47)
const STAR = String.fromCharCode(42)
const COLON = String.fromCharCode(58)
const COMMA = String.fromCharCode(44)
const SEMICOLON = String.fromCharCode(59)
const QUESTION = String.fromCharCode(63)
const OPEN_BRACE = String.fromCharCode(123)
const CLOSE_BRACE = String.fromCharCode(125)
const DQUOTE = String.fromCharCode(34)
const SQUOTE = String.fromCharCode(39)
const BACKTICK = String.fromCharCode(96)
const BACKSLASH = String.fromCharCode(92)
const IDENT_CHAR = /[A-Za-z0-9_$]/
const ELLIPSIS = String.fromCharCode(8230)

/** The two generated interfaces this module understands. */
const INTERFACE_NAMES = ['ToolArgsMap', 'ToolOutputMap']

/** The index-signature body that replaces the result typings. */
const OUTPUT_MAP_STUB = '  [toolName: string]: JsonValue | undefined;'

/**
 * Brace delta of one declaration line, ignoring quoted spans and comments.
 *
 * Enum literals and property docs contain braces inside strings and prose, and
 * a raw count would wander out of balance and swallow the next entry.
 *
 * @param line - one source line.
 * @returns how much the brace depth changes across the line.
 */
function braceDelta(line) {
  let depth = 0
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== null) {
      if (c === BACKSLASH) i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === DQUOTE || c === SQUOTE || c === BACKTICK) { quote = c; continue }
    if (c === SLASH && line[i + 1] === STAR) {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) return depth
      i = end + 1
      continue
    }
    if (c === SLASH && line[i + 1] === SLASH) break
    if (c === OPEN_BRACE) depth += 1
    else if (c === CLOSE_BRACE) depth -= 1
  }
  return depth
}

/**
 * Locate both generated interfaces in an SDK section.
 *
 * @param text - the assembled tools:sdk section.
 * @returns their line ranges, or null when this is not the generated
 *   TypeScript SDK (a Python SDK, or an older renderer).
 */
export function findInterfaces(text) {
  if (typeof text !== 'string' || !text.includes('interface ToolArgsMap')) return null
  const lines = text.split(NL)
  const found = {}
  for (let i = 0; i < lines.length; i += 1) {
    const name = INTERFACE_NAMES.find((n) => lines[i] === 'interface ' + n + ' {')
    if (!name) continue
    let depth = 0
    for (let j = i; j < lines.length; j += 1) {
      depth += braceDelta(lines[j])
      if (depth === 0 && j > i) { found[name] = { open: i, close: j }; break }
    }
  }
  if (!found.ToolArgsMap || !found.ToolOutputMap) return null
  return { lines, found }
}

/**
 * Read the entry name off a two-space-indented declaration line.
 *
 * @param line - one source line.
 * @returns the tool name, or null when the line does not open an entry.
 */
function entryName(line) {
  if (!line.startsWith('  ')) return null
  let i = 2
  if (line.startsWith('readonly ', i)) i += 9
  const start = i
  while (i < line.length && IDENT_CHAR.test(line[i])) i += 1
  if (i === start) return null
  const name = line.slice(start, i)
  if (line[i] !== COLON && !(line[i] === QUESTION && line[i + 1] === COLON)) return null
  return name
}

/**
 * Split an interface body into entry blocks.
 *
 * @param lines - the section lines.
 * @param range - the interface open/close line indexes.
 * @returns the entry blocks in source order.
 */
export function entryBlocks(lines, range) {
  const out = []
  let cursor = range.open + 1
  while (cursor < range.close) {
    const name = entryName(lines[cursor])
    if (name === null) { cursor += 1; continue }
    let depth = braceDelta(lines[cursor])
    let last = cursor
    while (depth > 0 && last + 1 < range.close) { last += 1; depth += braceDelta(lines[last]) }
    out.push({ name, start: cursor, end: last })
    cursor = last + 1
  }
  return out
}

/**
 * Whether a line carries no code (comment or blank).
 *
 * @param line - one source line.
 * @returns whether dropping it changes no code byte.
 */
function isAnnotation(line) {
  const t = line.trim()
  if (t === EMPTY) return true
  return t.startsWith('/*') || t.startsWith(STAR) || t.startsWith('//')
}

/** Collapse runs of spaces without a regular expression. */
function squeeze(text) {
  return text.split(' ').filter((part) => part !== EMPTY).join(' ')
}

/**
 * Collapse one entry block to a single declaration line.
 *
 * @param block - the block lines (comments sit on their own lines).
 * @param dropRecord - whether to strip the Record intersections, an 'extra
 *   keys allowed' escape hatch the model cannot act on.
 * @returns the one-line declaration, indented by two spaces.
 */
function collapseEntry(block, dropRecord) {
  let code = squeeze(block.filter((line) => !isAnnotation(line)).join(' '))
  if (dropRecord) code = squeeze(code.split('& Record<string, JsonValue>').join(EMPTY))
  code = compactOutsideStrings(code)
  return '  ' + ensureSemicolon(code)
}

/**
 * Drop the spaces around punctuation, leaving quoted spans untouched.
 *
 * Enum literals are quoted strings, so a blind replace could rewrite a literal
 * value; this scan keeps every character inside a string intact.
 *
 * @param code - squeezed declaration code.
 * @returns the compacted declaration.
 */
function compactOutsideStrings(code) {
  let out = EMPTY
  let quote = null
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]
    if (quote !== null) {
      out += c
      if (c === BACKSLASH) { out += code[i + 1] ?? EMPTY; i += 1 }
      else if (c === quote) quote = null
      continue
    }
    if (c === DQUOTE || c === SQUOTE || c === BACKTICK) { quote = c; out += c; continue }
    if (c === SLASH && (code[i + 1] === STAR || code[i + 1] === SLASH)) {
      // Copy a comment verbatim: gluing its spaces would mangle prose, and a
      // second pass over already-slimmed text must be a no-op.
      const stop = code[i + 1] === STAR ? code.indexOf('*/', i + 2) : -1
      const end = stop === -1 ? code.length : stop + 2
      out += code.slice(i, end)
      i = end - 1
      continue
    }
    if (c !== ' ') { out += c; continue }
    let j = i
    while (j < code.length && code[j] === ' ') j += 1
    const prev = out[out.length - 1]
    const next = code[j]
    if (prev !== OPEN_BRACE && prev !== COMMA && next !== CLOSE_BRACE && next !== COMMA && next !== SEMICOLON) out += ' '
    i = j - 1
  }
  return out
}

/**
 * Turn the comment lines above an entry into one inline block comment.
 *
 * The renderer puts each tool's description in a JSDoc above its declaration.
 * Keeping a short version of it is what makes the compact table usable for the
 * MCP tools whose arguments the renderer types as 'unknown' - for those the
 * declaration alone would carry no information at all.
 *
 * @param commentLines - the absorbed annotation lines above the entry.
 * @param cap - characters of prose to keep.
 * @returns the one-line block comment, or an empty string when there is none.
 */
function entryDoc(commentLines, cap) {
  const prose = squeeze(commentLines
    .map((line) => line.trim().replace(/^\/\*\*?/, EMPTY).replace(/\*\/$/, EMPTY).replace(/^\*\s?/, EMPTY))
    .join(' '))
  if (prose === EMPTY) return EMPTY
  const kept = prose.length > cap
    ? prose.slice(0, Math.max(0, cap - 1)).trimEnd() + ELLIPSIS
    : prose
  return '/** ' + kept + ' */'
}

/**
 * Make sure a declaration ends in a semicolon, before any trailing comment.
 *
 * @param code - compacted declaration code.
 * @returns the declaration with its terminator in the right place.
 */
function ensureSemicolon(code) {
  if (code.endsWith(SEMICOLON)) return code
  if (!code.endsWith(STAR + SLASH)) return code + SEMICOLON
  const start = code.lastIndexOf(SLASH + STAR)
  if (start <= 0) return code + SEMICOLON
  const head = code.slice(0, start).trimEnd()
  const tail = code.slice(start)
  return head.endsWith(SEMICOLON) ? code : head + SEMICOLON + ' ' + tail
}

/**
 * Slim selected entries of both generated interfaces.
 *
 * @param text - the assembled tools:sdk section.
 * @param options - include (glob list of tool names to slim; empty changes
 *   nothing), style ('table' | 'lines'), dropRecord, docCap (characters of the
 *   tool description to keep as a trailing block comment; 0 drops it), and
 *   minEntries so a session with one or two tools is never made worse than it
 *   already is.
 * @returns the rewritten section, or the identical string when nothing matched.
 */
export function slimEntries(text, { include = [], style = 'table', dropRecord = true, docCap = 0, minEntries = 1 } = {}) {
  if (!Array.isArray(include) || include.length === 0) return text
  const parsed = findInterfaces(text)
  if (!parsed) return text
  const { lines, found } = parsed
  const targets = []
  for (const key of INTERFACE_NAMES) {
    for (const block of entryBlocks(lines, found[key])) {
      if (globMatch(include, block.name)) targets.push({ key, block })
    }
  }
  if (targets.length === 0 || targets.length < minEntries) return text
  const out = []
  let cursor = 0
  for (const { key, block } of targets) {
    let start = block.start
    // Absorb the JSDoc above the entry so the prose never detaches from a
    // declaration and lands on its neighbour.
    while (start > found[key].open + 1 && isAnnotation(lines[start - 1])) start -= 1
    out.push(...lines.slice(cursor, start))
    const doc = docCap > 0 ? entryDoc(lines.slice(start, block.start), docCap) : EMPTY
    const body = lines.slice(block.start, block.end + 1)
    if (style === 'lines') {
      if (doc !== EMPTY) out.push('  ' + doc)
      out.push(...body.filter((line) => !isAnnotation(line)))
    } else {
      const declaration = collapseEntry(body, dropRecord)
      out.push(doc === EMPTY ? declaration : declaration + ' ' + doc)
    }
    cursor = block.end + 1
  }
  out.push(...lines.slice(cursor))
  return out.join(NL)
}

/**
 * Replace the ToolOutputMap body with an index signature.
 *
 * Result typings never gate a call — the harness validates arguments against
 * the real schema, not against these declarations — yet they cost one entry per
 * tool on every single request.
 *
 * @param text - the assembled tools:sdk section.
 * @returns the rewritten section, or the identical string when the interface
 *   is missing or already stubbed.
 */
export function stubOutputMap(text) {
  const parsed = findInterfaces(text)
  if (!parsed) return text
  const { lines, found } = parsed
  const range = found.ToolOutputMap
  if (lines.slice(range.open + 1, range.close).join(EMPTY).includes('[toolName: string]')) return text
  return [...lines.slice(0, range.open + 1), OUTPUT_MAP_STUB, ...lines.slice(range.close)].join(NL)
}

/**
 * Collect the original declaration blocks of the selected entries.
 *
 * This is the lazy-disclosure half of the design: the compact table is what
 * travels on every request, and the full declaration is handed back the moment
 * a call against that name is rejected.
 *
 * @param text - the assembled tools:sdk section, before slimming.
 * @param include - glob list of tool names to keep.
 * @returns a map of tool name to its original block text.
 */
export function collectBlocks(text, include) {
  const out = new Map()
  const parsed = findInterfaces(text)
  if (!parsed || !Array.isArray(include) || include.length === 0) return out
  const { lines, found } = parsed
  for (const key of INTERFACE_NAMES) {
    for (const block of entryBlocks(lines, found[key])) {
      if (!globMatch(include, block.name) || out.has(block.name)) continue
      let start = block.start
      while (start > found[key].open + 1 && isAnnotation(lines[start - 1])) start -= 1
      out.set(block.name, lines.slice(start, block.end + 1).join(NL).trim())
    }
  }
  return out
}

/**
 * Take the selected tools out of the generated SDK entirely.
 *
 * The counterpart of the `drop` config for PTC mode: there, the SDK section IS
 * the wire — the model reads the declarations instead of a tools[] array — so
 * a tool taken off the wire while the declarations stay behind is still
 * reachable from inside `run_code`, still costs its declaration on every
 * request, and still invites a call the deployment meant to retire.
 *
 * Only the two generated interfaces are touched: an entry's JSDoc block and
 * its declaration line(s) go together, in both `ToolArgsMap` and
 * `ToolOutputMap`, so a dropped tool leaves no dangling member behind.
 *
 * @param text - the assembled tools:sdk section.
 * @param drop - glob list of tool names to remove.
 * @returns `{ text, removed }`; `removed` lists each dropped name once and
 *   `text` is the input untouched when nothing matched.
 */
export function dropDeclarations(text, drop) {
  const parsed = findInterfaces(text)
  if (!parsed || !Array.isArray(drop) || drop.length === 0) return { text, removed: [] }
  const { lines, found } = parsed
  const gone = new Set()
  const cut = new Set()
  for (const key of INTERFACE_NAMES) {
    if (!found[key]) continue
    for (const block of entryBlocks(lines, found[key])) {
      if (!globMatch(drop, block.name)) continue
      let start = block.start
      while (start > found[key].open + 1 && isAnnotation(lines[start - 1])) start -= 1
      for (let line = start; line <= block.end; line += 1) cut.add(line)
      gone.add(block.name)
    }
  }
  if (cut.size === 0) return { text, removed: [] }
  return { text: lines.filter((_, index) => !cut.has(index)).join(NL), removed: [...gone] }
}

/** Marker line appended when the section was structurally slimmed. */
export const SLIM_MARKER = NL + NL + '...[toolscode: SDK declarations slimmed - tool names, argument names and types are unchanged; a rejected call returns the full declaration]'

