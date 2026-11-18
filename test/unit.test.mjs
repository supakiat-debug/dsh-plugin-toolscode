/**
 * Integration tests for dsh-plugin-toolscode against the REAL cordis
 * universe: real SystemPrompt service, real ToolRuntime service, real
 * dsh-scope chains, real dispatch pipeline.
 *
 * Topology note (this is what production actually looks like): the DSH web
 * deployment disables the root-plane tool rows and every agent preset
 * mounts its own tool rows, so tools are registered in the PRESET's
 * standing scope layer — never the global layer. The old unit tests
 * registered tools globally and passed while production did nothing, so
 * every scenario here registers through a preset-scoped plugin row
 * (`registrar`), exactly like the preset's `tool-*` rows do.
 *
 * Two harness contracts are covered by ONE suite, feature-detected rather
 * than version-parsed: up to dsh 0.1 ToolsService presents tools[] itself and
 * the assemble waterfall carries the array, while from dsh 0.2 presentation
 * and dispatch live in a mountable tool executor (the native one is mounted
 * into the test universe, and the plugin runs with executor: wrap so it
 * shrinks through that executor). Every wire assertion runs in both worlds.
 *
 * Module resolution: the dsh packages live in the installed dsh bundle, not
 * in this package's tree, so imports are anchored with createRequire at the
 * dsh install (override with DSH_ROOT).
 *
 * Run: node --test test/unit.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Locate the dsh install, in order: DSH_ROOT, a local/hoisted node_modules install
// (CI, or `npm install @deepseek-ai/dsh` in this checkout), then the npm global
// root — DSH is normally shipped as a CLI install, so that is where it lives.
const usable = (p) => p && !p.includes('${') && existsSync(join(p, 'lib/bin.js')) ? p : ''
const npmRootG = (() => {
  try { return execSync('npm root -g', { encoding: 'utf8', shell: true }).trim() } catch { return '' }
})()
const env = process.env
const guessed = process.platform === 'win32'
  ? [env.APPDATA && join(env.APPDATA, 'npm', 'node_modules'), env.ProgramFiles && join(env.ProgramFiles, 'nodejs', 'node_modules')]
  : [join(process.execPath, '..', '..', 'lib', 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules', env.HOME && join(env.HOME, '.npm-global', 'lib', 'node_modules')]
const DSH = [
  env.DSH_ROOT,
  (() => {
    try { return dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')) } catch { return '' }
  })(),
  npmRootG && join(npmRootG, '@deepseek-ai', 'dsh'),
  ...guessed.filter(Boolean).map((root) => join(root, '@deepseek-ai', 'dsh')),
].filter(Boolean).find(usable)
if (!DSH) throw new Error('dsh-plugin-toolscode tests: @deepseek-ai/dsh not found — set DSH_ROOT to its install directory')
const req = createRequire(join(DSH, 'lib/bin.js'))

const { Context } = req('@deepseek-ai/cordis')
const SystemPrompt = req('@deepseek-ai/dsh-system-prompt').default
const toolsPkg = req('@deepseek-ai/dsh-tools')
const ToolRuntime = toolsPkg.default
const { defineTool } = toolsPkg
const { createScope } = req('@deepseek-ai/dsh-scope')

// dsh 0.2 moved tool presentation and execution behind a mountable executor
// (`ctx.tools.setExecutor`), turned `tools.execute()` into a batch call, and
// dropped `tools` from the `system-prompt/assemble` carrier. Feature-detect the
// contract instead of parsing versions, so one suite runs in both worlds.
const EXECUTOR_ERA = typeof ToolRuntime.prototype?.setExecutor === 'function'
/**
 * On 0.2+ the executor is what presents tools[], so the wire shrink goes
 * through it: the same assertions hold in both worlds, one via the assemble
 * carrier and one via the describe() of the wrapper the plugin mounts.
 */
const PLUGIN_BASE = EXECUTOR_ERA ? { executor: 'wrap' } : {}
/** Gate for tests that need the 0.2 executor contract to exist at all. */
const ONLY_EXECUTOR_ERA = { skip: EXECUTOR_ERA ? false : 'the tool executor contract does not exist before dsh 0.2' }

/**
 * The row that plays the presentation role 0.1 ToolsService had built in, as
 * a builder so each universe gets its own instance - and with it its own
 * execution pipeline and post-execute waterfall.
 * @param ctx - context to select the executor on.
 */
const mountNative = (ctx) => {
  const { NativeToolExecutor } = req('@deepseek-ai/dsh-tool-executor-native')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
}
const nativeRow = EXECUTOR_ERA ? { name: 'native-tool-executor', inject: ['tools'], apply: mountNative } : null

/**
 * Dispatch one call and return its result through whichever contract the
 * installed harness speaks: a single call object on 0.1, a settled batch of
 * `{callId, result}` entries on 0.2+.
 */
const dispatch = async (root, { callId, name, args, agent }) => {
  const signal = new AbortController().signal
  if (!EXECUTOR_ERA) return root.tools.execute({ callId, name, arguments: args, agent, signal })
  const settled = await root.tools.execute({ calls: [{ id: callId, name, arguments: args }], agent, signal })
  const entries = settled?.results ?? []
  const entry = entries.find((e) => e.callId === callId) ?? entries[0]
  return entry === undefined ? settled : entry.result
}

