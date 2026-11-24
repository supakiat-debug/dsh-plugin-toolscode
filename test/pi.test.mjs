/**
 * pi adapter tests.
 *
 * pi itself is not a test dependency — it is a coding agent that talks to a
 * model — so this file drives the extension's own functions and a fake
 * ExtensionAPI that matches the real contract exactly: `registerTool(tool)`
 * stores a definition whose `prepareLoadout(loadout)` returns
 * `ToolLoadoutChanges | undefined`, and `on('before_agent_start')` receives an
 * event whose `systemPromptOptions` pi holds *by reference* and rebuilds the
 * prompt from afterwards (verified against
 * dist/core/extensions/runner.js:1134-1176 in @earendil-works/pi-coding-agent
 * 1.6.0: handlers mutate `currentOptions`, and returning `systemPrompt` sets
 * `forceSystemPrompt` instead).
 *
 * The point of these tests is the parts that are easy to get wrong and impossible
 * to see without running: that codemode owns its descriptions and we must not,
 * that `hiddenDeclarations` is what removes a tool from the wire while pi has no
 * way to unregister one, and that a section can be overwritten but never blanked.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import toolscode, { shrinkLoadout, shrinkPromptOptions } from '../extensions/toolscode.mjs'

const CONFIG = {
  enabled: true,
  include: ['*'],
  exclude: [],
  drop: [],
  minChars: 0,
  descriptionCap: 60,
  nestedDescriptionCap: 40,
  snippetsCap: 40,
  guidelinesCap: 40,
  docsCap: null,
  wire: false,
  wireConfig: {},
}

const long = (text, words) => Array.from({ length: words }, (_, i) => `${text}${i}`).join(' ')

const readTool = {
  name: 'read',
  description: long('Read a file from disk and return its contents with line numbers for reference. ', 12),
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to read.' } } },
}
const bashTool = {
  name: 'bash',
  description: long('Run a shell command and stream its output back to the conversation as text. ', 12),
  parameters: { type: 'object', properties: {} },
}
const shortTool = { name: 'ls', description: 'List a directory.', parameters: { type: 'object', properties: {} } }

/** Stand in for pi's ToolLoadout; only `declared` matters for these tests. */
const loadout = (declared) => ({
  declared,
  callable: declared,
  registered: declared,
  getExposure: () => 'direct',
  getNamespace: () => undefined,
  getPromptGuidelines: () => [],
})

const config = (over = {}) => ({ ...CONFIG, ...over })

test('shrinkLoadout caps long descriptions and leaves short ones alone', () => {
  const { changes, report } = shrinkLoadout(loadout([readTool, bashTool, shortTool]), config())
  assert.deepEqual(Object.keys(changes.descriptions).sort(), ['bash', 'read'])
  assert.ok(changes.descriptions.read.length <= 60, `cap: ${changes.descriptions.read.length}`)
  assert.ok(changes.descriptions.read.endsWith('…'))
  assert.equal(report.shrunk.length, 2)
  assert.equal(report.hidden.length, 0)
  assert.ok(report.after < report.before)
  // `after` is what the request would carry: the untouched tool still costs its
  // full bytes, so the two numbers can be checked against a real capture.
  assert.equal(
    report.after,
    JSON.stringify({ ...readTool, description: changes.descriptions.read }).length
      + JSON.stringify({ ...bashTool, description: changes.descriptions.bash }).length
      + JSON.stringify(shortTool).length,
  )
  assert.equal(report.before, [readTool, bashTool, shortTool].reduce((sum, tool) => sum + JSON.stringify(tool).length, 0),
    'before is the sum of the declarations, not the JSON of the array that holds them')
})

test('codemode owns its descriptions, so shrinkLoadout leaves every one of them alone', () => {
  // codemode's own prepareLoadout rewrites each callable tool's description to
  // add `tools.x(args)`, and pi merges hook output into one map with last writer
  // wins. Writing here would delete pi's guidance, which is worse than the bytes
  // saved — the knob for that deployment is codemode.inlineBudget.
  const codemode = { name: 'codemode', description: 'Call tools from a script.', parameters: { type: 'object' } }
  const { changes, report } = shrinkLoadout(loadout([codemode, readTool, bashTool]), config())
  assert.equal(changes, undefined)
  assert.equal(report.skippedFor, 'codemode')
  assert.deepEqual(report.shrunk, [])
  assert.equal(report.after, report.before)
})

