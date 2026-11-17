#!/usr/bin/env node
/**
 * tools/measure.mjs — measure what a tools:sdk / tools[] payload costs you, and what
 * this plugin would have saved, straight from the session logs DSH already writes.
 * 
 * DSH logs every assembled request header (`request/header`) next to the system message
 * it was assembled with, under ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 * (multi-frame zstd). This tool decodes those frames, finds the assemblies that carry a
 * `tools:sdk` declaration section, and reports:
 * 
 *   - the size of the wire `tools[]` and of the request prefix (everything the model
 *     reads before the first user message),
 *   - which shrink fingerprints are present in the served bytes (v0.1 prose caps, v0.2
 *     layout slim, the 457c note, the stubbed ToolOutputMap),
 *   - what the shrinkers shipped in lib/ would do to the same wire schemas, so you can
 *     sweep a config against your own tools without restarting anything,
 *   - an A/B of the newest assembly that carries a marker against the newest one that
 *     does not, but only when both declared the same tool inventory.
 * 
 * Requires Node >= 22.15 (zlib zstd). No dependencies.
 * 
 *   node tools/measure.mjs                       # newest sessions, table
 *   node tools/measure.mjs --limit=20 --preset=ptc
 *   node tools/measure.mjs --sessions=/path/to/.dsh/sessions --json
 *   node tools/measure.mjs --replay=captured-tools-sdk.txt   # size a captured section
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { schemaChars, shrinkInstructions, shrinkSdkSection, shrinkToolSchema } from '../lib/shrink.js'

const ARG = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = ARG.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const num = (name, dflt) => Number(flag(name, dflt))
const SESSIONS = flag('sessions', join(homedir(), '.dsh', 'sessions'))
const LIMIT = num('limit', 8)
const PRESET = flag('preset', null)
const AS_JSON = ARG.includes('--json')
const REPLAY = flag('replay', null)
// Defaults below are the config this plugin is deployed with; override to sweep.
const WIRE_CFG = {
  descriptionCap: num('description-cap', 160),
  nestedDescriptionCap: num('nested-cap', 80),
}
const MIN_CHARS = num('min-chars', 600)
const INSTR_CAP = num('instructions-cap', 2000)
const SDK_CFG = {
  descriptionCap: num('sdk-desc-cap', 160),
  tagCap: num('sdk-tag-cap', 80),
  blockMinChars: num('sdk-block-min-chars', 200),
}

const HEADING = '## Writing code for run_code'
const MARK_PROSE = 'SDK declaration prose shrunk'
const MARK_SLIM = 'SDK declarations slimmed'
const MARK_NOTE = 'MCP tools resolve to the standard envelope'
const MARK_STUB = '[toolName: string]: JsonValue | undefined;'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const TOK = 3.8 // rough chars/token for the models this is deployed against

if (!zstdDecompressSync) {
  console.error('tools/measure.mjs needs Node >= 22.15 (zlib.zstdDecompressSync)')
  process.exit(1)
}

/** Session logs concatenate zstd frames; a frame boundary is only known by trial. */
function decode(buf) {
  const parts = []
  let i = 0
  while (true) {
    const start = buf.indexOf(MAGIC, i)
    if (start < 0) break
    const ends = []
    let t = buf.indexOf(MAGIC, start + 4)
    while (t > 0) { ends.push(t); t = buf.indexOf(MAGIC, t + 4) }
    ends.push(buf.length)
    let ok = false
    for (const end of ends) {
      try { parts.push(zstdDecompressSync(buf.subarray(start, end))); i = end; ok = true; break } catch {}
    }
    if (!ok) i = start + 4
  }
  return Buffer.concat(parts).toString('utf8')
}

const textOf = (c) =>
  typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((x) => (typeof x?.text === 'string' ? x.text : JSON.stringify(x))).join(NLX)
  : c == null ? '' : JSON.stringify(c)
const NLX = String.fromCharCode(10)
const stamp = (t) => (typeof t === 'number' ? new Date(t).toISOString() : String(t ?? '')).slice(5, 16)