/** One real registry definition: 0.2 `definitions`, 0.1 `resolveExecution`. */
const registryEntry = (root, scope, name) => EXECUTOR_ERA
  ? root.tools.definitions(scope).find((d) => d.name === name)
  : root.tools.resolveExecution(name, scope)

/** The full-fidelity non-wire view (0.2 dropped the separate PTC SDK view). */
const registryView = (root, scope) => (EXECUTOR_ERA ? root.tools.definitions(scope) : root.tools.sdkSchemas(scope))

const pluginModule = await import('../lib/index.js')
// The shape PluginPackages hands to ctx.plugin(): a plain applicable object.
const plugin = pluginModule.default ?? pluginModule
const shrink = await import('../lib/shrink.js')

/** A tool whose schema is comfortably above the default minChars (1200). */
const makeBigTool = (name, body) => defineTool({
  name,
  description: `Use ${name} for a very important operation. `.repeat(20) +
    'Additional long tail text to push this description well past the cap so the shrink is observable.',
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'A long property description '.repeat(8) + 'that should be truncated by the nested cap.',
    },
    mode: {
      type: 'string',
      enum: ['a', 'b'],
      default: 'a',
      description: 'Another verbose property description that keeps going and going and going.',
    },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => String(value) },
  execute: async (args, exec) => body ? body(args, exec) : `ran:${name}:${args.path}`,
})