test('codemode does not disable drop: a hidden declaration is not a description', () => {
  const codemode = { name: 'codemode', description: 'Call tools from a script.', parameters: { type: 'object' } }
  const { changes, report } = shrinkLoadout(loadout([codemode, readTool, shortTool]), config({ drop: ['read'] }))
  assert.deepEqual(changes, { hiddenDeclarations: ['read'] })
  assert.deepEqual(report.hidden, ['read'])
  assert.equal(report.after, JSON.stringify(codemode).length + JSON.stringify(shortTool).length)
})

test('drop hides a declaration and leaves the tool callable, which is all pi offers', () => {
  const { changes, report } = shrinkLoadout(loadout([readTool, shortTool]), config({ drop: ['rea*'] }))
  assert.deepEqual(changes.hiddenDeclarations, ['read'])
  assert.equal(report.shrunk.length, 0, 'a dropped tool is not also reported as shrunk')
  assert.equal(report.after, JSON.stringify(shortTool).length)
})

test('exclude, include and minChars decide what is touched', () => {
  const tools = [readTool, bashTool, shortTool]
  assert.deepEqual(shrinkLoadout(loadout(tools), config({ exclude: ['bash'] })).report.shrunk, ['read'])
  assert.deepEqual(shrinkLoadout(loadout(tools), config({ include: ['ba*'] })).report.shrunk, ['bash'])
  // minChars measures the whole declaration, the same unit dsh reports in, so a
  // deployment can say "do not bother with anything already cheap". It spares
  // the cheap ones: read is the biggest declaration here, so a floor just above
  // bash's cost leaves read as the only tool worth touching.
  const floor = config({ minChars: JSON.stringify(bashTool).length + 1 })
  assert.deepEqual(shrinkLoadout(loadout(tools), floor).report.shrunk, ['read'])
  const everything = config({ minChars: JSON.stringify(shortTool).length + 1 })
  assert.deepEqual(shrinkLoadout(loadout(tools), everything).report.shrunk.sort(), ['bash', 'read'])
})

test('nothing to change means no changes, not an empty object', () => {
  // pi treats the hook result as ToolLoadoutChanges | undefined; returning {}
  // would be a lie about having changed something.
  const { changes } = shrinkLoadout(loadout([shortTool]), config())
  assert.equal(changes, undefined)
})

test('the shrink is byte-stable, because pi diffs sections and caches the prefix', () => {
  const tools = [readTool, bashTool, shortTool]
  const one = shrinkLoadout(loadout(tools), config()).changes
  const two = shrinkLoadout(loadout(tools), config()).changes
  assert.equal(JSON.stringify(one), JSON.stringify(two))
})

test('shrinkPromptOptions caps the snippets and guidelines pi builds its prompt from', () => {
  const options = {
    toolSnippets: { read: long('read', 30), bash: long('bash', 30) },
    toolGuidelines: { read: [long('rule', 30), 'short rule'] },
    promptGuidelines: [long('global', 30)],
    sections: {},
  }
  const report = { snippets: [], guidelines: 0, docsCap: null }
  shrinkPromptOptions(options, config(), report)
  assert.ok(options.toolSnippets.read.endsWith('…'))
  assert.ok(options.toolSnippets.read.length <= 40)
  assert.equal(report.snippets.length, 2)
  assert.equal(report.guidelines, 2, 'one per-tool rule and one global rule were long enough to cap')
  assert.equal(options.toolGuidelines.read[1], 'short rule', 'already-short text is left alone')
  assert.equal(options.sections.docs, undefined, 'docsCap null means do not touch pi\'s own section')
})

test('shrinkPromptOptions honours exclude and leaves customPrompt sessions alone', () => {
  const options = { toolSnippets: { read: long('read', 30) }, toolGuidelines: {}, promptGuidelines: [], sections: {} }
  const report = { snippets: [], guidelines: 0, docsCap: null }
  shrinkPromptOptions(options, config({ exclude: ['read'] }), report)
  assert.equal(report.snippets.length, 0)
  assert.ok(options.toolSnippets.read.length > 40)
})

