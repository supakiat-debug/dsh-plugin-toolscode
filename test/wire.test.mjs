/**
 * Tests for the wire layer — the part of this plugin that is not dsh.
 *
 * dsh hands the plugin a section registry; pi and Hermes hand it a provider
 * request payload. This suite pins the behaviour of that second surface across
 * all three serialisations (OpenAI chat, OpenAI Responses, Anthropic) plus the
 * kwargs dict Hermes POSTs, using one fixture shared with the Python port in
 * adapters/hermes/, so the two implementations cannot drift into two different
 * shrinkers that merely look related.
 *
 * What the assertions deliberately do NOT do is count characters and call it a
 * saving. The pinned strings in test/fixtures/wire-payloads.json are the point:
 * a byte count can be met by cutting the wrong sentence, whereas "this exact
 * description, truncated on this exact word boundary, with the marker" is the
 * behaviour a prompt cache depends on.
 *
 * Run: node --test test/wire.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applySystemSections,
  detectShape,
  headingBlocks,
  readTool,
  shrinkWirePayload,
} from '../lib/wire.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'wire-payloads.json'), 'utf8'))

/** The config the fixture's `expect` block was produced with. */
const CONFIG = {
  ...fx.caps,
  exclude: ['secret_*'],
  systemSections: { Personality: '' },
}

/** Shrink a named payload from the fixture. */
function run(name, config = CONFIG) {
  const payload = structuredClone(fx.payloads[name])
  return { result: shrinkWirePayload(payload, config), payload }
}

test('detects the provider shape from where a tool keeps its fields', () => {
  for (const [name, expected] of Object.entries(fx.expect.shapes)) {
    assert.equal(detectShape(fx.payloads[name]), expected, name)
  }
  assert.equal(detectShape({ model: 'x' }), 'unknown')
  assert.equal(detectShape({ model: 'x', tools: [{ type: 'web_search' }] }), 'unknown')
})