const makeTinyTool = (name) => defineTool({
  name,
  description: 'short',
  parameters: { a: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
  execute: async () => 'ok',
})

/**
 * A plugin row is the only supported way to register tools into a scope —
 * exactly how a preset's `tool-*` rows do it in production. The returned
 * handle can register more tools later (simulating an MCP connect).
 */
const registrar = (...definitions) => {
  let mounted
  const row = {
    inject: ['tools'],
    apply: (ctx) => {
      mounted = ctx
      for (const definition of definitions) ctx.tools.register(definition)
    },
  }
  row.register = (definition) => {
    if (mounted === undefined) throw new Error('registrar not mounted yet')
    return mounted.tools.register(definition)
  }
  return row
}

/**
 * Build root + a plugin-bearing preset + a second preset without the
 * plugin, each with its own registered tools, mirroring the deployment.
 * Both presets hang under a shared profile scope, so a row can mount at
 * three depths: inside the preset (the usual case), on that ancestor (a
 * profile row from cordis.patch.yml), or nowhere (a null config). On dsh
 * 0.2+ a tool executor is mounted at the root - the deployment default -
 * which is exactly the executor an ancestor or preset mount gets to wrap.
 * @param pluginConfig - config for the toolscode row (null skips the row).
 * @param options - topology and mount order: `atRoot` mounts the plugin on
 *   the ancestor scope, `withExecutor: false` leaves the executor out of
 *   the composition, `executorOverride` mounts a different row (a stand-in
 *   for the PTC executor). `tools` / `otherTools` are the registrations.
 */
const setup = async (pluginConfig, {
  pluginFirst = false,
  atRoot = false,
  withExecutor = true,
  executorOverride,
  tools = [makeBigTool('bigtool')],
  otherTools = [makeBigTool('bigtool')],
} = {}) => {
  const root = new Context()
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await root.plugin(ToolRuntime, {})
  // 0.2+ refuses to assemble or dispatch without an executor in the universe.
  const row = executorOverride === undefined ? nativeRow : executorOverride
  if (row !== null && withExecutor) await root.plugin(row)
  // The shared ancestor a profile-level patch row mounts on.
  const profileKey = {}
  const profile = createScope(root, profileKey)
  const presetKey = {}
  const preset = createScope(root, presetKey, { parent: profileKey })
  const agentKey = {}
  createScope(root, agentKey, { parent: presetKey })
  const otherKey = {}
  const other = createScope(root, otherKey, { parent: profileKey })
  const otherAgentKey = {}
  createScope(root, otherAgentKey, { parent: otherKey })
  const toolsRow = registrar(...tools)
  const otherRow = registrar(...otherTools)
  // atRoot mirrors a profile-level cordis.patch.yml row: the plugin mounts on
  // the ancestor scope, while tools stay registered in the preset own layer.
  const mountScope = atRoot ? profile.ctx : preset.ctx
  // executor: wrap is what lets the 0.2 contract shrink the wire at all.
  const config = pluginConfig === null ? null : { ...PLUGIN_BASE, ...pluginConfig }
  if (pluginFirst) {
    if (config !== null) await mountScope.plugin(plugin, config)
  }
  await preset.ctx.plugin(toolsRow)
  if (!pluginFirst) {
    if (config !== null) await mountScope.plugin(plugin, config)
  }
  await other.ctx.plugin(otherRow)
  return { root, profile, preset, agentKey, other, otherAgentKey, toolsRow }
}

const findTool = (schemas, name) => schemas.find((s) => s.name === name)

test('production topology: assembly carries the shrunk tools; other presets unaffected', async () => {
  const { root, agentKey, otherAgentKey } = await setup()
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  const seen = findTool(assembly.tools, 'bigtool')
  assert.ok(seen, 'tool must still be present')
  assert.ok(seen.description.length <= 201, `shrunk description too long: ${seen.description.length}`)
  assert.ok(seen.description.endsWith('…'))
  assert.ok(seen.description.startsWith('Use bigtool for a very important operation.'))
  const pathDesc = seen.parameters.properties.path.description
  assert.ok(pathDesc.length <= 101, `nested description too long: ${pathDesc.length}`)
  // Structural keywords survive: validation semantics untouched.
  assert.deepEqual(seen.parameters.properties.mode.enum, ['a', 'b'])
  assert.equal(seen.parameters.properties.mode.default, 'a')
  // The other preset (no plugin row) keeps the full schema.
  const elsewhere = await root.systemPrompt.assemble({ scope: otherAgentKey })
  assert.ok(findTool(elsewhere.tools, 'bigtool').description.length > 300, 'other preset must see the full schema')
})

test('mount order does not matter (plugin row before or after tool rows)', async () => {
  const { root, agentKey } = await setup(undefined, { pluginFirst: true })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  assert.ok(findTool(assembly.tools, 'bigtool').description.length <= 201)
})

test('registry keeps the real definitions: resolved execution is full-fidelity and the body runs', async () => {
  const { root, agentKey } = await setup()
  const definition = registryEntry(root, agentKey, 'bigtool')
  assert.ok(definition.description.length > 300, 'registry definition must be untouched')
  const result = await definition.execute({ path: 'x', mode: 'a' }, { signal: new AbortController().signal })
  assert.equal(result, 'ran:bigtool:x')
  const full = await dispatch(root, { callId: 'c-dispatch', name: 'bigtool', args: { path: 'y' }, agent: agentKey })
  assert.equal(full.isError !== true, true)
  assert.equal(full.value, 'ran:bigtool:y')
})

test('self-heal: invalid args surface the real violations plus the full real schema', async () => {
  const { root, agentKey } = await setup()
  // Production order: the model first assembles (receiving the shrunk wire,
  // which arms the self-heal stash), then dispatches.
  await root.systemPrompt.assemble({ scope: agentKey })
  const result = await dispatch(root, { callId: 'c-selfheal', name: 'bigtool', args: { path: 123, mode: 'zzz' }, agent: agentKey })
  assert.equal(result.isError, true)
  // The self-heal block rewrites the outcome: content carries the original
  // violations plus the real schema; error.message mirrors the content.
  const text = result.content.map((b) => b.text ?? '').join('\n')
  assert.match(text, /invalid arguments/)
  assert.match(text, /Full parameter schema for "bigtool"/)
  // The attached schema must be the REAL one: the shrunk nested cap of
  // 100 chars would keep only 3 copies of the repeated phrase.
  const copies = (text.match(/A long property description/g) ?? []).length
  assert.equal(copies, 8, 'attached schema must be the unshrunk real one')
})

test('self-heal leaves unshrunk tools and successful calls alone', async () => {
  const { root, agentKey } = await setup(undefined, { tools: [makeBigTool('bigtool'), makeTinyTool('tiny')] })
  await root.systemPrompt.assemble({ scope: agentKey })
  const bad = await dispatch(root, { callId: 'c-tiny', name: 'tiny', args: { zzz: 1 }, agent: agentKey })
  assert.equal(bad.isError, true)
  const text = bad.content.map((b) => b.text ?? '').join('\n')
  assert.doesNotMatch(text, /Full parameter schema/, 'never-shrunk tool must not get the note')
  const good = await dispatch(root, { callId: 'c-good', name: 'bigtool', args: { path: 'p' }, agent: agentKey })
  assert.equal(good.isError !== true, true)
})

test('mcp:* instruction sections truncate for joined agents only', async () => {
  const { root, agentKey, otherAgentKey } = await setup({ instructionsCap: 300 })
  root.systemPrompt.section({
    name: 'mcp:testserver',
    order: 900,
    interpolate: false,
    text: `### MCP server: testserver\n\n${'server guidance. '.repeat(900)}`,
  })
  root.systemPrompt.section({ name: 'other:section', order: 901, text: `plain ${'x'.repeat(5000)}` })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  const mcp = assembly.sections.find((s) => s.name === 'mcp:testserver')
  assert.ok(mcp.text.length < 400, `expected truncation, got ${mcp.text.length}`)
  assert.ok(mcp.text.startsWith('### MCP server: testserver'))
  assert.ok(mcp.text.includes('[toolscode: server instructions truncated]'))
  const other = assembly.sections.find((s) => s.name === 'other:section')
  assert.equal(other.text.length, 5006, 'non-mcp sections must be untouched')
  const elsewhere = await root.systemPrompt.assemble({ scope: otherAgentKey })
  assert.ok(elsewhere.sections.find((s) => s.name === 'mcp:testserver').text.length > 5000)
})

test('minChars and include/exclude globs steer which tools are shrunk', async () => {
  const { root, agentKey } = await setup(
    { include: ['mcp__*'], exclude: ['mcp__keep__*'] },
    { tools: [makeBigTool('mcp__comfy__queue'), makeBigTool('mcp__keep__special'), makeBigTool('core_tool')] },
  )
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  assert.ok(findTool(assembly.tools, 'mcp__comfy__queue').description.length <= 201)
  assert.ok(findTool(assembly.tools, 'mcp__keep__special').description.length > 300, 'exclude wins')
  assert.ok(findTool(assembly.tools, 'core_tool').description.length > 300, 'outside include stays full')
  // minChars: a small tool under a matching glob stays byte-identical.
  const { root: root2, agentKey: agent2 } = await setup(
    { minChars: 5000 },
    { tools: [makeBigTool('bigtool')] },
  )
  const a2 = await root2.systemPrompt.assemble({ scope: agent2 })
  assert.ok(findTool(a2.tools, 'bigtool').description.length > 300, 'under minChars stays full')
})

test('byte-stable across assemblies; a later registration only adds (cache contract)', async () => {
  const { root, agentKey, toolsRow } = await setup()
  const first = JSON.stringify((await root.systemPrompt.assemble({ scope: agentKey })).tools)
  const second = JSON.stringify((await root.systemPrompt.assemble({ scope: agentKey })).tools)
  assert.equal(first, second, 'unchanged state must assemble byte-identical tools')
  toolsRow.register(makeBigTool('late'))
  const third = JSON.parse(JSON.stringify((await root.systemPrompt.assemble({ scope: agentKey })).tools))
  const late = findTool(third, 'late')
  assert.ok(late.description.length <= 201, 'late tool is shrunk too')
  assert.deepEqual(findTool(third, 'bigtool'), JSON.parse(JSON.stringify(findTool(JSON.parse(first), 'bigtool'))),
    'unchanged tools must be byte-identical after a registration')
})

test('wire-only contract: the registry SDK view (PTC) stays full-fidelity', async () => {
  const { root, agentKey } = await setup()
  // The shrink is an assembly-time wire transform: sdkSchemas (the PTC SDK
  // source) keeps the real descriptions by design.
  const sdk = findTool(registryView(root, agentKey), 'bigtool')
  assert.ok(sdk.description.length > 300)
})

test('config validation rejects nonsense early', () => {
  assert.throws(() => plugin.apply({}, { unknownKey: 1 }), /unknown config key/)
  assert.throws(() => plugin.apply({}, { descriptionCap: -5 }), /non-negative integer/)
  assert.throws(() => plugin.apply({}, { include: 'mcp__*' }), /array of glob strings/)
  assert.throws(() => plugin.apply({}, { instructionsCap: 1.5 }), /non-negative integer or null/)
  assert.throws(() => plugin.apply({}, { executor: 'on' }), /executor must be "off" or "wrap"/)
})

test('disabled config is a no-op', async () => {
  const { root, agentKey } = await setup({ enabled: false })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  assert.ok(findTool(assembly.tools, 'bigtool').description.length > 300)
})

test('shrink helpers: truncation and instruction edge cases', () => {
  const { truncateText, shrinkInstructions } = shrink
  assert.equal(truncateText('hello world this is a fairly long sentence', 16), 'hello world this…')
  assert.equal(truncateText('short', 100), 'short')
  assert.equal(truncateText('drop me entirely', 0), '')
  const text = shrinkInstructions('### MCP server: x\n\n' + 'y'.repeat(100), 0)
  assert.equal(text, '### MCP server: x\n…[toolscode: server instructions dropped]')
  assert.equal(shrinkInstructions('### h\nshort', 1000), '### h\nshort', 'under cap stays byte-identical')
  // Deep recursion: property maps, items, and anyOf branches all shrink.
  const deep = shrink.shrinkToolSchema({
    name: 'deep',
    description: 'x'.repeat(500),
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string', description: 'deep '.repeat(40) } } } },
        c: { anyOf: [{ type: 'string', description: 'branch '.repeat(30) }, { const: 1 }] },
      },
      required: ['a'],
    },
  }, { descriptionCap: 50, nestedDescriptionCap: 40 })
  const b = deep.parameters.properties.a.items.properties.b.description
  assert.ok(b.length <= 41 && b.endsWith('…'), `items map not shrunk: ${b.length}`)
  const branch = deep.parameters.properties.c.anyOf[0].description
  assert.ok(branch.length <= 41, `anyOf branch not shrunk: ${branch.length}`)
  assert.equal(deep.parameters.properties.c.anyOf[1].const, 1, 'structural keywords survive')
  assert.equal(deep.parameters.required[0], 'a')
})