/** The tools:sdk section runs from its heading to the next top-level heading. */
function declSection(system) {
  const start = system.indexOf(HEADING)
  if (start < 0) return null
  const next = system.slice(start + HEADING.length).match(/^#[^\n]*$/m)
  return system.slice(start, next ? start + HEADING.length + next.index : system.length)
}

const argNames = (section) => {
  const i = section.indexOf('interface ToolArgsMap')
  const j = section.indexOf('interface ToolOutputMap')
  if (i < 0) return []
  return (section.slice(i, j < 0 ? section.length : j).match(/^ {2}[^:\s]+(?=:)/gm) ?? [])
    .map((s) => s.trim()).sort()
}

function* sessionFiles(dir) {
  for (const workspace of readdirSync(dir)) {
    const wd = join(dir, workspace)
    if (!statSync(wd).isDirectory()) continue
    for (const session of readdirSync(wd)) {
      const file = join(wd, session, 'session.v4.jsonl.zstd')
      try { if (statSync(file).isFile()) yield { file, mtime: statSync(file).mtimeMs } } catch {}
    }
  }
}

function assemblies(text, label) {
  const out = []
  let preset = '?'
  let pending = null
  for (const line of text.split(NLX)) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'session') preset = o.agentPreset || '?'
    if (o.type === 'agent-preset/selected' && o.data?.agentPreset) preset = o.data.agentPreset
    if (o.type === 'system/message') pending = textOf(o.data?.message?.content)
    if (o.type !== 'request/header') continue
    out.push({ label, preset, time: o.time, tools: o.data?.header?.tools ?? [], system: pending ?? '' })
    pending = null
  }
  return out
}