test('reads a tool out of every shape without the caller knowing which one', () => {
  assert.deepEqual(
    readTool({ type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object' } } }),
    { name: 'a', description: 'd', schema: { type: 'object' }, schemaKey: 'parameters', nested: true },
  )
  const anthropic = readTool({ name: 'a', description: 'd', input_schema: { type: 'object' } })
  assert.equal(anthropic.schemaKey, 'input_schema')
  assert.equal(anthropic.nested, false)
  assert.equal(readTool({ type: 'web_search' }), undefined)
  assert.equal(readTool(undefined), undefined)
})

test('openai-chat: shrinks the long tool to the pinned bytes and leaves the excluded one alone', () => {
  const { result, payload } = run('openai-chat')
  const [find, read, secret] = result.payload.tools

  assert.equal(result.shape, 'openai-chat')
  assert.equal(find.function.description, fx.expect.findFilesDescription)
  assert.equal(find.function.parameters.properties.root.description, fx.expect.rootDescription)
  // Structural keywords survive; only prose is touched, so validation cannot change.
  assert.equal(find.function.parameters.properties.limit.type, 'number')
  assert.deepEqual(read, payload.tools[1])
  assert.equal(secret.function.description.length, fx.expect.secretDescriptionLength)

  assert.deepEqual(result.report.shape, 'openai-chat')
  assert.deepEqual(result.report.shrunk, fx.expect.shrunk['openai-chat'])
  assert.deepEqual(result.report.dropped, [])
  assert.equal(result.payload.tools.length, fx.expect.toolCount['openai-chat'])
  assert.ok(result.report.toolsAfter < result.report.toolsBefore, 'the tool block must get smaller')
})

test('openai-chat: the system message loses the matched section and keeps everything else', () => {
  const { result } = run('openai-chat')
  const system = result.payload.messages[0]
  const rest = result.payload.messages.slice(1)

  assert.equal(system.role, 'system')
  assert.ok(!system.content.includes('## Personality'))
  assert.ok(system.content.includes('## Tools'))
  assert.ok(system.content.startsWith('Lead line'), 'text before the first heading is not matchable')
  assert.deepEqual(result.report.systemReplaced, ['Personality'])
  assert.deepEqual(result.report.systemMissing, [])
  assert.ok(result.report.systemAfter < result.report.systemBefore)
  assert.deepEqual(rest, fx.payloads['openai-chat'].messages.slice(1))
})

test('anthropic: rewrites only the first text block and keeps cache breakpoints', () => {
  const { result } = run('anthropic')
  const [first, second] = result.payload.system

  assert.ok(!first.text.includes('## Personality'))
  assert.equal(second.text, fx.payloads.anthropic.system[1].text)
  assert.equal(result.payload.tools[0].input_schema.type, 'object')
  assert.equal(result.payload.tools[0].description, fx.expect.findFilesDescription)
  assert.equal(result.payload.tools[0].input_schema.properties.root.description, fx.expect.rootDescription)
  assert.equal(result.payload.max_tokens, 4096, 'unrelated fields pass through')
})

test('anthropic: cache_control on the block it replaces is carried over', () => {
  const payload = {
    system: [{ type: 'text', text: 'Lead.\n\n## Personality\n\nLong persona prose that goes on.', cache_control: { type: 'ephemeral' } }],
    tools: [],
  }
  const out = shrinkWirePayload(payload, { systemSections: { Personality: '' } })
  assert.deepEqual(out.payload.system[0].cache_control, { type: 'ephemeral' })
  // The lead keeps the blank line that separated it from the removed heading:
  // byte-stability means not tidying up what a removal happened to leave behind.
  assert.equal(out.payload.system[0].text, 'Lead.\n')
})

test('openai-responses: flat tool entries and the instructions field both shrink', () => {
  const { result } = run('openai-responses')
  const [tool] = result.payload.tools

  assert.equal(result.shape, 'openai-responses')
  assert.equal(tool.description, fx.expect.findFilesDescription)
  assert.equal(tool.parameters.properties.root.description, fx.expect.rootDescription)
  assert.ok(!result.payload.instructions.includes('## Personality'))
  assert.equal(result.payload.input, 'hi')
})

test('hermes kwargs: shrinks the tool dict it is about to POST, transcript untouched', () => {
  const { result } = run('hermes-kwargs')
  assert.equal(result.payload.tools[0].function.description, fx.expect.findFilesDescription)
  assert.ok(!result.payload.messages[0].content.includes('## Personality'))
  assert.deepEqual(result.payload.messages[1], fx.payloads['hermes-kwargs'].messages[1])
  assert.deepEqual(result.report.shrunk, fx.expect.shrunk['hermes-kwargs'])
})

test('never mutates the payload it was handed', () => {
  const payload = structuredClone(fx.payloads['openai-chat'])
  const before = JSON.stringify(payload)
  shrinkWirePayload(payload, { ...CONFIG, drop: ['read'], systemSections: { Tools: 'Replaced.' }, systemCap: 20 })
  assert.equal(JSON.stringify(payload), before)
})

test('is byte-stable, because a request rewriter that wobbled would break the cache', () => {
  const a = shrinkWirePayload(structuredClone(fx.payloads.anthropic), CONFIG)
  const b = shrinkWirePayload(structuredClone(fx.payloads.anthropic), CONFIG)
  assert.equal(JSON.stringify(a.payload), JSON.stringify(b.payload))
  assert.deepEqual(a.report, b.report)
})

test('drop removes the tool from the request and names it in the report', () => {
  const { result } = run('openai-chat', { ...CONFIG, drop: ['secret_*', 'read'] })
  assert.deepEqual(result.payload.tools.map((t) => t.function.name), ['find_files'])
  assert.deepEqual(result.report.dropped, ['read', 'secret_tool'], 'reported in request order')
  assert.deepEqual(result.report.shrunk, ['find_files'])
})

test('include narrows what is touched; minChars spares anything already small', () => {
  const only = run('openai-chat', { ...CONFIG, exclude: [], include: ['secret_*'] })
  assert.deepEqual(only.result.report.shrunk, ['secret_tool'])
  assert.equal(only.result.payload.tools[0].function.description, fx.payloads['openai-chat'].tools[0].function.description)

  // read's whole entry is ~150 characters: below the floor, its prose is left
  // alone because cutting it would cost more in lost meaning than it saves.
  const big = run('openai-chat', { ...CONFIG, exclude: [], minChars: 200 })
  assert.deepEqual(big.result.report.shrunk, ['find_files', 'secret_tool'])
})

test('an unmatched section key is reported, never invented', () => {
  const { result } = run('openai-chat', { ...CONFIG, systemSections: { Personality: '', 'No Such Section': 'Made up.' } })
  assert.ok(!result.payload.messages[0].content.includes('Made up.'))
  assert.deepEqual(result.report.systemMissing, ['No Such Section'])
  assert.deepEqual(result.report.systemReplaced, ['Personality'])
})

test('systemCap cuts the tail with a marker a reader can see', () => {
  const { result } = run('openai-chat', { systemCap: 40 })
  const text = result.payload.messages[0].content
  assert.ok(text.startsWith('Lead line'))
  assert.ok(text.endsWith('[toolscode: system prompt truncated]'))
  assert.ok(text.length < result.report.systemBefore + 60)
})

test('headingBlocks keeps unheaded text as lead and splits on every level', () => {
  const { lead, blocks } = headingBlocks('lead one\nlead two\n# A\n\nbody a\n\n### B\ndeep\n')
  assert.equal(lead, 'lead one\nlead two')
  assert.deepEqual(blocks.map((b) => [b.heading, b.level]), [['A', 1], ['B', 3]])
  assert.ok(blocks[0].text.includes('body a'))
  assert.ok(blocks[1].text.startsWith('### B'))
})

test('applySystemSections with no keys is the identity', () => {
  const text = 'Lead.\n\n## Tools\n\nbody\n'
  assert.deepEqual(applySystemSections(text, {}), { text, replaced: [], missing: [] })
  assert.equal(applySystemSections(text, undefined).text, text)
})

test('a tool entry the shrinker does not understand passes through untouched', () => {
  const hosted = { type: 'web_search', search_context_size: 'low' }
  // Anthropic names its server tools, so readTool sees a name and would happily
  // write an empty description onto a tool that has neither prose nor schema.
  const named = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }
  const out = shrinkWirePayload(
    { model: 'x', tools: [hosted, named, structuredClone(fx.payloads['openai-chat'].tools[0])], messages: [] },
    CONFIG,
  )
  assert.deepEqual(out.payload.tools[0], hosted)
  assert.deepEqual(out.payload.tools[1], named)
  assert.ok(!('description' in out.payload.tools[1]), 'no empty description added to a provider-owned tool')
  assert.deepEqual(out.report.shrunk, ['find_files'])
})

test('a payload that is not an object is returned as it came', () => {
  for (const bad of [undefined, null, 'string', 42]) {
    const { payload } = shrinkWirePayload(bad, CONFIG)
    assert.equal(payload, bad)
  }
})