// ---------- option B: the PTC SDK declaration section (tools:sdk) ----------

/** A miniature of the real generated SDK section: declarations plus JSDoc. */
const sdkSample = [
  '## Writing code for run_code',
  '',
  'Intro prose stays untouched however long it is: ' + 'prose. '.repeat(60),
  '',
  'declare const tools: {',
  '  /** ' + 'Search many engines concurrently and merge the ranked results. '.repeat(10) + ' */',
  '  multi_search: (args: { query?: string }) => Promise<{ provider?: string }>;',
  '  /**',
  '   * Fan a workflow out into variants over slot value lists. ' + 'Zips the lists together. '.repeat(8),
  '   * Args: slots: one entry per address from the slot listing. comfy-cli ZIPS the value lists.',
  '   * @param workflow_path - the workflow file to read from disk.',
  '   * @param slots - one entry per address; every value list must be the same length.',
  '   * @returns the written variant paths, one per zip position.',
  '   * @example',
  '   *   const ignored = varyWorkflow(path, entries) // example body line',
  '   */',
  '  vary_workflow: (args: { workflow_path: string }) => Promise<string[]>;',
  '  /** Short one stays byte-identical. */',
  '  look: () => Promise<string>;',
  '}',
].join('\n')

/** Everything but the comment blocks and the whitespace between them. */
const codeOnly = (text) => text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()

