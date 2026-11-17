/**
 * Unit tests for the v0.2 structural SDK slimmers (lib/sdk-slim.js).
 *
 * Pure text in, pure text out — no cordis universe needed, so these run in
 * milliseconds and pin the contract the integration tests rely on: tool names,
 * argument names and types survive; comments, layout and the Record escape
 * hatch do not; every transform is idempotent and byte-stable.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { slimEntries, stubOutputMap, collectBlocks, findInterfaces, entryBlocks, SLIM_MARKER } from '../lib/sdk-slim.js'

const NL = String.fromCharCode(10)
const EMPTY = String.fromCharCode()
const Q = String.fromCharCode(34)
const ELLIPSIS = String.fromCharCode(8230)

/** The miniature generated section (see the note at its top). */
const section = readFileSync(new URL('./fixtures/sdk-sample.txt', import.meta.url), 'utf8').replace(/\r/g, EMPTY)

const names = (text, key) => {
  const p = findInterfaces(text)
  return entryBlocks(p.lines, p.found[key]).map((b) => b.name)
}
const block = (text, key, name) => {
  const p = findInterfaces(text)
  for (const b of entryBlocks(p.lines, p.found[key])) if (b.name === name) return p.lines.slice(b.start, b.end + 1).join(NL)
  return undefined
}
const braces = (text) => (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length

test('findInterfaces: only the generated TypeScript SDK qualifies', () => {
  assert.equal(findInterfaces(EMPTY), null)
  assert.equal(findInterfaces('interface ToolArgsMap {'), null, 'an unclosed interface is not a section')
  assert.ok(findInterfaces(section), 'the fixture qualifies')
  assert.deepEqual(names(section, 'ToolArgsMap'), [
    'advanced_search',
    'mcp__gridcraft__set_cell',
    'mcp__gridcraft__sort_range',
    'mcp__pdfcraft__doc_open',
    'mcp__gridcraft__workbook_list',
    'mcp__fake__thing',
  ])
  assert.deepEqual(names(section, 'ToolOutputMap'), names(section, 'ToolArgsMap'), 'the renderer pairs the two maps')
})

test('slimEntries: an empty include list is the byte-identical default', () => {
  assert.equal(slimEntries(section, {}), section)
  assert.equal(slimEntries(section, { include: [], style: 'table' }), section)
  assert.equal(slimEntries(section, { include: ['mcp__nope__*'], style: 'table' }), section, 'no match -> identical')
  assert.equal(slimEntries(section, { include: ['mcp__*'], style: 'table', minEntries: 99 }), section, 'below minEntries -> identical')
  assert.equal(slimEntries('not an sdk section at all', { include: ['*'] }), 'not an sdk section at all')
})

test('slimEntries: table style keeps every name, argument and type', () => {
  const out = slimEntries(section, { include: ['mcp__*'], style: 'table' })
  assert.ok(out.length < section.length * 0.8, 'expected a real cut, got ' + out.length + ' of ' + section.length)
  assert.deepEqual(names(out, 'ToolArgsMap'), names(section, 'ToolArgsMap'), 'names and order survive')
  assert.deepEqual(names(out, 'ToolOutputMap'), names(section, 'ToolOutputMap'))
  const setCell = block(out, 'ToolArgsMap', 'mcp__gridcraft__set_cell')
  assert.equal(setCell, '  mcp__gridcraft__set_cell: {cell: string; input: string | number | boolean;};')
  assert.ok(!setCell.includes('& Record<string, JsonValue>'), 'the escape hatch is dropped by default')
  assert.equal(block(out, 'ToolArgsMap', 'mcp__gridcraft__sort_range'), '  mcp__gridcraft__sort_range: unknown;', 'unknown stays unknown')
  assert.equal(block(out, 'ToolArgsMap', 'mcp__gridcraft__workbook_list'), '  mcp__gridcraft__workbook_list: Record<string,never>;', 'no-arg entries stay valid (generic spacing compacts)')
  assert.equal(
    block(out, 'ToolOutputMap', 'mcp__gridcraft__set_cell'),
    '  mcp__gridcraft__set_cell: {content: ({type: string; text?: string})[]; isError?: boolean;};',
  )
  assert.ok(out.includes('text?: string'), 'optionality markers survive')
  assert.equal(braces(out), braces(section), 'brace balance preserved')
})

test('slimEntries: quoted literals are never rewritten', () => {
  const out = slimEntries(section, { include: ['advanced_search', 'mcp__*'], style: 'table' })
  const entry = block(out, 'ToolArgsMap', 'advanced_search')
  assert.ok(entry.includes(Q + 'ddg' + Q), 'a literal survives')
  assert.ok(entry.includes(Q + 'bing, searxng' + Q), 'commas and spaces inside a literal are untouched')
})

test('slimEntries: entries outside the include list are byte-identical', () => {
  const out = slimEntries(section, { include: ['mcp__*'], style: 'table' })
  assert.equal(block(out, 'ToolArgsMap', 'advanced_search'), block(section, 'ToolArgsMap', 'advanced_search'))
  assert.equal(block(out, 'ToolOutputMap', 'advanced_search'), block(section, 'ToolOutputMap', 'advanced_search'))
  assert.ok(out.includes('  /** Search the web with optional time filtering. */'), 'its doc stays too')
  assert.ok(out.startsWith('## Writing code for run_code'), 'the section head stays')
  assert.ok(out.endsWith('```' + NL), 'the section tail stays')
})

test('slimEntries: docCap keeps a short description inline', () => {
  const out = slimEntries(section, { include: ['mcp__gridcraft__*'], style: 'table', docCap: 40 })
  const setCell = block(out, 'ToolArgsMap', 'mcp__gridcraft__set_cell')
  assert.ok(setCell.includes('; /** Enter one cell exactly as if t'), 'truncated doc rides on the declaration: ' + setCell)
  assert.ok(setCell.endsWith(ELLIPSIS + ' */'), 'the doc is capped, not dropped')
  assert.ok(block(out, 'ToolArgsMap', 'mcp__gridcraft__workbook_list').includes('/** No parameters at all. */'), 'a short doc is kept whole')
  assert.ok(out.includes('  /** Open a PDF and return its document id. */' + NL + '  mcp__pdfcraft__doc_open: {'), 'tools outside the list keep their own doc above the entry')
  const lined = slimEntries(section, { include: ['mcp__*'], style: 'lines', docCap: 30 })
  const docsAbove = lined.split(NL).filter((l) => /^  \/\*\* (Enter|Sort|Open|No parameters|Tiny fixture)/.test(l))
  assert.equal(docsAbove.length, 5, 'one capped doc per slimmed tool, above the entry')
  assert.ok(lined.includes('  /** Open a PDF and return its doc… */' + NL + '  mcp__pdfcraft__doc_open: {'), 'above, not inline')
})

test('slimEntries: lines style drops prose and keeps the layout', () => {
  const out = slimEntries(section, { include: ['mcp__*'], style: 'lines' })
  assert.ok(out.length < section.length, 'prose removal alone is a win')
  assert.equal(block(out, 'ToolArgsMap', 'mcp__gridcraft__set_cell'), [
    '  mcp__gridcraft__set_cell: {',
    '    cell: string;',
    '    input: string | number | boolean;',
    '  } & Record<string, JsonValue>;',
  ].join(NL))
  assert.ok(!out.includes('Dependent cells recalculate'), 'the doc is gone')
  assert.ok(out.includes('/** Search the web with optional time filtering. */'), 'untouched tools keep their docs')
})

test('slimEntries: dropRecord false keeps the intersection', () => {
  const out = slimEntries(section, { include: ['mcp__gridcraft__set_cell'], style: 'table', dropRecord: false })
  assert.ok(block(out, 'ToolArgsMap', 'mcp__gridcraft__set_cell').includes('} & Record<string,JsonValue>;'), 'kept, compacted')
})

test('every transform is idempotent and byte-stable', () => {
  for (const options of [
    { include: ['mcp__*'], style: 'table' },
    { include: ['mcp__*'], style: 'table', docCap: 60 },
    { include: ['*'], style: 'table', docCap: 120 },
    { include: ['mcp__*'], style: 'lines' },
    { include: ['mcp__*'], style: 'lines', docCap: 60 },
  ]) {
    const once = slimEntries(section, options)
    assert.equal(slimEntries(once, options), once, 'not idempotent: ' + JSON.stringify(options))
    assert.equal(slimEntries(section, options), once, 'not byte-stable: ' + JSON.stringify(options))
    const stubbed = stubOutputMap(once)
    assert.equal(stubOutputMap(stubbed), stubbed, 'stub not idempotent')
    assert.equal(slimEntries(stubbed, options), stubbed, 're-slimming a stubbed section is a no-op')
    assert.ok(stubbed.includes('[toolName: string]: JsonValue | undefined;'))
    assert.equal(block(stubbed, 'ToolArgsMap', 'advanced_search'), block(once, 'ToolArgsMap', 'advanced_search'), 'stubbing must not touch the args map')
    assert.equal((stubbed.match(/interface /g) ?? []).length, 2, 'both interfaces survive')
  }
})

test('stubOutputMap: only the result typings disappear', () => {
  const out = stubOutputMap(section)
  assert.ok(out.length < section.length - 300, 'expected a real cut, got ' + out.length + ' of ' + section.length)
  assert.ok(!out.includes('provider?: string'), 'result typings are gone')
  assert.ok(out.includes('type ToolName = keyof ToolOutputMap'), 'the tail of the section stays')
  assert.ok(out.includes('interface ToolArgsMap {'), 'the args map stays')
  assert.equal(stubOutputMap('no interfaces here'), 'no interfaces here')
})

test('collectBlocks: the original blocks are kept for lazy disclosure', () => {
  const blocks = collectBlocks(section, ['mcp__gridcraft__*'])
  assert.deepEqual([...blocks.keys()], ['mcp__gridcraft__set_cell', 'mcp__gridcraft__sort_range', 'mcp__gridcraft__workbook_list'])
  const setCell = blocks.get('mcp__gridcraft__set_cell')
  assert.ok(setCell.startsWith('/** Enter one cell'), 'the doc rides with its declaration')
  assert.ok(setCell.includes('input: string | number | boolean;'), 'and the full layout')
  assert.equal(collectBlocks(section, []).size, 0)
  assert.equal(collectBlocks('no interfaces', ['*']).size, 0)
})

test('glob matching follows the shrink.js semantics', () => {
  const hit = (patterns) => collectBlocks(section, patterns).size
  assert.equal(hit(['*']), 6, 'star matches everything, both maps, deduped by name')
  assert.equal(hit(['mcp__*']), 5)
  assert.equal(hit(['mcp__gridcraft__*']), 3)
  assert.equal(hit(['*__set_cell']), 1, 'leading star')
  assert.equal(hit(['mcp__*__set_cell']), 1, 'star in the middle')
  assert.equal(hit(['mcp__gridcraft__set_cell']), 1, 'exact')
  assert.equal(hit(['*cell', 'advanced_search']), 2, 'union of patterns')
  assert.equal(hit(['nope']), 0)
})

test('SLIM_MARKER says what the compact table does not spell out', () => {
  assert.ok(SLIM_MARKER.includes('slimmed'))
  assert.ok(SLIM_MARKER.includes('declaration'), 'it points at the disclosure path')
})