test('docs section: 0 blanks it with a space, a number replaces it', () => {
  // system-prompt.js copies custom sections with `if (content)`, so '' is
  // dropped and the default survives; one space is the smallest survivor.
  const blank = { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], sections: {} }
  shrinkPromptOptions(blank, config({ docsCap: 0 }), { snippets: [], guidelines: 0, docsCap: 0 })
  assert.equal(blank.sections.docs, ' ')
  const pointer = { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], sections: {} }
  shrinkPromptOptions(pointer, config({ docsCap: 80 }), { snippets: [], guidelines: 0, docsCap: 80 })
  assert.ok(pointer.sections.docs.includes('toolscode'))
  assert.ok(pointer.sections.docs.length <= 120)
})

test('the extension registers a carrier tool and reports when asked', async () => {
  const tools = new Map()
  const handlers = new Map()
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
  }
  toolscode(pi, { config: CONFIG })
  const carrier = tools.get('toolscode')
  assert.ok(carrier, 'the carrier is what makes prepareLoadout run')
  assert.deepEqual(carrier.parameters, { type: 'object', properties: {}, additionalProperties: false })
  assert.equal(carrier.exposure, undefined, 'the carrier is a direct tool by default')

  // Nothing has run yet: prepareLoadout is only called when the active tools change.
  const first = await carrier.execute('id-1', {}, undefined, undefined, {})
  assert.match(first.content[0].text, /not seen a loadout/)

  const changes = carrier.prepareLoadout(loadout([readTool, bashTool, shortTool]))
  assert.ok(changes.descriptions.read, 'the carrier applied the shrink to the real loadout')
  const report = await carrier.execute('id-2', {}, undefined, undefined, {})
  assert.match(report.content[0].text, /tool declarations: \d+ -> \d+ chars \(2 shrunk/)
  assert.match(report.content[0].text, /docs section untouched/)
  assert.match(report.content[0].text, /wire: off/)
  const printed = report.content[0].text.split('\n')
  assert.ok(!printed.includes('null'), 'a conditional line must not print the word null')
  assert.equal(printed.length, 3, 'declarations, prompt inputs, wire — the codemode line is absent here')

  // The prompt handler mutates the options pi handed over, and returns nothing:
  // returning a string would set forceSystemPrompt and lose the section diff.
  const options = { toolSnippets: { read: long('read', 30) }, toolGuidelines: {}, promptGuidelines: [], sections: undefined }
  assert.equal(handlers.get('before_agent_start')({ systemPromptOptions: options }), undefined)
  assert.ok(options.toolSnippets.read.endsWith('…'))
  assert.deepEqual(Object.keys(options.sections), [])
})

test('a session with its own system prompt is left completely alone', () => {
  // customPrompt already suppresses pi's tools/rules/docs sections, so capping
  // the inputs would change nothing and the report would claim credit for it.
  const tools = new Map()
  const handlers = new Map()
  toolscode({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler) },
    { config: CONFIG })
  const options = { customPrompt: 'mine', toolSnippets: { read: long('read', 30) }, toolGuidelines: {}, promptGuidelines: [] }
  handlers.get('before_agent_start')({ systemPromptOptions: options })
  assert.ok(options.toolSnippets.read.length > 40)
})

test('the docs pointer keeps its marker when the cap is smaller than the sentence', () => {
  const options = { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], sections: {} }
  shrinkPromptOptions(options, config({ docsCap: 40 }), { snippets: [], guidelines: 0, docsCap: 40 })
  assert.ok(options.sections.docs.startsWith('toolscode:'), 'the marker is first so a cut cannot amputate it')
  // cap + 1: the contract of truncateText is "keep at most `cap`, then append
  // one character to show it was cut", which is the honest reading of a cap.
  assert.ok(options.sections.docs.length <= 41, `got ${options.sections.docs.length} chars`)
})

test('capping the same options twice reports the same numbers, not doubled ones', () => {
  // pi holds systemPromptOptions by reference and may hand the same object to
  // before_agent_start again on a later turn of one session; a tally that grew
  // every turn would over-report the one thing this report exists to measure.
  const options = {
    toolSnippets: { read: long('read', 30) },
    toolGuidelines: { read: [long('rule', 30)] },
    promptGuidelines: [long('global', 30)],
    sections: {},
  }
  const report = { snippets: [], guidelines: 0, docsCap: null }
  shrinkPromptOptions(options, config(), report)
  const once = { snippets: [...report.snippets], guidelines: report.guidelines }
  assert.ok(once.guidelines > 0, 'the first pass must have found something to cap')
  shrinkPromptOptions(options, config(), report)
  assert.deepEqual(report.snippets, once.snippets)
  assert.equal(report.guidelines, once.guidelines)
})