function measure(a) {
  let wireBefore = 0
  let wireAfter = 0
  for (const tool of a.tools) {
    const size = schemaChars(tool)
    wireBefore += size
    wireAfter += tool.name === 'run_code' || size < MIN_CHARS
      ? size
      : schemaChars(shrinkToolSchema(tool, WIRE_CFG))
  }
  const sections = a.system.split(/\n(?=###|## |=== )/)
  const instructions = sections.filter((s) => s.startsWith('### MCP server:'))
  const instrBefore = instructions.reduce((n, s) => n + s.length, 0)
  const instrAfter = instructions.reduce((n, s) => n + (s.length > INSTR_CAP ? shrinkInstructions(s, INSTR_CAP).length : s.length), 0)
  const section = declSection(a.system)
  const names = section ? argNames(section) : []
  return {
    time: stamp(a.time),
    sid: a.label,
    preset: a.preset,
    tools: a.tools.length,
    mcpTools: a.tools.filter((t) => t.name.includes('__')).length,
    wireBefore, wireAfter,
    instrBefore, instrAfter, instrCount: instructions.length,
    decl: section?.length ?? 0,
    declWouldBe: section ? shrinkSdkSection(section, SDK_CFG).length : 0,
    prose: section?.includes(MARK_PROSE) ? 1 : 0,
    slim: section?.includes(MARK_SLIM) ? 1 : 0,
    note: section?.includes(MARK_NOTE) ? 1 : 0,
    stub: section?.includes(MARK_STUB) ? 1 : 0,
    entries: names.length,
    mcpEntries: names.filter((n) => n.startsWith('mcp__')).length,
    oneLine: (section?.match(/^ {2}mcp__[^:]+: [^\n]*$/gm) ?? []).length,
    prefix: a.system.length,
    inventory: names.join(','),
  }
}

if (REPLAY) {
  const text = readFileSync(REPLAY, 'utf8')
  const after = shrinkSdkSection(text, SDK_CFG)
  console.log('captured tools:sdk section: ' + text.length + 'c')
  console.log('  prose caps (' + SDK_CFG.descriptionCap + '/' + SDK_CFG.tagCap + '/' + SDK_CFG.blockMinChars + ') -> ' + after.length + 'c ('
    + (100 * (1 - after.length / text.length)).toFixed(1) + '% off, ~' + Math.round((text.length - after.length) / TOK) + ' tok)')
  console.log('  markers already present: prose=' + (text.includes(MARK_PROSE) ? 'yes' : 'no')
    + ' slim=' + (text.includes(MARK_SLIM) ? 'yes' : 'no') + ' stub=' + (text.includes(MARK_STUB) ? 'yes' : 'no'))
  console.log('  declaration entries: ' + argNames(text).length + ' ('
    + argNames(text).filter((n) => n.startsWith('mcp__')).length + ' MCP)')
  console.log('  note: layout slimming (sdkSlimInclude / sdkOutputMap) lives in lib/sdk-slim.js;',
    ' it is applied to the generated section at assembly time — see README for the variant table.')
  process.exit(0)
}

const files = [...sessionFiles(SESSIONS)].sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT)
const rows = []
for (const f of files) {
  const label = f.file.split(/[\\/]/).slice(-2, -1)[0].replace('session-', '').slice(0, 8)
  let text
  try { text = decode(readFileSync(f.file)) } catch { continue }
  for (const a of assemblies(text, label)) {
    if (PRESET && a.preset !== PRESET) continue
    const m = measure(a)
    if (m.prefix === 0) continue
    rows.push(m)
  }
}
rows.sort((a, b) => b.time.localeCompare(a.time))

if (AS_JSON) {
  console.log(JSON.stringify(rows.map(({ inventory, ...r }) => r), null, 1))
  process.exit(0)
}

const pad = (v, n) => String(v).padStart(n)
console.log('sessions read: ' + files.length + ' from ' + relative(homedir(), SESSIONS).replace(/\\/g, '/') + (PRESET ? ' (preset ' + PRESET + ')' : ''))
console.log('assemblies with tools or tools:sdk: ' + rows.length)
const head = 'time(UTC)     session   preset      tools mcp | wire ->shrink | instr ->shrink | decl ->prosecap | prose slim note stub | declEntries mcp 1line | prefix'
console.log(head)
for (const r of rows.slice(0, 40)) {
  console.log(r.time.padEnd(13) + r.sid.padEnd(10) + r.preset.padEnd(11)
    + pad(r.tools, 5) + pad(r.mcpTools, 4) + ' | ' + pad(r.wireBefore, 6) + '->' + pad(r.wireAfter, 6) + pad(pct(r.wireBefore, r.wireAfter), 9)
    + ' | ' + pad(r.instrBefore, 5) + '->' + pad(r.instrAfter, 5) + pad(pct(r.instrBefore, r.instrAfter), 7)
    + ' | ' + pad(r.decl, 6) + '->' + pad(r.declWouldBe, 6) + pad(pct(r.decl, r.declWouldBe), 8)
    + ' | ' + pad(r.prose, 5) + pad(r.slim, 5) + pad(r.note, 5) + pad(r.stub, 5)
    + ' | ' + pad(r.entries, 11) + pad(r.mcpEntries, 4) + pad(r.oneLine, 6) + ' | ' + pad(r.prefix, 7) + 'c')
}
function pct(before, after) {
  return before > 0 ? ' ' + (100 * (1 - after / before)).toFixed(1) + '%' : ''
}

const after = rows.find((r) => r.slim)
const v01 = rows.filter((r) => r.prose && !r.slim && r.inventory).sort((a, b) => b.time.localeCompare(a.time))[0]
const before = rows.filter((r) => !r.slim && r.inventory).sort((a, b) => b.time.localeCompare(a.time))[0]
const line = (what, base) => {
  const d = base.decl - after.decl
  console.log('  vs ' + what.padEnd(22) + base.time + ' ' + base.sid + ' tools:sdk = ' + base.decl + 'c'
    + '  -> ' + (d >= 0 ? '-' : '+') + Math.abs(d) + 'c (' + (100 * d / base.decl).toFixed(1) + '%, ~' + Math.round(Math.abs(d) / TOK) + ' tok/step)')
}
if (after && (before || v01)) {
  console.log('')
  console.log('A/B on an identical declaration inventory (' + after.entries + ' entries, ' + after.mcpEntries + ' MCP), newest slimmed assembly = ' + after.time + ' ' + after.sid + ' at ' + after.decl + 'c:')
  if (before && before.inventory === after.inventory) line('nothing shrunk', before)
  if (v01 && v01.inventory === after.inventory && v01 !== before) line('v0.1 prose caps', v01)
} else if (after) {
  console.log('')
  console.log('A/B skipped: no pre-marker assembly with the same declaration inventory in the sessions read.')
}
console.log('')
console.log('markers: prose = v0.1 SDK prose caps, slim = v0.2 declaration layout, stub = ToolOutputMap stubbed')