/** Drop the trailing shrink marker. */
const unmarked = (text) => text.replace(/\n+…\[toolscode:[^\n]*\n?$/g, '')

test('SDK shrink: prose capped, declarations byte-identical, examples dropped', () => {
  const opts = { descriptionCap: 120, tagCap: 60, blockMinChars: 200 }
  const out = shrink.shrinkSdkSection(sdkSample, opts)
  assert.ok(out.length < sdkSample.length * 0.7, 'expected a real cut, got ' + out.length + ' of ' + sdkSample.length)
  assert.ok(out.includes('[toolscode: SDK declaration prose shrunk'), 'the marker names the shrink')
  assert.ok(out.includes('Intro prose stays untouched'), 'section prose is not a comment block')
  assert.ok(!out.includes('example body line'), '@example bodies are dropped')
  assert.ok(out.includes('/** Short one stays byte-identical. */'), 'short blocks stay byte-identical')
  assert.ok(out.includes('@param workflow_path - the workflow file'), 'tag name and separator survive')
  // Structure contract: strip the comments (and the marker) and the
  // declarations are byte-identical to the input.
  assert.equal(codeOnly(unmarked(out)), codeOnly(sdkSample))
  assert.equal((out.match(/\/\*\*/g) ?? []).length, (out.match(/\*\//g) ?? []).length, 'every block stays closed')
  assert.equal(shrink.shrinkSdkSection(sdkSample, opts), out, 'byte-stable across calls')
})

test('SDK shrink: opt-in — the default config keeps the section byte-identical', async () => {
  const { root, agentKey } = await setup()
  root.systemPrompt.section({ name: 'tools:sdk', order: 950, interpolate: false, text: sdkSample })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  assert.equal(assembly.sections.find((s) => s.name === 'tools:sdk').text, sdkSample)
})

test('SDK shrink: enabled shrinks the mounted preset only', async () => {
  const { root, agentKey, otherAgentKey } = await setup({ sdkDescriptionCap: 120, sdkTagCap: 60 })
  root.systemPrompt.section({ name: 'tools:sdk', order: 950, interpolate: false, text: sdkSample })
  const here = await root.systemPrompt.assemble({ scope: agentKey })
  const shrunk = here.sections.find((s) => s.name === 'tools:sdk').text
  assert.ok(shrunk.length < sdkSample.length, 'mounted preset must shrink, got ' + shrunk.length)
  assert.ok(shrunk.includes('multi_search: (args: { query?: string })'), 'declarations survive')
  assert.equal(codeOnly(unmarked(shrunk)), codeOnly(sdkSample))
  const there = await root.systemPrompt.assemble({ scope: otherAgentKey })
  assert.equal(there.sections.find((s) => s.name === 'tools:sdk').text, sdkSample, 'other preset untouched')
})

test('SDK shrink: edge caps and config validation', () => {
  const text = '/** ' + 'long prose here. '.repeat(60) + ' */\ndeclare const x: number'
  const zero = shrink.shrinkSdkSection(text, { descriptionCap: 0, tagCap: 0, blockMinChars: 10 })
  assert.ok(!zero.includes('long prose here. long prose here.'), 'cap 0 drops the prose')
  assert.ok(zero.includes('declare const x: number'), 'the declaration survives')
  assert.equal(shrink.shrinkSdkSection('declare const x: number', { descriptionCap: 10 }), 'declare const x: number', 'no blocks -> identical')
  const tiny = '/** Short one stays byte-identical. */\ndeclare const y: number'
  assert.equal(shrink.shrinkSdkSection(tiny, { descriptionCap: 10, blockMinChars: 200 }), tiny, 'under blockMinChars -> identical')
  assert.throws(() => plugin.apply({}, { sdkDescriptionCap: 1.5 }), /non-negative integer or null/)
  assert.throws(() => plugin.apply({}, { sdkTagCap: -1 }), /non-negative integer/)
  assert.throws(() => plugin.apply({}, { sdkBlockMinChars: null }), /non-negative integer/)
})

test('ancestor-scope mount (a profile-level patch row) shrinks every preset and still self-heals', async () => {
  const config = { sdkDescriptionCap: 120, sdkTagCap: 60 }
  const { root, agentKey, otherAgentKey } = await setup(config, { atRoot: true })
  root.systemPrompt.section({ name: 'tools:sdk', order: 950, interpolate: false, text: sdkSample })
  for (const [label, key] of [['preset agent', agentKey], ['second preset agent', otherAgentKey]]) {
    const assembly = await root.systemPrompt.assemble({ scope: key })
    const seen = findTool(assembly.tools, 'bigtool')
    assert.ok(seen.description.endsWith('…'), label + ': wire prose must shrink from an ancestor mount')
    assert.ok(seen.parameters.properties.path.description.endsWith('…'), label + ': nested prose must shrink')
    const sdk = assembly.sections.find((s) => s.name === 'tools:sdk').text
    assert.ok(sdk.includes('[toolscode: SDK declaration prose shrunk'), label + ': SDK section must shrink')
    assert.equal(codeOnly(unmarked(sdk)), codeOnly(sdkSample), label + ': declarations stay byte-identical')
  }
  // Self-heal is scope-filtered by mount scope: an ancestor mount must still see
  // the calls of agents nested under any preset.
  await root.systemPrompt.assemble({ scope: otherAgentKey })
  const result = await dispatch(root, { callId: 'c-ancestor', name: 'bigtool', args: { path: 123, mode: 'zzz' }, agent: otherAgentKey })
  assert.equal(result.isError, true)
  const text = result.content.map((b) => b.text ?? '').join('\n')
  assert.match(text, /Full parameter schema for "bigtool"/, 'ancestor mount must still self-heal')
  assert.equal((text.match(/A long property description/g) ?? []).length, 8, 'and attach the unshrunk schema')
})

// ---------- v0.2: structural slimming of the generated SDK declarations ----------

/**
 * The miniature generated section used by the pure tests too, so both layers
 * exercise the same bytes: two interfaces, nesting, unions, quoted literals,
 * an unknown-typed MCP tool, a no-argument tool. The mcp__ names double as the
 * tools registered below, which is what lets a call hit a slimmed declaration.
 */
const sdkGenerated = readFileSync(new URL('./fixtures/sdk-sample.txt', import.meta.url), 'utf8').replace(/\r/g, '')
const NL = String.fromCharCode(10)

/** A tool that always fails the way an MCP server does: a plain error result. */
const makeThrower = (name, message) => defineTool({
  name,
  description: 'throws on purpose',
  parameters: { a: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => String(value) },
  execute: async () => { throw new Error(message) },
})

/**
 * The recommended production shape, with minEntries lowered: the fixture holds
 * five mcp__ entries while a real deployment holds hundreds, and the gate is
 * exercised on its own below.
 */
const slimConfig = { sdkSlimInclude: ['mcp__*'], sdkSlimStyle: 'table', sdkSlimDocCap: 90, sdkOutputMap: 'stub', sdkSlimMinEntries: 4 }

/**
 * The v0.2 topology: the plugin row plus a tools:sdk section carrying the
 * generated declarations, and `sdkOf` for reading that section back out of an
 * assembly — the same path dsh-tools' sdkSection takes in production.
 */
const slimSetup = async (config = slimConfig, tools = undefined) => {
  const universe = await setup(config, tools === undefined ? {} : { tools })
  universe.root.systemPrompt.section({ name: 'tools:sdk', order: 950, interpolate: false, text: sdkGenerated })
  const sdkOf = async (key) => (await universe.root.systemPrompt.assemble({ scope: key }))
    .sections.find((s) => s.name === 'tools:sdk').text
  return { ...universe, sdkOf }
}

const slimTools = () => [
  makeBigTool('bigtool'),
  makeTinyTool('tiny'),
  makeTinyTool('mcp__fake__thing'),
  makeThrower('mcp__gridcraft__sort_range', 'invalid arguments: keys must be column letters'),
  makeThrower('mcp__gridcraft__workbook_list', 'Blender is not connected'),
]

test('SDK slim v0.2: the default config keeps the generated section byte-identical', async () => {
  const { root, agentKey } = await setup()
  root.systemPrompt.section({ name: 'tools:sdk', order: 950, interpolate: false, text: sdkGenerated })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  assert.equal(assembly.sections.find((s) => s.name === 'tools:sdk').text, sdkGenerated)
})

test('SDK slim v0.2: table + stub compacts the section, keeps every declaration, explains itself once', async () => {
  const { root, agentKey, otherAgentKey, sdkOf } = await slimSetup()
  const here = await sdkOf(agentKey)
  // The note is a fixed 457-char surcharge; the declarations themselves are the win.
  const body = here.split(NL + NL + '...[toolscode:')[0]
  assert.ok(body.length < sdkGenerated.length - 400, 'expected a real cut, got ' + body.length + ' of ' + sdkGenerated.length)
  assert.ok(here.includes('  mcp__gridcraft__set_cell: {cell: string; input: string | number | boolean;}; /** Enter one cell'), 'compact entry: ' + here.slice(here.indexOf('set_cell') - 20, here.indexOf('set_cell') + 140))
  assert.ok(here.includes('  mcp__gridcraft__sort_range: unknown;'), 'unknown-typed tools survive as unknown')
  assert.ok(here.includes('  mcp__gridcraft__workbook_list: Record<string,never>;'), 'no-argument entries survive')
  assert.ok(here.includes('  advanced_search: {' + NL + '    /** The search query. */'), 'a core declaration keeps its layout and doc')
  assert.ok(here.includes('  [toolName: string]: JsonValue | undefined;'), 'the result map collapses')
  assert.ok(!here.includes('provider?: string'), 'its entries are gone')
  assert.equal((here.match(/interface /g) ?? []).length, 2, 'both interfaces survive')
  assert.equal((here.match(/\{/g) ?? []).length, (here.match(/\}/g) ?? []).length, 'brace balance')
  assert.ok(here.includes('MCP tools resolve to the standard envelope'), 'the collapsed result typings are explained once')
  assert.equal((here.match(/toolscode:/g) ?? []).length, 1, 'the note appears exactly once')
  assert.equal(await sdkOf(agentKey), here, 'two assemblies are byte-identical (prompt cache contract)')
  assert.equal(await sdkOf(otherAgentKey), sdkGenerated, 'a preset without the plugin row keeps the full section')
})

test('SDK slim v0.2: minEntries gates the layout rewrite; lines style keeps nesting; the stub is independent', async () => {
  // Below the gate nothing is rewritten, yet the result map still collapses.
  const first = await slimSetup({ sdkSlimInclude: ['mcp__*'], sdkSlimStyle: 'lines', sdkSlimMinEntries: 99, sdkOutputMap: 'stub' })
  const gated = await first.sdkOf(first.agentKey)
  assert.ok(gated.includes('    /** Cell, e.g. ' + String.fromCharCode(34) + 'B7' + String.fromCharCode(34) + ' or ' + String.fromCharCode(34) + 'Sheet2!C3' + String.fromCharCode(34) + '. */'), 'below minEntries the entry keeps its own doc line')
  assert.ok(gated.includes('  } & Record<string, JsonValue>;'), 'and its escape hatch')
  assert.ok(gated.includes('  [toolName: string]: JsonValue | undefined;'), 'the stub is governed by sdkOutputMap alone')
  // Above the gate, the lines style drops prose but keeps the layout.
  const second = await slimSetup({ sdkSlimInclude: ['mcp__gridcraft__set_cell'], sdkSlimStyle: 'lines', sdkSlimMinEntries: 1, sdkOutputMap: 'keep' })
  const lined = await second.sdkOf(second.agentKey)
  assert.ok(lined.includes('  mcp__gridcraft__set_cell: {' + NL + '    cell: string;'), 'nesting survives')
  assert.ok(!lined.includes('Dependent cells recalculate'), 'the prose is gone')
  assert.ok(lined.includes('  } & Record<string, JsonValue>;'), 'lines style keeps the escape hatch')
  assert.ok(lined.includes('/** Search the web with optional time filtering. */'), 'tools outside the list keep their docs')
})

test('SDK slim v0.2: a slimmed tool that is rejected is answered with the real contract', async () => {
  const { root, agentKey } = await slimSetup(slimConfig, slimTools())
  // Production order: assemble first (that is where the declarations are read
  // and the compact table is armed), then the model dispatches.
  await root.systemPrompt.assemble({ scope: agentKey })
  // An MCP server rejecting arguments itself (no ToolArgsError) is answered too.
  // This is also the healing path that survives on 0.2+: the failure comes back
  // as a dispatched result, so tools/post-execute still runs over it.
  const mcpStyle = await dispatch(root, { callId: 'c-slim-mcp', name: 'mcp__gridcraft__sort_range', args: { a: 'x' }, agent: agentKey })
  const mcpText = mcpStyle.content.map((b) => b.text ?? '').join('\n')
  assert.match(mcpText, /invalid arguments: keys must be column letters/, 'the server message survives')
  assert.match(mcpText, /Full (parameter schema|declaration) for "mcp__gridcraft__sort_range"/)
  // A runtime failure of a slimmed tool is not an argument problem: no note.
  const runtime = await dispatch(root, { callId: 'c-slim-runtime', name: 'mcp__gridcraft__workbook_list', args: { a: 'x' }, agent: agentKey })
  const runtimeText = runtime.content.map((b) => b.text ?? '').join('\n')
  assert.match(runtimeText, /Blender is not connected/)
  assert.doesNotMatch(runtimeText, /Full (parameter schema|declaration)/, 'a runtime error is left alone')
  // A tool never made smaller anywhere still gets no note.
  const untouched = await dispatch(root, { callId: 'c-slim-tiny', name: 'tiny', args: { zzz: 1 }, agent: agentKey })
  assert.doesNotMatch(untouched.content.map((b) => b.text ?? '').join('\n'), /Full (parameter schema|declaration)/)
  // And the two the harness rejects itself: on 0.1 that surfaces through the
  // dispatch waterfall, on 0.2 inside the pipeline - tools/post-execute sees
  // the normalized ToolArgsError either way, armed by whichever path shrank.
  const rejected = await dispatch(root, { callId: 'c-slim-args', name: 'mcp__fake__thing', args: { zzz: 1 }, agent: agentKey })
  assert.equal(rejected.isError, true)
  const text = rejected.content.map((b) => b.text ?? '').join('\n')
  assert.match(text, /Full (parameter schema|declaration) for "mcp__fake__thing"/, 'a slimmed declaration must self-heal')
  assert.match(text, /a: string|"a"/, 'and the disclosure carries the real argument')
  // The v0.1 wire path keeps working next to the slimming.
  const wire = await dispatch(root, { callId: 'c-slim-wire', name: 'bigtool', args: { path: 123, mode: 'zzz' }, agent: agentKey })
  assert.match(wire.content.map((b) => b.text ?? '').join('\n'), /Full parameter schema for "bigtool"/)
})

test('SDK slim v0.2: sdkSlimHeal false keeps the compact table but stops the disclosure', async () => {
  const { root, agentKey } = await slimSetup({ ...slimConfig, sdkSlimHeal: false }, slimTools())
  const here = await root.systemPrompt.assemble({ scope: agentKey })
  assert.ok(here.sections.find((s) => s.name === 'tools:sdk').text.includes('  [toolName: string]: JsonValue | undefined;'), 'slimming itself is unaffected')
  const rejected = await dispatch(root, { callId: 'c-noheal', name: 'mcp__gridcraft__sort_range', args: { a: 'x' }, agent: agentKey })
  assert.doesNotMatch(rejected.content.map((b) => b.text ?? '').join('\n'), /Full (parameter schema|declaration)/)
})

test('SDK slim v0.2: config validation for the new keys', () => {
  assert.throws(() => plugin.apply({}, { sdkSlimInclude: 'mcp__*' }), /sdkSlimInclude must be an array of glob strings/)
  assert.throws(() => plugin.apply({}, { sdkSlimInclude: [1] }), /sdkSlimInclude must be an array of glob strings/)
  assert.throws(() => plugin.apply({}, { sdkSlimStyle: 'blocks' }), /sdkSlimStyle must be "table" or "lines"/)
  assert.throws(() => plugin.apply({}, { sdkOutputMap: 'drop' }), /sdkOutputMap must be "keep" or "stub"/)
  assert.throws(() => plugin.apply({}, { sdkSlimDocCap: 1.5 }), /sdkSlimDocCap must be a non-negative integer/)
  assert.throws(() => plugin.apply({}, { sdkSlimMinEntries: -1 }), /sdkSlimMinEntries must be a non-negative integer/)
  assert.throws(() => plugin.apply({}, { sdkSlimRecord: 'yes' }), /sdkSlimRecord must be a boolean/)
  assert.throws(() => plugin.apply({}, { sdkSlimMarker: 1 }), /sdkSlimMarker must be a boolean/)
  assert.throws(() => plugin.apply({}, { sdkSlimHeal: null }), /sdkSlimHeal must be a boolean/)
  assert.throws(() => plugin.apply({}, { sdkSlimIncluded: ['mcp__*'] }), /unknown config key/)
  // Accepted shapes are exercised by the integration tests above, which mount
  // every one of these keys through a real cordis scope.
})

// ---------- dsh 0.2: shrinking through the mounted tool executor ----------

/** An executor that behaves like the PTC one: it owns prompt sections. */
const sectionBearingExecutor = {
  name: 'fake-ptc-executor',
  sections: [{ name: 'tools:sdk', order: 5000, text: () => 'DECLARATIONS FROM THE EXECUTOR' }],
  describe: (definitions) => ({
    schemas: definitions.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
  }),
  execute: async () => { throw new Error('the fake executor never executes') },
}
const fakePtcRow = {
  name: 'fake-ptc-row',
  inject: ['tools'],
  apply: (ctx) => { ctx.tools.setExecutor(sectionBearingExecutor) },
}

test('executor wrap: describe() shrinks while the registry keeps the real schema', async () => {
  const { root, agentKey } = await setup({ executor: 'wrap' })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  const seen = findTool(assembly.tools, 'bigtool')
  assert.ok(seen.description.endsWith('…'), 'the presented description must shrink')
  assert.ok(seen.parameters.properties.path.description.endsWith('…'), 'nested prose must shrink too')
  // The executor projects the live registry, parameters by reference: a
  // mutating shrink would leak its caps straight into the real definition.
  const definition = registryEntry(root, agentKey, 'bigtool')
  assert.ok(definition.description.length > 300, 'registry description must stay full')
  const view = registryView(root, agentKey).find((d) => d.name === 'bigtool')
  assert.ok(view.parameters.properties.path.description.length > 100, 'registry property prose must stay full')
  const ran = await dispatch(root, { callId: 'c-wrap', name: 'bigtool', args: { path: 'ok' }, agent: agentKey })
  assert.equal(ran.value, 'ran:bigtool:ok', 'the real body still runs')
})

test('executor wrap: the presented bytes are stable across assemblies', async () => {
  const { root, agentKey } = await setup({ executor: 'wrap' })
  const once = JSON.stringify((await root.systemPrompt.assemble({ scope: agentKey })).tools)
  const twice = JSON.stringify((await root.systemPrompt.assemble({ scope: agentKey })).tools)
  assert.equal(twice, once, 'the wrapper must present the same bytes every turn')
})

test('executor wrap: an executor presenting its own sections is never shadowed', ONLY_EXECUTOR_ERA, async () => {
  // The PTC executor owns tools:sdk, and that text renders only while it is
  // the selected executor. Shadowing it would blank the very section this
  // plugin shrinks - the biggest win of a PTC deployment - to win a wire
  // carrying nothing but the entrypoint tool.
  const { root, agentKey } = await setup({ executor: 'wrap' }, { executorOverride: fakePtcRow })
  const assembly = await root.systemPrompt.assemble({ scope: agentKey })
  const sdk = assembly.sections.find((s) => s.name === 'tools:sdk')
  assert.ok(sdk !== undefined, 'the executor section must still render')
  assert.match(sdk.text, /DECLARATIONS FROM THE EXECUTOR/, 'shadowing would blank exactly this text')
  assert.ok(findTool(assembly.tools, 'bigtool').description.length > 300, 'and the wire stays full-fidelity')
})

test('executor wrap: a missing executor is a warning, not a broken composition', ONLY_EXECUTOR_ERA, async () => {
  // Nothing to wrap: the row must mount, say so and stay harmless - a plugin
  // that throws at mount takes the whole agent down with it.
  const { root, agentKey } = await setup({ executor: 'wrap' }, { withExecutor: false, pluginFirst: true })
  assert.throws(() => root.tools.selectExecutor(agentKey), 'no executor may be invented')
})

test('executor wrap: a second row in one scope leaves the first in charge', ONLY_EXECUTOR_ERA, async () => {
  // Two profiles both asking for wrap: the second setExecutor throws, which
  // has to become a log line with the first wrapper still shrinking.
  const universe = await setup({ executor: 'wrap' })
  await universe.preset.ctx.plugin(plugin, { executor: 'wrap' })
  const assembly = await universe.root.systemPrompt.assemble({ scope: universe.agentKey })
  assert.ok(findTool(assembly.tools, 'bigtool').description.endsWith('…'))
})
